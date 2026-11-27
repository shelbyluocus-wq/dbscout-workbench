use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use sqlx::{MySqlConnection, MySqlPool, Row};
use tauri::AppHandle;
use tokio::task::JoinSet;

use crate::backup;
use crate::db::{connect_database_with_max_connections, escape_ident};
use crate::mysql_text;
use crate::sync_guard::{run_with_heartbeat, GuardError};
use crate::sync_verification::{
    capture_table_fingerprint_with_columns, compare_fingerprints,
    list_all_fingerprint_columns, list_base_tables as list_verification_tables,
    list_table_fingerprint_columns, FingerprintColumn, MismatchKind, TableFingerprint,
    TableMismatch,
};
use crate::types::{
    BackupConfig, DatabaseSyncProgress, DatabaseSyncTablePlan, PreviewDatabaseSyncResponse,
    SnapshotInfo, SyncDatabaseOverwriteRequest, SyncDatabaseOverwriteResponse,
};
use crate::work_scheduler::WorkCancellation;

pub const DATABASE_SYNC_PROGRESS_EVENT: &str = "database-sync-progress";

const SYSTEM_DATABASES: &[&str] = &["information_schema", "mysql", "performance_schema", "sys"];
const MYSQL_SYNC_LOCK_WAIT_SECONDS: u64 = 15;
const SYNC_HEARTBEAT_SECONDS: u64 = 2;
const SYNC_DDL_TIMEOUT_SECONDS: u64 = 90;
const SYNC_COPY_TIMEOUT_SECONDS: u64 = 30 * 60;
const SYNC_VERIFY_TIMEOUT_SECONDS: u64 = 15 * 60;
const SYNC_BACKUP_TIMEOUT_SECONDS: u64 = 2 * 60 * 60;
const SYNC_RESTORE_TIMEOUT_SECONDS: u64 = 2 * 60 * 60;
const SYNC_LOCK_RETRY_ATTEMPTS: usize = 3;
const SYNC_WORKER_CONCURRENCY: usize = 8;
const SYNC_DROP_BATCH_SIZE: usize = 50;
const COUNT_ROWS_UNION_BATCH_SIZE: usize = 40;
const COUNT_ROWS_CONCURRENCY: usize = 4;
const SYNC_PROGRESS_THROTTLE: Duration = Duration::from_millis(80);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub extra: String,
    pub generation_expression: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncOutcome {
    Succeeded,
    Cancelled,
    CancelledRestored,
    CancelledRestoreFailed,
    FailedRestored,
    FailedRestoreFailed,
}

#[derive(Debug, Clone)]
pub struct SyncError {
    message: String,
    requires_restore: bool,
}

impl SyncError {
    fn without_restore(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            requires_restore: false,
        }
    }

    fn requires_restore(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            requires_restore: true,
        }
    }
}

fn sync_panic_error(payload: Box<dyn std::any::Any + Send>, snapshot_created: bool) -> SyncError {
    let detail = payload
        .downcast_ref::<&str>()
        .map(|value| (*value).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "未知内部异常".into());
    let message = format!("覆盖同步发生内部异常: {detail}");
    if snapshot_created {
        SyncError::requires_restore(message)
    } else {
        SyncError::without_restore(message)
    }
}

#[derive(Clone)]
struct OperationProgress {
    job_id: String,
    stage: String,
    label: String,
    current_table: Option<String>,
    completed_tables: u64,
    total_tables: u64,
    completed_rows: Option<u64>,
    total_rows: Option<u64>,
    backup_snapshot_path: Option<String>,
}

impl OperationProgress {
    fn payload(&self, message: String) -> DatabaseSyncProgress {
        progress(
            &self.job_id,
            &self.stage,
            &message,
            self.current_table.clone(),
            self.completed_tables,
            self.total_tables,
            self.completed_rows,
            self.total_rows,
            self.backup_snapshot_path.clone(),
            "running",
        )
    }
}

async fn guard_operation<T, Fut, Emit>(
    operation: Fut,
    timeout: Duration,
    cancellation: &WorkCancellation,
    emit: &mut Emit,
    operation_progress: OperationProgress,
) -> Result<T, String>
where
    Fut: Future<Output = Result<T, String>>,
    Emit: FnMut(DatabaseSyncProgress),
{
    let label = operation_progress.label.clone();
    match run_with_heartbeat(
        operation,
        Duration::from_secs(SYNC_HEARTBEAT_SECONDS),
        timeout,
        cancellation,
        |elapsed| {
            emit(operation_progress.payload(format!(
                "{label}，已等待 {} 秒，数据库仍在处理",
                elapsed.as_secs()
            )));
        },
    )
    .await
    {
        Ok(value) => Ok(value),
        Err(GuardError::Failed(error)) => Err(error),
        Err(GuardError::Cancelled) => Err("覆盖同步已停止".into()),
        Err(GuardError::TimedOut { elapsed }) => Err(format!(
            "{label}超时（已等待 {} 秒），可能是网络中断、服务器繁忙或元数据锁未释放",
            elapsed.as_secs()
        )),
    }
}

async fn create_sync_snapshot_with_watchdog<Emit>(
    app: &AppHandle,
    mysql_url: &str,
    backup_config: &BackupConfig,
    request: &SyncDatabaseOverwriteRequest,
    total_tables: u64,
    cancellation: &WorkCancellation,
    emit: &mut Emit,
) -> Result<(SnapshotInfo, Option<String>), String>
where
    Emit: FnMut(DatabaseSyncProgress),
{
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel();
    let operation = backup::create_sync_protection_snapshot(
        app,
        mysql_url,
        &request.connection_id,
        &request.target_database,
        backup_config,
        &request.job_id,
        move |snapshot_progress| {
            let _ = progress_tx.send(snapshot_progress);
        },
    );
    tokio::pin!(operation);

    let started = std::time::Instant::now();
    let interval = Duration::from_secs(SYNC_HEARTBEAT_SECONDS);
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let deadline = tokio::time::sleep(Duration::from_secs(SYNC_BACKUP_TIMEOUT_SECONDS));
    tokio::pin!(deadline);
    let mut progress_open = true;
    let mut latest_done = 0;
    let mut latest_total = total_tables;
    let mut latest_table = None;

    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err("覆盖同步已停止".into()),
            result = &mut operation => {
                return result.map_err(|error| {
                    if error.starts_with("创建目标库本地安全快照") {
                        error
                    } else {
                        format!("创建目标库本地安全快照失败：{error}")
                    }
                });
            }
            snapshot_progress = progress_rx.recv(), if progress_open => {
                match snapshot_progress {
                    Some(snapshot_progress) => {
                        latest_done = snapshot_progress.done;
                        latest_total = snapshot_progress.total.max(total_tables);
                        latest_table = snapshot_progress.current_table.clone();
                        emit(progress(
                            &request.job_id,
                            "backup",
                            &snapshot_progress.message,
                            snapshot_progress.current_table,
                            snapshot_progress.done,
                            snapshot_progress.total,
                            None,
                            None,
                            None,
                            "running",
                        ));
                    }
                    None => progress_open = false,
                }
            }
            _ = ticker.tick() => emit(progress(
                &request.job_id,
                "backup",
                &format!(
                    "正在创建目标库本地安全快照，已运行 {} 秒，数据库仍在处理",
                    started.elapsed().as_secs()
                ),
                latest_table.clone(),
                latest_done,
                latest_total,
                None,
                None,
                None,
                "running",
            )),
            _ = &mut deadline => return Err(format!(
                "创建目标库本地安全快照超时（已等待 {} 秒），可能是网络中断或数据库服务器无响应",
                started.elapsed().as_secs()
            )),
        }
    }
}

fn sync_success_message(excluded_tables: &[String]) -> &'static str {
    if excluded_tables.is_empty() {
        "覆盖同步完成，一致性校验通过：目标库与源库的基础表结构和数据完全相同"
    } else {
        "覆盖同步完成，一致性校验通过：所有未排除表的结构和数据与源库相同，排除表保持目标库原状"
    }
}

async fn execute_sql_with_watchdog<Emit>(
    connection: &mut MySqlConnection,
    sql: &str,
    timeout: Duration,
    cancellation: &WorkCancellation,
    emit: &mut Emit,
    operation_progress: OperationProgress,
) -> Result<u64, String>
where
    Emit: FnMut(DatabaseSyncProgress),
{
    for attempt in 1..=SYNC_LOCK_RETRY_ATTEMPTS {
        let result = guard_operation(
            async {
                sqlx::query(sql)
                    .execute(&mut *connection)
                    .await
                    .map(|result| result.rows_affected())
                    .map_err(|error| error.to_string())
            },
            timeout,
            cancellation,
            emit,
            operation_progress.clone(),
        )
        .await;
        match result {
            Ok(rows) => return Ok(rows),
            Err(error) if is_retryable_lock_error(&error) && attempt < SYNC_LOCK_RETRY_ATTEMPTS => {
                emit(operation_progress.payload(format!(
                    "{}遇到数据库锁，2 秒后进行第 {} / {} 次重试",
                    operation_progress.label,
                    attempt + 1,
                    SYNC_LOCK_RETRY_ATTEMPTS
                )));
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(error) => return Err(format!("{}失败: {error}", operation_progress.label)),
        }
    }
    unreachable!("retry loop always returns")
}

fn is_retryable_lock_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("lock wait timeout")
        || lower.contains("metadata lock")
        || lower.contains("error 1205")
        || lower.contains("error 3572")
}

fn is_connection_fatal_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("超时")
        || lower.contains("已停止")
        || lower.contains("取消")
        || lower.contains("cancel")
        || lower.contains("timed out")
        || lower.contains("connection")
        || lower.contains("broken pipe")
        || lower.contains("unexpected eof")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
}

pub fn normalize_exclusions(values: Vec<String>) -> Vec<String> {
    let mut by_lower: HashMap<String, String> = HashMap::new();
    for value in values {
        let name = value.trim();
        if name.is_empty() {
            continue;
        }
        by_lower
            .entry(name.to_lowercase())
            .or_insert_with(|| name.to_string());
    }
    let mut names = by_lower.into_values().collect::<Vec<_>>();
    names.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    names
}

pub fn compute_preview(
    source_tables: Vec<String>,
    target_tables: Vec<String>,
    excluded_tables: Vec<String>,
    row_counts: &HashMap<String, u64>,
) -> PreviewDatabaseSyncResponse {
    let source_tables = sorted_unique(source_tables);
    let target_tables = sorted_unique(target_tables);
    let requested_exclusions = normalize_exclusions(excluded_tables);
    let source_lower = source_tables
        .iter()
        .map(|name| name.to_lowercase())
        .collect::<HashSet<_>>();
    let requested_excluded_lower = requested_exclusions
        .iter()
        .map(|name| name.to_lowercase())
        .collect::<HashSet<_>>();
    let excluded_tables = source_tables
        .iter()
        .filter(|name| requested_excluded_lower.contains(&name.to_lowercase()))
        .cloned()
        .collect::<Vec<_>>();
    let excluded_lower = excluded_tables
        .iter()
        .map(|name| name.to_lowercase())
        .collect::<HashSet<_>>();

    let included_tables = source_tables
        .iter()
        .filter(|name| !excluded_lower.contains(&name.to_lowercase()))
        .cloned()
        .collect::<Vec<_>>();
    let target_only_tables_to_drop = target_tables
        .iter()
        .filter(|name| {
            let lower = name.to_lowercase();
            !excluded_lower.contains(&lower) && !source_lower.contains(&lower)
        })
        .cloned()
        .collect::<Vec<_>>();
    let preserved_target_tables = target_tables
        .iter()
        .filter(|name| excluded_lower.contains(&name.to_lowercase()))
        .cloned()
        .collect::<Vec<_>>();
    let estimated_rows = included_tables
        .iter()
        .map(|name| {
            row_counts
                .get(name)
                .copied()
                .unwrap_or_else(|| row_counts.get(&name.to_lowercase()).copied().unwrap_or(0))
        })
        .sum();

    let mut warnings = Vec::new();
    let missing_source_exclusions = requested_exclusions
        .iter()
        .filter(|name| !source_lower.contains(&name.to_lowercase()))
        .cloned()
        .collect::<Vec<_>>();
    if !missing_source_exclusions.is_empty() {
        warnings.push(format!(
            "排除表不在源库中，将忽略: {}",
            missing_source_exclusions.join(", ")
        ));
    }
    if !preserved_target_tables.is_empty() {
        warnings.push(format!(
            "目标库存在同名排除表，将保留: {}",
            preserved_target_tables.join(", ")
        ));
    }

    let tables = table_plans(
        &included_tables,
        &preserved_target_tables,
        &target_only_tables_to_drop,
    );

    PreviewDatabaseSyncResponse {
        source_tables,
        target_tables,
        included_tables,
        excluded_tables,
        target_only_tables_to_drop,
        preserved_target_tables,
        estimated_rows,
        warnings,
        tables,
    }
}

pub fn rewrite_create_table_for_database(
    ddl: &str,
    source_database: &str,
    destination_database: &str,
    table: &str,
) -> Result<String, String> {
    let trimmed = ddl.trim_start();
    let leading_len = ddl.len().saturating_sub(trimmed.len());
    let leading = &ddl[..leading_len];
    let upper = trimmed.to_uppercase();
    let prefix = if upper.starts_with("CREATE TABLE IF NOT EXISTS ") {
        "CREATE TABLE IF NOT EXISTS "
    } else if upper.starts_with("CREATE TABLE ") {
        "CREATE TABLE "
    } else {
        return Err("无法识别 CREATE TABLE DDL".into());
    };
    let remainder = &trimmed[prefix.len()..];
    let body_start = find_table_definition_body(remainder)
        .ok_or_else(|| "无法定位 CREATE TABLE 表定义".to_string())?;
    let body = rewrite_same_schema_references(
        &remainder[body_start..],
        source_database,
        destination_database,
    );
    Ok(format!(
        "{leading}{prefix}`{}`.`{}`{}",
        escape_ident(destination_database),
        escape_ident(table),
        body
    ))
}

fn rewrite_same_schema_references(
    body: &str,
    source_database: &str,
    destination_database: &str,
) -> String {
    let mut rewritten = String::with_capacity(body.len());
    let mut cursor = 0;
    while let Some(keyword_start) = find_next_references_keyword(body, cursor) {
        let keyword_end = keyword_start + "REFERENCES".len();
        rewritten.push_str(&body[cursor..keyword_end]);
        if let Some((schema_start, schema_end)) =
            same_schema_reference_span(body, keyword_end, source_database)
        {
            rewritten.push_str(&body[keyword_end..schema_start]);
            rewritten.push('`');
            rewritten.push_str(&escape_ident(destination_database));
            rewritten.push('`');
            cursor = schema_end;
        } else {
            cursor = keyword_end;
        }
    }
    rewritten.push_str(&body[cursor..]);
    rewritten
}

fn find_next_references_keyword(sql: &str, from: usize) -> Option<usize> {
    let mut index = from;
    while index < sql.len() {
        let ch = sql[index..].chars().next()?;
        match ch {
            '`' => index = skip_quoted_sql_span(sql, index, '`'),
            '\'' | '"' => index = skip_quoted_sql_span(sql, index, ch),
            _ if keyword_at(sql, index, "REFERENCES") => return Some(index),
            _ => index += ch.len_utf8(),
        }
    }
    None
}

fn same_schema_reference_span(
    sql: &str,
    keyword_end: usize,
    source_database: &str,
) -> Option<(usize, usize)> {
    let schema_start = skip_sql_whitespace(sql, keyword_end);
    let (schema, schema_span_start, schema_span_end) = parse_sql_identifier(sql, schema_start)?;
    let dot_index = skip_sql_whitespace(sql, schema_span_end);
    if !matches!(sql[dot_index..].chars().next(), Some('.')) {
        return None;
    }
    let table_start = skip_sql_whitespace(sql, dot_index + 1);
    parse_sql_identifier(sql, table_start)?;
    (schema == source_database).then_some((schema_span_start, schema_span_end))
}

fn parse_sql_identifier(sql: &str, start: usize) -> Option<(String, usize, usize)> {
    let first = sql[start..].chars().next()?;
    if first == '`' {
        let mut value = String::new();
        let mut index = start + first.len_utf8();
        while index < sql.len() {
            let ch = sql[index..].chars().next()?;
            if ch == '`' {
                let next_index = index + ch.len_utf8();
                if matches!(sql[next_index..].chars().next(), Some('`')) {
                    value.push('`');
                    index = next_index + ch.len_utf8();
                } else {
                    return Some((value, start, next_index));
                }
            } else {
                value.push(ch);
                index += ch.len_utf8();
            }
        }
        None
    } else {
        let mut index = start;
        while index < sql.len() {
            let ch = sql[index..].chars().next()?;
            if ch.is_whitespace() || matches!(ch, '.' | '(' | ')' | ',') {
                break;
            }
            index += ch.len_utf8();
        }
        (index > start).then(|| (sql[start..index].to_string(), start, index))
    }
}

fn skip_sql_whitespace(sql: &str, from: usize) -> usize {
    let mut index = from;
    while index < sql.len() {
        let ch = sql[index..].chars().next().expect("index is in bounds");
        if !ch.is_whitespace() {
            break;
        }
        index += ch.len_utf8();
    }
    index
}

fn skip_quoted_sql_span(sql: &str, start: usize, quote: char) -> usize {
    let mut index = start + quote.len_utf8();
    while index < sql.len() {
        let ch = sql[index..].chars().next().expect("index is in bounds");
        let next_index = index + ch.len_utf8();
        if ch == '\\' && quote != '`' {
            index = sql[next_index..]
                .chars()
                .next()
                .map(|escaped| next_index + escaped.len_utf8())
                .unwrap_or(next_index);
        } else if ch == quote {
            if matches!(sql[next_index..].chars().next(), Some(next) if next == quote) {
                index = next_index + quote.len_utf8();
            } else {
                return next_index;
            }
        } else {
            index = next_index;
        }
    }
    sql.len()
}

fn keyword_at(sql: &str, index: usize, keyword: &str) -> bool {
    let end = index + keyword.len();
    let Some(candidate) = sql.get(index..end) else {
        return false;
    };
    candidate.eq_ignore_ascii_case(keyword)
        && !sql[..index]
            .chars()
            .next_back()
            .is_some_and(is_sql_word_char)
        && !sql[end..].chars().next().is_some_and(is_sql_word_char)
}

fn is_sql_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'
}

fn foreign_key_guard_result<T>(
    work_result: Result<T, String>,
    reenable_result: Result<(), String>,
) -> Result<T, String> {
    match (work_result, reenable_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(format!("重新启用 FOREIGN_KEY_CHECKS 失败: {error}")),
        (Err(error), Err(reenable_error)) => Err(format!(
            "{error}；重新启用 FOREIGN_KEY_CHECKS 失败: {reenable_error}"
        )),
    }
}

pub fn insertable_columns(columns: &[ColumnInfo]) -> Vec<String> {
    columns
        .iter()
        .filter(|column| {
            let extra = column.extra.to_uppercase();
            column.generation_expression.trim().is_empty()
                && !extra.contains("VIRTUAL GENERATED")
                && !extra.contains("STORED GENERATED")
        })
        .map(|column| column.name.clone())
        .collect()
}

pub fn build_copy_table_sql(
    source_database: &str,
    target_database: &str,
    table: &str,
    columns: &[String],
) -> Result<String, String> {
    if columns.is_empty() {
        return Err(format!("表 {table} 没有可复制的字段"));
    }
    let column_sql = columns
        .iter()
        .map(|column| format!("`{}`", escape_ident(column)))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!(
        "INSERT INTO `{}`.`{}` ({}) SELECT {} FROM `{}`.`{}`",
        escape_ident(target_database),
        escape_ident(table),
        column_sql,
        column_sql,
        escape_ident(source_database),
        escape_ident(table)
    ))
}

pub fn status_for_outcome(outcome: SyncOutcome) -> &'static str {
    match outcome {
        SyncOutcome::Succeeded => "succeeded",
        SyncOutcome::Cancelled => "cancelled",
        SyncOutcome::CancelledRestored => "cancelledRestored",
        SyncOutcome::CancelledRestoreFailed => "cancelledRestoreFailed",
        SyncOutcome::FailedRestored => "failedRestored",
        SyncOutcome::FailedRestoreFailed => "failedRestoreFailed",
    }
}

pub fn direct_error_message(error: &SyncError) -> Option<&str> {
    (!error.requires_restore).then_some(error.message.as_str())
}

pub fn status_for_error(error: &SyncError) -> Option<&'static str> {
    error
        .requires_restore
        .then_some(status_for_outcome(SyncOutcome::FailedRestored))
}

pub async fn preview_database_sync(
    pool: &MySqlPool,
    source_database: &str,
    target_database: &str,
    excluded_tables: Vec<String>,
) -> Result<PreviewDatabaseSyncResponse, String> {
    validate_database_pair(source_database, target_database)?;
    tokio::try_join!(
        ensure_database_exists(pool, source_database),
        ensure_database_exists(pool, target_database)
    )?;
    let exclusions = normalize_exclusions(excluded_tables);
    let (source_tables, target_tables) = tokio::try_join!(
        list_base_tables(pool, source_database),
        list_base_tables(pool, target_database)
    )?;
    let included_for_counts = source_tables
        .iter()
        .filter(|table| {
            !exclusions
                .iter()
                .any(|excluded| excluded.eq_ignore_ascii_case(table))
        })
        .cloned()
        .collect::<Vec<_>>();
    let row_counts = count_rows(pool, source_database, &included_for_counts).await?;
    let mut preview = compute_preview(source_tables, target_tables, exclusions, &row_counts);
    preview.warnings.extend(
        foreign_key_boundary_warnings(
            pool,
            source_database,
            target_database,
            &preview.included_tables,
            &preview.excluded_tables,
        )
        .await?,
    );
    Ok(preview)
}

pub async fn execute_database_sync<F>(
    app: &AppHandle,
    mysql_url: &str,
    backup_config: &BackupConfig,
    pool: &MySqlPool,
    request: SyncDatabaseOverwriteRequest,
    cancellation: &WorkCancellation,
    mut emit: F,
) -> Result<SyncDatabaseOverwriteResponse, String>
where
    F: FnMut(DatabaseSyncProgress),
{
    let job_id = request.job_id.clone();
    let mut warnings = Vec::new();
    let mut copied_tables = Vec::new();
    let mut copied_rows = 0_u64;
    let mut dropped_tables = Vec::new();
    let mut backup_snapshot_path = None;

    let result = AssertUnwindSafe(run_database_sync(
        app,
        mysql_url,
        backup_config,
        pool,
        &request,
        cancellation,
        &mut emit,
        &mut copied_tables,
        &mut copied_rows,
        &mut dropped_tables,
        &mut backup_snapshot_path,
        &mut warnings,
    ))
    .catch_unwind()
    .await
    .unwrap_or_else(|panic| Err(sync_panic_error(panic, backup_snapshot_path.is_some())));

    match result {
        Ok(()) => {
            let message = sync_success_message(&request.excluded_tables);
            emit(progress(
                &job_id,
                "completed",
                message,
                None,
                copied_tables.len() as u64,
                copied_tables.len() as u64,
                Some(copied_rows),
                Some(copied_rows),
                backup_snapshot_path.clone(),
                "succeeded",
            ));
            Ok(SyncDatabaseOverwriteResponse {
                job_id,
                status: status_for_outcome(SyncOutcome::Succeeded).into(),
                copied_tables,
                copied_rows,
                dropped_tables,
                backup_snapshot_path,
                message: message.into(),
                warnings,
            })
        }
        Err(error) if error.requires_restore => {
            let was_cancelled = cancellation.is_cancelled();
            let snapshot_path = backup_snapshot_path.clone();
            let restore_message = if was_cancelled {
                "正在停止同步，并从本地快照恢复目标库"
            } else {
                "同步失败，正在从本地快照恢复目标库"
            };
            emit(progress(
                &job_id,
                "restore",
                restore_message,
                None,
                0,
                0,
                None,
                None,
                snapshot_path.clone(),
                "restoring",
            ));
            // Once target mutation may have started, restoration must finish even
            // though the user-facing sync cancellation token is already set.
            let restore_cancellation = WorkCancellation::new();
            let restore_result = if let Some(path) = snapshot_path.as_deref() {
                guard_operation(
                    backup::restore_sync_protection_snapshot(
                        mysql_url,
                        &request.connection_id,
                        &request.target_database,
                        path,
                    ),
                    Duration::from_secs(SYNC_RESTORE_TIMEOUT_SECONDS),
                    &restore_cancellation,
                    &mut emit,
                    OperationProgress {
                        job_id: job_id.clone(),
                        stage: "restore".into(),
                        label: "正在从本地快照恢复目标库".into(),
                        current_table: None,
                        completed_tables: 0,
                        total_tables: 0,
                        completed_rows: None,
                        total_rows: None,
                        backup_snapshot_path: snapshot_path.clone(),
                    },
                )
                .await
            } else {
                Err("本地同步快照不存在，无法恢复".into())
            };
            match restore_result {
                Ok(()) => {
                    let terminal_message = if was_cancelled {
                        "覆盖同步已停止，目标库已从本地安全快照恢复"
                    } else {
                        "同步失败，已恢复目标库"
                    };
                    emit(progress(
                        &job_id,
                        if was_cancelled { "cancelled" } else { "failed" },
                        terminal_message,
                        None,
                        0,
                        0,
                        None,
                        None,
                        snapshot_path.clone(),
                        if was_cancelled { "cancelled" } else { "failed" },
                    ));
                    Ok(SyncDatabaseOverwriteResponse {
                        job_id,
                        status: if was_cancelled {
                            status_for_outcome(SyncOutcome::CancelledRestored)
                        } else {
                            status_for_error(&error)
                                .unwrap_or(status_for_outcome(SyncOutcome::FailedRestored))
                        }
                        .into(),
                        copied_tables,
                        copied_rows,
                        dropped_tables,
                        backup_snapshot_path: snapshot_path,
                        message: if was_cancelled {
                            terminal_message.into()
                        } else {
                            error.message
                        },
                        warnings,
                    })
                }
                Err(restore_error) => {
                    warnings.push(format!("自动恢复失败: {restore_error}"));
                    emit(progress(
                        &job_id,
                        "failed",
                        "同步失败且自动恢复失败",
                        None,
                        0,
                        0,
                        None,
                        None,
                        snapshot_path.clone(),
                        "failed",
                    ));
                    Ok(SyncDatabaseOverwriteResponse {
                        job_id,
                        status: status_for_outcome(if was_cancelled {
                            SyncOutcome::CancelledRestoreFailed
                        } else {
                            SyncOutcome::FailedRestoreFailed
                        })
                        .into(),
                        copied_tables,
                        copied_rows,
                        dropped_tables,
                        backup_snapshot_path: snapshot_path,
                        message: format!("{}；自动恢复失败: {restore_error}", error.message),
                        warnings,
                    })
                }
            }
        }
        Err(error) => {
            if cancellation.is_cancelled() {
                let message = "覆盖同步已停止，目标库尚未开始修改";
                emit(progress(
                    &job_id,
                    "cancelled",
                    message,
                    None,
                    0,
                    0,
                    None,
                    None,
                    backup_snapshot_path.clone(),
                    "cancelled",
                ));
                return Ok(SyncDatabaseOverwriteResponse {
                    job_id,
                    status: status_for_outcome(SyncOutcome::Cancelled).into(),
                    copied_tables,
                    copied_rows,
                    dropped_tables,
                    backup_snapshot_path,
                    message: message.into(),
                    warnings,
                });
            }
            emit(progress(
                &job_id,
                "failed",
                &error.message,
                None,
                0,
                0,
                None,
                None,
                backup_snapshot_path.clone(),
                "failed",
            ));
            Err(direct_error_message(&error)
                .unwrap_or(error.message.as_str())
                .to_string())
        }
    }
}

async fn run_database_sync<F>(
    app: &AppHandle,
    mysql_url: &str,
    backup_config: &BackupConfig,
    pool: &MySqlPool,
    request: &SyncDatabaseOverwriteRequest,
    cancellation: &WorkCancellation,
    emit: &mut F,
    copied_tables: &mut Vec<String>,
    copied_rows: &mut u64,
    dropped_tables: &mut Vec<String>,
    backup_snapshot_path: &mut Option<String>,
    warnings: &mut Vec<String>,
) -> Result<(), SyncError>
where
    F: FnMut(DatabaseSyncProgress),
{
    validate_database_pair(&request.source_database, &request.target_database)
        .map_err(SyncError::without_restore)?;
    emit(progress(
        &request.job_id,
        "preflight",
        "正在检查数据库同步计划",
        None,
        0,
        0,
        None,
        None,
        None,
        "running",
    ));

    let preview = guard_operation(
        preview_database_sync(
            pool,
            &request.source_database,
            &request.target_database,
            request.excluded_tables.clone(),
        ),
        Duration::from_secs(SYNC_VERIFY_TIMEOUT_SECONDS),
        cancellation,
        emit,
        OperationProgress {
            job_id: request.job_id.clone(),
            stage: "preflight".into(),
            label: "检查源库和目标库同步计划".into(),
            current_table: None,
            completed_tables: 0,
            total_tables: 0,
            completed_rows: None,
            total_rows: None,
            backup_snapshot_path: None,
        },
    )
    .await
    .map_err(SyncError::without_restore)?;
    warnings.extend(preview.warnings.clone());

    emit(progress(
        &request.job_id,
        "backup",
        "正在创建目标库本地安全快照",
        None,
        0,
        preview.target_tables.len() as u64,
        None,
        None,
        None,
        "running",
    ));

    let (snapshot, snapshot_warning) = create_sync_snapshot_with_watchdog(
        app,
        mysql_url,
        backup_config,
        request,
        preview.target_tables.len() as u64,
        cancellation,
        emit,
    )
    .await
    .map_err(SyncError::without_restore)?;
    if let Some(warning) = snapshot_warning {
        warnings.push(warning);
    }
    *backup_snapshot_path = Some(snapshot.path.clone());
    emit(progress(
        &request.job_id,
        "backup",
        "目标库本地安全快照已创建",
        None,
        preview.target_tables.len() as u64,
        preview.target_tables.len() as u64,
        None,
        None,
        Some(snapshot.path.clone()),
        "running",
    ));
    let sync_pool = guard_operation(
        connect_database_with_max_connections(
            mysql_url,
            None,
            SYNC_WORKER_CONCURRENCY as u32,
        ),
        Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
        cancellation,
        emit,
        OperationProgress {
            job_id: request.job_id.clone(),
            stage: "preflight".into(),
            label: "初始化并行同步连接池".into(),
            current_table: None,
            completed_tables: 0,
            total_tables: preview.included_tables.len() as u64,
            completed_rows: None,
            total_rows: None,
            backup_snapshot_path: backup_snapshot_path.clone(),
        },
    )
    .await
    .map_err(SyncError::without_restore)?;

    let mut connection = match guard_operation(
        async {
            pool.acquire()
                .await
                .map_err(|error| format!("获取 MySQL 连接失败: {error}"))
        },
        Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
        cancellation,
        emit,
        OperationProgress {
            job_id: request.job_id.clone(),
            stage: "preflight".into(),
            label: "获取覆盖同步数据库连接".into(),
            current_table: None,
            completed_tables: 0,
            total_tables: preview.included_tables.len() as u64,
            completed_rows: None,
            total_rows: None,
            backup_snapshot_path: backup_snapshot_path.clone(),
        },
    )
    .await
    {
        Ok(conn) => conn,
        Err(error) => {
            sync_pool.close().await;
            return Err(SyncError::without_restore(error));
        }
    };
    let mutation_result = overwrite_target_database(
        &mut connection,
        &sync_pool,
        request,
        &preview,
        cancellation,
        emit,
        copied_tables,
        copied_rows,
        dropped_tables,
        backup_snapshot_path.clone(),
    )
    .await;
    sync_pool.close().await;
    if let Err(error) = mutation_result.as_ref() {
        if is_connection_fatal_error(error) {
            connection.close_on_drop();
            return Err(SyncError::requires_restore(error.clone()));
        }
    }
    let reenable_result = guard_operation(
        set_foreign_key_checks(&mut connection, true),
        Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
        cancellation,
        emit,
        OperationProgress {
            job_id: request.job_id.clone(),
            stage: "finalize".into(),
            label: "恢复目标库外键检查".into(),
            current_table: None,
            completed_tables: copied_tables.len() as u64,
            total_tables: preview.included_tables.len() as u64,
            completed_rows: Some(*copied_rows),
            total_rows: Some(preview.estimated_rows),
            backup_snapshot_path: backup_snapshot_path.clone(),
        },
    )
    .await;
    let guarded_result = foreign_key_guard_result(mutation_result, reenable_result);
    if guarded_result
        .as_ref()
        .is_err_and(|error| is_connection_fatal_error(error))
    {
        connection.close_on_drop();
    }
    guarded_result.map_err(SyncError::requires_restore)?;

    emit(progress(
        &request.job_id,
        "finalize",
        sync_success_message(&request.excluded_tables),
        None,
        copied_tables.len() as u64,
        preview.included_tables.len() as u64,
        Some(*copied_rows),
        Some(preview.estimated_rows),
        backup_snapshot_path.clone(),
        "running",
    ));
    Ok(())
}

fn is_urgent_progress(event: &DatabaseSyncProgress) -> bool {
    event.message.contains("已等待") || event.message.contains("重试")
}

async fn acquire_sync_worker_connection(
    pool: &MySqlPool,
    disable_fk_checks: bool,
) -> Result<sqlx::pool::PoolConnection<sqlx::MySql>, String> {
    let mut conn = pool
        .acquire()
        .await
        .map_err(|error| format!("获取同步工作连接失败: {error}"))?;
    if let Err(error) = set_session_lock_wait_limits(&mut conn).await {
        conn.close_on_drop();
        return Err(error);
    }
    if disable_fk_checks {
        if let Err(error) = set_foreign_key_checks(&mut conn, false).await {
            conn.close_on_drop();
            return Err(error);
        }
    }
    Ok(conn)
}

async fn release_sync_worker_connection<T>(
    mut conn: sqlx::pool::PoolConnection<sqlx::MySql>,
    work_result: Result<T, String>,
    reenable_fk_checks: bool,
) -> Result<T, String> {
    if work_result
        .as_ref()
        .is_err_and(|error| is_connection_fatal_error(error))
    {
        conn.close_on_drop();
        return work_result;
    }
    if reenable_fk_checks {
        let reenable = set_foreign_key_checks(&mut conn, true).await;
        if reenable.is_err() {
            conn.close_on_drop();
        }
        return foreign_key_guard_result(work_result, reenable);
    }
    work_result
}

async fn run_concurrent_workers<I, W, Fut, T, Emit, OnItem>(
    items: I,
    concurrency: usize,
    mut make_worker: W,
    mut progress_rx: tokio::sync::mpsc::UnboundedReceiver<DatabaseSyncProgress>,
    emit: &mut Emit,
    mut on_item: OnItem,
) -> Result<(), String>
where
    I: IntoIterator,
    W: FnMut(I::Item) -> Fut,
    Fut: Future<Output = Result<T, String>> + Send + 'static,
    T: Send + 'static,
    Emit: FnMut(DatabaseSyncProgress),
    OnItem: FnMut(T, &mut Emit, &mut Instant),
{
    let mut iter = items.into_iter();
    let mut join_set: JoinSet<Result<T, String>> = JoinSet::new();
    for _ in 0..concurrency.max(1) {
        let Some(item) = iter.next() else {
            break;
        };
        join_set.spawn(make_worker(item));
    }

    let mut last_emit = Instant::now() - SYNC_PROGRESS_THROTTLE;
    let mut progress_open = true;
    while !join_set.is_empty() {
        tokio::select! {
            biased;
            maybe_progress = progress_rx.recv(), if progress_open => {
                match maybe_progress {
                    Some(event) => {
                        if is_urgent_progress(&event) || last_emit.elapsed() >= SYNC_PROGRESS_THROTTLE {
                            emit(event);
                            last_emit = Instant::now();
                        }
                    }
                    None => progress_open = false,
                }
            }
            join_res = join_set.join_next() => {
                let Some(join_res) = join_res else {
                    break;
                };
                let item = join_res.map_err(|error| format!("同步并发任务异常退出: {error}"))??;
                if let Some(next_item) = iter.next() {
                    join_set.spawn(make_worker(next_item));
                }
                on_item(item, emit, &mut last_emit);
            }
        }
    }
    Ok(())
}

async fn overwrite_target_database<F>(
    connection: &mut MySqlConnection,
    sync_pool: &MySqlPool,
    request: &SyncDatabaseOverwriteRequest,
    preview: &PreviewDatabaseSyncResponse,
    cancellation: &WorkCancellation,
    emit: &mut F,
    copied_tables: &mut Vec<String>,
    copied_rows: &mut u64,
    dropped_tables: &mut Vec<String>,
    backup_snapshot_path: Option<String>,
) -> Result<(), String>
where
    F: FnMut(DatabaseSyncProgress),
{
    guard_operation(
        set_session_lock_wait_limits(connection),
        Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
        cancellation,
        emit,
        OperationProgress {
            job_id: request.job_id.clone(),
            stage: "preflight".into(),
            label: "配置目标库同步会话".into(),
            current_table: None,
            completed_tables: 0,
            total_tables: preview.included_tables.len() as u64,
            completed_rows: None,
            total_rows: None,
            backup_snapshot_path: backup_snapshot_path.clone(),
        },
    )
    .await?;
    guard_operation(
        set_foreign_key_checks(connection, false),
        Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
        cancellation,
        emit,
        OperationProgress {
            job_id: request.job_id.clone(),
            stage: "preflight".into(),
            label: "关闭目标库外键检查".into(),
            current_table: None,
            completed_tables: 0,
            total_tables: preview.included_tables.len() as u64,
            completed_rows: None,
            total_rows: None,
            backup_snapshot_path: backup_snapshot_path.clone(),
        },
    )
    .await?;

    let target_set = preview
        .target_tables
        .iter()
        .map(|name| name.to_lowercase())
        .collect::<HashSet<_>>();
    let mut target_tables_to_drop = preview
        .target_tables
        .iter()
        .filter(|name| {
            !preview
                .preserved_target_tables
                .iter()
                .any(|preserved| preserved.eq_ignore_ascii_case(name))
        })
        .cloned()
        .collect::<Vec<_>>();
    target_tables_to_drop.sort_by(|a, b| b.to_lowercase().cmp(&a.to_lowercase()));

    let total_drop = target_tables_to_drop.len();
    emit(progress(
        &request.job_id,
        "dropTarget",
        "正在删除目标库旧表",
        None,
        0,
        total_drop as u64,
        None,
        None,
        backup_snapshot_path.clone(),
        "running",
    ));
    let mut dropped_count = 0usize;
    for batch in target_tables_to_drop.chunks(SYNC_DROP_BATCH_SIZE) {
        let Some(table) = batch.first() else {
            continue;
        };
        let batch_end = dropped_count + batch.len();
        emit(progress(
            &request.job_id,
            "dropTarget",
            &format!(
                "正在删除目标表 {table}（第 {} - {} / {} 张）",
                dropped_count + 1,
                batch_end,
                total_drop
            ),
            Some(table.clone()),
            dropped_count as u64,
            total_drop as u64,
            None,
            None,
            backup_snapshot_path.clone(),
            "running",
        ));
        let qualified_tables = batch
            .iter()
            .map(|name| {
                format!(
                    "`{}`.`{}`",
                    escape_ident(&request.target_database),
                    escape_ident(name)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let drop_sql = format!("DROP TABLE IF EXISTS {qualified_tables}");
        execute_sql_with_watchdog(
            connection,
            &drop_sql,
            Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
            cancellation,
            emit,
            OperationProgress {
                job_id: request.job_id.clone(),
                stage: "dropTarget".into(),
                label: format!("删除目标表 {table}"),
                current_table: Some(table.clone()),
                completed_tables: dropped_count as u64,
                total_tables: total_drop as u64,
                completed_rows: None,
                total_rows: None,
                backup_snapshot_path: backup_snapshot_path.clone(),
            },
        )
        .await?;
        dropped_tables.extend(batch.iter().cloned());
        dropped_count = batch_end;
        emit(progress(
            &request.job_id,
            "dropTarget",
            &format!("已删除目标表 {table} 等（{dropped_count} / {total_drop}）"),
            batch.last().cloned(),
            dropped_count as u64,
            total_drop as u64,
            None,
            None,
            backup_snapshot_path.clone(),
            "running",
        ));
    }

    let total_included = preview.included_tables.len();
    emit(progress(
        &request.job_id,
        "createTarget",
        "正在创建目标库表结构",
        None,
        0,
        total_included as u64,
        None,
        None,
        backup_snapshot_path.clone(),
        "running",
    ));
    create_target_tables_concurrently(
        sync_pool,
        request,
        &preview.included_tables,
        cancellation,
        emit,
        backup_snapshot_path.clone(),
    )
    .await?;

    let total_rows = preview.estimated_rows;
    emit(progress(
        &request.job_id,
        "copyData",
        "正在复制源库数据",
        None,
        0,
        total_included as u64,
        Some(0),
        Some(total_rows),
        backup_snapshot_path.clone(),
        "running",
    ));
    let mut source_columns_by_table = guard_operation(
        list_all_columns(sync_pool, &request.source_database),
        Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
        cancellation,
        emit,
        OperationProgress {
            job_id: request.job_id.clone(),
            stage: "copyData".into(),
            label: "批量读取源库字段元数据".into(),
            current_table: None,
            completed_tables: 0,
            total_tables: total_included as u64,
            completed_rows: Some(0),
            total_rows: Some(total_rows),
            backup_snapshot_path: backup_snapshot_path.clone(),
        },
    )
    .await?;
    let mut copy_plans: Vec<(usize, String, String)> = Vec::with_capacity(total_included);
    for (index, table) in preview.included_tables.iter().enumerate() {
        if target_set.contains(&table.to_lowercase())
            || preview
                .source_tables
                .iter()
                .any(|source| source.eq_ignore_ascii_case(table))
        {
            let columns = match source_columns_by_table.remove(&table.to_lowercase()) {
                Some(cols) if !cols.is_empty() => cols,
                _ => {
                    guard_operation(
                        list_columns(connection, &request.source_database, table),
                        Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
                        cancellation,
                        emit,
                        OperationProgress {
                            job_id: request.job_id.clone(),
                            stage: "copyData".into(),
                            label: format!("读取源表 {table} 的字段"),
                            current_table: Some(table.clone()),
                            completed_tables: 0,
                            total_tables: total_included as u64,
                            completed_rows: Some(*copied_rows),
                            total_rows: Some(total_rows),
                            backup_snapshot_path: backup_snapshot_path.clone(),
                        },
                    )
                    .await?
                }
            };
            let insertable = insertable_columns(&columns);
            let sql = build_copy_table_sql(
                &request.source_database,
                &request.target_database,
                table,
                &insertable,
            )?;
            copy_plans.push((index, table.clone(), sql));
        }
    }
    copy_target_tables_concurrently(
        sync_pool,
        request,
        copy_plans,
        total_included,
        total_rows,
        cancellation,
        emit,
        copied_tables,
        copied_rows,
        backup_snapshot_path.clone(),
    )
    .await?;

    *copied_rows = verify_and_repair_target(
        connection,
        sync_pool,
        request,
        preview,
        cancellation,
        emit,
        backup_snapshot_path,
    )
    .await?;
    Ok(())
}

async fn create_target_tables_concurrently<Emit>(
    sync_pool: &MySqlPool,
    request: &SyncDatabaseOverwriteRequest,
    included_tables: &[String],
    cancellation: &WorkCancellation,
    emit: &mut Emit,
    backup_snapshot_path: Option<String>,
) -> Result<(), String>
where
    Emit: FnMut(DatabaseSyncProgress),
{
    if included_tables.is_empty() {
        return Ok(());
    }
    let total = included_tables.len();
    let (progress_tx, progress_rx) = tokio::sync::mpsc::unbounded_channel();
    let snapshot_for_workers = backup_snapshot_path.clone();
    let pool_for_workers = sync_pool.clone();
    let request_for_workers = std::sync::Arc::new(request.clone());
    let cancel_for_workers = cancellation.clone();
    let mut completed = 0usize;
    run_concurrent_workers(
        included_tables.iter().cloned().enumerate(),
        SYNC_WORKER_CONCURRENCY,
        move |(index, table)| {
            let tx = progress_tx.clone();
            let snapshot_path = snapshot_for_workers.clone();
            let worker_pool = pool_for_workers.clone();
            let worker_request = request_for_workers.clone();
            let worker_cancel = cancel_for_workers.clone();
            async move {
                let mut worker_emit = |event: DatabaseSyncProgress| {
                    let _ = tx.send(event);
                };
                create_target_table_worker(
                    &worker_pool,
                    &worker_request,
                    index,
                    total,
                    table,
                    &worker_cancel,
                    &mut worker_emit,
                    snapshot_path,
                )
                .await
            }
        },
        progress_rx,
        emit,
        |table, emit, last_emit| {
            completed += 1;
            if completed == 1 || completed == total || last_emit.elapsed() >= SYNC_PROGRESS_THROTTLE
            {
                emit(progress(
                    &request.job_id,
                    "createTarget",
                    &format!("已创建目标表 {table}（{completed} / {total}）"),
                    Some(table),
                    completed as u64,
                    total as u64,
                    None,
                    None,
                    backup_snapshot_path.clone(),
                    "running",
                ));
                *last_emit = Instant::now();
            }
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn create_target_table_worker<Emit>(
    sync_pool: &MySqlPool,
    request: &SyncDatabaseOverwriteRequest,
    index: usize,
    total: usize,
    table: String,
    cancellation: &WorkCancellation,
    emit: &mut Emit,
    backup_snapshot_path: Option<String>,
) -> Result<String, String>
where
    Emit: FnMut(DatabaseSyncProgress),
{
    let mut conn = acquire_sync_worker_connection(sync_pool, true).await?;
    let work_result = async {
        emit(progress(
            &request.job_id,
            "createTarget",
            &format!(
                "正在创建目标表 {table}（第 {} / {} 张）",
                index + 1,
                total
            ),
            Some(table.clone()),
            index as u64,
            total as u64,
            None,
            None,
            backup_snapshot_path.clone(),
            "running",
        ));
        let ddl = guard_operation(
            show_create_table(&mut conn, &request.source_database, &table),
            Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
            cancellation,
            emit,
            OperationProgress {
                job_id: request.job_id.clone(),
                stage: "createTarget".into(),
                label: format!("读取源表 {table} 的结构"),
                current_table: Some(table.clone()),
                completed_tables: index as u64,
                total_tables: total as u64,
                completed_rows: None,
                total_rows: None,
                backup_snapshot_path: backup_snapshot_path.clone(),
            },
        )
        .await?;
        let rewritten = rewrite_create_table_for_database(
            &ddl,
            &request.source_database,
            &request.target_database,
            &table,
        )?;
        execute_sql_with_watchdog(
            &mut conn,
            &rewritten,
            Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
            cancellation,
            emit,
            OperationProgress {
                job_id: request.job_id.clone(),
                stage: "createTarget".into(),
                label: format!("创建目标表 {table}"),
                current_table: Some(table.clone()),
                completed_tables: index as u64,
                total_tables: total as u64,
                completed_rows: None,
                total_rows: None,
                backup_snapshot_path,
            },
        )
        .await?;
        Ok(table)
    }
    .await;
    release_sync_worker_connection(conn, work_result, true).await
}

#[allow(clippy::too_many_arguments)]
async fn copy_target_tables_concurrently<Emit>(
    sync_pool: &MySqlPool,
    request: &SyncDatabaseOverwriteRequest,
    copy_plans: Vec<(usize, String, String)>,
    total_included: usize,
    total_rows: u64,
    cancellation: &WorkCancellation,
    emit: &mut Emit,
    copied_tables: &mut Vec<String>,
    copied_rows: &mut u64,
    backup_snapshot_path: Option<String>,
) -> Result<(), String>
where
    Emit: FnMut(DatabaseSyncProgress),
{
    if copy_plans.is_empty() {
        return Ok(());
    }
    let plan_len = copy_plans.len();
    let (progress_tx, progress_rx) = tokio::sync::mpsc::unbounded_channel();
    let snapshot_for_workers = backup_snapshot_path.clone();
    let pool_for_workers = sync_pool.clone();
    let request_for_workers = std::sync::Arc::new(request.clone());
    let cancel_for_workers = cancellation.clone();
    let mut ordered_tables: Vec<(usize, String)> = Vec::with_capacity(plan_len);
    let mut completed = 0usize;
    run_concurrent_workers(
        copy_plans,
        SYNC_WORKER_CONCURRENCY,
        move |(index, table, sql)| {
            let tx = progress_tx.clone();
            let snapshot_path = snapshot_for_workers.clone();
            let worker_pool = pool_for_workers.clone();
            let worker_request = request_for_workers.clone();
            let worker_cancel = cancel_for_workers.clone();
            async move {
                let mut worker_emit = |event: DatabaseSyncProgress| {
                    let _ = tx.send(event);
                };
                copy_target_table_worker(
                    &worker_pool,
                    &worker_request,
                    index,
                    total_included,
                    total_rows,
                    table,
                    sql,
                    &worker_cancel,
                    &mut worker_emit,
                    snapshot_path,
                )
                .await
            }
        },
        progress_rx,
        emit,
        |(index, table, rows), emit, last_emit| {
            completed += 1;
            *copied_rows = copied_rows.saturating_add(rows);
            ordered_tables.push((index, table.clone()));
            if completed == 1
                || completed == plan_len
                || last_emit.elapsed() >= SYNC_PROGRESS_THROTTLE
            {
                emit(progress(
                    &request.job_id,
                    "copyData",
                    &format!("已复制表 {table}（{completed} / {total_included}）"),
                    Some(table),
                    completed as u64,
                    total_included as u64,
                    Some(*copied_rows),
                    Some(total_rows),
                    backup_snapshot_path.clone(),
                    "running",
                ));
                *last_emit = Instant::now();
            }
        },
    )
    .await?;

    ordered_tables.sort_by_key(|(index, _)| *index);
    copied_tables.extend(ordered_tables.into_iter().map(|(_, table)| table));
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn copy_target_table_worker<Emit>(
    sync_pool: &MySqlPool,
    request: &SyncDatabaseOverwriteRequest,
    index: usize,
    total_included: usize,
    total_rows: u64,
    table: String,
    sql: String,
    cancellation: &WorkCancellation,
    emit: &mut Emit,
    backup_snapshot_path: Option<String>,
) -> Result<(usize, String, u64), String>
where
    Emit: FnMut(DatabaseSyncProgress),
{
    let mut conn = acquire_sync_worker_connection(sync_pool, true).await?;
    let work_result = async {
        emit(progress(
            &request.job_id,
            "copyData",
            &format!(
                "正在复制表 {table}（第 {} / {} 张）",
                index + 1,
                total_included
            ),
            Some(table.clone()),
            index as u64,
            total_included as u64,
            None,
            Some(total_rows),
            backup_snapshot_path.clone(),
            "running",
        ));
        let rows = execute_sql_with_watchdog(
            &mut conn,
            &sql,
            Duration::from_secs(SYNC_COPY_TIMEOUT_SECONDS),
            cancellation,
            emit,
            OperationProgress {
                job_id: request.job_id.clone(),
                stage: "copyData".into(),
                label: format!("复制表 {table} 的数据"),
                current_table: Some(table.clone()),
                completed_tables: index as u64,
                total_tables: total_included as u64,
                completed_rows: None,
                total_rows: Some(total_rows),
                backup_snapshot_path,
            },
        )
        .await?;
        Ok((index, table, rows))
    }
    .await;
    release_sync_worker_connection(conn, work_result, true).await
}

async fn verify_and_repair_target<Emit>(
    connection: &mut MySqlConnection,
    sync_pool: &MySqlPool,
    request: &SyncDatabaseOverwriteRequest,
    preview: &PreviewDatabaseSyncResponse,
    cancellation: &WorkCancellation,
    emit: &mut Emit,
    backup_snapshot_path: Option<String>,
) -> Result<u64, String>
where
    Emit: FnMut(DatabaseSyncProgress),
{
    let (source, _target, mismatches) = capture_verification_pass(
        connection,
        sync_pool,
        request,
        preview,
        cancellation,
        emit,
        backup_snapshot_path.clone(),
    )
    .await?;
    if mismatches.is_empty() {
        let rows = source.iter().map(|table| table.rows).sum();
        emit(progress(
            &request.job_id,
            "verify",
            "一致性校验通过：目标库表结构和数据与源库相同",
            None,
            preview.included_tables.len() as u64,
            preview.included_tables.len() as u64,
            Some(rows),
            Some(rows),
            backup_snapshot_path,
            "running",
        ));
        return Ok(rows);
    }

    emit(progress(
        &request.job_id,
        "repair",
        &format!(
            "发现 {} 张表不一致，正在自动修复：{}",
            mismatches.len(),
            mismatch_summary(&mismatches)
        ),
        None,
        0,
        mismatches.len() as u64,
        None,
        None,
        backup_snapshot_path.clone(),
        "running",
    ));
    for (index, mismatch) in mismatches.iter().enumerate() {
        repair_mismatch(
            connection,
            request,
            mismatch,
            index,
            mismatches.len(),
            cancellation,
            emit,
            backup_snapshot_path.clone(),
        )
        .await?;
    }

    let (source, _target, remaining) = capture_verification_pass(
        connection,
        sync_pool,
        request,
        preview,
        cancellation,
        emit,
        backup_snapshot_path.clone(),
    )
    .await?;
    if !remaining.is_empty() {
        return Err(format!(
            "自动修复后仍有 {} 张表与源库不一致：{}",
            remaining.len(),
            mismatch_summary(&remaining)
        ));
    }
    let rows = source.iter().map(|table| table.rows).sum();
    emit(progress(
        &request.job_id,
        "verify",
        "自动修复完成，一致性复核通过",
        None,
        preview.included_tables.len() as u64,
        preview.included_tables.len() as u64,
        Some(rows),
        Some(rows),
        backup_snapshot_path,
        "running",
    ));
    Ok(rows)
}

async fn capture_verification_pass<Emit>(
    connection: &mut MySqlConnection,
    sync_pool: &MySqlPool,
    request: &SyncDatabaseOverwriteRequest,
    preview: &PreviewDatabaseSyncResponse,
    cancellation: &WorkCancellation,
    emit: &mut Emit,
    backup_snapshot_path: Option<String>,
) -> Result<
    (
        Vec<TableFingerprint>,
        Vec<TableFingerprint>,
        Vec<TableMismatch>,
    ),
    String,
>
where
    Emit: FnMut(DatabaseSyncProgress),
{
    emit(progress(
        &request.job_id,
        "verify",
        "正在重新读取源库和目标库，执行最终一致性校验",
        None,
        0,
        0,
        None,
        None,
        backup_snapshot_path.clone(),
        "running",
    ));
    let mut source_tables = guard_operation(
        list_verification_tables(connection, &request.source_database),
        Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
        cancellation,
        emit,
        OperationProgress {
            job_id: request.job_id.clone(),
            stage: "verify".into(),
            label: "读取源库表列表".into(),
            current_table: None,
            completed_tables: 0,
            total_tables: 0,
            completed_rows: None,
            total_rows: None,
            backup_snapshot_path: backup_snapshot_path.clone(),
        },
    )
    .await?;
    let mut target_tables = guard_operation(
        list_verification_tables(connection, &request.target_database),
        Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
        cancellation,
        emit,
        OperationProgress {
            job_id: request.job_id.clone(),
            stage: "verify".into(),
            label: "读取目标库表列表".into(),
            current_table: None,
            completed_tables: 0,
            total_tables: 0,
            completed_rows: None,
            total_rows: None,
            backup_snapshot_path: backup_snapshot_path.clone(),
        },
    )
    .await?;
    let excluded = preview
        .excluded_tables
        .iter()
        .map(|name| name.to_lowercase())
        .collect::<HashSet<_>>();
    let preserved = preview
        .preserved_target_tables
        .iter()
        .map(|name| name.to_lowercase())
        .collect::<HashSet<_>>();
    source_tables.retain(|name| !excluded.contains(&name.to_lowercase()));
    target_tables.retain(|name| !preserved.contains(&name.to_lowercase()));

    let (mut source_fp_cols, mut target_fp_cols) = guard_operation(
        async {
            tokio::try_join!(
                list_all_fingerprint_columns(sync_pool, &request.source_database),
                list_all_fingerprint_columns(sync_pool, &request.target_database)
            )
        },
        Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
        cancellation,
        emit,
        OperationProgress {
            job_id: request.job_id.clone(),
            stage: "verify".into(),
            label: "批量读取源库与目标库校验字段".into(),
            current_table: None,
            completed_tables: 0,
            total_tables: (source_tables.len() + target_tables.len()) as u64,
            completed_rows: None,
            total_rows: None,
            backup_snapshot_path: backup_snapshot_path.clone(),
        },
    )
    .await?;

    let total = source_tables.len() + target_tables.len();
    let mut tasks: Vec<(bool, usize, &'static str, String, String, Option<Vec<FingerprintColumn>>)> =
        Vec::with_capacity(total);
    for (index, table) in source_tables.iter().enumerate() {
        let cols = source_fp_cols.remove(&table.to_lowercase());
        tasks.push((
            false,
            index,
            "源库",
            request.source_database.clone(),
            table.clone(),
            cols,
        ));
    }
    for (index, table) in target_tables.iter().enumerate() {
        let cols = target_fp_cols.remove(&table.to_lowercase());
        tasks.push((
            true,
            index,
            "目标库",
            request.target_database.clone(),
            table.clone(),
            cols,
        ));
    }

    let (progress_tx, progress_rx) = tokio::sync::mpsc::unbounded_channel();
    let snapshot_for_workers = backup_snapshot_path.clone();
    let pool_for_workers = sync_pool.clone();
    let job_id_for_workers = request.job_id.clone();
    let cancel_for_workers = cancellation.clone();
    let mut source_indexed: Vec<(usize, TableFingerprint)> =
        Vec::with_capacity(source_tables.len());
    let mut target_indexed: Vec<(usize, TableFingerprint)> =
        Vec::with_capacity(target_tables.len());
    let mut completed = 0usize;
    run_concurrent_workers(
        tasks,
        SYNC_WORKER_CONCURRENCY,
        move |(is_target, index, side, database, table, preloaded_cols)| {
            let tx = progress_tx.clone();
            let snapshot_path = snapshot_for_workers.clone();
            let worker_pool = pool_for_workers.clone();
            let worker_job_id = job_id_for_workers.clone();
            let worker_cancel = cancel_for_workers.clone();
            async move {
                let mut worker_emit = |event: DatabaseSyncProgress| {
                    let _ = tx.send(event);
                };
                let mut conn = acquire_sync_worker_connection(&worker_pool, false).await?;
                let work_result = async {
                    let fp = guard_operation(
                        async {
                            let cols = match preloaded_cols {
                                Some(cols) => cols,
                                None => {
                                    list_table_fingerprint_columns(&mut conn, &database, &table)
                                        .await?
                                }
                            };
                            capture_table_fingerprint_with_columns(
                                &mut conn, &database, &table, &cols,
                            )
                            .await
                        },
                        Duration::from_secs(SYNC_VERIFY_TIMEOUT_SECONDS),
                        &worker_cancel,
                        &mut worker_emit,
                        OperationProgress {
                            job_id: worker_job_id,
                            stage: "verify".into(),
                            label: format!("校验{side}表 {table}"),
                            current_table: Some(table.clone()),
                            completed_tables: index as u64,
                            total_tables: total as u64,
                            completed_rows: None,
                            total_rows: None,
                            backup_snapshot_path: snapshot_path,
                        },
                    )
                    .await?;
                    Ok((is_target, index, side, fp))
                }
                .await;
                release_sync_worker_connection(conn, work_result, false).await
            }
        },
        progress_rx,
        emit,
        |(is_target, index, side, fingerprint), emit, last_emit| {
            completed += 1;
            let table_name = fingerprint.name.clone();
            if is_target {
                target_indexed.push((index, fingerprint));
            } else {
                source_indexed.push((index, fingerprint));
            }
            if completed == 1 || completed == total || last_emit.elapsed() >= SYNC_PROGRESS_THROTTLE
            {
                emit(progress(
                    &request.job_id,
                    "verify",
                    &format!("已校验{side}表 {table_name}（{completed} / {total}）"),
                    Some(table_name),
                    completed as u64,
                    total as u64,
                    None,
                    None,
                    backup_snapshot_path.clone(),
                    "running",
                ));
                *last_emit = Instant::now();
            }
        },
    )
    .await?;

    source_indexed.sort_by_key(|(index, _)| *index);
    target_indexed.sort_by_key(|(index, _)| *index);
    let source: Vec<TableFingerprint> = source_indexed.into_iter().map(|(_, fp)| fp).collect();
    let target: Vec<TableFingerprint> = target_indexed.into_iter().map(|(_, fp)| fp).collect();
    let mismatches = compare_fingerprints(&source, &target);
    Ok((source, target, mismatches))
}

async fn repair_mismatch<Emit>(
    connection: &mut MySqlConnection,
    request: &SyncDatabaseOverwriteRequest,
    mismatch: &TableMismatch,
    index: usize,
    total: usize,
    cancellation: &WorkCancellation,
    emit: &mut Emit,
    backup_snapshot_path: Option<String>,
) -> Result<(), String>
where
    Emit: FnMut(DatabaseSyncProgress),
{
    let table = &mismatch.table;
    if mismatch.kind == MismatchKind::ChecksumUnavailable {
        return Err(format!(
            "表 {table} 的存储引擎不提供 CHECKSUM，无法证明源库与目标库数据完全相同"
        ));
    }
    emit(progress(
        &request.job_id,
        "repair",
        &format!(
            "正在修复表 {table}（{}，第 {} / {} 张）",
            mismatch_kind_label(mismatch.kind),
            index + 1,
            total
        ),
        Some(table.clone()),
        index as u64,
        total as u64,
        None,
        None,
        backup_snapshot_path.clone(),
        "running",
    ));

    let drop_sql = format!(
        "DROP TABLE IF EXISTS `{}`.`{}`",
        escape_ident(&request.target_database),
        escape_ident(table)
    );
    execute_sql_with_watchdog(
        connection,
        &drop_sql,
        Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
        cancellation,
        emit,
        OperationProgress {
            job_id: request.job_id.clone(),
            stage: "repair".into(),
            label: format!("清理待修复表 {table}"),
            current_table: Some(table.clone()),
            completed_tables: index as u64,
            total_tables: total as u64,
            completed_rows: None,
            total_rows: None,
            backup_snapshot_path: backup_snapshot_path.clone(),
        },
    )
    .await?;
    if mismatch.kind != MismatchKind::ExtraTable {
        let ddl = guard_operation(
            show_create_table(connection, &request.source_database, table),
            Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
            cancellation,
            emit,
            OperationProgress {
                job_id: request.job_id.clone(),
                stage: "repair".into(),
                label: format!("读取待修复表 {table} 的结构"),
                current_table: Some(table.clone()),
                completed_tables: index as u64,
                total_tables: total as u64,
                completed_rows: None,
                total_rows: None,
                backup_snapshot_path: backup_snapshot_path.clone(),
            },
        )
        .await?;
        let rewritten = rewrite_create_table_for_database(
            &ddl,
            &request.source_database,
            &request.target_database,
            table,
        )?;
        execute_sql_with_watchdog(
            connection,
            &rewritten,
            Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
            cancellation,
            emit,
            OperationProgress {
                job_id: request.job_id.clone(),
                stage: "repair".into(),
                label: format!("重建目标表 {table}"),
                current_table: Some(table.clone()),
                completed_tables: index as u64,
                total_tables: total as u64,
                completed_rows: None,
                total_rows: None,
                backup_snapshot_path: backup_snapshot_path.clone(),
            },
        )
        .await?;
        let columns = guard_operation(
            list_columns(connection, &request.source_database, table),
            Duration::from_secs(SYNC_DDL_TIMEOUT_SECONDS),
            cancellation,
            emit,
            OperationProgress {
                job_id: request.job_id.clone(),
                stage: "repair".into(),
                label: format!("读取待修复表 {table} 的字段"),
                current_table: Some(table.clone()),
                completed_tables: index as u64,
                total_tables: total as u64,
                completed_rows: None,
                total_rows: None,
                backup_snapshot_path: backup_snapshot_path.clone(),
            },
        )
        .await?;
        let copy_sql = build_copy_table_sql(
            &request.source_database,
            &request.target_database,
            table,
            &insertable_columns(&columns),
        )?;
        execute_sql_with_watchdog(
            connection,
            &copy_sql,
            Duration::from_secs(SYNC_COPY_TIMEOUT_SECONDS),
            cancellation,
            emit,
            OperationProgress {
                job_id: request.job_id.clone(),
                stage: "repair".into(),
                label: format!("重新复制表 {table} 的数据"),
                current_table: Some(table.clone()),
                completed_tables: index as u64,
                total_tables: total as u64,
                completed_rows: None,
                total_rows: None,
                backup_snapshot_path: backup_snapshot_path.clone(),
            },
        )
        .await?;
    }
    emit(progress(
        &request.job_id,
        "repair",
        &format!("已修复表 {table}"),
        Some(table.clone()),
        (index + 1) as u64,
        total as u64,
        None,
        None,
        backup_snapshot_path,
        "running",
    ));
    Ok(())
}

fn mismatch_kind_label(kind: MismatchKind) -> &'static str {
    match kind {
        MismatchKind::MissingTable => "目标库缺表",
        MismatchKind::ExtraTable => "目标库多表",
        MismatchKind::DataStructure => "表结构不同",
        MismatchKind::RowCount => "行数不同",
        MismatchKind::DataChecksum => "数据内容不同",
        MismatchKind::ChecksumUnavailable => "无法校验数据内容",
    }
}

fn mismatch_summary(mismatches: &[TableMismatch]) -> String {
    let mut details = mismatches
        .iter()
        .take(8)
        .map(|item| format!("{}（{}）", item.table, mismatch_kind_label(item.kind)))
        .collect::<Vec<_>>();
    if mismatches.len() > details.len() {
        details.push(format!("另有 {} 张", mismatches.len() - details.len()));
    }
    details.join("、")
}

pub fn progress(
    job_id: &str,
    stage: &str,
    message: &str,
    current_table: Option<String>,
    completed_tables: u64,
    total_tables: u64,
    completed_rows: Option<u64>,
    total_rows: Option<u64>,
    backup_snapshot_path: Option<String>,
    status: &str,
) -> DatabaseSyncProgress {
    DatabaseSyncProgress {
        stage: stage.into(),
        job_id: job_id.into(),
        message: message.into(),
        current_table,
        completed_tables,
        total_tables,
        completed_rows,
        total_rows,
        backup_snapshot_path,
        status: status.into(),
        done: completed_tables,
        total: total_tables,
    }
}

pub fn validate_database_pair(source_database: &str, target_database: &str) -> Result<(), String> {
    let source = source_database.trim();
    let target = target_database.trim();
    if source.is_empty() || target.is_empty() {
        return Err("源数据库和目标数据库不能为空".into());
    }
    if source.eq_ignore_ascii_case(target) {
        return Err("源数据库和目标数据库必须不同".into());
    }
    if SYSTEM_DATABASES
        .iter()
        .any(|name| source.eq_ignore_ascii_case(name) || target.eq_ignore_ascii_case(name))
    {
        return Err("不能同步 MySQL 系统数据库".into());
    }
    Ok(())
}

async fn ensure_database_exists(pool: &MySqlPool, database: &str) -> Result<(), String> {
    if database_exists(pool, database).await? {
        Ok(())
    } else {
        Err(format!("数据库不存在: {database}"))
    }
}

pub async fn database_exists(pool: &MySqlPool, database: &str) -> Result<bool, String> {
    let exists = sqlx::query(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ? LIMIT 1",
    )
    .bind(database)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("检查数据库失败: {error}"))?
    .is_some();
    Ok(exists)
}

pub async fn list_base_tables(pool: &MySqlPool, database: &str) -> Result<Vec<String>, String> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    )
    .bind(database)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取基础表列表失败: {error}"))?;
    Ok(rows
        .into_iter()
        .filter_map(|row| mysql_text::string(&row, "TABLE_NAME").ok())
        .collect())
}

pub async fn count_rows(
    pool: &MySqlPool,
    database: &str,
    tables: &[String],
) -> Result<HashMap<String, u64>, String> {
    if tables.is_empty() {
        return Ok(HashMap::new());
    }
    let mut chunk_iter = tables
        .chunks(COUNT_ROWS_UNION_BATCH_SIZE)
        .map(|chunk| chunk.to_vec());
    let mut join_set: JoinSet<Result<Vec<(String, u64)>, String>> = JoinSet::new();
    for _ in 0..COUNT_ROWS_CONCURRENCY {
        let Some(chunk) = chunk_iter.next() else {
            break;
        };
        join_set.spawn(count_rows_chunk(pool.clone(), database.to_string(), chunk));
    }

    let mut counts = HashMap::with_capacity(tables.len());
    while let Some(join_res) = join_set.join_next().await {
        let chunk_counts = join_res.map_err(|error| format!("统计行数任务异常: {error}"))??;
        if let Some(next_chunk) = chunk_iter.next() {
            join_set.spawn(count_rows_chunk(
                pool.clone(),
                database.to_string(),
                next_chunk,
            ));
        }
        counts.extend(chunk_counts);
    }
    Ok(counts)
}

async fn count_rows_chunk(
    pool: MySqlPool,
    database: String,
    chunk: Vec<String>,
) -> Result<Vec<(String, u64)>, String> {
    let escaped_db = escape_ident(&database);
    let union_sql = chunk
        .iter()
        .enumerate()
        .map(|(idx, table)| {
            format!(
                "SELECT CAST({idx} AS SIGNED) AS tbl_idx, CAST(COUNT(*) AS SIGNED) AS cnt FROM `{escaped_db}`.`{}`",
                escape_ident(table)
            )
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    match sqlx::query(&union_sql).fetch_all(&pool).await {
        Ok(rows) if rows.len() == chunk.len() => {
            let mut out = Vec::with_capacity(chunk.len());
            for row in rows {
                let idx = row.try_get::<i64, _>("tbl_idx").unwrap_or(-1);
                let cnt = row.try_get::<i64, _>("cnt").unwrap_or(0).max(0) as u64;
                if let Ok(index) = usize::try_from(idx) {
                    if let Some(table) = chunk.get(index) {
                        out.push((table.clone(), cnt));
                    }
                }
            }
            if out.len() == chunk.len() {
                return Ok(out);
            }
        }
        _ => {}
    }

    let mut fallback = Vec::with_capacity(chunk.len());
    for table in chunk {
        let sql = format!(
            "SELECT COUNT(*) AS cnt FROM `{escaped_db}`.`{}`",
            escape_ident(&table)
        );
        let count = sqlx::query(&sql)
            .fetch_one(&pool)
            .await
            .map_err(|error| format!("统计表 {table} 行数失败: {error}"))?
            .try_get::<i64, _>("cnt")
            .unwrap_or(0)
            .max(0) as u64;
        fallback.push((table, count));
    }
    Ok(fallback)
}

pub(crate) async fn show_create_table(
    connection: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<String, String> {
    let sql = format!(
        "SHOW CREATE TABLE `{}`.`{}`",
        escape_ident(database),
        escape_ident(table)
    );
    let row = sqlx::query(&sql)
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("读取表 {table} DDL 失败: {error}"))?;
    mysql_text::string(&row, "Create Table")
        .or_else(|_| mysql_text::string(&row, 1))
        .map_err(|error| format!("读取表 {table} DDL 失败: {error}"))
}

pub(crate) async fn list_all_columns(
    pool: &MySqlPool,
    database: &str,
) -> Result<HashMap<String, Vec<ColumnInfo>>, String> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COALESCE(EXTRA, '') AS EXTRA, COALESCE(GENERATION_EXPRESSION, '') AS GENERATION_EXPRESSION \
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
    )
    .bind(database)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取数据库 {database} 字段元数据失败: {error}"))?;
    let mut map: HashMap<String, Vec<ColumnInfo>> = HashMap::new();
    for row in rows {
        let Ok(table_name) = mysql_text::string(&row, "TABLE_NAME") else {
            continue;
        };
        map.entry(table_name.to_lowercase())
            .or_default()
            .push(ColumnInfo {
                name: mysql_text::string(&row, "COLUMN_NAME").unwrap_or_default(),
                data_type: mysql_text::string(&row, "DATA_TYPE").unwrap_or_default(),
                extra: mysql_text::string(&row, "EXTRA").unwrap_or_default(),
                generation_expression: mysql_text::string(&row, "GENERATION_EXPRESSION")
                    .unwrap_or_default(),
            });
    }
    Ok(map)
}

pub(crate) async fn list_columns(
    connection: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let rows = sqlx::query(
        "SELECT COLUMN_NAME, DATA_TYPE, COALESCE(EXTRA, '') AS EXTRA, COALESCE(GENERATION_EXPRESSION, '') AS GENERATION_EXPRESSION \
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    )
    .bind(database)
    .bind(table)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("读取表 {table} 字段失败: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|row| ColumnInfo {
            name: mysql_text::string(&row, "COLUMN_NAME").unwrap_or_default(),
            data_type: mysql_text::string(&row, "DATA_TYPE").unwrap_or_default(),
            extra: mysql_text::string(&row, "EXTRA").unwrap_or_default(),
            generation_expression: mysql_text::string(&row, "GENERATION_EXPRESSION")
                .unwrap_or_default(),
        })
        .collect())
}

async fn set_foreign_key_checks(
    connection: &mut MySqlConnection,
    enabled: bool,
) -> Result<(), String> {
    let sql = if enabled {
        "SET FOREIGN_KEY_CHECKS=1"
    } else {
        "SET FOREIGN_KEY_CHECKS=0"
    };
    sqlx::query(sql)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("设置 FOREIGN_KEY_CHECKS 失败: {error}"))?;
    Ok(())
}

pub(crate) async fn set_session_lock_wait_limits(
    connection: &mut MySqlConnection,
) -> Result<(), String> {
    for (setting, sql) in [
        (
            "lock_wait_timeout",
            format!("SET SESSION lock_wait_timeout = {MYSQL_SYNC_LOCK_WAIT_SECONDS}"),
        ),
        (
            "innodb_lock_wait_timeout",
            format!("SET SESSION innodb_lock_wait_timeout = {MYSQL_SYNC_LOCK_WAIT_SECONDS}"),
        ),
    ] {
        sqlx::query(&sql)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("设置 MySQL {setting} 失败: {error}"))?;
    }
    Ok(())
}

async fn foreign_key_boundary_warnings(
    pool: &MySqlPool,
    source_database: &str,
    target_database: &str,
    included_tables: &[String],
    excluded_tables: &[String],
) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    warnings.extend(
        foreign_key_boundary_warnings_for_schema(
            pool,
            source_database,
            included_tables,
            excluded_tables,
        )
        .await?,
    );
    warnings.extend(
        foreign_key_boundary_warnings_for_schema(
            pool,
            target_database,
            included_tables,
            excluded_tables,
        )
        .await?,
    );
    Ok(sorted_unique(warnings))
}

async fn foreign_key_boundary_warnings_for_schema(
    pool: &MySqlPool,
    database: &str,
    included_tables: &[String],
    excluded_tables: &[String],
) -> Result<Vec<String>, String> {
    if included_tables.is_empty() || excluded_tables.is_empty() {
        return Ok(Vec::new());
    }
    let included = included_tables
        .iter()
        .map(|name| name.to_lowercase())
        .collect::<HashSet<_>>();
    let excluded = excluded_tables
        .iter()
        .map(|name| name.to_lowercase())
        .collect::<HashSet<_>>();
    let rows = sqlx::query(
        "SELECT TABLE_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE \
         WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL",
    )
    .bind(database)
    .bind(database)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("检查外键边界失败: {error}"))?;

    let mut warnings = Vec::new();
    for row in rows {
        let table = mysql_text::string(&row, "TABLE_NAME").unwrap_or_default();
        let referenced = mysql_text::string(&row, "REFERENCED_TABLE_NAME").unwrap_or_default();
        let table_included = included.contains(&table.to_lowercase());
        let table_excluded = excluded.contains(&table.to_lowercase());
        let referenced_included = included.contains(&referenced.to_lowercase());
        let referenced_excluded = excluded.contains(&referenced.to_lowercase());
        if (table_included && referenced_excluded) || (table_excluded && referenced_included) {
            warnings.push(format!("数据库 {database} 中表 {table} 与排除/同步边界表 {referenced} 存在外键关系，请同步后检查约束"));
        }
    }
    Ok(warnings)
}

fn sorted_unique(values: Vec<String>) -> Vec<String> {
    let mut by_lower: HashMap<String, String> = HashMap::new();
    for value in values {
        let name = value.trim();
        if !name.is_empty() {
            by_lower
                .entry(name.to_lowercase())
                .or_insert_with(|| name.to_string());
        }
    }
    let mut out = by_lower.into_values().collect::<Vec<_>>();
    out.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    out
}

fn table_plans(
    included_tables: &[String],
    preserved_tables: &[String],
    dropped_tables: &[String],
) -> Vec<DatabaseSyncTablePlan> {
    let mut plans = Vec::new();
    plans.extend(
        included_tables
            .iter()
            .cloned()
            .map(|name| DatabaseSyncTablePlan {
                name,
                action: "copy".into(),
            }),
    );
    plans.extend(
        preserved_tables
            .iter()
            .cloned()
            .map(|name| DatabaseSyncTablePlan {
                name,
                action: "preserve-excluded".into(),
            }),
    );
    plans.extend(
        dropped_tables
            .iter()
            .cloned()
            .map(|name| DatabaseSyncTablePlan {
                name,
                action: "remove".into(),
            }),
    );
    plans
}

fn find_table_definition_body(remainder: &str) -> Option<usize> {
    let mut chars = remainder.char_indices().peekable();
    skip_ws(&mut chars);
    if matches!(chars.peek(), Some((_, '`'))) {
        consume_quoted_ident(&mut chars)?;
        skip_ws(&mut chars);
        if matches!(chars.peek(), Some((_, '.'))) {
            chars.next();
            skip_ws(&mut chars);
            if matches!(chars.peek(), Some((_, '`'))) {
                consume_quoted_ident(&mut chars)?;
            } else {
                consume_bare_ident(&mut chars)?;
            }
        }
    } else {
        consume_bare_ident(&mut chars)?;
        skip_ws(&mut chars);
        if matches!(chars.peek(), Some((_, '.'))) {
            chars.next();
            skip_ws(&mut chars);
            if matches!(chars.peek(), Some((_, '`'))) {
                consume_quoted_ident(&mut chars)?;
            } else {
                consume_bare_ident(&mut chars)?;
            }
        }
    }
    chars.peek().map(|(idx, _)| *idx).or(Some(remainder.len()))
}

fn skip_ws(chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>) {
    while matches!(chars.peek(), Some((_, ch)) if ch.is_whitespace()) {
        chars.next();
    }
}

fn consume_quoted_ident(chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>) -> Option<()> {
    if !matches!(chars.next(), Some((_, '`'))) {
        return None;
    }
    while let Some((_, ch)) = chars.next() {
        if ch == '`' {
            if matches!(chars.peek(), Some((_, '`'))) {
                chars.next();
            } else {
                return Some(());
            }
        }
    }
    None
}

fn consume_bare_ident(chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>) -> Option<()> {
    let mut consumed = false;
    while matches!(chars.peek(), Some((_, ch)) if !ch.is_whitespace() && *ch != '(' && *ch != '.') {
        chars.next();
        consumed = true;
    }
    consumed.then_some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_exclusions_trims_removes_empty_and_deduplicates_case_insensitively() {
        let normalized = normalize_exclusions(vec![
            " player ".into(),
            "".into(),
            "PLAYER".into(),
            " inventory".into(),
            "Inventory ".into(),
            "guild".into(),
        ]);

        assert_eq!(normalized, vec!["guild", "inventory", "player"]);
    }

    #[test]
    fn overwrite_sync_never_creates_a_server_side_backup_database() {
        let source = include_str!("sync.rs");
        let create_database = ["CREATE", " DATABASE"].concat();
        let drop_database = ["DROP", " DATABASE"].concat();
        let legacy_prefix = ["__dbscout_sync", "_backup_"].concat();
        assert!(!source.contains(&create_database));
        assert!(!source.contains(&drop_database));
        assert!(!source.contains(&legacy_prefix));
    }

    #[test]
    fn overwrite_sync_guards_slow_sql_and_verifies_the_final_database() {
        let source = include_str!("sync.rs");
        let body = source
            .split("async fn overwrite_target_database")
            .nth(1)
            .expect("overwrite function exists");

        assert!(body.contains("配置目标库同步会话"));
        assert!(body.contains("关闭目标库外键检查"));
        assert!(source.contains("const MYSQL_SYNC_LOCK_WAIT_SECONDS: u64 = 15"));
        assert!(source.contains("正在创建目标库本地安全快照，已运行"));
        assert!(source.contains("正在从本地快照恢复目标库"));
        for start_message in [
            "正在删除目标表 {table}",
            "正在创建目标表 {table}",
            "正在复制表 {table}",
        ] {
            let start = body.find(start_message).expect("start progress exists");
            let operation = body[start..]
                .find("execute_sql_with_watchdog(")
                .map(|offset| start + offset)
                .expect("slow operation exists after progress");
            assert!(
                start < operation,
                "{start_message} must be emitted before the guarded operation"
            );
        }
        assert!(body.contains("verify_and_repair_target("));
        assert!(source.contains("run_with_heartbeat("));
    }

    #[test]
    fn lock_wait_errors_are_retried_but_connection_errors_are_not() {
        assert!(is_retryable_lock_error(
            "error returned from database: 1205 (HY000): Lock wait timeout exceeded"
        ));
        assert!(is_retryable_lock_error(
            "metadata lock could not be acquired"
        ));
        assert!(!is_retryable_lock_error("connection reset by peer"));
    }

    #[test]
    fn fatal_connection_errors_force_a_fresh_connection_for_restore() {
        for error in [
            "创建目标表超时（已等待 90 秒）",
            "覆盖同步已停止",
            "database sync cancelled",
            "connection reset by peer",
            "broken pipe",
            "unexpected EOF",
        ] {
            assert!(is_connection_fatal_error(error), "{error}");
        }
        assert!(!is_connection_fatal_error(
            "1205 (HY000): Lock wait timeout exceeded"
        ));
    }

    #[test]
    fn compute_preview_preserves_exclusions_and_drops_target_only_base_tables() {
        let source_tables = vec!["player".into(), "inventory".into(), "quest".into()];
        let target_tables = vec!["player".into(), "audit_log".into(), "local_config".into()];
        let excluded_tables = normalize_exclusions(vec![" quest ".into(), "missing_source".into()]);
        let row_counts = std::collections::HashMap::from([
            ("player".to_string(), 10_u64),
            ("inventory".to_string(), 5_u64),
            ("quest".to_string(), 7_u64),
        ]);

        let preview = compute_preview(source_tables, target_tables, excluded_tables, &row_counts);

        assert_eq!(preview.source_tables, vec!["inventory", "player", "quest"]);
        assert_eq!(
            preview.target_tables,
            vec!["audit_log", "local_config", "player"]
        );
        assert_eq!(preview.included_tables, vec!["inventory", "player"]);
        assert_eq!(preview.excluded_tables, vec!["quest"]);
        assert_eq!(
            preview.target_only_tables_to_drop,
            vec!["audit_log", "local_config"]
        );
        assert!(preview.preserved_target_tables.is_empty());
        assert_eq!(preview.estimated_rows, 15);
        assert!(preview
            .warnings
            .iter()
            .any(|warning| warning.contains("missing_source")));
    }

    #[test]
    fn rewrite_create_table_qualifies_table_for_destination_database() {
        let ddl =
            "CREATE TABLE `orders` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB";

        let rewritten = rewrite_create_table_for_database(ddl, "source_db", "target`db", "orders")
            .expect("DDL rewrites");

        assert!(rewritten.starts_with("CREATE TABLE `target``db`.`orders`"));
        assert!(rewritten.contains("PRIMARY KEY (`id`)"));
    }

    #[test]
    fn rewrite_create_table_handles_utf8_comments_without_panicking() {
        let ddl = "CREATE TABLE `achievementprop` (\n  `id` int NOT NULL COMMENT '成就编号',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB COMMENT='运营成就任务配置'";

        let rewritten =
            rewrite_create_table_for_database(ddl, "edota_17cfg", "edota_15cfg", "achievementprop")
                .expect("UTF-8 comments must not break DDL rewriting");

        assert!(rewritten.starts_with("CREATE TABLE `edota_15cfg`.`achievementprop`"));
        assert!(rewritten.contains("COMMENT '成就编号'"));
        assert!(rewritten.contains("COMMENT='运营成就任务配置'"));
    }

    #[test]
    fn rewrite_create_table_handles_if_not_exists_prefix() {
        let ddl = "CREATE TABLE IF NOT EXISTS `source_db`.`orders` (`id` int NOT NULL)";

        let rewritten = rewrite_create_table_for_database(ddl, "source_db", "backup_db", "orders")
            .expect("DDL rewrites");

        assert_eq!(
            rewritten,
            "CREATE TABLE IF NOT EXISTS `backup_db`.`orders` (`id` int NOT NULL)"
        );
    }

    #[test]
    fn rewrite_create_table_for_database_rewrites_same_schema_references() {
        let ddl = "CREATE TABLE `source_db`.`child` (\n  `id` int NOT NULL,\n  `parent_id` int NOT NULL,\n  PRIMARY KEY (`id`),\n  CONSTRAINT `child_parent_fk` FOREIGN KEY (`parent_id`) REFERENCES `source_db`.`parent` (`id`)\n) ENGINE=InnoDB";

        let rewritten = rewrite_create_table_for_database(ddl, "source_db", "target_db", "child")
            .expect("DDL rewrites");

        assert!(
            rewritten.contains("REFERENCES `target_db`.`parent` (`id`)"),
            "rewritten DDL was: {rewritten}"
        );
        assert!(
            !rewritten.contains("REFERENCES `source_db`.`parent`"),
            "rewritten DDL was: {rewritten}"
        );
    }

    #[test]
    fn rewrite_create_table_for_database_preserves_external_schema_references() {
        let ddl = "CREATE TABLE `source_db`.`orders` (\n  `id` int NOT NULL,\n  `user_id` int NOT NULL,\n  PRIMARY KEY (`id`),\n  CONSTRAINT `orders_user_fk` FOREIGN KEY (`user_id`) REFERENCES `auth_db`.`users` (`id`)\n) ENGINE=InnoDB";

        let rewritten = rewrite_create_table_for_database(ddl, "source_db", "target_db", "orders")
            .expect("DDL rewrites");

        assert!(
            rewritten.contains("REFERENCES `auth_db`.`users` (`id`)"),
            "rewritten DDL was: {rewritten}"
        );
        assert!(
            !rewritten.contains("REFERENCES `target_db`.`users`"),
            "rewritten DDL was: {rewritten}"
        );
    }

    #[test]
    fn rewrite_create_table_for_database_preserves_case_sensitive_different_schema_references() {
        let ddl = "CREATE TABLE `game`.`orders` (\n  `id` int NOT NULL,\n  `user_id` int NOT NULL,\n  PRIMARY KEY (`id`),\n  CONSTRAINT `orders_user_fk` FOREIGN KEY (`user_id`) REFERENCES `Game`.`users` (`id`)\n) ENGINE=InnoDB";

        let rewritten = rewrite_create_table_for_database(ddl, "game", "target_db", "orders")
            .expect("DDL rewrites");

        assert!(
            rewritten.contains("REFERENCES `Game`.`users` (`id`)"),
            "case-different schema Game should not be rewritten to target_db; rewritten DDL was: {rewritten}"
        );
        assert!(
            !rewritten.contains("REFERENCES `target_db`.`users`"),
            "case-different schema Game should not be treated as same-schema; rewritten DDL was: {rewritten}"
        );
    }

    #[test]
    fn insertable_columns_exclude_generated_columns_and_copy_sql_uses_explicit_columns() {
        let columns = vec![
            ColumnInfo {
                name: "id".into(),
                data_type: "bigint".into(),
                extra: "".into(),
                generation_expression: "".into(),
            },
            ColumnInfo {
                name: "full_name".into(),
                data_type: "varchar".into(),
                extra: "VIRTUAL GENERATED".into(),
                generation_expression: "concat(first_name,last_name)".into(),
            },
            ColumnInfo {
                name: "created`at".into(),
                data_type: "timestamp".into(),
                extra: "DEFAULT_GENERATED".into(),
                generation_expression: "".into(),
            },
        ];

        let insertable = insertable_columns(&columns);
        let sql = build_copy_table_sql("source_db", "target_db", "user`profile", &insertable)
            .expect("copy SQL builds");

        assert_eq!(insertable, vec!["id", "created`at"]);
        assert_eq!(
            sql,
            "INSERT INTO `target_db`.`user``profile` (`id`, `created``at`) SELECT `id`, `created``at` FROM `source_db`.`user``profile`"
        );
    }

    #[test]
    fn sync_status_maps_restore_outcomes_to_frontend_contract() {
        assert_eq!(status_for_outcome(SyncOutcome::Succeeded), "succeeded");
        assert_eq!(status_for_outcome(SyncOutcome::Cancelled), "cancelled");
        assert_eq!(
            status_for_outcome(SyncOutcome::CancelledRestored),
            "cancelledRestored"
        );
        assert_eq!(
            status_for_outcome(SyncOutcome::CancelledRestoreFailed),
            "cancelledRestoreFailed"
        );
        assert_eq!(
            status_for_outcome(SyncOutcome::FailedRestored),
            "failedRestored"
        );
        assert_eq!(
            status_for_outcome(SyncOutcome::FailedRestoreFailed),
            "failedRestoreFailed"
        );
    }

    #[test]
    fn sync_success_message_only_claims_full_equality_without_exclusions() {
        assert!(sync_success_message(&[]).contains("完全相同"));
        assert!(sync_success_message(&["audit_log".into()]).contains("未排除表"));
        assert!(!sync_success_message(&["audit_log".into()]).contains("完全相同"));
    }

    #[test]
    fn failures_before_target_mutation_do_not_request_restore() {
        let failure = SyncError::without_restore("snapshot failed before target mutation");

        assert_eq!(
            direct_error_message(&failure),
            Some("snapshot failed before target mutation")
        );
        assert_eq!(status_for_error(&failure), None);
    }

    #[test]
    fn failures_during_target_mutation_request_restore() {
        let failure = SyncError::requires_restore("copy failed after target mutation");

        assert_eq!(direct_error_message(&failure), None);
        assert_eq!(status_for_error(&failure), Some("failedRestored"));
    }

    #[test]
    fn internal_panics_request_restore_only_after_a_snapshot_exists() {
        let before_snapshot = sync_panic_error(Box::new("DDL parser panic"), false);
        let after_snapshot = sync_panic_error(Box::new("DDL parser panic"), true);

        assert!(!before_snapshot.requires_restore);
        assert!(before_snapshot.message.contains("DDL parser panic"));
        assert!(after_snapshot.requires_restore);
        assert!(after_snapshot.message.contains("DDL parser panic"));
    }

    #[test]
    fn foreign_key_guard_result_preserves_work_error_when_reenable_succeeds() {
        let result = foreign_key_guard_result::<()>(Err("restore failed".into()), Ok(()));

        assert_eq!(result, Err("restore failed".into()));
    }

    #[test]
    fn foreign_key_guard_result_preserves_work_error_and_reports_reenable_failure() {
        let result = foreign_key_guard_result::<()>(
            Err("restore failed".into()),
            Err("reenable failed".into()),
        );

        assert_eq!(
            result,
            Err("restore failed；重新启用 FOREIGN_KEY_CHECKS 失败: reenable failed".into())
        );
    }

    #[test]
    fn foreign_key_guard_result_reports_reenable_failure_when_work_succeeds() {
        let result = foreign_key_guard_result(
            Ok(vec!["warning".to_string()]),
            Err("reenable failed".into()),
        );

        assert_eq!(
            result,
            Err("重新启用 FOREIGN_KEY_CHECKS 失败: reenable failed".into())
        );
    }

    #[tokio::test]
    async fn run_concurrent_workers_bounds_parallelism_and_propagates_errors() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let active = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut collected = Vec::new();
        let mut emitted = Vec::new();
        let mut emit = |ev: DatabaseSyncProgress| emitted.push(ev);

        let active_clone = active.clone();
        let max_clone = max_seen.clone();
        run_concurrent_workers(
            0..20usize,
            4,
            move |idx| {
                let active_c = active_clone.clone();
                let max_c = max_clone.clone();
                let tx_c = tx.clone();
                async move {
                    let now = active_c.fetch_add(1, Ordering::SeqCst) + 1;
                    max_c.fetch_max(now, Ordering::SeqCst);
                    let _ = tx_c.send(progress(
                        "job-1",
                        "copyData",
                        "stalled",
                        None,
                        idx as u64,
                        20,
                        None,
                        None,
                        None,
                        "stalled",
                    ));
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    active_c.fetch_sub(1, Ordering::SeqCst);
                    Ok(idx)
                }
            },
            rx,
            &mut emit,
            |idx, _emit, _last| collected.push(idx),
        )
        .await
        .expect("all 20 worker tasks should finish cleanly");

        collected.sort_unstable();
        assert_eq!(collected, (0..20).collect::<Vec<_>>());
        assert!(max_seen.load(Ordering::SeqCst) <= 4);
        assert!(max_seen.load(Ordering::SeqCst) >= 2);
        assert!(!emitted.is_empty());

        let (_tx2, rx2) = tokio::sync::mpsc::unbounded_channel();
        let mut noop_emit = |_ev: DatabaseSyncProgress| {};
        let err = run_concurrent_workers(
            0..10usize,
            4,
            |idx| async move {
                if idx == 3 {
                    Err("boom on table 3".to_string())
                } else {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    Ok(idx)
                }
            },
            rx2,
            &mut noop_emit,
            |_idx, _emit, _last| {},
        )
        .await;
        assert_eq!(err, Err("boom on table 3".to_string()));
    }
}
