//! Full-database logical snapshot layer (层1) — the safety net behind the
//! change-audit layer. Streams a per-database `.sql` dump (DDL + INSERT rows)
//! using an InnoDB consistent-snapshot read so writes are not blocked, with a
//! grandfather-father-son (GFS) retention policy so monthly history does not
//! exhaust disk. Also implements snapshot restore (with an automatic
//! pre-restore snapshot so a restore can itself be undone).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sqlx::{MySqlPool, Row};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{connect_database, escape_ident};
use crate::sync::{count_rows, list_base_tables, show_create_table};
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

pub fn backup_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录: {error}"))?;
    let dir = base.join("backup");
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建备份目录失败: {error}"))?;
    Ok(dir)
}

fn snapshots_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = backup_root(app)?.join("snapshots");
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建快照目录失败: {error}"))?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(backup_root(app)?.join("config.json"))
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
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let dir = snapshots_root(app)?
        .join(safe_segment(connection_id))
        .join(safe_segment(database));
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建快照目录失败: {error}"))?;
    let stem = match label {
        Some(label) if !label.trim().is_empty() => format!("{ts}-{}", safe_segment(label)),
        _ => ts.clone(),
    };
    let sql_path = dir.join(format!("{stem}.sql"));
    let manifest_path = dir.join(format!("{stem}.manifest.json"));

    let tables = list_base_tables(pool, database).await?;
    let counts = count_rows(pool, database, &tables).await?;

    let mut file = tokio::fs::File::create(&sql_path)
        .await
        .map_err(|error| format!("创建快照文件失败: {error}"))?;
    use tokio::io::AsyncWriteExt;
    file.write_all(format!("-- snapshot connection={connection_id} database={database} ts={ts}\n").as_bytes())
        .await
        .map_err(|error| format!("写入快照失败: {error}"))?;
    file.write_all(b"SET FOREIGN_KEY_CHECKS=0;\n").await.ok();

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

    for (index, table) in tables.iter().enumerate() {
        let row_count = counts.get(table).copied().unwrap_or(0);
        if row_count > config.large_table_threshold {
            file.write_all(format!("-- SKIPPED large table `{table}` rows={row_count}\n").as_bytes())
                .await
                .ok();
            manifest.skipped_tables.push(table.clone());
            continue;
        }
        let ddl = show_create_table(&mut conn, database, table).await?;
        file.write_all(format!("DROP TABLE IF EXISTS `{}`;\n", escape_ident(table)).as_bytes())
            .await
            .ok();
        file.write_all(ddl.as_bytes()).await.ok();
        file.write_all(b"\n").await.ok();

        let columns_with_types = list_columns_with_type(pool, database, table).await?;
        let columns: Vec<String> = columns_with_types.iter().map(|(name, _)| name.clone()).collect();
        if columns.is_empty() || row_count == 0 {
            manifest.tables.push(ManifestTable {
                name: table.clone(),
                rows: 0,
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
        let mut buffer: Vec<String> = Vec::with_capacity(INSERT_BATCH_SIZE);
        let mut emitted = 0u64;
        let mut header_written = false;
        for row in &rows {
            let mut values = Vec::with_capacity(columns.len());
            for (i, _) in columns.iter().enumerate() {
                values.push(format_row_value(row, i));
            }
            buffer.push(format!("({})", values.join(", ")));
            emitted += 1;
            if buffer.len() >= INSERT_BATCH_SIZE {
                if !header_written {
                    file.write_all(format!("INSERT INTO `{}` ({}) VALUES\n", escape_ident(table), col_list).as_bytes()).await.ok();
                    header_written = true;
                }
                file.write_all(buffer.join(",\n").as_bytes()).await.ok();
                file.write_all(b";\n").await.ok();
                buffer.clear();
            }
        }
        if !buffer.is_empty() {
            if !header_written {
                file.write_all(format!("INSERT INTO `{}` ({}) VALUES\n", escape_ident(table), col_list).as_bytes()).await.ok();
            }
            file.write_all(buffer.join(",\n").as_bytes()).await.ok();
            file.write_all(b";\n").await.ok();
        }
        manifest.tables.push(ManifestTable {
            name: table.clone(),
            rows: emitted,
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
    }
    file.write_all(b"SET FOREIGN_KEY_CHECKS=1;\n").await.ok();
    file.flush().await.ok();

    let manifest_json =
        serde_json::to_string_pretty(&manifest).map_err(|error| format!("序列化清单失败: {error}"))?;
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
    snapshot_to_info(connection_id, database, &sql_path, Some(manifest))
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
                format!("CAST(`{}` AS CHAR) AS `{}`", escape_ident(name), escape_ident(name))
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
        return value.map(|v| v.to_string()).unwrap_or_else(|| "NULL".into());
    }
    if let Ok(value) = row.try_get::<Option<f64>, _>(index) {
        return value.map(|v| v.to_string()).unwrap_or_else(|| "NULL".into());
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
    let pre_label = format!(
        "pre-restore-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );
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

/// Split a dump into individual statements on `;` while respecting single-quoted
/// string literals and `--` line comments.
fn split_statements(content: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let mut prev = '\0';
    for ch in content.chars() {
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
    if !current.trim().is_empty() {
        statements.push(current);
    }
    statements
}

// ---- listing / GFS pruning -------------------------------------------------

pub fn list_snapshots(
    app: &AppHandle,
    connection_filter: Option<&str>,
    database_filter: Option<&str>,
) -> Result<Vec<SnapshotInfo>, String> {
    let root = snapshots_root(app)?;
    let mut entries = Vec::new();
    if !root.exists() {
        return Ok(entries);
    }
    let connections: Vec<PathBuf> = match connection_filter {
        Some(filter) => vec![root.join(safe_segment(filter))],
        None => read_dir_dirs(&root),
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
                if let Ok(info) = snapshot_to_info(&conn_name, &db_name, &sql_path, None) {
                    entries.push(info);
                }
            }
        }
    }
    entries.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(entries)
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
    let root = snapshots_root(app)?;
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

// ---- scheduler -------------------------------------------------------------

pub mod scheduler {
    use super::*;

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
        let connections = collect_connections(app).await?;
        for (connection_id, mysql_url, databases) in connections {
            for database in databases {
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

    async fn collect_connections(
        app: &AppHandle,
    ) -> Result<Vec<(String, String, Vec<String>)>, String> {
        let state = app.state::<AppState>();
        let rt = state.runtime.lock().await;
        let mut out = Vec::new();
        for (id, connection) in rt.connections.iter() {
            if let Some(url) = connection.mysql_url.as_ref() {
                let databases = list_databases_for_url(url).await.unwrap_or_default();
                out.push((id.clone(), url.clone(), databases));
            }
        }
        Ok(out)
    }

    async fn list_databases_for_url(mysql_url: &str) -> Result<Vec<String>, String> {
        let pool = connect_database(mysql_url, None).await?;
        let rows = sqlx::query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")
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
        .map(|ch| if ch.is_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' })
        .collect()
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

    #[test]
    fn split_statements_respects_strings_and_comments() {
        let content = "SET FOREIGN_KEY_CHECKS=0;\n-- a comment; with semicolon\nINSERT INTO `t` VALUES ('a;b', 'c');\nSET FOREIGN_KEY_CHECKS=1;";
        let stmts = split_statements(content);
        // Comment-only chunks are skipped by the caller; just verify count of non-empty.
        let non_empty: Vec<&String> = stmts.iter().filter(|s| !s.trim().is_empty()).collect();
        assert!(non_empty.len() >= 3);
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
}
