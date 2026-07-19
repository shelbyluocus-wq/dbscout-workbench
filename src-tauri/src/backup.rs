//! Full-database logical snapshot layer (层1) — the safety net behind the
//! change-audit layer. Streams a per-database `.sql` dump (DDL + INSERT rows)
//! using an InnoDB consistent-snapshot read so writes are not blocked, with a
//! grandfather-father-son (GFS) retention policy so monthly history does not
//! exhaust disk. Also implements snapshot restore (with an automatic
//! pre-restore snapshot so a restore can itself be undone).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use sqlx::{MySqlPool, Row};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{connect_database, escape_ident};
use crate::sync::{count_rows, list_base_tables, set_session_lock_wait_limits, show_create_table};
use crate::types::{AppState, BackupConfig, SnapshotInfo};

pub const SNAPSHOT_PROGRESS_EVENT: &str = "snapshot-progress";

const INSERT_BATCH_SIZE: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotManifest {
    pub connection_id: String,
    pub database: String,
    pub ts: String,
    pub tables: Vec<ManifestTable>,
    pub skipped_tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestTable {
    pub name: String,
    pub rows: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    job_id: String,
    connection_id: String,
    database: String,
    done: u64,
    total: u64,
    current_table: Option<String>,
    status: String,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncSnapshotProgress {
    pub done: u64,
    pub total: u64,
    pub current_table: Option<String>,
    pub message: String,
}

/// config.json 永远在这里 —— 不受 storage_dir 影响（安全网：自定义路径
/// 可能失效，但配置必须总能读到）。
pub fn config_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录: {error}"))?;
    let dir = base.join("backup");
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建配置目录失败: {error}"))?;
    Ok(dir)
}

/// 快照 + 审计库的根目录：storage_dir 自定义时用之，否则回退 config_root。
pub fn storage_root(app: &AppHandle, config: &BackupConfig) -> Result<PathBuf, String> {
    match &config.storage_dir {
        Some(dir) if !dir.trim().is_empty() => {
            let path = PathBuf::from(dir);
            std::fs::create_dir_all(&path).map_err(|error| format!("创建存储目录失败: {error}"))?;
            Ok(path)
        }
        _ => config_root(app),
    }
}

/// 默认位置（app_data_dir/backup）下的 snapshots 根，用于合并扫描旧位置。
fn legacy_snapshots_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_root(app)?.join("snapshots"))
}

pub fn resolved_storage_root(app: &AppHandle, config: &BackupConfig) -> Result<PathBuf, String> {
    storage_root(app, config)
}

pub(crate) fn snapshots_root(app: &AppHandle, config: &BackupConfig) -> Result<PathBuf, String> {
    let dir = storage_root(app, config)?.join("snapshots");
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建快照目录失败: {error}"))?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_root(app)?.join("config.json"))
}

pub fn load_config(app: &AppHandle) -> BackupConfig {
    let path = match config_path(app) {
        Ok(path) => path,
        Err(_) => return BackupConfig::default(),
    };
    match std::fs::read_to_string(&path) {
        Ok(content) if !content.trim().is_empty() => {
            serde_json::from_str(&content).unwrap_or_default()
        }
        _ => BackupConfig::default(),
    }
}

pub fn save_config(app: &AppHandle, config: &BackupConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let content =
        serde_json::to_string_pretty(config).map_err(|error| format!("序列化配置失败: {error}"))?;
    std::fs::write(&path, content).map_err(|error| format!("写入配置失败: {error}"))?;
    Ok(())
}

/// Whether the scheduler should snapshot a given database. `"all"` (the legacy
/// value) snapshots every database; `"selected"` snapshots only those listed in
/// `snapshot_enabled_databases`. Manual `create_snapshot` does NOT consult this
/// — it honors an explicit user action regardless of the opt-in list.
pub fn is_snapshot_enabled(config: &BackupConfig, connection_id: &str, database: &str) -> bool {
    if config.databases_scope == "all" {
        return true;
    }
    config
        .snapshot_enabled_databases
        .iter()
        .any(|key| key.connection_id == connection_id && key.database == database)
}

/// System schemas that should never be snapshotted. Mirrors the filter applied
/// by the `list_databases` command so the scheduler does not dump `mysql`,
/// `information_schema`, etc.
pub fn is_system_database(database: &str) -> bool {
    matches!(
        database.trim().to_ascii_lowercase().as_str(),
        "information_schema" | "mysql" | "performance_schema" | "sys"
    )
}

/// Build a fresh snapshot pool (max 1 connection) so long streaming cursors do
/// not steal connections from the runtime pool used by UI writes.
async fn snapshot_pool(mysql_url: &str) -> Result<MySqlPool, String> {
    connect_database(mysql_url, None).await
}

/// Generate one `.sql` snapshot for a single database under a connection.
/// `label` is folded into the filename (e.g. "pre-restore-<ts>").
pub async fn stream_snapshot(
    app: &AppHandle,
    pool: &MySqlPool,
    connection_id: &str,
    database: &str,
    config: &BackupConfig,
    label: Option<&str>,
) -> Result<(PathBuf, SnapshotManifest), String> {
    stream_snapshot_with_progress(app, pool, connection_id, database, config, label, |_| {}).await
}

async fn stream_snapshot_with_progress<F>(
    app: &AppHandle,
    pool: &MySqlPool,
    connection_id: &str,
    database: &str,
    config: &BackupConfig,
    label: Option<&str>,
    mut on_progress: F,
) -> Result<(PathBuf, SnapshotManifest), String>
where
    F: FnMut(SyncSnapshotProgress),
{
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let dir = snapshots_root(app, config)?
        .join(safe_segment(connection_id))
        .join(safe_segment(database));
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建快照目录失败: {error}"))?;
    let stem = match label {
        Some(label) if !label.trim().is_empty() => format!("{ts}-{}", safe_segment(label)),
        _ => ts.clone(),
    };
    let sql_path = dir.join(format!("{stem}.sql"));
    let manifest_path = dir.join(format!("{stem}.manifest.json"));

    on_progress(SyncSnapshotProgress {
        done: 0,
        total: 0,
        current_table: None,
        message: "正在扫描目标库表列表".into(),
    });
    let tables = list_base_tables(pool, database).await?;
    on_progress(SyncSnapshotProgress {
        done: 0,
        total: tables.len() as u64,
        current_table: None,
        message: format!("正在统计 {} 张表的数据量", tables.len()),
    });
    let counts = count_rows(pool, database, &tables).await?;

    let mut file = tokio::fs::File::create(&sql_path)
        .await
        .map_err(|error| format!("创建快照文件失败: {error}"))?;
    use tokio::io::AsyncWriteExt;
    file.write_all(
        format!("-- snapshot connection={connection_id} database={database} ts={ts}\n").as_bytes(),
    )
    .await
    .map_err(|error| format!("写入快照失败: {error}"))?;
    file.write_all(b"SET FOREIGN_KEY_CHECKS=0;\n")
        .await
        .map_err(|error| format!("写入快照失败: {error}"))?;

    let mut manifest = SnapshotManifest {
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        ts: ts.clone(),
        tables: Vec::new(),
        skipped_tables: Vec::new(),
    };

    let mut conn = pool
        .acquire()
        .await
        .map_err(|error| format!("获取连接失败: {error}"))?;
    set_session_lock_wait_limits(&mut conn).await?;

    for (index, table) in tables.iter().enumerate() {
        on_progress(SyncSnapshotProgress {
            done: index as u64,
            total: tables.len() as u64,
            current_table: Some(table.clone()),
            message: format!(
                "正在写入表 {table} 的本地快照（第 {} / {} 张）",
                index + 1,
                tables.len()
            ),
        });
        let row_count = counts.get(table).copied().unwrap_or(0);
        if row_count > config.large_table_threshold {
            file.write_all(
                format!("-- SKIPPED large table `{table}` rows={row_count}\n").as_bytes(),
            )
            .await
            .map_err(|error| format!("写入快照失败: {error}"))?;
            manifest.skipped_tables.push(table.clone());
            on_progress(SyncSnapshotProgress {
                done: (index + 1) as u64,
                total: tables.len() as u64,
                current_table: Some(table.clone()),
                message: format!("已跳过大表 {table}"),
            });
            continue;
        }
        let ddl = show_create_table(&mut conn, database, table).await?;
        file.write_all(format!("DROP TABLE IF EXISTS `{}`;\n", escape_ident(table)).as_bytes())
            .await
            .map_err(|error| format!("写入表 {table} 快照失败: {error}"))?;
        file.write_all(format_dump_statement(&ddl).as_bytes())
            .await
            .map_err(|error| format!("写入表 {table} 快照失败: {error}"))?;

        let columns_with_types = list_columns_with_type(pool, database, table).await?;
        let columns: Vec<String> = columns_with_types
            .iter()
            .map(|(name, _)| name.clone())
            .collect();
        if columns.is_empty() || row_count == 0 {
            manifest.tables.push(ManifestTable {
                name: table.clone(),
                rows: 0,
            });
            on_progress(SyncSnapshotProgress {
                done: (index + 1) as u64,
                total: tables.len() as u64,
                current_table: Some(table.clone()),
                message: format!("已写入表 {table} 的本地快照"),
            });
            continue;
        }

        let col_list = columns
            .iter()
            .map(|column| format!("`{}`", escape_ident(column)))
            .collect::<Vec<_>>()
            .join(", ");
        let select_sql = build_select_sql(database, table, &columns_with_types);
        let rows = sqlx::query(&select_sql)
            .fetch_all(pool)
            .await
            .map_err(|error| format!("读取表 {table} 数据失败: {error}"))?;
        let mut value_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut values = Vec::with_capacity(columns.len());
            for (i, _) in columns.iter().enumerate() {
                values.push(format_row_value(row, i));
            }
            value_rows.push(format!("({})", values.join(", ")));
        }
        let insert_sql = format_insert_batches(table, &col_list, &value_rows);
        file.write_all(insert_sql.as_bytes())
            .await
            .map_err(|error| format!("写入表 {table} 数据快照失败: {error}"))?;
        manifest.tables.push(ManifestTable {
            name: table.clone(),
            rows: value_rows.len() as u64,
        });
        emit_progress(
            app,
            &stem,
            connection_id,
            database,
            (index + 1) as u64,
            tables.len() as u64,
            Some(table.clone()),
            "running",
        );
        on_progress(SyncSnapshotProgress {
            done: (index + 1) as u64,
            total: tables.len() as u64,
            current_table: Some(table.clone()),
            message: format!("已写入表 {table} 的本地快照"),
        });
    }
    file.write_all(b"SET FOREIGN_KEY_CHECKS=1;\n")
        .await
        .map_err(|error| format!("写入快照失败: {error}"))?;
    file.flush()
        .await
        .map_err(|error| format!("刷新快照文件失败: {error}"))?;

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("序列化清单失败: {error}"))?;
    std::fs::write(&manifest_path, manifest_json)
        .map_err(|error| format!("写入清单失败: {error}"))?;

    emit_progress(
        app,
        &stem,
        connection_id,
        database,
        tables.len() as u64,
        tables.len() as u64,
        None,
        "done",
    );
    on_progress(SyncSnapshotProgress {
        done: tables.len() as u64,
        total: tables.len() as u64,
        current_table: None,
        message: "本地安全快照写入完成".into(),
    });
    Ok((sql_path, manifest))
}

/// Execute a snapshot for a connection+database, using a dedicated snapshot pool.
pub async fn create_snapshot(
    app: &AppHandle,
    mysql_url: &str,
    connection_id: &str,
    database: &str,
    config: &BackupConfig,
    label: Option<&str>,
) -> Result<SnapshotInfo, String> {
    let pool = snapshot_pool(mysql_url).await?;
    let result = stream_snapshot(app, &pool, connection_id, database, config, label).await;
    pool.close().await;
    let (sql_path, manifest) = result?;
    snapshot_to_info(
        connection_id,
        database,
        &sql_path,
        Some(manifest),
        "current",
    )
}

/// Create the safety snapshot used by overwrite sync. Unlike scheduled/manual
/// snapshots, protection snapshots must never skip large tables because they
/// are the complete rollback source for a destructive operation.
pub async fn create_sync_protection_snapshot<F>(
    app: &AppHandle,
    mysql_url: &str,
    connection_id: &str,
    database: &str,
    config: &BackupConfig,
    job_id: &str,
    on_progress: F,
) -> Result<SnapshotInfo, String>
where
    F: FnMut(SyncSnapshotProgress),
{
    let protection_config = sync_protection_config(config);
    let pool = snapshot_pool(mysql_url).await?;
    let result = stream_snapshot_with_progress(
        app,
        &pool,
        connection_id,
        database,
        &protection_config,
        Some(&format!("pre-sync-{job_id}")),
        on_progress,
    )
    .await;
    pool.close().await;
    let (sql_path, manifest) = result?;
    snapshot_to_info(
        connection_id,
        database,
        &sql_path,
        Some(manifest),
        "current",
    )
}

fn sync_protection_config(config: &BackupConfig) -> BackupConfig {
    let mut protection_config = config.clone();
    protection_config.large_table_threshold = u64::MAX;
    protection_config
}

async fn list_columns_with_type(
    pool: &MySqlPool,
    database: &str,
    table: &str,
) -> Result<Vec<(String, String)>, String> {
    let rows = sqlx::query(
        "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    )
    .bind(database)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取字段列表失败: {error}"))?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let name = row.try_get::<String, _>("COLUMN_NAME").ok()?;
            let data_type = row.try_get::<String, _>("DATA_TYPE").unwrap_or_default();
            Some((name, data_type.to_ascii_lowercase()))
        })
        .collect())
}

/// Build a SELECT that returns every column as a stable textual form, so the
/// decoder only needs to handle String (for normal columns) and Vec<u8> (for
/// raw binary columns). Non-binary columns are CAST to CHAR — this reliably
/// stringifies integers, decimals, dates, datetimes, enums, json, etc.
fn build_select_sql(
    database: &str,
    table: &str,
    columns_with_types: &[(String, String)],
) -> String {
    let list = columns_with_types
        .iter()
        .map(|(name, data_type)| {
            if is_binary_type(data_type) {
                format!("`{}`", escape_ident(name))
            } else {
                format!(
                    "CAST(`{}` AS CHAR) AS `{}`",
                    escape_ident(name),
                    escape_ident(name)
                )
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT {} FROM `{}`.`{}`",
        list,
        escape_ident(database),
        escape_ident(table)
    )
}

fn is_binary_type(data_type: &str) -> bool {
    matches!(
        data_type,
        "blob" | "tinyblob" | "mediumblob" | "longblob" | "binary" | "varbinary"
    )
}

/// Format one MySQL cell as a SQL literal for snapshot output. After the
/// CAST-to-CHAR SELECT, normal cells decode as String; binary columns decode
/// as Vec<u8>.
fn format_row_value(row: &sqlx::mysql::MySqlRow, index: usize) -> String {
    if let Ok(value) = row.try_get::<Option<String>, _>(index) {
        return match value {
            Some(value) => format_string_literal(&value),
            None => "NULL".into(),
        };
    }
    if let Ok(value) = row.try_get::<Option<Vec<u8>>, _>(index) {
        return match value {
            Some(bytes) => {
                let hex: String = bytes.iter().map(|byte| format!("{byte:02X}")).collect();
                format!("_binary X'{hex}'")
            }
            None => "NULL".into(),
        };
    }
    if let Ok(value) = row.try_get::<Option<i64>, _>(index) {
        return value
            .map(|v| v.to_string())
            .unwrap_or_else(|| "NULL".into());
    }
    if let Ok(value) = row.try_get::<Option<f64>, _>(index) {
        return value
            .map(|v| v.to_string())
            .unwrap_or_else(|| "NULL".into());
    }
    if let Ok(value) = row.try_get::<Option<bool>, _>(index) {
        return value
            .map(|v| if v { "1" } else { "0" }.into())
            .unwrap_or_else(|| "NULL".into());
    }
    "NULL".into()
}

fn format_string_literal(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('\'', "''")
        .replace('\0', "\\0")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\x1a', "\\Z");
    format!("'{escaped}'")
}

fn format_dump_statement(sql: &str) -> String {
    let trimmed = sql.trim_end();
    if trimmed.ends_with(';') {
        format!("{trimmed}\n")
    } else {
        format!("{trimmed};\n")
    }
}

fn format_insert_batches(table: &str, column_list: &str, value_rows: &[String]) -> String {
    value_rows
        .chunks(INSERT_BATCH_SIZE)
        .map(|batch| {
            format!(
                "INSERT INTO `{}` ({column_list}) VALUES\n{};\n",
                escape_ident(table),
                batch.join(",\n")
            )
        })
        .collect()
}

/// Restore a database from a snapshot file. A pre-restore snapshot of the
/// current state is taken first so the restore can be undone.
pub async fn restore_snapshot(
    app: &AppHandle,
    mysql_url: &str,
    connection_id: &str,
    database: &str,
    snapshot_path: &str,
    config: &BackupConfig,
) -> Result<PathBuf, String> {
    // 1. Snapshot current state first (so restore is reversible).
    let pre_label = format!("pre-restore-{}", chrono::Utc::now().format("%Y%m%d-%H%M%S"));
    let (pre_path, _pre_manifest) = stream_snapshot(
        app,
        &connect_database(mysql_url, Some(database)).await?,
        connection_id,
        database,
        config,
        Some(&pre_label),
    )
    .await?;

    // 2. Execute the snapshot SQL on a dedicated pool.
    let pool = connect_database(mysql_url, Some(database)).await?;
    let content = tokio::fs::read_to_string(snapshot_path)
        .await
        .map_err(|error| format!("读取快照文件失败: {error}"))?;
    for statement in split_statements(&content) {
        let trimmed = statement.trim();
        if trimmed.is_empty() || trimmed.starts_with("--") {
            continue;
        }
        sqlx::query(trimmed)
            .execute(&pool)
            .await
            .map_err(|error| format!("还原执行失败: {error}"))?;
    }
    pool.close().await;
    Ok(pre_path)
}

/// Restore an overwrite-sync protection snapshot exactly. All current target
/// tables are removed first so tables created by the failed sync cannot survive
/// the rollback. No pre-restore snapshot is needed: the protection snapshot is
/// itself the immutable pre-sync state.
pub async fn restore_sync_protection_snapshot(
    mysql_url: &str,
    connection_id: &str,
    database: &str,
    snapshot_path: &str,
) -> Result<(), String> {
    let manifest_path = Path::new(snapshot_path).with_extension("manifest.json");
    let manifest_content = tokio::fs::read_to_string(&manifest_path)
        .await
        .map_err(|error| format!("读取同步快照清单失败: {error}"))?;
    let manifest: SnapshotManifest = serde_json::from_str(&manifest_content)
        .map_err(|error| format!("解析同步快照清单失败: {error}"))?;
    if manifest.connection_id != connection_id || manifest.database != database {
        return Err("同步快照与目标连接或数据库不匹配".into());
    }
    if !manifest.skipped_tables.is_empty() {
        return Err(format!(
            "同步快照不完整，缺少表: {}",
            manifest.skipped_tables.join(", ")
        ));
    }

    let content = tokio::fs::read_to_string(snapshot_path)
        .await
        .map_err(|error| format!("读取同步快照文件失败: {error}"))?;
    let pool = connect_database(mysql_url, Some(database)).await?;
    let result = async {
        let mut connection = pool
            .acquire()
            .await
            .map_err(|error| format!("获取恢复连接失败: {error}"))?;
        set_session_lock_wait_limits(&mut connection).await?;
        sqlx::query("SET FOREIGN_KEY_CHECKS=0")
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("关闭外键检查失败: {error}"))?;

        let work_result = async {
            let rows = sqlx::query(
                "SELECT TABLE_NAME FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME DESC",
            )
            .bind(database)
            .fetch_all(&mut *connection)
            .await
            .map_err(|error| format!("读取目标库表列表失败: {error}"))?;
            for row in rows {
                let table = row
                    .try_get::<String, _>("TABLE_NAME")
                    .map_err(|error| format!("读取目标表名失败: {error}"))?;
                let sql = format!("DROP TABLE IF EXISTS `{}`", escape_ident(&table));
                sqlx::query(&sql)
                    .execute(&mut *connection)
                    .await
                    .map_err(|error| format!("清理目标表 {table} 失败: {error}"))?;
            }
            for statement in split_statements(&content) {
                let trimmed = statement.trim();
                if trimmed.is_empty() || trimmed.starts_with("--") {
                    continue;
                }
                sqlx::query(trimmed)
                    .execute(&mut *connection)
                    .await
                    .map_err(|error| format!("同步快照恢复失败: {error}"))?;
            }
            Ok::<(), String>(())
        }
        .await;

        let reenable_result = sqlx::query("SET FOREIGN_KEY_CHECKS=1")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("重新启用外键检查失败: {error}"));
        match (work_result, reenable_result) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Err(error), Err(reenable_error)) => Err(format!("{error}；{reenable_error}")),
        }
    }
    .await;
    pool.close().await;
    result
}

// ---- import / inspect ------------------------------------------------------

/// Parse the self-describing first line of a DB Scout snapshot
/// (`-- snapshot connection=X database=Y ts=Z`). Returns None for files
/// without the header (e.g. plain mysqldump output).
pub fn parse_snapshot_header(chunk: &str) -> Option<(String, String, String)> {
    let first_line = chunk.lines().next()?.trim_end();
    let rest = first_line.strip_prefix("-- snapshot ")?;
    let mut connection = None;
    let mut database = None;
    let mut ts = None;
    for token in rest.split_whitespace() {
        if let Some(value) = token.strip_prefix("connection=") {
            connection = Some(value.to_string());
        } else if let Some(value) = token.strip_prefix("database=") {
            database = Some(value.to_string());
        } else if let Some(value) = token.strip_prefix("ts=") {
            ts = Some(value.to_string());
        }
    }
    match (connection, database) {
        (Some(c), Some(d)) if !c.is_empty() && !d.is_empty() => {
            Some((c, d, ts.unwrap_or_default()))
        }
        _ => None,
    }
}

/// Read the first chunk of a snapshot file and extract its self-describing
/// header plus total size. Rejects non-.sql and empty files early.
pub fn inspect_snapshot_file(
    source_path: &str,
) -> Result<(Option<(String, String, String)>, u64), String> {
    let path = Path::new(source_path);
    let size_bytes = validate_sql_source(path)?;
    let mut file = std::fs::File::open(path).map_err(|error| format!("读取文件失败: {error}"))?;
    use std::io::Read;
    let mut buffer = [0u8; 2048];
    let read = file
        .read(&mut buffer)
        .map_err(|error| format!("读取文件失败: {error}"))?;
    let chunk = String::from_utf8_lossy(&buffer[..read]);
    Ok((parse_snapshot_header(&chunk), size_bytes))
}

fn validate_sql_source(path: &Path) -> Result<u64, String> {
    let is_sql = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("sql"))
        .unwrap_or(false);
    if !is_sql {
        return Err("请选择 .sql 快照文件".into());
    }
    let size_bytes = std::fs::metadata(path)
        .map_err(|error| format!("读取文件失败: {error}"))?
        .len();
    if size_bytes == 0 {
        return Err("文件为空，不是有效的快照".into());
    }
    Ok(size_bytes)
}

/// True when a filename stem starts with the `YYYYMMDD-HHMMSS` snapshot
/// timestamp (optionally followed by a label suffix).
fn is_snapshot_stem(stem: &str) -> bool {
    let mut parts = stem.split('-');
    let date = parts.next().unwrap_or("");
    let time = parts.next().unwrap_or("");
    date.len() == 8
        && time.len() == 6
        && date.chars().all(|c| c.is_ascii_digit())
        && time.chars().all(|c| c.is_ascii_digit())
}

/// Copy an external `.sql` snapshot into `<root>/<connection>/<database>/` so
/// it shows up in the snapshot list and can be restored. The original stem is
/// kept when it already follows the snapshot naming convention; otherwise a
/// fresh `<ts>-imported` stem is used. A companion manifest keeps its table
/// list but is rewritten to the target connection/database.
pub fn import_snapshot_file(
    root: &Path,
    source_path: &str,
    connection_id: &str,
    database: &str,
) -> Result<SnapshotInfo, String> {
    let connection_id = connection_id.trim();
    let database = database.trim();
    if connection_id.is_empty() || database.is_empty() {
        return Err("请选择目标连接和数据库".into());
    }
    let source = Path::new(source_path);
    validate_sql_source(source)?;

    let stem = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| {
            if is_snapshot_stem(stem) {
                stem.to_string()
            } else {
                format!("{}-imported", chrono::Utc::now().format("%Y%m%d-%H%M%S"))
            }
        })
        .ok_or_else(|| "无法读取快照文件名".to_string())?;

    let dir = root
        .join(safe_segment(connection_id))
        .join(safe_segment(database));
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建快照目录失败: {error}"))?;

    // Avoid overwriting an existing snapshot with the same stem.
    let mut target_stem = stem.clone();
    for suffix in 2..100 {
        if !dir.join(format!("{target_stem}.sql")).exists() {
            break;
        }
        target_stem = format!("{stem}-{suffix}");
    }
    let target_sql = dir.join(format!("{target_stem}.sql"));
    std::fs::copy(source, &target_sql).map_err(|error| format!("复制快照文件失败: {error}"))?;

    // Restore reads the target database from the companion manifest, so one
    // must always exist: retarget a source manifest when present, otherwise
    // synthesize a minimal one to keep the imported snapshot restorable.
    let manifest_ts = if is_snapshot_stem(&target_stem) {
        target_stem.chars().take(15).collect::<String>()
    } else {
        chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string()
    };
    let source_manifest = source.with_extension("manifest.json");
    let mut manifest_value = std::fs::read_to_string(&source_manifest)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok());
    if let Some(object) = manifest_value.as_mut().and_then(|v| v.as_object_mut()) {
        object.insert("connectionId".into(), connection_id.into());
        object.insert("database".into(), database.into());
    } else {
        manifest_value = Some(serde_json::json!({
            "connectionId": connection_id,
            "database": database,
            "ts": manifest_ts,
            "tables": [],
            "skippedTables": [],
        }));
    }
    if let Some(value) = manifest_value {
        let serialized = serde_json::to_string_pretty(&value)
            .map_err(|error| format!("生成快照清单失败: {error}"))?;
        std::fs::write(dir.join(format!("{target_stem}.manifest.json")), serialized)
            .map_err(|error| format!("写入快照清单失败: {error}"))?;
    }

    snapshot_to_info(connection_id, database, &target_sql, None, "current")
}

/// Split a dump into individual statements on `;` while respecting single-quoted
/// string literals and `--` line comments.
fn split_statements(content: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let mut prev = '\0';
    for line in content.lines() {
        if !in_string && line.trim_start().starts_with("--") {
            continue;
        }
        if !in_string && starts_legacy_statement_after_create(&current, line) {
            statements.push(std::mem::take(&mut current));
        }
        for ch in line.chars() {
            if in_string {
                current.push(ch);
                if ch == '\'' && prev != '\\' {
                    in_string = false;
                }
                prev = ch;
                continue;
            }
            if ch == '\'' {
                in_string = true;
                current.push(ch);
                prev = ch;
                continue;
            }
            if ch == ';' {
                statements.push(std::mem::take(&mut current));
                prev = ch;
                continue;
            }
            current.push(ch);
            prev = ch;
        }
        current.push('\n');
        prev = '\n';
    }
    if !current.trim().is_empty() {
        statements.push(current);
    }
    statements
}

fn starts_legacy_statement_after_create(current: &str, next_line: &str) -> bool {
    let statement = current.trim_start();
    if !statement.to_ascii_uppercase().starts_with("CREATE TABLE ") {
        return false;
    }
    let next = next_line.trim_start().to_ascii_uppercase();
    matches!(
        next.as_str(),
        line if line.starts_with("INSERT INTO ")
            || line.starts_with("DROP TABLE ")
            || line.starts_with("CREATE TABLE ")
            || line.starts_with("SET ")
    )
}

// ---- listing / GFS pruning -------------------------------------------------

pub fn list_snapshots(
    app: &AppHandle,
    config: &BackupConfig,
    connection_filter: Option<&str>,
    database_filter: Option<&str>,
) -> Result<Vec<SnapshotInfo>, String> {
    let current_root = snapshots_root(app, config)?;
    let mut entries = Vec::new();
    collect_snapshots(
        &current_root,
        connection_filter,
        database_filter,
        "current",
        &mut entries,
    );

    // 当 storage_dir 被自定义且与默认位置不同时，额外扫描旧位置（只读可见）。
    let legacy = legacy_snapshots_root(app)?;
    let custom = config
        .storage_dir
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if custom && legacy != current_root && legacy.exists() {
        collect_snapshots(
            &legacy,
            connection_filter,
            database_filter,
            "legacy",
            &mut entries,
        );
    }

    entries.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(entries)
}

/// 扫描一个 snapshots root 下的 <conn>/<db>/*.sql，追加到 entries。
fn collect_snapshots(
    root: &Path,
    connection_filter: Option<&str>,
    database_filter: Option<&str>,
    location: &str,
    entries: &mut Vec<SnapshotInfo>,
) {
    if !root.exists() {
        return;
    }
    let connections: Vec<PathBuf> = match connection_filter {
        Some(filter) => vec![root.join(safe_segment(filter))],
        None => read_dir_dirs(root),
    };
    for conn_dir in connections {
        let conn_name = match conn_dir.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        if !conn_dir.is_dir() {
            continue;
        }
        let databases: Vec<PathBuf> = match database_filter {
            Some(filter) => vec![conn_dir.join(safe_segment(filter))],
            None => read_dir_dirs(&conn_dir),
        };
        for db_dir in databases {
            let db_name = match db_dir.file_name().and_then(|n| n.to_str()) {
                Some(name) => name.to_string(),
                None => continue,
            };
            if !db_dir.is_dir() {
                continue;
            }
            for sql_path in read_dir_files(&db_dir, "sql") {
                if let Ok(info) = snapshot_to_info(&conn_name, &db_name, &sql_path, None, location)
                {
                    entries.push(info);
                }
            }
        }
    }
}

/// Parse `YYYYMMDD-HHMMSS` (and optional suffix like `-pre-restore-...`) from a snapshot filename stem.
fn parse_snapshot_stem_ts(stem: &str) -> String {
    let mut parts = stem.split('-');
    let date = parts.next().unwrap_or(stem);
    let time = parts.next();
    match time {
        Some(time)
            if date.len() == 8
                && time.len() == 6
                && date.chars().all(|c| c.is_ascii_digit())
                && time.chars().all(|c| c.is_ascii_digit()) =>
        {
            let compact = format!("{date}-{time}");
            chrono::NaiveDateTime::parse_from_str(&compact, "%Y%m%d-%H%M%S")
                .map(|naive| naive.and_utc().to_rfc3339())
                .unwrap_or(compact)
        }
        _ => date.to_string(),
    }
}

fn snapshot_to_info(
    connection_id: &str,
    database: &str,
    sql_path: &Path,
    manifest: Option<SnapshotManifest>,
    location: &str,
) -> Result<SnapshotInfo, String> {
    let size_bytes = std::fs::metadata(sql_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let ts = sql_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(parse_snapshot_stem_ts)
        .unwrap_or_default();
    let manifest_path = sql_path.with_extension("manifest.json");
    let manifest_value = if let Some(manifest) = manifest {
        serde_json::to_value(manifest).ok()
    } else {
        std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
    };
    let table_count = manifest_value
        .as_ref()
        .and_then(|value| value.get("tables"))
        .and_then(|tables| tables.as_array())
        .map(|tables| tables.len() as u32)
        .unwrap_or(0);
    Ok(SnapshotInfo {
        path: sql_path.to_string_lossy().to_string(),
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        ts,
        size_bytes,
        table_count,
        manifest: manifest_value,
        location: location.to_string(),
    })
}

/// GFS-prune snapshots for a connection+database (or all). Buckets:
///   ≤1h: keep all · ≤1d: keep oldest per hour · ≤7d: oldest per day ·
///   ≤30d: oldest per week · >30d or over max_per_db: delete.
pub fn prune_snapshots(
    app: &AppHandle,
    config: &BackupConfig,
    connection_filter: Option<&str>,
    database_filter: Option<&str>,
) -> Result<u64, String> {
    let root = snapshots_root(app, config)?;
    if !root.exists() {
        return Ok(0);
    }
    let mut deleted = 0u64;
    let connections: Vec<PathBuf> = match connection_filter {
        Some(filter) => vec![root.join(safe_segment(filter))],
        None => read_dir_dirs(&root),
    };
    for conn_dir in connections {
        let databases: Vec<PathBuf> = match database_filter {
            Some(filter) => vec![conn_dir.join(safe_segment(filter))],
            None => read_dir_dirs(&conn_dir),
        };
        for db_dir in databases {
            if !db_dir.is_dir() {
                continue;
            }
            deleted += prune_one_database(&db_dir, config.max_per_db);
        }
    }
    Ok(deleted)
}

fn prune_one_database(db_dir: &Path, max_per_db: u32) -> u64 {
    let mut files: Vec<(PathBuf, chrono::DateTime<chrono::Utc>)> = Vec::new();
    for sql_path in read_dir_files(db_dir, "sql") {
        let stem = match sql_path.file_stem().and_then(|s| s.to_str()) {
            Some(stem) => stem,
            None => continue,
        };
        let ts_str = stem.split('-').next().unwrap_or(stem);
        if let Ok(ts) = chrono::NaiveDateTime::parse_from_str(ts_str, "%Y%m%d-%H%M%S") {
            files.push((sql_path, ts.and_utc()));
        }
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    let now = chrono::Utc::now();
    let mut keep = std::collections::HashSet::new();
    let mut hour_bucket: std::collections::HashSet<String> = HashSet::new();
    let mut day_bucket: std::collections::HashSet<String> = HashSet::new();
    let mut week_bucket: std::collections::HashSet<String> = HashSet::new();
    // Iterate oldest-first so the earliest in each bucket is kept.
    for (path, ts) in files.iter().rev() {
        let age = now.signed_duration_since(*ts);
        let age_h = age.num_hours().max(0);
        if age_h <= 1 {
            keep.insert(path.clone());
        } else if age_h <= 24 {
            let key = ts.format("%Y-%m-%d %H").to_string();
            if hour_bucket.insert(key) {
                keep.insert(path.clone());
            }
        } else if age_h <= 24 * 7 {
            let key = ts.format("%Y-%m-%d").to_string();
            if day_bucket.insert(key) {
                keep.insert(path.clone());
            }
        } else if age_h <= 24 * 30 {
            let key = ts.format("%Y-%W").to_string();
            if week_bucket.insert(key) {
                keep.insert(path.clone());
            }
        }
    }
    // Enforce max_per_db: keep newest N among kept.
    let mut kept_sorted: Vec<(PathBuf, chrono::DateTime<chrono::Utc>)> = files
        .iter()
        .filter(|(p, _)| keep.contains(p))
        .cloned()
        .collect();
    kept_sorted.sort_by(|a, b| b.1.cmp(&a.1));
    let max = max_per_db as usize;
    for (path, _) in kept_sorted.iter().skip(max) {
        keep.remove(path);
    }

    let mut deleted = 0u64;
    for (path, _) in &files {
        if !keep.contains(path) {
            let _ = std::fs::remove_file(path);
            let manifest = path.with_extension("manifest.json");
            let _ = std::fs::remove_file(manifest);
            deleted += 1;
        }
    }
    deleted
}

/// Delete a single snapshot (.sql + .manifest.json). Validates the path is
/// inside either the current snapshots root or the legacy default root, to
/// prevent deleting arbitrary files.
pub fn delete_snapshot(
    app: &AppHandle,
    config: &BackupConfig,
    snapshot_path: &str,
) -> Result<(), String> {
    let path = std::path::Path::new(snapshot_path)
        .canonicalize()
        .map_err(|error| format!("快照路径无效: {error}"))?;
    let current_root = snapshots_root(app, config)?
        .canonicalize()
        .map_err(|error| format!("解析快照目录失败: {error}"))?;
    let legacy_root = legacy_snapshots_root(app)?
        .canonicalize()
        .unwrap_or_else(|_| current_root.clone());
    let inside_current = path.strip_prefix(&current_root).is_ok();
    let inside_legacy = path.strip_prefix(&legacy_root).is_ok();
    if !inside_current && !inside_legacy {
        return Err("路径不在允许的快照目录内".into());
    }
    std::fs::remove_file(&path).map_err(|error| format!("删除快照失败: {error}"))?;
    let manifest = path.with_extension("manifest.json");
    let _ = std::fs::remove_file(&manifest);
    Ok(())
}

pub fn open_backup_path(app: &AppHandle, config: &BackupConfig, path: &str) -> Result<(), String> {
    let current_root = storage_root(app, config)?;
    let legacy_root = legacy_snapshots_root(app)?;
    let target = resolve_open_backup_target(Path::new(path), &[current_root, legacy_root])?;
    open_directory(&target)
}

// ---- scheduler -------------------------------------------------------------

pub mod scheduler {
    use super::*;
    use std::future::Future;

    /// Background loop: every `interval_minutes`, snapshot every live MySQL
    /// connection's databases, then prune. Runs for the lifetime of the app.
    pub async fn run(app: AppHandle) {
        loop {
            let config = load_config(&app);
            let interval = config.interval_minutes.max(1);
            tokio::time::sleep(std::time::Duration::from_secs(interval * 60)).await;
            if !config.enabled {
                continue;
            }
            if let Err(error) = tick(&app, &config).await {
                eprintln!("[backup] scheduler tick failed: {error}");
            }
        }
    }

    async fn tick(app: &AppHandle, config: &BackupConfig) -> Result<(), String> {
        let connections = collect_connections(app, config).await;
        for (connection_id, mysql_url, databases) in connections {
            for database in databases {
                // Skip system schemas (mysql, information_schema, ...) and any
                // database the user has not opted in to (selected-scope whitelist).
                if is_system_database(&database)
                    || !is_snapshot_enabled(config, &connection_id, &database)
                {
                    continue;
                }
                let _ = run_one(app, &connection_id, &mysql_url, &database, config, None).await;
            }
        }
        prune_snapshots(app, config, None, None)?;
        Ok(())
    }

    pub async fn run_one(
        app: &AppHandle,
        connection_id: &str,
        mysql_url: &str,
        database: &str,
        config: &BackupConfig,
        label: Option<&str>,
    ) -> Result<SnapshotInfo, String> {
        let guard_key = format!("{connection_id}/{database}");
        {
            let state = app.state::<AppState>();
            let mut jobs = state.backup.snapshot_jobs.lock().await;
            if jobs.contains_key(&guard_key) {
                return Err("快照任务进行中".into());
            }
            jobs.insert(guard_key.clone(), ());
        }
        let state = app.state::<AppState>();
        let result = create_snapshot(app, mysql_url, connection_id, database, config, label).await;
        {
            let mut jobs = state.backup.snapshot_jobs.lock().await;
            jobs.remove(&guard_key);
        }
        result
    }

    fn collect_connection_configs(
        runtime: &crate::types::RuntimeState,
        config: &BackupConfig,
    ) -> Vec<(String, String)> {
        runtime
            .connections
            .iter()
            .filter(|(connection_id, connection)| {
                connection.mysql_url.is_some()
                    && (config.databases_scope == "all"
                        || config
                            .snapshot_enabled_databases
                            .iter()
                            .any(|key| key.connection_id.as_str() == connection_id.as_str()))
            })
            .filter_map(|(connection_id, connection)| {
                connection
                    .mysql_url
                    .as_ref()
                    .map(|mysql_url| (connection_id.clone(), mysql_url.clone()))
            })
            .collect()
    }

    pub(super) async fn collect_connections_with<L, Fut>(
        runtime: &tokio::sync::Mutex<crate::types::RuntimeState>,
        config: &BackupConfig,
        mut list_databases: L,
    ) -> Vec<(String, String, Vec<String>)>
    where
        L: FnMut(String) -> Fut,
        Fut: Future<Output = Result<Vec<String>, String>>,
    {
        let connection_configs = {
            let runtime = runtime.lock().await;
            collect_connection_configs(&runtime, config)
        };
        let mut connections = Vec::with_capacity(connection_configs.len());
        for (connection_id, mysql_url) in connection_configs {
            let databases = list_databases(mysql_url.clone()).await.unwrap_or_default();
            connections.push((connection_id, mysql_url, databases));
        }
        connections
    }

    async fn collect_connections(
        app: &AppHandle,
        config: &BackupConfig,
    ) -> Vec<(String, String, Vec<String>)> {
        let state = app.state::<AppState>();
        collect_connections_with(&state.runtime, config, |mysql_url| async move {
            list_databases_for_url(&mysql_url).await
        })
        .await
    }

    async fn list_databases_for_url(mysql_url: &str) -> Result<Vec<String>, String> {
        let pool = connect_database(mysql_url, None).await?;
        let rows =
            sqlx::query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")
                .fetch_all(&pool)
                .await
                .map_err(|error| format!("list databases failed: {error}"))?;
        let databases = rows
            .into_iter()
            .filter_map(|row| row.try_get::<String, _>("SCHEMA_NAME").ok())
            .collect::<Vec<_>>();
        pool.close().await;
        Ok(databases)
    }
}

// ---- helpers ---------------------------------------------------------------

fn safe_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn resolve_open_backup_target(path: &Path, allowed_roots: &[PathBuf]) -> Result<PathBuf, String> {
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("备份路径无效: {error}"))?;
    let inside_allowed = allowed_roots
        .iter()
        .any(|root| is_inside_backup_root(&canonical_path, root));
    if !inside_allowed {
        return Err("路径不在允许的备份目录内".into());
    }
    if canonical_path.is_dir() {
        return Ok(canonical_path);
    }
    canonical_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法解析备份文件所在目录".into())
}

fn is_inside_backup_root(canonical_path: &Path, root: &Path) -> bool {
    #[cfg(not(target_os = "windows"))]
    {
        return root
            .canonicalize()
            .map(|canonical_root| canonical_path.starts_with(canonical_root))
            .unwrap_or(false);
    }

    #[cfg(target_os = "windows")]
    {
        // Windows paths are case-insensitive and canonicalization may add a
        // verbatim (`\\?\`) prefix, so compare normalized components there.
        let path_norm = match normalize_backup_path(canonical_path) {
            Some(p) => p,
            None => return false,
        };
        let root_norm = match normalize_backup_path(root) {
            Some(r) => r,
            None => return false,
        };
        path_norm == root_norm || path_norm.starts_with(&format!("{root_norm}\\"))
    }
}

#[cfg(target_os = "windows")]
fn normalize_backup_path(path: &Path) -> Option<String> {
    let canonical = path.canonicalize().ok()?;
    let s = canonical.to_string_lossy();
    Some(
        s.strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .or_else(|| s.strip_prefix(r"\\?\").map(|rest| rest.to_string()))
            .unwrap_or_else(|| s.into_owned())
            .to_lowercase(),
    )
}

fn open_directory(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        Command::new("explorer.exe")
            .arg(explorer_directory_arg(path))
            .spawn()
            .map_err(|error| format!("打开资源管理器失败: {error}"))?;
        Ok(())
    } else if cfg!(target_os = "macos") {
        open_directory_with_status("open", path)
    } else {
        open_directory_with_status("xdg-open", path)
    }
}

fn open_directory_with_status(program: &str, path: &Path) -> Result<(), String> {
    let status = Command::new(program)
        .arg(path)
        .status()
        .map_err(|error| format!("打开资源管理器失败: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("打开资源管理器失败: {status}"))
    }
}

fn explorer_directory_arg(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        value.into_owned()
    }
}

fn read_dir_dirs(path: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default()
}

fn read_dir_files(path: &Path, extension: &str) -> Vec<PathBuf> {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry
                        .path()
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| ext == extension)
                        .unwrap_or(false)
                })
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default()
}

fn emit_progress(
    app: &AppHandle,
    job_id: &str,
    connection_id: &str,
    database: &str,
    done: u64,
    total: u64,
    current_table: Option<String>,
    status: &str,
) {
    let message = match current_table.as_deref() {
        Some(table) if !table.is_empty() => format!("正在快照 {table}"),
        _ => format!("已处理 {done}/{total} 张表"),
    };
    let payload = ProgressPayload {
        job_id: job_id.into(),
        connection_id: connection_id.into(),
        database: database.into(),
        done,
        total,
        current_table,
        status: status.into(),
        message,
    };
    let _ = app.emit(SNAPSHOT_PROGRESS_EVENT, payload);
}

// Used by prune_one_database; re-exported here to keep the module self-contained.
use std::collections::HashSet;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        DatabaseKind, RuntimeConnection, RuntimeOptions, RuntimeState, SnapshotDatabaseKey,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::Mutex;

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test runtime")
    }

    fn scheduler_runtime() -> RuntimeState {
        let mut runtime = RuntimeState::new(None, RuntimeOptions::for_environment(false, None));
        runtime.connections.insert(
            "mysql-1".into(),
            RuntimeConnection {
                id: "mysql-1".into(),
                kind: DatabaseKind::MySql,
                label: "MySQL 1".into(),
                host: "127.0.0.1".into(),
                port: 3306,
                username: "root".into(),
                mysql_url: Some("mysql://root@127.0.0.1:3306".into()),
                clickhouse_url: None,
                database: None,
            },
        );
        runtime
    }

    #[test]
    fn split_statements_respects_strings_and_comments() {
        let content = "SET FOREIGN_KEY_CHECKS=0;\n-- a comment; with semicolon\nINSERT INTO `t` VALUES ('a;b', 'c');\nSET FOREIGN_KEY_CHECKS=1;";
        let stmts = split_statements(content);
        // Comment-only chunks are skipped by the caller; just verify count of non-empty.
        let non_empty: Vec<&String> = stmts.iter().filter(|s| !s.trim().is_empty()).collect();
        assert!(non_empty.len() >= 3);
    }

    #[test]
    fn sync_protection_snapshot_never_skips_large_tables() {
        let mut config = BackupConfig::default();
        config.large_table_threshold = 10;

        let protection = sync_protection_config(&config);

        assert_eq!(protection.large_table_threshold, u64::MAX);
        assert_eq!(config.large_table_threshold, 10);
    }

    #[test]
    fn split_statements_recovers_legacy_create_table_without_semicolon() {
        let content = "-- snapshot connection=mysql-1 database=game ts=20260625-103000\n\
SET FOREIGN_KEY_CHECKS=0;\n\
DROP TABLE IF EXISTS `achievementprop`;\n\
CREATE TABLE `achievementprop` (\n\
  `ID` int NOT NULL,\n\
  `Dsc` varchar(255) DEFAULT NULL,\n\
  PRIMARY KEY (`ID`)\n\
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4\n\
INSERT INTO `achievementprop` (`ID`, `Dsc`, `CondType`, `P1`, `P2`, `P3`) VALUES\n\
('1', 'clear stage', '1', '?1', '?2', '?3');\n\
SET FOREIGN_KEY_CHECKS=1;";

        let stmts = split_statements(content);

        assert_eq!(stmts.len(), 5);
        assert_eq!(stmts[0].trim(), "SET FOREIGN_KEY_CHECKS=0");
        assert_eq!(stmts[1].trim(), "DROP TABLE IF EXISTS `achievementprop`");
        assert!(stmts[2]
            .trim_start()
            .starts_with("CREATE TABLE `achievementprop`"));
        assert!(!stmts[2].contains("INSERT INTO"));
        assert!(stmts[3]
            .trim_start()
            .starts_with("INSERT INTO `achievementprop`"));
        assert_eq!(stmts[4].trim(), "SET FOREIGN_KEY_CHECKS=1");
    }

    #[test]
    fn format_dump_statement_adds_missing_semicolon() {
        let sql = "CREATE TABLE `achievementprop` (\n  `ID` int NOT NULL\n) ENGINE=InnoDB";

        assert_eq!(
            format_dump_statement(sql),
            "CREATE TABLE `achievementprop` (\n  `ID` int NOT NULL\n) ENGINE=InnoDB;\n"
        );
    }

    #[test]
    fn insert_batches_repeat_the_statement_header_after_each_batch() {
        let values = (0..=INSERT_BATCH_SIZE)
            .map(|index| format!("({index})"))
            .collect::<Vec<_>>();

        let sql = format_insert_batches("players", "`id`", &values);

        assert_eq!(
            sql.matches("INSERT INTO `players` (`id`) VALUES").count(),
            2
        );
        assert!(sql.contains(&format!("({});\nINSERT INTO", INSERT_BATCH_SIZE - 1)));
        assert!(sql.ends_with(&format!("({INSERT_BATCH_SIZE});\n")));
    }

    #[test]
    fn is_snapshot_enabled_all_scope_snapshots_everything() {
        let mut config = BackupConfig::default();
        config.databases_scope = "all".into();
        config.snapshot_enabled_databases = Vec::new();
        // Even with an empty whitelist, "all" enables every database.
        assert!(is_snapshot_enabled(&config, "conn1", "game_db"));
        assert!(is_snapshot_enabled(&config, "conn2", "anything"));
    }

    #[test]
    fn is_snapshot_enabled_selected_scope_respects_whitelist() {
        let mut config = BackupConfig::default();
        config.databases_scope = "selected".into();
        config.snapshot_enabled_databases = vec![SnapshotDatabaseKey {
            connection_id: "conn1".into(),
            database: "game_db".into(),
        }];
        assert!(is_snapshot_enabled(&config, "conn1", "game_db"));
        // Same database on a different connection is NOT enabled.
        assert!(!is_snapshot_enabled(&config, "conn2", "game_db"));
        // Different database on the enabled connection is NOT enabled.
        assert!(!is_snapshot_enabled(&config, "conn1", "other_db"));
    }

    #[test]
    fn is_snapshot_enabled_selected_empty_whitelist_disables_all() {
        let mut config = BackupConfig::default();
        config.databases_scope = "selected".into();
        config.snapshot_enabled_databases = Vec::new();
        // Default install state: nothing is snapshotted until the user opts in.
        assert!(!is_snapshot_enabled(&config, "conn1", "game_db"));
    }

    #[test]
    fn scheduler_releases_runtime_lock_before_listing_databases() {
        test_runtime().block_on(async {
            let runtime = Arc::new(Mutex::new(scheduler_runtime()));
            let mut config = BackupConfig::default();
            config.databases_scope = "all".into();
            let started = Arc::new(tokio::sync::Notify::new());
            let release = Arc::new(tokio::sync::Notify::new());
            let task_runtime = runtime.clone();
            let task_started = started.clone();
            let task_release = release.clone();
            let task = tokio::spawn(async move {
                scheduler::collect_connections_with(task_runtime.as_ref(), &config, move |_| {
                    let started = task_started.clone();
                    let release = task_release.clone();
                    async move {
                        started.notify_one();
                        release.notified().await;
                        Ok(vec!["game_db".into()])
                    }
                })
                .await
            });

            started.notified().await;
            let foreground_guard =
                tokio::time::timeout(std::time::Duration::from_millis(100), runtime.lock())
                    .await
                    .expect("foreground runtime access must not wait for database IO");
            drop(foreground_guard);
            release.notify_one();

            assert_eq!(task.await.expect("collection task").len(), 1);
        });
    }

    #[test]
    fn scheduler_skips_database_listing_for_an_empty_selected_whitelist() {
        test_runtime().block_on(async {
            let runtime = Mutex::new(scheduler_runtime());
            let mut config = BackupConfig::default();
            config.databases_scope = "selected".into();
            config.snapshot_enabled_databases.clear();
            let calls = Arc::new(AtomicUsize::new(0));
            let observed_calls = calls.clone();

            let connections = scheduler::collect_connections_with(&runtime, &config, move |_| {
                observed_calls.fetch_add(1, Ordering::SeqCst);
                async { Ok(vec!["game_db".into()]) }
            })
            .await;

            assert!(connections.is_empty());
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn is_system_database_recognizes_mysql_schemas() {
        assert!(is_system_database("mysql"));
        assert!(is_system_database("Information_Schema"));
        assert!(is_system_database("performance_schema"));
        assert!(is_system_database("sys"));
        assert!(!is_system_database("game_db"));
        // Leading/trailing whitespace is trimmed before matching.
        assert!(is_system_database("  sys  "));
    }

    #[test]
    fn format_string_literal_escapes_quotes() {
        assert_eq!(format_string_literal("a'b"), "'a''b'");
        assert_eq!(format_string_literal("a\\b"), "'a\\\\b'");
    }

    #[test]
    fn safe_segment_replaces_unsafe() {
        assert_eq!(safe_segment("mysql-env"), "mysql-env");
        assert_eq!(safe_segment("a/b"), "a_b");
    }

    #[test]
    fn parse_snapshot_stem_ts_reads_date_and_time() {
        assert_eq!(
            parse_snapshot_stem_ts("20260621-143052"),
            "2026-06-21T14:30:52+00:00"
        );
        assert_eq!(
            parse_snapshot_stem_ts("20260621-143052-pre-restore-20260621-150000"),
            "2026-06-21T14:30:52+00:00"
        );
        assert_eq!(parse_snapshot_stem_ts("20260621"), "20260621");
    }

    #[test]
    fn resolve_open_target_selects_file_parent_inside_storage_root() {
        let root = std::env::temp_dir().join(format!("dbscout-open-target-{}", std::process::id()));
        let snapshot_dir = root.join("snapshots").join("demo").join("game_db");
        std::fs::create_dir_all(&snapshot_dir).unwrap();
        let snapshot = snapshot_dir.join("20260621-143052.sql");
        std::fs::write(&snapshot, "-- snapshot").unwrap();

        let target = resolve_open_backup_target(&snapshot, &[root.clone()]).unwrap();

        assert_eq!(target, snapshot_dir.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_open_target_allows_storage_root_itself() {
        let root = std::env::temp_dir().join(format!("dbscout-open-root-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();

        let target = resolve_open_backup_target(&root, &[root.clone()]).unwrap();

        assert_eq!(target, root.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_open_target_rejects_paths_outside_backup_roots() {
        let root =
            std::env::temp_dir().join(format!("dbscout-open-allowed-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("dbscout-open-outside-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let error = resolve_open_backup_target(&outside, &[root.clone()])
            .expect_err("outside path should be rejected");

        assert!(error.contains("允许的备份目录"));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolve_open_target_allows_case_variations_on_windows() {
        let root = std::env::temp_dir().join(format!("dbscout-open-case-{}", std::process::id()));
        let child = root.join("child");
        std::fs::create_dir_all(&child).unwrap();

        // Use an upper-cased root path as the allowed root. On Windows the
        // normalized comparison should still accept the actual (lower-cased)
        // directory regardless of the literal casing passed in.
        let root_upper = PathBuf::from(root.to_string_lossy().to_uppercase());
        let target = resolve_open_backup_target(&child, &[root_upper]).unwrap();

        assert_eq!(target, child.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn explorer_arg_strips_windows_verbatim_prefixes() {
        assert_eq!(
            explorer_directory_arg(Path::new(r"\\?\E:\dbscout\backups")),
            String::from(r"E:\dbscout\backups")
        );
        assert_eq!(
            explorer_directory_arg(Path::new(r"\\?\UNC\server\share\backups")),
            String::from(r"\\server\share\backups")
        );
    }

    #[test]
    fn parse_snapshot_header_reads_self_describing_line() {
        let (conn, db, ts) = parse_snapshot_header(
            "-- snapshot connection=prod database=game_db ts=20260621-143052\nSET FOREIGN_KEY_CHECKS=0;\n",
        )
        .unwrap();
        assert_eq!(conn, "prod");
        assert_eq!(db, "game_db");
        assert_eq!(ts, "20260621-143052");
    }

    #[test]
    fn parse_snapshot_header_rejects_plain_or_incomplete_lines() {
        assert!(parse_snapshot_header("-- MySQL dump\nCREATE TABLE").is_none());
        assert!(parse_snapshot_header("-- snapshot connection= database=x ts=y").is_none());
        assert!(parse_snapshot_header("SET FOREIGN_KEY_CHECKS=0;").is_none());
    }

    #[test]
    fn is_snapshot_stem_matches_timestamp_prefix() {
        assert!(is_snapshot_stem("20260621-143052"));
        assert!(is_snapshot_stem("20260621-143052-pre-restore-x"));
        assert!(!is_snapshot_stem("20260621"));
        assert!(!is_snapshot_stem("mysqldump-full"));
    }

    fn write_import_source(dir: &Path, stem: &str, sql: &str, manifest: Option<&str>) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(format!("{stem}.sql"));
        std::fs::write(&path, sql).unwrap();
        if let Some(manifest) = manifest {
            std::fs::write(dir.join(format!("{stem}.manifest.json")), manifest).unwrap();
        }
        path
    }

    #[test]
    fn import_snapshot_file_keeps_stem_and_retargets_manifest() {
        let base = std::env::temp_dir().join(format!("dbscout-import-{}", std::process::id()));
        let source = write_import_source(
            &base.join("src"),
            "20260621-143052",
            "-- snapshot connection=old database=old_db ts=20260621-143052\nSELECT 1;\n",
            Some(
                r#"{"connectionId":"old","database":"old_db","ts":"20260621-143052","tables":[{"name":"t","rows":3}],"skippedTables":[]}"#,
            ),
        );
        let root = base.join("snapshots");

        let info =
            import_snapshot_file(&root, source.to_str().unwrap(), "prod", "game_db").unwrap();

        let target_dir = root.join("prod").join("game_db");
        assert!(target_dir.join("20260621-143052.sql").exists());
        assert_eq!(info.connection_id, "prod");
        assert_eq!(info.database, "game_db");
        assert_eq!(info.table_count, 1);
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(target_dir.join("20260621-143052.manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["connectionId"], "prod");
        assert_eq!(manifest["database"], "game_db");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn import_snapshot_file_renames_foreign_stem_and_synthesizes_manifest() {
        let base = std::env::temp_dir().join(format!("dbscout-import2-{}", std::process::id()));
        let source = write_import_source(&base.join("src"), "mysqldump-full", "SELECT 1;\n", None);
        let root = base.join("snapshots");

        let info =
            import_snapshot_file(&root, source.to_str().unwrap(), "prod", "game_db").unwrap();

        assert!(info.path.ends_with("-imported.sql"));
        assert_eq!(info.table_count, 0);
        // Restore needs a manifest to find the target database, so one is
        // synthesized with the retargeted connection/database.
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(Path::new(&info.path).with_extension("manifest.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["connectionId"], "prod");
        assert_eq!(manifest["database"], "game_db");
        assert_eq!(manifest["tables"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn import_snapshot_file_avoids_collision() {
        let base = std::env::temp_dir().join(format!("dbscout-import3-{}", std::process::id()));
        let source = write_import_source(&base.join("src"), "20260621-143052", "SELECT 1;\n", None);
        let root = base.join("snapshots");

        let first =
            import_snapshot_file(&root, source.to_str().unwrap(), "prod", "game_db").unwrap();
        let second =
            import_snapshot_file(&root, source.to_str().unwrap(), "prod", "game_db").unwrap();

        assert!(first.path.ends_with("20260621-143052.sql"));
        assert!(second.path.ends_with("20260621-143052-2.sql"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn import_snapshot_file_validates_inputs() {
        let base = std::env::temp_dir().join(format!("dbscout-import4-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let txt = base.join("dump.txt");
        std::fs::write(&txt, "SELECT 1;").unwrap();
        let empty = base.join("empty.sql");
        std::fs::write(&empty, "").unwrap();
        let root = base.join("snapshots");

        assert!(import_snapshot_file(&root, txt.to_str().unwrap(), "c", "d").is_err());
        assert!(import_snapshot_file(&root, empty.to_str().unwrap(), "c", "d").is_err());
        let valid = write_import_source(&base, "20260621-143052", "SELECT 1;", None);
        assert!(import_snapshot_file(&root, valid.to_str().unwrap(), "", "d").is_err());
        assert!(import_snapshot_file(&root, valid.to_str().unwrap(), "c", " ").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn inspect_snapshot_file_reads_header_and_size() {
        let base = std::env::temp_dir().join(format!("dbscout-import5-{}", std::process::id()));
        let source = write_import_source(
            &base,
            "20260621-143052",
            "-- snapshot connection=prod database=game_db ts=20260621-143052\nSELECT 1;\n",
            None,
        );

        let (header, size) = inspect_snapshot_file(source.to_str().unwrap()).unwrap();
        assert_eq!(
            header,
            Some((
                "prod".to_string(),
                "game_db".to_string(),
                "20260621-143052".to_string()
            ))
        );
        assert!(size > 0);
        assert!(
            inspect_snapshot_file(base.join("dump.txt").to_str().unwrap_or("")).is_err()
                || !base.join("dump.txt").exists()
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
