use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::OnceLock,
    time::Duration,
};

use mongodb::{
    bson::{doc, Bson, DateTime, Document, oid::ObjectId},
    options::ClientOptions,
    Client, Collection,
};
use reqwest::Url;
use tokio::sync::Mutex;

use crate::db::{
    count_metadata_without_total, normalize_page_offset, normalize_page_request, primary_keys,
    value_search_preview,
};
use crate::perf::{
    PerfContext, PerfEventDetails, PerfOutcome, PerfPhase, PerfStage, PerformanceRecorder,
};
use crate::types::{
    CellUpdateChange, ColumnMeta, InsertRowResult, RowIdentity, RowMutationResult, SearchValueItem,
    TableCountResult, TableMeta, TableOption, TablePageRequest, TableSessionPage, UpdateCellsResult,
    UpdateRowPatch,
};

const SCHEMA_SAMPLE_LIMIT: i64 = 100;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const SERVER_SELECTION_TIMEOUT: Duration = Duration::from_secs(4);

fn client_cache() -> &'static Mutex<HashMap<String, Client>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Client>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn disconnect(url: &str) {
    client_cache().lock().await.remove(url);
}

async fn connect_client(url: &str) -> Result<Client, String> {
    let mut options = ClientOptions::parse(url)
        .await
        .map_err(|error| friendly_mongo_connect_error(&error.to_string()))?;
    options.connect_timeout = Some(CONNECT_TIMEOUT);
    options.server_selection_timeout = Some(SERVER_SELECTION_TIMEOUT);
    Client::with_options(options).map_err(|error| friendly_mongo_connect_error(&error.to_string()))
}

async fn client_for(url: &str) -> Result<Client, String> {
    {
        let cache = client_cache().lock().await;
        if let Some(client) = cache.get(url) {
            return Ok(client.clone());
        }
    }
    let client = connect_client(url).await?;
    let mut cache = client_cache().lock().await;
    Ok(cache.entry(url.to_string()).or_insert(client).clone())
}

pub fn describe_url(raw: &str) -> Result<(String, u16, String), String> {
    let url = parse_mongo_url(raw)?;
    let host = url
        .host_str()
        .ok_or_else(|| "MongoDB URL 缺少主机".to_string())?
        .to_string();
    let port = url.port().unwrap_or(27017);
    let username = url.username().to_string();
    Ok((host, port, username))
}

fn parse_mongo_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if !(trimmed.starts_with("mongodb://") || trimmed.starts_with("mongodb+srv://")) {
        return Err("MongoDB 连接需要 mongodb:// 或 mongodb+srv:// URL".into());
    }
    Url::parse(trimmed).map_err(|error| format!("MongoDB URL 无效: {error}"))
}

pub fn friendly_mongo_connect_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("authentication")
        || lower.contains("auth failed")
        || lower.contains("unauthorized")
        || lower.contains("bad auth")
    {
        return "认证失败：用户名或密码错误".into();
    }
    if lower.contains("connection refused")
        || lower.contains("actively refused")
        || lower.contains("failed to connect")
        || lower.contains("io error")
    {
        return "无法连接到服务器：请检查主机和端口是否正确".into();
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return "连接超时：请检查网络或防火墙设置".into();
    }
    if lower.contains("unknown host")
        || lower.contains("failed to lookup")
        || lower.contains("dns")
        || lower.contains("no such host")
    {
        return "无法解析主机名：请检查主机地址是否正确".into();
    }
    if lower.contains("invalid") && lower.contains("url") {
        return "MongoDB URL 无效".into();
    }
    "连接失败：请检查连接参数后重试".into()
}

pub async fn test_connection(url: &str) -> Result<(), String> {
    let client = connect_client(url).await?;
    client
        .list_database_names()
        .await
        .map_err(|error| friendly_mongo_connect_error(&error.to_string()))?;
    Ok(())
}

pub async fn list_databases(url: &str) -> Result<Vec<String>, String> {
    let client = client_for(url).await?;
    client
        .list_database_names()
        .await
        .map_err(|error| format!("读取数据库失败: {error}"))
}

pub async fn list_tables(url: &str, database: &str) -> Result<Vec<TableOption>, String> {
    let client = client_for(url).await?;
    let names = client
        .database(database)
        .list_collection_names()
        .await
        .map_err(|error| format!("读取集合失败: {error}"))?;
    Ok(names
        .into_iter()
        .filter(|name| !name.trim().is_empty())
        .map(|table_name| TableOption {
            table_name,
            table_comment: String::new(),
            column_count: None,
            data_size_bytes: None,
            modified_at: None,
            modified_source: None,
            modified_actor: None,
        })
        .collect())
}

pub async fn read_schema(url: &str, database: &str, table_name: &str) -> Result<TableMeta, String> {
    read_schemas(url, database, &[table_name.to_string()])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| format!("集合不存在: {table_name}"))
}

pub async fn read_schemas(
    url: &str,
    database: &str,
    table_names: &[String],
) -> Result<Vec<TableMeta>, String> {
    let client = client_for(url).await?;
    let mut schemas = Vec::with_capacity(table_names.len());
    for table_name in table_names {
        let collection = client.database(database).collection::<Document>(table_name);
        let samples = sample_documents(&collection).await?;
        schemas.push(infer_table_meta(table_name, &samples));
    }
    Ok(schemas)
}

async fn sample_documents(collection: &Collection<Document>) -> Result<Vec<Document>, String> {
    let mut cursor = collection
        .find(doc! {})
        .limit(SCHEMA_SAMPLE_LIMIT)
        .await
        .map_err(|error| format!("抽样集合失败: {error}"))?;
    let mut documents = Vec::new();
    while cursor
        .advance()
        .await
        .map_err(|error| format!("读取抽样文档失败: {error}"))?
    {
        documents.push(
            cursor
                .deserialize_current()
                .map_err(|error| format!("解析抽样文档失败: {error}"))?,
        );
    }
    Ok(documents)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MongoFieldKind {
    ObjectId,
    String,
    Boolean,
    Int,
    Long,
    Double,
    Date,
    Json,
    Binary,
    Mixed,
}

impl MongoFieldKind {
    fn from_bson(value: &Bson) -> Option<Self> {
        Some(match value {
            Bson::Null | Bson::Undefined => return None,
            Bson::ObjectId(_) => Self::ObjectId,
            Bson::String(_) => Self::String,
            Bson::Boolean(_) => Self::Boolean,
            Bson::Int32(_) => Self::Int,
            Bson::Int64(_) => Self::Long,
            Bson::Double(_) => Self::Double,
            Bson::DateTime(_) => Self::Date,
            Bson::Document(_) | Bson::Array(_) => Self::Json,
            Bson::Binary(_) => Self::Binary,
            Bson::Decimal128(_) => Self::String,
            _ => Self::Mixed,
        })
    }

    fn merge(self, other: Self) -> Self {
        if self == other {
            self
        } else {
            Self::Mixed
        }
    }

    pub fn as_column_type(self) -> &'static str {
        match self {
            Self::ObjectId => "objectId",
            Self::String => "string",
            Self::Boolean => "bool",
            Self::Int => "int",
            Self::Long => "long",
            Self::Double => "double",
            Self::Date => "date",
            Self::Json => "json",
            Self::Binary => "binary",
            Self::Mixed => "mixed",
        }
    }

    fn from_column(column: &ColumnMeta) -> Self {
        match column
            .data_type
            .as_deref()
            .unwrap_or(&column.column_type)
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "objectid" => Self::ObjectId,
            "string" => Self::String,
            "bool" | "boolean" => Self::Boolean,
            "int" | "int32" => Self::Int,
            "long" | "int64" => Self::Long,
            "double" | "number" => Self::Double,
            "date" => Self::Date,
            "json" | "object" | "array" => Self::Json,
            "binary" => Self::Binary,
            _ => Self::Mixed,
        }
    }
}

pub fn infer_table_meta(table_name: &str, samples: &[Document]) -> TableMeta {
    let mut order = Vec::new();
    let mut seen = HashSet::new();
    let mut kinds: BTreeMap<String, MongoFieldKind> = BTreeMap::new();
    if seen.insert("_id".to_string()) {
        order.push("_id".to_string());
    }
    for document in samples {
        for (key, value) in document {
            if seen.insert(key.clone()) {
                order.push(key.clone());
            }
            if let Some(kind) = MongoFieldKind::from_bson(value) {
                kinds
                    .entry(key.clone())
                    .and_modify(|current| *current = current.merge(kind))
                    .or_insert(kind);
            }
        }
    }
    if !kinds.contains_key("_id") {
        kinds.insert("_id".into(), MongoFieldKind::ObjectId);
    }
    let columns = order
        .into_iter()
        .map(|name| {
            let kind = kinds.get(&name).copied().unwrap_or(MongoFieldKind::Mixed);
            let mut column = ColumnMeta::with_basic(
                name.clone(),
                kind.as_column_type(),
                "",
                name == "_id",
                name != "_id",
            );
            if name == "_id" {
                column.is_auto_increment = true;
            }
            column
        })
        .collect();
    TableMeta {
        primary_key_order: Vec::new(),
        table_name: table_name.into(),
        table_comment: String::new(),
        columns,
    }
}

pub fn bson_to_cell(value: Option<&Bson>) -> (String, bool) {
    match value {
        None | Some(Bson::Null) | Some(Bson::Undefined) => (String::new(), true),
        Some(Bson::String(value)) => (value.clone(), false),
        Some(Bson::Boolean(value)) => (value.to_string(), false),
        Some(Bson::Int32(value)) => (value.to_string(), false),
        Some(Bson::Int64(value)) => (value.to_string(), false),
        Some(Bson::Double(value)) => (format_double(*value), false),
        Some(Bson::ObjectId(value)) => (value.to_hex(), false),
        Some(Bson::DateTime(value)) => (
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string()),
            false,
        ),
        Some(Bson::Decimal128(value)) => (value.to_string(), false),
        Some(Bson::Binary(value)) => (base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &value.bytes), false),
        Some(Bson::Document(value)) => (bson_to_json_text(&Bson::Document(value.clone())), false),
        Some(Bson::Array(value)) => (bson_to_json_text(&Bson::Array(value.clone())), false),
        Some(other) => (other.to_string(), false),
    }
}

fn format_double(value: f64) -> String {
    if value.fract() == 0.0 && value.is_finite() && value.abs() < (i64::MAX as f64) {
        format!("{}", value as i64)
    } else {
        let text = value.to_string();
        if text == "-0" {
            "0".into()
        } else {
            text
        }
    }
}

fn bson_to_json_text(value: &Bson) -> String {
    serde_json::to_string(&bson_to_json_value(value)).unwrap_or_else(|_| value.to_string())
}

fn bson_to_json_value(value: &Bson) -> serde_json::Value {
    match value {
        Bson::Null | Bson::Undefined => serde_json::Value::Null,
        Bson::String(value) => serde_json::Value::String(value.clone()),
        Bson::Boolean(value) => serde_json::Value::Bool(*value),
        Bson::Int32(value) => serde_json::json!(*value),
        Bson::Int64(value) => serde_json::json!(*value),
        Bson::Double(value) => serde_json::json!(*value),
        Bson::ObjectId(value) => serde_json::json!({ "$oid": value.to_hex() }),
        Bson::DateTime(value) => serde_json::json!({
            "$date": value.try_to_rfc3339_string().unwrap_or_else(|_| value.to_string())
        }),
        Bson::Document(document) => {
            let mut map = serde_json::Map::new();
            for (key, item) in document {
                map.insert(key.clone(), bson_to_json_value(item));
            }
            serde_json::Value::Object(map)
        }
        Bson::Array(items) => serde_json::Value::Array(items.iter().map(bson_to_json_value).collect()),
        Bson::Binary(value) => serde_json::json!({
            "$binary": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &value.bytes)
        }),
        other => serde_json::Value::String(other.to_string()),
    }
}

pub fn parse_cell_to_bson(kind: MongoFieldKind, raw: Option<&str>) -> Result<Option<Bson>, String> {
    let Some(text) = raw else {
        return Ok(None);
    };
    if text.is_empty() && !matches!(kind, MongoFieldKind::String | MongoFieldKind::Json) {
        return Ok(None);
    }
    match kind {
        MongoFieldKind::ObjectId => ObjectId::parse_str(text)
            .map(|value| Some(Bson::ObjectId(value)))
            .map_err(|_| format!("无法将 {text} 解析为 ObjectId")),
        MongoFieldKind::String => Ok(Some(Bson::String(text.to_string()))),
        MongoFieldKind::Boolean => parse_bool(text).map(|value| Some(Bson::Boolean(value))),
        MongoFieldKind::Int => text
            .parse::<i32>()
            .map(|value| Some(Bson::Int32(value)))
            .map_err(|_| format!("无法将 {text} 解析为整数")),
        MongoFieldKind::Long => text
            .parse::<i64>()
            .map(|value| Some(Bson::Int64(value)))
            .map_err(|_| format!("无法将 {text} 解析为整数")),
        MongoFieldKind::Double => text
            .parse::<f64>()
            .map(|value| Some(Bson::Double(value)))
            .map_err(|_| format!("无法将 {text} 解析为数字")),
        MongoFieldKind::Date => DateTime::parse_rfc3339_str(text)
            .map(|value| Some(Bson::DateTime(value)))
            .map_err(|_| format!("无法将 {text} 解析为日期，请使用 ISO-8601")),
        MongoFieldKind::Json => parse_json_bson(text).map(Some),
        MongoFieldKind::Binary => {
            let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, text)
                .map_err(|_| format!("无法将 {text} 解析为 Base64"))?;
            Ok(Some(Bson::Binary(mongodb::bson::Binary {
                subtype: mongodb::bson::spec::BinarySubtype::Generic,
                bytes,
            })))
        }
        MongoFieldKind::Mixed => {
            if let Ok(value) = parse_json_bson(text) {
                Ok(Some(value))
            } else {
                Ok(Some(Bson::String(text.to_string())))
            }
        }
    }
}

fn parse_bool(text: &str) -> Result<bool, String> {
    match text.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" => Ok(true),
        "0" | "false" | "no" => Ok(false),
        _ => Err(format!("无法将 {text} 解析为布尔值")),
    }
}

fn parse_json_bson(text: &str) -> Result<Bson, String> {
    let json: serde_json::Value =
        serde_json::from_str(text).map_err(|error| format!("JSON 无效: {error}"))?;
    json_to_bson(&json)
}

fn json_to_bson(value: &serde_json::Value) -> Result<Bson, String> {
    match value {
        serde_json::Value::Null => Ok(Bson::Null),
        serde_json::Value::Bool(value) => Ok(Bson::Boolean(*value)),
        serde_json::Value::Number(value) => {
            if let Some(int) = value.as_i64() {
                if int >= i32::MIN as i64 && int <= i32::MAX as i64 {
                    Ok(Bson::Int32(int as i32))
                } else {
                    Ok(Bson::Int64(int))
                }
            } else if let Some(float) = value.as_f64() {
                Ok(Bson::Double(float))
            } else {
                Err("无法解析 JSON 数字".into())
            }
        }
        serde_json::Value::String(value) => Ok(Bson::String(value.clone())),
        serde_json::Value::Array(items) => Ok(Bson::Array(
            items
                .iter()
                .map(json_to_bson)
                .collect::<Result<Vec<_>, _>>()?,
        )),
        serde_json::Value::Object(map) => {
            if let Some(oid) = map.get("$oid").and_then(serde_json::Value::as_str) {
                return ObjectId::parse_str(oid)
                    .map(Bson::ObjectId)
                    .map_err(|_| format!("无法将 {oid} 解析为 ObjectId"));
            }
            if let Some(date) = map.get("$date").and_then(serde_json::Value::as_str) {
                return DateTime::parse_rfc3339_str(date)
                    .map(Bson::DateTime)
                    .map_err(|_| format!("无法将 {date} 解析为日期"));
            }
            let mut document = Document::new();
            for (key, item) in map {
                document.insert(key.clone(), json_to_bson(item)?);
            }
            Ok(Bson::Document(document))
        }
    }
}

pub fn identity_to_id(identity: &RowIdentity) -> Result<Bson, String> {
    let raw = identity
        .get("_id")
        .and_then(|value| value.as_deref())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少文档 _id".to_string())?;
    if let Ok(oid) = ObjectId::parse_str(raw) {
        Ok(Bson::ObjectId(oid))
    } else {
        Ok(Bson::String(raw.to_string()))
    }
}

fn document_to_row(table: &TableMeta, document: &Document) -> (HashMap<String, String>, Vec<String>) {
    let mut row = HashMap::new();
    let mut null_columns = Vec::new();
    for column in &table.columns {
        let (value, is_null) = bson_to_cell(document.get(&column.column_name));
        if is_null {
            null_columns.push(column.column_name.clone());
        }
        row.insert(column.column_name.clone(), value);
    }
    (row, null_columns)
}

fn build_filter(table: &TableMeta, request: &TablePageRequest) -> Document {
    let Some(filter) = request.filter.as_ref() else {
        return doc! {};
    };
    let query = filter.query.trim();
    if query.is_empty() {
        return doc! {};
    }
    let columns = if filter.columns.is_empty() {
        table
            .columns
            .iter()
            .map(|column| column.column_name.clone())
            .collect::<Vec<_>>()
    } else {
        filter.columns.clone()
    };
    let escaped = regex_escape(query);
    let mut clauses = Vec::new();
    for column in columns {
        if column.trim().is_empty() {
            continue;
        }
        clauses.push(doc! {
            &column: {
                "$regex": &escaped,
                "$options": "i"
            }
        });
    }
    if let Ok(oid) = ObjectId::parse_str(query) {
        clauses.push(doc! { "_id": oid });
    }
    if clauses.is_empty() {
        doc! {}
    } else {
        doc! { "$or": clauses }
    }
}

fn regex_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(
            ch,
            '.' | '^' | '$' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\'
        ) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn page_sort(table: &TableMeta, request: &TablePageRequest) -> Document {
    if let Some(sort) = request.sort.as_ref().filter(|sort| !sort.column_name.trim().is_empty())
    {
        if table
            .columns
            .iter()
            .any(|column| column.column_name.eq_ignore_ascii_case(sort.column_name.trim()))
        {
            let direction = if sort.descending { -1 } else { 1 };
            return doc! { sort.column_name.trim(): direction };
        }
    }
    doc! { "_id": 1 }
}

async fn read_page_inner(
    url: &str,
    database: &str,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
    perf: Option<(&PerformanceRecorder, &PerfContext)>,
) -> Result<TableSessionPage, String> {
    crate::config_relations::filter::ensure_engine_supports(request)?;
    let client = client_for(url).await?;
    let collection = client
        .database(database)
        .collection::<Document>(&table.table_name);
    let (page, page_size) = normalize_page_request(request);
    let offset = normalize_page_offset(request, page, page_size);
    let filter = build_filter(table, request);
    let sort = page_sort(table, request);
    let mut cursor = collection
        .find(filter)
        .sort(sort)
        .skip(offset)
        .limit(page_size as i64)
        .await
        .map_err(|error| format!("读取集合失败: {error}"))?;
    let conversion_span = perf.and_then(|(recorder, context)| {
        recorder.begin_span(
            "mongodb.row_convert",
            PerfPhase::Conversion,
            Some(context),
            || PerfEventDetails {
                stage: Some(PerfStage::Convert),
                column_count: Some(table.columns.len() as u64),
                ..PerfEventDetails::default()
            },
        )
    });
    let mut rows = Vec::new();
    let mut null_cells = Vec::new();
    while cursor
        .advance()
        .await
        .map_err(|error| format!("读取文档失败: {error}"))?
    {
        let document = cursor
            .deserialize_current()
            .map_err(|error| format!("解析文档失败: {error}"))?;
        let (row, null_columns) = document_to_row(table, &document);
        rows.push(row);
        null_cells.push(null_columns);
    }
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

pub async fn read_table_count_with_perf(
    url: &str,
    database: &str,
    table: &TableMeta,
    request: &TablePageRequest,
    _recorder: &PerformanceRecorder,
    _context: &PerfContext,
) -> Result<TableCountResult, String> {
    crate::config_relations::filter::ensure_engine_supports(request)?;
    let client = client_for(url).await?;
    let collection = client
        .database(database)
        .collection::<Document>(&table.table_name);
    let filter = build_filter(table, request);
    let total_rows = if filter.is_empty() {
        collection
            .estimated_document_count()
            .await
            .map_err(|error| format!("统计文档失败: {error}"))?
    } else {
        collection
            .count_documents(filter)
            .await
            .map_err(|error| format!("统计文档失败: {error}"))?
    };
    Ok(TableCountResult {
        total_rows,
        exact: !request
            .filter
            .as_ref()
            .map(|filter| filter.query.trim().is_empty())
            .unwrap_or(true)
            || true,
        estimated: request
            .filter
            .as_ref()
            .map(|filter| filter.query.trim().is_empty())
            .unwrap_or(true),
    })
}

pub async fn read_search_scan_page_with_perf(
    url: &str,
    database: &str,
    table: &TableMeta,
    offset: u64,
    limit: u32,
    sort: Option<&crate::types::TablePageSort>,
    recorder: &PerformanceRecorder,
    context: &PerfContext,
) -> Result<Vec<HashMap<String, String>>, String> {
    let request = TablePageRequest {
        page: None,
        page_size: Some(limit),
        offset: Some(offset),
        include_total: None,
        filter: None,
        sort: sort.cloned(),
    };
    let page = read_page_inner(
        url,
        database,
        table,
        "",
        &request,
        Some((recorder, context)),
    )
    .await?;
    Ok(page.rows)
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
    let client = client_for(url).await?;
    let collection = client
        .database(database)
        .collection::<Document>(&table.table_name);
    let escaped = regex_escape(query);
    let mut results = Vec::new();
    for column in &table.columns {
        if column.column_name.trim().is_empty() {
            continue;
        }
        let filter = doc! {
            &column.column_name: {
                "$regex": &escaped,
                "$options": "i"
            }
        };
        let mut cursor = collection
            .find(filter)
            .limit(1)
            .await
            .map_err(|error| format!("搜索集合失败: {error}"))?;
        if !cursor
            .advance()
            .await
            .map_err(|error| format!("搜索集合失败: {error}"))?
        {
            continue;
        }
        let document = cursor
            .deserialize_current()
            .map_err(|error| format!("解析搜索结果失败: {error}"))?;
        let (preview, _) = bson_to_cell(document.get(&column.column_name));
        results.push(SearchValueItem {
            table_name: table.table_name.clone(),
            table_comment: table.table_comment.clone(),
            column_name: column.column_name.clone(),
            preview_value: value_search_preview(&preview, query, 80),
            row_identity: document.get("_id").map(|value| {
                let (id, _) = bson_to_cell(Some(value));
                HashMap::from([("_id".into(), id)])
            }),
        });
    }
    Ok(results)
}

pub async fn update_cells(
    url: &str,
    database: &str,
    table: &TableMeta,
    rows: &[UpdateRowPatch],
) -> Result<UpdateCellsResult, String> {
    if rows.is_empty() {
        return Ok(UpdateCellsResult {
            updated: 0,
            conflict: false,
        });
    }
    let client = client_for(url).await?;
    let collection = client
        .database(database)
        .collection::<Document>(&table.table_name);
    let mut updated = 0u64;
    for row in rows {
        if row.changes.iter().any(|change| change.column_name == "_id") {
            return Err("不能修改 _id".into());
        }
        let id = identity_to_id(&row.row_identity)?;
        let (set_doc, unset_doc) = changes_to_update(table, &row.changes)?;
        if set_doc.is_empty() && unset_doc.is_empty() {
            continue;
        }
        let mut update = Document::new();
        if !set_doc.is_empty() {
            update.insert("$set", set_doc);
        }
        if !unset_doc.is_empty() {
            update.insert("$unset", unset_doc);
        }
        let result = collection
            .update_one(doc! { "_id": id }, update)
            .await
            .map_err(|error| format!("保存失败: {error}"))?;
        if result.matched_count != 1 {
            return Err("有行已变化或不存在，本次保存已取消".into());
        }
        updated += 1;
    }
    Ok(UpdateCellsResult {
        updated,
        conflict: false,
    })
}

fn changes_to_update(
    table: &TableMeta,
    changes: &[CellUpdateChange],
) -> Result<(Document, Document), String> {
    let mut set_doc = Document::new();
    let mut unset_doc = Document::new();
    for change in changes {
        if change.old_value == change.new_value {
            continue;
        }
        let column = table
            .columns
            .iter()
            .find(|column| column.column_name == change.column_name)
            .ok_or_else(|| format!("字段 {} 不存在，未执行保存", change.column_name))?;
        let kind = MongoFieldKind::from_column(column);
        match parse_cell_to_bson(kind, change.new_value.as_deref())? {
            Some(value) => {
                set_doc.insert(&change.column_name, value);
            }
            None => {
                unset_doc.insert(&change.column_name, "");
            }
        }
    }
    Ok((set_doc, unset_doc))
}

pub async fn insert_row(
    url: &str,
    database: &str,
    table: &TableMeta,
    draft: &HashMap<String, String>,
) -> Result<InsertRowResult, String> {
    let client = client_for(url).await?;
    let collection = client
        .database(database)
        .collection::<Document>(&table.table_name);
    let mut document = Document::new();
    for column in &table.columns {
        let raw = draft.get(&column.column_name).map(String::as_str);
        if column.column_name == "_id" && raw.unwrap_or("").is_empty() {
            continue;
        }
        if let Some(value) = parse_cell_to_bson(MongoFieldKind::from_column(column), raw)? {
            document.insert(&column.column_name, value);
        }
    }
    let result = collection
        .insert_one(document)
        .await
        .map_err(|error| format!("插入失败: {error}"))?;
    let inserted_id = result.inserted_id;
    let filter = doc! { "_id": inserted_id.clone() };
    let stored = collection
        .find_one(filter)
        .await
        .map_err(|error| format!("新增成功但读取最终文档失败: {error}"))?
        .ok_or_else(|| "新增成功但无法按 _id 读取该文档".to_string())?;
    let (row, null_columns) = document_to_row(table, &stored);
    let (id_text, _) = bson_to_cell(Some(&inserted_id));
    Ok(InsertRowResult {
        affected: 1,
        row: Some(row),
        row_identity: HashMap::from([("_id".into(), id_text)]),
        null_columns,
    })
}

pub async fn delete_rows(
    url: &str,
    database: &str,
    table_name: &str,
    identities: &[RowIdentity],
) -> Result<RowMutationResult, String> {
    if identities.is_empty() {
        return Ok(RowMutationResult { affected: 0 });
    }
    let client = client_for(url).await?;
    let collection = client.database(database).collection::<Document>(table_name);
    let mut ids = Vec::with_capacity(identities.len());
    let mut seen = HashSet::new();
    for identity in identities {
        let id = identity_to_id(identity)?;
        let key = id.to_string();
        if !seen.insert(key) {
            return Err("删除列表包含重复行，本次删除已取消".into());
        }
        ids.push(id);
    }
    let result = collection
        .delete_many(doc! { "_id": { "$in": ids } })
        .await
        .map_err(|error| format!("删除失败: {error}"))?;
    if result.deleted_count != identities.len() as u64 {
        return Err("有行已变化或不存在，本次删除已取消".into());
    }
    Ok(RowMutationResult {
        affected: result.deleted_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::doc;

    #[test]
    fn describe_url_reads_host_port_and_user() {
        let (host, port, user) =
            describe_url("mongodb://alice:secret@db.internal:27018").unwrap();
        assert_eq!(host, "db.internal");
        assert_eq!(port, 27018);
        assert_eq!(user, "alice");
    }

    #[test]
    fn describe_url_defaults_port_and_allows_empty_user() {
        let (host, port, user) = describe_url("mongodb://127.0.0.1").unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 27017);
        assert_eq!(user, "");
    }

    #[test]
    fn infer_schema_unions_top_level_fields_and_keeps_id_first() {
        let samples = vec![
            doc! { "_id": ObjectId::new(), "name": "hero", "stats": { "atk": 1 } },
            doc! { "_id": ObjectId::new(), "name": "mage", "level": 3 },
        ];
        let table = infer_table_meta("heroes", &samples);
        let names = table
            .columns
            .iter()
            .map(|column| column.column_name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names[0], "_id");
        assert!(names.contains(&"name"));
        assert!(names.contains(&"stats"));
        assert!(names.contains(&"level"));
        assert!(table.columns[0].is_primary_key);
        assert_eq!(table.columns[0].column_type, "objectId");
        let stats = table
            .columns
            .iter()
            .find(|column| column.column_name == "stats")
            .unwrap();
        assert_eq!(stats.column_type, "json");
    }

    #[test]
    fn empty_collection_schema_is_only_id() {
        let table = infer_table_meta("empty", &[]);
        assert_eq!(table.columns.len(), 1);
        assert_eq!(table.columns[0].column_name, "_id");
        assert!(table.columns[0].is_primary_key);
    }

    #[test]
    fn object_id_round_trips_as_hex() {
        let oid = ObjectId::parse_str("65f1c2d3e4f5060708090a0b").unwrap();
        let (text, is_null) = bson_to_cell(Some(&Bson::ObjectId(oid)));
        assert_eq!(text, "65f1c2d3e4f5060708090a0b");
        assert!(!is_null);
        let parsed = parse_cell_to_bson(MongoFieldKind::ObjectId, Some(&text))
            .unwrap()
            .unwrap();
        assert_eq!(parsed, Bson::ObjectId(oid));
    }

    #[test]
    fn json_cells_round_trip_objects() {
        let document = doc! { "atk": 12, "def": 4 };
        let (text, _) = bson_to_cell(Some(&Bson::Document(document.clone())));
        let parsed = parse_cell_to_bson(MongoFieldKind::Json, Some(&text))
            .unwrap()
            .unwrap();
        assert_eq!(parsed, Bson::Document(document));
    }

    #[test]
    fn identity_accepts_object_id_or_string() {
        let mut identity = HashMap::new();
        identity.insert(
            "_id".into(),
            Some("65f1c2d3e4f5060708090a0b".into()),
        );
        assert!(matches!(
            identity_to_id(&identity).unwrap(),
            Bson::ObjectId(_)
        ));
        identity.insert("_id".into(), Some("custom-key".into()));
        assert_eq!(
            identity_to_id(&identity).unwrap(),
            Bson::String("custom-key".into())
        );
    }

    #[test]
    fn boolean_and_number_parse_errors_are_explicit() {
        assert!(parse_cell_to_bson(MongoFieldKind::Boolean, Some("maybe")).is_err());
        assert!(parse_cell_to_bson(MongoFieldKind::Int, Some("1.5")).is_err());
    }
}
