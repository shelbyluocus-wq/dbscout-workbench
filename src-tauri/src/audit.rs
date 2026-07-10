//! Change-audit layer (层2).
//!
//! Captures before-image + inverse SQL at each write entry point and stores it
//! in a local SQLite database, physically isolated from the target MySQL so a
//! DROP/accidental delete of the target cannot lose the audit trail. Supports
//! locating a specific historical modification and rolling it back; the rollback
//! itself is recorded as a symmetric audit row so it can be rolled back again.
//!
//! Consistency model: pending → committed/aborted. An audit row is written with
//! status='pending' before the MySQL mutation; on success it is marked
//! 'committed', on failure 'aborted'. This guarantees "a successful change
//! always has an audit row" without a 2PC across MySQL and SQLite.

use std::path::{Path, PathBuf};
use std::str::FromStr;

use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, SqlitePool,
};
use tauri::AppHandle;

use crate::db::{build_where, escape_ident};
use crate::types::{AuditLogEntry, ListAuditLogsRequest, RollbackResult};

pub const BACKUP_JOB_EVENT: &str = "backup-job";

/// Where a write originated. Used as the audit `source` column.
pub const SOURCE_GRID: &str = "grid";
pub const SOURCE_AGENT: &str = "agent";
pub const SOURCE_DDL: &str = "ddl";
pub const SOURCE_ROLLBACK: &str = "rollback";

pub const STRATEGY_AUTO: &str = "auto";
pub const STRATEGY_MANUAL: &str = "manual";
pub const STRATEGY_DDL: &str = "ddl";

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_COMMITTED: &str = "committed";
pub const STATUS_ABORTED: &str = "aborted";
pub const STATUS_ROLLED_BACK: &str = "rolled_back";

#[derive(Clone)]
pub struct AuditContext {
    pub connection_id: String,
    pub database: String,
    pub table_name: String,
    pub session_id: Option<String>,
    pub source: &'static str,
    /// Display name of the user who made the change (None when logged out).
    pub actor: Option<String>,
    /// Client-generated UUID; the idempotency key for syncing to the server.
    pub client_id: String,
}

/// Everything needed to write one pending audit row. The inverse fields may be
/// `None` when a reliable inverse cannot be built (e.g. agent SQL we could not
/// parse, or a table without a usable primary key); such rows are flagged
/// `rollback_strategy = manual` and cannot be auto-rolled-back.
pub struct PendingAudit {
    pub operation: &'static str,
    pub column_name: Option<String>,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub row_identity: Option<serde_json::Value>,
    pub forward_sql: String,
    pub forward_binds: Vec<String>,
    pub inverse_sql: Option<String>,
    pub inverse_binds: Vec<String>,
    pub rollback_strategy: &'static str,
    pub notes: Option<String>,
}

/// A full audit row fetched from SQLite, used by the rollback flow.
pub struct AuditEntry {
    pub id: i64,
    pub connection_id: String,
    pub database: String,
    pub table_name: String,
    pub operation: String,
    pub column_name: Option<String>,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub row_identity: Option<serde_json::Value>,
    pub forward_sql: Option<String>,
    pub forward_binds: Vec<String>,
    pub inverse_sql: Option<String>,
    pub inverse_binds: Vec<String>,
    pub rollback_strategy: String,
    pub status: String,
    pub is_rollback: bool,
    pub session_id: Option<String>,
    pub actor: Option<String>,
    pub client_id: Option<String>,
}

fn audit_db_path(app: &AppHandle, config: &crate::types::BackupConfig) -> Result<PathBuf, String> {
    Ok(crate::backup::storage_root(app, config)?.join("audit.sqlite"))
}

/// Lazily create (once) and return the SQLite audit pool. Stored in
/// `AppState.backup.audit_pool` (Mutex<Option<Pool>>) so the pool can be
/// reset when storage_dir changes.
pub async fn ensure_audit_pool(
    app: &AppHandle,
    state: &crate::types::AppState,
) -> Result<SqlitePool, String> {
    {
        let guard = state.backup.audit_pool.lock().await;
        if let Some(pool) = guard.as_ref() {
            return Ok(pool.clone());
        }
    }
    let config = crate::backup::load_config(app);
    let path = audit_db_path(app, &config)?;
    let url = format!(
        "sqlite://{}?mode=rwc",
        path.to_string_lossy().replace('\\', "/")
    );
    let options = SqliteConnectOptions::from_str(&url)
        .map_err(|error| format!("初始化审计库失败: {error}"))?
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| format!("连接审计库失败: {error}"))?;
    sqlx::query("PRAGMA journal_mode=WAL")
        .execute(&pool)
        .await
        .map_err(|error| format!("设置审计库 WAL 失败: {error}"))?;
    ensure_schema(&pool).await?;
    let mut guard = state.backup.audit_pool.lock().await;
    // If another task raced us, reuse theirs and drop ours.
    if let Some(existing) = guard.as_ref() {
        return Ok(existing.clone());
    }
    *guard = Some(pool.clone());
    Ok(pool)
}

/// Drop the cached audit pool so the next `ensure_audit_pool` reconnects at
/// the (possibly new) path. Called after storage_dir changes.
pub async fn reset_audit_pool(state: &crate::types::AppState) {
    let mut guard = state.backup.audit_pool.lock().await;
    if let Some(pool) = guard.take() {
        let _ = pool.close().await;
    }
}

/// Copy audit.sqlite (+ -wal / -shm) from `from_dir` to `to_dir` if the
/// target does not already have one. Used when storage_dir changes so audit
/// history survives the move. Best-effort: WAL files may not exist.
pub fn migrate_audit_db(from_dir: &Path, to_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to_dir).map_err(|error| format!("创建目标目录失败: {error}"))?;
    for suffix in ["audit.sqlite", "audit.sqlite-wal", "audit.sqlite-shm"] {
        let src = from_dir.join(suffix);
        let dst = to_dir.join(suffix);
        if src.exists() && !dst.exists() {
            std::fs::copy(&src, &dst)
                .map_err(|error| format!("迁移审计库 {suffix} 失败: {error}"))?;
        }
    }
    Ok(())
}

async fn ensure_schema(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS audit_log (\
            id INTEGER PRIMARY KEY AUTOINCREMENT,\
            ts TEXT NOT NULL,\
            connection_id TEXT NOT NULL,\
            database TEXT NOT NULL,\
            table_name TEXT NOT NULL,\
            operation TEXT NOT NULL,\
            row_identity TEXT,\
            column_name TEXT,\
            old_value TEXT,\
            new_value TEXT,\
            forward_sql TEXT,\
            forward_binds TEXT,\
            inverse_sql TEXT,\
            inverse_binds TEXT,\
            rollback_strategy TEXT NOT NULL,\
            session_id TEXT,\
            source TEXT NOT NULL,\
            status TEXT NOT NULL,\
            is_rollback INTEGER NOT NULL DEFAULT 0,\
            rollback_of INTEGER,\
            notes TEXT,\
            actor TEXT,\
            client_id TEXT,\
            synced INTEGER NOT NULL DEFAULT 0\
        )",
    )
    .execute(pool)
    .await
    .map_err(|error| format!("创建审计表失败: {error}"))?;

    // Migrate pre-existing databases: add the new columns if absent. SQLite
    // has no ADD COLUMN IF NOT EXISTS, so we attempt the ALTER and ignore the
    // "duplicate column" error. This is the standard single-file migration
    // technique used for the audit store.
    for (col, decl) in [
        ("actor", "actor TEXT"),
        ("client_id", "client_id TEXT"),
        ("synced", "synced INTEGER NOT NULL DEFAULT 0"),
    ] {
        let sql = format!("ALTER TABLE audit_log ADD COLUMN {decl}");
        if let Err(error) = sqlx::query(&sql).execute(pool).await {
            // sqlite error code 1 / "duplicate column name" => already present
            let msg = error.to_string();
            if !msg.contains("duplicate column name") {
                return Err(format!("迁移审计列 {col} 失败: {msg}"));
            }
        }
    }

    for stmt in [
        "CREATE INDEX IF NOT EXISTS ix_audit_conn_db_ts ON audit_log(connection_id, database, ts DESC)",
        "CREATE INDEX IF NOT EXISTS ix_audit_table_ts ON audit_log(connection_id, database, table_name, ts DESC)",
        "CREATE INDEX IF NOT EXISTS ix_audit_rollback_of ON audit_log(rollback_of)",
        "CREATE INDEX IF NOT EXISTS ix_audit_unsynced ON audit_log(synced) WHERE synced = 0",
    ] {
        sqlx::query(stmt)
            .execute(pool)
            .await
            .map_err(|error| format!("创建审计索引失败: {error}"))?;
    }
    Ok(())
}

fn now_ts() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn encode_binds(binds: &[String]) -> String {
    serde_json::to_string(binds).unwrap_or_else(|_| "[]".into())
}

fn decode_binds(value: &Option<String>) -> Vec<String> {
    value
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
        .unwrap_or_default()
}

/// Write a pending audit row and return its id. Call `mark_committed` /
/// `mark_aborted` after the MySQL mutation resolves.
pub async fn record_pending(
    pool: &SqlitePool,
    ctx: &AuditContext,
    pending: &PendingAudit,
) -> Result<i64, String> {
    let ts = now_ts();
    let identity_json = pending
        .row_identity
        .as_ref()
        .map(|value| serde_json::to_string(value).unwrap_or_default());
    let result = sqlx::query(
        "INSERT INTO audit_log \
            (ts, connection_id, database, table_name, operation, row_identity, column_name, \
             old_value, new_value, forward_sql, forward_binds, inverse_sql, inverse_binds, \
             rollback_strategy, session_id, source, status, is_rollback, notes, actor, client_id, synced) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0)",
    )
    .bind(&ts)
    .bind(&ctx.connection_id)
    .bind(&ctx.database)
    .bind(&ctx.table_name)
    .bind(pending.operation)
    .bind(&identity_json)
    .bind(&pending.column_name)
    .bind(&pending.old_value)
    .bind(&pending.new_value)
    .bind(&pending.forward_sql)
    .bind(encode_binds(&pending.forward_binds))
    .bind(&pending.inverse_sql)
    .bind(encode_binds(&pending.inverse_binds))
    .bind(pending.rollback_strategy)
    .bind(&ctx.session_id)
    .bind(ctx.source)
    .bind(STATUS_PENDING)
    .bind(&pending.notes)
    .bind(&ctx.actor)
    .bind(&ctx.client_id)
    .execute(pool)
    .await
    .map_err(|error| format!("写入审计记录失败: {error}"))?;
    Ok(result.last_insert_rowid())
}

async fn mark_status(pool: &SqlitePool, ids: &[i64], status: &str) -> Result<(), String> {
    let mut first_error = None;
    for id in ids {
        if let Err(error) = sqlx::query("UPDATE audit_log SET status = ? WHERE id = ?")
            .bind(status)
            .bind(*id)
            .execute(pool)
            .await
        {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    first_error
        .map(|error| Err(format!("更新审计记录状态失败: {error}")))
        .unwrap_or(Ok(()))
}

pub async fn mark_committed(pool: &SqlitePool, ids: &[i64]) -> Result<(), String> {
    mark_status(pool, ids, STATUS_COMMITTED).await
}

pub async fn mark_aborted(pool: &SqlitePool, ids: &[i64]) -> Result<(), String> {
    mark_status(pool, ids, STATUS_ABORTED).await
}

pub async fn mark_rolled_back(pool: &SqlitePool, id: i64) {
    let _ = sqlx::query("UPDATE audit_log SET status = ? WHERE id = ?")
        .bind(STATUS_ROLLED_BACK)
        .bind(id)
        .execute(pool)
        .await;
}

/// Finalize an insert audit row once the real primary key is known (after the
/// INSERT succeeded and we read `last_insert_id`). Fills in the inverse DELETE
/// and flips status to committed.
pub async fn finalize_insert_audit(
    pool: &SqlitePool,
    id: i64,
    identity: &std::collections::HashMap<String, String>,
    inverse_sql: Option<String>,
    inverse_binds: Vec<String>,
    strategy: &'static str,
) -> Result<(), String> {
    let identity_json = serde_json::to_string(identity).unwrap_or_default();
    let _ = sqlx::query(
        "UPDATE audit_log SET row_identity = ?, inverse_sql = ?, inverse_binds = ?, \
         rollback_strategy = ?, status = ? WHERE id = ?",
    )
    .bind(&identity_json)
    .bind(&inverse_sql)
    .bind(encode_binds(&inverse_binds))
    .bind(strategy)
    .bind(STATUS_COMMITTED)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|error| format!("更新审计记录失败: {error}"))?;
    Ok(())
}

/// Fetch a full audit row by id (for the rollback flow).
pub async fn fetch_audit_entry(pool: &SqlitePool, id: i64) -> Result<AuditEntry, String> {
    let row = sqlx::query("SELECT * FROM audit_log WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|error| format!("读取审计记录失败: {error}"))?
        .ok_or_else(|| format!("审计记录 {id} 不存在"))?;
    let row_identity = row
        .try_get::<Option<String>, _>("row_identity")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    Ok(AuditEntry {
        id: row.try_get("id").unwrap_or(0),
        connection_id: row.try_get("connection_id").unwrap_or_default(),
        database: row.try_get("database").unwrap_or_default(),
        table_name: row.try_get("table_name").unwrap_or_default(),
        operation: row.try_get("operation").unwrap_or_default(),
        column_name: row.try_get("column_name").ok().flatten(),
        old_value: row.try_get("old_value").ok().flatten(),
        new_value: row.try_get("new_value").ok().flatten(),
        row_identity,
        forward_sql: row.try_get("forward_sql").ok().flatten(),
        forward_binds: decode_binds(&row.try_get("forward_binds").ok().flatten()),
        inverse_sql: row.try_get("inverse_sql").ok().flatten(),
        inverse_binds: decode_binds(&row.try_get("inverse_binds").ok().flatten()),
        rollback_strategy: row.try_get("rollback_strategy").unwrap_or_default(),
        status: row.try_get("status").unwrap_or_default(),
        is_rollback: row.try_get::<i64, _>("is_rollback").unwrap_or(0) != 0,
        session_id: row.try_get("session_id").ok().flatten(),
        actor: row.try_get("actor").ok().flatten(),
        client_id: row.try_get("client_id").ok().flatten(),
    })
}

/// Record the symmetric rollback audit row E' for a completed rollback of `original`.
/// E'.inverse_sql = original.forward_sql so the rollback can itself be rolled back.
pub async fn record_rollback(
    pool: &SqlitePool,
    ctx: &AuditContext,
    original: &AuditEntry,
    executed_inverse_sql: &str,
    executed_inverse_binds: &[String],
) -> Result<i64, String> {
    let ts = now_ts();
    let identity_json = original
        .row_identity
        .as_ref()
        .map(|value| serde_json::to_string(value).unwrap_or_default());
    let inverse_op = match original.operation.as_str() {
        "UPDATE" => "UPDATE",
        "INSERT" => "DELETE",
        "DELETE" => "INSERT",
        other => other,
    };
    let result = sqlx::query(
        "INSERT INTO audit_log \
            (ts, connection_id, database, table_name, operation, row_identity, column_name, \
             old_value, new_value, forward_sql, forward_binds, inverse_sql, inverse_binds, \
             rollback_strategy, session_id, source, status, is_rollback, rollback_of, notes, \
             actor, client_id, synced) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0)",
    )
    .bind(&ts)
    .bind(&ctx.connection_id)
    .bind(&ctx.database)
    .bind(&ctx.table_name)
    .bind(inverse_op)
    .bind(&identity_json)
    .bind(&original.column_name)
    .bind(&original.old_value)
    .bind(&original.new_value)
    .bind(executed_inverse_sql)
    .bind(encode_binds(executed_inverse_binds))
    .bind(&original.forward_sql)
    .bind(encode_binds(&original.forward_binds))
    .bind(original.rollback_strategy.as_str())
    .bind(&ctx.session_id)
    .bind(SOURCE_ROLLBACK)
    .bind(STATUS_COMMITTED)
    .bind(original.id)
    .bind::<Option<String>>(None)
    .bind(&ctx.actor)
    .bind(&ctx.client_id)
    .execute(pool)
    .await
    .map_err(|error| format!("写入回滚审计记录失败: {error}"))?;
    Ok(result.last_insert_rowid())
}

pub async fn list_audit_logs(
    pool: &SqlitePool,
    req: &ListAuditLogsRequest,
) -> Result<Vec<AuditLogEntry>, String> {
    let limit = req.limit.unwrap_or(200).min(2000) as i64;
    let offset = req.offset.unwrap_or(0) as i64;
    let mut sql = String::from("SELECT * FROM audit_log WHERE 1=1");
    if req.connection_id.is_some() {
        sql.push_str(" AND connection_id = ?");
    }
    if req.database.is_some() {
        sql.push_str(" AND database = ?");
    }
    if req.table_name.is_some() {
        sql.push_str(" AND table_name = ?");
    }
    if req.from_ts.is_some() {
        sql.push_str(" AND ts >= ?");
    }
    if req.to_ts.is_some() {
        sql.push_str(" AND ts <= ?");
    }
    sql.push_str(" ORDER BY ts DESC LIMIT ? OFFSET ?");

    let mut query = sqlx::query(&sql);
    if let Some(value) = &req.connection_id {
        query = query.bind(value);
    }
    if let Some(value) = &req.database {
        query = query.bind(value);
    }
    if let Some(value) = &req.table_name {
        query = query.bind(value);
    }
    if let Some(value) = &req.from_ts {
        query = query.bind(value);
    }
    if let Some(value) = &req.to_ts {
        query = query.bind(value);
    }
    query = query.bind(limit).bind(offset);

    let rows = query
        .fetch_all(pool)
        .await
        .map_err(|error| format!("查询审计记录失败: {error}"))?;
    let mut entries = Vec::new();
    for row in rows {
        let identity_raw = row
            .try_get::<Option<String>, _>("row_identity")
            .ok()
            .flatten();
        let row_identity = identity_raw.and_then(|raw| serde_json::from_str(&raw).ok());
        entries.push(AuditLogEntry {
            id: row.try_get("id").unwrap_or(0),
            ts: row.try_get("ts").unwrap_or_default(),
            connection_id: row.try_get("connection_id").unwrap_or_default(),
            database: row.try_get("database").unwrap_or_default(),
            table_name: row.try_get("table_name").unwrap_or_default(),
            operation: row.try_get("operation").unwrap_or_default(),
            row_identity,
            column_name: row.try_get("column_name").ok().flatten(),
            old_value: row.try_get("old_value").ok().flatten(),
            new_value: row.try_get("new_value").ok().flatten(),
            forward_sql: row.try_get("forward_sql").ok().flatten(),
            inverse_sql: row.try_get("inverse_sql").ok().flatten(),
            rollback_strategy: row.try_get("rollback_strategy").unwrap_or_default(),
            source: row.try_get("source").unwrap_or_default(),
            status: row.try_get("status").unwrap_or_default(),
            is_rollback: row.try_get::<i64, _>("is_rollback").unwrap_or(0) != 0,
            rollback_of: row.try_get("rollback_of").ok().flatten(),
            notes: row.try_get("notes").ok().flatten(),
            actor: row.try_get("actor").ok().flatten(),
            client_id: row.try_get("client_id").ok().flatten(),
        });
    }
    Ok(entries)
}

pub async fn prune_audit_logs(pool: &SqlitePool, retention_days: u32) -> Result<u64, String> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
    let cutoff_ts = cutoff.to_rfc3339();
    let result = sqlx::query("DELETE FROM audit_log WHERE ts < ? AND is_rollback = 0")
        .bind(&cutoff_ts)
        .execute(pool)
        .await
        .map_err(|error| format!("清理审计记录失败: {error}"))?;
    Ok(result.rows_affected())
}

/// Delete all audit log entries. Used by the "Clear" button in the backup center.
/// Returns the number of deleted rows.
pub async fn clear_audit_logs(pool: &SqlitePool) -> Result<u64, String> {
    let result = sqlx::query("DELETE FROM audit_log")
        .execute(pool)
        .await
        .map_err(|error| format!("清空审计记录失败: {error}"))?;
    Ok(result.rows_affected())
}

// ---- inverse-SQL template builders ----------------------------------------

/// Build the shared UPDATE template + forward/inverse bind sets for a grid cell
/// edit. The template uses an optimistic `AND col = ?` so a rollback detects
/// concurrent modification (affected == 0).
///
/// Returns `(template, forward_binds, inverse_binds)` where forward_binds apply
/// the original change and inverse_binds revert it.
pub fn build_update_inverse(
    table: &str,
    column: &str,
    identity: &std::collections::HashMap<String, String>,
    old_value: &str,
    new_value: Option<&str>,
) -> Result<(String, Vec<String>, String, Vec<String>), String> {
    let (where_sql, identity_values) = build_where(identity)?;
    let table_ident = escape_ident(table);
    let column_ident = escape_ident(column);

    // When the new value is NULL we must emit `SET col = NULL` (no bind) and,
    // crucially, the inverse must locate the just-written NULL row with the
    // null-safe operator `<=>` because `col = NULL` never matches. This keeps
    // audit rollback correct for the NULL case (#5).
    match new_value {
        Some(new_str) => {
            let template = format!(
                "UPDATE `{}` SET `{}` = ? WHERE {} AND `{}` = ? LIMIT 1",
                table_ident, column_ident, where_sql, column_ident
            );
            // forward: SET col = <new> WHERE identity AND col = <old>
            let mut forward_binds = vec![new_str.to_string()];
            forward_binds.extend(identity_values.iter().cloned());
            forward_binds.push(old_value.to_string());
            // inverse: SET col = <old> WHERE identity AND col = <new>
            let mut inverse_binds = vec![old_value.to_string()];
            inverse_binds.extend(identity_values.iter().cloned());
            inverse_binds.push(new_str.to_string());
            Ok((template.clone(), forward_binds, template, inverse_binds))
        }
        None => {
            let forward_sql = format!(
                "UPDATE `{}` SET `{}` = NULL WHERE {} AND `{}` = ? LIMIT 1",
                table_ident, column_ident, where_sql, column_ident
            );
            // forward: SET col = NULL WHERE identity AND col = <old>
            let mut forward_binds = Vec::with_capacity(identity_values.len() + 1);
            forward_binds.extend(identity_values.iter().cloned());
            forward_binds.push(old_value.to_string());

            let inverse_sql = format!(
                "UPDATE `{}` SET `{}` = ? WHERE {} AND `{}` <=> NULL LIMIT 1",
                table_ident, column_ident, where_sql, column_ident
            );
            // inverse: SET col = <old> WHERE identity AND col <=> NULL
            let mut inverse_binds = vec![old_value.to_string()];
            inverse_binds.extend(identity_values.iter().cloned());
            Ok((forward_sql, forward_binds, inverse_sql, inverse_binds))
        }
    }
}

/// Build the inverse DELETE (undo an INSERT) given the row's real identity.
/// Returns `(inverse_sql, inverse_binds)` or `manual` strategy if identity
/// cannot locate the row (no primary key).
pub fn build_insert_inverse(
    table: &str,
    identity: &std::collections::HashMap<String, String>,
) -> Result<(Option<String>, Vec<String>, &'static str), String> {
    if identity.is_empty() {
        return Ok((None, Vec::new(), STRATEGY_MANUAL));
    }
    let (where_sql, identity_values) = build_where(identity)?;
    let sql = format!(
        "DELETE FROM `{}` WHERE {} LIMIT 1",
        escape_ident(table),
        where_sql
    );
    Ok((Some(sql), identity_values, STRATEGY_AUTO))
}

/// Build the inverse INSERT (undo a DELETE) from a full preimage row.
/// `columns` is the ordered list of insertable column names; `preimage` holds
/// their values in the same order.
pub fn build_delete_inverse(
    table: &str,
    columns: &[String],
    preimage: &[String],
) -> (String, Vec<String>) {
    let col_sql = columns
        .iter()
        .map(|column| format!("`{}`", escape_ident(column)))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = columns.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "INSERT INTO `{}` ({}) VALUES ({})",
        escape_ident(table),
        col_sql,
        placeholders
    );
    (sql, preimage.to_vec())
}

/// Build the forward DELETE (the original delete) for the audit record.
pub fn build_delete_forward(
    table: &str,
    identity: &std::collections::HashMap<String, String>,
) -> Result<(String, Vec<String>), String> {
    let (where_sql, identity_values) = build_where(identity)?;
    let sql = format!(
        "DELETE FROM `{}` WHERE {} LIMIT 1",
        escape_ident(table),
        where_sql
    );
    Ok((sql, identity_values))
}

/// Convert a MySQL row (as a column→value map in row order) into an ordered
/// preimage vector matching `columns`.
pub fn preimage_vector(
    columns: &[String],
    row: &std::collections::HashMap<String, String>,
) -> Vec<String> {
    columns
        .iter()
        .map(|column| row.get(column).cloned().unwrap_or_default())
        .collect()
}

/// Build a RollbackResult for a no-op / conflict outcome.
pub fn rollback_conflict(message: impl Into<String>) -> RollbackResult {
    RollbackResult {
        rolled_back: false,
        new_audit_id: None,
        conflict: true,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    async fn status_test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory audit database");
        sqlx::query("CREATE TABLE audit_log (id INTEGER PRIMARY KEY, status TEXT NOT NULL)")
            .execute(&pool)
            .await
            .expect("audit status table");
        sqlx::query("INSERT INTO audit_log (id, status) VALUES (1, 'pending'), (2, 'pending')")
            .execute(&pool)
            .await
            .expect("audit status rows");
        pool
    }

    #[test]
    fn audit_status_updates_report_success_and_persist_every_id() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let pool = status_test_pool().await;

                mark_committed(&pool, &[1, 2])
                    .await
                    .expect("commit status update");
                let committed =
                    sqlx::query_scalar::<_, String>("SELECT status FROM audit_log WHERE id = 1")
                        .fetch_one(&pool)
                        .await
                        .unwrap();
                assert_eq!(committed, STATUS_COMMITTED);

                mark_aborted(&pool, &[1, 2])
                    .await
                    .expect("abort status update");
                let statuses =
                    sqlx::query_scalar::<_, String>("SELECT status FROM audit_log ORDER BY id")
                        .fetch_all(&pool)
                        .await
                        .unwrap();
                assert_eq!(statuses, vec![STATUS_ABORTED, STATUS_ABORTED]);
            });
    }

    #[test]
    fn audit_status_updates_report_sqlite_failures() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let pool = status_test_pool().await;
                pool.close().await;

                assert!(mark_committed(&pool, &[1]).await.is_err());
                assert!(mark_aborted(&pool, &[1]).await.is_err());
            });
    }

    #[test]
    fn build_update_inverse_swaps_old_new() {
        let mut identity = HashMap::new();
        identity.insert("id".into(), "7".into());
        let (forward_sql, forward, inverse_sql, inverse) =
            build_update_inverse("hero", "name", &identity, "old", Some("new")).unwrap();
        assert!(forward_sql
            .contains("UPDATE `hero` SET `name` = ? WHERE `id` <=> ? AND `name` = ? LIMIT 1"));
        assert_eq!(forward, vec!["new", "7", "old"]);
        // Same template doubles as the inverse for the non-NULL case.
        assert_eq!(forward_sql, inverse_sql);
        assert_eq!(inverse, vec!["old", "7", "new"]);
    }

    #[test]
    fn build_update_inverse_emits_set_null_and_null_safe_inverse_for_null() {
        let mut identity = HashMap::new();
        identity.insert("id".into(), "7".into());
        let (forward_sql, forward, inverse_sql, inverse) =
            build_update_inverse("hero", "name", &identity, "old", None).unwrap();
        // forward writes NULL literally, no new-value bind.
        assert!(forward_sql.contains("SET `name` = NULL WHERE `id` <=> ? AND `name` = ? LIMIT 1"));
        assert_eq!(forward, vec!["7", "old"]);
        // inverse restores old and locates the NULL row via the null-safe op.
        assert!(inverse_sql.contains("SET `name` = ? WHERE `id` <=> ? AND `name` <=> NULL LIMIT 1"));
        assert_eq!(inverse, vec!["old", "7"]);
    }

    #[test]
    fn build_insert_inverse_manual_when_no_identity() {
        let identity = HashMap::new();
        let (sql, binds, strategy) = build_insert_inverse("hero", &identity).unwrap();
        assert!(sql.is_none());
        assert!(binds.is_empty());
        assert_eq!(strategy, STRATEGY_MANUAL);
    }

    #[test]
    fn build_delete_inverse_uses_preimage_order() {
        let columns = vec!["id".into(), "name".into()];
        let mut row = HashMap::new();
        row.insert("id".into(), "3".into());
        row.insert("name".into(), "abc".into());
        let preimage = preimage_vector(&columns, &row);
        let (sql, binds) = build_delete_inverse("hero", &columns, &preimage);
        assert!(sql.contains("INSERT INTO `hero` (`id`, `name`) VALUES (?, ?)"));
        assert_eq!(binds, vec!["3", "abc"]);
    }
}
