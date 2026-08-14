use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use sqlx::{
    mysql::{MySqlDatabaseError, MySqlQueryResult},
    Executor, MySqlConnection, MySqlPool,
};
use tokio::sync::{watch, Mutex};
use uuid::Uuid;

use crate::db::escape_ident;
use crate::ddl::TableDesignTypeChange;
use crate::mysql_text;
use crate::types::{ColumnMeta, TableDesignDraft, TableDesignMeta, TableMeta};

const CONFLICT_SAMPLE_LIMIT: usize = 3;
const CONFLICT_SAMPLE_MAX_CHARS: usize = 48;
const VALIDATION_CANCELLED_MESSAGE: &str = "字段数据检查已取消";

const VALIDATION_JOB_TTL: Duration = Duration::from_secs(300);

struct ValidationJob {
    cancellation: watch::Sender<bool>,
    started: bool,
    created_at: Instant,
}

static VALIDATION_JOBS: OnceLock<Mutex<HashMap<String, ValidationJob>>> = OnceLock::new();

#[derive(Debug, Default)]
pub struct TableDesignValidationOutcome {
    pub conflicts: Vec<String>,
    pub warnings: Vec<String>,
}

fn validation_jobs() -> &'static Mutex<HashMap<String, ValidationJob>> {
    VALIDATION_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug)]
struct TypeChangeCheck {
    source_column_name: String,
    target_type: String,
    target_table: TableMeta,
    invalid_count: u64,
    samples: Vec<String>,
    first_reason: Option<String>,
}

impl TypeChangeCheck {
    fn from_change(change: TableDesignTypeChange) -> Self {
        let target_type = change.target_column.column_type.clone();
        Self {
            source_column_name: change.source_column_name,
            target_type,
            target_table: TableMeta {
                table_name: String::new(),
                table_comment: String::new(),
                columns: vec![change.target_column],
            },
            invalid_count: 0,
            samples: Vec::new(),
            first_reason: None,
        }
    }

    fn target_column(&self) -> &ColumnMeta {
        &self.target_table.columns[0]
    }

    fn inspect(&mut self, value: Option<&str>) {
        let Some(reason) = materialized_conversion_error(self.target_column(), value) else {
            return;
        };
        self.record_invalid(display_sample(value), reason);
    }

    fn record_invalid(&mut self, sample: String, reason: String) {
        self.invalid_count += 1;
        if self.first_reason.is_none() {
            self.first_reason = Some(reason);
        }
        if self.samples.len() < CONFLICT_SAMPLE_LIMIT {
            self.samples.push(sample);
        }
    }

    fn conflict(self) -> Option<String> {
        if self.invalid_count == 0 {
            return None;
        }
        let samples = if self.samples.is_empty() {
            String::new()
        } else {
            format!("，例如 {}", self.samples.join("、"))
        };
        let reason = self
            .first_reason
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("（{value}）"))
            .unwrap_or_default();
        Some(format!(
            "字段「{}」有 {} 个现有值无法转换为 {}{}{}",
            self.source_column_name, self.invalid_count, self.target_type, samples, reason
        ))
    }
}

fn normalized_type(column: &ColumnMeta) -> String {
    column
        .data_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&column.column_type)
        .trim()
        .to_ascii_lowercase()
        .split(|ch: char| ch == '(' || ch.is_whitespace())
        .find(|part| !part.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn first_type_number(column_type: &str) -> Option<usize> {
    let open = column_type.find('(')?;
    let close = column_type[open + 1..].find(')')? + open + 1;
    column_type[open + 1..close]
        .split(',')
        .next()?
        .trim()
        .parse()
        .ok()
}

fn text_or_blob_byte_limit(data_type: &str) -> Option<u64> {
    match data_type {
        "tinytext" | "tinyblob" => Some(255),
        "text" | "blob" => Some(65_535),
        "mediumtext" | "mediumblob" => Some(16_777_215),
        "longtext" | "longblob" => Some(4_294_967_295),
        _ => None,
    }
}

fn target_accepts_empty_string(column: &ColumnMeta) -> bool {
    matches!(
        normalized_type(column).as_str(),
        "char"
            | "varchar"
            | "binary"
            | "varbinary"
            | "tinytext"
            | "text"
            | "mediumtext"
            | "longtext"
            | "tinyblob"
            | "blob"
            | "mediumblob"
            | "longblob"
            | "enum"
            | "set"
    )
}

fn materialized_conversion_error(column: &ColumnMeta, value: Option<&str>) -> Option<String> {
    let Some(raw) = value else {
        return (column.is_primary_key || !column.is_nullable).then(|| "不能为空".into());
    };
    let data_type = normalized_type(column);

    if raw.is_empty() {
        return (!target_accepts_empty_string(column)).then(|| "空字符串不能转换".into());
    }
    if raw.trim().is_empty() && !target_accepts_empty_string(column) {
        return Some("空白字符串不能转换".into());
    }

    if matches!(data_type.as_str(), "char" | "varchar") {
        if let Some(maximum) = first_type_number(&column.column_type) {
            if raw.chars().count() > maximum {
                return Some("长度超限".into());
            }
        }
        return None;
    }
    if matches!(data_type.as_str(), "binary" | "varbinary") {
        if let Some(maximum) = first_type_number(&column.column_type) {
            if raw.len() > maximum {
                return Some("字节长度超限".into());
            }
        }
        return None;
    }
    if let Some(maximum) = text_or_blob_byte_limit(&data_type) {
        if raw.len() as u64 > maximum {
            return Some("字节长度超限".into());
        }
        return None;
    }
    if data_type == "bit" {
        let width = first_type_number(&column.column_type).unwrap_or(1).min(64);
        let numeric = raw
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|_| raw.trim().chars().all(|ch| ch.is_ascii_digit()));
        let maximum = if width == 64 {
            u64::MAX
        } else {
            (1_u64 << width) - 1
        };
        return (numeric.is_none() || numeric.is_some_and(|value| value > maximum))
            .then(|| "位值超出范围".into());
    }

    let mut validation_column = column.clone();
    if matches!(data_type.as_str(), "bool" | "boolean")
        || (data_type == "tinyint" && first_type_number(&column.column_type) == Some(1))
    {
        // MySQL BOOL/TINYINT(1) is still a signed TINYINT. Display width 1
        // must not turn valid values such as 2 into a boolean-only check.
        validation_column.column_type = "tinyint".into();
        validation_column.data_type = Some("tinyint".into());
    }
    if matches!(data_type.as_str(), "float" | "double" | "real")
        && !raw
            .trim()
            .parse::<f64>()
            .is_ok_and(|value| value.is_finite())
    {
        return Some("数字格式错误".into());
    }

    let target_name = validation_column.column_name.clone();
    let table = TableMeta {
        table_name: String::new(),
        table_comment: String::new(),
        columns: vec![validation_column],
    };
    crate::validation::validate_column_value(&table, &target_name, Some(raw))
        .err()
        .map(|error| error.short_message)
}

fn display_sample(value: Option<&str>) -> String {
    let Some(value) = value else {
        return "NULL".into();
    };
    let normalized = value
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t");
    let mut chars = normalized.chars();
    let head = chars
        .by_ref()
        .take(CONFLICT_SAMPLE_MAX_CHARS)
        .collect::<String>();
    let suffix = if chars.next().is_some() { "…" } else { "" };
    format!("「{head}{suffix}」")
}

fn checks(
    current: &TableDesignMeta,
    draft: &TableDesignDraft,
) -> Result<Vec<TypeChangeCheck>, String> {
    Ok(crate::ddl::table_design_type_changes(current, draft)?
        .into_iter()
        .map(TypeChangeCheck::from_change)
        .collect())
}

fn finish_checks(checks: Vec<TypeChangeCheck>) -> Vec<String> {
    checks
        .into_iter()
        .filter_map(TypeChangeCheck::conflict)
        .collect()
}

pub fn validate_materialized_rows(
    current: &TableDesignMeta,
    draft: &TableDesignDraft,
    rows: &[HashMap<String, String>],
) -> Result<Vec<String>, String> {
    let mut checks = checks(current, draft)?;
    if checks.is_empty() || rows.is_empty() {
        return Ok(Vec::new());
    }
    for row in rows {
        for check in &mut checks {
            check.inspect(row.get(&check.source_column_name).map(String::as_str));
        }
    }
    Ok(finish_checks(checks))
}

pub fn validate_optional_materialized_rows(
    current: &TableDesignMeta,
    draft: &TableDesignDraft,
    rows: Option<&[HashMap<String, String>]>,
) -> Result<Vec<String>, String> {
    if crate::ddl::table_design_type_changes(current, draft)?.is_empty() {
        return Ok(Vec::new());
    }
    let fallback_rows;
    let rows = if let Some(rows) = rows {
        rows
    } else {
        fallback_rows = crate::demo::demo_rows()
            .remove(&current.source.table_name)
            .unwrap_or_default();
        fallback_rows.as_slice()
    };
    validate_materialized_rows(current, draft, rows)
}

fn strict_sql_mode(current: &str) -> String {
    let mut modes = current
        .split(',')
        .map(str::trim)
        .filter(|mode| !mode.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if !modes
        .iter()
        .any(|mode| mode.eq_ignore_ascii_case("STRICT_ALL_TABLES"))
    {
        modes.push("STRICT_ALL_TABLES".into());
    }
    modes.join(",")
}

async fn configure_strict_session(connection: &mut MySqlConnection) -> Result<(), String> {
    let row = sqlx::query("SELECT @@SESSION.sql_mode AS sql_mode")
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("读取 MySQL 严格模式失败：{error}"))?;
    let current_mode = mysql_text::string(&row, "sql_mode")
        .map_err(|error| format!("读取 MySQL 严格模式失败：{error}"))?;
    sqlx::query("SET SESSION sql_mode = ?")
        .bind(strict_sql_mode(&current_mode))
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("启用 MySQL 严格模式失败：{error}"))?;
    crate::sync::set_session_lock_wait_limits(connection).await
}

fn scratch_table_name() -> String {
    format!("__dbscout_type_check_{}", Uuid::new_v4().simple())
}

fn scratch_column_name(index: usize) -> String {
    format!("__dbscout_col_{}", index + 1)
}

fn preserves_binary_character_semantics(change: &TableDesignTypeChange) -> bool {
    let target_type = normalized_type(&change.target_column);
    if !matches!(target_type.as_str(), "char" | "varchar") {
        return false;
    }
    let source_type = change.target_original_type.to_ascii_lowercase();
    source_type.contains("character set binary") || source_type.contains("collate binary")
}

fn scratch_create_sql(table_name: &str, changes: &[TableDesignTypeChange]) -> String {
    let definitions = changes
        .iter()
        .enumerate()
        .map(|(index, change)| {
            let target = &change.target_column;
            let character_semantics = if preserves_binary_character_semantics(change) {
                " CHARACTER SET binary"
            } else {
                ""
            };
            format!(
                "`{}` {}{} {}",
                scratch_column_name(index),
                target.column_type,
                character_semantics,
                if target.is_nullable {
                    "NULL"
                } else {
                    "NOT NULL"
                }
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "CREATE TEMPORARY TABLE `{}` ({definitions})",
        escape_ident(table_name)
    )
}

fn scratch_insert_sql(
    table_name: &str,
    current: &TableDesignMeta,
    changes: &[TableDesignTypeChange],
) -> String {
    let targets = changes
        .iter()
        .enumerate()
        .map(|(index, _)| format!("`{}`", scratch_column_name(index)))
        .collect::<Vec<_>>()
        .join(", ");
    let sources = changes
        .iter()
        .map(|change| format!("`{}`", escape_ident(&change.source_column_name)))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "INSERT INTO `{}` ({targets}) SELECT {sources} FROM `{}`.`{}`",
        escape_ident(table_name),
        escape_ident(&current.source.database),
        escape_ident(&current.source.table_name),
    )
}

fn changed_field_labels(changes: &[TableDesignTypeChange]) -> String {
    changes
        .iter()
        .map(|change| {
            if change
                .source_column_name
                .eq_ignore_ascii_case(&change.target_column.column_name)
            {
                change.source_column_name.clone()
            } else {
                format!(
                    "{} → {}",
                    change.source_column_name, change.target_column.column_name
                )
            }
        })
        .collect::<Vec<_>>()
        .join("、")
}

fn database_error_number(error: &sqlx::Error) -> Option<u16> {
    error
        .as_database_error()?
        .try_downcast_ref::<MySqlDatabaseError>()
        .map(MySqlDatabaseError::number)
}

fn is_data_conversion_error(error: &sqlx::Error) -> bool {
    let number = database_error_number(error);
    let normalized = error.to_string().to_ascii_lowercase();
    matches!(
        number,
        Some(1048 | 1138 | 1264 | 1265 | 1292 | 1366 | 1406 | 1411 | 1690 | 3140 | 3141)
    ) || normalized.contains("data truncated")
        || normalized.contains("incorrect integer value")
        || normalized.contains("incorrect decimal value")
        || normalized.contains("incorrect datetime value")
        || normalized.contains("out of range value")
        || normalized.contains("cannot be null")
}

fn is_temporary_table_permission_error(error: &sqlx::Error) -> bool {
    let number = database_error_number(error);
    let normalized = error.to_string().to_ascii_lowercase();
    matches!(number, Some(1044 | 1142 | 1227))
        || normalized.contains("create command denied")
        || normalized.contains("create temporary tables") && normalized.contains("denied")
}

fn user_facing_conversion_details(changes: &[TableDesignTypeChange], details: &str) -> String {
    changes
        .iter()
        .enumerate()
        .fold(details.trim().to_string(), |current, (index, change)| {
            current.replace(
                &scratch_column_name(index),
                &change.target_column.column_name,
            )
        })
}

fn conversion_conflict(changes: &[TableDesignTypeChange], details: &str) -> String {
    format!(
        "字段「{}」的现有值无法无损转换为目标类型。数据库返回：{}",
        changed_field_labels(changes),
        user_facing_conversion_details(changes, details)
    )
}

#[derive(Debug)]
enum CancelableQueryError {
    Cancelled,
    Database(sqlx::Error),
}

async fn execute_cancelable(
    connection: &mut MySqlConnection,
    sql: &str,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<MySqlQueryResult, CancelableQueryError> {
    if *cancellation.borrow() {
        return Err(CancelableQueryError::Cancelled);
    }
    tokio::select! {
        biased;
        changed = cancellation.changed() => {
            match changed {
                Ok(()) if *cancellation.borrow() => Err(CancelableQueryError::Cancelled),
                _ => Err(CancelableQueryError::Cancelled),
            }
        }
        result = sqlx::query(sql).execute(&mut *connection) => {
            result.map_err(CancelableQueryError::Database)
        }
    }
}

async fn start_validation_job(
    validation_id: Option<&str>,
) -> (Option<String>, watch::Sender<bool>, watch::Receiver<bool>) {
    let id = validation_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mut cancelled_before_start = false;
    if let Some(id) = &id {
        let mut jobs = validation_jobs().lock().await;
        jobs.retain(|_, job| job.created_at.elapsed() < VALIDATION_JOB_TTL);
        if let Some(previous) = jobs.remove(id) {
            cancelled_before_start = !previous.started && *previous.cancellation.borrow();
            if previous.started {
                let _ = previous.cancellation.send(true);
            }
        }
        let (sender, receiver) = watch::channel(cancelled_before_start);
        jobs.insert(
            id.clone(),
            ValidationJob {
                cancellation: sender.clone(),
                started: true,
                created_at: Instant::now(),
            },
        );
        return (Some(id.clone()), sender, receiver);
    }
    let (sender, receiver) = watch::channel(false);
    (None, sender, receiver)
}

async fn finish_validation_job(validation_id: Option<&str>, sender: &watch::Sender<bool>) {
    let Some(validation_id) = validation_id else {
        return;
    };
    let mut jobs = validation_jobs().lock().await;
    if jobs
        .get(validation_id)
        .is_some_and(|current| current.cancellation.same_channel(sender))
    {
        jobs.remove(validation_id);
    }
}

pub async fn cancel_validation(validation_id: &str) -> bool {
    let validation_id = validation_id.trim();
    if validation_id.is_empty() {
        return false;
    }
    let mut jobs = validation_jobs().lock().await;
    jobs.retain(|_, job| job.created_at.elapsed() < VALIDATION_JOB_TTL);
    if let Some(job) = jobs.get(validation_id) {
        return job.cancellation.send(true).is_ok();
    }

    // A user can cancel immediately after IPC dispatch, before the preview
    // command reaches its database scan. Keep a short-lived tombstone so that
    // the later registration starts in the cancelled state.
    let (sender, _receiver) = watch::channel(true);
    jobs.insert(
        validation_id.to_string(),
        ValidationJob {
            cancellation: sender,
            started: false,
            created_at: Instant::now(),
        },
    );
    true
}

async fn validate_mysql_type_changes(
    pool: &MySqlPool,
    current: &TableDesignMeta,
    changes: &[TableDesignTypeChange],
    cancellation: &mut watch::Receiver<bool>,
) -> Result<TableDesignValidationOutcome, String> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| format!("连接数据库检查字段数据失败：{error}"))?;
    // The session is deliberately discarded: it owns a temporary table and
    // modified session modes, and a cancelled MySQL query must never be put
    // back into the shared pool.
    connection.close_on_drop();
    configure_strict_session(&mut connection).await?;

    let scratch_name = scratch_table_name();
    let create_sql = scratch_create_sql(&scratch_name, changes);
    match execute_cancelable(&mut connection, &create_sql, cancellation).await {
        Ok(_) => {}
        Err(CancelableQueryError::Cancelled) => return Err(VALIDATION_CANCELLED_MESSAGE.into()),
        Err(CancelableQueryError::Database(error))
            if is_temporary_table_permission_error(&error) =>
        {
            return Ok(TableDesignValidationOutcome {
                conflicts: Vec::new(),
                warnings: vec![format!(
                    "当前账号没有临时表校验权限，预览无法提前扫描现有字段值；执行 ALTER 时仍会由数据库严格模式阻止不兼容转换。数据库返回：{}",
                    error
                )],
            });
        }
        Err(CancelableQueryError::Database(error)) => {
            return Err(format!(
                "准备字段类型检查失败：{}",
                apply_database_error(&error)
            ))
        }
    }

    let insert_sql = scratch_insert_sql(&scratch_name, current, changes);
    match execute_cancelable(&mut connection, &insert_sql, cancellation).await {
        Ok(_) => {}
        Err(CancelableQueryError::Cancelled) => return Err(VALIDATION_CANCELLED_MESSAGE.into()),
        Err(CancelableQueryError::Database(error)) if is_data_conversion_error(&error) => {
            return Ok(TableDesignValidationOutcome {
                conflicts: vec![conversion_conflict(changes, &error.to_string())],
                warnings: Vec::new(),
            });
        }
        Err(CancelableQueryError::Database(error)) => {
            return Err(format!(
                "检查字段现有数据失败：{}",
                apply_database_error(&error)
            ))
        }
    }

    let warning_rows = (&mut *connection)
        .fetch_all(sqlx::raw_sql("SHOW WARNINGS LIMIT 4"))
        .await
        .map_err(|error| format!("读取字段转换警告失败：{error}"))?;
    let warnings = warning_rows
        .iter()
        .filter_map(|row| {
            let level = mysql_text::string(row, "Level").ok()?;
            if level.eq_ignore_ascii_case("note") {
                return None;
            }
            mysql_text::string(row, "Message").ok()
        })
        .collect::<Vec<_>>();
    if warnings.is_empty() {
        Ok(TableDesignValidationOutcome::default())
    } else {
        Ok(TableDesignValidationOutcome {
            conflicts: vec![conversion_conflict(changes, &warnings.join("；"))],
            warnings: Vec::new(),
        })
    }
}

/// Ask MySQL itself to perform the conversion in a strict, connection-local
/// temporary table. Only errors/warnings cross the IPC boundary; table values
/// remain on the server.
pub async fn validate_mysql_rows(
    pool: &MySqlPool,
    current: &TableDesignMeta,
    draft: &TableDesignDraft,
    validation_id: Option<&str>,
) -> Result<TableDesignValidationOutcome, String> {
    let changes = crate::ddl::table_design_type_changes(current, draft)?;
    if changes.is_empty() {
        return Ok(TableDesignValidationOutcome::default());
    }
    let (job_id, sender, mut cancellation) = start_validation_job(validation_id).await;
    let mut query_cancellation = cancellation.clone();
    let result = if *cancellation.borrow() {
        Err(VALIDATION_CANCELLED_MESSAGE.into())
    } else {
        tokio::select! {
            biased;
            changed = cancellation.changed() => {
                match changed {
                    Ok(()) if *cancellation.borrow() => Err(VALIDATION_CANCELLED_MESSAGE.into()),
                    _ => Err(VALIDATION_CANCELLED_MESSAGE.into()),
                }
            }
            result = validate_mysql_type_changes(pool, current, &changes, &mut query_cancellation) => result,
        }
    };
    finish_validation_job(job_id.as_deref(), &sender).await;
    result
}

/// Execute the authoritative ALTER on the same strict, bounded-lock session.
/// This closes the preview/apply race safely: rows changed after preview can
/// make ALTER fail, but cannot be silently truncated by a permissive session.
pub async fn execute_mysql_ddl_strict(
    pool: &MySqlPool,
    statements: &[String],
) -> Result<(), String> {
    if statements.is_empty() {
        return Ok(());
    }
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| format!("连接数据库应用表设计失败：{error}"))?;
    connection.close_on_drop();
    configure_strict_session(&mut connection).await?;
    for statement in statements {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .map_err(|error| apply_database_error(&error))?;
    }
    Ok(())
}

pub fn blocking_conflict_message(conflicts: &[String]) -> String {
    format!(
        "发现现有字段值与目标类型不兼容，表结构未修改。请先修正这些数据，再重新预览：{}",
        conflicts.join("；")
    )
}

pub fn apply_database_error(error: &sqlx::Error) -> String {
    if let Some(database_error) = error.as_database_error() {
        if let Some(mysql_error) = database_error.try_downcast_ref::<MySqlDatabaseError>() {
            return classified_database_error(Some(mysql_error.number()), mysql_error.message());
        }
        return classified_database_error(None, database_error.message());
    }
    classified_database_error(None, &error.to_string())
}

fn classified_database_error(number: Option<u16>, message: &str) -> String {
    let normalized = message.to_ascii_lowercase();
    let details = message.trim();
    if matches!(number, Some(1205 | 1213))
        || normalized.contains("metadata lock")
        || normalized.contains("lock wait timeout")
        || normalized.contains("deadlock")
    {
        return format!(
            "表结构修改等待数据库锁时失败。请提交或回滚占用该表的事务，结束相关查询后直接重试；无需重启软件。数据库返回：{details}"
        );
    }
    if matches!(number, Some(1022 | 1062 | 1169 | 1586 | 1859))
        || normalized.contains("duplicate entry")
    {
        return format!(
            "表结构未修改：修改后会产生重复的主键或唯一索引值。请先处理重复数据，再重新预览。数据库返回：{details}"
        );
    }
    if matches!(
        number,
        Some(1048 | 1138 | 1264 | 1265 | 1292 | 1366 | 1406 | 1411 | 1690 | 3140 | 3141)
    ) || normalized.contains("data truncated")
        || normalized.contains("incorrect integer value")
        || normalized.contains("incorrect decimal value")
        || normalized.contains("incorrect datetime value")
        || normalized.contains("out of range value")
        || normalized.contains("cannot be null")
    {
        return format!(
            "表结构未修改：仍有字段值无法转换为目标类型。请修正数据后重新预览；无需重启软件。数据库返回：{details}"
        );
    }
    format!("应用表设计失败，请根据数据库返回信息处理后重试。数据库返回：{details}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ColumnDesignDraft, ColumnDesignMeta, TableDesignDraft, TableDesignSource};

    fn current() -> TableDesignMeta {
        TableDesignMeta {
            source: TableDesignSource {
                connection_id: "mysql-1".into(),
                database: "game_db".into(),
                table_name: "items".into(),
            },
            table_name: "items".into(),
            table_comment: String::new(),
            schema_signature: None,
            columns: vec![ColumnDesignMeta {
                ordinal: 1,
                column_name: "code".into(),
                column_type: "varchar(512)".into(),
                data_type: "varchar".into(),
                length: Some(512),
                scale: None,
                is_nullable: true,
                is_primary_key: false,
                primary_key_ordinal: None,
                default_mode: "none".into(),
                default_value: None,
                column_comment: String::new(),
                extra: String::new(),
                generation_expression: None,
                is_generated: false,
                is_supported: true,
                unsupported_reason: None,
            }],
        }
    }

    fn draft_for(data_type: &str, length: Option<u64>) -> TableDesignDraft {
        TableDesignDraft {
            table_comment: String::new(),
            columns: vec![ColumnDesignDraft {
                original_name: "code".into(),
                name: "code".into(),
                data_type: data_type.into(),
                length,
                scale: None,
                nullable: true,
                primary_key: false,
                primary_key_ordinal: None,
                default_mode: "none".into(),
                default_value: None,
                comment: String::new(),
            }],
        }
    }

    #[test]
    fn compatible_existing_values_allow_text_to_integer_conversion() {
        let rows = vec![
            HashMap::from([("code".into(), "1".into())]),
            HashMap::from([("code".into(), "-20".into())]),
        ];

        let conflicts = validate_materialized_rows(&current(), &draft_for("int", None), &rows)
            .expect("compatibility check should run");

        assert!(conflicts.is_empty());
    }

    #[test]
    fn incompatible_existing_values_report_count_and_samples() {
        let rows = vec![
            HashMap::from([("code".into(), "1".into())]),
            HashMap::from([("code".into(), "ABC".into())]),
            HashMap::from([("code".into(), "".into())]),
        ];

        let conflicts = validate_materialized_rows(&current(), &draft_for("int", None), &rows)
            .expect("compatibility check should run");

        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].contains("2 个"), "{}", conflicts[0]);
        assert!(conflicts[0].contains("ABC"), "{}", conflicts[0]);
    }

    #[test]
    fn materialized_fallback_covers_mysql_display_width_and_storage_limits() {
        let tinyint_rows = vec![HashMap::from([("code".into(), "2".into())])];
        assert!(validate_materialized_rows(
            &current(),
            &draft_for("tinyint", Some(1)),
            &tinyint_rows
        )
        .expect("tinyint check")
        .is_empty());

        let bit_rows = vec![HashMap::from([("code".into(), "4".into())])];
        assert!(
            !validate_materialized_rows(&current(), &draft_for("bit", Some(2)), &bit_rows)
                .expect("bit check")
                .is_empty()
        );

        let tinytext_rows = vec![HashMap::from([("code".into(), "x".repeat(256))])];
        assert!(!validate_materialized_rows(
            &current(),
            &draft_for("tinytext", None),
            &tinytext_rows
        )
        .expect("tinytext check")
        .is_empty());

        let varchar_rows = vec![HashMap::from([("code".into(), "  ".into())])];
        assert!(!validate_materialized_rows(
            &current(),
            &draft_for("varchar", Some(1)),
            &varchar_rows
        )
        .expect("varchar check")
        .is_empty());
    }

    #[test]
    fn strict_mode_preserves_existing_modes_and_adds_strict_all_tables() {
        assert_eq!(strict_sql_mode(""), "STRICT_ALL_TABLES");
        assert_eq!(
            strict_sql_mode("NO_ZERO_DATE,STRICT_TRANS_TABLES"),
            "NO_ZERO_DATE,STRICT_TRANS_TABLES,STRICT_ALL_TABLES"
        );
        assert_eq!(
            strict_sql_mode("strict_all_tables,NO_ZERO_DATE"),
            "strict_all_tables,NO_ZERO_DATE"
        );
    }

    #[test]
    fn scratch_sql_keeps_values_on_the_server_and_uses_target_types() {
        let draft = draft_for("int", None);
        let changes = crate::ddl::table_design_type_changes(&current(), &draft)
            .expect("type changes should be derived");
        let create = scratch_create_sql("scratch", &changes);
        let insert = scratch_insert_sql("scratch", &current(), &changes);

        assert!(create.contains("`__dbscout_col_1` int NULL"), "{create}");
        assert!(
            insert.contains("INSERT INTO `scratch` (`__dbscout_col_1`)"),
            "{insert}"
        );
        assert!(
            insert.contains("SELECT `code` FROM `game_db`.`items`"),
            "{insert}"
        );
        assert!(!insert.to_ascii_uppercase().contains("CAST("), "{insert}");
    }

    #[test]
    fn scratch_sql_preserves_binary_character_semantics_for_text_targets() {
        let mut current = current();
        current.columns[0].column_type = "varchar(512) CHARACTER SET binary".into();
        let changes =
            crate::ddl::table_design_type_changes(&current, &draft_for("varchar", Some(16)))
                .expect("type changes should be derived");

        let create = scratch_create_sql("scratch", &changes);

        assert!(
            create.contains("varchar(16) CHARACTER SET binary NULL"),
            "{create}"
        );
    }

    #[test]
    fn database_errors_distinguish_locks_data_and_duplicates() {
        assert!(
            classified_database_error(Some(1205), "Lock wait timeout exceeded")
                .contains("无需重启软件")
        );
        assert!(
            classified_database_error(Some(1366), "Incorrect integer value").contains("无法转换")
        );
        assert!(classified_database_error(Some(1062), "Duplicate entry").contains("重复"));
    }

    #[test]
    fn mysql_warning_lookup_uses_simple_query_protocol() {
        let source = include_str!("table_design_validation.rs");
        assert!(
            source.contains("sqlx::raw_sql(\"SHOW WARNINGS LIMIT 4\")"),
            "SHOW WARNINGS is not supported as a prepared statement",
        );
        assert!(
            !source.contains("sqlx::query(\"SHOW WARNINGS LIMIT 4\")"),
            "prepared SHOW WARNINGS returns MySQL 1295",
        );
    }

    #[test]
    fn scratch_column_aliases_are_replaced_in_user_facing_errors() {
        let changes = crate::ddl::table_design_type_changes(&current(), &draft_for("int", None))
            .expect("type changes should be derived");

        let conflict = conversion_conflict(
            &changes,
            "Data truncated for column '__dbscout_col_1' at row 2",
        );

        assert!(conflict.contains("column 'code'"), "{conflict}");
        assert!(!conflict.contains("__dbscout_col_1"), "{conflict}");
    }

    #[tokio::test]
    async fn cancellation_before_registration_is_not_lost() {
        let validation_id = format!("test-cancel-{}", Uuid::new_v4());
        assert!(cancel_validation(&validation_id).await);

        let (job_id, sender, receiver) = start_validation_job(Some(&validation_id)).await;

        assert!(*receiver.borrow());
        finish_validation_job(job_id.as_deref(), &sender).await;
        assert!(!validation_jobs().lock().await.contains_key(&validation_id));
    }
}
