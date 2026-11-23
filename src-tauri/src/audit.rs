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

use crate::db::{build_nullable_where, build_where, escape_ident, qualified_table};
use crate::types::{
    AuditLogEntry, CellUpdateChange, ListAuditLogsRequest, RollbackResult, RowIdentity,
};

pub const BACKUP_JOB_EVENT: &str = "backup-job";

/// Where a write originated. Used as the audit `source` column.
pub const SOURCE_GRID: &str = "grid";
pub const SOURCE_IMPORT: &str = "import";
pub const SOURCE_AGENT: &str = "agent";
pub const SOURCE_SQL_CONSOLE: &str = "sql_console";
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
#[derive(Clone, Debug)]
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
#[derive(Debug, serde::Serialize)]
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

pub(crate) async fn ensure_schema(pool: &SqlitePool) -> Result<(), String> {
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
        ("operation_id", "operation_id TEXT"),
        ("operation_size", "operation_size INTEGER"),
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
        "CREATE INDEX IF NOT EXISTS ix_audit_operation ON audit_log(operation_id, id)",
        "CREATE INDEX IF NOT EXISTS ix_audit_table_id ON audit_log(connection_id, database, table_name, id)",
        "CREATE TABLE IF NOT EXISTS audit_restore_jobs (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, database TEXT NOT NULL, table_name TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL, audit_ids TEXT NOT NULL, status TEXT NOT NULL)",
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
    crate::table_modified::ensure_schema(pool).await?;
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
             rollback_strategy, session_id, source, status, is_rollback, notes, actor, client_id, synced, operation_id, operation_size) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, 1)",
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
    .bind(uuid::Uuid::new_v4().to_string())
    .execute(pool)
    .await
    .map_err(|error| format!("写入审计记录失败: {error}"))?;
    Ok(result.last_insert_rowid())
}

/// Batch variant of `record_pending`: writes all pending rows inside ONE SQLite
/// transaction (a single WAL fsync instead of one per row). Returns ids in input order.
pub async fn record_pending_batch(
    pool: &SqlitePool,
    ctx: &AuditContext,
    pendings: &[PendingAudit],
) -> Result<Vec<i64>, String> {
    let ts = now_ts();
    let operation_id = uuid::Uuid::new_v4().to_string();
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("开启审计写入事务失败: {error}"))?;
    let mut ids = Vec::with_capacity(pendings.len());
    for pending in pendings {
        // The server deduplicates individual audit rows, not whole operations.
        let client_id = uuid::Uuid::new_v4().to_string();
        let identity_json = pending
            .row_identity
            .as_ref()
            .map(|value| serde_json::to_string(value).unwrap_or_default());
        let result = sqlx::query(
            "INSERT INTO audit_log \
                (ts, connection_id, database, table_name, operation, row_identity, column_name, \
                 old_value, new_value, forward_sql, forward_binds, inverse_sql, inverse_binds, \
                 rollback_strategy, session_id, source, status, is_rollback, notes, actor, client_id, synced, operation_id, operation_size) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?)",
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
        .bind(&client_id)
        .bind(&operation_id)
        .bind(pendings.len() as i64)
        .execute(&mut *tx)
        .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                tx.rollback().await.ok();
                return Err(format!("写入审计记录失败: {error}"));
            }
        };
        ids.push(result.last_insert_rowid());
    }
    tx.commit()
        .await
        .map_err(|error| format!("提交审计记录失败: {error}"))?;
    Ok(ids)
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

pub async fn mark_committed_required(pool: &SqlitePool, id: i64) -> Result<(), String> {
    mark_status_required(pool, id, STATUS_COMMITTED).await
}

pub async fn mark_aborted_required(pool: &SqlitePool, id: i64) -> Result<(), String> {
    mark_status_required(pool, id, STATUS_ABORTED).await
}

pub async fn mark_committed_required_batch(pool: &SqlitePool, ids: &[i64]) -> Result<(), String> {
    mark_status_required_batch(pool, ids, STATUS_COMMITTED).await
}

pub async fn mark_aborted_required_batch(pool: &SqlitePool, ids: &[i64]) -> Result<(), String> {
    mark_status_required_batch(pool, ids, STATUS_ABORTED).await
}

pub async fn mark_aborted_batch(pool: &SqlitePool, ids: &[i64]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    if mark_aborted_required_batch(pool, ids).await.is_err() {
        // Retain best-effort cleanup of every surviving entry if one bad entry
        // prevents an atomic status update after the database has rolled back.
        return mark_aborted(pool, ids).await;
    }
    Ok(())
}

async fn mark_status_required_batch(
    pool: &SqlitePool,
    ids: &[i64],
    status: &str,
) -> Result<(), String> {
    if let [id] = ids {
        return mark_status_required(pool, *id, status).await;
    }
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("开启审计状态事务失败: {error}"))?;
    for id in ids {
        let result = sqlx::query("UPDATE audit_log SET status = ? WHERE id = ?")
            .bind(status)
            .bind(*id)
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("更新审计状态失败: {error}"))?;
        if result.rows_affected() != 1 {
            tx.rollback().await.ok();
            return Err(format!("审计记录 {id} 不存在，无法更新状态"));
        }
    }
    tx.commit()
        .await
        .map_err(|error| format!("提交审计状态失败: {error}"))
}

async fn mark_status_required(pool: &SqlitePool, id: i64, status: &str) -> Result<(), String> {
    let result = sqlx::query("UPDATE audit_log SET status = ? WHERE id = ?")
        .bind(status)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|error| format!("更新审计状态失败: {error}"))?;
    if result.rows_affected() != 1 {
        return Err(format!("审计记录 {id} 不存在，无法更新状态"));
    }
    Ok(())
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
    let result = sqlx::query(
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
    if result.rows_affected() != 1 {
        return Err(format!("审计记录 {id} 不存在，无法补全回滚信息"));
    }
    Ok(())
}

/// One item for `finalize_insert_audit_batch`.
pub struct FinalizeInsertAuditItem {
    pub id: i64,
    pub identity: std::collections::HashMap<String, String>,
    pub inverse_sql: Option<String>,
    pub inverse_binds: Vec<String>,
    pub strategy: &'static str,
}

/// Batch variant of `finalize_insert_audit`: runs the same UPDATE (including
/// `status = committed`) for many items inside ONE SQLite transaction.
pub async fn finalize_insert_audit_batch(
    pool: &SqlitePool,
    items: &[FinalizeInsertAuditItem],
) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("开启审计补全事务失败: {error}"))?;
    for item in items {
        let identity_json = serde_json::to_string(&item.identity).unwrap_or_default();
        let result = sqlx::query(
            "UPDATE audit_log SET row_identity = ?, inverse_sql = ?, inverse_binds = ?, \
             rollback_strategy = ?, status = ? WHERE id = ?",
        )
        .bind(&identity_json)
        .bind(&item.inverse_sql)
        .bind(encode_binds(&item.inverse_binds))
        .bind(item.strategy)
        .bind(STATUS_COMMITTED)
        .bind(item.id)
        .execute(&mut *tx)
        .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                tx.rollback().await.ok();
                return Err(format!("更新审计记录失败: {error}"));
            }
        };
        if result.rows_affected() != 1 {
            tx.rollback().await.ok();
            return Err(format!("审计记录 {} 不存在，无法补全回滚信息", item.id));
        }
    }
    tx.commit()
        .await
        .map_err(|error| format!("提交审计记录失败: {error}"))
}

/// Fetch a full audit row by id (for the rollback flow).
pub async fn fetch_audit_entry(pool: &SqlitePool, id: i64) -> Result<AuditEntry, String> {
    let row = sqlx::query("SELECT * FROM audit_log WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|error| format!("读取审计记录失败: {error}"))?
        .ok_or_else(|| format!("审计记录 {id} 不存在"))?;
    Ok(audit_entry(&row))
}

pub(crate) fn audit_entry(row: &sqlx::sqlite::SqliteRow) -> AuditEntry {
    let row_identity = row
        .try_get::<Option<String>, _>("row_identity")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    AuditEntry {
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
    }
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
             actor, client_id, synced, operation_id, operation_size) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, 1)",
    )
    .bind(&ts)
    .bind(&ctx.connection_id)
    .bind(&ctx.database)
    .bind(&ctx.table_name)
    .bind(inverse_op)
    .bind(&identity_json)
    .bind(&original.column_name)
    .bind(&original.new_value)
    .bind(&original.old_value)
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
    .bind(uuid::Uuid::new_v4().to_string())
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
    Ok(rows.iter().map(audit_log_entry).collect())
}

pub(crate) fn audit_log_entry(row: &sqlx::sqlite::SqliteRow) -> AuditLogEntry {
    let identity_raw = row
        .try_get::<Option<String>, _>("row_identity")
        .ok()
        .flatten();
    let row_identity = identity_raw.and_then(|raw| serde_json::from_str(&raw).ok());
    AuditLogEntry {
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
    }
}

pub async fn prune_audit_logs(pool: &SqlitePool, retention_days: u32) -> Result<u64, String> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
    let cutoff_ts = cutoff.to_rfc3339();
    let result = sqlx::query("DELETE FROM audit_log WHERE ts < ? AND is_rollback = 0 AND status != 'pending' AND NOT EXISTS (SELECT 1 FROM audit_restore_jobs WHERE status='prepared')")
        .bind(&cutoff_ts)
        .execute(pool)
        .await
        .map_err(|error| format!("清理审计记录失败: {error}"))?;
    Ok(result.rows_affected())
}

/// Delete all audit log entries. Used by the "Clear" button in the backup center.
/// Returns the number of deleted rows.
pub async fn clear_audit_logs(pool: &SqlitePool) -> Result<u64, String> {
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE status='pending'")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if pending > 0 {
        return Err("存在执行中或待核对的操作，暂不能清空日志".into());
    }
    let result = sqlx::query("DELETE FROM audit_log")
        .execute(pool)
        .await
        .map_err(|error| format!("清空审计记录失败: {error}"))?;
    Ok(result.rows_affected())
}

// ---- inverse-SQL template builders ----------------------------------------

/// Build the shared UPDATE template + forward/inverse bind sets for a grid cell
/// edit. The template includes the old value as an optimistic guard so a
/// rollback detects concurrent modification (affected == 0).
///
/// Returns `(template, forward_binds, inverse_binds)` where forward_binds apply
/// the original change and inverse_binds revert it.
#[allow(dead_code)]
pub fn build_update_inverse(
    database: &str,
    table: &str,
    column: &str,
    identity: &RowIdentity,
    old_value: Option<&str>,
    new_value: Option<&str>,
    json_column: bool,
) -> Result<(String, Vec<String>, String, Vec<String>), String> {
    let change = CellUpdateChange {
        column_name: column.to_string(),
        old_value: old_value.map(str::to_string),
        new_value: new_value.map(str::to_string),
    };
    let json_columns = if json_column {
        std::collections::HashSet::from([column.to_string()])
    } else {
        std::collections::HashSet::new()
    };
    build_row_update_inverse(database, table, identity, &[change], &json_columns)
}

pub fn build_row_update_inverse(
    database: &str,
    table: &str,
    identity: &RowIdentity,
    changes: &[CellUpdateChange],
    json_columns: &std::collections::HashSet<String>,
) -> Result<(String, Vec<String>, String, Vec<String>), String> {
    let changes = changes
        .iter()
        .filter(|change| change.old_value != change.new_value)
        .collect::<Vec<_>>();
    if changes.is_empty() {
        return Err("没有需要保存的单元格变更".into());
    }

    let build_statement =
        |row_identity: &RowIdentity, forward: bool| -> Result<(String, Vec<String>), String> {
            let mut set_parts = Vec::with_capacity(changes.len());
            let mut guard_parts = Vec::with_capacity(changes.len());
            let mut set_binds = Vec::new();
            let mut guard_binds = Vec::new();

            for change in &changes {
                let column = escape_ident(&change.column_name);
                let set_value = if forward {
                    change.new_value.as_deref()
                } else {
                    change.old_value.as_deref()
                };
                let guard_value = if forward {
                    change.old_value.as_deref()
                } else {
                    change.new_value.as_deref()
                };
                match set_value {
                    Some(value) => {
                        set_parts.push(format!("`{column}` = ?"));
                        set_binds.push(value.to_string());
                    }
                    None => set_parts.push(format!("`{column}` = NULL")),
                }
                match guard_value {
                    None => guard_parts.push(format!("`{column}` <=> NULL")),
                    Some(value) if json_columns.contains(&change.column_name) => {
                        guard_parts.push(format!("`{column}` = CAST(? AS JSON)"));
                        guard_binds.push(value.to_string());
                    }
                    Some(value) => {
                        guard_parts.push(format!("`{column}` = ?"));
                        guard_binds.push(value.to_string());
                    }
                }
            }

            let (where_sql, identity_binds) = build_nullable_where(row_identity)?;
            let sql = format!(
                "UPDATE {} SET {} WHERE {} AND {} LIMIT 1",
                qualified_table(database, table),
                set_parts.join(", "),
                where_sql,
                guard_parts.join(" AND ")
            );
            set_binds.extend(identity_binds);
            set_binds.extend(guard_binds);
            Ok((sql, set_binds))
        };

    let (forward_sql, forward_binds) = build_statement(identity, true)?;
    let mut inverse_identity = identity.clone();
    for change in &changes {
        if inverse_identity.contains_key(&change.column_name) {
            inverse_identity.insert(change.column_name.clone(), change.new_value.clone());
        }
    }
    let (inverse_sql, inverse_binds) = build_statement(&inverse_identity, false)?;
    Ok((forward_sql, forward_binds, inverse_sql, inverse_binds))
}

/// Build the inverse DELETE (undo an INSERT) given the row's real identity.
/// Returns `(inverse_sql, inverse_binds)` or `manual` strategy if identity
/// cannot locate the row (no primary key).
pub fn build_insert_inverse(
    database: &str,
    table: &str,
    identity: &std::collections::HashMap<String, String>,
) -> Result<(Option<String>, Vec<String>, &'static str), String> {
    if identity.is_empty() {
        return Ok((None, Vec::new(), STRATEGY_MANUAL));
    }
    let (where_sql, identity_values) = build_where(identity)?;
    let sql = format!(
        "DELETE FROM {} WHERE {} LIMIT 1",
        qualified_table(database, table),
        where_sql
    );
    Ok((Some(sql), identity_values, STRATEGY_AUTO))
}

/// Build the inverse INSERT (undo a DELETE) from a full preimage row.
/// `columns` is the ordered list of insertable column names; `preimage` holds
/// their values in the same order.
pub fn build_delete_inverse(
    database: &str,
    table: &str,
    columns: &[String],
    preimage: &[Option<String>],
) -> (String, Vec<String>) {
    let col_sql = columns
        .iter()
        .map(|column| format!("`{}`", escape_ident(column)))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = preimage
        .iter()
        .map(|value| if value.is_some() { "?" } else { "NULL" })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        qualified_table(database, table),
        col_sql,
        placeholders
    );
    let binds = preimage.iter().filter_map(Clone::clone).collect();
    (sql, binds)
}

/// Build the forward DELETE (the original delete) for the audit record.
pub fn build_delete_forward(
    database: &str,
    table: &str,
    identity: &std::collections::HashMap<String, String>,
) -> Result<(String, Vec<String>), String> {
    let (where_sql, identity_values) = build_where(identity)?;
    let sql = format!(
        "DELETE FROM {} WHERE {} LIMIT 1",
        qualified_table(database, table),
        where_sql
    );
    Ok((sql, identity_values))
}

pub fn build_delete_forward_nullable(
    database: &str,
    table: &str,
    identity: &RowIdentity,
) -> Result<(String, Vec<String>), String> {
    let (where_sql, identity_values) = build_nullable_where(identity)?;
    let sql = format!(
        "DELETE FROM {} WHERE {} LIMIT 1",
        qualified_table(database, table),
        where_sql
    );
    Ok((sql, identity_values))
}

/// Convert a MySQL row (as a column→value map in row order) into an ordered
/// preimage vector matching `columns`.
pub fn preimage_vector(
    columns: &[String],
    row: &std::collections::HashMap<String, Option<String>>,
) -> Vec<Option<String>> {
    columns
        .iter()
        .map(|column| row.get(column).cloned().unwrap_or(None))
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
    use sqlx::sqlite::SqlitePoolOptions;
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
        identity.insert("id".into(), Some("7".into()));
        let (forward_sql, forward, inverse_sql, inverse) = build_update_inverse(
            "game-db",
            "hero`archive",
            "name",
            &identity,
            Some("old"),
            Some("new"),
            false,
        )
        .unwrap();
        assert!(forward_sql
            .contains("UPDATE `game-db`.`hero``archive` SET `name` = ? WHERE `id` <=> ? AND `name` = ? LIMIT 1"));
        assert_eq!(forward, vec!["new", "7", "old"]);
        // Same template doubles as the inverse for the non-NULL case.
        assert_eq!(forward_sql, inverse_sql);
        assert_eq!(inverse, vec!["old", "7", "new"]);
    }

    #[test]
    fn build_update_inverse_emits_set_null_and_null_safe_inverse_for_null() {
        let mut identity = HashMap::new();
        identity.insert("id".into(), Some("7".into()));
        let (forward_sql, forward, inverse_sql, inverse) = build_update_inverse(
            "game-db",
            "hero",
            "name",
            &identity,
            Some("old"),
            None,
            false,
        )
        .unwrap();
        // forward writes NULL literally, no new-value bind.
        assert!(forward_sql.contains("SET `name` = NULL WHERE `id` <=> ? AND `name` = ? LIMIT 1"));
        assert_eq!(forward, vec!["7", "old"]);
        // inverse restores old and locates the NULL row via the null-safe op.
        assert!(inverse_sql.contains("SET `name` = ? WHERE `id` <=> ? AND `name` <=> NULL LIMIT 1"));
        assert_eq!(inverse, vec!["old", "7"]);
    }

    #[test]
    fn build_update_inverse_compares_json_guard_as_json() {
        let identity = HashMap::from([("id".into(), Some("7".into()))]);
        let (forward_sql, forward, inverse_sql, inverse) = build_update_inverse(
            "game-db",
            "artifact",
            "cost",
            &identity,
            Some(r#"[{"ID":61095,"Num":1}]"#),
            Some(r#"[{"ID":61095,"Num":12}]"#),
            true,
        )
        .unwrap();

        assert!(forward_sql.contains("`cost` = CAST(? AS JSON) LIMIT 1"));
        assert_eq!(forward_sql, inverse_sql);
        assert_eq!(forward.len(), 3);
        assert_eq!(inverse.len(), 3);
    }

    #[test]
    fn build_update_inverse_updates_null_text_and_restores_null() {
        let identity = HashMap::from([("PosID".into(), Some("12".into()))]);
        let new_value = "function(curLvl) {\n  return curLvl - 1;\n}";
        let (forward_sql, forward, inverse_sql, inverse) = build_update_inverse(
            "edota_15cfg",
            "petgemposprop",
            "EnergyVal",
            &identity,
            None,
            Some(new_value),
            false,
        )
        .unwrap();

        assert!(forward_sql
            .contains("SET `EnergyVal` = ? WHERE `PosID` <=> ? AND `EnergyVal` <=> NULL LIMIT 1"));
        assert_eq!(forward, vec![new_value, "12"]);
        assert!(inverse_sql
            .contains("SET `EnergyVal` = NULL WHERE `PosID` <=> ? AND `EnergyVal` = ? LIMIT 1"));
        assert_eq!(inverse, vec!["12", new_value]);
    }

    #[test]
    fn grouped_update_preserves_nullable_identity_and_uses_the_new_primary_key_for_undo() {
        let identity = HashMap::from([
            ("id".into(), Some("1".into())),
            ("nullable_key".into(), None),
        ]);
        let changes = vec![
            CellUpdateChange {
                column_name: "id".into(),
                old_value: Some("1".into()),
                new_value: Some("2".into()),
            },
            CellUpdateChange {
                column_name: "note".into(),
                old_value: None,
                new_value: Some(String::new()),
            },
        ];

        let (forward_sql, forward, inverse_sql, inverse) = build_row_update_inverse(
            "game-db",
            "hero",
            &identity,
            &changes,
            &std::collections::HashSet::new(),
        )
        .unwrap();

        assert!(forward_sql.contains("SET `id` = ?, `note` = ?"));
        assert!(forward_sql.contains("`id` <=> ? AND `nullable_key` IS NULL"));
        assert!(forward_sql.contains("`id` = ? AND `note` <=> NULL"));
        assert_eq!(forward, vec!["2", "", "1", "1"]);
        assert!(inverse_sql.contains("SET `id` = ?, `note` = NULL"));
        assert!(inverse_sql.contains("`id` <=> ? AND `nullable_key` IS NULL"));
        assert_eq!(inverse, vec!["1", "2", "2", ""]);
    }

    #[test]
    fn build_insert_inverse_manual_when_no_identity() {
        let identity = HashMap::new();
        let (sql, binds, strategy) = build_insert_inverse("game-db", "hero", &identity).unwrap();
        assert!(sql.is_none());
        assert!(binds.is_empty());
        assert_eq!(strategy, STRATEGY_MANUAL);
    }

    #[test]
    fn build_delete_inverse_uses_preimage_order() {
        let columns = vec!["id".into(), "name".into()];
        let mut row = HashMap::new();
        row.insert("id".into(), Some("3".into()));
        row.insert("name".into(), Some("abc".into()));
        let preimage = preimage_vector(&columns, &row);
        let (sql, binds) = build_delete_inverse("game-db", "hero", &columns, &preimage);
        assert!(sql.contains("INSERT INTO `game-db`.`hero` (`id`, `name`) VALUES (?, ?)"));
        assert_eq!(binds, vec!["3", "abc"]);
    }

    #[test]
    fn build_delete_inverse_preserves_null_and_empty_string() {
        let columns = vec!["id".into(), "note".into(), "label".into()];
        let preimage = vec![Some("3".into()), None, Some(String::new())];

        let (sql, binds) = build_delete_inverse("game-db", "hero", &columns, &preimage);

        assert!(sql.contains("VALUES (?, NULL, ?)"));
        assert_eq!(binds, vec!["3", ""]);
    }

    #[test]
    fn finalize_insert_audit_rejects_missing_row() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let pool = SqlitePoolOptions::new()
                    .max_connections(1)
                    .connect("sqlite::memory:")
                    .await
                    .unwrap();
                sqlx::query(
                    "CREATE TABLE audit_log (
                        id INTEGER PRIMARY KEY,
                        row_identity TEXT,
                        inverse_sql TEXT,
                        inverse_binds TEXT,
                        rollback_strategy TEXT,
                        status TEXT
                    )",
                )
                .execute(&pool)
                .await
                .unwrap();

                let identity = HashMap::from([("id".to_string(), "7".to_string())]);
                let error = finalize_insert_audit(
                    &pool,
                    99,
                    &identity,
                    Some("DELETE FROM `hero` WHERE `id` <=> ? LIMIT 1".to_string()),
                    vec!["7".to_string()],
                    STRATEGY_AUTO,
                )
                .await
                .unwrap_err();

                assert!(error.contains("不存在"));
            });
    }

    #[test]
    fn build_delete_forward_qualifies_and_escapes_database_identity() {
        let identity = HashMap::from([("id".to_string(), "3".to_string())]);
        let (sql, binds) = build_delete_forward("game-db", "hero`archive", &identity).unwrap();
        assert_eq!(
            sql,
            "DELETE FROM `game-db`.`hero``archive` WHERE `id` <=> ? LIMIT 1"
        );
        assert_eq!(binds, vec!["3"]);
    }

    async fn full_schema_test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory audit database");
        ensure_schema(&pool).await.expect("audit schema");
        pool
    }

    fn test_audit_context() -> AuditContext {
        AuditContext {
            connection_id: "conn-1".into(),
            database: "game-db".into(),
            table_name: "hero".into(),
            session_id: Some("session-1".into()),
            source: SOURCE_IMPORT,
            actor: Some("tester".into()),
            client_id: "client-1".into(),
        }
    }

    fn test_pending_audit(operation: &'static str, forward_sql: &str) -> PendingAudit {
        PendingAudit {
            operation,
            column_name: None,
            old_value: None,
            new_value: None,
            row_identity: None,
            forward_sql: forward_sql.into(),
            forward_binds: vec!["7".into()],
            inverse_sql: None,
            inverse_binds: Vec::new(),
            rollback_strategy: STRATEGY_AUTO,
            notes: None,
        }
    }

    #[test]
    fn record_pending_batch_writes_every_row_in_input_order() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let pool = full_schema_test_pool().await;
                let ctx = test_audit_context();
                let pendings = vec![
                    test_pending_audit("INSERT", "INSERT INTO `hero` (`id`) VALUES (?)"),
                    test_pending_audit("UPDATE", "UPDATE `hero` SET `name` = ? WHERE `id` = ?"),
                ];

                let ids = record_pending_batch(&pool, &ctx, &pendings)
                    .await
                    .expect("batch pending write");

                assert_eq!(ids.len(), 2);
                assert!(ids[0] < ids[1]);
                let rows =
                    sqlx::query("SELECT operation, status, client_id FROM audit_log ORDER BY id")
                        .fetch_all(&pool)
                        .await
                        .unwrap();
                let operations = rows
                    .iter()
                    .map(|row| row.try_get::<String, _>("operation").unwrap())
                    .collect::<Vec<_>>();
                assert_eq!(operations, vec!["INSERT", "UPDATE"]);
                assert_ne!(
                    rows[0].try_get::<String, _>("client_id").unwrap(),
                    rows[1].try_get::<String, _>("client_id").unwrap(),
                    "each audit row must survive central-server deduplication"
                );
                for row in &rows {
                    assert_eq!(row.try_get::<String, _>("status").unwrap(), STATUS_PENDING);
                }
            });
    }

    #[test]
    fn record_pending_batch_rolls_back_when_an_insert_fails() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let pool = full_schema_test_pool().await;
                sqlx::query("CREATE TRIGGER fail_second_audit BEFORE INSERT ON audit_log WHEN (SELECT COUNT(*) FROM audit_log) > 0 BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END")
                    .execute(&pool)
                    .await
                    .unwrap();
                let ctx = test_audit_context();
                let pendings = vec![
                    test_pending_audit("INSERT", "INSERT INTO `hero` (`id`) VALUES (?)"),
                    test_pending_audit("INSERT", "INSERT INTO `hero` (`id`) VALUES (?)"),
                ];

                let error = record_pending_batch(&pool, &ctx, &pendings)
                    .await
                    .expect_err("second row triggers the injected failure");
                assert!(error.contains("写入审计记录失败"));

                // The whole transaction rolled back: nothing was written.
                let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM audit_log")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                assert_eq!(count, 0);
            });
    }

    #[test]
    fn required_batch_status_changes_are_atomic_and_abortable() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let pool = full_schema_test_pool().await;
                let pendings = vec![
                    test_pending_audit("DELETE", "DELETE FROM hero WHERE id = ?"),
                    test_pending_audit("DELETE", "DELETE FROM hero WHERE id = ?"),
                ];
                let ids = record_pending_batch(&pool, &test_audit_context(), &pendings)
                    .await
                    .unwrap();
                assert!(mark_committed_required_batch(&pool, &[ids[0], 999])
                    .await
                    .is_err());
                assert_eq!(
                    fetch_audit_entry(&pool, ids[0]).await.unwrap().status,
                    STATUS_PENDING
                );
                mark_committed_required_batch(&pool, &ids).await.unwrap();
                for id in &ids {
                    assert_eq!(
                        fetch_audit_entry(&pool, *id).await.unwrap().status,
                        STATUS_COMMITTED
                    );
                }
                mark_aborted_required_batch(&pool, &ids).await.unwrap();
                for id in &ids {
                    assert_eq!(
                        fetch_audit_entry(&pool, *id).await.unwrap().status,
                        STATUS_ABORTED
                    );
                }
                mark_committed_required_batch(&pool, &ids).await.unwrap();
                mark_aborted_batch(&pool, &[ids[0], 999, ids[1]])
                    .await
                    .unwrap();
                for id in &ids {
                    assert_eq!(
                        fetch_audit_entry(&pool, *id).await.unwrap().status,
                        STATUS_ABORTED
                    );
                }
            });
    }

    #[test]
    #[ignore = "local disk benchmark; uses only a temporary SQLite database"]
    fn bulk_delete_audit_disk_benchmark() {
        use sqlx::sqlite::{SqliteJournalMode, SqliteSynchronous};
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let path = std::env::temp_dir().join(format!(
                    "blackcat-audit-bench-{}.sqlite",
                    uuid::Uuid::new_v4()
                ));
                let pool = SqlitePoolOptions::new()
                    .max_connections(1)
                    .connect_with(
                        SqliteConnectOptions::new()
                            .filename(&path)
                            .create_if_missing(true)
                            .journal_mode(SqliteJournalMode::Wal)
                            .synchronous(SqliteSynchronous::Full),
                    )
                    .await
                    .unwrap();
                ensure_schema(&pool).await.unwrap();
                let pendings: Vec<_> = (0..1000)
                    .map(|_| test_pending_audit("DELETE", "DELETE FROM hero WHERE id = ?"))
                    .collect();
                let ctx = test_audit_context();
                let started = std::time::Instant::now();
                let mut ids = Vec::new();
                for pending in &pendings {
                    ids.push(record_pending(&pool, &ctx, pending).await.unwrap());
                }
                for id in &ids {
                    mark_committed_required(&pool, *id).await.unwrap();
                }
                let serial_ms = started.elapsed().as_millis();
                let started = std::time::Instant::now();
                let mut ids = Vec::new();
                for chunk in pendings.chunks(256) {
                    ids.extend(record_pending_batch(&pool, &ctx, chunk).await.unwrap());
                }
                mark_committed_required_batch(&pool, &ids).await.unwrap();
                let batch_ms = started.elapsed().as_millis();
                eprintln!("1000-row audit, WAL/FULL: serial={serial_ms}ms batch={batch_ms}ms");
                pool.close().await;
                std::fs::remove_file(&path).unwrap();
            });
    }

    #[test]
    fn finalize_insert_audit_batch_updates_every_item() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let pool = full_schema_test_pool().await;
                let ctx = test_audit_context();
                let pendings = vec![
                    test_pending_audit("INSERT", "INSERT INTO `hero` (`id`) VALUES (?)"),
                    test_pending_audit("INSERT", "INSERT INTO `hero` (`id`) VALUES (?)"),
                ];
                let ids = record_pending_batch(&pool, &ctx, &pendings).await.unwrap();

                finalize_insert_audit_batch(
                    &pool,
                    &[
                        FinalizeInsertAuditItem {
                            id: ids[0],
                            identity: HashMap::from([("id".to_string(), "7".to_string())]),
                            inverse_sql: Some(
                                "DELETE FROM `hero` WHERE `id` <=> ? LIMIT 1".to_string(),
                            ),
                            inverse_binds: vec!["7".to_string()],
                            strategy: STRATEGY_AUTO,
                        },
                        FinalizeInsertAuditItem {
                            id: ids[1],
                            identity: HashMap::from([("id".to_string(), "8".to_string())]),
                            inverse_sql: None,
                            inverse_binds: Vec::new(),
                            strategy: STRATEGY_MANUAL,
                        },
                    ],
                )
                .await
                .expect("batch finalize");

                let first = fetch_audit_entry(&pool, ids[0]).await.unwrap();
                assert_eq!(first.status, STATUS_COMMITTED);
                assert_eq!(first.row_identity, Some(serde_json::json!({"id": "7"})));
                assert_eq!(
                    first.inverse_sql.as_deref(),
                    Some("DELETE FROM `hero` WHERE `id` <=> ? LIMIT 1")
                );
                assert_eq!(first.inverse_binds, vec!["7"]);
                assert_eq!(first.rollback_strategy, STRATEGY_AUTO);

                let second = fetch_audit_entry(&pool, ids[1]).await.unwrap();
                assert_eq!(second.status, STATUS_COMMITTED);
                assert_eq!(second.row_identity, Some(serde_json::json!({"id": "8"})));
                assert!(second.inverse_sql.is_none());
                assert_eq!(second.rollback_strategy, STRATEGY_MANUAL);
            });
    }

    #[test]
    fn finalize_insert_audit_batch_is_a_noop_for_empty_items() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let pool = full_schema_test_pool().await;
                finalize_insert_audit_batch(&pool, &[])
                    .await
                    .expect("empty finalize is a no-op");
            });
    }

    #[test]
    fn finalize_insert_audit_batch_rolls_back_when_an_id_is_missing() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let pool = full_schema_test_pool().await;
                let ctx = test_audit_context();
                let ids = record_pending_batch(
                    &pool,
                    &ctx,
                    &[test_pending_audit(
                        "INSERT",
                        "INSERT INTO `hero` (`id`) VALUES (?)",
                    )],
                )
                .await
                .unwrap();

                let error = finalize_insert_audit_batch(
                    &pool,
                    &[
                        FinalizeInsertAuditItem {
                            id: ids[0],
                            identity: HashMap::from([("id".to_string(), "7".to_string())]),
                            inverse_sql: Some(
                                "DELETE FROM `hero` WHERE `id` <=> ? LIMIT 1".to_string(),
                            ),
                            inverse_binds: vec!["7".to_string()],
                            strategy: STRATEGY_AUTO,
                        },
                        FinalizeInsertAuditItem {
                            id: 999,
                            identity: HashMap::from([("id".to_string(), "9".to_string())]),
                            inverse_sql: None,
                            inverse_binds: Vec::new(),
                            strategy: STRATEGY_AUTO,
                        },
                    ],
                )
                .await
                .expect_err("missing audit id must fail the batch");
                assert!(error.contains("999"));
                assert!(error.contains("不存在"));

                // The earlier item rolled back with the transaction.
                let entry = fetch_audit_entry(&pool, ids[0]).await.unwrap();
                assert_eq!(entry.status, STATUS_PENDING);
                assert!(entry.row_identity.is_none());
            });
    }
}
