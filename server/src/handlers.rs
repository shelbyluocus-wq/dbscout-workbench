//! HTTP handlers: register / login / me / audit (GET + POST) / audit/since.

use axum::{
    extract::{Extension, Query, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::auth::account_info;
use crate::db::{find_user_by_username, insert_user, UserRow};
use crate::models::*;

fn trim_username(value: &str) -> Option<String> {
    let name = value.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Map a storage-layer `String` error to a 500 response tuple.
fn server_err<E: Into<String>>(error: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.into())
}

pub async fn register(
    State(pool): State<SqlitePool>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AccountInfo>, (StatusCode, String)> {
    let username = trim_username(&req.username)
        .ok_or((StatusCode::BAD_REQUEST, "用户名不能为空".into()))?;
    let display_name = req
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| username.clone());

    if find_user_by_username(&pool, &username).await.map_err(server_err)?.is_some() {
        return Err((StatusCode::CONFLICT, "用户名已被注册".into()));
    }

    let id = Uuid::new_v4().to_string();
    let token = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    insert_user(&pool, &id, &username, &display_name, &token, &created_at)
        .await
        .map_err(server_err)?;

    Ok(Json(AccountInfo {
        user_id: id,
        username,
        display_name,
        token,
    }))
}

pub async fn login(
    State(pool): State<SqlitePool>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AccountInfo>, (StatusCode, String)> {
    let username = trim_username(&req.username)
        .ok_or((StatusCode::BAD_REQUEST, "用户名不能为空".into()))?;
    let user = find_user_by_username(&pool, &username)
        .await
        .map_err(server_err)?
        .ok_or((StatusCode::NOT_FOUND, "用户不存在，请先注册".into()))?;
    Ok(Json(account_info(&user)))
}

/// Returns the currently authenticated user. Used by the client at startup to
/// validate a stored token.
pub async fn me(Extension(user): Extension<UserRow>) -> Json<AccountInfo> {
    Json(account_info(&user))
}

pub async fn push_audit(
    State(pool): State<SqlitePool>,
    Json(req): Json<AuditPushRequest>,
) -> Result<Json<AuditPushResponse>, (StatusCode, String)> {
    if req.items.is_empty() {
        return Ok(Json(AuditPushResponse { accepted: 0, skipped: 0 }));
    }
    let now = Utc::now().to_rfc3339();
    let mut accepted: u64 = 0;
    let mut skipped: u64 = 0;
    for item in &req.items {
        // INSERT OR IGNORE => idempotent on client_id. Repeated pushes of the
        // same outbox row are safe no-ops.
        let res = sqlx::query(
            "INSERT OR IGNORE INTO audit_log \
             (client_id, ts, user_id, username, connection_id, database, table_name, \
              operation, column_name, old_value, new_value, source, status, is_rollback, \
              rollback_of_client_id, host, synced_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&item.client_id)
        .bind(&item.ts)
        .bind(&item.user_id)
        .bind(&item.username)
        .bind(&item.connection_id)
        .bind(&item.database)
        .bind(&item.table_name)
        .bind(&item.operation)
        .bind(&item.column_name)
        .bind(&item.old_value)
        .bind(&item.new_value)
        .bind(&item.source)
        .bind(&item.status)
        .bind(if item.is_rollback { 1 } else { 0 })
        .bind(&item.rollback_of_client_id)
        .bind(&item.host)
        .bind(&now)
        .execute(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("写入审计失败: {e}")))?;
        if res.rows_affected() > 0 {
            accepted += 1;
        } else {
            skipped += 1;
        }
    }
    Ok(Json(AuditPushResponse { accepted, skipped }))
}

pub async fn list_audit(
    State(pool): State<SqlitePool>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Vec<SharedAuditLogEntry>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(200).min(2000) as i64;
    let offset = q.offset.unwrap_or(0) as i64;

    let mut sql = String::from(
        "SELECT a.client_id, a.ts, a.user_id, a.username, u.display_name, \
         a.connection_id, a.database, a.table_name, a.operation, a.column_name, \
         a.old_value, a.new_value, a.source, a.status, a.is_rollback, \
         a.rollback_of_client_id, a.host \
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id",
    );
    let mut clauses: Vec<&'static str> = Vec::new();
    if q.connection_id.is_some() {
        clauses.push("a.connection_id = ?");
    }
    if q.database.is_some() {
        clauses.push("a.database = ?");
    }
    if q.table_name.is_some() {
        clauses.push("a.table_name = ?");
    }
    if q.user_id.is_some() {
        clauses.push("a.user_id = ?");
    }
    if q.from_ts.is_some() {
        clauses.push("a.ts >= ?");
    }
    if q.to_ts.is_some() {
        clauses.push("a.ts <= ?");
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY a.ts DESC LIMIT ? OFFSET ?");

    let mut query = sqlx::query(&sql);
    if let Some(v) = &q.connection_id {
        query = query.bind(v);
    }
    if let Some(v) = &q.database {
        query = query.bind(v);
    }
    if let Some(v) = &q.table_name {
        query = query.bind(v);
    }
    if let Some(v) = &q.user_id {
        query = query.bind(v);
    }
    if let Some(v) = &q.from_ts {
        query = query.bind(v);
    }
    if let Some(v) = &q.to_ts {
        query = query.bind(v);
    }
    query = query.bind(limit).bind(offset);

    let rows = query
        .fetch_all(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("查询共享审计失败: {e}")))?;
    let entries = rows
        .into_iter()
        .map(|r| SharedAuditLogEntry {
            client_id: r.try_get("client_id").unwrap_or_default(),
            ts: r.try_get("ts").unwrap_or_default(),
            user_id: r.try_get("user_id").unwrap_or_default(),
            username: r.try_get("username").unwrap_or_default(),
            display_name: r.try_get("display_name").unwrap_or_default(),
            connection_id: r.try_get("connection_id").unwrap_or_default(),
            database: r.try_get("database").unwrap_or_default(),
            table_name: r.try_get("table_name").unwrap_or_default(),
            operation: r.try_get("operation").unwrap_or_default(),
            column_name: r.try_get("column_name").ok().flatten(),
            old_value: r.try_get("old_value").ok().flatten(),
            new_value: r.try_get("new_value").ok().flatten(),
            source: r.try_get("source").unwrap_or_default(),
            status: r.try_get("status").unwrap_or_default(),
            is_rollback: r.try_get::<i64, _>("is_rollback").unwrap_or(0) != 0,
            rollback_of_client_id: r.try_get("rollback_of_client_id").ok().flatten(),
            host: r.try_get("host").ok().flatten(),
        })
        .collect();
    Ok(Json(entries))
}
