//! Persistent table modification time tracking.
//!
//! Combines three sources per `(server_key, database, table)` and always retains
//! the newest timestamp in `audit.sqlite` so InnoDB restarts, cache eviction, or
//! audit-log retention pruning never clear the modified column back to empty:
//!
//! 1. Local Blackcat mutations (cell edits, inserts, deletes, imports, DDL,
//!    table copy/rename, overwrite sync, SQL console, rollbacks, MCP writes),
//!    plus one-time incremental backfill from existing local `audit_log`.
//! 2. Central-server shared audit log (`/audit/table-latest`), matched across
//!    workstations by canonical `server_key` (`kind://host:port`) even when two
//!    machines assign different local `connection_id`s.
//! 3. Non-invasive live database observation: fresh MySQL `UPDATE_TIME`
//!    (bypassing MySQL 8's 24h `information_schema_stats_expiry`), table
//!    `CREATE_TIME` changes, and `performance_schema` table write counters
//!    (`COUNT_WRITE`) with server-restart detection via `Uptime`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use reqwest::Url;
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Emitter, Manager};

use crate::audit;
use crate::db::{MysqlDatabaseObservation, MysqlSingleTableObservation};
use crate::external_changes::{
    self, ExternalChangeAction, SIGNAL_CREATE_TIME, SIGNAL_UPDATE_TIME, SIGNAL_WRITE_COUNT,
    TIME_KIND_DETECTED, TIME_KIND_EXACT,
};
use crate::types::{AppState, DatabaseKind, RuntimeConnection, TableExternalChangeEntry, TableOption};

pub const TABLE_MODIFIED_TIMES_UPDATED_EVENT: &str = "table-modified-times-updated";

pub const SOURCE_BLACKCAT: &str = "blackcat";
pub const SOURCE_SHARED: &str = "shared";
pub const SOURCE_DATABASE: &str = "database";
pub const SOURCE_EXTERNAL: &str = "external";

/// Grace window so minor clock skew between the MySQL server and local PC does
/// not clobber `"blackcat"` / `"shared"` actor attribution right after a write.
const CLOCK_SKEW_GRACE_MS: i64 = 120_000;
const NORMALIZED_LOCAL_PENDING_GRACE_MS: i64 = 5_000;
const NORMALIZED_AUDIT_GRACE_MS: i64 = 12_000;
const CLOCK_SKEW_NORMALIZE_THRESHOLD_MS: i64 = 3_000;
const SELF_ECHO_GRACE_MS: i64 = 5_000;
const SERVER_BOOT_TOLERANCE_SECS: i64 = 120;
const SHARED_REFRESH_DEBOUNCE: Duration = Duration::from_secs(15);
const DB_OBSERVE_DEBOUNCE: Duration = Duration::from_secs(10);

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct MysqlServerCapabilities {
    pub stats_expiry_supported: Option<bool>,
    pub perf_schema_supported: Option<bool>,
}

#[derive(Default)]
pub struct TableModifiedState {
    capabilities: Mutex<HashMap<String, MysqlServerCapabilities>>,
    last_shared_fetch: Mutex<HashMap<(String, String), Instant>>,
    last_db_observe: Mutex<HashMap<(String, String), Instant>>,
}

impl TableModifiedState {
    pub fn capabilities_for(&self, server_key: &str) -> MysqlServerCapabilities {
        self.capabilities
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(server_key)
            .copied()
            .unwrap_or_default()
    }

    pub fn set_stats_expiry_supported(&self, server_key: &str, supported: bool) {
        self.capabilities
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(server_key.to_string())
            .or_default()
            .stats_expiry_supported = Some(supported);
    }

    pub fn set_perf_schema_supported(&self, server_key: &str, supported: bool) {
        self.capabilities
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(server_key.to_string())
            .or_default()
            .perf_schema_supported = Some(supported);
    }

    pub fn claim_shared_fetch(&self, server_key: &str, database: &str, force: bool) -> bool {
        let mut guard = self
            .last_shared_fetch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let key = (server_key.to_string(), database.to_lowercase());
        let now = Instant::now();
        if !force {
            if let Some(last) = guard.get(&key) {
                if now.duration_since(*last) < SHARED_REFRESH_DEBOUNCE {
                    return false;
                }
            }
        }
        guard.insert(key, now);
        true
    }

    pub fn clear_shared_fetch_debounce(&self) {
        self.last_shared_fetch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    pub fn claim_db_observe(&self, server_key: &str, database: &str, force: bool) -> bool {
        let mut guard = self
            .last_db_observe
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let key = (server_key.to_string(), database.to_lowercase());
        let now = Instant::now();
        if !force {
            if let Some(last) = guard.get(&key) {
                if now.duration_since(*last) < DB_OBSERVE_DEBOUNCE {
                    return false;
                }
            }
        }
        guard.insert(key, now);
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedTableLatest {
    pub table_name: String,
    pub ts_ms: i64,
    pub actor: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableModifiedUpdateItem {
    pub table_name: String,
    pub modified_at: String,
    pub modified_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_actor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableModifiedTimesUpdatedPayload {
    pub connection_id: String,
    pub database: String,
    pub updates: Vec<TableModifiedUpdateItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SavedRow {
    table_key: String,
    table_name: String,
    modified_at_ms: Option<i64>,
    modified_source: Option<String>,
    modified_actor: Option<String>,
    pending_local_write_ms: Option<i64>,
    observed_write_count: Option<i64>,
    observed_create_time: Option<String>,
    observed_server_boot: Option<i64>,
    last_shared_ts_ms: Option<i64>,
}

impl SavedRow {
    fn new(table_name: &str) -> Self {
        Self {
            table_key: table_name.to_lowercase(),
            table_name: table_name.to_string(),
            modified_at_ms: None,
            modified_source: None,
            modified_actor: None,
            pending_local_write_ms: None,
            observed_write_count: None,
            observed_create_time: None,
            observed_server_boot: None,
            last_shared_ts_ms: None,
        }
    }
}

fn extract_host_port_from_url(raw: &str, default_port: u16) -> Option<(String, u16)> {
    let parsed = Url::parse(raw.trim()).ok()?;
    let host = parsed.host_str()?.trim().to_lowercase();
    if host.is_empty() {
        return None;
    }
    let port = parsed.port().unwrap_or_else(|| {
        if parsed.scheme().eq_ignore_ascii_case("https") && default_port == 8123 {
            8443
        } else {
            default_port
        }
    });
    Some((host, port))
}

pub fn server_key_for_connection(connection: &RuntimeConnection) -> String {
    let (scheme, raw_url, default_port) = match connection.kind {
        DatabaseKind::MySql => ("mysql", connection.mysql_url.as_deref(), 3306_u16),
        DatabaseKind::ClickHouse => ("clickhouse", connection.clickhouse_url.as_deref(), 8123_u16),
        DatabaseKind::MongoDb => ("mongodb", connection.mongodb_url.as_deref(), 27017_u16),
    };
    let Some(raw_url) = raw_url.filter(|value| !value.trim().is_empty()) else {
        return format!("demo://{}", connection.id);
    };
    if let Some((host, port)) = extract_host_port_from_url(raw_url, default_port) {
        return format!("{scheme}://{host}:{port}");
    }
    let host = connection.host.trim().to_lowercase();
    format!("{scheme}://{host}:{}", connection.port)
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

pub fn format_local_ms(ms: i64) -> String {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .or_else(|| {
            Utc.timestamp_millis_opt(ms)
                .single()
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        })
        .unwrap_or_default()
}

pub fn parse_timestamp_ms(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.timestamp_millis());
    }
    for fmt in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, fmt) {
            if let Some(dt) = Local.from_local_datetime(&naive).earliest() {
                return Some(dt.timestamp_millis());
            }
            return Some(Utc.from_utc_datetime(&naive).timestamp_millis());
        }
    }
    None
}

/// Extract `(database, table_name)` from a raw SQL object string such as
/// `` `newsg_4cfg`.`goodsprop` `` or `goodsprop`. Returns `None` for synthetic
/// placeholders like `(sql_console)` or `(agent)`.
pub fn normalize_sql_target(default_database: &str, raw_object: &str) -> Option<(String, String)> {
    let pretrimmed = raw_object.trim();
    if pretrimmed.is_empty() || pretrimmed.starts_with('(') {
        return None;
    }
    let trimmed = pretrimmed.trim_matches(|ch: char| "`\"'();,".contains(ch));
    if trimmed.is_empty() {
        return None;
    }
    let upper = trimmed.to_ascii_uppercase();
    if matches!(upper.as_str(), "IF" | "EXISTS" | "NOT" | "TABLE" | "INTO" | "FROM") {
        return None;
    }
    if let Some((db, table)) = trimmed.split_once('.') {
        let db = db.trim().trim_matches(|ch: char| "`\"'".contains(ch));
        let table = table.trim().trim_matches(|ch: char| "`\"'".contains(ch));
        if table.is_empty() {
            return None;
        }
        let target_db = if db.is_empty() { default_database } else { db };
        return Some((target_db.to_string(), table.to_string()));
    }
    Some((default_database.to_string(), trimmed.to_string()))
}

pub fn resolve_sql_target_table(default_database: &str, sql: &str) -> Option<(String, String)> {
    let raw = crate::sql_console::affected_object(sql);
    normalize_sql_target(default_database, &raw)
}

pub(crate) async fn ensure_schema(pool: &SqlitePool) -> Result<(), String> {
    for stmt in [
        "CREATE TABLE IF NOT EXISTS table_modified_state (\
            server_key TEXT NOT NULL,\
            database_key TEXT NOT NULL,\
            table_key TEXT NOT NULL,\
            table_name TEXT NOT NULL,\
            modified_at_ms INTEGER,\
            modified_source TEXT,\
            modified_actor TEXT,\
            pending_local_write_ms INTEGER,\
            observed_write_count INTEGER,\
            observed_create_time TEXT,\
            observed_server_boot INTEGER,\
            last_shared_ts_ms INTEGER,\
            updated_at_ms INTEGER NOT NULL,\
            PRIMARY KEY (server_key, database_key, table_key)\
        )",
        "CREATE INDEX IF NOT EXISTS ix_tms_server_db \
            ON table_modified_state(server_key, database_key)",
        "CREATE TABLE IF NOT EXISTS table_modified_meta (\
            server_key TEXT NOT NULL,\
            database_key TEXT NOT NULL,\
            audit_backfilled_id INTEGER NOT NULL DEFAULT 0,\
            has_observed_db INTEGER NOT NULL DEFAULT 0,\
            PRIMARY KEY (server_key, database_key)\
        )",
    ] {
        sqlx::query(stmt)
            .execute(pool)
            .await
            .map_err(|error| format!("创建表修改时间记录表失败: {error}"))?;
    }
    if let Err(error) =
        sqlx::query("ALTER TABLE table_modified_state ADD COLUMN last_shared_ts_ms INTEGER")
            .execute(pool)
            .await
    {
        if !error.to_string().contains("duplicate column name") {
            return Err(format!("迁移表修改时间共享时间戳列失败: {error}"));
        }
    }
    external_changes::ensure_schema(pool).await?;
    Ok(())
}

async fn load_meta(
    pool: &SqlitePool,
    server_key: &str,
    database_key: &str,
) -> Result<(i64, bool), String> {
    let row = sqlx::query(
        "SELECT audit_backfilled_id, has_observed_db \
         FROM table_modified_meta \
         WHERE server_key = ? AND database_key = ?",
    )
    .bind(server_key)
    .bind(database_key)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("读取表修改时间元数据失败: {error}"))?;
    Ok(match row {
        Some(row) => (
            row.try_get::<i64, _>("audit_backfilled_id").unwrap_or(0),
            row.try_get::<i64, _>("has_observed_db").unwrap_or(0) != 0,
        ),
        None => (0, false),
    })
}

async fn save_meta(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    server_key: &str,
    database_key: &str,
    audit_backfilled_id: i64,
    has_observed_db: bool,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO table_modified_meta (server_key, database_key, audit_backfilled_id, has_observed_db) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(server_key, database_key) DO UPDATE SET \
             audit_backfilled_id = MAX(audit_backfilled_id, excluded.audit_backfilled_id), \
             has_observed_db = MAX(has_observed_db, excluded.has_observed_db)",
    )
    .bind(server_key)
    .bind(database_key)
    .bind(audit_backfilled_id)
    .bind(if has_observed_db { 1_i64 } else { 0_i64 })
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("保存表修改时间元数据失败: {error}"))?;
    Ok(())
}

async fn load_saved_rows(
    pool: &SqlitePool,
    server_key: &str,
    database_key: &str,
) -> Result<HashMap<String, SavedRow>, String> {
    let rows = sqlx::query(
        "SELECT table_key, table_name, modified_at_ms, modified_source, modified_actor, \
                pending_local_write_ms, observed_write_count, observed_create_time, \
                observed_server_boot, last_shared_ts_ms \
         FROM table_modified_state \
         WHERE server_key = ? AND database_key = ?",
    )
    .bind(server_key)
    .bind(database_key)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取表修改时间状态失败: {error}"))?;

    let mut map = HashMap::with_capacity(rows.len());
    for row in rows {
        let table_key: String = row.try_get("table_key").unwrap_or_default();
        if table_key.is_empty() {
            continue;
        }
        map.insert(
            table_key.clone(),
            SavedRow {
                table_key,
                table_name: row.try_get("table_name").unwrap_or_default(),
                modified_at_ms: row.try_get("modified_at_ms").ok().flatten(),
                modified_source: row.try_get("modified_source").ok().flatten(),
                modified_actor: row.try_get("modified_actor").ok().flatten(),
                pending_local_write_ms: row.try_get("pending_local_write_ms").ok().flatten(),
                observed_write_count: row.try_get("observed_write_count").ok().flatten(),
                observed_create_time: row.try_get("observed_create_time").ok().flatten(),
                observed_server_boot: row.try_get("observed_server_boot").ok().flatten(),
                last_shared_ts_ms: row.try_get("last_shared_ts_ms").ok().flatten(),
            },
        );
    }
    Ok(map)
}

async fn upsert_saved_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    server_key: &str,
    database_key: &str,
    row: &SavedRow,
    updated_at_ms: i64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO table_modified_state (\
             server_key, database_key, table_key, table_name, \
             modified_at_ms, modified_source, modified_actor, pending_local_write_ms, \
             observed_write_count, observed_create_time, observed_server_boot, \
             last_shared_ts_ms, updated_at_ms\
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(server_key, database_key, table_key) DO UPDATE SET \
             table_name = excluded.table_name, \
             modified_at_ms = excluded.modified_at_ms, \
             modified_source = excluded.modified_source, \
             modified_actor = excluded.modified_actor, \
             pending_local_write_ms = excluded.pending_local_write_ms, \
             observed_write_count = excluded.observed_write_count, \
             observed_create_time = excluded.observed_create_time, \
             observed_server_boot = excluded.observed_server_boot, \
             last_shared_ts_ms = excluded.last_shared_ts_ms, \
             updated_at_ms = excluded.updated_at_ms",
    )
    .bind(server_key)
    .bind(database_key)
    .bind(&row.table_key)
    .bind(&row.table_name)
    .bind(row.modified_at_ms)
    .bind(&row.modified_source)
    .bind(&row.modified_actor)
    .bind(row.pending_local_write_ms)
    .bind(row.observed_write_count)
    .bind(&row.observed_create_time)
    .bind(row.observed_server_boot)
    .bind(row.last_shared_ts_ms)
    .bind(updated_at_ms)
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("写入表修改时间状态失败: {error}"))?;
    Ok(())
}

/// Incrementally fold any committed/rolled-back local `audit_log` entries for
/// `(connection_id, database)` into `saved` and return the new highest `id`.
async fn fold_local_audit_backfill(
    pool: &SqlitePool,
    connection_id: &str,
    database_key: &str,
    since_id: i64,
    saved: &mut HashMap<String, SavedRow>,
    dirty_keys: &mut Vec<String>,
) -> Result<i64, String> {
    let rows = sqlx::query(
        "SELECT id, table_name, ts, actor \
         FROM audit_log \
         WHERE id IN ( \
             SELECT MAX(id) \
             FROM audit_log \
             WHERE connection_id = ? \
               AND LOWER(database) = ? \
               AND status IN ('committed', 'rolled_back') \
               AND id > ? \
               AND table_name NOT LIKE '(%' \
             GROUP BY LOWER(table_name) \
         )",
    )
    .bind(connection_id)
    .bind(database_key)
    .bind(since_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("回填本地审计修改时间失败: {error}"))?;

    let mut max_id = since_id;
    for row in rows {
        let id: i64 = row.try_get("id").unwrap_or(0);
        if id > max_id {
            max_id = id;
        }
        let table_name: String = row.try_get("table_name").unwrap_or_default();
        let ts: String = row.try_get("ts").unwrap_or_default();
        let actor: Option<String> = row
            .try_get::<Option<String>, _>("actor")
            .ok()
            .flatten()
            .filter(|value| !value.trim().is_empty());
        let Some(ts_ms) = parse_timestamp_ms(&ts) else {
            continue;
        };
        let key = table_name.to_lowercase();
        if key.is_empty() {
            continue;
        }
        let entry = saved
            .entry(key.clone())
            .or_insert_with(|| SavedRow::new(&table_name));
        let should_update = match entry.modified_at_ms {
            None => true,
            Some(current_ms) => ts_ms > current_ms,
        };
        if should_update {
            entry.table_name = table_name;
            entry.modified_at_ms = Some(ts_ms);
            entry.modified_source = Some(SOURCE_BLACKCAT.into());
            entry.modified_actor = actor;
            dirty_keys.push(key);
        }
    }
    Ok(max_id)
}

fn apply_shared_to_row(state: &mut SavedRow, shared: &SharedTableLatest) -> bool {
    if state
        .last_shared_ts_ms
        .is_some_and(|seen_ms| shared.ts_ms <= seen_ms)
    {
        return false;
    }
    state.last_shared_ts_ms = Some(shared.ts_ms);
    match state.modified_at_ms {
        None => {
            state.modified_at_ms = Some(shared.ts_ms);
            state.modified_source = Some(SOURCE_SHARED.into());
            state.modified_actor = shared.actor.clone();
            true
        }
        Some(current_ms) => {
            if matches!(
                state.modified_source.as_deref(),
                Some(SOURCE_EXTERNAL | SOURCE_DATABASE)
            ) {
                // Attach the exact teammate actor when a brand-new shared record
                // arrives shortly after we observed MySQL's UPDATE_TIME or write
                // count (covering push latency and minor server/PC clock skew).
                if shared.ts_ms >= current_ms - CLOCK_SKEW_GRACE_MS {
                    state.modified_at_ms = Some(shared.ts_ms);
                    state.modified_source = Some(SOURCE_SHARED.into());
                    state.modified_actor = shared.actor.clone();
                    return true;
                }
                return false;
            }
            if state.modified_source.as_deref() == Some(SOURCE_BLACKCAT) {
                let is_self_echo = match (&state.modified_actor, &shared.actor) {
                    (Some(local), Some(remote)) => {
                        local.eq_ignore_ascii_case(remote)
                            && shared.ts_ms <= current_ms.saturating_add(SELF_ECHO_GRACE_MS)
                            && shared.ts_ms >= current_ms.saturating_sub(CLOCK_SKEW_GRACE_MS)
                    }
                    (None, Some(_)) => {
                        shared.ts_ms <= current_ms.saturating_add(SELF_ECHO_GRACE_MS)
                            && shared.ts_ms >= current_ms.saturating_sub(CLOCK_SKEW_GRACE_MS)
                    }
                    _ => false,
                };
                if is_self_echo {
                    if state.modified_actor.is_none() && shared.actor.is_some() {
                        state.modified_actor = shared.actor.clone();
                        return true;
                    }
                    return false;
                }
            }
            if shared.ts_ms > current_ms {
                state.modified_at_ms = Some(shared.ts_ms);
                state.modified_source = Some(SOURCE_SHARED.into());
                state.modified_actor = shared.actor.clone();
                return true;
            }
            false
        }
    }
}

fn normalize_db_timestamp_ms(
    raw_ms: Option<i64>,
    server_now_epoch_secs: Option<i64>,
    local_now_ms: i64,
) -> Option<i64> {
    let raw = raw_ms?;
    let Some(server_secs) = server_now_epoch_secs.filter(|secs| *secs > 0) else {
        return Some(raw);
    };
    let skew_ms = server_secs.saturating_mul(1000).saturating_sub(local_now_ms);
    if skew_ms.abs() >= CLOCK_SKEW_NORMALIZE_THRESHOLD_MS {
        Some(raw.saturating_sub(skew_ms))
    } else {
        Some(raw)
    }
}

fn reconcile_mysql_row(
    saved: Option<&SavedRow>,
    obs: &crate::db::MysqlTableObservation,
    shared: Option<&SharedTableLatest>,
    server_boot_epoch: Option<i64>,
    server_now_epoch_secs: Option<i64>,
    has_observed_db: bool,
    now_ms: i64,
) -> (SavedRow, bool, Option<ExternalChangeAction>) {
    let initial_ms = saved.and_then(|row| row.modified_at_ms);
    let initial_source = saved.and_then(|row| row.modified_source.clone());
    let had_known_baseline = saved.is_some();

    let mut state = saved
        .cloned()
        .unwrap_or_else(|| SavedRow::new(&obs.option.table_name));
    state.table_name = obs.option.table_name.clone();

    let shared_changed = shared
        .map(|entry| apply_shared_to_row(&mut state, entry))
        .unwrap_or(false);
    let shared_claimed_external = shared_changed
        && matches!(
            initial_source.as_deref(),
            Some(SOURCE_DATABASE | SOURCE_EXTERNAL)
        );

    let norm_update_ms =
        normalize_db_timestamp_ms(obs.update_time_ms, server_now_epoch_secs, now_ms);
    let norm_create_ms =
        normalize_db_timestamp_ms(obs.create_time_ms, server_now_epoch_secs, now_ms);

    let same_boot = match (state.observed_server_boot, server_boot_epoch) {
        (Some(old), Some(new)) => (new - old).abs() <= SERVER_BOOT_TOLERANCE_SECS,
        _ => false,
    };
    let server_restarted = match (state.observed_server_boot, server_boot_epoch) {
        (Some(old), Some(new)) => new > old + SERVER_BOOT_TOLERANCE_SECS,
        _ => false,
    };

    let write_increased = same_boot
        && matches!(
            (state.observed_write_count, obs.write_count),
            (Some(old), Some(new)) if new > old
        );
    let post_restart_write = server_restarted
        && matches!(obs.write_count, Some(new) if new > 0)
        && matches!(
            server_boot_epoch,
            Some(boot) if state.modified_at_ms.unwrap_or(0) < boot.saturating_mul(1000)
        );
    let create_changed = matches!(
        (state.observed_create_time.as_deref(), obs.create_time.as_deref()),
        (Some(old), Some(new)) if old != new
    );
    let newly_appeared = saved.is_none() && has_observed_db;
    let has_pending_local = state.pending_local_write_ms.is_some();

    let pre_db_ms = state.modified_at_ms;
    let pre_db_source = state.modified_source.clone();

    let grace_ms = match state.modified_source.as_deref() {
        Some(SOURCE_BLACKCAT) => {
            if server_now_epoch_secs.is_some() {
                if has_pending_local {
                    NORMALIZED_LOCAL_PENDING_GRACE_MS
                } else {
                    NORMALIZED_AUDIT_GRACE_MS
                }
            } else {
                CLOCK_SKEW_GRACE_MS
            }
        }
        Some(SOURCE_SHARED) => {
            if server_now_epoch_secs.is_some() {
                NORMALIZED_AUDIT_GRACE_MS
            } else {
                CLOCK_SKEW_GRACE_MS
            }
        }
        _ => 0,
    };

    let mut db_updated = false;
    let mut external_action: Option<ExternalChangeAction> = None;

    if let Some(db_ms) = norm_update_ms {
        let should_apply_db_time = match state.modified_at_ms {
            None => true,
            Some(current_ms) => {
                if state.modified_source.as_deref() == Some(SOURCE_EXTERNAL)
                    && (db_ms - current_ms).abs() <= CLOCK_SKEW_GRACE_MS
                {
                    true
                } else {
                    db_ms > current_ms.saturating_add(grace_ms)
                }
            }
        };
        if should_apply_db_time {
            state.modified_at_ms = Some(db_ms);
            state.modified_source = Some(SOURCE_DATABASE.into());
            state.modified_actor = None;
            db_updated = true;

            if pre_db_source.as_deref() == Some(SOURCE_EXTERNAL)
                && pre_db_ms.is_some_and(|prev| (db_ms - prev).abs() <= CLOCK_SKEW_GRACE_MS)
            {
                external_action = Some(ExternalChangeAction::RefineToExact {
                    approx_ts_ms: pre_db_ms.unwrap_or(db_ms),
                    exact_ts_ms: db_ms,
                    signal: SIGNAL_UPDATE_TIME,
                });
            } else if had_known_baseline || pre_db_ms.is_some() {
                let archive_prior = if pre_db_source.as_deref() == Some(SOURCE_DATABASE) {
                    pre_db_ms
                } else {
                    None
                };
                external_action = Some(ExternalChangeAction::Record {
                    ts_ms: db_ms,
                    time_kind: TIME_KIND_EXACT,
                    signal: SIGNAL_UPDATE_TIME,
                    archive_prior_exact_ms: archive_prior,
                });
            }
        }
    }

    if !db_updated && newly_appeared && state.modified_at_ms.is_none() {
        if let Some(create_ms) = norm_create_ms {
            state.modified_at_ms = Some(create_ms);
            state.modified_source = Some(SOURCE_DATABASE.into());
            state.modified_actor = None;
            db_updated = true;
            external_action = Some(ExternalChangeAction::Record {
                ts_ms: create_ms,
                time_kind: TIME_KIND_EXACT,
                signal: SIGNAL_CREATE_TIME,
                archive_prior_exact_ms: None,
            });
        }
    }

    if !db_updated
        && !has_pending_local
        && !shared_changed
        && (write_increased || create_changed || post_restart_write)
    {
        let current_ms = state.modified_at_ms.unwrap_or(i64::MIN);
        let archive_prior = if pre_db_source.as_deref() == Some(SOURCE_DATABASE) {
            pre_db_ms
        } else {
            None
        };
        if let Some(db_ms) = norm_update_ms.filter(|ms| *ms > current_ms) {
            state.modified_at_ms = Some(db_ms);
            state.modified_source = Some(SOURCE_DATABASE.into());
            state.modified_actor = None;
            external_action = Some(ExternalChangeAction::Record {
                ts_ms: db_ms,
                time_kind: TIME_KIND_EXACT,
                signal: SIGNAL_UPDATE_TIME,
                archive_prior_exact_ms: archive_prior,
            });
        } else if create_changed {
            if let Some(create_ms) = norm_create_ms.filter(|ms| *ms > current_ms) {
                state.modified_at_ms = Some(create_ms);
                state.modified_source = Some(SOURCE_DATABASE.into());
                state.modified_actor = None;
                external_action = Some(ExternalChangeAction::Record {
                    ts_ms: create_ms,
                    time_kind: TIME_KIND_EXACT,
                    signal: SIGNAL_CREATE_TIME,
                    archive_prior_exact_ms: archive_prior,
                });
            } else if now_ms > current_ms {
                state.modified_at_ms = Some(now_ms);
                state.modified_source = Some(SOURCE_EXTERNAL.into());
                state.modified_actor = None;
                external_action = Some(ExternalChangeAction::Record {
                    ts_ms: now_ms,
                    time_kind: TIME_KIND_DETECTED,
                    signal: SIGNAL_CREATE_TIME,
                    archive_prior_exact_ms: archive_prior,
                });
            }
        } else if now_ms > current_ms {
            state.modified_at_ms = Some(now_ms);
            state.modified_source = Some(SOURCE_EXTERNAL.into());
            state.modified_actor = None;
            external_action = Some(ExternalChangeAction::Record {
                ts_ms: now_ms,
                time_kind: TIME_KIND_DETECTED,
                signal: SIGNAL_WRITE_COUNT,
                archive_prior_exact_ms: archive_prior,
            });
        }
    }

    if external_action.is_none() && shared_claimed_external {
        if let Some(old_ms) = initial_ms {
            external_action = Some(ExternalChangeAction::Retract {
                approx_ts_ms: old_ms,
            });
        }
    }

    if obs.write_count.is_some() {
        state.observed_write_count = obs.write_count;
    }
    if obs.create_time.is_some() {
        state.observed_create_time = obs.create_time.clone();
    }
    if server_boot_epoch.is_some() {
        state.observed_server_boot = server_boot_epoch;
    }
    state.pending_local_write_ms = None;

    let dirty = saved.map(|previous| *previous != state).unwrap_or(true);
    (state, dirty, external_action)
}

fn apply_state_to_option(option: &mut TableOption, state: &SavedRow) {
    if let Some(ms) = state.modified_at_ms {
        option.modified_at = Some(format_local_ms(ms));
        option.modified_source = state.modified_source.clone();
        option.modified_actor = state.modified_actor.clone();
    }
}

/// Fast, read-only local SQLite overlay for foreground table-list loads.
/// Merges already-persisted modification times without blocking on write
/// transactions, audit-log backfills, `information_schema_stats_expiry = 0`,
/// or `performance_schema` queries.
pub async fn overlay_saved_modified_times(
    pool: &SqlitePool,
    server_key: &str,
    database: &str,
    mut tables: Vec<TableOption>,
) -> Result<Vec<TableOption>, String> {
    let database_key = database.to_lowercase();
    let saved = load_saved_rows(pool, server_key, &database_key).await?;
    for option in &mut tables {
        let key = option.table_name.to_lowercase();
        let db_ms = option.modified_at.as_deref().and_then(parse_timestamp_ms);
        if let Some(state) = saved.get(&key) {
            let grace_ms = match state.modified_source.as_deref() {
                Some(SOURCE_BLACKCAT | SOURCE_SHARED) => CLOCK_SKEW_GRACE_MS,
                _ => 0,
            };
            let db_is_newer = match (db_ms, state.modified_at_ms) {
                (Some(db), Some(saved_ms)) => db > saved_ms.saturating_add(grace_ms),
                (Some(_), None) => true,
                _ => false,
            };
            if db_is_newer {
                option.modified_source = Some(SOURCE_DATABASE.into());
                option.modified_actor = None;
            } else {
                apply_state_to_option(option, state);
            }
        } else if option.modified_at.is_some() {
            option.modified_source = Some(SOURCE_DATABASE.into());
        }
    }
    Ok(tables)
}

pub fn emit_table_option_updates(
    app: &AppHandle,
    connection_id: &str,
    database: &str,
    previous: &[TableOption],
    next: &[TableOption],
) {
    let previous_by_key: HashMap<String, (&Option<String>, &Option<String>, &Option<String>)> =
        previous
            .iter()
            .map(|item| {
                (
                    item.table_name.to_lowercase(),
                    (
                        &item.modified_at,
                        &item.modified_source,
                        &item.modified_actor,
                    ),
                )
            })
            .collect();

    let mut updates = Vec::new();
    for item in next {
        let Some(modified_at) = item.modified_at.as_ref() else {
            continue;
        };
        let key = item.table_name.to_lowercase();
        let unchanged = previous_by_key.get(&key).is_some_and(|(prev_at, prev_src, prev_actor)| {
            *prev_at == &item.modified_at
                && *prev_src == &item.modified_source
                && *prev_actor == &item.modified_actor
        });
        if unchanged {
            continue;
        }
        updates.push(TableModifiedUpdateItem {
            table_name: item.table_name.clone(),
            modified_at: modified_at.clone(),
            modified_source: item
                .modified_source
                .clone()
                .unwrap_or_else(|| SOURCE_DATABASE.into()),
            modified_actor: item.modified_actor.clone(),
        });
    }
    emit_updates(app, connection_id, database, updates);
}

pub async fn reconcile_mysql_observation_with_events(
    pool: &SqlitePool,
    server_key: &str,
    connection_id: &str,
    database: &str,
    observation: MysqlDatabaseObservation,
    shared_updates: &[SharedTableLatest],
    now_ms: i64,
) -> Result<(Vec<TableOption>, bool), String> {
    let database_key = database.to_lowercase();
    let (backfilled_id, has_observed_db) = load_meta(pool, server_key, &database_key).await?;
    let mut saved = load_saved_rows(pool, server_key, &database_key).await?;
    let mut dirty_keys = Vec::new();
    let new_backfilled_id = fold_local_audit_backfill(
        pool,
        connection_id,
        &database_key,
        backfilled_id,
        &mut saved,
        &mut dirty_keys,
    )
    .await?;

    let shared_by_table: HashMap<String, &SharedTableLatest> = shared_updates
        .iter()
        .map(|item| (item.table_name.to_lowercase(), item))
        .collect();

    let mut result = Vec::with_capacity(observation.tables.len());
    let mut rows_to_persist = Vec::new();
    let mut external_actions: Vec<(String, ExternalChangeAction)> = Vec::new();
    for obs in observation.tables {
        let key = obs.option.table_name.to_lowercase();
        let existing = saved.get(&key);
        let shared = shared_by_table.get(&key).copied();
        let (next_state, dirty, action) = reconcile_mysql_row(
            existing,
            &obs,
            shared,
            observation.server_boot_epoch_secs,
            observation.server_now_epoch_secs,
            has_observed_db,
            now_ms,
        );
        let mut option = obs.option;
        apply_state_to_option(&mut option, &next_state);
        if dirty {
            rows_to_persist.push(next_state.clone());
        }
        if let Some(action) = action {
            external_actions.push((next_state.table_name.clone(), action));
        }
        saved.insert(key, next_state);
        result.push(option);
    }

    let need_meta_write = !has_observed_db || new_backfilled_id > backfilled_id;
    let mut recorded_external = false;
    if !rows_to_persist.is_empty() || !external_actions.is_empty() || need_meta_write {
        let mut tx = pool
            .begin()
            .await
            .map_err(|error| format!("开启表修改时间写入事务失败: {error}"))?;
        for row in &rows_to_persist {
            upsert_saved_row(&mut tx, server_key, &database_key, row, now_ms).await?;
        }
        for (table_name, action) in &external_actions {
            if external_changes::apply_action_in_tx(
                &mut tx, server_key, database, table_name, action, now_ms,
            )
            .await?
            .is_some()
            {
                recorded_external = true;
            }
        }
        if need_meta_write {
            save_meta(&mut tx, server_key, &database_key, new_backfilled_id, true).await?;
        }
        tx.commit()
            .await
            .map_err(|error| format!("提交表修改时间状态失败: {error}"))?;
    }

    Ok((result, recorded_external))
}

pub async fn reconcile_mysql_observation(
    pool: &SqlitePool,
    server_key: &str,
    connection_id: &str,
    database: &str,
    observation: MysqlDatabaseObservation,
    shared_updates: &[SharedTableLatest],
    now_ms: i64,
) -> Result<Vec<TableOption>, String> {
    let (tables, _) = reconcile_mysql_observation_with_events(
        pool,
        server_key,
        connection_id,
        database,
        observation,
        shared_updates,
        now_ms,
    )
    .await?;
    Ok(tables)
}

/// Reconcile a single-table observation (used when opening or refreshing one
/// table's change history) without marking the entire database as observed.
pub async fn reconcile_single_mysql_table(
    pool: &SqlitePool,
    server_key: &str,
    connection_id: &str,
    database: &str,
    observation: MysqlSingleTableObservation,
    shared_latest: Option<&SharedTableLatest>,
    now_ms: i64,
) -> Result<(TableOption, Option<TableExternalChangeEntry>), String> {
    let database_key = database.to_lowercase();
    let table_key = observation.table.option.table_name.to_lowercase();
    let (backfilled_id, _has_observed_db) = load_meta(pool, server_key, &database_key).await?;
    let mut saved = load_saved_rows(pool, server_key, &database_key).await?;
    let mut dirty_keys = Vec::new();
    let new_backfilled_id = fold_local_audit_backfill(
        pool,
        connection_id,
        &database_key,
        backfilled_id,
        &mut saved,
        &mut dirty_keys,
    )
    .await?;

    let existing = saved.get(&table_key);
    let (next_state, dirty, action) = reconcile_mysql_row(
        existing,
        &observation.table,
        shared_latest,
        observation.server_boot_epoch_secs,
        observation.server_now_epoch_secs,
        false,
        now_ms,
    );
    let mut option = observation.table.option;
    apply_state_to_option(&mut option, &next_state);

    let mut detected_event = None;
    let need_backfill_meta = new_backfilled_id > backfilled_id;
    if dirty || action.is_some() || need_backfill_meta {
        let mut tx = pool
            .begin()
            .await
            .map_err(|error| format!("开启单表状态写入事务失败: {error}"))?;
        if dirty {
            upsert_saved_row(&mut tx, server_key, &database_key, &next_state, now_ms).await?;
        }
        if let Some(action) = action.as_ref() {
            detected_event = external_changes::apply_action_in_tx(
                &mut tx,
                server_key,
                database,
                &next_state.table_name,
                action,
                now_ms,
            )
            .await?;
        }
        if need_backfill_meta {
            save_meta(&mut tx, server_key, &database_key, new_backfilled_id, false).await?;
        }
        tx.commit()
            .await
            .map_err(|error| format!("提交单表状态失败: {error}"))?;
    }

    Ok((option, detected_event))
}

/// Persistent merge for ClickHouse / MongoDB table lists.
pub async fn reconcile_generic_tables(
    pool: &SqlitePool,
    server_key: &str,
    connection_id: &str,
    database: &str,
    mut tables: Vec<TableOption>,
    shared_updates: &[SharedTableLatest],
    now_ms: i64,
) -> Result<Vec<TableOption>, String> {
    let database_key = database.to_lowercase();
    let (backfilled_id, has_observed_db) = load_meta(pool, server_key, &database_key).await?;
    let mut saved = load_saved_rows(pool, server_key, &database_key).await?;
    let mut dirty_keys = Vec::new();
    let new_backfilled_id = fold_local_audit_backfill(
        pool,
        connection_id,
        &database_key,
        backfilled_id,
        &mut saved,
        &mut dirty_keys,
    )
    .await?;

    let shared_by_table: HashMap<String, &SharedTableLatest> = shared_updates
        .iter()
        .map(|item| (item.table_name.to_lowercase(), item))
        .collect();

    let mut rows_to_persist = Vec::new();
    for option in &mut tables {
        let key = option.table_name.to_lowercase();
        let previous = saved.get(&key).cloned();
        let mut state = previous
            .clone()
            .unwrap_or_else(|| SavedRow::new(&option.table_name));
        state.table_name = option.table_name.clone();

        if let Some(shared) = shared_by_table.get(&key) {
            apply_shared_to_row(&mut state, shared);
        }
        if let Some(db_ms) = option.modified_at.as_deref().and_then(parse_timestamp_ms) {
            let grace = match state.modified_source.as_deref() {
                Some(SOURCE_BLACKCAT | SOURCE_SHARED) => CLOCK_SKEW_GRACE_MS,
                _ => 0,
            };
            if state
                .modified_at_ms
                .is_none_or(|current| db_ms > current.saturating_add(grace))
            {
                state.modified_at_ms = Some(db_ms);
                state.modified_source = Some(SOURCE_DATABASE.into());
                state.modified_actor = None;
            }
        }
        state.pending_local_write_ms = None;

        apply_state_to_option(option, &state);
        if previous.as_ref() != Some(&state) && state.modified_at_ms.is_some() {
            rows_to_persist.push(state.clone());
        }
        saved.insert(key, state);
    }

    let need_meta_write = !has_observed_db || new_backfilled_id > backfilled_id;
    if !rows_to_persist.is_empty() || need_meta_write {
        let mut tx = pool
            .begin()
            .await
            .map_err(|error| format!("开启表修改时间写入事务失败: {error}"))?;
        for row in &rows_to_persist {
            upsert_saved_row(&mut tx, server_key, &database_key, row, now_ms).await?;
        }
        if need_meta_write {
            save_meta(&mut tx, server_key, &database_key, new_backfilled_id, true).await?;
        }
        tx.commit()
            .await
            .map_err(|error| format!("提交表修改时间状态失败: {error}"))?;
    }

    Ok(tables)
}

async fn apply_shared_updates_to_store(
    pool: &SqlitePool,
    server_key: &str,
    database: &str,
    shared_updates: &[SharedTableLatest],
    now_ms: i64,
) -> Result<Vec<TableModifiedUpdateItem>, String> {
    if shared_updates.is_empty() {
        return Ok(Vec::new());
    }
    let database_key = database.to_lowercase();
    let mut saved = load_saved_rows(pool, server_key, &database_key).await?;
    let mut changed_rows = Vec::new();
    let mut retracted_external: Vec<(String, i64)> = Vec::new();
    let mut emitted = Vec::new();
    for entry in shared_updates {
        let key = entry.table_name.to_lowercase();
        if key.is_empty() {
            continue;
        }
        let mut state = saved
            .get(&key)
            .cloned()
            .unwrap_or_else(|| SavedRow::new(&entry.table_name));
        let prev_source = state.modified_source.clone();
        let prev_ms = state.modified_at_ms;
        if state.table_name.is_empty() {
            state.table_name = entry.table_name.clone();
        }
        if apply_shared_to_row(&mut state, entry) {
            if matches!(
                prev_source.as_deref(),
                Some(SOURCE_DATABASE | SOURCE_EXTERNAL)
            ) {
                if let Some(old_ms) = prev_ms {
                    retracted_external.push((key.clone(), old_ms));
                }
            }
            if let Some(ms) = state.modified_at_ms {
                emitted.push(TableModifiedUpdateItem {
                    table_name: state.table_name.clone(),
                    modified_at: format_local_ms(ms),
                    modified_source: state
                        .modified_source
                        .clone()
                        .unwrap_or_else(|| SOURCE_SHARED.into()),
                    modified_actor: state.modified_actor.clone(),
                });
            }
            changed_rows.push(state.clone());
            saved.insert(key, state);
        }
    }
    if !changed_rows.is_empty() || !retracted_external.is_empty() {
        let mut tx = pool
            .begin()
            .await
            .map_err(|error| format!("开启共享修改时间事务失败: {error}"))?;
        for row in &changed_rows {
            upsert_saved_row(&mut tx, server_key, &database_key, row, now_ms).await?;
        }
        for (table_key, old_ms) in &retracted_external {
            let _ = external_changes::retract_around_in_tx(
                &mut tx,
                server_key,
                &database_key,
                table_key,
                *old_ms,
            )
            .await?;
        }
        tx.commit()
            .await
            .map_err(|error| format!("保存共享修改时间失败: {error}"))?;
    }
    Ok(emitted)
}

async fn resolve_server_key(state: &AppState, connection_id: &str) -> Option<String> {
    let rt = state.runtime.lock().await;
    rt.connections
        .get(connection_id)
        .map(server_key_for_connection)
}

fn emit_updates(
    app: &AppHandle,
    connection_id: &str,
    database: &str,
    updates: Vec<TableModifiedUpdateItem>,
) {
    if updates.is_empty() {
        return;
    }
    let _ = app.emit(
        TABLE_MODIFIED_TIMES_UPDATED_EVENT,
        TableModifiedTimesUpdatedPayload {
            connection_id: connection_id.to_string(),
            database: database.to_string(),
            updates,
        },
    );
}

/// Best-effort immediate local timestamp update after a Blackcat write commits.
pub async fn record_local_change(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    database: &str,
    table_names: &[&str],
) {
    if database.trim().is_empty() || table_names.is_empty() {
        return;
    }
    let Some(server_key) = resolve_server_key(state, connection_id).await else {
        return;
    };
    let Ok(pool) = audit::ensure_audit_pool(app, state).await else {
        return;
    };
    let _ = crate::account::ensure_loaded(app, state).await;
    let actor = crate::account::current_actor(state).await;
    let now = now_ms();
    let database_key = database.to_lowercase();
    let saved = load_saved_rows(&pool, &server_key, &database_key)
        .await
        .unwrap_or_default();

    let mut seen = std::collections::HashSet::new();
    let mut rows_to_save = Vec::new();
    let mut archived_externals: Vec<(String, i64, bool)> = Vec::new();
    let mut updates = Vec::new();
    let formatted = format_local_ms(now);
    for raw_name in table_names {
        let name = raw_name.trim();
        if name.is_empty() || name.starts_with('(') {
            continue;
        }
        let key = name.to_lowercase();
        if !seen.insert(key.clone()) {
            continue;
        }
        let mut row = saved
            .get(&key)
            .cloned()
            .unwrap_or_else(|| SavedRow::new(name));
        if matches!(
            row.modified_source.as_deref(),
            Some(SOURCE_DATABASE | SOURCE_EXTERNAL)
        ) {
            if let Some(prev_ms) = row.modified_at_ms {
                archived_externals.push((
                    name.to_string(),
                    prev_ms,
                    row.modified_source.as_deref() == Some(SOURCE_DATABASE),
                ));
            }
        }
        row.table_name = name.to_string();
        row.modified_at_ms = Some(now);
        row.modified_source = Some(SOURCE_BLACKCAT.into());
        row.modified_actor = actor.clone();
        row.pending_local_write_ms = Some(now);
        rows_to_save.push(row);
        updates.push(TableModifiedUpdateItem {
            table_name: name.to_string(),
            modified_at: formatted.clone(),
            modified_source: SOURCE_BLACKCAT.into(),
            modified_actor: actor.clone(),
        });
    }
    if rows_to_save.is_empty() {
        return;
    }
    if let Ok(mut tx) = pool.begin().await {
        let mut ok = true;
        for (table_name, prev_ms, is_exact) in &archived_externals {
            let _ = external_changes::archive_prior_external_in_tx(
                &mut tx,
                &server_key,
                database,
                table_name,
                *prev_ms,
                *is_exact,
                now,
            )
            .await;
        }
        for row in &rows_to_save {
            if upsert_saved_row(&mut tx, &server_key, &database_key, row, now)
                .await
                .is_err()
            {
                ok = false;
                break;
            }
        }
        if ok {
            let _ = tx.commit().await;
        }
    }
    emit_updates(app, connection_id, database, updates);
}

pub async fn record_local_change_owned(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    database: &str,
    table_names: &[String],
) {
    let refs: Vec<&str> = table_names.iter().map(String::as_str).collect();
    record_local_change(app, state, connection_id, database, &refs).await;
}

pub async fn record_table_renamed(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    database: &str,
    old_name: &str,
    new_name: &str,
) {
    let Some(server_key) = resolve_server_key(state, connection_id).await else {
        return;
    };
    if let Ok(pool) = audit::ensure_audit_pool(app, state).await {
        let database_key = database.to_lowercase();
        let old_key = old_name.trim().to_lowercase();
        if !old_key.is_empty() && old_key != new_name.trim().to_lowercase() {
            let _ = sqlx::query(
                "DELETE FROM table_modified_state \
                 WHERE server_key = ? AND database_key = ? AND table_key = ?",
            )
            .bind(&server_key)
            .bind(&database_key)
            .bind(&old_key)
            .execute(&pool)
            .await;
        }
    }
    record_local_change(app, state, connection_id, database, &[new_name]).await;
}

pub async fn record_tables_dropped(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    database: &str,
    table_names: &[String],
) {
    if table_names.is_empty() {
        return;
    }
    let Some(server_key) = resolve_server_key(state, connection_id).await else {
        return;
    };
    let Ok(pool) = audit::ensure_audit_pool(app, state).await else {
        return;
    };
    let database_key = database.to_lowercase();
    for name in table_names {
        let key = name.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        let _ = sqlx::query(
            "DELETE FROM table_modified_state \
             WHERE server_key = ? AND database_key = ? AND table_key = ?",
        )
        .bind(&server_key)
        .bind(&database_key)
        .bind(&key)
        .execute(&pool)
        .await;
    }
}

/// Non-blocking background refresh of shared central-server modification times.
/// Called after foreground `select_database` / `list_tables` so UI opens
/// instantaneously without waiting on LAN HTTP latency.
pub fn spawn_background_shared_refresh(
    app: AppHandle,
    connection_id: String,
    database: String,
    server_key: String,
) {
    let state = app.state::<AppState>();
    if !state
        .table_modified
        .claim_shared_fetch(&server_key, &database, false)
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let shared = crate::audit_sync::fetch_shared_table_latest(
            &app,
            &state,
            &server_key,
            &connection_id,
            &database,
        )
        .await;
        if shared.is_empty() {
            return;
        }
        let Ok(pool) = audit::ensure_audit_pool(&app, &state).await else {
            return;
        };
        if let Ok(updates) =
            apply_shared_updates_to_store(&pool, &server_key, &database, &shared, now_ms()).await
        {
            emit_updates(&app, &connection_id, &database, updates);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::MysqlTableObservation;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn memory_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::audit::ensure_schema(&pool).await.unwrap();
        pool
    }

    fn mysql_obs(
        name: &str,
        update_time_ms: Option<i64>,
        create_time: Option<&str>,
        create_time_ms: Option<i64>,
        write_count: Option<i64>,
    ) -> MysqlTableObservation {
        MysqlTableObservation {
            option: TableOption {
                table_name: name.into(),
                table_comment: String::new(),
                column_count: None,
                data_size_bytes: Some(16384),
                modified_at: update_time_ms.map(format_local_ms),
                modified_source: None,
                modified_actor: None,
            },
            update_time_ms,
            create_time: create_time.map(Into::into),
            create_time_ms,
            write_count,
        }
    }

    #[tokio::test]
    async fn retains_modified_time_across_mysql_restart_and_detects_external_writes() {
        let pool = memory_pool().await;
        let t1 = 1_760_000_000_000_i64;
        let boot1 = 1_759_990_000_i64;

        // First observation: table A has MySQL UPDATE_TIME; table B is NULL with write_count=5.
        let first = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-2",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![
                    mysql_obs("goodsprop", Some(t1), Some("2026-01-01 00:00:00"), None, Some(10)),
                    mysql_obs("heroprop", None, Some("2026-01-01 00:00:00"), None, Some(5)),
                ],
                server_boot_epoch_secs: Some(boot1),
                server_now_epoch_secs: None,
            },
            &[],
            t1 + 10_000,
        )
        .await
        .unwrap();
        assert_eq!(first[0].modified_at, Some(format_local_ms(t1)));
        assert_eq!(first[0].modified_source.as_deref(), Some(SOURCE_DATABASE));
        // Baseline observation does not fabricate a timestamp for untouched/undated table B.
        assert_eq!(first[1].modified_at, None);

        // External Navicat write on table B bumps write_count from 5 -> 6, UPDATE_TIME still NULL.
        let t2 = t1 + 60_000;
        let second = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-2",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![
                    mysql_obs("goodsprop", None, Some("2026-01-01 00:00:00"), None, Some(10)),
                    mysql_obs("heroprop", None, Some("2026-01-01 00:00:00"), None, Some(6)),
                ],
                server_boot_epoch_secs: Some(boot1),
                server_now_epoch_secs: None,
            },
            &[],
            t2,
        )
        .await
        .unwrap();
        // Table A retains t1 even though MySQL returned NULL.
        assert_eq!(second[0].modified_at, Some(format_local_ms(t1)));
        assert_eq!(second[0].modified_source.as_deref(), Some(SOURCE_DATABASE));
        // Table B detected external write at t2.
        assert_eq!(second[1].modified_at, Some(format_local_ms(t2)));
        assert_eq!(second[1].modified_source.as_deref(), Some(SOURCE_EXTERNAL));

        // MySQL restarts (boot2 > boot1 + 120): both write_counts reset to 0.
        // Neither table should lose its saved timestamp nor falsely bump.
        let boot2 = boot1 + 500_000;
        let t3 = boot2 * 1000 + 30_000;
        let third = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-2",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![
                    mysql_obs("goodsprop", None, Some("2026-01-01 00:00:00"), None, Some(0)),
                    mysql_obs("heroprop", None, Some("2026-01-01 00:00:00"), None, Some(0)),
                ],
                server_boot_epoch_secs: Some(boot2),
                server_now_epoch_secs: None,
            },
            &[],
            t3,
        )
        .await
        .unwrap();
        assert_eq!(third[0].modified_at, Some(format_local_ms(t1)));
        assert_eq!(third[1].modified_at, Some(format_local_ms(t2)));
    }

    #[tokio::test]
    async fn shared_central_update_syncs_actor_and_beats_approximate_external() {
        let pool = memory_pool().await;
        let boot1 = 1_759_990_000_i64;
        let t1 = 1_760_000_000_000_i64;

        // Baseline
        let _ = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-1",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![mysql_obs("goodsprop", None, None, None, Some(10))],
                server_boot_epoch_secs: Some(boot1),
                server_now_epoch_secs: None,
            },
            &[],
            t1,
        )
        .await
        .unwrap();

        // Person B observes write_count jump before Alice's central push finishes.
        let detected_at = t1 + 30_000;
        let detected = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-1",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![mysql_obs("goodsprop", None, None, None, Some(11))],
                server_boot_epoch_secs: Some(boot1),
                server_now_epoch_secs: None,
            },
            &[],
            detected_at,
        )
        .await
        .unwrap();
        assert_eq!(detected[0].modified_source.as_deref(), Some(SOURCE_EXTERNAL));
        assert_eq!(detected[0].modified_at, Some(format_local_ms(detected_at)));

        // Alice's exact central-server timestamp (10 seconds earlier than detection) arrives.
        let alice_ts = t1 + 20_000;
        let synced = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-1",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![mysql_obs("goodsprop", None, None, None, Some(11))],
                server_boot_epoch_secs: Some(boot1),
                server_now_epoch_secs: None,
            },
            &[SharedTableLatest {
                table_name: "goodsprop".into(),
                ts_ms: alice_ts,
                actor: Some("Alice".into()),
            }],
            detected_at + 10_000,
        )
        .await
        .unwrap();
        assert_eq!(synced[0].modified_at, Some(format_local_ms(alice_ts)));
        assert_eq!(synced[0].modified_source.as_deref(), Some(SOURCE_SHARED));
        assert_eq!(synced[0].modified_actor.as_deref(), Some("Alice"));

        // Later, Navicat edits the table 10 seconds after Alice: write_count jumps 11 -> 12!
        let navicat_ts = alice_ts + 40_000;
        let navicat = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-1",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![mysql_obs("goodsprop", Some(navicat_ts), None, None, Some(12))],
                server_boot_epoch_secs: Some(boot1),
                server_now_epoch_secs: None,
            },
            &[SharedTableLatest {
                table_name: "goodsprop".into(),
                ts_ms: alice_ts,
                actor: Some("Alice".into()),
            }],
            navicat_ts + 5_000,
        )
        .await
        .unwrap();
        assert_eq!(navicat[0].modified_at, Some(format_local_ms(navicat_ts)));
        assert_eq!(navicat[0].modified_source.as_deref(), Some(SOURCE_DATABASE));
        assert_eq!(navicat[0].modified_actor, None);
    }

    #[tokio::test]
    async fn backfills_existing_local_audit_log_entries_and_ignores_aborted() {
        let pool = memory_pool().await;
        sqlx::query(
            "INSERT INTO audit_log \
             (ts, connection_id, database, table_name, operation, rollback_strategy, source, status, actor) \
             VALUES \
             ('2026-11-23T08:00:00Z', 'mysql-2', 'newsg_4cfg', 'goodsprop', 'UPDATE', 'auto', 'grid', 'committed', 'Bob'), \
             ('2026-11-23T09:00:00Z', 'mysql-2', 'newsg_4cfg', 'goodsprop', 'UPDATE', 'auto', 'grid', 'aborted', 'Bob'), \
             ('2026-11-23T07:00:00Z', 'mysql-2', 'newsg_4cfg', '(agent)', 'UPDATE', 'manual', 'agent', 'committed', 'Bob')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let tables = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-2",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![mysql_obs("goodsprop", None, None, None, Some(0))],
                server_boot_epoch_secs: Some(1_760_000_000),
                server_now_epoch_secs: None,
            },
            &[],
            1_760_100_000_000,
        )
        .await
        .unwrap();

        let expected = parse_timestamp_ms("2026-11-23T08:00:00Z").unwrap();
        assert_eq!(tables[0].modified_at, Some(format_local_ms(expected)));
        assert_eq!(tables[0].modified_source.as_deref(), Some(SOURCE_BLACKCAT));
        assert_eq!(tables[0].modified_actor.as_deref(), Some("Bob"));
    }

    #[tokio::test]
    async fn self_blackcat_write_does_not_misattribute_as_external_on_next_poll() {
        let pool = memory_pool().await;
        let boot = 1_760_000_000_i64;
        let t0 = 1_760_010_000_000_i64;

        // Baseline
        let _ = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-2",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![mysql_obs("goodsprop", None, None, None, Some(10))],
                server_boot_epoch_secs: Some(boot),
                server_now_epoch_secs: None,
            },
            &[],
            t0,
        )
        .await
        .unwrap();

        // Simulate local Blackcat write at t1
        let t1 = t0 + 10_000;
        let mut tx = pool.begin().await.unwrap();
        upsert_saved_row(
            &mut tx,
            "mysql://10.0.0.1:3306",
            "newsg_4cfg",
            &SavedRow {
                table_key: "goodsprop".into(),
                table_name: "goodsprop".into(),
                modified_at_ms: Some(t1),
                modified_source: Some(SOURCE_BLACKCAT.into()),
                modified_actor: Some("Alice".into()),
                pending_local_write_ms: Some(t1),
                observed_write_count: Some(10),
                observed_create_time: None,
                observed_server_boot: Some(boot),
                last_shared_ts_ms: None,
            },
            t1,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        // Next poll observes write_count 10 -> 11 and slight 3s server clock skew
        let polled = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-2",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![mysql_obs("goodsprop", Some(t1 + 3_000), None, None, Some(11))],
                server_boot_epoch_secs: Some(boot),
                server_now_epoch_secs: None,
            },
            &[],
            t1 + 30_000,
        )
        .await
        .unwrap();
        assert_eq!(polled[0].modified_at, Some(format_local_ms(t1)));
        assert_eq!(polled[0].modified_source.as_deref(), Some(SOURCE_BLACKCAT));
        assert_eq!(polled[0].modified_actor.as_deref(), Some("Alice"));
    }

    #[test]
    fn normalizes_sql_target_names_safely() {
        assert_eq!(
            normalize_sql_target("newsg_4cfg", "`goodsprop`"),
            Some(("newsg_4cfg".into(), "goodsprop".into()))
        );
        assert_eq!(
            normalize_sql_target("newsg_4cfg", "`other_db`.`heroprop`"),
            Some(("other_db".into(), "heroprop".into()))
        );
        assert_eq!(normalize_sql_target("newsg_4cfg", "(sql_console)"), None);
        assert_eq!(normalize_sql_target("newsg_4cfg", "IF"), None);
    }

    #[tokio::test]
    async fn fast_overlay_merges_persisted_timestamps_without_overwriting_newer_db_time() {
        let pool = memory_pool().await;
        let t1 = 1_760_010_000_000_i64;
        let t2 = t1 + 600_000;
        let mut tx = pool.begin().await.unwrap();
        upsert_saved_row(
            &mut tx,
            "mysql://10.0.0.1:3306",
            "newsg_4cfg",
            &SavedRow {
                table_key: "goodsprop".into(),
                table_name: "goodsprop".into(),
                modified_at_ms: Some(t1),
                modified_source: Some(SOURCE_BLACKCAT.into()),
                modified_actor: Some("Alice".into()),
                pending_local_write_ms: None,
                observed_write_count: None,
                observed_create_time: None,
                observed_server_boot: None,
                last_shared_ts_ms: None,
            },
            t1,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        let tables = overlay_saved_modified_times(
            &pool,
            "mysql://10.0.0.1:3306",
            "newsg_4cfg",
            vec![
                TableOption {
                    table_name: "goodsprop".into(),
                    table_comment: String::new(),
                    column_count: None,
                    data_size_bytes: None,
                    modified_at: None,
                    modified_source: None,
                    modified_actor: None,
                },
                TableOption {
                    table_name: "heroprop".into(),
                    table_comment: String::new(),
                    column_count: None,
                    data_size_bytes: None,
                    modified_at: Some(format_local_ms(t2)),
                    modified_source: None,
                    modified_actor: None,
                },
            ],
        )
        .await
        .unwrap();

        assert_eq!(tables[0].modified_at, Some(format_local_ms(t1)));
        assert_eq!(tables[0].modified_source.as_deref(), Some(SOURCE_BLACKCAT));
        assert_eq!(tables[0].modified_actor.as_deref(), Some("Alice"));
        assert_eq!(tables[1].modified_at, Some(format_local_ms(t2)));
        assert_eq!(tables[1].modified_source.as_deref(), Some(SOURCE_DATABASE));
    }

    #[tokio::test]
    async fn shared_actor_attaches_after_database_observation_and_does_not_clobber_later_external_edit() {
        let pool = memory_pool().await;
        let boot = 1_760_000_000_i64;
        let alice_ts = 1_760_020_000_000_i64;
        // MySQL server clock is 15s ahead of Alice's workstation clock.
        let db_ts = alice_ts + 15_000;

        // 1) Person B sees MySQL UPDATE_TIME first before Alice's central push lands.
        let first = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-1",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![mysql_obs("goodsprop", Some(db_ts), None, None, Some(11))],
                server_boot_epoch_secs: Some(boot),
                server_now_epoch_secs: None,
            },
            &[],
            db_ts + 2_000,
        )
        .await
        .unwrap();
        assert_eq!(first[0].modified_source.as_deref(), Some(SOURCE_DATABASE));
        assert_eq!(first[0].modified_actor, None);

        // 2) Alice's shared record arrives: upgrades SOURCE_DATABASE -> SOURCE_SHARED with actor "张三".
        let attached = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-1",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![mysql_obs("goodsprop", Some(db_ts), None, None, Some(11))],
                server_boot_epoch_secs: Some(boot),
                server_now_epoch_secs: None,
            },
            &[SharedTableLatest {
                table_name: "goodsprop".into(),
                ts_ms: alice_ts,
                actor: Some("张三".into()),
            }],
            db_ts + 10_000,
        )
        .await
        .unwrap();
        assert_eq!(attached[0].modified_at, Some(format_local_ms(alice_ts)));
        assert_eq!(attached[0].modified_source.as_deref(), Some(SOURCE_SHARED));
        assert_eq!(attached[0].modified_actor.as_deref(), Some("张三"));

        // 3) Later, someone edits the table in Navicat (write_count 11 -> 12, UPDATE_TIME advances).
        let navicat_ts = db_ts + 25_000;
        let external = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-1",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![mysql_obs("goodsprop", Some(navicat_ts), None, None, Some(12))],
                server_boot_epoch_secs: Some(boot),
                server_now_epoch_secs: None,
            },
            &[SharedTableLatest {
                table_name: "goodsprop".into(),
                ts_ms: alice_ts,
                actor: Some("张三".into()),
            }],
            navicat_ts + 5_000,
        )
        .await
        .unwrap();
        assert_eq!(external[0].modified_at, Some(format_local_ms(navicat_ts)));
        assert_eq!(external[0].modified_source.as_deref(), Some(SOURCE_DATABASE));
        assert_eq!(external[0].modified_actor, None);

        // 4) Next poll still sees Alice's older shared record; must NOT overwrite Navicat's edit back to "张三".
        let steady = reconcile_mysql_observation(
            &pool,
            "mysql://10.0.0.1:3306",
            "mysql-1",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![mysql_obs("goodsprop", Some(navicat_ts), None, None, Some(12))],
                server_boot_epoch_secs: Some(boot),
                server_now_epoch_secs: None,
            },
            &[SharedTableLatest {
                table_name: "goodsprop".into(),
                ts_ms: alice_ts,
                actor: Some("张三".into()),
            }],
            navicat_ts + 60_000,
        )
        .await
        .unwrap();
        assert_eq!(steady[0].modified_at, Some(format_local_ms(navicat_ts)));
        assert_eq!(steady[0].modified_source.as_deref(), Some(SOURCE_DATABASE));
        assert_eq!(steady[0].modified_actor, None);
    }

    #[test]
    fn server_key_uses_real_url_host_and_port_even_when_runtime_host_is_placeholder() {
        let mysql = RuntimeConnection {
            id: "mysql-2".into(),
            kind: DatabaseKind::MySql,
            label: "决胜2".into(),
            host: "configured".into(),
            port: 3306,
            username: "mysql".into(),
            mysql_url: Some("mysql://root:secret@192.168.1.243:8306/newsg_4cfg".into()),
            clickhouse_url: None,
            mongodb_url: None,
            database: Some("newsg_4cfg".into()),
        };
        assert_eq!(server_key_for_connection(&mysql), "mysql://192.168.1.243:8306");

        let mysql_default_port = RuntimeConnection {
            mysql_url: Some("mysql://root@DB.Internal".into()),
            ..mysql.clone()
        };
        assert_eq!(
            server_key_for_connection(&mysql_default_port),
            "mysql://db.internal:3306"
        );

        let demo = RuntimeConnection {
            id: "demo-1".into(),
            mysql_url: None,
            ..mysql
        };
        assert_eq!(server_key_for_connection(&demo), "demo://demo-1");
    }

    #[test]
    fn apply_shared_accepts_teammate_edit_shortly_after_local_and_upgrades_offline_self_echo() {
        let t0 = 1_760_050_000_000_i64;
        // 1) Teammate edits 2s after local logged-in edit: must switch to teammate.
        let mut logged_in_local = SavedRow {
            table_key: "goodsprop".into(),
            table_name: "goodsprop".into(),
            modified_at_ms: Some(t0),
            modified_source: Some(SOURCE_BLACKCAT.into()),
            modified_actor: Some("刘岳松".into()),
            pending_local_write_ms: None,
            observed_write_count: None,
            observed_create_time: None,
            observed_server_boot: None,
            last_shared_ts_ms: None,
        };
        let changed = apply_shared_to_row(
            &mut logged_in_local,
            &SharedTableLatest {
                table_name: "goodsprop".into(),
                ts_ms: t0 + 2_000,
                actor: Some("张三".into()),
            },
        );
        assert!(changed);
        assert_eq!(logged_in_local.modified_source.as_deref(), Some(SOURCE_SHARED));
        assert_eq!(logged_in_local.modified_actor.as_deref(), Some("张三"));
        assert_eq!(logged_in_local.modified_at_ms, Some(t0 + 2_000));

        // 2) Offline local edit (actor=None) echoed back after login (audit ts 10s earlier
        //    than record_local_change commit time): upgrades actor while preserving local source.
        let mut offline_local = SavedRow {
            table_key: "heroprop".into(),
            table_name: "heroprop".into(),
            modified_at_ms: Some(t0),
            modified_source: Some(SOURCE_BLACKCAT.into()),
            modified_actor: None,
            pending_local_write_ms: None,
            observed_write_count: None,
            observed_create_time: None,
            observed_server_boot: None,
            last_shared_ts_ms: None,
        };
        let upgraded = apply_shared_to_row(
            &mut offline_local,
            &SharedTableLatest {
                table_name: "heroprop".into(),
                ts_ms: t0 - 10_000,
                actor: Some("刘岳松".into()),
            },
        );
        assert!(upgraded);
        assert_eq!(offline_local.modified_source.as_deref(), Some(SOURCE_BLACKCAT));
        assert_eq!(offline_local.modified_actor.as_deref(), Some("刘岳松"));
    }

    #[tokio::test]
    async fn records_refines_retracts_and_normalizes_external_change_events() {
        let pool = memory_pool().await;
        let server_key = "mysql://192.168.1.243:8306";
        let boot = 1_760_000_000_i64;
        let t0 = 1_760_010_000_000_i64;

        // 1) Initial baseline does not spam untouched tables into table_external_changes.
        let (_, recorded0) = reconcile_mysql_observation_with_events(
            &pool,
            server_key,
            "mysql-1",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![
                    mysql_obs("goodsprop", Some(t0 - 300_000), Some("2026-01-01 00:00:00"), None, Some(10)),
                    mysql_obs("heroprop", None, Some("2026-01-01 00:00:00"), None, Some(5)),
                ],
                server_boot_epoch_secs: Some(boot),
                server_now_epoch_secs: Some(t0 / 1000),
            },
            &[],
            t0,
        )
        .await
        .unwrap();
        assert!(!recorded0);
        assert!(external_changes::list_local(&pool, server_key, "newsg_4cfg", "goodsprop", 50, 0)
            .await
            .unwrap()
            .is_empty());

        // 2) External write on heroprop bumps write_count 5 -> 6 (approximate detection),
        //    then 20s later MySQL flushes UPDATE_TIME -> refines to exact without duplicating.
        let t_detect = t0 + 30_000;
        let (_, recorded1) = reconcile_mysql_observation_with_events(
            &pool,
            server_key,
            "mysql-1",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![
                    mysql_obs("goodsprop", Some(t0 - 300_000), Some("2026-01-01 00:00:00"), None, Some(10)),
                    mysql_obs("heroprop", None, Some("2026-01-01 00:00:00"), None, Some(6)),
                ],
                server_boot_epoch_secs: Some(boot),
                server_now_epoch_secs: Some(t_detect / 1000),
            },
            &[],
            t_detect,
        )
        .await
        .unwrap();
        assert!(recorded1);
        let hero_events_1 = external_changes::list_local(&pool, server_key, "newsg_4cfg", "heroprop", 50, 0)
            .await
            .unwrap();
        assert_eq!(hero_events_1.len(), 1);
        assert_eq!(hero_events_1[0].time_kind, TIME_KIND_DETECTED);
        assert_eq!(hero_events_1[0].signal, SIGNAL_WRITE_COUNT);

        let exact_ts = t_detect - 5_000;
        let _ = reconcile_mysql_observation_with_events(
            &pool,
            server_key,
            "mysql-1",
            "newsg_4cfg",
            MysqlDatabaseObservation {
                tables: vec![
                    mysql_obs("goodsprop", Some(t0 - 300_000), Some("2026-01-01 00:00:00"), None, Some(10)),
                    mysql_obs("heroprop", Some(exact_ts), Some("2026-01-01 00:00:00"), None, Some(6)),
                ],
                server_boot_epoch_secs: Some(boot),
                server_now_epoch_secs: Some((t_detect + 20_000) / 1000),
            },
            &[],
            t_detect + 20_000,
        )
        .await
        .unwrap();
        let hero_events_2 = external_changes::list_local(&pool, server_key, "newsg_4cfg", "heroprop", 50, 0)
            .await
            .unwrap();
        assert_eq!(hero_events_2.len(), 1);
        assert_eq!(hero_events_2[0].time_kind, TIME_KIND_EXACT);
        assert_eq!(hero_events_2[0].ts_ms, exact_ts);

        // 3) If a teammate's shared Blackcat audit claims that exact_ts shortly after,
        //    the suspected external change is retracted cleanly.
        let _ = apply_shared_updates_to_store(
            &pool,
            server_key,
            "newsg_4cfg",
            &[SharedTableLatest {
                table_name: "heroprop".into(),
                ts_ms: exact_ts - 2_000,
                actor: Some("Alice".into()),
            }],
            t_detect + 25_000,
        )
        .await
        .unwrap();
        let hero_events_3 = external_changes::list_local(&pool, server_key, "newsg_4cfg", "heroprop", 50, 0)
            .await
            .unwrap();
        assert!(hero_events_3.is_empty());

        // 4) Clock-skew normalization: MySQL clock is 47s ahead of local PC.
        //    Local Blackcat write commits at t_bc; Navicat edits 8s later.
        let t_bc = t0 + 120_000;
        let skew_ms = 47_000_i64;
        let mut tx = pool.begin().await.unwrap();
        upsert_saved_row(
            &mut tx,
            server_key,
            "newsg_4cfg",
            &SavedRow {
                table_key: "goodsprop".into(),
                table_name: "goodsprop".into(),
                modified_at_ms: Some(t_bc),
                modified_source: Some(SOURCE_BLACKCAT.into()),
                modified_actor: Some("我".into()),
                pending_local_write_ms: Some(t_bc),
                observed_write_count: Some(10),
                observed_create_time: Some("2026-01-01 00:00:00".into()),
                observed_server_boot: Some(boot),
                last_shared_ts_ms: None,
            },
            t_bc,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        // First: poll sees only our own Blackcat commit (MySQL raw UPDATE_TIME = t_bc + 47s).
        // Must NOT trigger external change!
        let poll_self = t_bc + 4_000;
        let (_, evt_self) = reconcile_single_mysql_table(
            &pool,
            server_key,
            "mysql-1",
            "newsg_4cfg",
            MysqlSingleTableObservation {
                table: mysql_obs(
                    "goodsprop",
                    Some(t_bc + skew_ms),
                    Some("2026-01-01 00:00:00"),
                    None,
                    Some(11),
                ),
                server_boot_epoch_secs: Some(boot),
                server_now_epoch_secs: Some((poll_self + skew_ms) / 1000),
            },
            None,
            poll_self,
        )
        .await
        .unwrap();
        assert!(evt_self.is_none());

        // Second: Navicat edits 15s after t_bc (MySQL raw UPDATE_TIME = t_bc + 15s + 47s).
        let t_navicat = t_bc + 15_000;
        let poll_navicat = t_navicat + 3_000;
        let (opt_navicat, evt_navicat) = reconcile_single_mysql_table(
            &pool,
            server_key,
            "mysql-1",
            "newsg_4cfg",
            MysqlSingleTableObservation {
                table: mysql_obs(
                    "goodsprop",
                    Some(t_navicat + skew_ms),
                    Some("2026-01-01 00:00:00"),
                    None,
                    Some(12),
                ),
                server_boot_epoch_secs: Some(boot),
                server_now_epoch_secs: Some((poll_navicat + skew_ms) / 1000),
            },
            None,
            poll_navicat,
        )
        .await
        .unwrap();
        assert_eq!(opt_navicat.modified_source.as_deref(), Some(SOURCE_DATABASE));
        let detected = evt_navicat.expect("should record fast Navicat edit after Blackcat write");
        assert_eq!(detected.time_kind, TIME_KIND_EXACT);
        assert!((detected.ts_ms - t_navicat).abs() <= 1_000);
    }

    #[tokio::test]
    async fn single_table_observation_does_not_mark_whole_database_observed() {
        let pool = memory_pool().await;
        let server_key = "mysql://192.168.1.243:8306";
        let t0 = 1_760_010_000_000_i64;

        let _ = reconcile_single_mysql_table(
            &pool,
            server_key,
            "mysql-1",
            "newsg_4cfg",
            MysqlSingleTableObservation {
                table: mysql_obs("goodsprop", Some(t0 - 10_000), Some("2026-01-01 00:00:00"), None, Some(1)),
                server_boot_epoch_secs: Some(1_760_000_000),
                server_now_epoch_secs: Some(t0 / 1000),
            },
            None,
            t0,
        )
        .await
        .unwrap();

        let (_, has_observed_db) = load_meta(&pool, server_key, "newsg_4cfg").await.unwrap();
        assert!(!has_observed_db);
    }
}
