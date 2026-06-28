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

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Manager};

use crate::account::{current_session, server_url};
use crate::types::AppState;

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
        items.push((
            id,
            AuditPushItem {
                client_id,
                ts: row.try_get("ts").unwrap_or_default(),
                user_id: session.user_id.clone(),
                username: session.username.clone(),
                connection_id: row.try_get("connection_id").unwrap_or_default(),
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

    let pool = crate::audit::ensure_audit_pool(app, state).await?;
    let batch = collect_outbox(&pool, &session, 500).await?;
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

/// Background sync loop: pushes the outbox every 30s while the app runs. Fires
/// once immediately on login via `sync_now`; this loop catches offline edits
/// that accumulated while the server was down.
pub fn spawn_background_sync(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
        // The first tick fires immediately — skip it so we don't hammer the
        // server on startup before the user has even opened the backup center.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let state = app.state::<AppState>();
            // Best-effort: swallow errors so the loop keeps running.
            let _ = push_outbox(&app, &state).await;
        }
    });
}

/// Best-effort immediate sync used after a local audit row becomes committed.
/// The periodic loop still retries later if the server is offline.
pub fn trigger_immediate_sync(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let _ = push_outbox(&app, &state).await;
    });
}
