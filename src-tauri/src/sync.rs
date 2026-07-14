use std::collections::{HashMap, HashSet};

use sqlx::{MySqlConnection, MySqlPool, Row};
use tauri::AppHandle;

use crate::backup;
use crate::db::escape_ident;
use crate::types::{
    BackupConfig, DatabaseSyncProgress, DatabaseSyncTablePlan, PreviewDatabaseSyncResponse,
    SyncDatabaseOverwriteRequest, SyncDatabaseOverwriteResponse,
};

pub const DATABASE_SYNC_PROGRESS_EVENT: &str = "database-sync-progress";

const SYSTEM_DATABASES: &[&str] = &["information_schema", "mysql", "performance_schema", "sys"];
const MYSQL_SYNC_LOCK_WAIT_SECONDS: u64 = 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnInfo {
    pub name: String,
    pub extra: String,
    pub generation_expression: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncOutcome {
    Succeeded,
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
    end <= sql.len()
        && sql[index..end].eq_ignore_ascii_case(keyword)
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
    ensure_database_exists(pool, source_database).await?;
    ensure_database_exists(pool, target_database).await?;
    let exclusions = normalize_exclusions(excluded_tables);
    let source_tables = list_base_tables(pool, source_database).await?;
    let target_tables = list_base_tables(pool, target_database).await?;
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

    let result = run_database_sync(
        app,
        mysql_url,
        backup_config,
        pool,
        &request,
        &mut emit,
        &mut copied_tables,
        &mut copied_rows,
        &mut dropped_tables,
        &mut backup_snapshot_path,
        &mut warnings,
    )
    .await;

    match result {
        Ok(()) => {
            emit(progress(
                &job_id,
                "completed",
                "覆盖同步完成",
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
                message: "覆盖同步完成".into(),
                warnings,
            })
        }
        Err(error) if error.requires_restore => {
            let snapshot_path = backup_snapshot_path.clone();
            emit(progress(
                &job_id,
                "restore",
                "同步失败，正在从本地快照恢复目标库",
                None,
                0,
                0,
                None,
                None,
                snapshot_path.clone(),
                "restoring",
            ));
            let restore_result = if let Some(path) = snapshot_path.as_deref() {
                backup::restore_sync_protection_snapshot(
                    mysql_url,
                    &request.connection_id,
                    &request.target_database,
                    path,
                )
                .await
            } else {
                Err("本地同步快照不存在，无法恢复".into())
            };
            match restore_result {
                Ok(()) => {
                    emit(progress(
                        &job_id,
                        "failed",
                        "同步失败，已恢复目标库",
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
                        status: status_for_error(&error)
                            .unwrap_or(status_for_outcome(SyncOutcome::FailedRestored))
                            .into(),
                        copied_tables,
                        copied_rows,
                        dropped_tables,
                        backup_snapshot_path: snapshot_path,
                        message: error.message,
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
                        status: status_for_outcome(SyncOutcome::FailedRestoreFailed).into(),
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

    let preview = preview_database_sync(
        pool,
        &request.source_database,
        &request.target_database,
        request.excluded_tables.clone(),
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

    let snapshot = backup::create_sync_protection_snapshot(
        app,
        mysql_url,
        &request.connection_id,
        &request.target_database,
        backup_config,
        &request.job_id,
        |snapshot_progress| {
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
        },
    )
    .await
    .map_err(SyncError::without_restore)?;
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
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| SyncError::without_restore(format!("获取 MySQL 连接失败: {error}")))?;
    let mutation_result = overwrite_target_database(
        &mut connection,
        request,
        &preview,
        emit,
        copied_tables,
        copied_rows,
        dropped_tables,
        backup_snapshot_path.clone(),
    )
    .await;
    foreign_key_guard_result(
        mutation_result,
        set_foreign_key_checks(&mut connection, true).await,
    )
    .map_err(SyncError::requires_restore)?;

    emit(progress(
        &request.job_id,
        "finalize",
        "覆盖同步完成，本地安全快照已保留",
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

async fn overwrite_target_database<F>(
    connection: &mut MySqlConnection,
    request: &SyncDatabaseOverwriteRequest,
    preview: &PreviewDatabaseSyncResponse,
    emit: &mut F,
    copied_tables: &mut Vec<String>,
    copied_rows: &mut u64,
    dropped_tables: &mut Vec<String>,
    backup_snapshot_path: Option<String>,
) -> Result<(), String>
where
    F: FnMut(DatabaseSyncProgress),
{
    set_session_lock_wait_limits(connection).await?;
    set_foreign_key_checks(connection, false).await?;

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

    emit(progress(
        &request.job_id,
        "dropTarget",
        "正在删除目标库旧表",
        None,
        0,
        target_tables_to_drop.len() as u64,
        None,
        None,
        backup_snapshot_path.clone(),
        "running",
    ));
    for (index, table) in target_tables_to_drop.iter().enumerate() {
        emit(progress(
            &request.job_id,
            "dropTarget",
            &format!(
                "正在删除目标表 {table}（第 {} / {} 张）",
                index + 1,
                target_tables_to_drop.len()
            ),
            Some(table.clone()),
            index as u64,
            target_tables_to_drop.len() as u64,
            None,
            None,
            backup_snapshot_path.clone(),
            "running",
        ));
        drop_table(connection, &request.target_database, table).await?;
        dropped_tables.push(table.clone());
        emit(progress(
            &request.job_id,
            "dropTarget",
            &format!("已删除目标表 {table}"),
            Some(table.clone()),
            (index + 1) as u64,
            target_tables_to_drop.len() as u64,
            None,
            None,
            backup_snapshot_path.clone(),
            "running",
        ));
    }

    emit(progress(
        &request.job_id,
        "createTarget",
        "正在创建目标库表结构",
        None,
        0,
        preview.included_tables.len() as u64,
        None,
        None,
        backup_snapshot_path.clone(),
        "running",
    ));
    for (index, table) in preview.included_tables.iter().enumerate() {
        emit(progress(
            &request.job_id,
            "createTarget",
            &format!(
                "正在创建目标表 {table}（第 {} / {} 张）",
                index + 1,
                preview.included_tables.len()
            ),
            Some(table.clone()),
            index as u64,
            preview.included_tables.len() as u64,
            None,
            None,
            backup_snapshot_path.clone(),
            "running",
        ));
        let ddl = show_create_table(connection, &request.source_database, table).await?;
        let rewritten = rewrite_create_table_for_database(
            &ddl,
            &request.source_database,
            &request.target_database,
            table,
        )?;
        sqlx::query(&rewritten)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("创建目标表 {table} 失败: {error}"))?;
        emit(progress(
            &request.job_id,
            "createTarget",
            &format!("已创建目标表 {table}"),
            Some(table.clone()),
            (index + 1) as u64,
            preview.included_tables.len() as u64,
            None,
            None,
            backup_snapshot_path.clone(),
            "running",
        ));
    }

    let total_rows = preview.estimated_rows;
    emit(progress(
        &request.job_id,
        "copyData",
        "正在复制源库数据",
        None,
        0,
        preview.included_tables.len() as u64,
        Some(0),
        Some(total_rows),
        backup_snapshot_path.clone(),
        "running",
    ));
    for (index, table) in preview.included_tables.iter().enumerate() {
        if target_set.contains(&table.to_lowercase())
            || preview
                .source_tables
                .iter()
                .any(|source| source.eq_ignore_ascii_case(table))
        {
            emit(progress(
                &request.job_id,
                "copyData",
                &format!(
                    "正在复制表 {table}（第 {} / {} 张）",
                    index + 1,
                    preview.included_tables.len()
                ),
                Some(table.clone()),
                index as u64,
                preview.included_tables.len() as u64,
                Some(*copied_rows),
                Some(total_rows),
                backup_snapshot_path.clone(),
                "running",
            ));
            let columns = list_columns(connection, &request.source_database, table).await?;
            let insertable = insertable_columns(&columns);
            let sql = build_copy_table_sql(
                &request.source_database,
                &request.target_database,
                table,
                &insertable,
            )?;
            let rows = sqlx::query(&sql)
                .execute(&mut *connection)
                .await
                .map_err(|error| format!("复制表 {table} 数据失败: {error}"))?
                .rows_affected();
            copied_tables.push(table.clone());
            *copied_rows = copied_rows.saturating_add(rows);
            emit(progress(
                &request.job_id,
                "copyData",
                &format!("已复制表 {table}"),
                Some(table.clone()),
                (index + 1) as u64,
                preview.included_tables.len() as u64,
                Some(*copied_rows),
                Some(total_rows),
                backup_snapshot_path.clone(),
                "running",
            ));
        }
    }
    Ok(())
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
        .filter_map(|row| row.try_get::<String, _>("TABLE_NAME").ok())
        .collect())
}

pub async fn count_rows(
    pool: &MySqlPool,
    database: &str,
    tables: &[String],
) -> Result<HashMap<String, u64>, String> {
    let mut counts = HashMap::new();
    for table in tables {
        let sql = format!(
            "SELECT COUNT(*) AS cnt FROM `{}`.`{}`",
            escape_ident(database),
            escape_ident(table)
        );
        let count = sqlx::query(&sql)
            .fetch_one(pool)
            .await
            .map_err(|error| format!("统计表 {table} 行数失败: {error}"))?
            .try_get::<i64, _>("cnt")
            .unwrap_or(0)
            .max(0) as u64;
        counts.insert(table.clone(), count);
    }
    Ok(counts)
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
    row.try_get::<String, _>("Create Table")
        .or_else(|_| row.try_get::<String, _>(1))
        .map_err(|error| format!("读取表 {table} DDL 失败: {error}"))
}

pub(crate) async fn list_columns(
    connection: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let rows = sqlx::query(
        "SELECT COLUMN_NAME, COALESCE(EXTRA, '') AS EXTRA, COALESCE(GENERATION_EXPRESSION, '') AS GENERATION_EXPRESSION \
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
            name: row.try_get("COLUMN_NAME").unwrap_or_default(),
            extra: row.try_get("EXTRA").unwrap_or_default(),
            generation_expression: row.try_get("GENERATION_EXPRESSION").unwrap_or_default(),
        })
        .collect())
}

async fn drop_table(
    connection: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<(), String> {
    let sql = format!(
        "DROP TABLE IF EXISTS `{}`.`{}`",
        escape_ident(database),
        escape_ident(table)
    );
    sqlx::query(&sql)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("删除表 {table} 失败: {error}"))?;
    Ok(())
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
        let table = row.try_get::<String, _>("TABLE_NAME").unwrap_or_default();
        let referenced = row
            .try_get::<String, _>("REFERENCED_TABLE_NAME")
            .unwrap_or_default();
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
    fn overwrite_sync_limits_lock_waits_and_reports_each_table_before_slow_sql() {
        let source = include_str!("sync.rs");
        let body = source
            .split("async fn overwrite_target_database")
            .nth(1)
            .expect("overwrite function exists");

        assert!(body.contains("set_session_lock_wait_limits(connection).await?"));
        for (start_message, operation) in [
            ("正在删除目标表 {table}", "drop_table(connection"),
            ("正在创建目标表 {table}", "sqlx::query(&rewritten)"),
            ("正在复制表 {table}", "sqlx::query(&sql)"),
        ] {
            let start = body.find(start_message).expect("start progress exists");
            let operation = body[start..]
                .find(operation)
                .map(|offset| start + offset)
                .expect("slow operation exists after progress");
            assert!(
                start < operation,
                "{start_message} must be emitted before {operation}"
            );
        }
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
                extra: "".into(),
                generation_expression: "".into(),
            },
            ColumnInfo {
                name: "full_name".into(),
                extra: "VIRTUAL GENERATED".into(),
                generation_expression: "concat(first_name,last_name)".into(),
            },
            ColumnInfo {
                name: "created`at".into(),
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
}
