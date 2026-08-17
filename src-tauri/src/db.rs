use std::{collections::HashMap, str::FromStr, time::Duration};

use reqwest::Url;
use sqlx::{
    mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow},
    MySqlPool, Row,
};

use crate::mysql_column_types::supports_table_design;
use crate::mysql_text;
use crate::natural_sort;
use crate::perf::{
    PerfContext, PerfEventDetails, PerfOutcome, PerfPhase, PerfStage, PerformanceRecorder,
};
use crate::types::*;

const MYSQL_POOL_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(10);

pub fn escape_ident(value: &str) -> String {
    value.replace('`', "``")
}

fn escape_sql_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "''")
}

pub fn qualified_table(database: &str, table_name: &str) -> String {
    format!(
        "`{}`.`{}`",
        escape_ident(database.trim()),
        escape_ident(table_name)
    )
}

fn table_ref_sql(database: Option<&str>, table_name: &str) -> String {
    if let Some(database) = database.filter(|value| !value.trim().is_empty()) {
        qualified_table(database, table_name)
    } else {
        format!("`{}`", escape_ident(table_name))
    }
}

fn normalized_column_data_type(column: &ColumnMeta) -> String {
    column
        .data_type
        .as_deref()
        .unwrap_or(&column.column_type)
        .trim()
        .to_ascii_lowercase()
        .split(|ch: char| ch == '(' || ch.is_whitespace())
        .find(|part| !part.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn is_value_searchable_column(column: &ColumnMeta) -> bool {
    if column.column_name.trim().is_empty() {
        return false;
    }
    !matches!(
        normalized_column_data_type(column).as_str(),
        "binary"
            | "varbinary"
            | "bit"
            | "tinyblob"
            | "blob"
            | "mediumblob"
            | "longblob"
            | "geometry"
            | "point"
            | "linestring"
            | "polygon"
            | "multipoint"
            | "multilinestring"
            | "multipolygon"
            | "geometrycollection"
            | "vector"
    )
}

pub fn normalize_page_request(request: &TablePageRequest) -> (u32, u32) {
    let page = request.page.unwrap_or(1).max(1);
    let page_size = request.page_size.unwrap_or(100).clamp(1, 10000);
    (page, page_size)
}

pub fn normalize_page_offset(request: &TablePageRequest, page: u32, page_size: u32) -> u64 {
    request
        .offset
        .unwrap_or_else(|| (page.saturating_sub(1) as u64).saturating_mul(page_size as u64))
}

pub fn count_metadata_without_total(
    row_count: usize,
    page_size: u32,
    offset: u64,
) -> (u64, bool, bool) {
    let has_more = row_count as u32 >= page_size;
    let total_rows = offset.saturating_add(row_count as u64);
    (total_rows, false, has_more)
}

pub fn primary_keys(table: &TableMeta) -> Vec<String> {
    table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.clone())
        .collect()
}

pub fn build_filter_sql(
    columns: &[ColumnMeta],
    request: &TablePageRequest,
) -> (String, Vec<String>) {
    let Some(filter) = request.filter.as_ref() else {
        return (String::new(), Vec::new());
    };
    let query = filter.query.trim();
    if query.is_empty() {
        return (String::new(), Vec::new());
    }
    let requested = filter
        .columns
        .iter()
        .map(|value| value.to_lowercase())
        .collect::<Vec<_>>();
    let filter_columns = columns
        .iter()
        .filter(|column| {
            requested.is_empty() || requested.contains(&column.column_name.to_lowercase())
        })
        .collect::<Vec<_>>();
    if filter_columns.is_empty() {
        return (String::new(), Vec::new());
    }
    let exact = filter
        .mode
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("exact"))
        .unwrap_or(false);
    if exact {
        let sql = format!(
            " WHERE ({})",
            filter_columns
                .iter()
                .map(|column| format!("CAST(`{}` AS CHAR) = ?", escape_ident(&column.column_name)))
                .collect::<Vec<_>>()
                .join(" OR ")
        );
        return (
            sql,
            filter_columns.iter().map(|_| query.to_string()).collect(),
        );
    }

    let continuous = filter
        .mode
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("continuous"));
    let patterns = if continuous {
        vec![escape_like_pattern(&query.to_lowercase())]
    } else {
        fuzzy_search_patterns(query)
    };
    if patterns.is_empty() {
        return (String::new(), Vec::new());
    }
    let sql = format!(
        " WHERE ({})",
        filter_columns
            .iter()
            .map(|column| {
                let column_name = escape_ident(&column.column_name);
                let column_predicates = patterns
                    .iter()
                    .map(|_| {
                        format!(
                            "LOWER(CAST(`{}` AS CHAR)) LIKE ? ESCAPE '\\\\'",
                            column_name
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" OR ");
                format!("({column_predicates})")
            })
            .collect::<Vec<_>>()
            .join(" OR ")
    );
    let binds = filter_columns
        .iter()
        .flat_map(|_| patterns.iter().cloned())
        .collect::<Vec<_>>();
    (sql, binds)
}

#[allow(dead_code)]
pub fn escape_like_pattern(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

#[allow(dead_code)]
pub fn escape_like_subsequence_pattern(value: &str) -> String {
    let parts = value
        .chars()
        .map(|ch| {
            ch.to_string()
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        })
        .collect::<Vec<_>>();
    format!("%{}%", parts.join("%"))
}

#[allow(dead_code)]
pub fn value_search_pattern(query: &str) -> Option<String> {
    let query = query.trim();
    if query.is_empty() {
        return None;
    }
    Some(escape_like_pattern(query))
}

#[allow(dead_code)]
pub fn value_search_patterns(query: &str) -> Vec<String> {
    let normalized = query.trim().to_lowercase();
    let query = normalized.as_str();
    if query.is_empty() {
        return Vec::new();
    }
    vec![escape_like_pattern(query)]
}

pub fn value_search_preview(value: &str, query: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let value_chars = value.chars().collect::<Vec<_>>();
    if value_chars.len() <= max_chars {
        return value.to_string();
    }
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return value_chars.into_iter().take(max_chars).collect();
    }

    let mut normalized = String::new();
    let mut segments = Vec::new();
    for (original_index, ch) in value_chars.iter().enumerate() {
        for lowered in ch.to_lowercase() {
            let start = normalized.len();
            normalized.push(lowered);
            segments.push((start, normalized.len(), original_index));
        }
    }
    let Some(match_byte_start) = normalized.find(&needle) else {
        return value_chars.into_iter().take(max_chars).collect();
    };
    let match_byte_end = match_byte_start + needle.len();
    let match_start = segments
        .iter()
        .find(|(start, end, _)| *start <= match_byte_start && match_byte_start < *end)
        .map(|(_, _, original_index)| *original_index)
        .unwrap_or(0);
    let match_end = segments
        .iter()
        .filter(|(start, end, _)| *start < match_byte_end && match_byte_start < *end)
        .map(|(_, _, original_index)| original_index + 1)
        .max()
        .unwrap_or(match_start + 1);
    let window_len = max_chars
        .max(match_end.saturating_sub(match_start))
        .min(value_chars.len());
    let context_before = window_len.saturating_sub(match_end - match_start) / 2;
    let mut window_start = match_start.saturating_sub(context_before);
    if window_start + window_len < match_end {
        window_start = match_end - window_len;
    }
    window_start = window_start.min(value_chars.len() - window_len);
    value_chars[window_start..window_start + window_len]
        .iter()
        .collect()
}

fn fuzzy_search_patterns(query: &str) -> Vec<String> {
    let normalized = query.trim().to_lowercase();
    let query = normalized.as_str();
    if query.is_empty() {
        return Vec::new();
    }
    let contains = escape_like_pattern(query);
    let subsequence = escape_like_subsequence_pattern(query);
    if contains == subsequence {
        vec![contains]
    } else {
        vec![contains, subsequence]
    }
}

pub fn build_where(identity: &HashMap<String, String>) -> Result<(String, Vec<String>), String> {
    if identity.is_empty() {
        return Err("缺少行标识".into());
    }
    let mut keys = identity.keys().cloned().collect::<Vec<_>>();
    keys.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok((
        keys.iter()
            .map(|key| format!("`{}` <=> ?", escape_ident(key)))
            .collect::<Vec<_>>()
            .join(" AND "),
        keys.iter()
            .map(|key| identity.get(key).cloned().unwrap_or_default())
            .collect(),
    ))
}

pub fn build_nullable_where(
    identity: &HashMap<String, Option<String>>,
) -> Result<(String, Vec<String>), String> {
    if identity.is_empty() {
        return Err("缺少行标识".into());
    }
    let mut keys = identity.keys().cloned().collect::<Vec<_>>();
    keys.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    let mut binds = Vec::new();
    let clauses = keys
        .iter()
        .map(
            |key| match identity.get(key).and_then(|value| value.as_ref()) {
                Some(value) => {
                    binds.push(value.clone());
                    format!("`{}` <=> ?", escape_ident(key))
                }
                None => format!("`{}` IS NULL", escape_ident(key)),
            },
        )
        .collect::<Vec<_>>();
    Ok((clauses.join(" AND "), binds))
}

#[allow(dead_code)]
pub fn build_value_search_sql(table: &TableMeta) -> Result<(String, usize), String> {
    if !table.columns.is_empty() {
        return build_value_search_sql_for_database(table, None);
    }

    let columns = table
        .columns
        .iter()
        .filter(|column| !column.column_name.trim().is_empty())
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Err("没有可搜索字段".into());
    }

    let select_sql = columns
        .iter()
        .map(|column| {
            format!(
                "CAST(`{}` AS CHAR) AS `{}`",
                escape_ident(&column.column_name),
                escape_ident(&column.column_name)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let where_sql = columns
        .iter()
        .map(|column| {
            format!(
                "CAST(`{}` AS CHAR) LIKE ? ESCAPE '\\\\'",
                escape_ident(&column.column_name)
            )
        })
        .collect::<Vec<_>>()
        .join(" OR ");
    let sql = format!(
        "SELECT {} FROM `{}` WHERE ({}) LIMIT 1",
        select_sql,
        escape_ident(&table.table_name),
        where_sql
    );
    Ok((sql, columns.len()))
}

pub fn build_value_search_sql_for_database(
    table: &TableMeta,
    database: Option<&str>,
) -> Result<(String, usize), String> {
    let columns = table
        .columns
        .iter()
        .filter(|column| is_value_searchable_column(column))
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Err("no searchable column".into());
    }

    let table_ref = table_ref_sql(database, &table.table_name);
    let sql = columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let column_name = escape_ident(&column.column_name);
            format!(
                "SELECT matched_column, preview_value FROM (SELECT '{}' AS matched_column, CAST(`{}` AS CHAR) AS preview_value FROM {} WHERE LOWER(CAST(`{}` AS CHAR)) LIKE ? ESCAPE '\\\\' LIMIT 1) AS `_value_hit_{}`",
                escape_sql_string(&column.column_name),
                column_name,
                table_ref,
                column_name,
                index
            )
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    Ok((sql, columns.len()))
}

#[allow(dead_code)]
pub fn build_value_search_column_sql(
    table: &TableMeta,
    column: &ColumnMeta,
) -> Result<String, String> {
    if column.column_name.trim().is_empty() {
        return Err("no searchable column".into());
    }
    let column_name = escape_ident(&column.column_name);
    Ok(format!(
        "SELECT CAST(`{}` AS CHAR) AS preview_value FROM `{}` WHERE CAST(`{}` AS CHAR) LIKE ? ESCAPE '\\\\' LIMIT 1",
        column_name,
        escape_ident(&table.table_name),
        column_name
    ))
}

#[allow(dead_code)]
pub async fn search_value_matches(
    pool: &MySqlPool,
    table: &TableMeta,
    query: &str,
) -> Result<Vec<SearchValueItem>, String> {
    if !table.columns.is_empty() {
        return search_value_matches_in_database(pool, None, table, query).await;
    }

    let patterns = value_search_patterns(query);
    if patterns.is_empty() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    for pattern in patterns {
        for column in &table.columns {
            if results
                .iter()
                .any(|item: &SearchValueItem| item.column_name == column.column_name)
            {
                continue;
            }
            let sql = match build_value_search_column_sql(table, column) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let row = sqlx::query(&sql)
                .bind(&pattern)
                .fetch_optional(pool)
                .await
                .map_err(|error| format!("搜索值失败: {error}"))?;
            let Some(row) = row else {
                continue;
            };
            let value = mysql_text::optional_string(&row, "preview_value")
                .unwrap_or(None)
                .unwrap_or_default();
            results.push(SearchValueItem {
                table_name: table.table_name.clone(),
                table_comment: table.table_comment.clone(),
                column_name: column.column_name.clone(),
                preview_value: value_search_preview(&value, query, 80),
                row_identity: None,
            });
        }
    }
    Ok(results)
}

pub async fn search_value_matches_in_database(
    pool: &MySqlPool,
    database: Option<&str>,
    table: &TableMeta,
    query: &str,
) -> Result<Vec<SearchValueItem>, String> {
    let patterns = value_search_patterns(query);
    if patterns.is_empty() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    let (sql, bind_count) = match build_value_search_sql_for_database(table, database) {
        Ok(value) => value,
        Err(_) => return Ok(Vec::new()),
    };
    for pattern in patterns {
        let mut statement = sqlx::query(&sql);
        for _ in 0..bind_count {
            statement = statement.bind(&pattern);
        }
        let rows = statement
            .fetch_all(pool)
            .await
            .map_err(|error| format!("搜索值失败: {error}"))?;
        for row in rows {
            let column_name = mysql_text::string(&row, "matched_column").unwrap_or_default();
            if column_name.is_empty()
                || results
                    .iter()
                    .any(|item: &SearchValueItem| item.column_name == column_name)
            {
                continue;
            }
            let value = mysql_text::optional_string(&row, "preview_value")
                .unwrap_or(None)
                .unwrap_or_default();
            results.push(SearchValueItem {
                table_name: table.table_name.clone(),
                table_comment: table.table_comment.clone(),
                column_name,
                preview_value: value_search_preview(&value, query, 80),
                row_identity: None,
            });
        }
    }
    Ok(results)
}

#[allow(dead_code)]
pub async fn search_first_value_match(
    pool: &MySqlPool,
    table: &TableMeta,
    query: &str,
) -> Result<Option<SearchValueItem>, String> {
    Ok(search_value_matches(pool, table, query)
        .await?
        .into_iter()
        .next())
}

pub fn friendly_mysql_connect_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("access denied") || lower.contains("authentication") {
        return "认证失败：用户名或密码错误".into();
    }
    if lower.contains("host") && lower.contains("not allowed") {
        return "权限不足：该用户不允许从此主机连接".into();
    }
    if lower.contains("unknown database") {
        return "数据库不存在：请检查数据库名称".into();
    }
    if lower.contains("connection refused")
        || lower.contains("actively refused")
        || lower.contains("failed to connect")
    {
        return "无法连接到服务器：请检查主机和端口是否正确".into();
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return "连接超时：请检查网络或防火墙设置".into();
    }
    if lower.contains("unknown host")
        || lower.contains("failed to lookup")
        || lower.contains("dns")
        || lower.contains("name or service not known")
    {
        return "无法解析主机名：请检查主机地址是否正确".into();
    }
    if lower.contains("ssl") || lower.contains("tls") {
        return "安全连接失败：请检查 SSL/TLS 配置".into();
    }
    "连接失败：请检查连接参数后重试".into()
}

pub async fn connect_database(
    mysql_url: &str,
    database: Option<&str>,
) -> Result<MySqlPool, String> {
    let options = mysql_connect_options(mysql_url, database)?;
    MySqlPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(MYSQL_POOL_ACQUIRE_TIMEOUT)
        .connect_with(options)
        .await
        .map_err(|error| format!("连接 MySQL 失败: {error}"))
}

pub(crate) fn table_count_pool_options() -> MySqlPoolOptions {
    MySqlPoolOptions::new().max_connections(1)
}

pub async fn connect_table_count_database(
    mysql_url: &str,
    database: &str,
) -> Result<MySqlPool, String> {
    let options = mysql_connect_options(mysql_url, Some(database))?;
    table_count_pool_options()
        .connect_with(options)
        .await
        .map_err(|error| format!("连接 MySQL 统计通道失败: {error}"))
}

fn mysql_connect_options(
    mysql_url: &str,
    database: Option<&str>,
) -> Result<MySqlConnectOptions, String> {
    let mut url = Url::parse(mysql_url).map_err(|error| format!("MySQL URL 无效: {error}"))?;
    // A server pool must not inherit a stale default database from a saved URL.
    // Database pools always apply the caller's current explicit selection.
    url.set_path("");
    let mut options = MySqlConnectOptions::from_str(url.as_str())
        .map_err(|error| format!("MySQL URL 无效: {error}"))?;
    if let Some(database) = database.filter(|value| !value.trim().is_empty()) {
        options = options.database(database.trim());
    }
    Ok(options)
}

const TEST_CONNECTION_TIMEOUT: Duration = Duration::from_secs(3);

async fn probe_database_connection(mysql_url: &str) -> Result<(), String> {
    let pool = connect_database(mysql_url, None)
        .await
        .map_err(|error| friendly_mysql_connect_error(&error))?;
    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .map_err(|error| friendly_mysql_connect_error(&error.to_string()))?;
    pool.close().await;
    Ok(())
}

pub async fn test_database_connection(mysql_url: &str) -> Result<(), String> {
    match tokio::time::timeout(
        TEST_CONNECTION_TIMEOUT,
        probe_database_connection(mysql_url),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err("连接超时：请检查网络或防火墙设置".into()),
    }
}

pub async fn read_schema(
    pool: &MySqlPool,
    database: &str,
    table_name: &str,
) -> Result<TableMeta, String> {
    let table_row = sqlx::query(
        "SELECT TABLE_NAME, COALESCE(TABLE_COMMENT, '') AS TABLE_COMMENT \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1",
    )
    .bind(database)
    .bind(table_name)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("读取表信息失败: {error}"))?
    .ok_or_else(|| format!("表不存在: {table_name}"))?;

    let columns = sqlx::query(
        "SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, \
         NUMERIC_PRECISION, NUMERIC_SCALE, COALESCE(COLUMN_COMMENT, '') AS COLUMN_COMMENT, \
         COLUMN_KEY = 'PRI' AS IS_PRIMARY_KEY, IS_NULLABLE = 'YES' AS IS_NULLABLE, \
         COALESCE(EXTRA, '') AS EXTRA, COLUMN_DEFAULT, GENERATION_EXPRESSION \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    )
    .bind(database)
    .bind(table_name)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取字段信息失败: {error}"))?
    .into_iter()
    .map(|row| column_meta_from_schema_row(&row))
    .collect::<Result<Vec<_>, String>>()?;

    Ok(TableMeta {
        table_name: mysql_text::string(&table_row, "TABLE_NAME")
            .unwrap_or_else(|_| table_name.to_string()),
        table_comment: mysql_text::string(&table_row, "TABLE_COMMENT").unwrap_or_default(),
        columns,
    })
}

fn column_meta_from_schema_row(row: &MySqlRow) -> Result<ColumnMeta, String> {
    let column_type = mysql_text::string(row, "COLUMN_TYPE").map_err(|error| error.to_string())?;
    let data_type = mysql_text::string(row, "DATA_TYPE").ok();
    let extra = mysql_text::string(row, "EXTRA").unwrap_or_default();
    let generation_expression =
        mysql_text::optional_string(row, "GENERATION_EXPRESSION").unwrap_or(None);
    let is_primary_key = row.try_get::<i8, _>("IS_PRIMARY_KEY").unwrap_or(0) != 0;
    let is_nullable = row.try_get::<i8, _>("IS_NULLABLE").unwrap_or(0) != 0;
    let default_value = mysql_text::optional_string(row, "COLUMN_DEFAULT").unwrap_or(None);
    let default_mode = Some(infer_default_mode(
        &default_value,
        is_nullable,
        is_primary_key,
    ));
    let normalized_data_type = data_type.clone().unwrap_or_default().to_ascii_lowercase();
    Ok(ColumnMeta {
        column_name: mysql_text::string(row, "COLUMN_NAME").map_err(|error| error.to_string())?,
        column_type: column_type.clone(),
        column_comment: mysql_text::string(row, "COLUMN_COMMENT").unwrap_or_default(),
        is_primary_key,
        is_nullable,
        data_type,
        character_maximum_length: row.try_get("CHARACTER_MAXIMUM_LENGTH").ok(),
        numeric_precision: row.try_get("NUMERIC_PRECISION").ok(),
        numeric_scale: row.try_get("NUMERIC_SCALE").ok(),
        is_unsigned: column_type.to_ascii_lowercase().contains("unsigned"),
        is_auto_increment: extra.to_ascii_lowercase().contains("auto_increment"),
        enum_values: if normalized_data_type == "enum" {
            parse_enum_set_values(&column_type)
        } else {
            Vec::new()
        },
        set_values: if normalized_data_type == "set" {
            parse_enum_set_values(&column_type)
        } else {
            Vec::new()
        },
        is_generated: !generation_expression
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty(),
        default_value,
        default_mode,
    })
}

fn infer_default_mode(default_value: &Option<String>, nullable: bool, primary_key: bool) -> String {
    match default_value.as_deref() {
        None => "none".into(),
        Some(value) if value.eq_ignore_ascii_case("NULL") && nullable && !primary_key => {
            "null".into()
        }
        Some(value)
            if value.contains('(')
                || value.eq_ignore_ascii_case("CURRENT_TIMESTAMP")
                || value.eq_ignore_ascii_case("CURRENT_DATE")
                || value.eq_ignore_ascii_case("CURRENT_TIME") =>
        {
            "expression".into()
        }
        Some(_) => "value".into(),
    }
}

fn parse_enum_set_values(column_type: &str) -> Vec<String> {
    let Some(open) = column_type.find('(') else {
        return Vec::new();
    };
    let Some(close) = column_type.rfind(')') else {
        return Vec::new();
    };
    let mut values = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut chars = column_type[open + 1..close].chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' if in_quote => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            '\'' if in_quote && chars.peek() == Some(&'\'') => {
                current.push('\'');
                chars.next();
            }
            '\'' => {
                if in_quote {
                    values.push(current.clone());
                    current.clear();
                }
                in_quote = !in_quote;
            }
            _ if in_quote => current.push(ch),
            _ => {}
        }
    }
    values
}

fn column_support(
    data_type: &str,
    extra: &str,
    generation_expression: &Option<String>,
) -> (bool, bool, Option<String>) {
    let generated = !generation_expression
        .as_deref()
        .unwrap_or_default()
        .trim()
        .is_empty()
        || extra.to_ascii_lowercase().contains("generated");
    if generated {
        return (
            true,
            false,
            Some("generated columns are read-only in table design V1".into()),
        );
    }
    let supported = supports_table_design(data_type);
    if supported {
        (false, true, None)
    } else {
        (
            false,
            false,
            Some(format!("unsupported column type: {data_type}")),
        )
    }
}

pub async fn read_table_design(
    pool: &MySqlPool,
    database: &str,
    table_name: &str,
    connection_id: &str,
) -> Result<TableDesignMeta, String> {
    let table_row = sqlx::query(
        "SELECT TABLE_NAME, COALESCE(TABLE_COMMENT, '') AS TABLE_COMMENT \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1",
    )
    .bind(database)
    .bind(table_name)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("读取表设计失败: {error}"))?
    .ok_or_else(|| format!("表不存在: {table_name}"))?;

    let columns = sqlx::query(
        "SELECT c.ORDINAL_POSITION, c.COLUMN_NAME, c.COLUMN_TYPE, c.DATA_TYPE, \
         c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, \
         c.IS_NULLABLE = 'YES' AS IS_NULLABLE, c.COLUMN_KEY = 'PRI' AS IS_PRIMARY_KEY, \
         s.SEQ_IN_INDEX AS PRIMARY_KEY_ORDINAL, c.COLUMN_DEFAULT, \
         COALESCE(c.COLUMN_COMMENT, '') AS COLUMN_COMMENT, \
         COALESCE(c.EXTRA, '') AS EXTRA, c.GENERATION_EXPRESSION \
         FROM information_schema.COLUMNS c \
         LEFT JOIN information_schema.STATISTICS s \
           ON s.TABLE_SCHEMA = c.TABLE_SCHEMA AND s.TABLE_NAME = c.TABLE_NAME \
          AND s.INDEX_NAME = 'PRIMARY' AND s.COLUMN_NAME = c.COLUMN_NAME \
         WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION",
    )
    .bind(database)
    .bind(table_name)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取字段设计失败: {error}"))?
    .into_iter()
    .map(|row| {
        let data_type = mysql_text::string(&row, "DATA_TYPE").map_err(|error| error.to_string())?;
        let nullable = row.try_get::<i8, _>("IS_NULLABLE").unwrap_or(0) != 0;
        let primary_key = row.try_get::<i8, _>("IS_PRIMARY_KEY").unwrap_or(0) != 0;
        let default_value = mysql_text::optional_string(&row, "COLUMN_DEFAULT").unwrap_or(None);
        let extra = mysql_text::string(&row, "EXTRA").unwrap_or_default();
        let generation_expression = mysql_text::optional_string(&row, "GENERATION_EXPRESSION")
            .unwrap_or(None)
            .filter(|value| !value.trim().is_empty());
        let (is_generated, is_supported, unsupported_reason) =
            column_support(&data_type, &extra, &generation_expression);
        let column_name = mysql_text::string(&row, "COLUMN_NAME")
            .map_err(|error| error.to_string())?;
        Ok(ColumnDesignMeta {
            ordinal: row.try_get::<u32, _>("ORDINAL_POSITION").unwrap_or(0),
            primary_key_ordinal: row
                .try_get::<Option<u32>, _>("PRIMARY_KEY_ORDINAL")
                .unwrap_or(None),
            column_name,
            column_type: mysql_text::string(&row, "COLUMN_TYPE")
                .map_err(|error| error.to_string())?,
            data_type,
            length: row
                .try_get::<Option<u64>, _>("CHARACTER_MAXIMUM_LENGTH")
                .unwrap_or(None)
                .or_else(|| {
                    row.try_get::<Option<u64>, _>("NUMERIC_PRECISION")
                        .unwrap_or(None)
                }),
            scale: row
                .try_get::<Option<u64>, _>("NUMERIC_SCALE")
                .unwrap_or(None),
            is_nullable: nullable,
            is_primary_key: primary_key,
            default_mode: infer_default_mode(&default_value, nullable, primary_key),
            default_value,
            column_comment: mysql_text::string(&row, "COLUMN_COMMENT").unwrap_or_default(),
            extra,
            generation_expression,
            is_generated,
            is_supported,
            unsupported_reason,
        })
    })
    .collect::<Result<Vec<_>, String>>()?;

    let mut design = TableDesignMeta {
        source: TableDesignSource {
            connection_id: connection_id.into(),
            database: database.into(),
            table_name: table_name.into(),
        },
        table_name: mysql_text::string(&table_row, "TABLE_NAME")
            .unwrap_or_else(|_| table_name.to_string()),
        table_comment: mysql_text::string(&table_row, "TABLE_COMMENT").unwrap_or_default(),
        schema_signature: None,
        columns,
    };
    design.schema_signature = Some(crate::ddl::schema_signature(&design));
    Ok(design)
}

fn list_tables_sql() -> &'static str {
    "SELECT TABLE_NAME, COALESCE(TABLE_COMMENT, '') AS TABLE_COMMENT, \
     CAST(COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS CHAR) AS DATA_SIZE_BYTES, \
     DATE_FORMAT(UPDATE_TIME, '%Y-%m-%d %H:%i:%s') AS MODIFIED_AT \
     FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME"
}

fn parse_mysql_data_size(value: &str) -> Option<u64> {
    value.trim().parse::<u64>().ok()
}

pub async fn list_tables_from_db(
    pool: &MySqlPool,
    database: &str,
) -> Result<Vec<TableOption>, String> {
    let rows = sqlx::query(list_tables_sql())
        .bind(database)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取表列表失败: {error}"))?;

    Ok(rows
        .into_iter()
        .map(|row| TableOption {
            table_name: mysql_text::string(&row, "TABLE_NAME").unwrap_or_default(),
            table_comment: mysql_text::string(&row, "TABLE_COMMENT").unwrap_or_default(),
            column_count: None,
            data_size_bytes: mysql_text::string(&row, "DATA_SIZE_BYTES")
                .ok()
                .and_then(|value| parse_mysql_data_size(&value)),
            modified_at: mysql_text::optional_string(&row, "MODIFIED_AT").unwrap_or(None),
        })
        .collect())
}

pub async fn read_schemas_for_tables(
    pool: &MySqlPool,
    database: &str,
    tables: &[TableOption],
) -> Result<Vec<TableMeta>, String> {
    if tables.is_empty() {
        return Ok(Vec::new());
    }

    let table_names = tables
        .iter()
        .map(|table| table.table_name.as_str())
        .collect::<Vec<_>>();
    let sql = build_schema_batch_sql(table_names.len());
    let mut query = sqlx::query(&sql).bind(database);
    for table_name in &table_names {
        query = query.bind(*table_name);
    }
    let rows = query
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取字段信息失败: {error}"))?;

    let mut comments = HashMap::new();
    for table in tables {
        comments.insert(table.table_name.to_lowercase(), table.table_comment.clone());
    }

    let mut by_table: HashMap<String, Vec<ColumnMeta>> = HashMap::new();
    for row in rows {
        let table_name = mysql_text::string(&row, "TABLE_NAME").unwrap_or_default();
        let normalized_table_name = table_name.to_lowercase();
        comments.insert(
            normalized_table_name.clone(),
            mysql_text::string(&row, "TABLE_COMMENT").unwrap_or_default(),
        );
        let column = column_meta_from_schema_row(&row)?;
        by_table
            .entry(normalized_table_name)
            .or_default()
            .push(column);
    }

    Ok(tables
        .iter()
        .filter_map(|table| {
            by_table
                .remove(&table.table_name.to_lowercase())
                .map(|columns| TableMeta {
                    table_name: table.table_name.clone(),
                    table_comment: comments
                        .get(&table.table_name.to_lowercase())
                        .cloned()
                        .unwrap_or_default(),
                    columns,
                })
        })
        .collect())
}

fn build_schema_batch_sql(table_count: usize) -> String {
    let placeholders = std::iter::repeat("?")
        .take(table_count)
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT C.TABLE_NAME, COALESCE(T.TABLE_COMMENT, '') AS TABLE_COMMENT, \
         C.COLUMN_NAME, C.COLUMN_TYPE, C.DATA_TYPE, C.CHARACTER_MAXIMUM_LENGTH, \
         C.NUMERIC_PRECISION, C.NUMERIC_SCALE, COALESCE(C.COLUMN_COMMENT, '') AS COLUMN_COMMENT, \
         C.COLUMN_KEY = 'PRI' AS IS_PRIMARY_KEY, C.IS_NULLABLE = 'YES' AS IS_NULLABLE, \
         COALESCE(C.EXTRA, '') AS EXTRA, C.COLUMN_DEFAULT, C.GENERATION_EXPRESSION \
         FROM information_schema.COLUMNS AS C \
         LEFT JOIN information_schema.TABLES AS T \
           ON T.TABLE_SCHEMA = C.TABLE_SCHEMA AND T.TABLE_NAME = C.TABLE_NAME \
         WHERE C.TABLE_SCHEMA = ? AND C.TABLE_NAME IN ({placeholders}) \
         ORDER BY C.TABLE_NAME, C.ORDINAL_POSITION"
    )
}

pub async fn read_db_page_in_database(
    pool: &MySqlPool,
    database: &str,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> Result<TableSessionPage, String> {
    read_db_page_inner(pool, table, session_id, request, Some(database), None).await
}

pub async fn read_db_page_with_perf_in_database(
    pool: &MySqlPool,
    database: &str,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
    recorder: &PerformanceRecorder,
    context: &PerfContext,
) -> Result<TableSessionPage, String> {
    read_db_page_inner(
        pool,
        table,
        session_id,
        request,
        Some(database),
        Some((recorder, context)),
    )
    .await
}

pub(crate) fn build_table_count_sql(
    database: &str,
    table: &TableMeta,
    request: &TablePageRequest,
) -> (String, Vec<String>) {
    let (where_sql, binds) = build_filter_sql(&table.columns, request);
    (
        format!(
            "SELECT /*+ MAX_EXECUTION_TIME(10000) */ COUNT(*) AS cnt FROM {}{}",
            table_ref_sql(Some(database), &table.table_name),
            where_sql,
        ),
        binds,
    )
}

fn requested_sort_order_sql(table: &TableMeta, sort: &TablePageSort) -> String {
    let column_name = sort.column_name.trim();
    let qualified = format!(
        "`{}`.`{}`",
        escape_ident(&table.table_name),
        escape_ident(column_name)
    );
    let textual = table
        .columns
        .iter()
        .find(|column| column.column_name.eq_ignore_ascii_case(column_name))
        .is_some_and(natural_sort::is_textual_sort_column);
    format!(
        " ORDER BY {}",
        natural_sort::mysql_order_by_terms(&qualified, sort.descending, textual)
    )
}

fn mysql_column_order_terms(table: &TableMeta, column: &ColumnMeta, descending: bool) -> String {
    let qualified = format!(
        "`{}`.`{}`",
        escape_ident(&table.table_name),
        escape_ident(&column.column_name)
    );
    natural_sort::mysql_order_by_terms(
        &qualified,
        descending,
        natural_sort::is_textual_sort_column(column),
    )
}

fn default_primary_key_order_sql(table: &TableMeta) -> String {
    let terms = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| mysql_column_order_terms(table, column, false))
        .collect::<Vec<_>>();
    if terms.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", terms.join(", "))
    }
}

fn page_order_sql(table: &TableMeta, sort: Option<&TablePageSort>) -> String {
    match sort.filter(|sort| !sort.column_name.trim().is_empty()) {
        Some(sort) => requested_sort_order_sql(table, sort),
        None => default_primary_key_order_sql(table),
    }
}

fn search_scan_order_sql(table: &TableMeta, sort: Option<&TablePageSort>) -> String {
    let requested_sort = sort.filter(|sort| {
        !sort.column_name.trim().is_empty()
            && table.columns.iter().any(|column| {
                column
                    .column_name
                    .eq_ignore_ascii_case(sort.column_name.trim())
            })
    });
    if let Some(sort) = requested_sort {
        return requested_sort_order_sql(table, sort);
    }
    default_primary_key_order_sql(table)
}

pub(crate) fn build_search_scan_sql(
    database: &str,
    table: &TableMeta,
    offset: u64,
    limit: u32,
    sort: Option<&TablePageSort>,
) -> String {
    let select_columns = table
        .columns
        .iter()
        .map(|column| {
            format!(
                "CAST(`{}` AS CHAR) AS `{}`",
                escape_ident(&column.column_name),
                escape_ident(&column.column_name)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT /*+ MAX_EXECUTION_TIME(3000) */ {} FROM {}{} LIMIT {} OFFSET {}",
        select_columns,
        table_ref_sql(Some(database), &table.table_name),
        search_scan_order_sql(table, sort),
        limit.clamp(1, 512),
        offset,
    )
}

pub async fn read_db_search_scan_page_with_perf(
    pool: &MySqlPool,
    database: &str,
    table: &TableMeta,
    offset: u64,
    limit: u32,
    sort: Option<&TablePageSort>,
    recorder: &PerformanceRecorder,
    context: &PerfContext,
) -> Result<Vec<HashMap<String, String>>, String> {
    let sql = build_search_scan_sql(database, table, offset, limit, sort);
    let span = recorder.begin_span(
        "mysql.table_search_sql_wait",
        PerfPhase::Database,
        Some(context),
        || PerfEventDetails::stage(PerfStage::Query),
    );
    let result = sqlx::query(&sql).fetch_all(pool).await;
    if let Some(span) = span {
        span.finish(
            if result.is_ok() {
                PerfOutcome::Success
            } else {
                PerfOutcome::Error
            },
            PerfEventDetails::default,
        );
    }
    let rows = result
        .map_err(|error| format!("搜索表数据失败: {error}"))?
        .into_iter()
        .map(|row| {
            table
                .columns
                .iter()
                .map(|column| {
                    let value = mysql_text::optional_string(&row, column.column_name.as_str())
                        .unwrap_or(None)
                        .unwrap_or_default();
                    (column.column_name.clone(), value)
                })
                .collect()
        })
        .collect::<Vec<_>>();
    Ok(rows)
}

pub async fn read_db_search_scan_page_in_database(
    pool: &MySqlPool,
    database: &str,
    table: &TableMeta,
    offset: u64,
    limit: u32,
    sort: Option<&TablePageSort>,
) -> Result<Vec<HashMap<String, String>>, String> {
    read_db_search_scan_page_with_perf(
        pool,
        database,
        table,
        offset,
        limit,
        sort,
        &PerformanceRecorder::default(),
        &PerfContext::default(),
    )
    .await
}

pub async fn read_db_table_count_with_perf(
    pool: &MySqlPool,
    database: &str,
    table: &TableMeta,
    request: &TablePageRequest,
    recorder: &PerformanceRecorder,
    context: &PerfContext,
) -> Result<TableCountResult, String> {
    let (sql, binds) = build_table_count_sql(database, table, request);
    let mut query = sqlx::query(&sql);
    for bind in &binds {
        query = query.bind(bind);
    }
    let span = recorder.begin_span(
        "mysql.count_sql_wait",
        PerfPhase::Database,
        Some(context),
        || PerfEventDetails::stage(PerfStage::Query),
    );
    let result = query.fetch_one(pool).await;
    if let Some(span) = span {
        span.finish(
            if result.is_ok() {
                PerfOutcome::Success
            } else {
                PerfOutcome::Error
            },
            PerfEventDetails::default,
        );
    }
    let total_rows = result
        .map_err(|error| format!("统计行数失败: {error}"))?
        .try_get::<i64, _>("cnt")
        .unwrap_or(0)
        .max(0) as u64;
    Ok(TableCountResult {
        total_rows,
        exact: true,
        estimated: false,
    })
}

pub async fn read_db_table_count_in_database(
    pool: &MySqlPool,
    database: &str,
    table: &TableMeta,
    request: &TablePageRequest,
) -> Result<TableCountResult, String> {
    read_db_table_count_with_perf(
        pool,
        database,
        table,
        request,
        &PerformanceRecorder::default(),
        &PerfContext::default(),
    )
    .await
}

async fn read_db_page_inner(
    pool: &MySqlPool,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
    database: Option<&str>,
    perf: Option<(&PerformanceRecorder, &PerfContext)>,
) -> Result<TableSessionPage, String> {
    let (page, page_size) = normalize_page_request(request);
    let offset = normalize_page_offset(request, page, page_size);
    let select_columns = table
        .columns
        .iter()
        .map(|column| {
            format!(
                "CAST(`{}` AS CHAR) AS `{}`",
                escape_ident(&column.column_name),
                escape_ident(&column.column_name)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let (where_sql, binds) = build_filter_sql(&table.columns, request);
    let table_ref = table_ref_sql(database, &table.table_name);
    // ORDER BY references the real (table-qualified) column rather than the
    // CAST(... AS CHAR) select alias. MySQL resolves an unqualified ORDER BY
    // name to the select-list alias first, which forced lexicographic string
    // sorting on every column type (#7). Qualifying with the table name makes
    // MySQL sort on the underlying column so numeric/date values use their
    // native ordering. Text columns add a prefix + first-number key so ids
    // like C12 sort before C111.
    let order_sql = page_order_sql(table, request.sort.as_ref());

    let sql = format!(
        "SELECT {} FROM {}{}{} LIMIT {} OFFSET {}",
        select_columns, table_ref, where_sql, order_sql, page_size, offset
    );
    let mut query = sqlx::query(&sql);
    for bind in &binds {
        query = query.bind(bind);
    }
    let query_span = perf.and_then(|(recorder, context)| {
        recorder.begin_span(
            "mysql.page_sql_wait",
            PerfPhase::Database,
            Some(context),
            || PerfEventDetails::stage(PerfStage::Query),
        )
    });
    let query_result = query.fetch_all(pool).await;
    if let Some(span) = query_span {
        span.finish(
            if query_result.is_ok() {
                PerfOutcome::Success
            } else {
                PerfOutcome::Error
            },
            PerfEventDetails::default,
        );
    }
    let raw_rows = query_result.map_err(|error| format!("读取数据失败: {error}"))?;
    let row_count = raw_rows.len() as u64;
    let conversion_span = perf.and_then(|(recorder, context)| {
        recorder.begin_span(
            "mysql.row_convert",
            PerfPhase::Conversion,
            Some(context),
            || PerfEventDetails {
                stage: Some(PerfStage::Convert),
                row_count: Some(row_count),
                column_count: Some(table.columns.len() as u64),
                ..PerfEventDetails::default()
            },
        )
    });
    let (rows, null_cells) = raw_rows
        .into_iter()
        .map(|row| {
            let mut out = HashMap::new();
            let mut null_columns = Vec::new();
            for column in &table.columns {
                let value =
                    mysql_text::optional_string(&row, column.column_name.as_str()).unwrap_or(None);
                if value.is_none() {
                    null_columns.push(column.column_name.clone());
                }
                out.insert(column.column_name.clone(), value.unwrap_or_default());
            }
            (out, null_columns)
        })
        .unzip::<_, _, Vec<_>, Vec<_>>();
    if let Some(span) = conversion_span {
        span.finish(PerfOutcome::Success, PerfEventDetails::default);
    }
    let (total_rows, total_rows_exact, has_more) =
        count_metadata_without_total(rows.len(), page_size, offset);

    Ok(TableSessionPage {
        session_id: session_id.into(),
        table_name: table.table_name.clone(),
        table_comment: table.table_comment.clone(),
        columns: table.columns.clone(),
        primary_keys: primary_keys(table),
        rows,
        null_cells,
        total_rows,
        total_rows_exact,
        has_more,
        page,
        page_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_pool_acquire_timeout_is_bounded() {
        assert_eq!(MYSQL_POOL_ACQUIRE_TIMEOUT, Duration::from_secs(10));
    }

    #[test]
    fn server_options_drop_a_stale_url_database_and_database_options_override_it() {
        let url = "mysql://user:secret@127.0.0.1:3306/deleted_db?ssl-mode=REQUIRED";

        let server = mysql_connect_options(url, None).expect("server options");
        let database = mysql_connect_options(url, Some(" current_db ")).expect("database options");

        assert_eq!(server.get_database(), None);
        assert_eq!(database.get_database(), Some("current_db"));
        assert_eq!(server.get_host(), "127.0.0.1");
        assert_eq!(server.get_port(), 3306);
    }

    #[test]
    fn escape_ident_doubles_backticks() {
        assert_eq!(escape_ident("normal_name"), "normal_name");
        assert_eq!(escape_ident("bad`name"), "bad``name");
    }

    #[test]
    fn qualified_table_escapes_database_and_table() {
        assert_eq!(
            qualified_table("game-db", "order`item"),
            "`game-db`.`order``item`"
        );
    }

    #[test]
    fn table_design_metadata_supports_existing_enum_and_set_columns() {
        for data_type in ["enum", "set"] {
            let (generated, supported, reason) = column_support(data_type, "", &None);
            assert!(!generated);
            assert!(supported);
            assert_eq!(reason, None);
        }
    }

    #[test]
    fn normalize_page_request_clamps_page_size() {
        let request = TablePageRequest {
            page: Some(0),
            page_size: Some(999),
            offset: None,
            include_total: None,
            filter: None,
            sort: None,
        };

        assert_eq!(normalize_page_request(&request), (1, 999));
        assert_eq!(normalize_page_offset(&request, 1, 999), 0);

        let offset_request = TablePageRequest {
            page: Some(9),
            page_size: Some(999),
            offset: Some(1234),
            include_total: None,
            filter: None,
            sort: None,
        };
        assert_eq!(normalize_page_offset(&offset_request, 9, 999), 1234);
    }

    #[test]
    fn table_page_request_retains_the_legacy_include_total_wire_field() {
        let default_request = TablePageRequest::default();
        let explicit_fast_request = TablePageRequest {
            page: Some(1),
            page_size: Some(1000),
            offset: None,
            include_total: Some(false),
            filter: None,
            sort: None,
        };
        let exact_request = TablePageRequest {
            page: Some(1),
            page_size: Some(1000),
            offset: None,
            include_total: Some(true),
            filter: None,
            sort: None,
        };

        assert_eq!(default_request.include_total, None);
        assert_eq!(explicit_fast_request.include_total, Some(false));
        assert_eq!(exact_request.include_total, Some(true));
    }

    #[test]
    fn table_count_uses_a_single_connection_pool_and_server_timeout_hint() {
        let table = TableMeta {
            table_name: "hero".into(),
            table_comment: String::new(),
            columns: vec![ColumnMeta::with_basic(
                "name",
                "varchar(64)",
                "",
                false,
                false,
            )],
        };
        let request = TablePageRequest {
            page: Some(99),
            page_size: Some(1),
            offset: None,
            include_total: Some(true),
            filter: Some(TablePageFilter {
                query: "Alice".into(),
                columns: vec!["name".into()],
                mode: Some("exact".into()),
            }),
            sort: None,
        };

        let (sql, binds) = build_table_count_sql("game", &table, &request);

        assert!(sql.starts_with("SELECT /*+ MAX_EXECUTION_TIME(10000) */ COUNT(*) AS cnt"));
        assert!(sql.contains("FROM `game`.`hero` WHERE"));
        assert!(!sql.to_ascii_lowercase().contains(" limit "));
        assert!(!sql.to_ascii_lowercase().contains(" offset "));
        assert_eq!(binds, vec!["Alice"]);
        assert_eq!(table_count_pool_options().get_max_connections(), 1);
    }

    #[test]
    fn table_search_scan_sql_is_bounded_timed_and_preserves_sort() {
        let table = TableMeta {
            table_name: "hero".into(),
            table_comment: String::new(),
            columns: vec![
                ColumnMeta::with_basic("id", "bigint", "", true, false),
                ColumnMeta::with_basic("name", "varchar(64)", "", false, false),
            ],
        };
        let sort = TablePageSort {
            column_name: "name".into(),
            descending: true,
        };

        let sql = build_search_scan_sql("game", &table, 256, 128, Some(&sort));

        assert!(sql.starts_with(
            "SELECT /*+ MAX_EXECUTION_TIME(3000) */ CAST(`id` AS CHAR) AS `id`, CAST(`name` AS CHAR) AS `name` FROM `game`.`hero` ORDER BY "
        ));
        assert!(sql.contains("DECIMAL(40,0)"));
        assert!(sql.contains("`hero`.`name` DESC"));
        assert!(sql.ends_with(" LIMIT 128 OFFSET 256"));
        assert!(!sql.contains('?'));
    }

    #[test]
    fn table_search_scan_sql_keeps_native_order_for_numeric_sort() {
        let table = TableMeta {
            table_name: "hero".into(),
            table_comment: String::new(),
            columns: vec![
                ColumnMeta::with_basic("id", "bigint", "", true, false),
                ColumnMeta::with_basic("name", "varchar(64)", "", false, false),
            ],
        };
        let sort = TablePageSort {
            column_name: "id".into(),
            descending: true,
        };

        let sql = build_search_scan_sql("game", &table, 256, 128, Some(&sort));

        assert!(sql.contains(" ORDER BY `hero`.`id` DESC "));
        assert!(!sql.contains("DECIMAL(40,0)"));
    }

    #[test]
    fn table_search_scan_sql_uses_primary_keys_for_stable_default_order() {
        let table = TableMeta {
            table_name: "hero".into(),
            table_comment: String::new(),
            columns: vec![
                ColumnMeta::with_basic("realm", "int", "", true, false),
                ColumnMeta::with_basic("id", "bigint", "", true, false),
            ],
        };

        let sql = build_search_scan_sql("game", &table, 0, 64, None);

        assert!(sql.contains(" ORDER BY `hero`.`realm` ASC, `hero`.`id` ASC "));
        assert!(sql.ends_with("LIMIT 64 OFFSET 0"));
    }

    #[test]
    fn table_search_scan_sql_uses_natural_order_for_text_primary_keys() {
        let table = TableMeta {
            table_name: "activecondprop".into(),
            table_comment: String::new(),
            columns: vec![
                ColumnMeta::with_basic("CondID", "varchar(32)", "", true, false),
                ColumnMeta::with_basic("Idx", "smallint unsigned", "", true, false),
            ],
        };

        let sql = build_search_scan_sql("newsg_4cfg", &table, 0, 64, None);

        assert!(sql.contains("DECIMAL(40,0)"));
        assert!(sql.contains("`activecondprop`.`CondID` ASC"));
        assert!(sql.contains("`activecondprop`.`Idx` ASC"));
        assert!(!sql.contains(" ORDER BY `activecondprop`.`CondID` ASC, `activecondprop`.`Idx` ASC "));
    }

    #[test]
    fn count_metadata_without_total_uses_loaded_offset_as_lower_bound() {
        assert_eq!(
            count_metadata_without_total(1000, 1000, 0),
            (1000, false, true)
        );
        assert_eq!(
            count_metadata_without_total(400, 1000, 0),
            (400, false, false)
        );
        assert_eq!(
            count_metadata_without_total(1000, 1000, 2000),
            (3000, false, true)
        );
        assert_eq!(
            count_metadata_without_total(900, 900, 100),
            (1000, false, true)
        );
    }

    #[test]
    fn build_filter_sql_targets_requested_columns() {
        let columns = vec![
            ColumnMeta::with_basic("name", "varchar(64)", "", false, false),
            ColumnMeta::with_basic("remark`text", "text", "", false, true),
        ];
        let request = TablePageRequest {
            page: None,
            page_size: None,
            offset: None,
            include_total: None,
            filter: Some(TablePageFilter {
                query: "abc".into(),
                columns: vec!["remark`text".into()],
                mode: None,
            }),
            sort: None,
        };

        let (sql, values) = build_filter_sql(&columns, &request);

        assert_eq!(
            sql,
            " WHERE ((LOWER(CAST(`remark``text` AS CHAR)) LIKE ? ESCAPE '\\\\' OR LOWER(CAST(`remark``text` AS CHAR)) LIKE ? ESCAPE '\\\\'))"
        );
        assert_eq!(values, vec!["%abc%", "%a%b%c%"]);
    }

    #[test]
    fn build_filter_sql_uses_the_same_fuzzy_patterns_as_value_search() {
        let columns = vec![ColumnMeta::with_basic(
            "name",
            "varchar(64)",
            "",
            false,
            false,
        )];
        let request = TablePageRequest {
            page: None,
            page_size: None,
            offset: None,
            include_total: None,
            filter: Some(TablePageFilter {
                query: "  Hrp  ".into(),
                columns: vec![],
                mode: None,
            }),
            sort: None,
        };

        let (sql, values) = build_filter_sql(&columns, &request);

        assert_eq!(
            sql,
            " WHERE ((LOWER(CAST(`name` AS CHAR)) LIKE ? ESCAPE '\\\\' OR LOWER(CAST(`name` AS CHAR)) LIKE ? ESCAPE '\\\\'))"
        );
        assert_eq!(values, vec!["%hrp%".to_string(), "%h%r%p%".to_string()]);
    }

    #[test]
    fn build_filter_sql_supports_exact_mode() {
        let columns = vec![ColumnMeta::with_basic(
            "name",
            "varchar(64)",
            "",
            false,
            false,
        )];
        let request = TablePageRequest {
            page: None,
            page_size: None,
            offset: None,
            include_total: None,
            filter: Some(TablePageFilter {
                query: "Needle".into(),
                columns: vec![],
                mode: Some("exact".into()),
            }),
            sort: None,
        };

        let (sql, values) = build_filter_sql(&columns, &request);

        assert_eq!(sql, " WHERE (CAST(`name` AS CHAR) = ?)");
        assert_eq!(values, vec!["Needle"]);
    }

    #[test]
    fn build_filter_sql_supports_continuous_mode_without_subsequence_pattern() {
        let columns = vec![ColumnMeta::with_basic(
            "name",
            "varchar(64)",
            "",
            false,
            false,
        )];
        let request = TablePageRequest {
            page: None,
            page_size: None,
            offset: None,
            include_total: None,
            filter: Some(TablePageFilter {
                query: "Hrp".into(),
                columns: vec![],
                mode: Some("continuous".into()),
            }),
            sort: None,
        };

        let (sql, values) = build_filter_sql(&columns, &request);

        assert_eq!(
            sql,
            " WHERE ((LOWER(CAST(`name` AS CHAR)) LIKE ? ESCAPE '\\\\'))"
        );
        assert_eq!(values, vec!["%hrp%"]);
    }

    #[test]
    fn build_where_uses_all_identity_columns() {
        let mut identity = HashMap::new();
        identity.insert("id".into(), "1".into());
        identity.insert("name`part".into(), "demo".into());

        let (sql, mut values) = build_where(&identity).expect("identity is valid");
        values.sort();

        assert!(sql.contains("`id` <=> ?"));
        assert!(sql.contains("`name``part` <=> ?"));
        assert_eq!(values, vec!["1", "demo"]);
    }

    #[test]
    fn build_nullable_where_distinguishes_sql_null_from_empty_text() {
        let identity = HashMap::from([
            ("empty".to_string(), Some(String::new())),
            ("missing".to_string(), None),
        ]);

        let (sql, values) = build_nullable_where(&identity).expect("nullable identity is valid");

        assert_eq!(sql, "`empty` <=> ? AND `missing` IS NULL");
        assert_eq!(values, vec![String::new()]);
    }

    #[test]
    fn escape_like_pattern_escapes_wildcards_and_backslashes() {
        assert_eq!(escape_like_pattern("a%b_c\\d"), "%a\\%b\\_c\\\\d%");
    }

    #[test]
    fn build_value_search_sql_batches_all_columns_for_one_table() {
        let table = TableMeta {
            table_name: "player`profile".into(),
            table_comment: String::new(),
            columns: vec![
                ColumnMeta::with_basic("nickname", "varchar(64)", "", false, false),
                ColumnMeta::with_basic("remark`text", "text", "", false, true),
                ColumnMeta::with_basic("avatar", "blob", "", false, true),
            ],
        };

        let (sql, bind_count) = build_value_search_sql(&table).expect("columns are searchable");

        assert!(sql.contains("FROM `player``profile`"));
        assert!(sql.contains("AS matched_column"));
        assert!(sql.contains("AS preview_value"));
        assert!(sql.contains("UNION ALL"));
        assert!(sql.contains("SELECT matched_column, preview_value FROM ("));
        assert!(sql.contains("LOWER(CAST(`nickname` AS CHAR)) LIKE ? ESCAPE '\\\\'"));
        assert!(sql.contains("LOWER(CAST(`remark``text` AS CHAR)) LIKE ? ESCAPE '\\\\'"));
        assert!(!sql.contains("`avatar`"));
        assert!(!sql.starts_with('('));
        assert_eq!(sql.matches(" LIMIT 1").count(), 2);
        assert_eq!(bind_count, 2);
    }

    #[test]
    fn build_value_search_column_sql_selects_preview_for_one_column() {
        let table = TableMeta {
            table_name: "player`profile".into(),
            table_comment: String::new(),
            columns: Vec::new(),
        };
        let column = ColumnMeta::with_basic("remark`text", "text", "", false, true);

        let sql = build_value_search_column_sql(&table, &column).expect("column is searchable");

        assert_eq!(
            sql,
            "SELECT CAST(`remark``text` AS CHAR) AS preview_value FROM `player``profile` WHERE CAST(`remark``text` AS CHAR) LIKE ? ESCAPE '\\\\' LIMIT 1"
        );
    }

    #[test]
    fn batch_schema_sql_reads_table_comments_and_all_columns_in_one_query() {
        let sql = super::build_schema_batch_sql(3);

        assert!(sql.contains("information_schema.COLUMNS AS C"));
        assert!(sql.contains("information_schema.TABLES AS T"));
        assert!(sql.contains("T.TABLE_COMMENT"));
        assert!(sql.contains("C.TABLE_NAME IN (?, ?, ?)"));
        assert_eq!(sql.matches("information_schema").count(), 2);
    }

    #[test]
    fn table_list_size_uses_string_transport_for_mysql_numeric_expressions() {
        assert!(list_tables_sql()
            .contains("CAST(COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS CHAR)"));
        assert_eq!(
            parse_mysql_data_size(" 18446744073709551615 "),
            Some(u64::MAX)
        );
        assert_eq!(parse_mysql_data_size("not-a-number"), None);
    }

    #[test]
    fn value_search_pattern_trims_and_rejects_empty_queries() {
        assert_eq!(
            value_search_pattern("  a%b_c\\d  "),
            Some("%a\\%b\\_c\\\\d%".into())
        );
        assert_eq!(value_search_pattern("   "), None);
    }

    #[test]
    fn value_search_patterns_only_build_contiguous_contains() {
        assert_eq!(value_search_patterns("  hrp  "), vec!["%hrp%".to_string()]);
        assert_eq!(value_search_patterns("h"), vec!["%h%".to_string()]);
    }

    #[test]
    fn value_search_patterns_normalize_case_for_database_search() {
        assert_eq!(
            value_search_patterns("  Alice  "),
            vec!["%alice%".to_string()]
        );
    }

    #[test]
    fn value_search_preview_keeps_a_late_contiguous_match_visible() {
        let value = format!("{}prefixAbC21020suffix", "前".repeat(90));

        let preview = value_search_preview(&value, "ABC21020", 80);

        assert!(preview.chars().count() <= 80);
        assert!(preview.to_lowercase().contains("abc21020"));
    }
}
