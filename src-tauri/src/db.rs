use std::{collections::HashMap, str::FromStr, time::Duration};

use sqlx::{
    mysql::{MySqlConnectOptions, MySqlPoolOptions},
    MySqlPool, Row,
};

use crate::types::*;

pub fn escape_ident(value: &str) -> String {
    value.replace('`', "``")
}

fn escape_sql_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "''")
}

fn table_ref_sql(database: Option<&str>, table_name: &str) -> String {
    if let Some(database) = database.filter(|value| !value.trim().is_empty()) {
        format!(
            "`{}`.`{}`",
            escape_ident(database.trim()),
            escape_ident(table_name)
        )
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
    let sql = format!(
        " WHERE ({})",
        filter_columns
            .iter()
            .map(|column| format!(
                "CAST(`{}` AS CHAR) LIKE ? ESCAPE '\\\\'",
                escape_ident(&column.column_name)
            ))
            .collect::<Vec<_>>()
            .join(" OR ")
    );
    let escaped_query = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    (
        sql,
        filter_columns
            .iter()
            .map(|_| format!("%{escaped_query}%"))
            .collect(),
    )
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
    let contains = escape_like_pattern(query);
    let subsequence = escape_like_subsequence_pattern(query);
    if contains == subsequence {
        vec![contains]
    } else {
        vec![contains, subsequence]
    }
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
            let value = row
                .try_get::<Option<String>, _>("preview_value")
                .unwrap_or(None)
                .unwrap_or_default();
            results.push(SearchValueItem {
                table_name: table.table_name.clone(),
                table_comment: table.table_comment.clone(),
                column_name: column.column_name.clone(),
                preview_value: value.chars().take(80).collect(),
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
        let mut query = sqlx::query(&sql);
        for _ in 0..bind_count {
            query = query.bind(&pattern);
        }
        let rows = query
            .fetch_all(pool)
            .await
            .map_err(|error| format!("搜索值失败: {error}"))?;
        for row in rows {
            let column_name = row
                .try_get::<String, _>("matched_column")
                .unwrap_or_default();
            if column_name.is_empty()
                || results
                    .iter()
                    .any(|item: &SearchValueItem| item.column_name == column_name)
            {
                continue;
            }
            let value = row
                .try_get::<Option<String>, _>("preview_value")
                .unwrap_or(None)
                .unwrap_or_default();
            results.push(SearchValueItem {
                table_name: table.table_name.clone(),
                table_comment: table.table_comment.clone(),
                column_name,
                preview_value: value.chars().take(80).collect(),
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
    let mut options = MySqlConnectOptions::from_str(mysql_url)
        .map_err(|error| format!("MySQL URL 无效: {error}"))?;
    if let Some(database) = database.filter(|value| !value.trim().is_empty()) {
        options = options.database(database.trim());
    }
    MySqlPoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .map_err(|error| format!("连接 MySQL 失败: {error}"))
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
    match tokio::time::timeout(TEST_CONNECTION_TIMEOUT, probe_database_connection(mysql_url)).await {
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
    .map(|row| {
        let column_type: String = row
            .try_get("COLUMN_TYPE")
            .map_err(|error| error.to_string())?;
        let data_type: Option<String> = row.try_get("DATA_TYPE").ok();
        let extra: String = row.try_get("EXTRA").unwrap_or_default();
        let generation_expression: Option<String> = row.try_get("GENERATION_EXPRESSION").ok();
        let is_primary_key = row.try_get::<i8, _>("IS_PRIMARY_KEY").unwrap_or(0) != 0;
        let is_nullable = row.try_get::<i8, _>("IS_NULLABLE").unwrap_or(0) != 0;
        let default_value: Option<String> = row.try_get("COLUMN_DEFAULT").ok();
        let default_mode = Some(infer_default_mode(
            &default_value,
            is_nullable,
            is_primary_key,
        ));
        let normalized_data_type = data_type.clone().unwrap_or_default().to_ascii_lowercase();
        Ok(ColumnMeta {
            column_name: row
                .try_get("COLUMN_NAME")
                .map_err(|error| error.to_string())?,
            column_type: column_type.clone(),
            column_comment: row.try_get("COLUMN_COMMENT").unwrap_or_default(),
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
    })
    .collect::<Result<Vec<_>, String>>()?;

    Ok(TableMeta {
        table_name: table_row
            .try_get("TABLE_NAME")
            .unwrap_or_else(|_| table_name.to_string()),
        table_comment: table_row.try_get("TABLE_COMMENT").unwrap_or_default(),
        columns,
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
    let supported = matches!(
        data_type.to_ascii_lowercase().as_str(),
        "char"
            | "varchar"
            | "binary"
            | "varbinary"
            | "bit"
            | "decimal"
            | "numeric"
            | "dec"
            | "fixed"
            | "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "float"
            | "double"
            | "real"
            | "tinytext"
            | "text"
            | "mediumtext"
            | "longtext"
            | "json"
            | "tinyblob"
            | "blob"
            | "mediumblob"
            | "longblob"
            | "date"
            | "datetime"
            | "timestamp"
            | "time"
            | "year"
            | "bool"
            | "boolean"
    );
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
        "SELECT ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, \
         CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, \
         IS_NULLABLE = 'YES' AS IS_NULLABLE, COLUMN_KEY = 'PRI' AS IS_PRIMARY_KEY, \
         COLUMN_DEFAULT, COALESCE(COLUMN_COMMENT, '') AS COLUMN_COMMENT, \
         COALESCE(EXTRA, '') AS EXTRA, GENERATION_EXPRESSION \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    )
    .bind(database)
    .bind(table_name)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取字段设计失败: {error}"))?
    .into_iter()
    .map(|row| {
        let data_type: String = row
            .try_get("DATA_TYPE")
            .map_err(|error| error.to_string())?;
        let nullable = row.try_get::<i8, _>("IS_NULLABLE").unwrap_or(0) != 0;
        let primary_key = row.try_get::<i8, _>("IS_PRIMARY_KEY").unwrap_or(0) != 0;
        let default_value = row
            .try_get::<Option<String>, _>("COLUMN_DEFAULT")
            .unwrap_or(None);
        let extra = row.try_get::<String, _>("EXTRA").unwrap_or_default();
        let generation_expression = row
            .try_get::<Option<String>, _>("GENERATION_EXPRESSION")
            .unwrap_or(None)
            .filter(|value| !value.trim().is_empty());
        let (is_generated, is_supported, unsupported_reason) =
            column_support(&data_type, &extra, &generation_expression);
        Ok(ColumnDesignMeta {
            ordinal: row.try_get::<u32, _>("ORDINAL_POSITION").unwrap_or(0),
            column_name: row
                .try_get("COLUMN_NAME")
                .map_err(|error| error.to_string())?,
            column_type: row
                .try_get("COLUMN_TYPE")
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
            column_comment: row.try_get("COLUMN_COMMENT").unwrap_or_default(),
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
        table_name: table_row
            .try_get("TABLE_NAME")
            .unwrap_or_else(|_| table_name.to_string()),
        table_comment: table_row.try_get("TABLE_COMMENT").unwrap_or_default(),
        schema_signature: None,
        columns,
    };
    design.schema_signature = Some(crate::ddl::schema_signature(&design));
    Ok(design)
}

pub async fn list_tables_from_db(
    pool: &MySqlPool,
    database: &str,
) -> Result<Vec<TableOption>, String> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME, COALESCE(TABLE_COMMENT, '') AS TABLE_COMMENT \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
    )
    .bind(database)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取表列表失败: {error}"))?;

    Ok(rows
        .into_iter()
        .map(|row| TableOption {
            table_name: row.try_get("TABLE_NAME").unwrap_or_default(),
            table_comment: row.try_get("TABLE_COMMENT").unwrap_or_default(),
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
    let placeholders = std::iter::repeat("?")
        .take(table_names.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, \
         NUMERIC_PRECISION, NUMERIC_SCALE, COALESCE(COLUMN_COMMENT, '') AS COLUMN_COMMENT, \
         COLUMN_KEY = 'PRI' AS IS_PRIMARY_KEY, IS_NULLABLE = 'YES' AS IS_NULLABLE, \
         COALESCE(EXTRA, '') AS EXTRA, COLUMN_DEFAULT, GENERATION_EXPRESSION \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ({placeholders}) ORDER BY TABLE_NAME, ORDINAL_POSITION"
    );
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
        let table_name: String = row.try_get("TABLE_NAME").unwrap_or_default();
        let column_type: String = row
            .try_get("COLUMN_TYPE")
            .map_err(|error| error.to_string())?;
        let data_type: Option<String> = row.try_get("DATA_TYPE").ok();
        let extra: String = row.try_get("EXTRA").unwrap_or_default();
        let generation_expression: Option<String> = row.try_get("GENERATION_EXPRESSION").ok();
        let is_primary_key = row.try_get::<i8, _>("IS_PRIMARY_KEY").unwrap_or(0) != 0;
        let is_nullable = row.try_get::<i8, _>("IS_NULLABLE").unwrap_or(0) != 0;
        let default_value: Option<String> = row.try_get("COLUMN_DEFAULT").ok();
        let default_mode = Some(infer_default_mode(
            &default_value,
            is_nullable,
            is_primary_key,
        ));
        let normalized_data_type = data_type.clone().unwrap_or_default().to_ascii_lowercase();
        by_table.entry(table_name).or_default().push(ColumnMeta {
            column_name: row
                .try_get("COLUMN_NAME")
                .map_err(|error| error.to_string())?,
            column_type: column_type.clone(),
            column_comment: row.try_get("COLUMN_COMMENT").unwrap_or_default(),
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
        });
    }

    Ok(tables
        .iter()
        .filter_map(|table| {
            by_table.remove(&table.table_name).map(|columns| TableMeta {
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

pub async fn read_db_page(
    pool: &MySqlPool,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> Result<TableSessionPage, String> {
    let (page, page_size) = normalize_page_request(request);
    let offset = (page - 1) * page_size;
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
    // ORDER BY references the real (table-qualified) column rather than the
    // CAST(... AS CHAR) select alias. MySQL resolves an unqualified ORDER BY
    // name to the select-list alias first, which forced lexicographic string
    // sorting on every column type (#7). Qualifying with the table name makes
    // MySQL sort on the underlying column so numeric/date values use their
    // native ordering.
    let order_sql = request
        .sort
        .as_ref()
        .filter(|sort| !sort.column_name.trim().is_empty())
        .map(|sort| {
            format!(
                " ORDER BY `{}`.`{}` {}",
                escape_ident(&table.table_name),
                escape_ident(&sort.column_name),
                if sort.descending { "DESC" } else { "ASC" }
            )
        })
        .unwrap_or_default();

    let count_sql = format!(
        "SELECT COUNT(*) AS cnt FROM `{}`{}",
        escape_ident(&table.table_name),
        where_sql
    );
    let mut count_query = sqlx::query(&count_sql);
    for bind in &binds {
        count_query = count_query.bind(bind);
    }
    let total_rows = count_query
        .fetch_one(pool)
        .await
        .map_err(|error| format!("统计行数失败: {error}"))?
        .try_get::<i64, _>("cnt")
        .unwrap_or(0)
        .max(0) as u64;

    let sql = format!(
        "SELECT {} FROM `{}`{}{} LIMIT {} OFFSET {}",
        select_columns,
        escape_ident(&table.table_name),
        where_sql,
        order_sql,
        page_size,
        offset
    );
    let mut query = sqlx::query(&sql);
    for bind in &binds {
        query = query.bind(bind);
    }
    let rows = query
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取数据失败: {error}"))?
        .into_iter()
        .map(|row| {
            let mut out = HashMap::new();
            for column in &table.columns {
                let value = row
                    .try_get::<Option<String>, _>(column.column_name.as_str())
                    .unwrap_or(None)
                    .unwrap_or_default();
                out.insert(column.column_name.clone(), value);
            }
            out
        })
        .collect::<Vec<_>>();

    Ok(TableSessionPage {
        session_id: session_id.into(),
        table_name: table.table_name.clone(),
        table_comment: table.table_comment.clone(),
        columns: table.columns.clone(),
        primary_keys: primary_keys(table),
        rows,
        total_rows,
        page,
        page_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_ident_doubles_backticks() {
        assert_eq!(escape_ident("normal_name"), "normal_name");
        assert_eq!(escape_ident("bad`name"), "bad``name");
    }

    #[test]
    fn normalize_page_request_clamps_page_size() {
        let request = TablePageRequest {
            page: Some(0),
            page_size: Some(999),
            filter: None,
            sort: None,
        };

        assert_eq!(normalize_page_request(&request), (1, 999));
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
            filter: Some(TablePageFilter {
                query: "abc".into(),
                columns: vec!["remark`text".into()],
            }),
            sort: None,
        };

        let (sql, values) = build_filter_sql(&columns, &request);

        assert_eq!(
            sql,
            " WHERE (CAST(`remark``text` AS CHAR) LIKE ? ESCAPE '\\\\')"
        );
        assert_eq!(values, vec!["%abc%"]);
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
    fn value_search_pattern_trims_and_rejects_empty_queries() {
        assert_eq!(
            value_search_pattern("  a%b_c\\d  "),
            Some("%a\\%b\\_c\\\\d%".into())
        );
        assert_eq!(value_search_pattern("   "), None);
    }

    #[test]
    fn value_search_patterns_prefer_contains_before_subsequence_like() {
        assert_eq!(
            value_search_patterns("  hrp  "),
            vec!["%hrp%".to_string(), "%h%r%p%".to_string()]
        );
        assert_eq!(value_search_patterns("h"), vec!["%h%".to_string()]);
    }

    #[test]
    fn value_search_patterns_normalize_case_for_database_search() {
        assert_eq!(
            value_search_patterns("  Alice  "),
            vec!["%alice%".to_string(), "%a%l%i%c%e%".to_string()]
        );
    }
}
