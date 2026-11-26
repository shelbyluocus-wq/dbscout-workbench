//! Persistent per-table external (non-Blackcat) change event log and team sync.
//!
//! Stored in `audit.sqlite` separately from `audit_log` so Backup Center and
//! transactional table restore remain strictly scoped to Blackcat mutations,
//! while single-table change history can interleave detected external changes
//! alongside Blackcat revisions and share them across workstations via the
//! central server.

use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};

use crate::types::TableExternalChangeEntry;

pub const TIME_KIND_EXACT: &str = "exact";
pub const TIME_KIND_DETECTED: &str = "detected";

pub const SIGNAL_UPDATE_TIME: &str = "update_time";
pub const SIGNAL_CREATE_TIME: &str = "create_time";
pub const SIGNAL_WRITE_COUNT: &str = "write_count";

pub const EXACT_COALESCE_WINDOW_MS: i64 = 5_000;
pub const DETECTED_COALESCE_WINDOW_MS: i64 = 90_000;
pub const DETECTED_BEFORE_EXACT_GRACE_MS: i64 = 15_000;
pub const EXACT_AUDIT_MATCH_BEFORE_MS: i64 = 5_000;
pub const EXACT_AUDIT_MATCH_AFTER_MS: i64 = 12_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalChangeAction {
    /// Record a newly detected external change (optionally archiving an older
    /// baseline database timestamp that was not yet written to the event log).
    Record {
        ts_ms: i64,
        time_kind: &'static str,
        signal: &'static str,
        archive_prior_exact_ms: Option<i64>,
    },
    /// Refine an earlier approximate (`detected`) event into an exact DB time.
    RefineToExact {
        approx_ts_ms: i64,
        exact_ts_ms: i64,
        signal: &'static str,
    },
    /// Retract a suspected local external event now explained by a Blackcat edit.
    Retract { approx_ts_ms: i64 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalChangePushItem {
    event_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_key: Option<String>,
    database: String,
    table_name: String,
    ts: String,
    ts_ms: i64,
    time_kind: String,
    signal: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalChangePushRequest {
    items: Vec<ExternalChangePushItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalChangePushResponse {
    #[serde(default)]
    accepted: u64,
    #[serde(default)]
    #[allow(dead_code)]
    skipped: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedExternalChangeWire {
    event_id: String,
    #[serde(default)]
    server_key: Option<String>,
    database: String,
    table_name: String,
    ts: String,
    ts_ms: i64,
    time_kind: String,
    signal: String,
}

pub fn format_utc_rfc3339_ms(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

pub(crate) async fn ensure_schema(pool: &SqlitePool) -> Result<(), String> {
    for stmt in [
        "CREATE TABLE IF NOT EXISTS table_external_changes (\
            id INTEGER PRIMARY KEY AUTOINCREMENT,\
            event_id TEXT NOT NULL UNIQUE,\
            server_key TEXT NOT NULL,\
            database_key TEXT NOT NULL,\
            database_name TEXT NOT NULL,\
            table_key TEXT NOT NULL,\
            table_name TEXT NOT NULL,\
            ts TEXT NOT NULL,\
            ts_ms INTEGER NOT NULL,\
            time_kind TEXT NOT NULL,\
            signal TEXT NOT NULL,\
            synced INTEGER NOT NULL DEFAULT 0,\
            created_at_ms INTEGER NOT NULL\
        )",
        "CREATE INDEX IF NOT EXISTS ix_tec_scope_ts \
            ON table_external_changes(server_key, database_key, table_key, ts_ms DESC)",
        "CREATE INDEX IF NOT EXISTS ix_tec_unsynced \
            ON table_external_changes(synced) WHERE synced = 0",
    ] {
        sqlx::query(stmt)
            .execute(pool)
            .await
            .map_err(|error| format!("创建外部变动记录表失败: {error}"))?;
    }
    Ok(())
}

async fn insert_or_coalesce_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    server_key: &str,
    database_name: &str,
    table_name: &str,
    ts_ms: i64,
    time_kind: &'static str,
    signal: &'static str,
    now_ms: i64,
) -> Result<Option<TableExternalChangeEntry>, String> {
    let trimmed_db = database_name.trim();
    let trimmed_table = table_name.trim();
    if server_key.trim().is_empty()
        || trimmed_db.is_empty()
        || trimmed_table.is_empty()
        || trimmed_table.starts_with('(')
        || ts_ms <= 0
    {
        return Ok(None);
    }

    let database_key = trimmed_db.to_lowercase();
    let table_key = trimmed_table.to_lowercase();
    let window_min = ts_ms.saturating_sub(DETECTED_COALESCE_WINDOW_MS);
    let window_max = ts_ms.saturating_add(DETECTED_COALESCE_WINDOW_MS);

    let nearby = sqlx::query(
        "SELECT id, event_id, ts_ms, time_kind \
         FROM table_external_changes \
         WHERE server_key = ? AND database_key = ? AND table_key = ? \
           AND ts_ms BETWEEN ? AND ? \
         ORDER BY ts_ms ASC",
    )
    .bind(server_key)
    .bind(&database_key)
    .bind(&table_key)
    .bind(window_min)
    .bind(window_max)
    .fetch_all(&mut **tx)
    .await
    .map_err(|error| format!("查询本地外部变动记录失败: {error}"))?;

    let rows: Vec<(i64, String, i64, String)> = nearby
        .into_iter()
        .map(|row| {
            (
                row.try_get::<i64, _>("id").unwrap_or(0),
                row.try_get::<String, _>("event_id").unwrap_or_default(),
                row.try_get::<i64, _>("ts_ms").unwrap_or(0),
                row.try_get::<String, _>("time_kind").unwrap_or_default(),
            )
        })
        .collect();

    let ts_iso = format_utc_rfc3339_ms(ts_ms);

    if time_kind == TIME_KIND_EXACT {
        if rows.iter().any(|(_, _, existing_ms, kind)| {
            kind == TIME_KIND_EXACT && (*existing_ms - ts_ms).abs() <= EXACT_COALESCE_WINDOW_MS
        }) {
            return Ok(None);
        }
        // Upgrade an existing nearby `detected` row to this exact DB timestamp.
        if let Some((existing_id, existing_event_id, _, _)) = rows.iter().find(|(_, _, existing_ms, kind)| {
            kind != TIME_KIND_EXACT
                && ts_ms <= existing_ms.saturating_add(DETECTED_BEFORE_EXACT_GRACE_MS)
                && *existing_ms <= ts_ms.saturating_add(DETECTED_COALESCE_WINDOW_MS)
        }) {
            sqlx::query(
                "UPDATE table_external_changes \
                 SET ts = ?, ts_ms = ?, time_kind = ?, signal = ?, synced = 0 \
                 WHERE id = ?",
            )
            .bind(&ts_iso)
            .bind(ts_ms)
            .bind(TIME_KIND_EXACT)
            .bind(signal)
            .bind(*existing_id)
            .execute(&mut **tx)
            .await
            .map_err(|error| format!("更新本地外部变动时间失败: {error}"))?;
            return Ok(Some(TableExternalChangeEntry {
                event_id: existing_event_id.clone(),
                server_key: Some(server_key.to_string()),
                database: trimmed_db.to_string(),
                table_name: trimmed_table.to_string(),
                ts: ts_iso,
                ts_ms,
                time_kind: TIME_KIND_EXACT.to_string(),
                signal: signal.to_string(),
                origin: "local".to_string(),
            }));
        }
    } else {
        if rows.iter().any(|(_, _, existing_ms, kind)| {
            kind == TIME_KIND_EXACT
                && *existing_ms <= ts_ms.saturating_add(DETECTED_BEFORE_EXACT_GRACE_MS)
                && ts_ms <= existing_ms.saturating_add(DETECTED_COALESCE_WINDOW_MS)
        }) {
            return Ok(None);
        }
        if rows.iter().any(|(_, _, existing_ms, kind)| {
            kind != TIME_KIND_EXACT && (*existing_ms - ts_ms).abs() <= DETECTED_COALESCE_WINDOW_MS
        }) {
            return Ok(None);
        }
    }

    let event_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT OR IGNORE INTO table_external_changes \
         (event_id, server_key, database_key, database_name, table_key, table_name, \
          ts, ts_ms, time_kind, signal, synced, created_at_ms) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(&event_id)
    .bind(server_key)
    .bind(&database_key)
    .bind(trimmed_db)
    .bind(&table_key)
    .bind(trimmed_table)
    .bind(&ts_iso)
    .bind(ts_ms)
    .bind(time_kind)
    .bind(signal)
    .bind(now_ms)
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("写入本地外部变动记录失败: {error}"))?;

    Ok(Some(TableExternalChangeEntry {
        event_id,
        server_key: Some(server_key.to_string()),
        database: trimmed_db.to_string(),
        table_name: trimmed_table.to_string(),
        ts: ts_iso,
        ts_ms,
        time_kind: time_kind.to_string(),
        signal: signal.to_string(),
        origin: "local".to_string(),
    }))
}

pub async fn retract_around_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    server_key: &str,
    database_key: &str,
    table_key: &str,
    center_ts_ms: i64,
) -> Result<u64, String> {
    let min_ms = center_ts_ms.saturating_sub(DETECTED_BEFORE_EXACT_GRACE_MS);
    let max_ms = center_ts_ms.saturating_add(DETECTED_COALESCE_WINDOW_MS);
    let res = sqlx::query(
        "DELETE FROM table_external_changes \
         WHERE server_key = ? AND database_key = ? AND table_key = ? \
           AND ( \
               (time_kind = 'exact' AND ts_ms BETWEEN ? AND ?) \
               OR (time_kind != 'exact' AND ts_ms BETWEEN ? AND ?) \
           )",
    )
    .bind(server_key)
    .bind(database_key)
    .bind(table_key)
    .bind(center_ts_ms.saturating_sub(EXACT_AUDIT_MATCH_BEFORE_MS))
    .bind(center_ts_ms.saturating_add(EXACT_AUDIT_MATCH_AFTER_MS))
    .bind(min_ms)
    .bind(max_ms)
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("撤回误报外部变动失败: {error}"))?;
    Ok(res.rows_affected())
}

pub async fn apply_action_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    server_key: &str,
    database_name: &str,
    table_name: &str,
    action: &ExternalChangeAction,
    now_ms: i64,
) -> Result<Option<TableExternalChangeEntry>, String> {
    let database_key = database_name.trim().to_lowercase();
    let table_key = table_name.trim().to_lowercase();
    match action {
        ExternalChangeAction::Record {
            ts_ms,
            time_kind,
            signal,
            archive_prior_exact_ms,
        } => {
            if let Some(prior_ms) = archive_prior_exact_ms {
                if *prior_ms > 0 && (*ts_ms - *prior_ms).abs() > EXACT_COALESCE_WINDOW_MS {
                    let _ = insert_or_coalesce_in_tx(
                        tx,
                        server_key,
                        database_name,
                        table_name,
                        *prior_ms,
                        TIME_KIND_EXACT,
                        SIGNAL_UPDATE_TIME,
                        now_ms,
                    )
                    .await?;
                }
            }
            insert_or_coalesce_in_tx(
                tx,
                server_key,
                database_name,
                table_name,
                *ts_ms,
                time_kind,
                signal,
                now_ms,
            )
            .await
        }
        ExternalChangeAction::RefineToExact {
            approx_ts_ms,
            exact_ts_ms,
            signal,
        } => {
            let min_ms = approx_ts_ms.saturating_sub(DETECTED_COALESCE_WINDOW_MS);
            let max_ms = approx_ts_ms.saturating_add(DETECTED_COALESCE_WINDOW_MS);
            let candidate = sqlx::query(
                "SELECT id, event_id \
                 FROM table_external_changes \
                 WHERE server_key = ? AND database_key = ? AND table_key = ? \
                   AND time_kind != 'exact' AND ts_ms BETWEEN ? AND ? \
                 ORDER BY ABS(ts_ms - ?) ASC LIMIT 1",
            )
            .bind(server_key)
            .bind(&database_key)
            .bind(&table_key)
            .bind(min_ms)
            .bind(max_ms)
            .bind(*approx_ts_ms)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|error| format!("查找待精确化外部变动失败: {error}"))?;

            if let Some(row) = candidate {
                let id: i64 = row.try_get("id").unwrap_or(0);
                let event_id: String = row.try_get("event_id").unwrap_or_default();
                let ts_iso = format_utc_rfc3339_ms(*exact_ts_ms);
                sqlx::query(
                    "UPDATE table_external_changes \
                     SET ts = ?, ts_ms = ?, time_kind = ?, signal = ?, synced = 0 \
                     WHERE id = ?",
                )
                .bind(&ts_iso)
                .bind(*exact_ts_ms)
                .bind(TIME_KIND_EXACT)
                .bind(*signal)
                .bind(id)
                .execute(&mut **tx)
                .await
                .map_err(|error| format!("精确化外部变动时间失败: {error}"))?;
                return Ok(Some(TableExternalChangeEntry {
                    event_id,
                    server_key: Some(server_key.to_string()),
                    database: database_name.trim().to_string(),
                    table_name: table_name.trim().to_string(),
                    ts: ts_iso,
                    ts_ms: *exact_ts_ms,
                    time_kind: TIME_KIND_EXACT.to_string(),
                    signal: (*signal).to_string(),
                    origin: "local".to_string(),
                }));
            }
            insert_or_coalesce_in_tx(
                tx,
                server_key,
                database_name,
                table_name,
                *exact_ts_ms,
                TIME_KIND_EXACT,
                signal,
                now_ms,
            )
            .await
        }
        ExternalChangeAction::Retract { approx_ts_ms } => {
            let _ =
                retract_around_in_tx(tx, server_key, &database_key, &table_key, *approx_ts_ms)
                    .await?;
            Ok(None)
        }
    }
}

pub async fn archive_prior_external_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    server_key: &str,
    database_name: &str,
    table_name: &str,
    prev_ts_ms: i64,
    is_exact: bool,
    now_ms: i64,
) -> Result<bool, String> {
    // Only archive genuinely older external timestamps so a local write never
    // accidentally archives a recent clock-skew echo.
    if prev_ts_ms <= 0 || now_ms.saturating_sub(prev_ts_ms) <= EXACT_AUDIT_MATCH_AFTER_MS {
        return Ok(false);
    }
    let time_kind = if is_exact {
        TIME_KIND_EXACT
    } else {
        TIME_KIND_DETECTED
    };
    let signal = if is_exact {
        SIGNAL_UPDATE_TIME
    } else {
        SIGNAL_WRITE_COUNT
    };
    Ok(insert_or_coalesce_in_tx(
        tx,
        server_key,
        database_name,
        table_name,
        prev_ts_ms,
        time_kind,
        signal,
        now_ms,
    )
    .await?
    .is_some())
}

pub async fn list_local(
    pool: &SqlitePool,
    server_key: &str,
    database: &str,
    table_name: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<TableExternalChangeEntry>, String> {
    let database_key = database.trim().to_lowercase();
    let table_key = table_name.trim().to_lowercase();
    if server_key.trim().is_empty() || database_key.is_empty() || table_key.is_empty() {
        return Ok(Vec::new());
    }
    let clamped_limit = limit.clamp(1, 500) as i64;
    let rows = sqlx::query(
        "SELECT event_id, server_key, database_name, table_name, ts, ts_ms, time_kind, signal \
         FROM table_external_changes \
         WHERE server_key = ? AND database_key = ? AND table_key = ? \
         ORDER BY ts_ms DESC, id DESC \
         LIMIT ? OFFSET ?",
    )
    .bind(server_key)
    .bind(&database_key)
    .bind(&table_key)
    .bind(clamped_limit)
    .bind(offset as i64)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取本地外部变动记录失败: {error}"))?;

    Ok(rows
        .into_iter()
        .map(|row| TableExternalChangeEntry {
            event_id: row.try_get("event_id").unwrap_or_default(),
            server_key: row.try_get::<Option<String>, _>("server_key").ok().flatten(),
            database: row.try_get("database_name").unwrap_or_default(),
            table_name: row.try_get("table_name").unwrap_or_default(),
            ts: row.try_get("ts").unwrap_or_default(),
            ts_ms: row.try_get("ts_ms").unwrap_or(0),
            time_kind: row.try_get("time_kind").unwrap_or_default(),
            signal: row.try_get("signal").unwrap_or_default(),
            origin: "local".to_string(),
        })
        .collect())
}

/// Push unsynced local external change events to the central server.
/// Gracefully treats 404/405/501 from older servers as a no-op without failing
/// audit sync.
pub async fn push_outbox(
    pool: &SqlitePool,
    http: &reqwest::Client,
    base_url: &str,
    token: &str,
    host: Option<String>,
) -> Result<u64, String> {
    let rows = sqlx::query(
        "SELECT id, event_id, server_key, database_name, table_name, ts, ts_ms, time_kind, signal \
         FROM table_external_changes \
         WHERE synced = 0 \
         ORDER BY id ASC \
         LIMIT 200",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("查询待同步外部变动失败: {error}"))?;

    if rows.is_empty() {
        return Ok(0);
    }

    let mut ids = Vec::with_capacity(rows.len());
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let id: i64 = row.try_get("id").unwrap_or(0);
        let server_key: String = row.try_get("server_key").unwrap_or_default();
        if server_key.starts_with("demo://") {
            ids.push(id);
            continue;
        }
        ids.push(id);
        items.push(ExternalChangePushItem {
            event_id: row.try_get("event_id").unwrap_or_default(),
            server_key: if server_key.is_empty() {
                None
            } else {
                Some(server_key)
            },
            database: row.try_get("database_name").unwrap_or_default(),
            table_name: row.try_get("table_name").unwrap_or_default(),
            ts: row.try_get("ts").unwrap_or_default(),
            ts_ms: row.try_get("ts_ms").unwrap_or(0),
            time_kind: row.try_get("time_kind").unwrap_or_default(),
            signal: row.try_get("signal").unwrap_or_default(),
            host: host.clone(),
        });
    }

    let mut accepted = 0_u64;
    if !items.is_empty() {
        let url = format!("{base_url}/external-changes");
        let resp = http
            .post(&url)
            .bearer_auth(token)
            .timeout(Duration::from_secs(6))
            .json(&ExternalChangePushRequest { items })
            .send()
            .await
            .map_err(|error| format!("推送外部变动记录失败: {error}"))?;
        let status = resp.status();
        if matches!(
            status,
            StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED | StatusCode::NOT_IMPLEMENTED
        ) {
            return Ok(0);
        }
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("推送外部变动失败: {status} {text}"));
        }
        if let Ok(parsed) = resp.json::<ExternalChangePushResponse>().await {
            accepted = parsed.accepted;
        }
    }

    if !ids.is_empty() {
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!("UPDATE table_external_changes SET synced = 1 WHERE id IN ({placeholders})");
        let mut query = sqlx::query(&sql);
        for id in &ids {
            query = query.bind(id);
        }
        query
            .execute(pool)
            .await
            .map_err(|error| format!("标记外部变动同步状态失败: {error}"))?;
    }

    Ok(accepted)
}

pub enum SharedFetchOutcome {
    Ok(Vec<TableExternalChangeEntry>),
    Unauthorized(String),
}

/// Fetch team-shared external changes for one table from the central server,
/// surfacing `401 Unauthorized` separately so callers can trigger session
/// recovery and retry once.
pub async fn fetch_shared_outcome(
    http: &reqwest::Client,
    base_url: &str,
    token: &str,
    server_key: Option<&str>,
    database: &str,
    table_name: &str,
    limit: u32,
    offset: u32,
) -> Result<SharedFetchOutcome, String> {
    let endpoint = format!("{base_url}/external-changes");
    let mut params: Vec<(&str, String)> = vec![
        ("database", database.to_string()),
        ("tableName", table_name.to_string()),
        ("limit", limit.clamp(1, 500).to_string()),
        ("offset", offset.to_string()),
    ];
    if let Some(key) = server_key.map(str::trim).filter(|s| !s.is_empty()) {
        params.push(("serverKey", key.to_string()));
    }
    let url = Url::parse_with_params(&endpoint, &params)
        .map_err(|error| format!("构建外部变动查询地址失败: {error}"))?;

    let resp = http
        .get(url)
        .bearer_auth(token)
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .map_err(|error| format!("查询共享外部变动失败: {error}"))?;

    let status = resp.status();
    if status == StatusCode::UNAUTHORIZED {
        let text = resp.text().await.unwrap_or_default();
        return Ok(SharedFetchOutcome::Unauthorized(format!(
            "中心服务返回 {status}: {text}"
        )));
    }
    if matches!(
        status,
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED | StatusCode::NOT_IMPLEMENTED
    ) {
        return Ok(SharedFetchOutcome::Ok(Vec::new()));
    }
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("中心服务返回 {status}: {text}"));
    }
    let rows = resp
        .json::<Vec<SharedExternalChangeWire>>()
        .await
        .map_err(|error| format!("解析共享外部变动失败: {error}"))?;

    Ok(SharedFetchOutcome::Ok(
        rows.into_iter()
            .map(|row| TableExternalChangeEntry {
                event_id: row.event_id,
                server_key: row.server_key,
                database: row.database,
                table_name: row.table_name,
                ts: row.ts,
                ts_ms: row.ts_ms,
                time_kind: row.time_kind,
                signal: row.signal,
                origin: "shared".to_string(),
            })
            .collect(),
    ))
}

/// Fetch team-shared external changes for one table from the central server.
/// Older servers without `/external-changes` degrade cleanly to an empty list.
#[allow(dead_code)]
pub async fn fetch_shared(
    http: &reqwest::Client,
    base_url: &str,
    token: &str,
    server_key: Option<&str>,
    database: &str,
    table_name: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<TableExternalChangeEntry>, String> {
    match fetch_shared_outcome(
        http, base_url, token, server_key, database, table_name, limit, offset,
    )
    .await?
    {
        SharedFetchOutcome::Ok(rows) => Ok(rows),
        SharedFetchOutcome::Unauthorized(err) => Err(err),
    }
}
