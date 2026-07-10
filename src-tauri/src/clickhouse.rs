use std::{collections::HashMap, time::Duration};

use reqwest::Url;
use serde_json::Value;

use crate::db::{count_metadata_without_total, normalize_page_request, primary_keys};
use crate::perf::{
    PerfContext, PerfEventDetails, PerfOutcome, PerfPhase, PerfStage, PerformanceRecorder,
};
use crate::types::{
    ColumnMeta, SearchValueItem, TableCountResult, TableMeta, TableOption, TablePageRequest,
    TableSessionPage,
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

#[derive(Clone, Copy)]
enum ClickHouseQueryKind {
    General,
    Count,
    Page,
}

impl ClickHouseQueryKind {
    fn wait_label(self) -> &'static str {
        match self {
            Self::General => "clickhouse.query_wait",
            Self::Count => "clickhouse.count_query_wait",
            Self::Page => "clickhouse.page_query_wait",
        }
    }
}

fn validate_clickhouse_response(
    status: reqwest::StatusCode,
    text: String,
) -> Result<String, String> {
    if status.is_success() {
        Ok(text)
    } else {
        Err(format!("ClickHouse 查询失败: {text}"))
    }
}

fn json_object_row_count(value: &Value) -> usize {
    value
        .get("data")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter(|row| row.is_object()).count())
        .unwrap_or(0)
}

async fn execute_json_query(url: &str, sql: &str) -> Result<Value, String> {
    execute_json_query_inner(url, sql, ClickHouseQueryKind::General, None).await
}

async fn execute_json_query_inner(
    url: &str,
    sql: &str,
    query_kind: ClickHouseQueryKind,
    perf: Option<(&PerformanceRecorder, &PerfContext)>,
) -> Result<Value, String> {
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
    let request_span = perf.and_then(|(recorder, context)| {
        recorder.begin_span(
            query_kind.wait_label(),
            PerfPhase::Database,
            Some(context),
            || PerfEventDetails::stage(PerfStage::Request),
        )
    });
    let response_result = async {
        let response = request
            .send()
            .await
            .map_err(|error| format!("连接 ClickHouse 失败: {error}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| format!("读取 ClickHouse 响应失败: {error}"))?;
        validate_clickhouse_response(status, text)
    }
    .await;
    if let Some(span) = request_span {
        span.finish(
            if response_result.is_ok() {
                PerfOutcome::Success
            } else {
                PerfOutcome::Error
            },
            PerfEventDetails::default,
        );
    }
    let text = response_result?;
    let decode_span = perf.and_then(|(recorder, context)| {
        recorder.begin_span(
            "clickhouse.json_decode",
            PerfPhase::Conversion,
            Some(context),
            || PerfEventDetails {
                stage: Some(PerfStage::Convert),
                payload_bytes: Some(text.len() as u64),
                ..PerfEventDetails::default()
            },
        )
    });
    let decoded =
        serde_json::from_str(&text).map_err(|error| format!("解析 ClickHouse 响应失败: {error}"));
    if let Some(span) = decode_span {
        span.finish(
            if decoded.is_ok() {
                PerfOutcome::Success
            } else {
                PerfOutcome::Error
            },
            PerfEventDetails::default,
        );
    }
    decoded
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
            column_count: None,
        })
        .filter(|table| !table.table_name.trim().is_empty())
        .collect())
}

pub async fn read_schema(url: &str, database: &str, table_name: &str) -> Result<TableMeta, String> {
    read_schemas(url, database, &[table_name.to_string()])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| format!("表不存在: {table_name}"))
}

pub async fn read_schemas(
    url: &str,
    database: &str,
    table_names: &[String],
) -> Result<Vec<TableMeta>, String> {
    if table_names.is_empty() {
        return Ok(Vec::new());
    }
    let sql = build_read_schemas_sql(database, table_names);
    let value = execute_json_query(url, &sql).await?;
    let schemas = parse_schema_batch(&value, table_names);
    if schemas.len() != table_names.len() {
        let loaded = schemas
            .iter()
            .map(|schema| schema.table_name.to_lowercase())
            .collect::<std::collections::HashSet<_>>();
        let missing = table_names
            .iter()
            .find(|table_name| !loaded.contains(&table_name.to_lowercase()))
            .cloned()
            .unwrap_or_default();
        return Err(format!("表不存在: {missing}"));
    }
    Ok(schemas)
}

fn build_read_schemas_sql(database: &str, table_names: &[String]) -> String {
    let table_list = table_names
        .iter()
        .map(|table_name| quote_string(table_name))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT c.table AS table_name, ifNull(t.comment, '') AS table_comment, \
         c.name AS column_name, c.type AS column_type, ifNull(c.comment, '') AS column_comment, \
         c.is_in_primary_key AS is_primary_key, c.default_kind, c.default_expression \
         FROM system.columns AS c \
         LEFT JOIN system.tables AS t ON t.database = c.database AND t.name = c.table \
         WHERE c.database = {} AND c.table IN ({table_list}) \
         ORDER BY c.table, c.position FORMAT JSON",
        quote_string(database)
    )
}

fn parse_schema_batch(value: &Value, table_names: &[String]) -> Vec<TableMeta> {
    let mut comments = HashMap::<String, String>::new();
    let mut columns = HashMap::<String, Vec<ColumnMeta>>::new();
    for row in json_rows(value) {
        let table_name = json_cell_to_string(row.get("table_name"));
        let normalized_table_name = table_name.to_lowercase();
        comments.insert(
            normalized_table_name.clone(),
            json_cell_to_string(row.get("table_comment")),
        );
        let column_type = json_cell_to_string(row.get("column_type"));
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
        columns
            .entry(normalized_table_name)
            .or_default()
            .push(ColumnMeta {
                column_name: json_cell_to_string(row.get("column_name")),
                column_type: column_type.clone(),
                column_comment: json_cell_to_string(row.get("column_comment")),
                is_primary_key: json_cell_to_string(row.get("is_primary_key")) == "1",
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
            });
    }

    table_names
        .into_iter()
        .filter_map(|table_name| {
            let normalized = table_name.to_lowercase();
            columns.remove(&normalized).map(|columns| TableMeta {
                table_name: table_name.clone(),
                table_comment: comments.remove(&normalized).unwrap_or_default(),
                columns,
            })
        })
        .collect()
}

fn build_filter_sql(columns: &[ColumnMeta], request: &TablePageRequest) -> String {
    let Some(filter) = request.filter.as_ref() else {
        return String::new();
    };
    let query = filter.query.trim();
    if query.is_empty() {
        return String::new();
    }
    let exact = filter
        .mode
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("exact"))
        .unwrap_or(false);
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
            if exact {
                format!(
                    "toString({}) = {}",
                    quote_ident(&column.column_name),
                    quote_string(query)
                )
            } else {
                format!(
                    "positionCaseInsensitiveUTF8(toString({}), {}) > 0",
                    quote_ident(&column.column_name),
                    quote_string(query)
                )
            }
        })
        .collect::<Vec<_>>();
    if predicates.is_empty() {
        String::new()
    } else {
        format!(" WHERE ({})", predicates.join(" OR "))
    }
}

pub fn build_read_page_sql(
    database: &str,
    table: &TableMeta,
    request: &TablePageRequest,
) -> String {
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

pub(crate) fn build_table_count_sql(
    database: &str,
    table: &TableMeta,
    request: &TablePageRequest,
) -> String {
    format!(
        "SELECT count() AS cnt FROM {}{} SETTINGS max_execution_time = 10 FORMAT JSON",
        table_ref(database, &table.table_name),
        build_filter_sql(&table.columns, request)
    )
}

pub async fn read_table_count_with_perf(
    url: &str,
    database: &str,
    table: &TableMeta,
    request: &TablePageRequest,
    recorder: &PerformanceRecorder,
    context: &PerfContext,
) -> Result<TableCountResult, String> {
    let value = execute_json_query_inner(
        url,
        &build_table_count_sql(database, table, request),
        ClickHouseQueryKind::Count,
        Some((recorder, context)),
    )
    .await?;
    let total_rows = json_rows(&value)
        .into_iter()
        .next()
        .and_then(|row| row.get("cnt"))
        .and_then(|value| json_cell_to_string(Some(value)).parse::<u64>().ok())
        .unwrap_or(0);
    Ok(TableCountResult {
        total_rows,
        exact: true,
        estimated: false,
    })
}

pub async fn read_page_with_perf(
    url: &str,
    database: &str,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
    recorder: &PerformanceRecorder,
    context: &PerfContext,
) -> Result<TableSessionPage, String> {
    read_page_inner(
        url,
        database,
        table,
        session_id,
        request,
        Some((recorder, context)),
    )
    .await
}

async fn read_page_inner(
    url: &str,
    database: &str,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
    perf: Option<(&PerformanceRecorder, &PerfContext)>,
) -> Result<TableSessionPage, String> {
    let (page, page_size) = normalize_page_request(request);
    let value = execute_json_query_inner(
        url,
        &build_read_page_sql(database, table, request),
        ClickHouseQueryKind::Page,
        perf,
    )
    .await?;
    let conversion_span = perf.and_then(|(recorder, context)| {
        recorder.begin_span(
            "clickhouse.row_convert",
            PerfPhase::Conversion,
            Some(context),
            || PerfEventDetails {
                stage: Some(PerfStage::Convert),
                row_count: Some(json_object_row_count(&value) as u64),
                column_count: Some(table.columns.len() as u64),
                ..PerfEventDetails::default()
            },
        )
    });
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
    if let Some(span) = conversion_span {
        span.finish(PerfOutcome::Success, PerfEventDetails::default);
    }
    let (total_rows, total_rows_exact, has_more) =
        count_metadata_without_total(rows.len(), page_size, page);
    Ok(TableSessionPage {
        session_id: session_id.into(),
        table_name: table.table_name.clone(),
        table_comment: table.table_comment.clone(),
        columns: table.columns.clone(),
        primary_keys: primary_keys(table),
        rows,
        total_rows,
        total_rows_exact,
        has_more,
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
    use reqwest::StatusCode;
    use serde_json::json;

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
            include_total: None,
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

    #[test]
    fn batch_schema_sql_reads_requested_tables_with_one_columns_query() {
        let sql = super::build_read_schemas_sql("analytics", &["events".into(), "users".into()]);

        assert!(sql.contains("FROM system.columns AS c"));
        assert!(sql.contains("LEFT JOIN system.tables AS t"));
        assert!(sql.contains("c.table IN ('events', 'users')"));
        assert_eq!(sql.matches("FORMAT JSON").count(), 1);
    }

    #[test]
    fn batch_schema_rows_are_grouped_by_requested_table() {
        let value = serde_json::json!({
            "data": [
                {
                    "table_name": "events",
                    "table_comment": "Events",
                    "column_name": "event_id",
                    "column_type": "UInt64",
                    "column_comment": "",
                    "default_kind": "",
                    "default_expression": "",
                    "is_primary_key": 1
                },
                {
                    "table_name": "users",
                    "table_comment": "Users",
                    "column_name": "name",
                    "column_type": "String",
                    "column_comment": "Display name",
                    "default_kind": "DEFAULT",
                    "default_expression": "''",
                    "is_primary_key": 0
                }
            ]
        });

        let schemas = super::parse_schema_batch(&value, &["users".into(), "events".into()]);

        assert_eq!(schemas.len(), 2);
        assert_eq!(schemas[0].table_name, "users");
        assert_eq!(schemas[0].columns[0].column_name, "name");
        assert_eq!(schemas[1].table_name, "events");
        assert!(schemas[1].columns[0].is_primary_key);
    }

    #[test]
    fn clickhouse_http_status_validation_rejects_non_success_before_recording_outcome() {
        assert!(super::validate_clickhouse_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server failed".into(),
        )
        .is_err());
        assert_eq!(
            super::validate_clickhouse_response(StatusCode::OK, "{\"data\":[]}".into()).unwrap(),
            "{\"data\":[]}"
        );
    }

    #[test]
    fn count_and_page_queries_have_distinct_wait_labels() {
        assert_ne!(
            super::ClickHouseQueryKind::Count.wait_label(),
            super::ClickHouseQueryKind::Page.wait_label(),
        );
        assert_eq!(
            super::ClickHouseQueryKind::Count.wait_label(),
            "clickhouse.count_query_wait"
        );
        assert_eq!(
            super::ClickHouseQueryKind::Page.wait_label(),
            "clickhouse.page_query_wait"
        );
    }

    #[test]
    fn table_count_uses_a_server_timeout_without_fetching_a_page() {
        let table = TableMeta {
            table_name: "events".into(),
            table_comment: String::new(),
            columns: vec![ColumnMeta::with_basic(
                "event_name",
                "String",
                "",
                false,
                false,
            )],
        };
        let request = TablePageRequest {
            page: Some(99),
            page_size: Some(1),
            include_total: Some(true),
            filter: Some(crate::types::TablePageFilter {
                query: "launch".into(),
                columns: vec!["event_name".into()],
                mode: None,
            }),
            sort: None,
        };

        let sql = super::build_table_count_sql("analytics", &table, &request);

        assert!(sql.starts_with("SELECT count() AS cnt FROM \"analytics\".\"events\""));
        assert!(sql.contains("SETTINGS max_execution_time = 10 FORMAT JSON"));
        assert!(!sql.to_ascii_lowercase().contains(" limit "));
        assert!(!sql.to_ascii_lowercase().contains(" offset "));
    }

    #[test]
    fn row_count_reads_json_array_without_materializing_row_references() {
        let value = json!({ "data": [{ "id": 1 }, { "id": 2 }, null] });
        assert_eq!(super::json_object_row_count(&value), 2);

        let source = include_str!("clickhouse.rs").replace("\r\n", "\n");
        let conversion = source
            .split("let conversion_span")
            .nth(1)
            .and_then(|tail| tail.split("let rows = json_rows").next())
            .expect("row conversion instrumentation should remain localized");
        assert!(conversion.contains("json_object_row_count(&value)"));
        assert!(!conversion.contains("let row_count = json_rows"));
    }
}
