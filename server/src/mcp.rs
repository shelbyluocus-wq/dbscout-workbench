//! The central server's authenticated, stateless MCP transport.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

use crate::{db, mcp_mysql};

const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Client {
    id: String,
    token: String,
    username: String,
    svn_username: String,
    connections: Vec<String>,
    #[serde(default)]
    can_write: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    clients: Vec<Client>,
    connections: Vec<mcp_mysql::Connection>,
}

fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|c| c.is_ascii_hexdigit())
}

fn tokens_match(configured: &str, supplied: &str) -> bool {
    configured
        .bytes()
        .zip(supplied.bytes())
        .fold(0u8, |different, (a, b)| different | (a ^ b))
        == 0
}

impl Config {
    async fn read(path: &Path) -> Result<Self, &'static str> {
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|_| "无法读取 MCP 配置")?;
        let config: Self = serde_json::from_slice(&bytes).map_err(|_| "MCP 配置格式错误")?;
        let mut connections = HashSet::new();
        for connection in &config.connections {
            if !connection.valid() || !connections.insert(&connection.id) {
                return Err("MCP 连接 ID 或连接参数无效");
            }
        }
        let mut ids = HashSet::new();
        let mut tokens = HashSet::new();
        for client in &config.clients {
            if client.id.trim().is_empty()
                || client.username.trim().is_empty()
                || client.svn_username.trim().is_empty()
                || !ids.insert(&client.id)
                || !valid_token(&client.token)
                || !tokens.insert(&client.token)
                || client
                    .connections
                    .iter()
                    .any(|id| !connections.contains(id))
            {
                return Err("MCP 客户端身份或连接授权无效");
            }
        }
        Ok(config)
    }
}

pub async fn client_headers(path: &str, id: &str) -> Result<Value, &'static str> {
    let config = Config::read(Path::new(path)).await?;
    let client = config
        .clients
        .iter()
        .find(|client| client.id == id)
        .ok_or("MCP 客户端未配置")?;
    Ok(json!({"Authorization": format!("Bearer {}", client.token)}))
}

#[derive(Clone)]
struct McpState {
    config_path: PathBuf,
    audit_pool: SqlitePool,
    max_revisions_per_table: usize,
}

pub fn router(
    config_path: PathBuf,
    audit_pool: SqlitePool,
    max_revisions_per_table: usize,
) -> Router {
    Router::new()
        .route("/mcp", post(handle))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(McpState {
            config_path,
            audit_pool,
            max_revisions_per_table,
        })
}

#[derive(Deserialize)]
struct Request {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

fn rpc_error(id: Value, code: i32, message: &str) -> Response {
    Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})).into_response()
}

async fn handle(
    State(state): State<McpState>,
    headers: HeaderMap,
    Json(request): Json<Request>,
) -> Response {
    if headers.contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| valid_token(v))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let config = match Config::read(&state.config_path).await {
        Ok(config) => config,
        Err(message) => return (StatusCode::SERVICE_UNAVAILABLE, message).into_response(),
    };
    let Some(client) = config
        .clients
        .iter()
        .find(|client| tokens_match(&client.token, token))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let user = match db::find_user_by_username(&state.audit_pool, &client.username).await {
        Ok(Some(user)) => user,
        Ok(None) => return (StatusCode::FORBIDDEN, "MCP 配置绑定的黑猫账号不存在").into_response(),
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    if request.jsonrpc != "2.0" {
        return rpc_error(
            request.id.unwrap_or(Value::Null),
            -32600,
            "无效的 JSON-RPC 版本",
        );
    }
    let Some(id) = request.id else {
        // Notifications cannot invoke a database operation.
        return StatusCode::ACCEPTED.into_response();
    };
    let result = match request.method.as_str() {
        "initialize" => {
            let version = request.params["protocolVersion"]
                .as_str()
                .filter(|version| PROTOCOL_VERSIONS.contains(version))
                .unwrap_or(PROTOCOL_VERSIONS[0]);
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "blackcat-server", "version": env!("CARGO_PKG_VERSION") },
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools": tools(&config, client)}),
        "tools/call" => {
            let Some(name) = request.params.get("name").and_then(Value::as_str) else {
                return rpc_error(id, -32602, "缺少工具名称");
            };
            let arguments = request
                .params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = tokio::time::timeout(
                Duration::from_secs(20),
                call_tool(&state, &config, client, &user, name, arguments),
            )
            .await
            .unwrap_or_else(|_| {
                Err("操作超时。若本次是写入，请用 requestId 核对审计和当前值。".into())
            });
            match result {
                Ok(data) => json!({"content":[{"type":"text","text":data.to_string()}]}),
                Err(message) => json!({"isError":true,"content":[{"type":"text","text":message}]}),
            }
        }
        _ => return rpc_error(id, -32601, "方法不存在"),
    };
    Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response()
}

fn tools(config: &Config, client: &Client) -> Vec<Value> {
    let string = json!({"type":"string", "minLength":1});
    let nullable = json!({"type":["string","null"]});
    let simple = json!({});
    let connection = json!({"connectionId": string});
    let table = json!({"connectionId":string,"table":string});
    let mut tools = vec![
        tool(
            "get_identity",
            "查看调用者对应的黑猫账号和 SVN 用户名。",
            &[],
            simple.clone(),
            true,
        ),
        tool(
            "list_connections",
            "列出本账号获准使用的服务端数据库连接。",
            &[],
            simple,
            true,
        ),
        tool(
            "list_operation_records",
            "查看当前黑猫账号的服务端 MCP 改动记录，包括 SVN 用户名和提交状态。",
            &[],
            json!({"limit":{"type":"integer","minimum":1,"maximum":100},"auditId":string}),
            true,
        ),
        tool(
            "list_tables",
            "列出连接中已授权的表。",
            &["connectionId"],
            connection,
            true,
        ),
        tool(
            "describe_table",
            "查看表字段、类型和主键。",
            &["connectionId", "table"],
            table,
            true,
        ),
        tool(
            "read_table_page",
            "分页读表。值以字符串或 null 返回，单个值最多 4096 字符。",
            &["connectionId", "table"],
            json!({"connectionId":string,"table":string,"offset":{"type":"integer","minimum":0,"maximum":1000000},
                "limit":{"type":"integer","minimum":1,"maximum":100}}),
            true,
        ),
    ];
    if config.connections.iter().any(|connection| {
        client.can_write && connection.writable && client.connections.contains(&connection.id)
    }) {
        tools.push(tool(
            "update_cell", "经用户确认后修改一行中的一个非主键字段。需完整主键、读到的旧值和本次请求 UUID。",
            &["connectionId","table","primaryKey","column","expectedValue","newValue","confirmed","requestId"],
            json!({"connectionId":string,"table":string,"primaryKey":{"type":"object","additionalProperties":{"type":"string"}},
                "column":string,"expectedValue":nullable,"newValue":nullable,"confirmed":{"type":"boolean"},
                "requestId":{"type":"string","format":"uuid"}}), false,
        ));
    }
    tools
}

fn tool(
    name: &str,
    description: &str,
    required: &[&str],
    properties: Value,
    read_only: bool,
) -> Value {
    json!({"name":name, "description":description, "inputSchema":{
        "type":"object","properties":properties,"required":required,"additionalProperties":false,
    }, "annotations":{"readOnlyHint":read_only,"destructiveHint":!read_only}})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    connection_id: String,
    table: Option<String>,
    offset: Option<u32>,
    limit: Option<u32>,
}

async fn call_tool(
    state: &McpState,
    config: &Config,
    client: &Client,
    user: &db::UserRow,
    name: &str,
    arguments: Value,
) -> Result<Value, String> {
    match name {
        "get_identity" => {
            return Ok(json!({
                "username":user.username,"displayName":user.display_name,"svnUsername":client.svn_username,
            }))
        }
        "list_connections" => {
            return Ok(json!({"connections": config.connections.iter()
            .filter(|connection| client.connections.contains(&connection.id))
            .map(|connection| json!({"connectionId":connection.id,"name":connection.name,
                "database":connection.database,"canWrite":connection.writable && client.can_write}))
            .collect::<Vec<_>>()}))
        }
        "list_operation_records" => {
            let limit = match arguments.get("limit") {
                Some(value) => value
                    .as_u64()
                    .filter(|limit| (1..=100).contains(limit))
                    .ok_or("limit 必须为 1–100")?,
                None => 20,
            };
            let audit_id = match arguments.get("auditId") {
                Some(value) => Some(value.as_str().ok_or("auditId 必须是字符串")?),
                None => None,
            };
            return list_operation_records(&state.audit_pool, &user.id, limit as i64, audit_id)
                .await;
        }
        _ => {}
    }
    let connection_id = arguments["connectionId"]
        .as_str()
        .ok_or("缺少 connectionId")?;
    let connection = config
        .connections
        .iter()
        .find(|connection| {
            connection.id == connection_id && client.connections.contains(&connection.id)
        })
        .ok_or("该连接未授权")?;
    if name == "update_cell" {
        if !client.can_write || !connection.writable {
            return Err("该连接未授权写入".into());
        }
        let edit = serde_json::from_value(arguments).map_err(|_| "改单元格参数格式错误")?;
        let audit = mcp_mysql::AuditContext {
            pool: &state.audit_pool,
            user,
            svn_username: &client.svn_username,
            max_revisions_per_table: state.max_revisions_per_table,
        };
        return mcp_mysql::update_cell(connection, edit, audit).await;
    }
    let target: Target = serde_json::from_value(arguments).map_err(|_| "查询参数格式错误")?;
    debug_assert_eq!(target.connection_id, connection.id);
    match name {
        "list_tables" => mcp_mysql::list_tables(connection).await,
        "describe_table" => {
            mcp_mysql::describe_table(connection, target.table.as_deref().ok_or("缺少表名")?).await
        }
        "read_table_page" => {
            mcp_mysql::read_table_page(
                connection,
                target.table.as_deref().ok_or("缺少表名")?,
                target.offset.unwrap_or(0),
                target.limit.unwrap_or(20),
            )
            .await
        }
        _ => Err("未知的 Blackcat MCP 工具".into()),
    }
}

async fn list_operation_records(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
    audit_id: Option<&str>,
) -> Result<Value, String> {
    let rows = sqlx::query(
        "SELECT client_id, ts, username, svn_username, connection_id, database, table_name, \
                row_identity, column_name, old_value, new_value, status \
         FROM audit_log WHERE user_id = ? AND client_id LIKE 'mcp:%' \
         AND (? IS NULL OR client_id = ?) \
         ORDER BY ts DESC, rowid DESC LIMIT ?",
    )
    .bind(user_id)
    .bind(audit_id)
    .bind(audit_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|_| "读取 MCP 操作记录失败")?;
    let records: Vec<_> = rows
        .iter()
        .map(|row| {
            let row_identity = row
                .get::<Option<String>, _>("row_identity")
                .and_then(|identity| serde_json::from_str::<Value>(&identity).ok());
            json!({
                "auditId": row.get::<String, _>("client_id"),
                "timestamp": row.get::<String, _>("ts"),
                "username": row.get::<String, _>("username"),
                "svnUsername": row.get::<Option<String>, _>("svn_username"),
                "connectionId": row.get::<String, _>("connection_id"),
                "database": row.get::<String, _>("database"),
                "table": row.get::<String, _>("table_name"),
                "primaryKey": row_identity,
                "column": row.get::<Option<String>, _>("column_name"),
                "oldValue": row.get::<Option<String>, _>("old_value"),
                "newValue": row.get::<Option<String>, _>("new_value"),
                "status": row.get::<String, _>("status"),
            })
        })
        .collect();
    Ok(json!({"records": records}))
}
