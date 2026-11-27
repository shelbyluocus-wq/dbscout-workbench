//! Strictly read-only access to GM's hourly MySQL backup archives stored on
//! 192.168.1.243 under `/home/servbin/dbback`.
//!
//! Layout observed on 243:
//!   `/home/servbin/dbback/<YYYY-MM-DD>/<Hour>/<host>_mysql_<database>_<YYYY-MM-DD>-<HH>_<MM>_<SS>.zip`
//! where `<Hour>` is `0`..`23` (no leading zero) and each `.zip` holds a
//! standard `mysqldump` `.sql` file. MongoDB and Redis zips in the same
//! directory are ignored.
//!
//! Security & safety guarantees:
//! - Never writes, renames, or deletes anything inside the backup directory.
//! - Rejects path traversal, symlinks escaping the backup root, non-MySQL
//!   archives, and invalid date/hour segments before opening any file.
//! - Parses table boundaries with a single-quote-aware scanner so game text or
//!   column comments containing SQL keywords or `--` markers cannot corrupt
//!   single-table extraction.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use axum::http::StatusCode;
use chrono::{NaiveDate, NaiveDateTime};
use zip::ZipArchive;

use crate::models::{
    GmBackupExtractResponse, GmBackupItem, GmBackupListResponse, GmBackupTableInfo,
    GmBackupTablesResponse,
};

pub const DEFAULT_GM_BACKUP_DIR: &str = "/home/servbin/dbback";
const DEFAULT_LIST_LIMIT: usize = 200;
const MAX_LIST_LIMIT: usize = 1000;
const TABLE_CACHE_MAX_ENTRIES: usize = 256;

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct TableCacheKey {
    path: PathBuf,
    mtime_secs: u64,
    size_bytes: u64,
}

#[derive(Clone, Default)]
pub struct GmBackupTableCache {
    entries: Arc<Mutex<HashMap<TableCacheKey, Vec<GmBackupTableInfo>>>>,
}

impl GmBackupTableCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, key: &TableCacheKey) -> Option<Vec<GmBackupTableInfo>> {
        self.entries.lock().ok()?.get(key).cloned()
    }

    fn insert(&self, key: TableCacheKey, tables: Vec<GmBackupTableInfo>) {
        let Ok(mut guard) = self.entries.lock() else {
            return;
        };
        if guard.len() >= TABLE_CACHE_MAX_ENTRIES && !guard.contains_key(&key) {
            guard.clear();
        }
        guard.insert(key, tables);
    }
}

/// Resolve the GM hourly backup root from `DBSCOUT_SERVER_GM_BACKUP_DIR`,
/// falling back to `/home/servbin/dbback` when that directory exists on disk.
pub fn resolve_gm_backup_dir() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("DBSCOUT_SERVER_GM_BACKUP_DIR") {
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
    let default_path = PathBuf::from(DEFAULT_GM_BACKUP_DIR);
    if default_path.is_dir() {
        Some(default_path)
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMysqlBackupName {
    pub host: String,
    pub database: String,
    /// Wall-clock timestamp formatted as `YYYY-MM-DD HH:MM:SS` (server local time).
    pub ts: String,
}

/// Parse `<host>_mysql_<database>_<YYYY-MM-DD>-<HH>_<MM>_<SS>.zip`.
///
/// Anchors on `_mysql_` and the fixed 20-byte `_YYYY-MM-DD-HH_MM_SS` tail so
/// database names containing underscores (e.g. `newsg_4cfg`,
/// `plat_ad_101_actcfg`) parse unambiguously, while `*_mongodb_*` and
/// `*_redis_*` archives return `None`.
pub fn parse_mysql_backup_filename(file_name: &str) -> Option<ParsedMysqlBackupName> {
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains('\0') {
        return None;
    }
    let stem = file_name
        .strip_suffix(".zip")
        .or_else(|| file_name.strip_suffix(".ZIP"))?;
    let marker = "_mysql_";
    let marker_idx = stem.find(marker)?;
    let host = &stem[..marker_idx];
    if host.is_empty() {
        return None;
    }
    let rest = &stem[marker_idx + marker.len()..];
    // Tail format: `_YYYY-MM-DD-HH_MM_SS` => 20 ASCII bytes.
    const TAIL_LEN: usize = 20;
    if rest.len() <= TAIL_LEN || !rest.is_char_boundary(rest.len() - TAIL_LEN) {
        return None;
    }
    let split_idx = rest.len() - TAIL_LEN;
    if rest.as_bytes()[split_idx] != b'_' {
        return None;
    }
    let database = &rest[..split_idx];
    if database.is_empty() {
        return None;
    }
    let ts_raw = &rest[split_idx + 1..];
    let parsed_dt = NaiveDateTime::parse_from_str(ts_raw, "%Y-%m-%d-%H_%M_%S").ok()?;
    Some(ParsedMysqlBackupName {
        host: host.to_string(),
        database: database.to_string(),
        ts: parsed_dt.format("%Y-%m-%d %H:%M:%S").to_string(),
    })
}

pub(crate) fn is_valid_date_segment(date: &str) -> bool {
    date.len() == 10
        && !date.contains('/')
        && !date.contains('\\')
        && NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
}

pub(crate) fn is_valid_hour_segment(hour: &str) -> bool {
    if hour.is_empty() || hour.len() > 2 || !hour.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    hour.parse::<u8>().map(|h| h <= 23).unwrap_or(false)
}

fn resolve_safe_archive_path(
    root: &Path,
    date: &str,
    hour: &str,
    file_name: &str,
) -> Result<(PathBuf, ParsedMysqlBackupName), (StatusCode, String)> {
    if !root.is_dir() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "服务端未启用或无法访问 GM 定时备份目录".into(),
        ));
    }
    if !is_valid_date_segment(date) {
        return Err((StatusCode::BAD_REQUEST, "日期格式无效，应为 YYYY-MM-DD".into()));
    }
    if !is_valid_hour_segment(hour) {
        return Err((StatusCode::BAD_REQUEST, "小时目录格式无效，应为 0-23".into()));
    }
    let parsed = parse_mysql_backup_filename(file_name).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "备份文件名格式无效或不是 MySQL 备份文件".into(),
        )
    })?;

    let canon_root = std::fs::canonicalize(root).map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("无法读取备份目录: {e}"),
        )
    })?;
    let candidate = root.join(date).join(hour).join(file_name);
    let canon_candidate = std::fs::canonicalize(&candidate).map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            format!("未找到备份文件: {date}/{hour}/{file_name}"),
        )
    })?;
    if !canon_candidate.starts_with(&canon_root) {
        return Err((StatusCode::FORBIDDEN, "拒绝访问备份目录之外的路径".into()));
    }
    if !canon_candidate.is_file() {
        return Err((StatusCode::NOT_FOUND, "目标备份不是有效文件".into()));
    }
    Ok((canon_candidate, parsed))
}

/// List available MySQL hourly backups under `root` (metadata-only, no unzip).
pub fn list_backups(
    root: Option<&Path>,
    database_filter: Option<&str>,
    date_filter: Option<&str>,
    limit: Option<usize>,
) -> Result<GmBackupListResponse, (StatusCode, String)> {
    let Some(root) = root else {
        return Ok(GmBackupListResponse {
            enabled: false,
            backup_dir_configured: false,
            databases: Vec::new(),
            dates: Vec::new(),
            items: Vec::new(),
        });
    };
    if !root.is_dir() {
        return Ok(GmBackupListResponse {
            enabled: false,
            backup_dir_configured: true,
            databases: Vec::new(),
            dates: Vec::new(),
            items: Vec::new(),
        });
    }

    let db_filter = database_filter
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let date_filter = date_filter
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(date) = date_filter {
        if !is_valid_date_segment(date) {
            return Err((StatusCode::BAD_REQUEST, "日期筛选格式无效，应为 YYYY-MM-DD".into()));
        }
    }
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);

    let mut all_dates: BTreeSet<String> = BTreeSet::new();
    let mut all_databases: BTreeSet<String> = BTreeSet::new();
    let mut matched: Vec<(GmBackupItem, PathBuf)> = Vec::new();

    let date_entries = std::fs::read_dir(root).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("读取备份根目录失败: {e}"),
        )
    })?;

    for date_entry in date_entries.flatten() {
        let date_name = date_entry.file_name().to_string_lossy().into_owned();
        if !is_valid_date_segment(&date_name) {
            continue;
        }
        let date_path = date_entry.path();
        if !date_path.is_dir() {
            continue;
        }
        all_dates.insert(date_name.clone());

        let date_matches = date_filter.map(|f| f == date_name).unwrap_or(true);
        let Ok(hour_entries) = std::fs::read_dir(&date_path) else {
            continue;
        };
        for hour_entry in hour_entries.flatten() {
            let hour_name = hour_entry.file_name().to_string_lossy().into_owned();
            if !is_valid_hour_segment(&hour_name) {
                continue;
            }
            let hour_path = hour_entry.path();
            if !hour_path.is_dir() {
                continue;
            }
            let Ok(file_entries) = std::fs::read_dir(&hour_path) else {
                continue;
            };
            for file_entry in file_entries.flatten() {
                let file_name = file_entry.file_name().to_string_lossy().into_owned();
                let Some(parsed) = parse_mysql_backup_filename(&file_name) else {
                    continue;
                };
                all_databases.insert(parsed.database.clone());
                if !date_matches {
                    continue;
                }
                if let Some(filter_db) = db_filter {
                    if !parsed.database.eq_ignore_ascii_case(filter_db) {
                        continue;
                    }
                }
                matched.push((
                    GmBackupItem {
                        date: date_name.clone(),
                        hour: hour_name.clone(),
                        file_name,
                        host: parsed.host,
                        database: parsed.database,
                        ts: parsed.ts,
                        size_bytes: 0,
                    },
                    file_entry.path(),
                ));
            }
        }
    }

    matched.sort_by(|(a, _), (b, _)| b.ts.cmp(&a.ts).then_with(|| b.file_name.cmp(&a.file_name)));
    matched.truncate(limit);

    let mut items = Vec::with_capacity(matched.len());
    for (mut item, path) in matched {
        item.size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        items.push(item);
    }

    let dates: Vec<String> = all_dates.into_iter().rev().collect();
    let databases: Vec<String> = all_databases.into_iter().collect();

    Ok(GmBackupListResponse {
        enabled: true,
        backup_dir_configured: true,
        databases,
        dates,
        items,
    })
}

fn is_sql_zip_entry(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && !trimmed.ends_with('/')
        && !trimmed.starts_with("__MACOSX/")
        && trimmed.to_ascii_lowercase().ends_with(".sql")
}

pub(crate) fn sql_entry_indices(archive: &mut ZipArchive<File>) -> Result<Vec<usize>, (StatusCode, String)> {
    let mut entries: Vec<(String, usize)> = Vec::new();
    for idx in 0..archive.len() {
        let entry = archive.by_index(idx).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("读取备份压缩包目录失败: {e}"),
            )
        })?;
        if is_sql_zip_entry(entry.name()) {
            entries.push((entry.name().to_string(), idx));
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    if entries.is_empty() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "备份压缩包内未找到 .sql 文件".into(),
        ));
    }
    Ok(entries.into_iter().map(|(_, idx)| idx).collect())
}

/// Extract a backtick-quoted identifier immediately following `prefix`.
fn extract_backtick_ident(line: &str, prefix: &str) -> Option<String> {
    let rest = line.strip_prefix(prefix)?;
    let start = rest.find('`')?;
    let after = &rest[start + 1..];
    let end = after.find('`')?;
    let ident = &after[..end];
    if ident.is_empty() {
        None
    } else {
        Some(ident.to_string())
    }
}

/// Extract a table name from a SQL statement line such as:
/// - `DROP TABLE IF EXISTS \`foo\`;`
/// - `CREATE TABLE \`foo\` (`
/// - `CREATE TABLE IF NOT EXISTS \`foo\` (`
/// - `INSERT INTO \`foo\` ...`
pub(crate) fn extract_statement_table_name(trimmed: &str) -> Option<(&'static str, String)> {
    let upper = trimmed.to_ascii_uppercase();
    for (kind, prefix) in [
        ("drop", "DROP TABLE IF EXISTS "),
        ("create", "CREATE TABLE IF NOT EXISTS "),
        ("create", "CREATE TABLE "),
        ("insert", "INSERT INTO "),
        ("insert", "INSERT IGNORE INTO "),
        ("insert", "REPLACE INTO "),
    ] {
        if upper.starts_with(prefix) {
            let tail = trimmed[prefix.len()..].trim_start();
            if let Some(after_tick) = tail.strip_prefix('`') {
                if let Some(end) = after_tick.find('`') {
                    let name = &after_tick[..end];
                    if !name.is_empty() {
                        return Some((kind, name.to_string()));
                    }
                }
            } else {
                let name: String = tail
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
                    .collect();
                if !name.is_empty() {
                    return Some((kind, name));
                }
            }
        }
    }
    None
}

pub(crate) enum DumpLineMarker {
    TableStructure(String),
    TableData(String),
    NonTableSection,
}

pub(crate) fn parse_mysqldump_section_marker(trimmed: &str) -> Option<DumpLineMarker> {
    if let Some(name) = extract_backtick_ident(trimmed, "-- Table structure for table ") {
        return Some(DumpLineMarker::TableStructure(name));
    }
    if let Some(name) = extract_backtick_ident(trimmed, "-- Dumping data for table ") {
        return Some(DumpLineMarker::TableData(name));
    }
    if trimmed.starts_with("-- Temporary view structure for view ")
        || trimmed.starts_with("-- Final view structure for view ")
        || trimmed.starts_with("-- Dumping routines for database")
        || trimmed.starts_with("-- Dumping events for database")
        || trimmed.starts_with("-- Dump completed on")
        || trimmed.starts_with("-- Current Database:")
    {
        return Some(DumpLineMarker::NonTableSection);
    }
    None
}

/// Advance single-quoted SQL string literal state across one line.
/// Handles MySQL backslash escapes (`\'`, `\\`) AND doubled single quotes (`''`).
pub(crate) fn advance_sql_quote_state(line: &str, in_single_quote: &mut bool) {
    let bytes = line.as_bytes();
    let mut i = 0;
    let mut escaped = false;
    while i < bytes.len() {
        let b = bytes[i];
        if *in_single_quote {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'\'' {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                    i += 1;
                } else {
                    *in_single_quote = false;
                }
            }
        } else {
            // Stop scanning at `-- ` or `#` comments outside quotes.
            if b == b'#'
                || (b == b'-'
                    && i + 1 < bytes.len()
                    && bytes[i + 1] == b'-'
                    && (i + 2 == bytes.len()
                        || matches!(bytes[i + 2], b' ' | b'\t' | b'\r' | b'\n')))
            {
                break;
            }
            if b == b'\'' {
                *in_single_quote = true;
            }
        }
        i += 1;
    }
}

fn scan_tables_in_reader<R: BufRead>(
    reader: R,
    order: &mut Vec<String>,
    stats: &mut HashMap<String, GmBackupTableInfo>,
) -> Result<(), (StatusCode, String)> {
    let mut current_key: Option<String> = None;
    let mut in_single_quote = false;
    let mut raw_buf = Vec::with_capacity(8192);
    let mut reader = reader;

    loop {
        raw_buf.clear();
        let bytes_read = reader.read_until(b'\n', &mut raw_buf).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("读取备份 SQL 内容失败: {e}"),
            )
        })?;
        if bytes_read == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&raw_buf);
        let line_len = bytes_read as u64;

        if !in_single_quote {
            let trimmed = line.trim();
            if let Some(marker) = parse_mysqldump_section_marker(trimmed) {
                match marker {
                    DumpLineMarker::TableStructure(name) | DumpLineMarker::TableData(name) => {
                        let key = name.to_ascii_lowercase();
                        if !stats.contains_key(&key) {
                            order.push(key.clone());
                            stats.insert(
                                key.clone(),
                                GmBackupTableInfo {
                                    name,
                                    has_data: false,
                                    insert_batches: 0,
                                    approx_bytes: 0,
                                },
                            );
                        }
                        current_key = Some(key);
                    }
                    DumpLineMarker::NonTableSection => {
                        current_key = None;
                    }
                }
            } else if let Some((kind, name)) = extract_statement_table_name(trimmed) {
                let key = name.to_ascii_lowercase();
                if !stats.contains_key(&key) {
                    order.push(key.clone());
                    stats.insert(
                        key.clone(),
                        GmBackupTableInfo {
                            name,
                            has_data: false,
                            insert_batches: 0,
                            approx_bytes: 0,
                        },
                    );
                }
                if kind == "insert" {
                    if let Some(info) = stats.get_mut(&key) {
                        info.has_data = true;
                        info.insert_batches = info.insert_batches.saturating_add(1);
                    }
                }
                current_key = Some(key);
            }
        }

        if let Some(key) = current_key.as_ref() {
            if let Some(info) = stats.get_mut(key) {
                info.approx_bytes = info.approx_bytes.saturating_add(line_len);
            }
        }
        advance_sql_quote_state(&line, &mut in_single_quote);
    }

    Ok(())
}

/// Inspect the table list inside a specific GM MySQL backup `.zip`.
pub fn list_backup_tables(
    root: Option<&Path>,
    cache: &GmBackupTableCache,
    date: &str,
    hour: &str,
    file_name: &str,
) -> Result<GmBackupTablesResponse, (StatusCode, String)> {
    let root = root.ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "服务端未启用 GM 定时备份目录".into(),
        )
    })?;
    let (archive_path, parsed) = resolve_safe_archive_path(root, date, hour, file_name)?;
    let meta = std::fs::metadata(&archive_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("读取备份文件属性失败: {e}"),
        )
    })?;
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cache_key = TableCacheKey {
        path: archive_path.clone(),
        mtime_secs,
        size_bytes: meta.len(),
    };

    if let Some(cached) = cache.get(&cache_key) {
        return Ok(GmBackupTablesResponse {
            database: parsed.database,
            ts: parsed.ts,
            tables: cached,
        });
    }

    let file = File::open(&archive_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("打开备份文件失败: {e}"),
        )
    })?;
    let mut archive = ZipArchive::new(file).map_err(|e| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("解析备份压缩包失败: {e}"),
        )
    })?;
    let indices = sql_entry_indices(&mut archive)?;

    let mut order = Vec::new();
    let mut stats = HashMap::new();
    for idx in indices {
        let entry = archive.by_index(idx).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("打开压缩包内 SQL 文件失败: {e}"),
            )
        })?;
        let reader = BufReader::with_capacity(64 * 1024, entry);
        scan_tables_in_reader(reader, &mut order, &mut stats)?;
    }

    let tables: Vec<GmBackupTableInfo> = order
        .into_iter()
        .filter_map(|key| stats.remove(&key))
        .collect();
    cache.insert(cache_key, tables.clone());

    Ok(GmBackupTablesResponse {
        database: parsed.database,
        ts: parsed.ts,
        tables,
    })
}

pub(crate) fn is_lock_statement(trimmed: &str) -> bool {
    let upper = trimmed.to_ascii_uppercase();
    upper.starts_with("LOCK TABLES ") || upper.starts_with("UNLOCK TABLES")
}

fn extract_tables_from_reader<R: BufRead>(
    reader: R,
    requested: &HashSet<String>,
    out_sql: &mut String,
    found_order: &mut Vec<String>,
    found_keys: &mut HashSet<String>,
) -> Result<(), (StatusCode, String)> {
    let mut current_key: Option<String> = None;
    let mut capturing = false;
    let mut in_single_quote = false;
    let mut raw_buf = Vec::with_capacity(8192);
    let mut reader = reader;

    loop {
        raw_buf.clear();
        let bytes_read = reader.read_until(b'\n', &mut raw_buf).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("读取备份 SQL 内容失败: {e}"),
            )
        })?;
        if bytes_read == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&raw_buf);

        if !in_single_quote {
            let trimmed = line.trim();
            if let Some(marker) = parse_mysqldump_section_marker(trimmed) {
                match marker {
                    DumpLineMarker::TableStructure(name) | DumpLineMarker::TableData(name) => {
                        let key = name.to_ascii_lowercase();
                        capturing = requested.contains(&key);
                        current_key = Some(key.clone());
                        if capturing && found_keys.insert(key) {
                            found_order.push(name);
                        }
                    }
                    DumpLineMarker::NonTableSection => {
                        capturing = false;
                        current_key = None;
                    }
                }
            } else if let Some((_, name)) = extract_statement_table_name(trimmed) {
                let key = name.to_ascii_lowercase();
                if current_key.as_deref() != Some(key.as_str()) {
                    capturing = requested.contains(&key);
                    current_key = Some(key.clone());
                    if capturing && found_keys.insert(key) {
                        found_order.push(name);
                    }
                }
            }
        }

        if capturing {
            // Skip LOCK TABLES / UNLOCK TABLES so single-table restore does not
            // stall concurrent readers or fail under restricted privileges.
            let should_skip = !in_single_quote && is_lock_statement(line.trim());
            if !should_skip {
                out_sql.push_str(&line);
                if !line.ends_with('\n') {
                    out_sql.push('\n');
                }
            }
        }

        advance_sql_quote_state(&line, &mut in_single_quote);
    }

    Ok(())
}

/// Extract either the full `.sql` dump (`tables` empty) or only the requested
/// tables (`tables` non-empty) from a GM MySQL backup `.zip`.
pub fn extract_backup_sql(
    root: Option<&Path>,
    date: &str,
    hour: &str,
    file_name: &str,
    tables: &[String],
) -> Result<GmBackupExtractResponse, (StatusCode, String)> {
    let root = root.ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "服务端未启用 GM 定时备份目录".into(),
        )
    })?;
    let (archive_path, parsed) = resolve_safe_archive_path(root, date, hour, file_name)?;

    let file = File::open(&archive_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("打开备份文件失败: {e}"),
        )
    })?;
    let mut archive = ZipArchive::new(file).map_err(|e| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("解析备份压缩包失败: {e}"),
        )
    })?;
    let indices = sql_entry_indices(&mut archive)?;

    let requested_clean: Vec<String> = tables
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if requested_clean.is_empty() {
        let mut full_sql = String::new();
        let mut order = Vec::new();
        let mut stats = HashMap::new();
        for idx in indices {
            let entry = archive.by_index(idx).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("打开压缩包内 SQL 文件失败: {e}"),
                )
            })?;
            let mut reader = BufReader::with_capacity(64 * 1024, entry);
            let mut raw = Vec::new();
            std::io::Read::read_to_end(&mut reader, &mut raw).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("解压备份 SQL 失败: {e}"),
                )
            })?;
            let text = String::from_utf8_lossy(&raw);
            scan_tables_in_reader(BufReader::new(text.as_bytes()), &mut order, &mut stats)?;
            full_sql.push_str(&text);
            if !full_sql.ends_with('\n') {
                full_sql.push('\n');
            }
        }
        if full_sql.trim().is_empty() {
            return Err((StatusCode::UNPROCESSABLE_ENTITY, "备份 SQL 文件为空".into()));
        }
        let table_names = order
            .into_iter()
            .filter_map(|key| stats.remove(&key).map(|info| info.name))
            .collect();
        return Ok(GmBackupExtractResponse {
            database: parsed.database,
            ts: parsed.ts,
            tables: table_names,
            sql: full_sql,
        });
    }

    let requested_set: HashSet<String> = requested_clean
        .iter()
        .map(|name| name.to_ascii_lowercase())
        .collect();
    let mut body = String::new();
    let mut found_order = Vec::new();
    let mut found_keys = HashSet::new();

    for idx in indices {
        let entry = archive.by_index(idx).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("打开压缩包内 SQL 文件失败: {e}"),
            )
        })?;
        let reader = BufReader::with_capacity(64 * 1024, entry);
        extract_tables_from_reader(
            reader,
            &requested_set,
            &mut body,
            &mut found_order,
            &mut found_keys,
        )?;
    }

    let missing: Vec<String> = requested_clean
        .iter()
        .filter(|name| !found_keys.contains(&name.to_ascii_lowercase()))
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("该备份中未找到以下数据表: {}", missing.join(", ")),
        ));
    }

    let mut sql = String::with_capacity(body.len() + 256);
    sql.push_str(&format!(
        "-- Extracted from 243 GM backup: {} ({})\n",
        file_name, parsed.ts
    ));
    sql.push_str("SET NAMES utf8mb4;\n");
    sql.push_str("SET FOREIGN_KEY_CHECKS=0;\n");
    sql.push_str("SET UNIQUE_CHECKS=0;\n");
    sql.push_str("SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n\n");
    sql.push_str(&body);
    sql.push_str("\nSET FOREIGN_KEY_CHECKS=1;\n");
    sql.push_str("SET UNIQUE_CHECKS=1;\n");

    Ok(GmBackupExtractResponse {
        database: parsed.database,
        ts: parsed.ts,
        tables: found_order,
        sql,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn sample_mysqldump() -> String {
        r#"-- MySQL dump 10.13  Distrib 8.4.10, for Linux (x86_64)
--
-- Host: localhost    Database: newsgcfg
-- ------------------------------------------------------
-- Server version	8.4.10

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!50503 SET NAMES utf8 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;

--
-- Table structure for table `activentranceprop`
--

DROP TABLE IF EXISTS `activentranceprop`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `activentranceprop` (
  `Entrance` int NOT NULL COMMENT '活动入口类型ID，\r\n-- Dump completed on fake comment line',
  `Icon` text NOT NULL COMMENT '功能图标ID,填写完整图标名common\\functionButton\\',
  PRIMARY KEY (`Entrance`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `activentranceprop`
--

LOCK TABLES `activentranceprop` WRITE;
/*!40000 ALTER TABLE `activentranceprop` DISABLE KEYS */;
INSERT INTO `activentranceprop` VALUES (1,'common\\functionButton\\'),(2,'line1\n-- Table structure for table `fake`');
/*!40000 ALTER TABLE `activentranceprop` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `heroprop`
--

DROP TABLE IF EXISTS `heroprop`;
CREATE TABLE `heroprop` (
  `HeroID` int NOT NULL,
  `Name` varchar(64) NOT NULL,
  PRIMARY KEY (`HeroID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `heroprop`
--

LOCK TABLES `heroprop` WRITE;
INSERT INTO `heroprop` VALUES (1001,'Arthur'),(1002,'Merlin');
UNLOCK TABLES;

--
-- Table structure for table `emptyprop`
--

DROP TABLE IF EXISTS `emptyprop`;
CREATE TABLE `emptyprop` (
  `ID` int NOT NULL,
  PRIMARY KEY (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `emptyprop`
--

LOCK TABLES `emptyprop` WRITE;
UNLOCK TABLES;
-- Dump completed on 2026-11-26  0:50:02
"#
        .to_string()
    }

    fn write_test_zip(path: &Path, entry_name: &str, sql_content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(entry_name, SimpleFileOptions::default())
            .unwrap();
        zip.write_all(sql_content.as_bytes()).unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn parse_mysql_backup_filename_handles_underscores_and_ignores_other_engines() {
        let simple = parse_mysql_backup_filename(
            "192.168.1.243_mysql_newsgcfg_2026-11-26-00_50_02.zip",
        )
        .unwrap();
        assert_eq!(simple.host, "192.168.1.243");
        assert_eq!(simple.database, "newsgcfg");
        assert_eq!(simple.ts, "2026-11-26 00:50:02");

        let underscored = parse_mysql_backup_filename(
            "192.168.1.243_mysql_plat_ad_101_actcfg_2026-11-26-13_10_05.zip",
        )
        .unwrap();
        assert_eq!(underscored.database, "plat_ad_101_actcfg");
        assert_eq!(underscored.ts, "2026-11-26 13:10:05");

        let four_cfg = parse_mysql_backup_filename(
            "192.168.1.243_mysql_newsg_4cfg_2026-11-26-14_50_01.zip",
        )
        .unwrap();
        assert_eq!(four_cfg.database, "newsg_4cfg");

        assert!(parse_mysql_backup_filename(
            "192.168.1.243_mongodb_newsg_gs101_2026-11-26-00_50_09.zip"
        )
        .is_none());
        assert!(parse_mysql_backup_filename(
            "192.168.1.243_redis_all_2026-11-26-00_50_10.zip"
        )
        .is_none());
        assert!(parse_mysql_backup_filename("../192.168.1.243_mysql_a_2026-11-26-00_50_02.zip")
            .is_none());
    }

    #[test]
    fn list_inspect_and_extract_single_table_and_full_db() {
        let root = std::env::temp_dir().join(format!("blackcat-gm-bk-{}", uuid::Uuid::new_v4()));
        let sql = sample_mysqldump();
        write_test_zip(
            &root.join("2026-11-26/0/192.168.1.243_mysql_newsgcfg_2026-11-26-00_50_02.zip"),
            "192.168.1.243_mysql_newsgcfg_2026-11-26-00_50_02/newsgcfg_2026-11-26-00_50_02.sql",
            &sql,
        );
        write_test_zip(
            &root.join("2026-11-26/13/192.168.1.243_mysql_plat_ad_101_actcfg_2026-11-26-13_10_05.zip"),
            "plat_ad_101_actcfg.sql",
            &sql,
        );
        // Non-MySQL archives must be ignored.
        write_test_zip(
            &root.join("2026-11-26/0/192.168.1.243_mongodb_newsg_gs101_2026-11-26-00_50_09.zip"),
            "dump.bson",
            "ignored",
        );

        let listed = list_backups(Some(&root), None, None, None).unwrap();
        assert!(listed.enabled);
        assert_eq!(listed.dates, vec!["2026-11-26"]);
        assert_eq!(listed.databases, vec!["newsgcfg", "plat_ad_101_actcfg"]);
        assert_eq!(listed.items.len(), 2);
        assert_eq!(listed.items[0].database, "plat_ad_101_actcfg");
        assert_eq!(listed.items[1].database, "newsgcfg");
        assert!(listed.items[1].size_bytes > 0);

        let filtered = list_backups(Some(&root), Some("newsgcfg"), None, None).unwrap();
        assert_eq!(filtered.items.len(), 1);
        assert_eq!(filtered.databases, vec!["newsgcfg", "plat_ad_101_actcfg"]);

        let cache = GmBackupTableCache::new();
        let tables_resp = list_backup_tables(
            Some(&root),
            &cache,
            "2026-11-26",
            "0",
            "192.168.1.243_mysql_newsgcfg_2026-11-26-00_50_02.zip",
        )
        .unwrap();
        let names: Vec<&str> = tables_resp.tables.iter().map(|t| t.name.as_str()).collect();
        // Multiline string containing `-- Table structure for table \`fake\`` must NOT appear as a table!
        assert_eq!(names, vec!["activentranceprop", "heroprop", "emptyprop"]);
        assert!(tables_resp.tables[0].has_data);
        assert_eq!(tables_resp.tables[0].insert_batches, 1);
        assert!(tables_resp.tables[1].has_data);
        assert!(!tables_resp.tables[2].has_data);

        // Extract one table with tricky escaped backslashes and multiline comments.
        let extracted_one = extract_backup_sql(
            Some(&root),
            "2026-11-26",
            "0",
            "192.168.1.243_mysql_newsgcfg_2026-11-26-00_50_02.zip",
            &["activentranceprop".into()],
        )
        .unwrap();
        assert_eq!(extracted_one.tables, vec!["activentranceprop"]);
        assert!(extracted_one.sql.contains("CREATE TABLE `activentranceprop`"));
        assert!(extracted_one.sql.contains("common\\\\functionButton\\\\"));
        assert!(extracted_one.sql.contains("INSERT INTO `activentranceprop`"));
        assert!(!extracted_one.sql.contains("CREATE TABLE `heroprop`"));
        assert!(!extracted_one.sql.contains("LOCK TABLES"));
        assert!(!extracted_one.sql.contains("Dump completed on 2026-11-26"));

        // Extract another table (case-insensitive match).
        let extracted_hero = extract_backup_sql(
            Some(&root),
            "2026-11-26",
            "0",
            "192.168.1.243_mysql_newsgcfg_2026-11-26-00_50_02.zip",
            &["HeroProp".into()],
        )
        .unwrap();
        assert_eq!(extracted_hero.tables, vec!["heroprop"]);
        assert!(extracted_hero.sql.contains("INSERT INTO `heroprop`"));
        assert!(!extracted_hero.sql.contains("activentranceprop"));

        // Missing table returns 404.
        let err = extract_backup_sql(
            Some(&root),
            "2026-11-26",
            "0",
            "192.168.1.243_mysql_newsgcfg_2026-11-26-00_50_02.zip",
            &["does_not_exist".into()],
        )
        .unwrap_err();
        assert_eq!(err.0, StatusCode::NOT_FOUND);

        // Full database extract includes every table.
        let full = extract_backup_sql(
            Some(&root),
            "2026-11-26",
            "0",
            "192.168.1.243_mysql_newsgcfg_2026-11-26-00_50_02.zip",
            &[],
        )
        .unwrap();
        assert_eq!(full.tables, vec!["activentranceprop", "heroprop", "emptyprop"]);
        assert!(full.sql.contains("INSERT INTO `heroprop`"));

        // Path traversal is rejected.
        let bad_date = list_backup_tables(
            Some(&root),
            &cache,
            "../etc",
            "0",
            "192.168.1.243_mysql_newsgcfg_2026-11-26-00_50_02.zip",
        )
        .unwrap_err();
        assert_eq!(bad_date.0, StatusCode::BAD_REQUEST);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_backups_reports_disabled_gracefully_when_dir_absent() {
        let missing = std::env::temp_dir().join(format!("nonexistent-gm-bk-{}", uuid::Uuid::new_v4()));
        let resp = list_backups(Some(&missing), None, None, None).unwrap();
        assert!(!resp.enabled);
        assert!(resp.backup_dir_configured);
        assert!(resp.items.is_empty());

        let none_resp = list_backups(None, None, None, None).unwrap();
        assert!(!none_resp.enabled);
        assert!(!none_resp.backup_dir_configured);
    }
}
