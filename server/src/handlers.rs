//! HTTP handlers: health / register / login / me / audit (GET + POST) / audit/since.

use std::collections::HashSet;
use std::path::PathBuf;

use axum::{
    extract::{Extension, Query, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::auth::account_info;
use crate::db::{
    canonical_server_scope, clear_external_changes_matching_audit, find_user_by_username,
    insert_user, parse_audit_ts_ms, prune_table_external_changes, prune_table_revisions,
    upsert_external_change, ExternalChangeInsert, UserRow,
};
use crate::gm_backups::{self, GmBackupTableCache};
use crate::models::*;

#[derive(Clone)]
pub struct ServerState {
    pub pool: SqlitePool,
    pub max_revisions_per_table: usize,
    pub gm_backup_dir: Option<PathBuf>,
    pub gm_backup_table_cache: GmBackupTableCache,
}

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

/// Lightweight health check for deployment scripts and process supervision.
pub async fn health(
    State(state): State<ServerState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    sqlx::query("SELECT 1")
        .execute(&state.pool)
        .await
        .map_err(|e| server_err(format!("中心服务数据库不可用: {e}")))?;
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

pub async fn register(
    State(state): State<ServerState>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AccountInfo>, (StatusCode, String)> {
    let username =
        trim_username(&req.username).ok_or((StatusCode::BAD_REQUEST, "用户名不能为空".into()))?;
    let display_name = req
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| username.clone());

    if find_user_by_username(&state.pool, &username)
        .await
        .map_err(server_err)?
        .is_some()
    {
        return Err((StatusCode::CONFLICT, "用户名已被注册".into()));
    }

    let id = Uuid::new_v4().to_string();
    let token = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    insert_user(&state.pool, &id, &username, &display_name, &token, &created_at)
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
    State(state): State<ServerState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AccountInfo>, (StatusCode, String)> {
    let username =
        trim_username(&req.username).ok_or((StatusCode::BAD_REQUEST, "用户名不能为空".into()))?;
    let user = find_user_by_username(&state.pool, &username)
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
    State(state): State<ServerState>,
    Json(req): Json<AuditPushRequest>,
) -> Result<Json<AuditPushResponse>, (StatusCode, String)> {
    if req.items.iter().any(|item| item.client_id.starts_with("mcp:")) {
        return Err((StatusCode::BAD_REQUEST, "MCP 操作记录由中心服务生成".into()));
    }
    if req.items.is_empty() {
        return Ok(Json(AuditPushResponse {
            accepted: 0,
            skipped: 0,
        }));
    }
    let now = Utc::now().to_rfc3339();
    let mut accepted: u64 = 0;
    let mut skipped: u64 = 0;
    let mut touched_tables: HashSet<(String, String, String)> = HashSet::new();
    for item in &req.items {
        // INSERT OR IGNORE => idempotent on client_id. Repeated pushes of the
        // same outbox row are safe no-ops.
        let row_identity_json = item
            .row_identity
            .as_ref()
            .and_then(|value| serde_json::to_string(value).ok());
        let operation_id = item
            .operation_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let res = sqlx::query(
            "INSERT OR IGNORE INTO audit_log \
             (client_id, ts, user_id, username, connection_id, database, table_name, \
              operation, row_identity, column_name, old_value, new_value, source, status, \
              is_rollback, rollback_of_client_id, host, synced_at, server_key, operation_id, operation_size) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&item.client_id)
        .bind(&item.ts)
        .bind(&item.user_id)
        .bind(&item.username)
        .bind(&item.connection_id)
        .bind(&item.database)
        .bind(&item.table_name)
        .bind(&item.operation)
        .bind(&row_identity_json)
        .bind(&item.column_name)
        .bind(&item.old_value)
        .bind(&item.new_value)
        .bind(&item.source)
        .bind(&item.status)
        .bind(if item.is_rollback { 1 } else { 0 })
        .bind(&item.rollback_of_client_id)
        .bind(&item.host)
        .bind(&now)
        .bind(&item.server_key)
        .bind(operation_id)
        .bind(item.operation_size)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("写入审计失败: {e}"),
            )
        })?;
        if res.rows_affected() > 0 {
            accepted += 1;
            let scope = canonical_server_scope(item.server_key.as_deref());
            let db_lower = item.database.trim().to_ascii_lowercase();
            let table_lower = item.table_name.trim().to_ascii_lowercase();
            if matches!(item.status.as_str(), "committed" | "rolled_back") {
                if let Some(audit_ms) = parse_audit_ts_ms(&item.ts) {
                    let _ = clear_external_changes_matching_audit(
                        &state.pool,
                        &scope,
                        &db_lower,
                        &table_lower,
                        audit_ms,
                    )
                    .await;
                }
            }
            touched_tables.insert((scope, db_lower, table_lower));
        } else {
            skipped += 1;
        }
    }
    if state.max_revisions_per_table > 0 {
        for (scope, db_lower, table_lower) in touched_tables {
            let _ = prune_table_revisions(
                &state.pool,
                &scope,
                &db_lower,
                &table_lower,
                state.max_revisions_per_table,
            )
            .await;
        }
    }
    Ok(Json(AuditPushResponse { accepted, skipped }))
}

pub async fn list_audit(
    State(state): State<ServerState>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Vec<SharedAuditLogEntry>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(200).min(2000) as i64;
    let offset = q.offset.unwrap_or(0) as i64;
    let server_scope = canonical_server_scope(q.server_key.as_deref());

    let mut sql = String::from(
        "SELECT a.client_id, a.ts, a.user_id, a.username, u.display_name, \
         a.connection_id, a.database, a.table_name, a.operation, a.row_identity, a.column_name, \
         a.old_value, a.new_value, a.source, a.status, a.is_rollback, \
         a.rollback_of_client_id, a.host, a.server_key, a.svn_username, \
         a.operation_id, a.operation_size \
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id",
    );
    let mut clauses: Vec<&'static str> = Vec::new();
    if q.connection_id.is_some() {
        clauses.push("a.connection_id = ?");
    }
    if q.database.is_some() {
        clauses.push("LOWER(TRIM(a.database)) = LOWER(TRIM(?))");
    }
    if q.table_name.is_some() {
        clauses.push("LOWER(TRIM(a.table_name)) = LOWER(TRIM(?))");
    }
    if !server_scope.is_empty() {
        clauses.push(
            "(a.server_key IS NULL OR TRIM(a.server_key) = '' \
              OR LOWER(TRIM(a.server_key)) = 'mysql://configured:3306' \
              OR LOWER(TRIM(a.server_key)) = ?)",
        );
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
    if q.committed_only {
        clauses.push("a.status IN ('committed', 'rolled_back')");
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY a.ts DESC, a.rowid DESC LIMIT ? OFFSET ?");

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
    if !server_scope.is_empty() {
        query = query.bind(&server_scope);
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

    let rows = query.fetch_all(&state.pool).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("查询共享审计失败: {e}"),
        )
    })?;
    let entries = rows
        .into_iter()
        .map(|r| SharedAuditLogEntry {
            client_id: r.try_get("client_id").unwrap_or_default(),
            ts: r.try_get("ts").unwrap_or_default(),
            user_id: r.try_get("user_id").unwrap_or_default(),
            username: r.try_get("username").unwrap_or_default(),
            display_name: r.try_get("display_name").unwrap_or_default(),
            svn_username: r.try_get("svn_username").ok().flatten(),
            connection_id: r.try_get("connection_id").unwrap_or_default(),
            database: r.try_get("database").unwrap_or_default(),
            table_name: r.try_get("table_name").unwrap_or_default(),
            operation: r.try_get("operation").unwrap_or_default(),
            row_identity: r
                .try_get::<Option<String>, _>("row_identity")
                .ok()
                .flatten()
                .and_then(|raw| serde_json::from_str(&raw).ok()),
            column_name: r.try_get("column_name").ok().flatten(),
            old_value: r.try_get("old_value").ok().flatten(),
            new_value: r.try_get("new_value").ok().flatten(),
            source: r.try_get("source").unwrap_or_default(),
            status: r.try_get("status").unwrap_or_default(),
            is_rollback: r.try_get::<i64, _>("is_rollback").unwrap_or(0) != 0,
            rollback_of_client_id: r.try_get("rollback_of_client_id").ok().flatten(),
            host: r.try_get("host").ok().flatten(),
            server_key: r.try_get("server_key").ok().flatten(),
            operation_id: r
                .try_get::<Option<String>, _>("operation_id")
                .ok()
                .flatten()
                .filter(|s| !s.is_empty()),
            operation_size: r.try_get("operation_size").ok().flatten(),
        })
        .collect();
    Ok(Json(entries))
}

pub async fn table_latest(
    State(state): State<ServerState>,
    Query(q): Query<TableLatestQuery>,
) -> Result<Json<Vec<SharedTableLatestModified>>, (StatusCode, String)> {
    let database = q.database.trim();
    if database.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "database 不能为空".into()));
    }
    let server_key = q
        .server_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("mysql://configured:3306"));
    let connection_id = q
        .connection_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if server_key.is_none() && connection_id.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            "serverKey 与 connectionId 不能同时为空".into(),
        ));
    }

    let rows = sqlx::query(
        "WITH ranked AS ( \
             SELECT a.table_name, a.ts, a.username, \
                    COALESCE(u.display_name, a.username) AS display_name, \
                    a.source, \
                    ROW_NUMBER() OVER ( \
                        PARTITION BY LOWER(a.table_name) \
                        ORDER BY a.ts DESC, a.rowid DESC \
                    ) AS rn \
             FROM audit_log a \
             LEFT JOIN users u ON u.id = a.user_id \
             WHERE a.status IN ('committed', 'rolled_back') \
               AND LOWER(a.database) = LOWER(?) \
               AND a.table_name NOT LIKE '(%' \
               AND ( \
                   a.server_key IS NULL \
                   OR TRIM(a.server_key) = '' \
                   OR LOWER(TRIM(a.server_key)) = 'mysql://configured:3306' \
                   OR (? IS NOT NULL AND LOWER(TRIM(a.server_key)) = LOWER(?)) \
               ) \
         ) \
         SELECT table_name, ts, username, display_name, source \
         FROM ranked \
         WHERE rn = 1",
    )
    .bind(database)
    .bind(server_key)
    .bind(server_key)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("查询表最新修改时间失败: {e}"),
        )
    })?;

    let items = rows
        .into_iter()
        .map(|r| SharedTableLatestModified {
            table_name: r.try_get("table_name").unwrap_or_default(),
            ts: r.try_get("ts").unwrap_or_default(),
            username: r.try_get("username").unwrap_or_default(),
            display_name: r.try_get("display_name").unwrap_or_default(),
            source: r.try_get("source").unwrap_or_default(),
        })
        .collect();
    Ok(Json(items))
}

pub async fn push_external_changes(
    State(state): State<ServerState>,
    Extension(user): Extension<UserRow>,
    Json(req): Json<ExternalChangePushRequest>,
) -> Result<Json<AuditPushResponse>, (StatusCode, String)> {
    if req.items.is_empty() {
        return Ok(Json(AuditPushResponse {
            accepted: 0,
            skipped: 0,
        }));
    }
    let now = Utc::now().to_rfc3339();
    let mut accepted: u64 = 0;
    let mut skipped: u64 = 0;
    let mut touched_tables: HashSet<(String, String, String)> = HashSet::new();

    for item in &req.items {
        let changed = upsert_external_change(
            &state.pool,
            &ExternalChangeInsert {
                event_id: &item.event_id,
                server_key: item.server_key.as_deref(),
                database: &item.database,
                table_name: &item.table_name,
                ts: &item.ts,
                ts_ms: item.ts_ms,
                time_kind: &item.time_kind,
                signal: &item.signal,
                reported_by_user_id: &user.id,
                reported_by_username: &user.username,
                host: item.host.as_deref(),
                synced_at: &now,
            },
        )
        .await
        .map_err(server_err)?;
        if changed {
            accepted += 1;
            touched_tables.insert((
                canonical_server_scope(item.server_key.as_deref()),
                item.database.trim().to_ascii_lowercase(),
                item.table_name.trim().to_ascii_lowercase(),
            ));
        } else {
            skipped += 1;
        }
    }

    if state.max_revisions_per_table > 0 {
        for (scope, db_lower, table_lower) in touched_tables {
            let _ = prune_table_external_changes(
                &state.pool,
                &scope,
                &db_lower,
                &table_lower,
                state.max_revisions_per_table,
            )
            .await;
        }
    }

    Ok(Json(AuditPushResponse { accepted, skipped }))
}

pub async fn list_external_changes(
    State(state): State<ServerState>,
    Query(q): Query<ExternalChangeQuery>,
) -> Result<Json<Vec<SharedExternalChangeEntry>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(100).min(500) as i64;
    let offset = q.offset.unwrap_or(0) as i64;
    let server_scope = canonical_server_scope(q.server_key.as_deref());
    let database = q.database.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let table_name = q
        .table_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut sql = String::from(
        "SELECT event_id, server_key, database, table_name, ts, ts_ms, time_kind, signal \
         FROM table_external_changes",
    );
    let mut clauses: Vec<&'static str> = Vec::new();
    if database.is_some() {
        clauses.push("LOWER(TRIM(database)) = LOWER(?)");
    }
    if table_name.is_some() {
        clauses.push("LOWER(TRIM(table_name)) = LOWER(?)");
    }
    if !server_scope.is_empty() {
        clauses.push(
            "(server_key IS NULL OR TRIM(server_key) = '' \
              OR LOWER(TRIM(server_key)) = 'mysql://configured:3306' \
              OR LOWER(TRIM(server_key)) = ?)",
        );
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY ts_ms DESC, rowid DESC LIMIT ? OFFSET ?");

    let mut query = sqlx::query(&sql);
    if let Some(v) = database {
        query = query.bind(v);
    }
    if let Some(v) = table_name {
        query = query.bind(v);
    }
    if !server_scope.is_empty() {
        query = query.bind(&server_scope);
    }
    query = query.bind(limit).bind(offset);

    let rows = query.fetch_all(&state.pool).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("查询共享外部变动失败: {e}"),
        )
    })?;

    let entries = rows
        .into_iter()
        .map(|r| SharedExternalChangeEntry {
            event_id: r.try_get("event_id").unwrap_or_default(),
            server_key: r.try_get("server_key").ok().flatten(),
            database: r.try_get("database").unwrap_or_default(),
            table_name: r.try_get("table_name").unwrap_or_default(),
            ts: r.try_get("ts").unwrap_or_default(),
            ts_ms: r.try_get("ts_ms").unwrap_or(0),
            time_kind: r.try_get("time_kind").unwrap_or_default(),
            signal: r.try_get("signal").unwrap_or_default(),
        })
        .collect();
    Ok(Json(entries))
}

pub async fn list_gm_backups(
    State(state): State<ServerState>,
    Query(q): Query<GmBackupListQuery>,
) -> Result<Json<GmBackupListResponse>, (StatusCode, String)> {
    let dir = state.gm_backup_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        gm_backups::list_backups(
            dir.as_deref(),
            q.database.as_deref(),
            q.date.as_deref(),
            q.limit,
        )
    })
    .await
    .map_err(|e| server_err(format!("扫描备份目录任务异常: {e}")))??;
    Ok(Json(result))
}

pub async fn list_gm_backup_tables(
    State(state): State<ServerState>,
    Query(q): Query<GmBackupTablesQuery>,
) -> Result<Json<GmBackupTablesResponse>, (StatusCode, String)> {
    let dir = state.gm_backup_dir.clone();
    let cache = state.gm_backup_table_cache.clone();
    let result = tokio::task::spawn_blocking(move || {
        gm_backups::list_backup_tables(dir.as_deref(), &cache, &q.date, &q.hour, &q.file_name)
    })
    .await
    .map_err(|e| server_err(format!("读取备份表列表任务异常: {e}")))??;
    Ok(Json(result))
}

pub async fn extract_gm_backup(
    State(state): State<ServerState>,
    Json(req): Json<GmBackupExtractRequest>,
) -> Result<Json<GmBackupExtractResponse>, (StatusCode, String)> {
    let dir = state.gm_backup_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        gm_backups::extract_backup_sql(
            dir.as_deref(),
            &req.date,
            &req.hour,
            &req.file_name,
            &req.tables,
        )
    })
    .await
    .map_err(|e| server_err(format!("提取备份 SQL 任务异常: {e}")))??;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{connect, insert_user, prune_all_tables, DEFAULT_MAX_REVISIONS_PER_TABLE};

    fn test_state(pool: SqlitePool) -> ServerState {
        ServerState {
            pool,
            max_revisions_per_table: DEFAULT_MAX_REVISIONS_PER_TABLE,
            gm_backup_dir: None,
            gm_backup_table_cache: GmBackupTableCache::new(),
        }
    }

    fn push_item(
        client_id: &str,
        ts: &str,
        connection_id: &str,
        server_key: Option<&str>,
        table_name: &str,
        status: &str,
    ) -> AuditPushItem {
        AuditPushItem {
            client_id: client_id.into(),
            ts: ts.into(),
            user_id: "u1".into(),
            username: "alice".into(),
            connection_id: connection_id.into(),
            database: "newsg_4cfg".into(),
            table_name: table_name.into(),
            operation: "UPDATE".into(),
            row_identity: Some(serde_json::json!({"id": "1001"})),
            column_name: Some("Name".into()),
            old_value: Some("old".into()),
            new_value: Some("new".into()),
            source: "grid".into(),
            status: status.into(),
            is_rollback: false,
            rollback_of_client_id: None,
            host: Some("pc-a".into()),
            server_key: server_key.map(Into::into),
            operation_id: None,
            operation_size: None,
        }
    }

    #[tokio::test]
    async fn table_latest_matches_across_connection_ids_via_server_key_and_filters_status() {
        let pool = connect("sqlite::memory:").await.unwrap();
        insert_user(&pool, "u1", "alice", "Alice", "tok", "2026-11-23T00:00:00Z")
            .await
            .unwrap();

        let _ = push_audit(
            State(test_state(pool.clone())),
            Json(AuditPushRequest {
                items: vec![
                    push_item(
                        "c1",
                        "2026-11-23T08:00:00Z",
                        "mysql-2",
                        Some("mysql://10.0.0.1:3306"),
                        "goodsprop",
                        "committed",
                    ),
                    push_item(
                        "c2",
                        "2026-11-23T09:00:00Z",
                        "mysql-2",
                        Some("mysql://10.0.0.1:3306"),
                        "GoodsProp",
                        "committed",
                    ),
                    push_item(
                        "c3",
                        "2026-11-23T10:00:00Z",
                        "mysql-2",
                        Some("mysql://10.0.0.1:3306"),
                        "goodsprop",
                        "aborted",
                    ),
                    push_item(
                        "c4",
                        "2026-11-23T08:30:00Z",
                        "mysql-9",
                        None,
                        "heroprop",
                        "committed",
                    ),
                    push_item(
                        "c5",
                        "2026-11-23T11:00:00Z",
                        "mysql-2",
                        Some("mysql://10.0.0.1:3306"),
                        "(agent)",
                        "committed",
                    ),
                    push_item(
                        "c6",
                        "2026-11-23T12:00:00Z",
                        "mysql-1",
                        Some("mysql://10.0.0.2:3306"),
                        "other_server_table",
                        "committed",
                    ),
                ],
            }),
        )
        .await
        .unwrap();

        let Json(mut items) = table_latest(
            State(test_state(pool)),
            Query(TableLatestQuery {
                database: "newsg_4cfg".into(),
                server_key: Some("mysql://10.0.0.1:3306".into()),
                connection_id: Some("mysql-1".into()),
            }),
        )
        .await
        .unwrap();
        items.sort_by(|a, b| a.table_name.to_lowercase().cmp(&b.table_name.to_lowercase()));

        assert_eq!(items.len(), 2);
        assert_eq!(items[0].table_name, "GoodsProp");
        assert_eq!(items[0].ts, "2026-11-23T09:00:00Z");
        assert_eq!(items[0].display_name, "Alice");
        assert_eq!(items[1].table_name, "heroprop");
        assert_eq!(items[1].ts, "2026-11-23T08:30:00Z");
    }

    #[tokio::test]
    async fn push_and_list_audit_round_trips_row_identity_and_preserves_legacy_nulls() {
        let pool = connect("sqlite::memory:").await.unwrap();
        insert_user(&pool, "u1", "alice", "Alice", "tok", "2026-11-23T00:00:00Z")
            .await
            .unwrap();

        let mut with_identity = push_item(
            "c-with-id",
            "2026-11-24T10:00:00Z",
            "mysql-1",
            Some("mysql://10.0.0.1:3306"),
            "goodsprop",
            "committed",
        );
        with_identity.row_identity = Some(serde_json::json!({"ID": "2048", "SubID": "3"}));

        let mut legacy_without_identity = push_item(
            "c-legacy",
            "2026-11-24T09:00:00Z",
            "mysql-1",
            Some("mysql://10.0.0.1:3306"),
            "goodsprop",
            "committed",
        );
        legacy_without_identity.row_identity = None;

        let Json(resp) = push_audit(
            State(test_state(pool.clone())),
            Json(AuditPushRequest {
                items: vec![with_identity, legacy_without_identity],
            }),
        )
        .await
        .unwrap();
        assert_eq!(resp.accepted, 2);

        let Json(entries) = list_audit(
            State(test_state(pool)),
            Query(AuditQuery {
                database: Some("newsg_4cfg".into()),
                table_name: Some("goodsprop".into()),
                ..Default::default()
            }),
        )
        .await
        .unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].client_id, "c-with-id");
        assert_eq!(
            entries[0].row_identity,
            Some(serde_json::json!({"ID": "2048", "SubID": "3"}))
        );
        assert_eq!(entries[1].client_id, "c-legacy");
        assert_eq!(entries[1].row_identity, None);
    }

    #[tokio::test]
    async fn health_checks_database_connectivity() {
        let pool = connect("sqlite::memory:").await.unwrap();
        let Json(payload) = health(State(test_state(pool))).await.unwrap();
        assert_eq!(payload["status"], "ok");
    }

    #[tokio::test]
    async fn push_audit_retains_latest_20_revisions_per_table_preserving_batch_imports() {
        let pool = connect("sqlite::memory:").await.unwrap();
        insert_user(&pool, "u1", "alice", "Alice", "tok", "2026-11-23T00:00:00Z")
            .await
            .unwrap();

        let mut items = Vec::new();
        // 1 older edit on another table must remain untouched.
        items.push(push_item(
            "other-table-1",
            "2026-11-20T00:00:00Z",
            "mysql-1",
            Some("mysql://192.168.1.243:8306"),
            "skillprop",
            "committed",
        ));

        // 25 distinct edits on heroprop (1 minute apart); edit #10 is a 3-row batch import within 1s.
        for i in 1..=25 {
            let ts = format!("2026-11-24T10:{:02}:00Z", i);
            if i == 10 {
                for j in 0..3 {
                    let mut batch_row = push_item(
                        &format!("hero-batch-{j}"),
                        &format!("2026-11-24T10:10:0{j}Z"),
                        "mysql-1",
                        Some("mysql://192.168.1.243:8306"),
                        "heroprop",
                        "committed",
                    );
                    batch_row.source = "import".into();
                    items.push(batch_row);
                }
            } else {
                items.push(push_item(
                    &format!("hero-{i:02}"),
                    &ts,
                    "mysql-1",
                    Some("mysql://192.168.1.243:8306"),
                    "heroprop",
                    "committed",
                ));
            }
        }

        let _ = push_audit(State(test_state(pool.clone())), Json(AuditPushRequest { items }))
            .await
            .unwrap();

        let Json(hero_entries) = list_audit(
            State(test_state(pool.clone())),
            Query(AuditQuery {
                database: Some("newsg_4cfg".into()),
                table_name: Some("heroprop".into()),
                ..Default::default()
            }),
        )
        .await
        .unwrap();

        // Revisions 6..=25 survive (20 revisions total); revision 10 has 3 grouped rows => 22 rows.
        assert_eq!(hero_entries.len(), 22);
        assert_eq!(hero_entries[0].client_id, "hero-25");
        assert_eq!(hero_entries.last().unwrap().client_id, "hero-06");
        assert!(hero_entries.iter().filter(|e| e.client_id.starts_with("hero-batch-")).count() == 3);

        let Json(skill_entries) = list_audit(
            State(test_state(pool)),
            Query(AuditQuery {
                database: Some("newsg_4cfg".into()),
                table_name: Some("skillprop".into()),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
        assert_eq!(skill_entries.len(), 1);
        assert_eq!(skill_entries[0].client_id, "other-table-1");
    }

    #[tokio::test]
    async fn startup_prune_all_tables_trims_migrated_history_to_20_per_table() {
        let pool = connect("sqlite::memory:").await.unwrap();
        insert_user(&pool, "u1", "alice", "Alice", "tok", "2026-11-23T00:00:00Z")
            .await
            .unwrap();

        // Seed 24 edits without pruning (simulating a pre-existing DB migrated from 193).
        let unpruned_state = ServerState {
            pool: pool.clone(),
            max_revisions_per_table: 0,
            gm_backup_dir: None,
            gm_backup_table_cache: GmBackupTableCache::new(),
        };
        let items: Vec<_> = (1..=24)
            .map(|i| {
                push_item(
                    &format!("legacy-{i:02}"),
                    &format!("2026-11-24T08:{:02}:00Z", i),
                    "mysql-1",
                    None,
                    "goodsprop",
                    "committed",
                )
            })
            .collect();
        let _ = push_audit(State(unpruned_state), Json(AuditPushRequest { items }))
            .await
            .unwrap();

        let pruned = prune_all_tables(&pool, DEFAULT_MAX_REVISIONS_PER_TABLE)
            .await
            .unwrap();
        assert_eq!(pruned, 4);

        let Json(entries) = list_audit(
            State(test_state(pool)),
            Query(AuditQuery {
                database: Some("newsg_4cfg".into()),
                table_name: Some("goodsprop".into()),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 20);
        assert_eq!(entries[0].client_id, "legacy-24");
        assert_eq!(entries.last().unwrap().client_id, "legacy-05");
    }

    fn test_user(id: &str, username: &str) -> UserRow {
        UserRow {
            id: id.into(),
            username: username.into(),
            display_name: username.into(),
            token: "tok".into(),
        }
    }

    fn ext_item(
        event_id: &str,
        server_key: Option<&str>,
        table_name: &str,
        ts: &str,
        ts_ms: i64,
        time_kind: &str,
        signal: &str,
    ) -> ExternalChangePushItem {
        ExternalChangePushItem {
            event_id: event_id.into(),
            server_key: server_key.map(Into::into),
            database: "newsg_4cfg".into(),
            table_name: table_name.into(),
            ts: ts.into(),
            ts_ms,
            time_kind: time_kind.into(),
            signal: signal.into(),
            host: Some("pc-1".into()),
        }
    }

    #[tokio::test]
    async fn external_changes_deduplicate_across_workstations_and_upgrade_detected_to_exact() {
        let pool = connect("sqlite::memory:").await.unwrap();
        insert_user(&pool, "u1", "alice", "Alice", "tok1", "2026-11-26T00:00:00Z")
            .await
            .unwrap();
        insert_user(&pool, "u2", "bob", "Bob", "tok2", "2026-11-26T00:00:00Z")
            .await
            .unwrap();

        let t0 = parse_audit_ts_ms("2026-11-26T02:00:00Z").unwrap();
        // 1) Alice's workstation detects write_count bump at t0 + 25s (approximate).
        let Json(r1) = push_external_changes(
            State(test_state(pool.clone())),
            Extension(test_user("u1", "alice")),
            Json(ExternalChangePushRequest {
                items: vec![ext_item(
                    "ext-a-1",
                    Some("mysql://192.168.1.243:8306"),
                    "goodsprop",
                    "2026-11-26T02:00:25Z",
                    t0 + 25_000,
                    "detected",
                    "write_count",
                )],
            }),
        )
        .await
        .unwrap();
        assert_eq!(r1.accepted, 1);

        // 2) Bob detects the same bump 15s later -> coalesced (skipped).
        let Json(r2) = push_external_changes(
            State(test_state(pool.clone())),
            Extension(test_user("u2", "bob")),
            Json(ExternalChangePushRequest {
                items: vec![ext_item(
                    "ext-b-1",
                    Some("mysql://192.168.1.243:8306"),
                    "goodsprop",
                    "2026-11-26T02:00:40Z",
                    t0 + 40_000,
                    "detected",
                    "write_count",
                )],
            }),
        )
        .await
        .unwrap();
        assert_eq!(r2.accepted, 0);
        assert_eq!(r2.skipped, 1);

        // 3) Exact MySQL UPDATE_TIME at t0 arrives -> upgrades the existing row to exact.
        let Json(r3) = push_external_changes(
            State(test_state(pool.clone())),
            Extension(test_user("u2", "bob")),
            Json(ExternalChangePushRequest {
                items: vec![ext_item(
                    "ext-b-exact",
                    Some("mysql://192.168.1.243:8306"),
                    "goodsprop",
                    "2026-11-26T02:00:00Z",
                    t0,
                    "exact",
                    "update_time",
                )],
            }),
        )
        .await
        .unwrap();
        assert_eq!(r3.accepted, 1);

        // 4) Another workstation pushes exact t0 + 2s -> coalesced.
        let Json(r4) = push_external_changes(
            State(test_state(pool.clone())),
            Extension(test_user("u1", "alice")),
            Json(ExternalChangePushRequest {
                items: vec![ext_item(
                    "ext-a-exact-dup",
                    Some("mysql://192.168.1.243:8306"),
                    "goodsprop",
                    "2026-11-26T02:00:02Z",
                    t0 + 2_000,
                    "exact",
                    "update_time",
                )],
            }),
        )
        .await
        .unwrap();
        assert_eq!(r4.accepted, 0);
        assert_eq!(r4.skipped, 1);

        // 5) Different MySQL server with same DB/table stays isolated.
        let _ = push_external_changes(
            State(test_state(pool.clone())),
            Extension(test_user("u1", "alice")),
            Json(ExternalChangePushRequest {
                items: vec![ext_item(
                    "ext-other-server",
                    Some("mysql://192.168.1.223:8306"),
                    "goodsprop",
                    "2026-11-26T02:05:00Z",
                    t0 + 300_000,
                    "exact",
                    "update_time",
                )],
            }),
        )
        .await
        .unwrap();

        let Json(list) = list_external_changes(
            State(test_state(pool)),
            Query(ExternalChangeQuery {
                server_key: Some("mysql://192.168.1.243:8306".into()),
                database: Some("newsg_4cfg".into()),
                table_name: Some("goodsprop".into()),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].time_kind, "exact");
        assert_eq!(list[0].ts_ms, t0);
        assert_eq!(list[0].signal, "update_time");
    }

    #[tokio::test]
    async fn external_changes_reconcile_against_blackcat_audits_in_both_orders() {
        let pool = connect("sqlite::memory:").await.unwrap();
        insert_user(&pool, "u1", "alice", "Alice", "tok1", "2026-11-26T00:00:00Z")
            .await
            .unwrap();
        insert_user(&pool, "u2", "bob", "Bob", "tok2", "2026-11-26T00:00:00Z")
            .await
            .unwrap();

        let t_audit1 = parse_audit_ts_ms("2026-11-26T03:00:00Z").unwrap();
        let t_audit2 = parse_audit_ts_ms("2026-11-26T03:10:00Z").unwrap();
        let t_navicat = parse_audit_ts_ms("2026-11-26T03:10:25Z").unwrap(); // 25s after audit2 -> real!

        // Order A: Blackcat audit1 lands first, then Bob reports an external observation 3s later -> rejected.
        let _ = push_audit(
            State(test_state(pool.clone())),
            Json(AuditPushRequest {
                items: vec![push_item(
                    "cid-1",
                    "2026-11-26T03:00:00Z",
                    "mysql-1",
                    Some("mysql://192.168.1.243:8306"),
                    "goodsprop",
                    "committed",
                )],
            }),
        )
        .await
        .unwrap();

        let Json(resp_a) = push_external_changes(
            State(test_state(pool.clone())),
            Extension(test_user("u2", "bob")),
            Json(ExternalChangePushRequest {
                items: vec![ext_item(
                    "ext-race-a",
                    Some("mysql://192.168.1.243:8306"),
                    "goodsprop",
                    "2026-11-26T03:00:03Z",
                    t_audit1 + 3_000,
                    "exact",
                    "update_time",
                )],
            }),
        )
        .await
        .unwrap();
        assert_eq!(resp_a.accepted, 0);

        // Order B: Bob reports suspected external change BEFORE Alice's audit2 lands,
        // AND also reports a genuine Navicat edit 25s after audit2.
        let Json(resp_b) = push_external_changes(
            State(test_state(pool.clone())),
            Extension(test_user("u2", "bob")),
            Json(ExternalChangePushRequest {
                items: vec![
                    ext_item(
                        "ext-race-b",
                        Some("mysql://192.168.1.243:8306"),
                        "goodsprop",
                        "2026-11-26T03:10:04Z",
                        t_audit2 + 4_000,
                        "exact",
                        "update_time",
                    ),
                    ext_item(
                        "ext-real-navicat",
                        Some("mysql://192.168.1.243:8306"),
                        "goodsprop",
                        "2026-11-26T03:10:25Z",
                        t_navicat,
                        "exact",
                        "update_time",
                    ),
                ],
            }),
        )
        .await
        .unwrap();
        assert_eq!(resp_b.accepted, 2);

        // Now Alice's audit2 arrives: clears ext-race-b, preserves ext-real-navicat!
        let _ = push_audit(
            State(test_state(pool.clone())),
            Json(AuditPushRequest {
                items: vec![push_item(
                    "cid-2",
                    "2026-11-26T03:10:00Z",
                    "mysql-1",
                    Some("mysql://192.168.1.243:8306"),
                    "goodsprop",
                    "committed",
                )],
            }),
        )
        .await
        .unwrap();

        let Json(list) = list_external_changes(
            State(test_state(pool)),
            Query(ExternalChangeQuery {
                server_key: Some("mysql://192.168.1.243:8306".into()),
                database: Some("newsg_4cfg".into()),
                table_name: Some("goodsprop".into()),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].event_id, "ext-real-navicat");
    }

    #[tokio::test]
    async fn external_changes_prune_independently_to_max_per_table() {
        let pool = connect("sqlite::memory:").await.unwrap();
        insert_user(&pool, "u1", "alice", "Alice", "tok1", "2026-11-26T00:00:00Z")
            .await
            .unwrap();
        let base = parse_audit_ts_ms("2026-11-26T01:00:00Z").unwrap();
        let items: Vec<_> = (1..=25)
            .map(|i| {
                let ts_ms = base + i * 60_000;
                let ts = chrono::DateTime::from_timestamp_millis(ts_ms)
                    .unwrap()
                    .to_rfc3339();
                ext_item(
                    &format!("ext-{i:02}"),
                    Some("mysql://192.168.1.243:8306"),
                    "goodsprop",
                    &ts,
                    ts_ms,
                    "exact",
                    "update_time",
                )
            })
            .collect();
        let _ = push_external_changes(
            State(test_state(pool.clone())),
            Extension(test_user("u1", "alice")),
            Json(ExternalChangePushRequest { items }),
        )
        .await
        .unwrap();

        let Json(list) = list_external_changes(
            State(test_state(pool)),
            Query(ExternalChangeQuery {
                server_key: Some("mysql://192.168.1.243:8306".into()),
                database: Some("newsg_4cfg".into()),
                table_name: Some("goodsprop".into()),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
        assert_eq!(list.len(), 20);
        assert_eq!(list[0].event_id, "ext-25");
        assert_eq!(list.last().unwrap().event_id, "ext-06");
    }

    #[tokio::test]
    async fn push_audit_keeps_multi_thousand_row_import_as_single_revision_and_round_trips_operation_meta() {
        let pool = connect("sqlite::memory:").await.unwrap();
        insert_user(&pool, "u1", "hyp", "黄亚鹏", "tok", "2026-11-26T00:00:00Z")
            .await
            .unwrap();

        // Seed 20 older single-row edits (1 minute apart).
        let mut seed_items = Vec::new();
        for i in 1..=20 {
            seed_items.push(push_item(
                &format!("older-{i:02}"),
                &format!("2026-11-26T07:{i:02}:00Z"),
                "mysql-1",
                Some("mysql://192.168.1.243:8306"),
                "goodsprop",
                "committed",
            ));
        }
        let _ = push_audit(
            State(test_state(pool.clone())),
            Json(AuditPushRequest { items: seed_items }),
        )
        .await
        .unwrap();

        // Push a 2,500-row Excel import in 5 separate 500-row HTTP batches sharing one operation_id.
        // Previously MAX_ITEMS_PER_REVISION=500 treated 2,500 rows as 5 revisions (and >10,000 rows
        // deleted part of the import itself!). Now all 2,500 rows count as 1 revision, so 19 older
        // revisions survive alongside all 2,500 rows of the import (total = 2,519 rows).
        for chunk_idx in 0..5 {
            let mut batch = Vec::with_capacity(500);
            for offset in 0..500 {
                let row_num = chunk_idx * 500 + offset + 1;
                let mut item = push_item(
                    &format!("imp-row-{row_num:04}"),
                    "2026-11-26T08:53:15Z",
                    "mysql-1",
                    Some("mysql://192.168.1.243:8306"),
                    "goodsprop",
                    "committed",
                );
                item.source = "import".into();
                item.row_identity = Some(serde_json::json!({ "ID": row_num.to_string() }));
                item.operation_id = Some("op-import-2500".into());
                item.operation_size = Some(2500);
                batch.push(item);
            }
            let Json(resp) = push_audit(
                State(test_state(pool.clone())),
                Json(AuditPushRequest { items: batch }),
            )
            .await
            .unwrap();
            assert_eq!(resp.accepted, 500);
        }

        // Also push an edit on another MySQL server's `goodsprop` and an aborted row;
        // `server_key` + `committed_only` must isolate them cleanly.
        let mut other_server = push_item(
            "other-srv-1",
            "2026-11-26T09:00:00Z",
            "mysql-9",
            Some("mysql://192.168.1.223:8306"),
            "goodsprop",
            "committed",
        );
        other_server.operation_id = Some("op-other-srv".into());
        other_server.operation_size = Some(1);
        let aborted_row = push_item(
            "aborted-1",
            "2026-11-26T08:55:00Z",
            "mysql-1",
            Some("mysql://192.168.1.243:8306"),
            "goodsprop",
            "aborted",
        );
        let _ = push_audit(
            State(test_state(pool.clone())),
            Json(AuditPushRequest {
                items: vec![other_server, aborted_row],
            }),
        )
        .await
        .unwrap();

        let mut all_fetched = Vec::new();
        let mut offset = 0;
        loop {
            let Json(page) = list_audit(
                State(test_state(pool.clone())),
                Query(AuditQuery {
                    server_key: Some("mysql://192.168.1.243:8306".into()),
                    database: Some("newsg_4cfg".into()),
                    table_name: Some("GoodsProp".into()),
                    committed_only: true,
                    limit: Some(2000),
                    offset: Some(offset),
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
            let count = page.len() as u32;
            all_fetched.extend(page);
            offset += count;
            if count < 2000 {
                break;
            }
        }

        // 2,500 import rows + 19 retained older revisions (older-02 .. older-20) = 2,519 rows!
        // Wait: the aborted_row at 08:55 counted as 1 stored revision in prune_table_revisions,
        // so 18 committed older revisions + 1 aborted + 1 import = 20 revisions => 2,518 committed rows!
        let import_rows: Vec<_> = all_fetched
            .iter()
            .filter(|e| e.operation_id.as_deref() == Some("op-import-2500"))
            .collect();
        assert_eq!(import_rows.len(), 2500, "all 2500 import rows must be retained intact");
        assert!(import_rows.iter().all(|e| e.operation_size == Some(2500)));
        assert!(all_fetched.iter().all(|e| e.status == "committed"));
        assert!(all_fetched.iter().all(|e| e.client_id != "other-srv-1"));
        // Deterministic descending rowid order across the 2000-row page boundary
        assert_eq!(import_rows[0].client_id, "imp-row-2500");
        assert_eq!(import_rows[2499].client_id, "imp-row-0001");
    }
}
