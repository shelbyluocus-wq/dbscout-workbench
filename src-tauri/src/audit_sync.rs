//! Outbox sync: pushes unsynced local audit-log rows to the central server.
//!
//! The local `audit_log` table doubles as the outbox — rows start with
//! `synced = 0` and are flipped to `synced = 1` after a successful POST. Pushes
//! are idempotent (the server dedups on `client_id`), so retries and duplicate
//! pushes are safe. Only the lightweight summary (who/when/where/op/old→new) is
//! pushed; the heavy forward/inverse SQL stays local for rollback.
//!
//! Offline-first: when the server is unreachable, `push_outbox` fails silently
//! and the background task retries on the next tick. Local edits and rollbacks
//! are never blocked by sync state.

use std::{collections::HashMap, future::Future, sync::atomic::Ordering, time::Duration};

use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Manager};

use crate::account::{current_session, recover_unauthorized_session, server_url, SessionRecovery};
use crate::table_modified::{parse_timestamp_ms, server_key_for_connection, SharedTableLatest};
use crate::types::{AppState, AuditSyncSignal};

/// One audit summary pushed to the server. Mirrors the server's
/// `AuditPushItem`. Identified by `client_id` for idempotent upsert.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditPushItem {
    client_id: String,
    ts: String,
    user_id: String,
    username: String,
    connection_id: String,
    database: String,
    table_name: String,
    operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    row_identity: Option<serde_json::Value>,
    column_name: Option<String>,
    old_value: Option<String>,
    new_value: Option<String>,
    source: String,
    status: String,
    is_rollback: bool,
    rollback_of_client_id: Option<String>,
    host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditPushRequest {
    items: Vec<AuditPushItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPushResult {
    pub accepted: u64,
    pub skipped: u64,
}

/// Best-effort machine name for audit context (purely informational).
fn hostname() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// Fetch up to `batch` unsynced rows as push items. Rows are joined with the
/// current session (user_id/username) — an audit row written while logged out
/// is still pushed but attributed to the current user at sync time; this is
/// acceptable for an internal tool and avoids dropping offline edits.
async fn collect_outbox(
    pool: &SqlitePool,
    session: &crate::types::UserSession,
    server_keys: &HashMap<String, String>,
    batch: i64,
) -> Result<Vec<(i64, AuditPushItem)>, String> {
    let host = hostname();
    let rows = sqlx::query(
        "SELECT id, ts, connection_id, database, table_name, operation, row_identity, column_name, \
         old_value, new_value, source, status, is_rollback, client_id, actor \
         FROM audit_log WHERE synced = 0 ORDER BY id ASC LIMIT ?",
    )
    .bind(batch)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询待同步审计失败: {e}"))?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let id: i64 = row.try_get("id").unwrap_or(0);
        let client_id: Option<String> = row.try_get("client_id").ok().flatten();
        // Skip rows without a client_id (shouldn't happen post-migration, but
        // guard against pre-existing rows from older builds).
        let client_id = match client_id {
            Some(cid) if !cid.is_empty() => cid,
            _ => continue,
        };
        let connection_id: String = row.try_get("connection_id").unwrap_or_default();
        let server_key = server_keys.get(&connection_id).cloned();
        let row_identity = row
            .try_get::<Option<String>, _>("row_identity")
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok());
        items.push((
            id,
            AuditPushItem {
                client_id,
                ts: row.try_get("ts").unwrap_or_default(),
                user_id: session.user_id.clone(),
                username: session.username.clone(),
                connection_id,
                database: row.try_get("database").unwrap_or_default(),
                table_name: row.try_get("table_name").unwrap_or_default(),
                operation: row.try_get("operation").unwrap_or_default(),
                row_identity,
                column_name: row.try_get("column_name").ok().flatten(),
                old_value: row.try_get("old_value").ok().flatten(),
                new_value: row.try_get("new_value").ok().flatten(),
                source: row.try_get("source").unwrap_or_default(),
                status: row.try_get("status").unwrap_or_default(),
                is_rollback: row.try_get::<i64, _>("is_rollback").unwrap_or(0) != 0,
                rollback_of_client_id: None,
                host: host.clone(),
                server_key,
            },
        ));
    }
    Ok(items)
}

/// Mark the given local row ids as synced.
async fn mark_synced(pool: &SqlitePool, ids: &[i64]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    // SQLite has no array binding; bind each id in an IN (...) clause.
    let placeholders: Vec<String> = ids.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "UPDATE audit_log SET synced = 1 WHERE id IN ({})",
        placeholders.join(", ")
    );
    let mut query = sqlx::query(&sql);
    for id in ids {
        query = query.bind(id);
    }
    query
        .execute(pool)
        .await
        .map_err(|e| format!("标记同步状态失败: {e}"))?;
    Ok(())
}

/// Push unsynced audit rows to the central server. No-op when logged out or
/// when no server URL is configured. Returns the server's accepted/skipped
/// counts. Errors are returned (not panicked) so the background task can retry.
pub async fn push_outbox(app: &AppHandle, state: &AppState) -> Result<AuditPushResult, String> {
    let _push_guard = state.audit_sync.push_lock.lock().await;
    let _ = crate::account::ensure_loaded(app, state).await;
    let Some(session) = current_session(state).await else {
        // Not logged in — nothing to sync. Outbox rows remain pending and will
        // be pushed after the next login.
        return Ok(AuditPushResult {
            accepted: 0,
            skipped: 0,
        });
    };
    let Some(base_url) = server_url(state).await else {
        return Ok(AuditPushResult {
            accepted: 0,
            skipped: 0,
        });
    };

    let server_keys: HashMap<String, String> = {
        let rt = state.runtime.lock().await;
        rt.connections
            .iter()
            .map(|(id, conn)| (id.clone(), server_key_for_connection(conn)))
            .collect()
    };
    let pool = crate::audit::ensure_audit_pool(app, state).await?;
    let host = hostname();
    let batch = collect_outbox(&pool, &session, &server_keys, 500).await?;
    let mut active_session = session;
    let result = if batch.is_empty() {
        AuditPushResult {
            accepted: 0,
            skipped: 0,
        }
    } else {
        let items: Vec<AuditPushItem> = batch.iter().map(|(_, item)| item.clone()).collect();
        let ids: Vec<i64> = batch.iter().map(|(id, _)| *id).collect();
        let body = serde_json::to_value(AuditPushRequest { items })
            .map_err(|e| format!("序列化同步请求失败: {e}"))?;

        let url = format!("{base_url}/audit");
        let mut resp = state
            .account
            .http
            .post(&url)
            .bearer_auth(&active_session.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("同步请求失败: {e}"))?;

        if resp.status() == StatusCode::UNAUTHORIZED {
            if let SessionRecovery::Refreshed(refreshed) =
                recover_unauthorized_session(app, state, &base_url, &active_session).await
            {
                active_session = refreshed;
                resp = state
                    .account
                    .http
                    .post(&url)
                    .bearer_auth(&active_session.token)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| format!("同步请求失败: {e}"))?;
            }
        }

        if !resp.status().is_success() {
            let status = resp.status();
            if status == StatusCode::UNAUTHORIZED {
                return Err("登录状态已失效，请在设置中重新登录黑猫账号".into());
            }
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("同步失败: {status} {text}"));
        }

        let result: AuditPushResult = resp
            .json()
            .await
            .map_err(|e| format!("解析同步响应失败: {e}"))?;

        // Only mark synced after a successful response. On partial failure (which
        // the server doesn't produce today — it's all-or-nothing per batch), rows
        // would stay pending and retry.
        mark_synced(&pool, &ids).await?;
        result
    };

    // Push externally observed table changes after audit rows so Blackcat edits
    // always reach the central server first and reconcile any race cleanly.
    let _ = crate::external_changes::push_outbox(
        &pool,
        &state.account.http,
        &base_url,
        &active_session.token,
        host,
    )
    .await;

    Ok(result)
}

async fn run_sync_worker<P, PushFuture>(
    mut signals: tokio::sync::mpsc::Receiver<AuditSyncSignal>,
    mut push: P,
) where
    P: FnMut() -> PushFuture,
    PushFuture: Future<Output = ()>,
{
    while let Some(signal) = signals.recv().await {
        match signal {
            AuditSyncSignal::Push => push().await,
            AuditSyncSignal::Shutdown => break,
        }
    }
}

/// Background sync loop: pushes the outbox after a mutation signal or every
/// 30 seconds. All triggers share this one worker and `push_outbox` also guards
/// direct/manual calls, so network concurrency is globally bounded to one.
pub fn spawn_background_sync(app: AppHandle) {
    let state = app.state::<AppState>();
    if state.audit_sync.worker_started.swap(true, Ordering::AcqRel) {
        return;
    }
    let receiver = state
        .audit_sync
        .signal_rx
        .lock()
        .ok()
        .and_then(|mut receiver| receiver.take());
    let Some(receiver) = receiver else {
        state
            .audit_sync
            .worker_started
            .store(false, Ordering::Release);
        return;
    };
    let ticker = state.audit_sync.signal_tx.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            match ticker.try_send(AuditSyncSignal::Push) {
                Ok(_) | Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {}
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => break,
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        run_sync_worker(receiver, move || {
            let app = app.clone();
            async move {
                let state = app.state::<AppState>();
                let _ = push_outbox(&app, &state).await;
            }
        })
        .await;
    });
}

/// Best-effort immediate sync used after a local audit row becomes committed.
/// The periodic loop still retries later if the server is offline.
pub fn trigger_immediate_sync(app: &AppHandle) {
    let _ = app
        .state::<AppState>()
        .audit_sync
        .signal_tx
        .try_send(AuditSyncSignal::Push);
}

const LEGACY_PLACEHOLDER_SERVER_KEY: &str = "mysql://configured:3306";
const FALLBACK_AUDIT_PAGE_LIMIT: usize = 2000;
const FALLBACK_AUDIT_MAX_PAGES: usize = 5;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedTableLatestWire {
    table_name: String,
    ts: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedAuditListRowWire {
    #[serde(default)]
    ts: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    table_name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    server_key: Option<String>,
}

fn pick_shared_actor(display_name: Option<&str>, username: Option<&str>) -> Option<String> {
    display_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| username.map(str::trim).filter(|value| !value.is_empty()))
        .map(str::to_string)
}

fn canonical_real_server_key(raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case(LEGACY_PLACEHOLDER_SERVER_KEY))
}

fn aggregate_shared_audit_rows(
    entries: &[SharedAuditListRowWire],
    wanted_server_key: &str,
) -> Vec<SharedTableLatest> {
    let wanted_key = canonical_real_server_key(Some(wanted_server_key));
    let mut latest_by_table: HashMap<String, SharedTableLatest> = HashMap::new();
    for entry in entries {
        if !matches!(entry.status.as_str(), "committed" | "rolled_back") {
            continue;
        }
        let table_name = entry.table_name.trim();
        if table_name.is_empty() || table_name.starts_with('(') {
            continue;
        }
        if let (Some(wanted), Some(entry_key)) = (
            wanted_key,
            canonical_real_server_key(entry.server_key.as_deref()),
        ) {
            if !entry_key.eq_ignore_ascii_case(wanted) {
                continue;
            }
        }
        let Some(ts_ms) = parse_timestamp_ms(&entry.ts) else {
            continue;
        };
        let actor = pick_shared_actor(entry.display_name.as_deref(), entry.username.as_deref());
        let key = table_name.to_lowercase();
        let should_replace = match latest_by_table.get(&key) {
            None => true,
            Some(current) => {
                ts_ms > current.ts_ms
                    || (ts_ms == current.ts_ms && current.actor.is_none() && actor.is_some())
            }
        };
        if should_replace {
            latest_by_table.insert(
                key,
                SharedTableLatest {
                    table_name: table_name.to_string(),
                    ts_ms,
                    actor,
                },
            );
        }
    }
    latest_by_table.into_values().collect()
}

/// Compatibility fallback for central servers that predate `/audit/table-latest`:
/// reads recent pages from `GET /audit?database=...` and computes per-table latest
/// timestamps + actors on the client.
async fn fetch_shared_table_latest_via_audit_list(
    http: &reqwest::Client,
    base_url: &str,
    token: &str,
    server_key: &str,
    database: &str,
) -> Vec<SharedTableLatest> {
    let endpoint = format!("{base_url}/audit");
    let mut collected = Vec::new();
    for page in 0..FALLBACK_AUDIT_MAX_PAGES {
        let offset = page * FALLBACK_AUDIT_PAGE_LIMIT;
        let limit_str = FALLBACK_AUDIT_PAGE_LIMIT.to_string();
        let offset_str = offset.to_string();
        let Ok(url) = Url::parse_with_params(
            &endpoint,
            &[
                ("database", database),
                ("limit", limit_str.as_str()),
                ("offset", offset_str.as_str()),
            ],
        ) else {
            break;
        };
        let Ok(resp) = http
            .get(url)
            .bearer_auth(token)
            .timeout(Duration::from_secs(4))
            .send()
            .await
        else {
            break;
        };
        if !resp.status().is_success() {
            break;
        }
        let Ok(rows) = resp.json::<Vec<SharedAuditListRowWire>>().await else {
            break;
        };
        let count = rows.len();
        collected.extend(rows);
        if count < FALLBACK_AUDIT_PAGE_LIMIT {
            break;
        }
    }
    aggregate_shared_audit_rows(&collected, server_key)
}

/// Best-effort fetch of per-table latest modification timestamps from the
/// central server. Offline-first: returns empty when logged out, unconfigured,
/// or unreachable; automatically falls back to `GET /audit` when talking to an
/// older server without `/audit/table-latest`.
pub async fn fetch_shared_table_latest(
    app: &AppHandle,
    state: &AppState,
    server_key: &str,
    connection_id: &str,
    database: &str,
) -> Vec<SharedTableLatest> {
    let _ = crate::account::ensure_loaded(app, state).await;
    let Some(session) = current_session(state).await else {
        return Vec::new();
    };
    let Some(base_url) = server_url(state).await else {
        return Vec::new();
    };
    let endpoint = format!("{base_url}/audit/table-latest");
    let Ok(url) = Url::parse_with_params(
        &endpoint,
        &[
            ("database", database),
            ("serverKey", server_key),
            ("connectionId", connection_id),
        ],
    ) else {
        return Vec::new();
    };

    let mut active_session = session;
    let Ok(mut resp) = state
        .account
        .http
        .get(url.clone())
        .bearer_auth(&active_session.token)
        .timeout(Duration::from_secs(3))
        .send()
        .await
    else {
        return Vec::new();
    };
    if resp.status() == StatusCode::UNAUTHORIZED {
        if let SessionRecovery::Refreshed(refreshed) =
            recover_unauthorized_session(app, state, &base_url, &active_session).await
        {
            active_session = refreshed;
            let Ok(retried) = state
                .account
                .http
                .get(url)
                .bearer_auth(&active_session.token)
                .timeout(Duration::from_secs(3))
                .send()
                .await
            else {
                return Vec::new();
            };
            resp = retried;
        }
    }
    let status = resp.status();
    if matches!(
        status,
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED | StatusCode::NOT_IMPLEMENTED
    ) {
        return fetch_shared_table_latest_via_audit_list(
            &state.account.http,
            &base_url,
            &active_session.token,
            server_key,
            database,
        )
        .await;
    }
    if !status.is_success() {
        return Vec::new();
    }
    let Ok(rows) = resp.json::<Vec<SharedTableLatestWire>>().await else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| {
            let ts_ms = parse_timestamp_ms(&row.ts)?;
            let actor = pick_shared_actor(row.display_name.as_deref(), row.username.as_deref());
            Some(SharedTableLatest {
                table_name: row.table_name,
                ts_ms,
                actor,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test runtime")
    }

    #[test]
    fn worker_coalesces_notifications_stays_single_flight_and_shuts_down() {
        test_runtime().block_on(async {
            let (signal_tx, signal_rx) = tokio::sync::mpsc::channel(1);
            let calls = Arc::new(AtomicUsize::new(0));
            let active = Arc::new(AtomicUsize::new(0));
            let max_active = Arc::new(AtomicUsize::new(0));
            let first_started = Arc::new(tokio::sync::Notify::new());
            let release_first = Arc::new(tokio::sync::Notify::new());
            let second_finished = Arc::new(tokio::sync::Notify::new());
            let worker_calls = calls.clone();
            let worker_active = active.clone();
            let worker_max_active = max_active.clone();
            let worker_first_started = first_started.clone();
            let worker_release_first = release_first.clone();
            let worker_second_finished = second_finished.clone();
            let worker = tokio::spawn(async move {
                run_sync_worker(signal_rx, move || {
                    let calls = worker_calls.clone();
                    let active = worker_active.clone();
                    let max_active = worker_max_active.clone();
                    let first_started = worker_first_started.clone();
                    let release_first = worker_release_first.clone();
                    let second_finished = worker_second_finished.clone();
                    async move {
                        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                        max_active.fetch_max(current, Ordering::SeqCst);
                        let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
                        if call == 1 {
                            first_started.notify_one();
                            release_first.notified().await;
                        }
                        active.fetch_sub(1, Ordering::SeqCst);
                        if call == 2 {
                            second_finished.notify_one();
                        }
                    }
                })
                .await;
            });

            for _ in 0..100 {
                let _ = signal_tx.try_send(AuditSyncSignal::Push);
            }
            first_started.notified().await;
            for _ in 0..100 {
                let _ = signal_tx.try_send(AuditSyncSignal::Push);
            }
            release_first.notify_one();
            second_finished.notified().await;

            assert_eq!(calls.load(Ordering::SeqCst), 2);
            assert_eq!(max_active.load(Ordering::SeqCst), 1);
            signal_tx
                .send(AuditSyncSignal::Shutdown)
                .await
                .expect("signal worker shutdown");
            tokio::time::timeout(std::time::Duration::from_millis(100), worker)
                .await
                .expect("worker should stop after shutdown")
                .expect("worker task should finish cleanly");
        });
    }

    #[test]
    fn aggregate_shared_audit_rows_supports_legacy_rows_and_isolates_distinct_servers() {
        let rows = vec![
            SharedAuditListRowWire {
                ts: "2026-11-23T08:00:00Z".into(),
                username: Some("zhangsan".into()),
                display_name: Some("张三".into()),
                table_name: "goodsprop".into(),
                status: "committed".into(),
                server_key: None, // legacy row from older client/server
            },
            SharedAuditListRowWire {
                ts: "2026-11-23T09:00:00Z".into(),
                username: Some("lisi".into()),
                display_name: Some("李四".into()),
                table_name: "GoodsProp".into(),
                status: "committed".into(),
                server_key: Some("mysql://192.168.1.243:8306".into()),
            },
            SharedAuditListRowWire {
                ts: "2026-11-23T10:00:00Z".into(),
                username: Some("wangwu".into()),
                display_name: Some("王五".into()),
                table_name: "goodsprop".into(),
                status: "aborted".into(),
                server_key: Some("mysql://192.168.1.243:8306".into()),
            },
            SharedAuditListRowWire {
                ts: "2026-11-23T11:00:00Z".into(),
                username: Some("other".into()),
                display_name: Some("其他服".into()),
                table_name: "goodsprop".into(),
                status: "committed".into(),
                server_key: Some("mysql://192.168.1.223:8306".into()),
            },
            SharedAuditListRowWire {
                ts: "2026-11-23T08:30:00Z".into(),
                username: Some("alice".into()),
                display_name: Some(String::new()),
                table_name: "heroprop".into(),
                status: "rolled_back".into(),
                server_key: Some("mysql://configured:3306".into()),
            },
            SharedAuditListRowWire {
                ts: "2026-11-23T12:00:00Z".into(),
                username: Some("bot".into()),
                display_name: Some("Bot".into()),
                table_name: "(sql_console)".into(),
                status: "committed".into(),
                server_key: None,
            },
        ];

        let mut latest = aggregate_shared_audit_rows(&rows, "mysql://192.168.1.243:8306");
        latest.sort_by(|a, b| a.table_name.to_lowercase().cmp(&b.table_name.to_lowercase()));
        assert_eq!(latest.len(), 2);
        assert_eq!(latest[0].table_name, "GoodsProp");
        assert_eq!(latest[0].actor.as_deref(), Some("李四"));
        assert_eq!(
            latest[0].ts_ms,
            parse_timestamp_ms("2026-11-23T09:00:00Z").unwrap()
        );
        assert_eq!(latest[1].table_name, "heroprop");
        assert_eq!(latest[1].actor.as_deref(), Some("alice"));
    }
}
