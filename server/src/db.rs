//! SQLite storage for the central server: `users` + shared `audit_log`.

use std::str::FromStr;

use chrono::{DateTime, NaiveDateTime};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, SqlitePool,
};

/// Default number of recent revisions retained per table on the central server.
pub const DEFAULT_MAX_REVISIONS_PER_TABLE: usize = 20;

/// Revision grouping window matching the desktop client (`tableChangeHistory.js`).
const REVISION_GROUP_WINDOW_MS: i64 = 2500;
const MAX_ITEMS_PER_REVISION: usize = 500;
const DELETE_CHUNK_SIZE: usize = 400;
const LEGACY_PLACEHOLDER_SERVER_KEY: &str = "mysql://configured:3306";

const SCHEMA: &str = "\
CREATE TABLE IF NOT EXISTS users (\
    id TEXT PRIMARY KEY,\
    username TEXT UNIQUE NOT NULL,\
    display_name TEXT NOT NULL,\
    token TEXT NOT NULL,\
    created_at TEXT NOT NULL\
);\
CREATE TABLE IF NOT EXISTS audit_log (\
    client_id TEXT PRIMARY KEY,\
    ts TEXT NOT NULL,\
    user_id TEXT NOT NULL,\
    username TEXT NOT NULL,\
    connection_id TEXT NOT NULL,\
    database TEXT NOT NULL,\
    table_name TEXT NOT NULL,\
    operation TEXT NOT NULL,\
    column_name TEXT,\
    old_value TEXT,\
    new_value TEXT,\
    source TEXT NOT NULL,\
    status TEXT NOT NULL,\
    is_rollback INTEGER NOT NULL DEFAULT 0,\
    rollback_of_client_id TEXT,\
    host TEXT,\
    synced_at TEXT NOT NULL,\
    FOREIGN KEY (user_id) REFERENCES users(id)\
);\
CREATE INDEX IF NOT EXISTS ix_audit_user_ts ON audit_log(user_id, ts DESC);\
CREATE INDEX IF NOT EXISTS ix_audit_conn_db_ts ON audit_log(connection_id, database, ts DESC);\
CREATE INDEX IF NOT EXISTS ix_audit_synced ON audit_log(synced_at);\
";

pub async fn connect(db_path: &str) -> Result<SqlitePool, String> {
    let url = if db_path.starts_with("sqlite://") {
        db_path.to_string()
    } else {
        format!("sqlite://{}?mode=rwc", db_path.replace('\\', "/"))
    };
    let options = SqliteConnectOptions::from_str(&url)
        .map_err(|e| format!("初始化中心服务数据库失败: {e}"))?
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| format!("连接中心服务数据库失败: {e}"))?;
    sqlx::query("PRAGMA journal_mode=WAL")
        .execute(&pool)
        .await
        .map_err(|e| format!("设置中心服务 WAL 失败: {e}"))?;
    sqlx::query(SCHEMA)
        .execute(&pool)
        .await
        .map_err(|e| format!("创建中心服务表失败: {e}"))?;
    if let Err(error) = sqlx::query("ALTER TABLE audit_log ADD COLUMN server_key TEXT")
        .execute(&pool)
        .await
    {
        if !error.to_string().contains("duplicate column name") {
            return Err(format!("迁移中心服务 server_key 列失败: {error}"));
        }
    }
    if let Err(error) = sqlx::query("ALTER TABLE audit_log ADD COLUMN row_identity TEXT")
        .execute(&pool)
        .await
    {
        if !error.to_string().contains("duplicate column name") {
            return Err(format!("迁移中心服务 row_identity 列失败: {error}"));
        }
    }
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS ix_audit_server_db_ts ON audit_log(server_key, database, ts DESC)",
    )
    .execute(&pool)
    .await
    .map_err(|e| format!("创建中心服务 server_key 索引失败: {e}"))?;
    Ok(pool)
}

/// A user row fetched for login/token validation.
#[derive(Clone)]
pub struct UserRow {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub token: String,
}

pub async fn find_user_by_username(
    pool: &SqlitePool,
    username: &str,
) -> Result<Option<UserRow>, String> {
    let row = sqlx::query("SELECT id, username, display_name, token FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询用户失败: {e}"))?;
    Ok(row.map(|r| UserRow {
        id: r.try_get("id").unwrap_or_default(),
        username: r.try_get("username").unwrap_or_default(),
        display_name: r.try_get("display_name").unwrap_or_default(),
        token: r.try_get("token").unwrap_or_default(),
    }))
}

pub async fn find_user_by_token(pool: &SqlitePool, token: &str) -> Result<Option<UserRow>, String> {
    let row = sqlx::query("SELECT id, username, display_name, token FROM users WHERE token = ?")
        .bind(token)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("校验令牌失败: {e}"))?;
    Ok(row.map(|r| UserRow {
        id: r.try_get("id").unwrap_or_default(),
        username: r.try_get("username").unwrap_or_default(),
        display_name: r.try_get("display_name").unwrap_or_default(),
        token: r.try_get("token").unwrap_or_default(),
    }))
}

pub async fn insert_user(
    pool: &SqlitePool,
    id: &str,
    username: &str,
    display_name: &str,
    token: &str,
    created_at: &str,
) -> Result<bool, String> {
    let res = sqlx::query(
        "INSERT INTO users (id, username, display_name, token, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(username)
    .bind(display_name)
    .bind(token)
    .bind(created_at)
    .execute(pool)
    .await
    .map_err(|e| format!("创建用户失败: {e}"))?;
    Ok(res.rows_affected() > 0)
}

pub fn canonical_server_scope(server_key: Option<&str>) -> String {
    match server_key.map(str::trim) {
        Some(value)
            if !value.is_empty() && !value.eq_ignore_ascii_case(LEGACY_PLACEHOLDER_SERVER_KEY) =>
        {
            value.to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

fn parse_audit_ts_ms(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
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
            return Some(naive.and_utc().timestamp_millis());
        }
    }
    None
}

/// Keep only the latest `max_revisions` revisions for a single
/// `(server_scope, database, table_name)` bucket. Adjacent entries by the same
/// user/source/rollback flag within 2.5 seconds count as one revision (matching
/// the desktop change-history timeline), so multi-row imports are pruned whole.
/// Passing `0` disables pruning.
pub async fn prune_table_revisions(
    pool: &SqlitePool,
    server_scope: &str,
    database_lower: &str,
    table_lower: &str,
    max_revisions: usize,
) -> Result<u64, String> {
    if max_revisions == 0 {
        return Ok(0);
    }

    let rows = if server_scope.is_empty() {
        sqlx::query(
            "SELECT rowid, ts, user_id, source, is_rollback \
             FROM audit_log \
             WHERE LOWER(TRIM(database)) = ? \
               AND LOWER(TRIM(table_name)) = ? \
               AND ( \
                   server_key IS NULL \
                   OR TRIM(server_key) = '' \
                   OR LOWER(TRIM(server_key)) = 'mysql://configured:3306' \
               ) \
             ORDER BY ts DESC, rowid DESC",
        )
        .bind(database_lower)
        .bind(table_lower)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query(
            "SELECT rowid, ts, user_id, source, is_rollback \
             FROM audit_log \
             WHERE LOWER(TRIM(database)) = ? \
               AND LOWER(TRIM(table_name)) = ? \
               AND LOWER(TRIM(server_key)) = ? \
             ORDER BY ts DESC, rowid DESC",
        )
        .bind(database_lower)
        .bind(table_lower)
        .bind(server_scope)
        .fetch_all(pool)
        .await
    }
    .map_err(|e| format!("查询待清理审计记录失败: {e}"))?;

    let mut revision_count: usize = 0;
    let mut bucket_len: usize = 0;
    let mut prev: Option<(Option<i64>, String, String, i64)> = None;
    let mut to_delete: Vec<i64> = Vec::new();

    for row in rows {
        let rowid: i64 = row.try_get("rowid").unwrap_or(0);
        let ts_raw: String = row.try_get("ts").unwrap_or_default();
        let ts_ms = parse_audit_ts_ms(&ts_raw);
        let user_id: String = row.try_get("user_id").unwrap_or_default();
        let source: String = row.try_get("source").unwrap_or_default();
        let is_rollback: i64 = row.try_get("is_rollback").unwrap_or(0);

        let joins_current = match (&prev, ts_ms) {
            (Some((Some(prev_ms), prev_user, prev_source, prev_rb)), Some(curr_ms))
                if bucket_len < MAX_ITEMS_PER_REVISION
                    && *prev_user == user_id
                    && *prev_source == source
                    && *prev_rb == is_rollback =>
            {
                (prev_ms - curr_ms).abs() <= REVISION_GROUP_WINDOW_MS
            }
            _ => false,
        };

        if joins_current {
            bucket_len += 1;
        } else {
            revision_count += 1;
            bucket_len = 1;
        }

        prev = Some((ts_ms, user_id, source, is_rollback));

        if revision_count > max_revisions {
            to_delete.push(rowid);
        }
    }

    if to_delete.is_empty() {
        return Ok(0);
    }

    let mut deleted: u64 = 0;
    for chunk in to_delete.chunks(DELETE_CHUNK_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!("DELETE FROM audit_log WHERE rowid IN ({placeholders})");
        let mut query = sqlx::query(&sql);
        for rowid in chunk {
            query = query.bind(rowid);
        }
        let res = query
            .execute(pool)
            .await
            .map_err(|e| format!("清理超限审计记录失败: {e}"))?;
        deleted += res.rows_affected();
    }
    Ok(deleted)
}

/// Trim every `(server_scope, database, table_name)` bucket in the database to
/// at most `max_revisions`. Invoked once at server startup so migrated databases
/// immediately honor the retention cap.
pub async fn prune_all_tables(pool: &SqlitePool, max_revisions: usize) -> Result<u64, String> {
    if max_revisions == 0 {
        return Ok(0);
    }
    let scopes = sqlx::query(
        "SELECT DISTINCT \
             CASE \
                 WHEN server_key IS NULL OR TRIM(server_key) = '' \
                      OR LOWER(TRIM(server_key)) = 'mysql://configured:3306' \
                     THEN '' \
                 ELSE LOWER(TRIM(server_key)) \
             END AS server_scope, \
             LOWER(TRIM(database)) AS db_lower, \
             LOWER(TRIM(table_name)) AS table_lower \
         FROM audit_log",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("枚举待清理审计表失败: {e}"))?;

    let mut total: u64 = 0;
    for row in scopes {
        let scope: String = row.try_get("server_scope").unwrap_or_default();
        let db_lower: String = row.try_get("db_lower").unwrap_or_default();
        let table_lower: String = row.try_get("table_lower").unwrap_or_default();
        total += prune_table_revisions(pool, &scope, &db_lower, &table_lower, max_revisions).await?;
    }
    Ok(total)
}
