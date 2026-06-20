use std::{collections::HashMap, time::Duration};

use reqwest::Url;
use serde_json::Value;

use crate::db::{normalize_page_request, primary_keys};
use crate::types::{
    ColumnMeta, SearchValueItem, TableMeta, TableOption, TablePageRequest, TableSessionPage,
};

pub fn quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

fn table_ref(database: &str, table_name: &str) -> String {
    format!("{}.{}", quote_ident(database), quote_ident(table_name))
}

fn json_rows(value: &Value) -> Vec<&serde_json::Map<String, Value>> {
    value
        .get("data")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default()
}

fn json_cell_to_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::Null) | None => String::new(),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(value) => value.to_string(),
    }
}

fn parse_http_url(raw: &str) -> Result<(Url, Option<(String, String)>), String> {
    let mut url = Url::parse(raw).map_err(|error| format!("ClickHouse URL 无效: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("ClickHouse 连接需要 http:// 或 https:// URL".into());
    }
    let username = url.username().to_string();
    let password = url.password().unwrap_or_default().to_string();
    let auth = if username.is_empty() {
        None
    } else {
        url.set_username("")
            .map_err(|_| "ClickHouse URL 用户名无效".to_string())?;
        url.set_password(None)
            .map_err(|_| "ClickHouse URL 密码无效".to_string())?;
        Some((username, password))
    };
    Ok((url, auth))
}

pub fn describe_url(raw: &str) -> Result<(String, u16, String), String> {
    let url = Url::parse(raw).map_err(|error| format!("ClickHouse URL 无效: {error}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "ClickHouse URL 缺少主机".to_string())?
        .to_string();
    let port = url.port_or_known_default().unwrap_or(8123);
    let username = if url.username().is_empty() {
        "default".into()
    } else {
        url.username().into()
    };
    Ok((host, port, username))
}

const CLICKHOUSE_REQUEST_TIMEOUT: Duration = Duration::from_secs(4);

async fn execute_json_query(url: &str, sql: &str) -> Result<Value, String> {
    let (url, auth) = parse_http_url(url)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(CLICKHOUSE_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("初始化 ClickHouse 客户端失败: {error}"))?;
    let mut request = client.post(url).body(sql.to_string());
    if let Some((username, password)) = auth {
        request = request.basic_auth(username, Some(password));
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("连接 ClickHouse 失败: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取 ClickHouse 响应失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("ClickHouse 查询失败: {text}"));
    }
    serde_json::from_str(&text).map_err(|error| format!("解析 ClickHouse 响应失败: {error}"))
}

pub fn friendly_clickhouse_connect_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("401")
        || lower.contains("403")
        || lower.contains("authentication")
        || lower.contains("password")
        || lower.contains("unauthorized")
    {
        return "认证失败：用户名或密码错误".into();
    }
    if lower.contains("connection refused")
        || lower.contains("actively refused")
        || lower.contains("failed to connect")
        || lower.contains("error sending request")
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
    if lower.contains("code: 497") || lower.contains("required privilege") {
        return "权限不足：当前用户缺少访问权限".into();
    }
    "连接失败：请检查连接参数后重试".into()
}

pub async fn test_connection(url: &str) -> Result<(), String> {
    execute_json_query(url, "SELECT 1 FORMAT JSON")
        .await
        .map_err(|error| friendly_clickhouse_connect_error(&error))?;
    Ok(())
}

pub async fn list_databases(url: &str) -> Result<Vec<String>, String> {
    let sql = "SELECT name FROM system.databases ORDER BY name FORMAT JSON";
    let value = execute_json_query(url, sql).await?;
    Ok(json_rows(&value)
        .into_iter()
        .filter_map(|row| row.get("name"))
        .map(|value| json_cell_to_string(Some(value)))
        .filter(|name| {
            !matches!(
                name.as_str(),
                "system" | "INFORMATION_SCHEMA" | "information_schema"
            )
        })
        .collect())
}

pub async fn list_tables(url: &str, database: &str) -> Result<Vec<TableOption>, String> {
    let sql = format!(
        "SELECT name, ifNull(comment, '') AS comment FROM system.tables WHERE database = {} AND is_temporary = 0 ORDER BY name FORMAT JSON",
        quote_string(database)
    );
    let value = execute_json_query(url, &sql).await?;
    Ok(json_rows(&value)
        .into_iter()
        .map(|row| TableOption {
            table_name: json_cell_to_string(row.get("name")),
            table_comment: json_cell_to_string(row.get("comment")),
        })
        .filter(|table| !table.table_name.trim().is_empty())
        .collect())
}

pub async fn read_schema(url: &str, database: &str, table_name: &str) -> Result<TableMeta, String> {
    let table_sql = format!(
        "SELECT name, ifNull(comment, '') AS comment FROM system.tables WHERE database = {} AND name = {} LIMIT 1 FORMAT JSON",
        quote_string(database),
        quote_string(table_name)
    );
    let table_value = execute_json_query(url, &table_sql).await?;
    let table_row = json_rows(&table_value)
        .into_iter()
        .next()
        .ok_or_else(|| format!("表不存在: {table_name}"))?;
    let column_sql = format!(
        "SELECT name, type, ifNull(comment, '') AS comment, is_in_primary_key, default_kind, default_expression FROM system.columns WHERE database = {} AND table = {} ORDER BY position FORMAT JSON",
        quote_string(database),
        quote_string(table_name)
    );
    let column_value = execute_json_query(url, &column_sql).await?;
    let columns = json_rows(&column_value)
        .into_iter()
        .map(|row| {
            let column_type = json_cell_to_string(row.get("type"));
            let lower = column_type.to_ascii_lowercase();
            let is_nullable = lower.starts_with("nullable(");
            let data_type = lower
                .trim_start_matches("nullable(")
                .trim_start_matches("lowcardinality(")
                .trim_end_matches(')')
                .split('(')
                .next()
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            ColumnMeta {
                column_name: json_cell_to_string(row.get("name")),
                column_type: column_type.clone(),
                column_comment: json_cell_to_string(row.get("comment")),
                is_primary_key: json_cell_to_string(row.get("is_in_primary_key")) == "1",
                is_nullable,
                data_type,
                character_maximum_length: None,
                numeric_precision: None,
                numeric_scale: None,
                is_unsigned: lower.starts_with('u'),
                is_auto_increment: false,
                enum_values: Vec::new(),
                set_values: Vec::new(),
                is_generated: false,
                default_value: Some(json_cell_to_string(row.get("default_expression")))
                    .filter(|value| !value.trim().is_empty()),
                default_mode: Some(json_cell_to_string(row.get("default_kind")))
                    .filter(|value| !value.trim().is_empty()),
            }
        })
        .collect();
    Ok(TableMeta {
        table_name: json_cell_to_string(table_row.get("name")),
        table_comment: json_cell_to_string(table_row.get("comment")),
        columns,
    })
}

fn build_filter_sql(columns: &[ColumnMeta], request: &TablePageRequest) -> String {
    let Some(filter) = request.filter.as_ref() else {
        return String::new();
    };
    let query = filter.query.trim();
    if query.is_empty() {
        return String::new();
    }
    let requested = filter
        .columns
        .iter()
        .map(|value| value.to_lowercase())
        .collect::<Vec<_>>();
    let predicates = columns
        .iter()
        .filter(|column| {
            requested.is_empty() || requested.contains(&column.column_name.to_lowercase())
        })
        .map(|column| {
            format!(
                "positionCaseInsensitiveUTF8(toString({}), {}) > 0",
                quote_ident(&column.column_name),
                quote_string(query)
            )
        })
        .collect::<Vec<_>>();
    if predicates.is_empty() {
        String::new()
    } else {
        format!(" WHERE ({})", predicates.join(" OR "))
    }
}

pub fn build_read_page_sql(database: &str, table: &TableMeta, request: &TablePageRequest) -> String {
    let (page, page_size) = normalize_page_request(request);
    let offset = (page - 1) * page_size;
    let select_columns = table
        .columns
        .iter()
        .map(|column| {
            format!(
                "toString({}) AS {}",
                quote_ident(&column.column_name),
                quote_ident(&column.column_name)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let where_sql = build_filter_sql(&table.columns, request);
    let order_sql = request
        .sort
        .as_ref()
        .filter(|sort| !sort.column_name.trim().is_empty())
        .map(|sort| {
            format!(
                " ORDER BY {} {}",
                quote_ident(&sort.column_name),
                if sort.descending { "DESC" } else { "ASC" }
            )
        })
        .unwrap_or_default();
    format!(
        "SELECT {} FROM {}{}{} LIMIT {} OFFSET {} FORMAT JSON",
        select_columns,
        table_ref(database, &table.table_name),
        where_sql,
        order_sql,
        page_size,
        offset
    )
}

fn build_count_sql(database: &str, table: &TableMeta, request: &TablePageRequest) -> String {
    format!(
        "SELECT count() AS cnt FROM {}{} FORMAT JSON",
        table_ref(database, &table.table_name),
        build_filter_sql(&table.columns, request)
    )
}

pub async fn read_page(
    url: &str,
    database: &str,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> Result<TableSessionPage, String> {
    let (page, page_size) = normalize_page_request(request);
    let count_value = execute_json_query(url, &build_count_sql(database, table, request)).await?;
    let total_rows = json_rows(&count_value)
        .into_iter()
        .next()
        .and_then(|row| row.get("cnt"))
        .and_then(|value| json_cell_to_string(Some(value)).parse::<u64>().ok())
        .unwrap_or(0);
    let value = execute_json_query(url, &build_read_page_sql(database, table, request)).await?;
    let rows = json_rows(&value)
        .into_iter()
        .map(|row| {
            let mut out = HashMap::new();
            for column in &table.columns {
                out.insert(
                    column.column_name.clone(),
                    json_cell_to_string(row.get(&column.column_name)),
                );
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

pub async fn search_value_matches(
    url: &str,
    database: &str,
    table: &TableMeta,
    query: &str,
) -> Result<Vec<SearchValueItem>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    for column in &table.columns {
        if column.column_name.trim().is_empty() {
            continue;
        }
        let sql = format!(
            "SELECT toString({column}) AS preview_value FROM {table_ref} WHERE positionCaseInsensitiveUTF8(toString({column}), {query}) > 0 LIMIT 1 FORMAT JSON",
            column = quote_ident(&column.column_name),
            table_ref = table_ref(database, &table.table_name),
            query = quote_string(query)
        );
        let value = execute_json_query(url, &sql).await?;
        let Some(row) = json_rows(&value).into_iter().next() else {
            continue;
        };
        results.push(SearchValueItem {
            table_name: table.table_name.clone(),
            table_comment: table.table_comment.clone(),
            column_name: column.column_name.clone(),
            preview_value: json_cell_to_string(row.get("preview_value"))
                .chars()
                .take(80)
                .collect(),
            row_identity: None,
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use crate::types::{ColumnMeta, TableMeta, TablePageRequest, TablePageSort};

    #[test]
    fn clickhouse_identifiers_use_double_quotes() {
        assert_eq!(super::quote_ident("events"), "\"events\"");
        assert_eq!(super::quote_ident("bad\"name"), "\"bad\"\"name\"");
    }

    #[test]
    fn clickhouse_page_sql_is_select_only_and_uses_limit_by_offset() {
        let table = TableMeta {
            table_name: "events".into(),
            table_comment: String::new(),
            columns: vec![
                ColumnMeta::with_basic("event_id", "UInt64", "", false, false),
                ColumnMeta::with_basic("user_name", "String", "", false, false),
            ],
        };
        let request = TablePageRequest {
            page: Some(3),
            page_size: Some(25),
            filter: None,
            sort: Some(TablePageSort {
                column_name: "event_id".into(),
                descending: true,
            }),
        };

        let sql = super::build_read_page_sql("analytics", &table, &request);

        assert_eq!(
            sql,
            "SELECT toString(\"event_id\") AS \"event_id\", toString(\"user_name\") AS \"user_name\" FROM \"analytics\".\"events\" ORDER BY \"event_id\" DESC LIMIT 25 OFFSET 50 FORMAT JSON"
        );
        assert!(!sql.to_ascii_lowercase().contains("update"));
        assert!(!sql.to_ascii_lowercase().contains("delete"));
        assert!(!sql.to_ascii_lowercase().contains("insert"));
    }
}
