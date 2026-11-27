//! Per-table count-based backups derived read-only from 243 GM hourly dumps.
//!
//! Runs daily (default 01:15 server local time) against the latest settled
//! hourly `.zip` per eligible config database in `/home/servbin/dbback`:
//! - Streams each archive once using `gm_backups`'s quote-aware table parser.
//! - Computes canonical SHA-256 content + schema hashes (ignoring dump comments
//!   and volatile `AUTO_INCREMENT=N` counters).
//! - Stores a gzipped SQL snapshot under `/home/blackcat-server/table-backups/`
//!   ONLY when the table's content hash differs from its previous stored version.
//! - Keeps at most `max_versions` (default 60) changed versions per table.
//! - Marks tables absent from the latest archive as `present_in_latest = 0`
//!   while preserving all of their stored backup versions for accidental-drop recovery.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use axum::http::StatusCode;
use chrono::{DateTime, FixedOffset, Utc};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;
use zip::ZipArchive;

use crate::db::DEFAULT_TZ_OFFSET_HOURS;
use crate::gm_backups::{
    advance_sql_quote_state, extract_statement_table_name, is_lock_statement,
    is_valid_date_segment, is_valid_hour_segment, parse_mysql_backup_filename,
    parse_mysqldump_section_marker, sql_entry_indices, DumpLineMarker, ParsedMysqlBackupName,
};
use crate::models::{
    GmTableBackupExtractResponse, GmTableBackupListResponse, GmTableBackupRunResponse,
    GmTableBackupSummary, GmTableBackupVersion, GmTableBackupVersionsResponse,
};

pub const DEFAULT_MAX_VERSIONS_PER_TABLE: usize = 60;
pub const DEFAULT_MAX_TABLE_BYTES: usize = 64 * 1024 * 1024;
pub const DEFAULT_MIN_ARCHIVE_AGE_SECS: u64 = 60;

#[derive(Debug, Clone)]
pub struct TableBackupConfig {
    pub backup_dir: Option<PathBuf>,
    pub max_versions: usize,
    pub max_table_bytes: usize,
    pub min_archive_age_secs: u64,
    pub tz_offset_hours: i32,
    /// Optional explicit database filter (`*` for all MySQL DBs, or exact names).
    /// When `None`, defaults to config databases (containing `cfg` or `config`,
    /// excluding `log`).
    pub database_whitelist: Option<Vec<String>>,
}

impl TableBackupConfig {
    pub fn from_env(db_path: &str) -> Self {
        let backup_dir = resolve_table_backup_dir(db_path);
        let max_versions = std::env::var("DBSCOUT_SERVER_TABLE_BACKUP_MAX_VERSIONS")
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .filter(|&v| v >= 1)
            .unwrap_or(DEFAULT_MAX_VERSIONS_PER_TABLE);
        let max_table_bytes = std::env::var("DBSCOUT_SERVER_TABLE_BACKUP_MAX_TABLE_MB")
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .filter(|&v| v >= 1)
            .map(|mb| mb.saturating_mul(1024 * 1024))
            .unwrap_or(DEFAULT_MAX_TABLE_BYTES);
        let tz_offset_hours = std::env::var("DBSCOUT_SERVER_TZ_OFFSET_HOURS")
            .ok()
            .and_then(|v| v.trim().parse::<i32>().ok())
            .filter(|&v| (-12..=14).contains(&v))
            .unwrap_or(DEFAULT_TZ_OFFSET_HOURS);
        let database_whitelist = std::env::var("DBSCOUT_SERVER_TABLE_BACKUP_DATABASES")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|list| !list.is_empty());

        Self {
            backup_dir,
            max_versions,
            max_table_bytes,
            min_archive_age_secs: DEFAULT_MIN_ARCHIVE_AGE_SECS,
            tz_offset_hours,
            database_whitelist,
        }
    }

    pub fn should_include_database(&self, db_name: &str) -> bool {
        let lower = db_name.trim().to_ascii_lowercase();
        if lower.is_empty()
            || matches!(
                lower.as_str(),
                "mysql" | "information_schema" | "performance_schema" | "sys"
            )
        {
            return false;
        }
        if let Some(list) = &self.database_whitelist {
            if list.iter().any(|item| item == "*") {
                return true;
            }
            return list.iter().any(|item| item.eq_ignore_ascii_case(&lower));
        }
        // Smart default: config databases only (excludes player/game/log DBs).
        (lower.contains("cfg") || lower.contains("config")) && !lower.contains("log")
    }
}

pub fn resolve_table_backup_dir(db_path: &str) -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("DBSCOUT_SERVER_TABLE_BACKUP_DIR") {
        let trimmed = raw.trim();
        if trimmed.is_empty()
            || trimmed.eq_ignore_ascii_case("off")
            || trimmed.eq_ignore_ascii_case("none")
            || trimmed.eq_ignore_ascii_case("false")
            || trimmed == "0"
        {
            return None;
        }
        return Some(PathBuf::from(trimmed));
    }
    if db_path.contains(":memory:") {
        return None;
    }
    let clean = db_path
        .strip_prefix("sqlite://")
        .unwrap_or(db_path)
        .split('?')
        .next()
        .unwrap_or(db_path);
    let p = Path::new(clean);
    let base = match p.parent() {
        Some(parent) if parent.file_name().and_then(|n| n.to_str()) == Some("data") => {
            parent.parent().unwrap_or(parent)
        }
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    Some(base.join("table-backups"))
}

fn sanitize_path_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('.');
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Strip volatile `AUTO_INCREMENT=<digits>` table option from a DDL line so
/// counter drift without schema/data edits never creates false backup diffs.
fn strip_auto_increment_option(line: &str) -> String {
    let bytes = line.as_bytes();
    let needle = b"AUTO_INCREMENT=";
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + needle.len() <= bytes.len()
            && bytes[i..i + needle.len()].eq_ignore_ascii_case(needle)
        {
            let prev_ok = i == 0 || bytes[i - 1].is_ascii_whitespace() || bytes[i - 1] == b',';
            if prev_ok {
                let mut j = i + needle.len();
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j > i + needle.len() {
                    if j < bytes.len() && bytes[j] == b' ' {
                        j += 1;
                    }
                    i = j;
                    continue;
                }
            }
        }
        let ch = line[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn is_volatile_dump_wrapper(trimmed: &str) -> bool {
    trimmed.is_empty()
        || trimmed.starts_with("--")
        || trimmed.starts_with('#')
        || trimmed.starts_with("/*!40000 ALTER TABLE ")
        || trimmed.starts_with("/*!40101 SET ")
        || trimmed.starts_with("/*!50503 SET ")
        || is_lock_statement(trimmed)
}

#[derive(Debug, Clone)]
struct ExtractedTableDump {
    name: String,
    raw_sql: String,
    has_data: bool,
    content_hash: String,
    schema_hash: String,
    oversized: bool,
}

#[derive(Debug)]
struct TableAcc {
    name: String,
    raw_sql: String,
    has_data: bool,
    content_hasher: Sha256,
    schema_hasher: Sha256,
    in_create_table: bool,
    oversized: bool,
}

impl TableAcc {
    fn new(name: String) -> Self {
        Self {
            name,
            raw_sql: String::new(),
            has_data: false,
            content_hasher: Sha256::new(),
            schema_hasher: Sha256::new(),
            in_create_table: false,
            oversized: false,
        }
    }

    fn push_line(&mut self, line: &str, in_single_quote_before: bool, max_table_bytes: usize) {
        if self.oversized {
            return;
        }
        let trimmed = line.trim();
        if !in_single_quote_before && is_lock_statement(trimmed) {
            return;
        }
        if self.raw_sql.len().saturating_add(line.len()) > max_table_bytes {
            self.oversized = true;
            self.raw_sql.clear();
            self.raw_sql.shrink_to_fit();
            return;
        }
        self.raw_sql.push_str(line);
        if !line.ends_with('\n') {
            self.raw_sql.push('\n');
        }

        if in_single_quote_before {
            self.content_hasher.update(line.as_bytes());
            if self.in_create_table {
                self.schema_hasher.update(line.as_bytes());
            }
            return;
        }

        if is_volatile_dump_wrapper(trimmed) {
            return;
        }

        let upper = trimmed.to_ascii_uppercase();
        if upper.starts_with("CREATE TABLE ") {
            self.in_create_table = true;
        }
        if upper.starts_with("INSERT INTO ")
            || upper.starts_with("INSERT IGNORE INTO ")
            || upper.starts_with("REPLACE INTO ")
        {
            self.has_data = true;
        }

        let normalized = if self.in_create_table {
            strip_auto_increment_option(trimmed)
        } else {
            trimmed.to_string()
        };
        self.content_hasher.update(normalized.as_bytes());
        self.content_hasher.update(b"\n");

        if self.in_create_table {
            self.schema_hasher.update(normalized.as_bytes());
            self.schema_hasher.update(b"\n");
            if trimmed.ends_with(';') {
                self.in_create_table = false;
            }
        }
    }

    fn finish(self) -> ExtractedTableDump {
        ExtractedTableDump {
            name: self.name,
            raw_sql: self.raw_sql,
            has_data: self.has_data,
            content_hash: format!("{:x}", self.content_hasher.finalize()),
            schema_hash: format!("{:x}", self.schema_hasher.finalize()),
            oversized: self.oversized,
        }
    }
}

fn split_all_tables_from_reader<R: BufRead>(
    mut reader: R,
    max_table_bytes: usize,
    order: &mut Vec<String>,
    tables: &mut HashMap<String, TableAcc>,
) -> Result<(), String> {
    let mut current_key: Option<String> = None;
    let mut in_single_quote = false;
    let mut raw_buf = Vec::with_capacity(8192);

    loop {
        raw_buf.clear();
        let bytes_read = reader
            .read_until(b'\n', &mut raw_buf)
            .map_err(|e| format!("读取整库备份 SQL 失败: {e}"))?;
        if bytes_read == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&raw_buf);
        let quote_before = in_single_quote;

        if !quote_before {
            let trimmed = line.trim();
            if let Some(marker) = parse_mysqldump_section_marker(trimmed) {
                match marker {
                    DumpLineMarker::TableStructure(name) | DumpLineMarker::TableData(name) => {
                        let key = name.to_ascii_lowercase();
                        if !tables.contains_key(&key) {
                            order.push(key.clone());
                            tables.insert(key.clone(), TableAcc::new(name));
                        }
                        current_key = Some(key);
                    }
                    DumpLineMarker::NonTableSection => {
                        current_key = None;
                    }
                }
            } else if let Some((_, name)) = extract_statement_table_name(trimmed) {
                let key = name.to_ascii_lowercase();
                if !tables.contains_key(&key) {
                    order.push(key.clone());
                    tables.insert(key.clone(), TableAcc::new(name));
                }
                current_key = Some(key);
            }
        }

        if let Some(key) = current_key.as_ref() {
            if let Some(acc) = tables.get_mut(key) {
                acc.push_line(&line, quote_before, max_table_bytes);
            }
        }

        advance_sql_quote_state(&line, &mut in_single_quote);
    }

    Ok(())
}

fn split_archive_tables(
    archive_path: &Path,
    max_table_bytes: usize,
) -> Result<Vec<ExtractedTableDump>, String> {
    let file = File::open(archive_path)
        .map_err(|e| format!("打开整库备份压缩包失败 ({}): {e}", archive_path.display()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("解析整库备份压缩包失败 ({}): {e}", archive_path.display()))?;
    let indices = sql_entry_indices(&mut archive).map_err(|(_, msg)| msg)?;

    let mut order = Vec::new();
    let mut map = HashMap::new();
    for idx in indices {
        let entry = archive
            .by_index(idx)
            .map_err(|e| format!("读取压缩包内 SQL 文件失败: {e}"))?;
        let reader = BufReader::with_capacity(64 * 1024, entry);
        split_all_tables_from_reader(reader, max_table_bytes, &mut order, &mut map)?;
    }

    Ok(order
        .into_iter()
        .filter_map(|key| map.remove(&key).map(TableAcc::finish))
        .collect())
}

#[derive(Debug, Clone)]
struct CandidateArchive {
    path: PathBuf,
    file_name: String,
    parsed: ParsedMysqlBackupName,
    backup_date: String,
}

fn discover_latest_archives_by_db(
    gm_root: &Path,
    config: &TableBackupConfig,
) -> Result<HashMap<String, Vec<CandidateArchive>>, String> {
    let mut by_db: HashMap<String, Vec<CandidateArchive>> = HashMap::new();
    let now_sys = SystemTime::now();
    let min_age = Duration::from_secs(config.min_archive_age_secs);

    let date_entries =
        fs::read_dir(gm_root).map_err(|e| format!("读取 243 备份根目录失败: {e}"))?;
    for date_entry in date_entries.flatten() {
        let date_name = date_entry.file_name().to_string_lossy().into_owned();
        if !is_valid_date_segment(&date_name) || !date_entry.path().is_dir() {
            continue;
        }
        let Ok(hour_entries) = fs::read_dir(date_entry.path()) else {
            continue;
        };
        for hour_entry in hour_entries.flatten() {
            let hour_name = hour_entry.file_name().to_string_lossy().into_owned();
            if !is_valid_hour_segment(&hour_name) || !hour_entry.path().is_dir() {
                continue;
            }
            let Ok(file_entries) = fs::read_dir(hour_entry.path()) else {
                continue;
            };
            for file_entry in file_entries.flatten() {
                let file_name = file_entry.file_name().to_string_lossy().into_owned();
                let Some(parsed) = parse_mysql_backup_filename(&file_name) else {
                    continue;
                };
                if !config.should_include_database(&parsed.database) {
                    continue;
                }
                let path = file_entry.path();
                if config.min_archive_age_secs > 0 {
                    if let Ok(meta) = fs::metadata(&path) {
                        if let Ok(modified) = meta.modified() {
                            if let Ok(elapsed) = now_sys.duration_since(modified) {
                                if elapsed < min_age {
                                    continue;
                                }
                            }
                        }
                    }
                }
                let db_key = parsed.database.to_ascii_lowercase();
                by_db.entry(db_key).or_default().push(CandidateArchive {
                    path,
                    file_name,
                    parsed,
                    backup_date: date_name.clone(),
                });
            }
        }
    }

    for candidates in by_db.values_mut() {
        candidates.sort_by(|a, b| {
            b.parsed
                .ts
                .cmp(&a.parsed.ts)
                .then_with(|| b.file_name.cmp(&a.file_name))
        });
    }
    Ok(by_db)
}

fn write_gzipped_table_sql(
    target_root: &Path,
    database: &str,
    table_name: &str,
    version_id: &str,
    source_file_name: &str,
    backup_ts: &str,
    raw_sql: &str,
) -> Result<(String, u64, u64), String> {
    let db_seg = sanitize_path_segment(&database.to_ascii_lowercase());
    let tbl_seg = sanitize_path_segment(&table_name.to_ascii_lowercase());
    let dir = target_root.join(&db_seg).join(&tbl_seg);
    fs::create_dir_all(&dir).map_err(|e| format!("创建单表备份目录失败: {e}"))?;

    let rel_path = format!("{db_seg}/{tbl_seg}/{version_id}.sql.gz");
    let final_path = dir.join(format!("{version_id}.sql.gz"));
    let tmp_path = dir.join(format!("{version_id}.sql.gz.tmp"));

    let mut full_sql = String::with_capacity(raw_sql.len() + 256);
    full_sql.push_str(&format!(
        "-- Blackcat per-table backup: {}.{} @ {} (source: {})\n",
        database, table_name, backup_ts, source_file_name
    ));
    full_sql.push_str("SET NAMES utf8mb4;\n");
    full_sql.push_str("SET FOREIGN_KEY_CHECKS=0;\n");
    full_sql.push_str("SET UNIQUE_CHECKS=0;\n");
    full_sql.push_str("SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n\n");
    full_sql.push_str(raw_sql);
    if !full_sql.ends_with('\n') {
        full_sql.push('\n');
    }
    full_sql.push_str("\nSET FOREIGN_KEY_CHECKS=1;\n");
    full_sql.push_str("SET UNIQUE_CHECKS=1;\n");

    let raw_bytes = full_sql.len() as u64;
    {
        let file = File::create(&tmp_path).map_err(|e| format!("创建临时单表备份文件失败: {e}"))?;
        let mut encoder = GzEncoder::new(file, Compression::default());
        encoder
            .write_all(full_sql.as_bytes())
            .map_err(|e| format!("压缩单表备份 SQL 失败: {e}"))?;
        let mut file = encoder
            .finish()
            .map_err(|e| format!("完成压缩单表备份失败: {e}"))?;
        file.flush().map_err(|e| format!("刷盘单表备份失败: {e}"))?;
    }
    fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("保存单表备份文件失败: {e}")
    })?;
    let compressed_bytes = fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
    Ok((rel_path, compressed_bytes, raw_bytes))
}

fn safe_resolve_stored_file(root: &Path, rel_path: &str) -> Result<PathBuf, (StatusCode, String)> {
    let trimmed = rel_path.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.contains("..")
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err((StatusCode::FORBIDDEN, "非法的单表备份路径".into()));
    }
    let canon_root = fs::canonicalize(root).map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("无法访问单表备份目录: {e}"),
        )
    })?;
    let candidate = root.join(trimmed);
    let canon_candidate = fs::canonicalize(&candidate).map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            "单表备份文件不存在或已被清理".into(),
        )
    })?;
    if !canon_candidate.starts_with(&canon_root) || !canon_candidate.is_file() {
        return Err((StatusCode::FORBIDDEN, "拒绝访问单表备份目录之外的文件".into()));
    }
    Ok(canon_candidate)
}

/// Run one incremental per-table snapshot pass across all eligible config
/// databases present in `gm_backup_dir`. Safe to invoke daily or manually.
pub async fn run_per_table_backup_pass(
    pool: &SqlitePool,
    gm_backup_dir: Option<&Path>,
    config: &TableBackupConfig,
    now_utc: DateTime<Utc>,
) -> Result<GmTableBackupRunResponse, String> {
    let Some(gm_root) = gm_backup_dir else {
        return Ok(GmTableBackupRunResponse {
            databases_scanned: 0,
            tables_scanned: 0,
            tables_changed: 0,
            tables_missing: 0,
            skipped_archives: 0,
        });
    };
    let Some(store_root) = config.backup_dir.as_deref() else {
        return Ok(GmTableBackupRunResponse {
            databases_scanned: 0,
            tables_scanned: 0,
            tables_changed: 0,
            tables_missing: 0,
            skipped_archives: 0,
        });
    };
    if !gm_root.is_dir() {
        return Ok(GmTableBackupRunResponse {
            databases_scanned: 0,
            tables_scanned: 0,
            tables_changed: 0,
            tables_missing: 0,
            skipped_archives: 0,
        });
    }
    fs::create_dir_all(store_root).map_err(|e| format!("初始化单表备份目录失败: {e}"))?;

    let gm_root_owned = gm_root.to_path_buf();
    let cfg_clone = config.clone();
    let by_db = tokio::task::spawn_blocking(move || {
        discover_latest_archives_by_db(&gm_root_owned, &cfg_clone)
    })
    .await
    .map_err(|e| format!("扫描 243 备份清单任务异常: {e}"))??;

    let offset = FixedOffset::east_opt(config.tz_offset_hours * 3600)
        .unwrap_or_else(|| FixedOffset::east_opt(DEFAULT_TZ_OFFSET_HOURS * 3600).unwrap());
    let run_date = now_utc.with_timezone(&offset).format("%Y-%m-%d").to_string();
    let run_ts = now_utc.to_rfc3339();

    let mut summary = GmTableBackupRunResponse {
        databases_scanned: 0,
        tables_scanned: 0,
        tables_changed: 0,
        tables_missing: 0,
        skipped_archives: 0,
    };

    let mut db_keys: Vec<String> = by_db.keys().cloned().collect();
    db_keys.sort();

    for db_lower in db_keys {
        let candidates = &by_db[&db_lower];
        // Pick the newest readable `.zip` archive for this database.
        let mut chosen: Option<(CandidateArchive, Vec<ExtractedTableDump>)> = None;
        for cand in candidates {
            let already_done: Option<i64> = sqlx::query_scalar(
                "SELECT id FROM table_backup_runs \
                 WHERE LOWER(database) = ? AND source_file_name = ? AND status = 'ok' LIMIT 1",
            )
            .bind(&db_lower)
            .bind(&cand.file_name)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("查询单表备份运行记录失败: {e}"))?;
            if already_done.is_some() {
                summary.skipped_archives += 1;
                chosen = None;
                break;
            }
            let path = cand.path.clone();
            let max_bytes = config.max_table_bytes;
            let parsed_tables =
                tokio::task::spawn_blocking(move || split_archive_tables(&path, max_bytes))
                    .await
                    .map_err(|e| format!("拆解备份压缩包任务异常: {e}"))?;
            match parsed_tables {
                Ok(tables) => {
                    chosen = Some((cand.clone(), tables));
                    break;
                }
                Err(err) => {
                    tracing::warn!(
                        "跳过可能仍在写入或损坏的 243 备份包 {}: {err}",
                        cand.file_name
                    );
                    continue;
                }
            }
        }

        let Some((cand, dumped_tables)) = chosen else {
            continue;
        };

        summary.databases_scanned += 1;
        let database = cand.parsed.database.clone();
        let backup_ts = cand.parsed.ts.clone();
        let backup_date = cand.backup_date.clone();
        let source_file_name = cand.file_name.clone();

        // Load existing latest hashes for every tracked table in this database.
        let existing_rows = sqlx::query(
            "SELECT table_lower, latest_content_hash, latest_schema_hash, version_count \
             FROM table_backup_tables WHERE db_lower = ?",
        )
        .bind(&db_lower)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询已有单表备份索引失败: {e}"))?;

        let mut existing_map: HashMap<String, (String, String, i64)> = HashMap::new();
        for row in existing_rows {
            let tbl_lower: String = row.try_get("table_lower").unwrap_or_default();
            let content_hash: String = row.try_get("latest_content_hash").unwrap_or_default();
            let schema_hash: String = row.try_get("latest_schema_hash").unwrap_or_default();
            let version_count: i64 = row.try_get("version_count").unwrap_or(0);
            existing_map.insert(tbl_lower, (content_hash, schema_hash, version_count));
        }

        let mut seen_tables: HashSet<String> = HashSet::new();
        let mut db_scanned: usize = 0;
        let mut db_changed: usize = 0;

        for tbl in dumped_tables {
            let tbl_lower = tbl.name.to_ascii_lowercase();
            seen_tables.insert(tbl_lower.clone());
            db_scanned += 1;

            if tbl.oversized {
                tracing::warn!(
                    "跳过超过单表体积上限的表 {}.{} (limit={}MB)",
                    database,
                    tbl.name,
                    config.max_table_bytes / (1024 * 1024)
                );
                continue;
            }

            if let Some((prev_content, prev_schema, _)) = existing_map.get(&tbl_lower) {
                if *prev_content == tbl.content_hash {
                    // Unchanged: keep version count intact, only refresh last_seen_ts & present flag.
                    sqlx::query(
                        "UPDATE table_backup_tables \
                         SET table_name = ?, present_in_latest = 1, last_seen_ts = ? \
                         WHERE db_lower = ? AND table_lower = ?",
                    )
                    .bind(&tbl.name)
                    .bind(&backup_ts)
                    .bind(&db_lower)
                    .bind(&tbl_lower)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("更新未变化表巡检时间失败: {e}"))?;
                    continue;
                }
                let schema_changed = *prev_schema != tbl.schema_hash;
                persist_new_table_version(
                    pool,
                    store_root,
                    &db_lower,
                    &database,
                    &tbl_lower,
                    &tbl,
                    &backup_ts,
                    &backup_date,
                    &source_file_name,
                    schema_changed,
                    config.max_versions,
                )
                .await?;
                db_changed += 1;
            } else {
                // First ever version of this table.
                persist_new_table_version(
                    pool,
                    store_root,
                    &db_lower,
                    &database,
                    &tbl_lower,
                    &tbl,
                    &backup_ts,
                    &backup_date,
                    &source_file_name,
                    false,
                    config.max_versions,
                )
                .await?;
                db_changed += 1;
            }
        }

        // Mark previously tracked tables absent from the latest archive as deleted
        // WITHOUT removing any of their stored versions.
        let mut db_missing: usize = 0;
        for prev_tbl_lower in existing_map.keys() {
            if !seen_tables.contains(prev_tbl_lower) {
                let res = sqlx::query(
                    "UPDATE table_backup_tables SET present_in_latest = 0 \
                     WHERE db_lower = ? AND table_lower = ? AND present_in_latest != 0",
                )
                .bind(&db_lower)
                .bind(prev_tbl_lower)
                .execute(pool)
                .await
                .map_err(|e| format!("标记缺失表状态失败: {e}"))?;
                if res.rows_affected() > 0 {
                    db_missing += 1;
                }
            }
        }

        sqlx::query(
            "INSERT INTO table_backup_runs \
             (run_ts, run_date, database, source_file_name, tables_scanned, tables_changed, tables_missing, status, error) \
             VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', NULL)",
        )
        .bind(&run_ts)
        .bind(&run_date)
        .bind(&database)
        .bind(&source_file_name)
        .bind(db_scanned as i64)
        .bind(db_changed as i64)
        .bind(db_missing as i64)
        .execute(pool)
        .await
        .map_err(|e| format!("记录单表备份运行日志失败: {e}"))?;

        summary.tables_scanned += db_scanned;
        summary.tables_changed += db_changed;
        summary.tables_missing += db_missing;
    }

    Ok(summary)
}

#[allow(clippy::too_many_arguments)]
async fn persist_new_table_version(
    pool: &SqlitePool,
    store_root: &Path,
    db_lower: &str,
    database: &str,
    tbl_lower: &str,
    tbl: &ExtractedTableDump,
    backup_ts: &str,
    backup_date: &str,
    source_file_name: &str,
    schema_changed: bool,
    max_versions: usize,
) -> Result<(), String> {
    let version_id = format!(
        "{}-{}",
        backup_ts.replace([' ', ':'], "-"),
        &Uuid::new_v4().simple().to_string()[..8]
    );
    let created_at = Utc::now().to_rfc3339();

    let store_owned = store_root.to_path_buf();
    let db_owned = database.to_string();
    let tbl_owned = tbl.name.clone();
    let vid_owned = version_id.clone();
    let src_owned = source_file_name.to_string();
    let ts_owned = backup_ts.to_string();
    let sql_owned = tbl.raw_sql.clone();

    let (rel_path, compressed_bytes, raw_bytes) = tokio::task::spawn_blocking(move || {
        write_gzipped_table_sql(
            &store_owned,
            &db_owned,
            &tbl_owned,
            &vid_owned,
            &src_owned,
            &ts_owned,
            &sql_owned,
        )
    })
    .await
    .map_err(|e| format!("写入单表备份文件任务异常: {e}"))??;

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启单表备份入库事务失败: {e}"))?;

    sqlx::query(
        "INSERT INTO table_backup_versions \
         (version_id, db_lower, table_lower, database, table_name, backup_ts, backup_date, \
          source_file_name, content_hash, schema_hash, schema_changed, has_data, \
          compressed_bytes, raw_bytes, rel_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&version_id)
    .bind(db_lower)
    .bind(tbl_lower)
    .bind(database)
    .bind(&tbl.name)
    .bind(backup_ts)
    .bind(backup_date)
    .bind(source_file_name)
    .bind(&tbl.content_hash)
    .bind(&tbl.schema_hash)
    .bind(if schema_changed { 1 } else { 0 })
    .bind(if tbl.has_data { 1 } else { 0 })
    .bind(compressed_bytes as i64)
    .bind(raw_bytes as i64)
    .bind(&rel_path)
    .bind(&created_at)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("写入单表备份版本失败: {e}"))?;

    // Enforce max_versions (default 60): prune oldest excess versions.
    let all_versions = sqlx::query(
        "SELECT version_id, rel_path FROM table_backup_versions \
         WHERE db_lower = ? AND table_lower = ? \
         ORDER BY backup_ts DESC, rowid DESC",
    )
    .bind(db_lower)
    .bind(tbl_lower)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| format!("查询单表备份版本数失败: {e}"))?;

    let mut files_to_delete: Vec<String> = Vec::new();
    let kept_count = all_versions.len().min(max_versions) as i64;
    if all_versions.len() > max_versions {
        for excess in all_versions.into_iter().skip(max_versions) {
            let old_vid: String = excess.try_get("version_id").unwrap_or_default();
            let old_rel: String = excess.try_get("rel_path").unwrap_or_default();
            sqlx::query("DELETE FROM table_backup_versions WHERE version_id = ?")
                .bind(&old_vid)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("清理超限单表备份版本失败: {e}"))?;
            if !old_rel.is_empty() {
                files_to_delete.push(old_rel);
            }
        }
    }

    sqlx::query(
        "INSERT INTO table_backup_tables \
         (db_lower, table_lower, database, table_name, present_in_latest, last_seen_ts, \
          latest_version_id, latest_version_ts, latest_content_hash, latest_schema_hash, \
          latest_size_bytes, latest_schema_changed, version_count) \
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(db_lower, table_lower) DO UPDATE SET \
          database = excluded.database, \
          table_name = excluded.table_name, \
          present_in_latest = 1, \
          last_seen_ts = excluded.last_seen_ts, \
          latest_version_id = excluded.latest_version_id, \
          latest_version_ts = excluded.latest_version_ts, \
          latest_content_hash = excluded.latest_content_hash, \
          latest_schema_hash = excluded.latest_schema_hash, \
          latest_size_bytes = excluded.latest_size_bytes, \
          latest_schema_changed = excluded.latest_schema_changed, \
          version_count = excluded.version_count",
    )
    .bind(db_lower)
    .bind(tbl_lower)
    .bind(database)
    .bind(&tbl.name)
    .bind(backup_ts)
    .bind(&version_id)
    .bind(backup_ts)
    .bind(&tbl.content_hash)
    .bind(&tbl.schema_hash)
    .bind(compressed_bytes as i64)
    .bind(if schema_changed { 1 } else { 0 })
    .bind(kept_count)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("更新单表备份索引失败: {e}"))?;

    tx.commit()
        .await
        .map_err(|e| format!("提交单表备份事务失败: {e}"))?;

    // Remove pruned files from disk after transaction commit.
    for old_rel in files_to_delete {
        if let Ok(path) = safe_resolve_stored_file(store_root, &old_rel) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

pub async fn list_table_backups(
    pool: &SqlitePool,
    config: &TableBackupConfig,
    database_filter: Option<&str>,
    search: Option<&str>,
    include_deleted: bool,
) -> Result<GmTableBackupListResponse, (StatusCode, String)> {
    let Some(_) = config.backup_dir.as_ref() else {
        return Ok(GmTableBackupListResponse {
            enabled: false,
            max_versions: config.max_versions,
            last_run_ts: None,
            databases: Vec::new(),
            items: Vec::new(),
        });
    };

    let last_run_ts: Option<String> = sqlx::query_scalar(
        "SELECT run_ts FROM table_backup_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("查询单表备份最近运行时间失败: {e}"),
        )
    })?;

    let db_rows = sqlx::query(
        "SELECT DISTINCT database FROM table_backup_tables ORDER BY LOWER(database) ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("查询单表备份库清单失败: {e}"),
        )
    })?;
    let databases: Vec<String> = db_rows
        .into_iter()
        .map(|r| r.try_get::<String, _>("database").unwrap_or_default())
        .filter(|s| !s.is_empty())
        .collect();

    let db_filter = database_filter
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase);
    let search_lower = search
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase);

    let mut sql = String::from(
        "SELECT database, table_name, version_count, latest_version_id, latest_version_ts, \
                latest_size_bytes, latest_schema_changed, present_in_latest, last_seen_ts \
         FROM table_backup_tables WHERE 1=1",
    );
    if db_filter.is_some() {
        sql.push_str(" AND db_lower = ?");
    }
    if !include_deleted {
        sql.push_str(" AND present_in_latest = 1");
    }
    if search_lower.is_some() {
        sql.push_str(" AND instr(table_lower, ?) > 0");
    }
    sql.push_str(" ORDER BY latest_version_ts DESC, table_lower ASC");

    let mut q = sqlx::query(&sql);
    if let Some(ref d) = db_filter {
        q = q.bind(d);
    }
    if let Some(ref s) = search_lower {
        q = q.bind(s);
    }
    let rows = q.fetch_all(pool).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("查询单表备份列表失败: {e}"),
        )
    })?;

    let items: Vec<GmTableBackupSummary> = rows
        .into_iter()
        .map(|r| GmTableBackupSummary {
            database: r.try_get("database").unwrap_or_default(),
            table_name: r.try_get("table_name").unwrap_or_default(),
            version_count: r.try_get::<i64, _>("version_count").unwrap_or(0).max(0) as u32,
            latest_version_id: r.try_get("latest_version_id").unwrap_or_default(),
            latest_version_ts: r.try_get("latest_version_ts").unwrap_or_default(),
            latest_size_bytes: r.try_get::<i64, _>("latest_size_bytes").unwrap_or(0).max(0) as u64,
            latest_schema_changed: r.try_get::<i64, _>("latest_schema_changed").unwrap_or(0) != 0,
            present_in_latest: r.try_get::<i64, _>("present_in_latest").unwrap_or(1) != 0,
            last_seen_ts: r.try_get("last_seen_ts").unwrap_or_default(),
        })
        .collect();

    Ok(GmTableBackupListResponse {
        enabled: true,
        max_versions: config.max_versions,
        last_run_ts,
        databases,
        items,
    })
}

pub async fn list_table_backup_versions(
    pool: &SqlitePool,
    config: &TableBackupConfig,
    database: &str,
    table_name: &str,
) -> Result<GmTableBackupVersionsResponse, (StatusCode, String)> {
    let db_lower = database.trim().to_ascii_lowercase();
    let tbl_lower = table_name.trim().to_ascii_lowercase();
    if db_lower.is_empty() || tbl_lower.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "database 和 tableName 不能为空".into()));
    }

    let table_row = sqlx::query(
        "SELECT database, table_name, present_in_latest, last_seen_ts \
         FROM table_backup_tables WHERE db_lower = ? AND table_lower = ?",
    )
    .bind(&db_lower)
    .bind(&tbl_lower)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("查询单表备份摘要失败: {e}"),
        )
    })?
    .ok_or_else(|| (StatusCode::NOT_FOUND, "未找到该表的 243 按次备份记录".into()))?;

    let version_rows = sqlx::query(
        "SELECT version_id, backup_ts, backup_date, source_file_name, content_hash, \
                schema_changed, has_data, compressed_bytes, raw_bytes, created_at \
         FROM table_backup_versions \
         WHERE db_lower = ? AND table_lower = ? \
         ORDER BY backup_ts DESC, rowid DESC",
    )
    .bind(&db_lower)
    .bind(&tbl_lower)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("查询单表备份版本清单失败: {e}"),
        )
    })?;

    let versions: Vec<GmTableBackupVersion> = version_rows
        .into_iter()
        .map(|r| GmTableBackupVersion {
            version_id: r.try_get("version_id").unwrap_or_default(),
            backup_ts: r.try_get("backup_ts").unwrap_or_default(),
            backup_date: r.try_get("backup_date").unwrap_or_default(),
            source_file_name: r.try_get("source_file_name").unwrap_or_default(),
            content_hash: r.try_get("content_hash").unwrap_or_default(),
            schema_changed: r.try_get::<i64, _>("schema_changed").unwrap_or(0) != 0,
            has_data: r.try_get::<i64, _>("has_data").unwrap_or(0) != 0,
            compressed_bytes: r.try_get::<i64, _>("compressed_bytes").unwrap_or(0).max(0) as u64,
            raw_bytes: r.try_get::<i64, _>("raw_bytes").unwrap_or(0).max(0) as u64,
            created_at: r.try_get("created_at").unwrap_or_default(),
        })
        .collect();

    Ok(GmTableBackupVersionsResponse {
        database: table_row.try_get("database").unwrap_or_default(),
        table_name: table_row.try_get("table_name").unwrap_or_default(),
        present_in_latest: table_row.try_get::<i64, _>("present_in_latest").unwrap_or(1) != 0,
        last_seen_ts: table_row.try_get("last_seen_ts").unwrap_or_default(),
        max_versions: config.max_versions,
        versions,
    })
}

pub async fn extract_table_backup_sql(
    pool: &SqlitePool,
    config: &TableBackupConfig,
    database: &str,
    table_name: &str,
    version_id: &str,
) -> Result<GmTableBackupExtractResponse, (StatusCode, String)> {
    let Some(store_root) = config.backup_dir.as_ref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "服务端未启用单表按次备份存储目录".into(),
        ));
    };
    let db_lower = database.trim().to_ascii_lowercase();
    let tbl_lower = table_name.trim().to_ascii_lowercase();
    let vid = version_id.trim();
    if db_lower.is_empty() || tbl_lower.is_empty() || vid.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "database、tableName 与 versionId 均不能为空".into(),
        ));
    }

    let row = sqlx::query(
        "SELECT database, table_name, backup_ts, rel_path \
         FROM table_backup_versions \
         WHERE version_id = ? AND db_lower = ? AND table_lower = ?",
    )
    .bind(vid)
    .bind(&db_lower)
    .bind(&tbl_lower)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("查询单表备份版本失败: {e}"),
        )
    })?
    .ok_or_else(|| (StatusCode::NOT_FOUND, "未找到指定的单表备份版本".into()))?;

    let actual_db: String = row.try_get("database").unwrap_or_default();
    let actual_tbl: String = row.try_get("table_name").unwrap_or_default();
    let backup_ts: String = row.try_get("backup_ts").unwrap_or_default();
    let rel_path: String = row.try_get("rel_path").unwrap_or_default();

    let root_owned = store_root.clone();
    let sql = tokio::task::spawn_blocking(move || {
        let full_path = safe_resolve_stored_file(&root_owned, &rel_path)?;
        let file = File::open(&full_path).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("打开单表备份文件失败: {e}"),
            )
        })?;
        let mut decoder = GzDecoder::new(BufReader::new(file));
        let mut text = String::new();
        decoder.read_to_string(&mut text).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("解压单表备份 SQL 失败: {e}"),
            )
        })?;
        Ok::<String, (StatusCode, String)>(text)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("读取单表备份任务异常: {e}"),
        )
    })??;

    Ok(GmTableBackupExtractResponse {
        database: actual_db,
        table_name: actual_tbl,
        version_id: vid.to_string(),
        ts: backup_ts,
        sql,
    })
}

pub async fn has_any_completed_run(pool: &SqlitePool) -> bool {
    sqlx::query_scalar::<_, i64>(
        "SELECT id FROM table_backup_runs WHERE status = 'ok' LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .is_some()
}

pub fn discover_tracked_databases(config: &TableBackupConfig, gm_dir: Option<&Path>) -> Vec<String> {
    let Some(root) = gm_dir else {
        return Vec::new();
    };
    if !root.is_dir() {
        return Vec::new();
    }
    let Ok(by_db) = discover_latest_archives_by_db(root, config) else {
        return Vec::new();
    };
    let mut set = BTreeSet::new();
    for list in by_db.values() {
        if let Some(first) = list.first() {
            set.insert(first.parsed.database.clone());
        }
    }
    set.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connect;
    use zip::write::SimpleFileOptions;

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "blackcat-tb-{prefix}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_zip_dump(zip_path: &Path, sql_name: &str, sql: &str) {
        fs::create_dir_all(zip_path.parent().unwrap()).unwrap();
        let file = File::create(zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(sql_name, SimpleFileOptions::default())
            .unwrap();
        zip.write_all(sql.as_bytes()).unwrap();
        zip.finish().unwrap();
    }

    fn dump_two_tables(
        hero_val: &str,
        hero_auto_inc: u32,
        include_skill: bool,
        skill_extra_col: bool,
        dump_time: &str,
    ) -> String {
        let mut sql = format!(
            "-- MySQL dump 10.13\n-- Host: localhost Database: newsg_4cfg\n\n\
             -- Table structure for table `heroprop`\n\
             DROP TABLE IF EXISTS `heroprop`;\n\
             CREATE TABLE `heroprop` (\n\
               `ID` int NOT NULL,\n\
               `Name` varchar(64) NOT NULL,\n\
               PRIMARY KEY (`ID`)\n\
             ) ENGINE=InnoDB AUTO_INCREMENT={hero_auto_inc} DEFAULT CHARSET=utf8mb4;\n\
             -- Dumping data for table `heroprop`\n\
             LOCK TABLES `heroprop` WRITE;\n\
             INSERT INTO `heroprop` VALUES (1,'{hero_val}');\n\
             UNLOCK TABLES;\n"
        );
        if include_skill {
            let extra = if skill_extra_col {
                ",\n  `Power` int DEFAULT 0"
            } else {
                ""
            };
            let val = if skill_extra_col {
                "(10,'Slash',99)"
            } else {
                "(10,'Slash')"
            };
            sql.push_str(&format!(
                "\n-- Table structure for table `skillprop`\n\
                 DROP TABLE IF EXISTS `skillprop`;\n\
                 CREATE TABLE `skillprop` (\n\
                   `ID` int NOT NULL,\n\
                   `Name` varchar(64) NOT NULL{extra},\n\
                   PRIMARY KEY (`ID`)\n\
                 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\
                 -- Dumping data for table `skillprop`\n\
                 INSERT INTO `skillprop` VALUES {val};\n"
            ));
        }
        sql.push_str(&format!("\n-- Dump completed on {dump_time}\n"));
        sql
    }

    #[tokio::test]
    async fn per_table_backup_skips_unchanged_caps_versions_preserves_deleted_and_filters_config_dbs() {
        let gm_dir = make_temp_dir("gm");
        let store_dir = make_temp_dir("store");
        let pool = connect("sqlite::memory:").await.unwrap();

        let cfg = TableBackupConfig {
            backup_dir: Some(store_dir.clone()),
            max_versions: 3, // small cap to test FIFO eviction
            max_table_bytes: DEFAULT_MAX_TABLE_BYTES,
            min_archive_age_secs: 0,
            tz_offset_hours: 8,
            database_whitelist: None,
        };

        // Non-config DBs (player/log) must be excluded by default; config DBs included.
        assert!(cfg.should_include_database("newsg_4cfg"));
        assert!(cfg.should_include_database("plat_ad_101_actcfg"));
        assert!(!cfg.should_include_database("newsg_player"));
        assert!(!cfg.should_include_database("newsg_cfg_log"));

        let now = Utc::now();

        // Day 1: baseline with heroprop + skillprop, plus an ignored player DB zip.
        write_zip_dump(
            &gm_dir.join("2026-11-01/0/192.168.1.243_mysql_newsg_4cfg_2026-11-01-00_50_02.zip"),
            "newsg_4cfg.sql",
            &dump_two_tables("Arthur", 10, true, false, "2026-11-01 00:50:02"),
        );
        write_zip_dump(
            &gm_dir.join("2026-11-01/0/192.168.1.243_mysql_game_player_2026-11-01-00_50_02.zip"),
            "game_player.sql",
            &dump_two_tables("Player1", 1, false, false, "2026-11-01 00:50:02"),
        );

        let r1 = run_per_table_backup_pass(&pool, Some(&gm_dir), &cfg, now)
            .await
            .unwrap();
        assert_eq!(r1.databases_scanned, 1);
        assert_eq!(r1.tables_scanned, 2);
        assert_eq!(r1.tables_changed, 2);

        // Day 2: ONLY AUTO_INCREMENT & dump timestamp changed => ZERO new versions!
        write_zip_dump(
            &gm_dir.join("2026-11-02/0/192.168.1.243_mysql_newsg_4cfg_2026-11-02-00_50_02.zip"),
            "newsg_4cfg.sql",
            &dump_two_tables("Arthur", 99, true, false, "2026-11-02 00:50:02"),
        );
        let r2 = run_per_table_backup_pass(&pool, Some(&gm_dir), &cfg, now)
            .await
            .unwrap();
        assert_eq!(r2.tables_changed, 0);

        // Day 3: heroprop data changes + skillprop schema changes.
        write_zip_dump(
            &gm_dir.join("2026-11-03/0/192.168.1.243_mysql_newsg_4cfg_2026-11-03-00_50_02.zip"),
            "newsg_4cfg.sql",
            &dump_two_tables("Arthur v2", 99, true, true, "2026-11-03 00:50:02"),
        );
        let r3 = run_per_table_backup_pass(&pool, Some(&gm_dir), &cfg, now)
            .await
            .unwrap();
        assert_eq!(r3.tables_changed, 2);

        // Day 4: heroprop changes again (v3), and skillprop is DROPPED!
        write_zip_dump(
            &gm_dir.join("2026-11-04/0/192.168.1.243_mysql_newsg_4cfg_2026-11-04-00_50_02.zip"),
            "newsg_4cfg.sql",
            &dump_two_tables("Arthur v3", 99, false, false, "2026-11-04 00:50:02"),
        );
        let r4 = run_per_table_backup_pass(&pool, Some(&gm_dir), &cfg, now)
            .await
            .unwrap();
        assert_eq!(r4.tables_changed, 1);
        assert_eq!(r4.tables_missing, 1);

        // Day 5: heroprop changes a 4th time => cap of 3 evicts Day 1 version!
        write_zip_dump(
            &gm_dir.join("2026-11-05/0/192.168.1.243_mysql_newsg_4cfg_2026-11-05-00_50_02.zip"),
            "newsg_4cfg.sql",
            &dump_two_tables("Arthur v4", 99, false, false, "2026-11-05 00:50:02"),
        );
        let _ = run_per_table_backup_pass(&pool, Some(&gm_dir), &cfg, now)
            .await
            .unwrap();

        let listed = list_table_backups(&pool, &cfg, Some("newsg_4cfg"), None, true)
            .await
            .unwrap();
        assert_eq!(listed.items.len(), 2);

        let hero_versions = list_table_backup_versions(&pool, &cfg, "newsg_4cfg", "heroprop")
            .await
            .unwrap();
        assert!(hero_versions.present_in_latest);
        assert_eq!(hero_versions.versions.len(), 3);
        assert_eq!(hero_versions.versions[0].backup_date, "2026-11-05");
        assert_eq!(hero_versions.versions[2].backup_date, "2026-11-03");

        // Dropped skillprop keeps ALL of its versions and flags present_in_latest = false + schema_changed!
        let skill_versions = list_table_backup_versions(&pool, &cfg, "newsg_4cfg", "skillprop")
            .await
            .unwrap();
        assert!(!skill_versions.present_in_latest);
        assert_eq!(skill_versions.versions.len(), 2);
        assert!(skill_versions.versions[0].schema_changed);

        // Extract SQL for dropped skillprop still works cleanly!
        let extracted = extract_table_backup_sql(
            &pool,
            &cfg,
            "newsg_4cfg",
            "skillprop",
            &skill_versions.versions[0].version_id,
        )
        .await
        .unwrap();
        assert!(extracted.sql.contains("CREATE TABLE `skillprop`"));
        assert!(extracted.sql.contains("'Slash',99"));

        let _ = fs::remove_dir_all(&gm_dir);
        let _ = fs::remove_dir_all(&store_dir);
    }
}
