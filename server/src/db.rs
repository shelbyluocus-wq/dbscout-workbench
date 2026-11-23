//! SQLite storage for the central server: `users` + shared `audit_log`.

use std::str::FromStr;

use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, SqlitePool,
};

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
