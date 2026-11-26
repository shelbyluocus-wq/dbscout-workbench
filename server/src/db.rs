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

/// Tolerance windows for matching an externally observed MySQL change against
/// a Blackcat audit entry or coalescing duplicate workstation observations.
pub const EXACT_AUDIT_MATCH_BEFORE_MS: i64 = 5_000;
pub const EXACT_AUDIT_MATCH_AFTER_MS: i64 = 12_000;
pub const DETECTED_AUDIT_MATCH_BEFORE_MS: i64 = 15_000;
pub const DETECTED_AUDIT_MATCH_AFTER_MS: i64 = 90_000;
pub const EXACT_COALESCE_WINDOW_MS: i64 = 5_000;
pub const DETECTED_COALESCE_WINDOW_MS: i64 = 90_000;

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
CREATE TABLE IF NOT EXISTS mcp_write_receipts (\
    audit_id TEXT PRIMARY KEY,\
    status TEXT NOT NULL\
);\
CREATE TABLE IF NOT EXISTS table_external_changes (\
    event_id TEXT PRIMARY KEY,\
    server_key TEXT,\
    database TEXT NOT NULL,\
    table_name TEXT NOT NULL,\
    ts TEXT NOT NULL,\
    ts_ms INTEGER NOT NULL,\
    time_kind TEXT NOT NULL,\
    signal TEXT NOT NULL,\
    reported_by_user_id TEXT NOT NULL,\
    reported_by_username TEXT NOT NULL,\
    host TEXT,\
    synced_at TEXT NOT NULL\
);\
CREATE INDEX IF NOT EXISTS ix_ext_server_db_table_ts \
    ON table_external_changes(server_key, database, table_name, ts_ms DESC);\
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
    if let Err(error) = sqlx::query("ALTER TABLE audit_log ADD COLUMN svn_username TEXT")
        .execute(&pool)
        .await
    {
        if !error.to_string().contains("duplicate column name") {
            return Err(format!("迁移中心服务 svn_username 列失败: {error}"));
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

pub fn parse_audit_ts_ms(raw: &str) -> Option<i64> {
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
               AND status != 'mcp_pending' \
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
               AND status != 'mcp_pending' \
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

fn normalize_time_kind(raw: &str) -> &'static str {
    if raw.eq_ignore_ascii_case("exact") {
        "exact"
    } else {
        "detected"
    }
}

fn normalize_signal(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "create_time" => "create_time",
        "write_count" => "write_count",
        _ => "update_time",
    }
}

fn server_scope_matches(wanted_scope: &str, row_server_key: Option<&str>) -> bool {
    let row_scope = canonical_server_scope(row_server_key);
    if wanted_scope.is_empty() || row_scope.is_empty() {
        return true;
    }
    wanted_scope == row_scope
}

fn audit_matches_external(audit_ts_ms: i64, ext_ts_ms: i64, time_kind: &str) -> bool {
    if normalize_time_kind(time_kind) == "exact" {
        ext_ts_ms >= audit_ts_ms.saturating_sub(EXACT_AUDIT_MATCH_BEFORE_MS)
            && ext_ts_ms <= audit_ts_ms.saturating_add(EXACT_AUDIT_MATCH_AFTER_MS)
    } else {
        ext_ts_ms >= audit_ts_ms.saturating_sub(DETECTED_AUDIT_MATCH_BEFORE_MS)
            && ext_ts_ms <= audit_ts_ms.saturating_add(DETECTED_AUDIT_MATCH_AFTER_MS)
    }
}

pub async fn has_matching_audit_for_external(
    pool: &SqlitePool,
    server_scope: &str,
    db_lower: &str,
    table_lower: &str,
    ext_ts_ms: i64,
    time_kind: &str,
) -> Result<bool, String> {
    let rows = sqlx::query(
        "SELECT ts, server_key \
         FROM audit_log \
         WHERE status IN ('committed', 'rolled_back') \
           AND LOWER(TRIM(database)) = ? \
           AND LOWER(TRIM(table_name)) = ?",
    )
    .bind(db_lower)
    .bind(table_lower)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询同表审计记录失败: {e}"))?;

    for row in rows {
        let row_key: Option<String> = row.try_get("server_key").ok().flatten();
        if !server_scope_matches(server_scope, row_key.as_deref()) {
            continue;
        }
        let ts_raw: String = row.try_get("ts").unwrap_or_default();
        let Some(audit_ms) = parse_audit_ts_ms(&ts_raw) else {
            continue;
        };
        if audit_matches_external(audit_ms, ext_ts_ms, time_kind) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Remove any suspected external changes that are now explained by a newly
/// arrived Blackcat audit entry for the same table.
pub async fn clear_external_changes_matching_audit(
    pool: &SqlitePool,
    server_scope: &str,
    db_lower: &str,
    table_lower: &str,
    audit_ts_ms: i64,
) -> Result<u64, String> {
    let min_ms = audit_ts_ms.saturating_sub(DETECTED_AUDIT_MATCH_BEFORE_MS);
    let max_ms = audit_ts_ms.saturating_add(DETECTED_AUDIT_MATCH_AFTER_MS);
    let rows = sqlx::query(
        "SELECT event_id, server_key, ts_ms, time_kind \
         FROM table_external_changes \
         WHERE LOWER(TRIM(database)) = ? \
           AND LOWER(TRIM(table_name)) = ? \
           AND ts_ms BETWEEN ? AND ?",
    )
    .bind(db_lower)
    .bind(table_lower)
    .bind(min_ms)
    .bind(max_ms)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询待核销外部变动失败: {e}"))?;

    let mut to_delete = Vec::new();
    for row in rows {
        let row_key: Option<String> = row.try_get("server_key").ok().flatten();
        if !server_scope_matches(server_scope, row_key.as_deref()) {
            continue;
        }
        let ext_ms: i64 = row.try_get("ts_ms").unwrap_or(0);
        let time_kind: String = row.try_get("time_kind").unwrap_or_default();
        if audit_matches_external(audit_ts_ms, ext_ms, &time_kind) {
            let event_id: String = row.try_get("event_id").unwrap_or_default();
            if !event_id.is_empty() {
                to_delete.push(event_id);
            }
        }
    }
    let mut deleted: u64 = 0;
    for chunk in to_delete.chunks(DELETE_CHUNK_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!("DELETE FROM table_external_changes WHERE event_id IN ({placeholders})");
        let mut query = sqlx::query(&sql);
        for id in chunk {
            query = query.bind(id);
        }
        let res = query
            .execute(pool)
            .await
            .map_err(|e| format!("核销误报外部变动失败: {e}"))?;
        deleted += res.rows_affected();
    }
    Ok(deleted)
}

pub struct ExternalChangeInsert<'a> {
    pub event_id: &'a str,
    pub server_key: Option<&'a str>,
    pub database: &'a str,
    pub table_name: &'a str,
    pub ts: &'a str,
    pub ts_ms: i64,
    pub time_kind: &'a str,
    pub signal: &'a str,
    pub reported_by_user_id: &'a str,
    pub reported_by_username: &'a str,
    pub host: Option<&'a str>,
    pub synced_at: &'a str,
}

/// Insert or coalesce one externally observed change. Returns `Ok(true)` when a
/// row was inserted or upgraded, and `Ok(false)` when skipped as a duplicate or
/// already explained by a Blackcat audit entry.
pub async fn upsert_external_change(
    pool: &SqlitePool,
    item: &ExternalChangeInsert<'_>,
) -> Result<bool, String> {
    let event_id = item.event_id.trim();
    let database = item.database.trim();
    let table_name = item.table_name.trim();
    if event_id.is_empty()
        || database.is_empty()
        || table_name.is_empty()
        || table_name.starts_with('(')
        || item.ts_ms <= 0
    {
        return Ok(false);
    }

    let server_scope = canonical_server_scope(item.server_key);
    let stored_server_key = if server_scope.is_empty() {
        None
    } else {
        Some(server_scope.as_str())
    };
    let db_lower = database.to_ascii_lowercase();
    let table_lower = table_name.to_ascii_lowercase();
    let time_kind = normalize_time_kind(item.time_kind);
    let signal = normalize_signal(item.signal);

    // 1. Suppress if a Blackcat audit already explains this timestamp.
    if has_matching_audit_for_external(pool, &server_scope, &db_lower, &table_lower, item.ts_ms, time_kind)
        .await?
    {
        return Ok(false);
    }

    // 2. Idempotent on event_id.
    let existing_same_id: Option<String> =
        sqlx::query_scalar("SELECT event_id FROM table_external_changes WHERE event_id = ?")
            .bind(event_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("检查外部变动幂等键失败: {e}"))?;
    if existing_same_id.is_some() {
        return Ok(false);
    }

    // 3. Coalesce cross-workstation observations of the same external edit.
    let window_min = item.ts_ms.saturating_sub(DETECTED_COALESCE_WINDOW_MS);
    let window_max = item.ts_ms.saturating_add(DETECTED_COALESCE_WINDOW_MS);
    let nearby = sqlx::query(
        "SELECT event_id, server_key, ts_ms, time_kind \
         FROM table_external_changes \
         WHERE LOWER(TRIM(database)) = ? \
           AND LOWER(TRIM(table_name)) = ? \
           AND ts_ms BETWEEN ? AND ? \
         ORDER BY ts_ms ASC",
    )
    .bind(&db_lower)
    .bind(&table_lower)
    .bind(window_min)
    .bind(window_max)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询邻近外部变动失败: {e}"))?;

    let scoped_nearby: Vec<(String, i64, String)> = nearby
        .into_iter()
        .filter_map(|row| {
            let row_key: Option<String> = row.try_get("server_key").ok().flatten();
            if !server_scope_matches(&server_scope, row_key.as_deref()) {
                return None;
            }
            Some((
                row.try_get::<String, _>("event_id").unwrap_or_default(),
                row.try_get::<i64, _>("ts_ms").unwrap_or(0),
                row.try_get::<String, _>("time_kind").unwrap_or_default(),
            ))
        })
        .collect();

    if time_kind == "exact" {
        if scoped_nearby.iter().any(|(_, existing_ms, kind)| {
            normalize_time_kind(kind) == "exact"
                && (*existing_ms - item.ts_ms).abs() <= EXACT_COALESCE_WINDOW_MS
        }) {
            return Ok(false);
        }
        // Upgrade any matching approximate ("detected") row to this exact DB timestamp.
        let upgradeable: Vec<&str> = scoped_nearby
            .iter()
            .filter(|(_, existing_ms, kind)| {
                normalize_time_kind(kind) != "exact"
                    && item.ts_ms <= existing_ms.saturating_add(DETECTED_AUDIT_MATCH_BEFORE_MS)
                    && existing_ms <= &item.ts_ms.saturating_add(DETECTED_COALESCE_WINDOW_MS)
            })
            .map(|(id, _, _)| id.as_str())
            .collect();
        if let Some((first_id, rest)) = upgradeable.split_first() {
            sqlx::query(
                "UPDATE table_external_changes \
                 SET ts = ?, ts_ms = ?, time_kind = 'exact', signal = ?, synced_at = ? \
                 WHERE event_id = ?",
            )
            .bind(item.ts)
            .bind(item.ts_ms)
            .bind(signal)
            .bind(item.synced_at)
            .bind(*first_id)
            .execute(pool)
            .await
            .map_err(|e| format!("升级外部变动时间精度失败: {e}"))?;
            for dup_id in rest {
                let _ = sqlx::query("DELETE FROM table_external_changes WHERE event_id = ?")
                    .bind(*dup_id)
                    .execute(pool)
                    .await;
            }
            return Ok(true);
        }
    } else {
        // Incoming is approximate ("detected"). Skip if an exact row already covers it.
        if scoped_nearby.iter().any(|(_, existing_ms, kind)| {
            normalize_time_kind(kind) == "exact"
                && *existing_ms <= item.ts_ms.saturating_add(DETECTED_AUDIT_MATCH_BEFORE_MS)
                && item.ts_ms <= existing_ms.saturating_add(DETECTED_COALESCE_WINDOW_MS)
        }) {
            return Ok(false);
        }
        // Coalesce with any nearby approximate observation (keep earliest discovery time).
        if let Some((existing_id, existing_ms, _)) = scoped_nearby
            .iter()
            .find(|(_, existing_ms, kind)| {
                normalize_time_kind(kind) != "exact"
                    && (*existing_ms - item.ts_ms).abs() <= DETECTED_COALESCE_WINDOW_MS
            })
        {
            if item.ts_ms < *existing_ms {
                sqlx::query(
                    "UPDATE table_external_changes \
                     SET ts = ?, ts_ms = ?, signal = ?, synced_at = ? \
                     WHERE event_id = ?",
                )
                .bind(item.ts)
                .bind(item.ts_ms)
                .bind(signal)
                .bind(item.synced_at)
                .bind(existing_id)
                .execute(pool)
                .await
                .map_err(|e| format!("更新更早外部发现时间失败: {e}"))?;
                return Ok(true);
            }
            return Ok(false);
        }
    }

    let res = sqlx::query(
        "INSERT OR IGNORE INTO table_external_changes \
         (event_id, server_key, database, table_name, ts, ts_ms, time_kind, signal, \
          reported_by_user_id, reported_by_username, host, synced_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(event_id)
    .bind(stored_server_key)
    .bind(database)
    .bind(table_name)
    .bind(item.ts)
    .bind(item.ts_ms)
    .bind(time_kind)
    .bind(signal)
    .bind(item.reported_by_user_id)
    .bind(item.reported_by_username)
    .bind(item.host)
    .bind(item.synced_at)
    .execute(pool)
    .await
    .map_err(|e| format!("写入外部变动记录失败: {e}"))?;
    Ok(res.rows_affected() > 0)
}

pub async fn prune_table_external_changes(
    pool: &SqlitePool,
    server_scope: &str,
    database_lower: &str,
    table_lower: &str,
    max_per_table: usize,
) -> Result<u64, String> {
    if max_per_table == 0 {
        return Ok(0);
    }
    let rows = if server_scope.is_empty() {
        sqlx::query(
            "SELECT rowid \
             FROM table_external_changes \
             WHERE LOWER(TRIM(database)) = ? \
               AND LOWER(TRIM(table_name)) = ? \
               AND ( \
                   server_key IS NULL \
                   OR TRIM(server_key) = '' \
                   OR LOWER(TRIM(server_key)) = 'mysql://configured:3306' \
               ) \
             ORDER BY ts_ms DESC, rowid DESC",
        )
        .bind(database_lower)
        .bind(table_lower)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query(
            "SELECT rowid \
             FROM table_external_changes \
             WHERE LOWER(TRIM(database)) = ? \
               AND LOWER(TRIM(table_name)) = ? \
               AND LOWER(TRIM(server_key)) = ? \
             ORDER BY ts_ms DESC, rowid DESC",
        )
        .bind(database_lower)
        .bind(table_lower)
        .bind(server_scope)
        .fetch_all(pool)
        .await
    }
    .map_err(|e| format!("查询待清理外部变动失败: {e}"))?;

    if rows.len() <= max_per_table {
        return Ok(0);
    }
    let to_delete: Vec<i64> = rows
        .into_iter()
        .skip(max_per_table)
        .map(|row| row.try_get::<i64, _>("rowid").unwrap_or(0))
        .collect();
    let mut deleted: u64 = 0;
    for chunk in to_delete.chunks(DELETE_CHUNK_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!("DELETE FROM table_external_changes WHERE rowid IN ({placeholders})");
        let mut query = sqlx::query(&sql);
        for rowid in chunk {
            query = query.bind(rowid);
        }
        let res = query
            .execute(pool)
            .await
            .map_err(|e| format!("清理超限外部变动失败: {e}"))?;
        deleted += res.rows_affected();
    }
    Ok(deleted)
}

pub async fn prune_all_external_changes(
    pool: &SqlitePool,
    max_per_table: usize,
) -> Result<u64, String> {
    if max_per_table == 0 {
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
         FROM table_external_changes",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("枚举待清理外部变动表失败: {e}"))?;

    let mut total: u64 = 0;
    for row in scopes {
        let scope: String = row.try_get("server_scope").unwrap_or_default();
        let db_lower: String = row.try_get("db_lower").unwrap_or_default();
        let table_lower: String = row.try_get("table_lower").unwrap_or_default();
        total += prune_table_external_changes(pool, &scope, &db_lower, &table_lower, max_per_table)
            .await?;
    }
    Ok(total)
}
