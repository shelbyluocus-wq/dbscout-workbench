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

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Manager};

use crate::account::{current_session, server_url};
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
        "SELECT id, ts, connection_id, database, table_name, operation, column_name, \
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
    let batch = collect_outbox(&pool, &session, &server_keys, 500).await?;
    if batch.is_empty() {
        return Ok(AuditPushResult {
            accepted: 0,
            skipped: 0,
        });
    }

    let items: Vec<AuditPushItem> = batch.iter().map(|(_, item)| item.clone()).collect();
    let ids: Vec<i64> = batch.iter().map(|(id, _)| *id).collect();
    let body = serde_json::to_value(AuditPushRequest { items })
        .map_err(|e| format!("序列化同步请求失败: {e}"))?;

    let url = format!("{base_url}/audit");
    let resp = state
        .account
        .http
        .post(&url)
        .bearer_auth(&session.token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("同步请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedTableLatestWire {
    table_name: String,
    ts: String,
    username: String,
    display_name: String,
}

/// Best-effort fetch of per-table latest modification timestamps from the
/// central server. Offline-first: returns empty when logged out, unconfigured,
/// unreachable, or when talking to an older server without `/audit/table-latest`.
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

    let Ok(resp) = state
        .account
        .http
        .get(url)
        .bearer_auth(&session.token)
        .timeout(Duration::from_secs(3))
        .send()
        .await
    else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(rows) = resp.json::<Vec<SharedTableLatestWire>>().await else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| {
            let ts_ms = parse_timestamp_ms(&row.ts)?;
            let actor = if !row.display_name.trim().is_empty() {
                Some(row.display_name)
            } else if !row.username.trim().is_empty() {
                Some(row.username)
            } else {
                None
            };
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
}
