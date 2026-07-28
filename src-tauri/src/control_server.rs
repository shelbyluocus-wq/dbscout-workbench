//! Local control endpoint for the external MCP server (`mcp-server.mjs`).
//!
//! Listens on a random loopback TCP port speaking JSON-lines (same style as
//! the agent sidecar stdio protocol). Every connection must authenticate with
//! the per-launch random token before any request is served. The endpoint
//! address + token are published through a discovery file at
//! `<app_data_dir>/control-endpoint.json` so the MCP server can find the
//! running app.
//!
//! Security model: read-only DB tools + UI navigation only. The whitelists in
//! this module are the final gate — write tool names are rejected here even if
//! the MCP layer is tampered with. `run_read_query` flows through the existing
//! `agent::sql_guard` read-only validation inside `db_bridge`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex, RwLock};
use tokio::time::timeout;

use crate::agent::AgentContext;
use crate::types::AppState;
use crate::window_reveal;

/// Window event consumed by the frontend (mirrors the sidecar
/// `workbench_action` payload contract handled in useAgent.js).
pub const CONTROL_WORKBENCH_ACTION_EVENT: &str = "control-workbench-action";

const DISCOVERY_FILE_NAME: &str = "control-endpoint.json";
const CONFIG_FILE_NAME: &str = "control-config.json";
const CONTROL_PROTOCOL_VERSION: u32 = 1;
const UI_ACTION_TIMEOUT: Duration = Duration::from_secs(30);
const FRONTEND_READY_TIMEOUT: Duration = Duration::from_secs(45);
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_IMPORT_ROWS: usize = 50_000;

/// Read-only DB tools the endpoint is allowed to forward to `db_bridge`.
/// `run_write_query` and any unknown name are rejected.
const READ_ONLY_DB_TOOLS: &[&str] = &[
    "get_database_profile",
    "refresh_database_profile",
    "search_database_profile",
    "find_related_tables",
    "list_databases",
    "list_tables",
    "describe_table",
    "sample_rows",
    "read_table_page",
    "search_schema",
    "search_values",
    "run_read_query",
];

/// UI actions forwarded to the frontend as `control-workbench-action` events.
const UI_ACTIONS: &[&str] = &[
    "open_table",
    "focus_column",
    "focus_row",
    "focus_cell",
    "reveal_window",
    "refresh_table",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EndpointInfo {
    port: u16,
    token: String,
    pid: u32,
    version: String,
    protocol_version: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpStatus {
    enabled: bool,
    running: bool,
    connected_clients: usize,
    protocol_version: u32,
    endpoint_file: String,
    node_path: String,
    server_path: String,
    app_path: String,
    install_command: String,
    codex_install_command: String,
}

pub struct ControlServerState {
    enabled: AtomicBool,
    ui_ready: AtomicBool,
    active_clients: AtomicUsize,
    endpoint: RwLock<Option<EndpointInfo>>,
    ui_context: RwLock<Value>,
    queued_ui_actions: Mutex<Vec<Value>>,
    pending_ui_actions: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

impl Default for ControlServerState {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(true),
            ui_ready: AtomicBool::new(false),
            active_clients: AtomicUsize::new(0),
            endpoint: RwLock::new(None),
            ui_context: RwLock::new(serde_json::json!({})),
            queued_ui_actions: Mutex::new(Vec::new()),
            pending_ui_actions: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum ControlRequest {
    Hello {
        token: String,
    },
    DbTool {
        id: String,
        func: String,
        #[serde(default)]
        args: Value,
    },
    UiAction {
        id: String,
        action: String,
        #[serde(default)]
        args: Value,
    },
    GetContext {
        id: String,
    },
    ExportTable {
        id: String,
        #[serde(default)]
        args: Value,
    },
    ImportTable {
        id: String,
        #[serde(default)]
        args: Value,
    },
}

fn parse_control_request(line: &str) -> Result<ControlRequest, String> {
    serde_json::from_str::<ControlRequest>(line)
        .map_err(|error| format!("invalid control request: {error}"))
}

fn is_allowed_db_tool(func: &str) -> bool {
    READ_ONLY_DB_TOOLS.contains(&func)
}

fn is_allowed_ui_action(action: &str) -> bool {
    UI_ACTIONS.contains(&action)
}

fn arg_str(args: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = args.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

/// Build the `control-workbench-action` event payload. Shape matches the
/// sidecar `workbench_action` payload that `normalizeWorkbenchAction` in
/// useAgent.js accepts; the frontend performs the final validation.
fn build_ui_action_payload(
    action: &str,
    args: &Value,
    fallback_connection_id: &str,
    fallback_database: &str,
) -> Result<Value, String> {
    if !is_allowed_ui_action(action) {
        return Err(format!("unsupported ui action: {action}"));
    }
    let table_name = arg_str(args, &["tableName", "table"]);
    if action != "reveal_window" && table_name.is_empty() {
        return Err("missing or invalid argument: tableName/table".to_string());
    }
    let mut connection_id = arg_str(args, &["connectionId", "connection_id"]);
    if connection_id.is_empty() {
        connection_id = fallback_connection_id.to_string();
    }
    let mut database = arg_str(args, &["database"]);
    if database.is_empty() {
        database = fallback_database.to_string();
    }
    let mut payload = serde_json::json!({
        "requestId": format!("control-{}", uuid::Uuid::new_v4().simple()),
        "action": action,
        "connectionId": connection_id,
        "database": database,
        "tableName": table_name,
        "tableComment": arg_str(args, &["tableComment", "table_comment"]),
    });
    if action == "focus_column" || action == "focus_cell" {
        let column_name = arg_str(args, &["columnName", "column"]);
        if column_name.is_empty() {
            return Err("missing or invalid argument: columnName/column".to_string());
        }
        payload["columnName"] = Value::String(column_name);
    }
    if action == "focus_row" || action == "focus_cell" {
        let row_key = arg_str(args, &["rowKey", "row_key"]);
        let row_identity = args
            .get("rowIdentity")
            .or_else(|| args.get("row_identity"))
            .filter(|value| value.is_object())
            .cloned();
        if row_key.is_empty() && row_identity.is_none() {
            return Err("missing or invalid argument: rowKey/rowIdentity".to_string());
        }
        payload["rowKey"] = Value::String(row_key);
        if let Some(identity) = row_identity {
            payload["rowIdentity"] = identity;
        }
    }
    Ok(payload)
}

fn discovery_payload(port: u16, token: &str, pid: u32, version: &str) -> Value {
    serde_json::json!({
        "port": port,
        "token": token,
        "pid": pid,
        "version": version,
        "protocolVersion": CONTROL_PROTOCOL_VERSION,
    })
}

fn response_ok(id: &str, data: Value) -> Value {
    serde_json::json!({ "id": id, "ok": true, "data": data })
}

fn response_err(id: &str, error: &str) -> Value {
    serde_json::json!({ "id": id, "ok": false, "error": error })
}

fn request_id(request: &ControlRequest) -> &str {
    match request {
        ControlRequest::DbTool { id, .. }
        | ControlRequest::UiAction { id, .. }
        | ControlRequest::GetContext { id }
        | ControlRequest::ExportTable { id, .. }
        | ControlRequest::ImportTable { id, .. } => id.as_str(),
        ControlRequest::Hello { .. } => "",
    }
}

fn request_needs_frontend_ready(request: &ControlRequest) -> bool {
    !matches!(request, ControlRequest::Hello { .. })
        && !matches!(
            request,
            ControlRequest::UiAction { action, .. } if action == "reveal_window"
        )
}

async fn wait_for_frontend_ready(app: &AppHandle) -> Result<(), String> {
    timeout(FRONTEND_READY_TIMEOUT, async {
        while !app
            .state::<ControlServerState>()
            .ui_ready
            .load(Ordering::Acquire)
        {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| "黑猫后台已启动，但数据库连接恢复超时，请打开黑猫检查连接状态".to_string())
}

/// Spawn the control endpoint. Failures are logged and never abort startup:
/// the endpoint only powers the optional external MCP integration.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let enabled = load_enabled(&app).unwrap_or(true);
        app.state::<ControlServerState>()
            .enabled
            .store(enabled, Ordering::Release);
        if let Err(error) = run(app).await {
            eprintln!(
                "[dbscout] 本地控制端点启动失败(外部 MCP 集成本次不可用,其余功能不受影响): {error}"
            );
        }
    });
}

async fn run(app: AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("绑定回环端口失败: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取监听地址失败: {error}"))?
        .port();
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let endpoint = EndpointInfo {
        port,
        token: token.clone(),
        pid: std::process::id(),
        version: app.package_info().version.to_string(),
        protocol_version: CONTROL_PROTOCOL_VERSION,
    };
    *app.state::<ControlServerState>().endpoint.write().await = Some(endpoint);
    write_discovery_file(&app, port, &token)?;

    loop {
        let (stream, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                eprintln!("[dbscout] 控制端点 accept 失败: {error}");
                continue;
            }
        };
        let app = app.clone();
        let token = token.clone();
        tauri::async_runtime::spawn(async move {
            handle_connection(app, stream, token).await;
        });
    }
}

fn write_discovery_file(app: &AppHandle, port: u16, token: &str) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建应用数据目录失败: {error}"))?;
    let payload = discovery_payload(
        port,
        token,
        std::process::id(),
        &app.package_info().version.to_string(),
    );
    let body = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("序列化控制端点信息失败: {error}"))?;
    let path = dir.join(DISCOVERY_FILE_NAME);
    let temp = dir.join(format!("{DISCOVERY_FILE_NAME}.tmp"));
    write_private_file(&temp, body.as_bytes())?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|error| format!("替换控制端点发现文件失败: {error}"))?;
    }
    std::fs::rename(&temp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("写入控制端点发现文件失败: {error}")
    })
}

fn app_data_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(name))
        .map_err(|error| format!("无法获取应用数据目录: {error}"))
}

fn write_private_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| format!("创建本地控制文件失败: {error}"))?;
        std::io::Write::write_all(&mut file, bytes)
            .map_err(|error| format!("写入本地控制文件失败: {error}"))?;
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes).map_err(|error| format!("写入本地控制文件失败: {error}"))
    }
}

fn load_enabled(app: &AppHandle) -> Result<bool, String> {
    let path = app_data_file(app, CONFIG_FILE_NAME)?;
    if !path.exists() {
        return Ok(true);
    }
    let body =
        std::fs::read_to_string(path).map_err(|error| format!("读取外部 MCP 配置失败: {error}"))?;
    let value: Value =
        serde_json::from_str(&body).map_err(|error| format!("解析外部 MCP 配置失败: {error}"))?;
    Ok(value
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true))
}

fn save_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let path = app_data_file(app, CONFIG_FILE_NAME)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建外部 MCP 配置目录失败: {error}"))?;
    }
    write_private_file(
        &path,
        serde_json::json!({ "enabled": enabled })
            .to_string()
            .as_bytes(),
    )
}

pub fn cleanup_discovery_file(app: &AppHandle) {
    if let Ok(path) = app_data_file(app, DISCOVERY_FILE_NAME) {
        let _ = std::fs::remove_file(path);
    }
}

async fn handle_connection(app: AppHandle, stream: tokio::net::TcpStream, token: String) {
    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();

    // The first line must be a valid hello carrying the launch token;
    // anything else drops the connection without a response body.
    let authenticated = match timeout(HELLO_TIMEOUT, lines.next_line()).await {
        Ok(Ok(Some(line))) => matches!(
            parse_control_request(&line),
            Ok(ControlRequest::Hello { token: presented }) if presented == token
        ),
        _ => false,
    };
    if !authenticated {
        let _ = write_half
            .write_all(b"{\"ok\":false,\"error\":\"unauthorized\"}\n")
            .await;
        return;
    }
    let hello = serde_json::json!({
        "ok": true,
        "app": "blackcat",
        "version": app.package_info().version.to_string(),
        "protocolVersion": CONTROL_PROTOCOL_VERSION,
        "enabled": app.state::<ControlServerState>().enabled.load(Ordering::Acquire),
    });
    if write_line(&mut write_half, &hello).await.is_err() {
        return;
    }

    app.state::<ControlServerState>()
        .active_clients
        .fetch_add(1, Ordering::AcqRel);
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let response = match parse_control_request(&line) {
            Ok(request) => dispatch(&app, request).await,
            Err(error) => response_err("", &error),
        };
        if write_line(&mut write_half, &response).await.is_err() {
            break;
        }
    }
    app.state::<ControlServerState>()
        .active_clients
        .fetch_sub(1, Ordering::AcqRel);
}

async fn write_line(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    payload: &Value,
) -> Result<(), ()> {
    let mut line = payload.to_string();
    line.push('\n');
    writer.write_all(line.as_bytes()).await.map_err(|_| ())
}

async fn dispatch(app: &AppHandle, request: ControlRequest) -> Value {
    if !app
        .state::<ControlServerState>()
        .enabled
        .load(Ordering::Acquire)
    {
        return response_err(
            request_id(&request),
            "外部 MCP 已关闭，请在黑猫 AI 设置中开启",
        );
    }
    if request_needs_frontend_ready(&request) {
        if let Err(error) = wait_for_frontend_ready(app).await {
            return response_err(request_id(&request), &error);
        }
    }
    match request {
        // A repeated hello after authentication is harmless; acknowledge it.
        ControlRequest::Hello { .. } => serde_json::json!({ "ok": true }),
        ControlRequest::DbTool { id, func, args } => {
            if !is_allowed_db_tool(&func) {
                return response_err(&id, &format!("拒绝执行:{func} 不在只读白名单内"));
            }
            match run_db_tool(app, &func, args).await {
                Ok(data) => response_ok(&id, data),
                Err(error) => response_err(&id, &error),
            }
        }
        ControlRequest::UiAction { id, action, args } => {
            match run_ui_action(app, &action, args).await {
                Ok(data) => response_ok(&id, data),
                Err(error) => response_err(&id, &error),
            }
        }
        ControlRequest::GetContext { id } => match current_context(app).await {
            Ok(data) => response_ok(&id, data),
            Err(error) => response_err(&id, &error),
        },
        ControlRequest::ExportTable { id, args } => match export_table_xlsx(app, args).await {
            Ok(data) => response_ok(&id, data),
            Err(error) => response_err(&id, &error),
        },
        ControlRequest::ImportTable { id, args } => match import_table_xlsx(app, args).await {
            Ok(data) => response_ok(&id, data),
            Err(error) => response_err(&id, &error),
        },
    }
}

async fn selected_runtime_context(app: &AppHandle) -> (String, String) {
    let state = app.state::<AppState>();
    let rt = state.runtime.lock().await;
    (
        rt.selected_connection_id.clone(),
        rt.selected_database.clone(),
    )
}

async fn run_db_tool(app: &AppHandle, func: &str, args: Value) -> Result<Value, String> {
    let (selected_connection_id, selected_database) = selected_runtime_context(app).await;
    let connection_id = {
        let explicit = arg_str(&args, &["connectionId", "connection_id"]);
        if explicit.is_empty() {
            selected_connection_id
        } else {
            explicit
        }
    };
    let database = {
        let explicit = arg_str(&args, &["database"]);
        if explicit.is_empty() {
            selected_database
        } else {
            explicit
        }
    };
    let context = AgentContext {
        connection_id: Some(connection_id),
        database: Some(database),
        ..Default::default()
    };
    let state = app.state::<AppState>();
    crate::agent::db_bridge::handle_db_request(state, app.clone(), &context, func, args).await
}

async fn run_ui_action(app: &AppHandle, action: &str, args: Value) -> Result<Value, String> {
    let (selected_connection_id, selected_database) = selected_runtime_context(app).await;
    if action == "reveal_window" {
        window_reveal::reveal_main_window(app);
        return Ok(serde_json::json!({ "action": action, "status": "done" }));
    }
    let payload =
        build_ui_action_payload(action, &args, &selected_connection_id, &selected_database)?;
    let request_id = payload
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // Surface the window first so the user sees the tab open.
    window_reveal::reveal_main_window(app);
    let (sender, receiver) = oneshot::channel();
    let control = app.state::<ControlServerState>();
    control
        .pending_ui_actions
        .lock()
        .await
        .insert(request_id.clone(), sender);

    if control.ui_ready.load(Ordering::Acquire) {
        if let Err(error) = app.emit(CONTROL_WORKBENCH_ACTION_EVENT, payload.clone()) {
            control.pending_ui_actions.lock().await.remove(&request_id);
            return Err(format!("发送界面动作事件失败: {error}"));
        }
    } else {
        control.queued_ui_actions.lock().await.push(payload);
    }

    match timeout(UI_ACTION_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("界面动作结果通道已关闭".to_string()),
        Err(_) => {
            control.pending_ui_actions.lock().await.remove(&request_id);
            control.queued_ui_actions.lock().await.retain(|queued| {
                queued.get("requestId").and_then(Value::as_str) != Some(request_id.as_str())
            });
            Err(format!("界面动作超时: {action}"))
        }
    }
}

async fn current_context(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let rt = state.runtime.lock().await;
    let connection = rt.connections.get(&rt.selected_connection_id);
    let mut context = serde_json::json!({
        "connectionId": rt.selected_connection_id,
        "connectionLabel": connection.map(|item| item.label.clone()).unwrap_or_default(),
        "databaseKind": connection
            .map(|item| serde_json::to_value(item.kind).unwrap_or(Value::Null))
            .unwrap_or(Value::Null),
        "database": rt.selected_database,
        "tableCount": rt.schema.len(),
    });
    drop(rt);
    if let Some(target) = context.as_object_mut() {
        if let Some(ui) = app
            .state::<ControlServerState>()
            .ui_context
            .read()
            .await
            .as_object()
        {
            for (key, value) in ui {
                if !value.is_null() && value.as_str().map(str::is_empty) != Some(true) {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        target.insert(
            "externalMcpEnabled".to_string(),
            Value::Bool(
                app.state::<ControlServerState>()
                    .enabled
                    .load(Ordering::Acquire),
            ),
        );
    }
    Ok(context)
}

fn page_request(page: u32) -> crate::types::TablePageRequest {
    crate::types::TablePageRequest {
        page: Some(page),
        page_size: Some(10_000),
        offset: None,
        include_total: Some(false),
        filter: None,
        sort: None,
    }
}

fn append_xlsx_rows(
    target: &mut Vec<crate::table_xlsx::XlsxRow>,
    page: &crate::types::TableSessionPage,
    columns: &[String],
) {
    for (index, row) in page.rows.iter().enumerate() {
        let nulls = page.null_cells.get(index);
        target.push(
            columns
                .iter()
                .map(|column| {
                    let is_null = nulls
                        .map(|names| names.iter().any(|name| name == column))
                        .unwrap_or(false);
                    (
                        column.clone(),
                        if is_null {
                            None
                        } else {
                            row.get(column).cloned()
                        },
                    )
                })
                .collect(),
        );
    }
}

async fn read_table_for_xlsx(
    app: &AppHandle,
    connection_id: String,
    database: String,
    table_name: String,
) -> Result<(Vec<String>, Vec<crate::table_xlsx::XlsxRow>), String> {
    let first = crate::commands::open_table_session(
        Some(connection_id),
        Some(database),
        table_name,
        Some(page_request(1)),
        crate::perf::PerfContext::default(),
        app.state::<AppState>(),
    )
    .await?
    .into_inner();
    let session_id = first.session_id.clone();
    let columns = first
        .columns
        .iter()
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    let mut rows = Vec::new();
    append_xlsx_rows(&mut rows, &first, &columns);
    let mut page = first.page;
    let mut has_more = first.has_more;
    let result = async {
        while has_more {
            page += 1;
            let next = crate::commands::fetch_table_page(
                session_id.clone(),
                Some(page_request(page)),
                crate::perf::PerfContext::default(),
                app.state::<AppState>(),
            )
            .await?
            .into_inner();
            if next.rows.is_empty() {
                break;
            }
            has_more = next.has_more;
            append_xlsx_rows(&mut rows, &next, &columns);
        }
        Ok::<_, String>((columns, rows))
    }
    .await;
    let _ = crate::commands::close_table_session(session_id, app.state::<AppState>()).await;
    result
}

async fn export_table_xlsx(app: &AppHandle, args: Value) -> Result<Value, String> {
    let (selected_connection_id, selected_database) = selected_runtime_context(app).await;
    let connection_id = {
        let explicit = arg_str(&args, &["connectionId", "connection_id"]);
        if explicit.is_empty() {
            selected_connection_id
        } else {
            explicit
        }
    };
    let database = {
        let explicit = arg_str(&args, &["database"]);
        if explicit.is_empty() {
            selected_database
        } else {
            explicit
        }
    };
    let table_name = arg_str(&args, &["table", "tableName"]);
    if connection_id.is_empty() || database.is_empty() || table_name.is_empty() {
        return Err("导出需要有效的 connectionId、database 和 table".to_string());
    }
    let (columns, rows) =
        read_table_for_xlsx(app, connection_id, database.clone(), table_name.clone()).await?;
    let row_count = rows.len();
    let column_count = columns.len();
    let path = crate::table_xlsx::write_agent_export_async(
        database.clone(),
        table_name.clone(),
        columns,
        rows,
    )
    .await?;
    Ok(serde_json::json!({
        "filePath": path,
        "database": database,
        "tableName": table_name,
        "rowCount": row_count,
        "columnCount": column_count,
    }))
}

async fn import_table_xlsx(app: &AppHandle, args: Value) -> Result<Value, String> {
    if args.get("confirmReplace").and_then(Value::as_bool) != Some(true) {
        return Err("导入是整表覆盖操作，必须显式传入 confirmReplace=true".to_string());
    }
    let rows_value = args
        .get("rows")
        .cloned()
        .ok_or_else(|| "导入数据缺少 rows".to_string())?;
    let rows = serde_json::from_value::<Vec<HashMap<String, String>>>(rows_value)
        .map_err(|error| format!("导入 rows 格式无效: {error}"))?;
    if rows.len() > MAX_IMPORT_ROWS {
        return Err(format!(
            "外部 MCP 单次最多导入 {MAX_IMPORT_ROWS} 行，请拆分文件或使用黑猫批量导入"
        ));
    }
    let mapped_columns = args
        .get("mappedColumns")
        .or_else(|| args.get("mapped_columns"))
        .cloned()
        .map(serde_json::from_value::<Vec<String>>)
        .transpose()
        .map_err(|error| format!("mappedColumns 格式无效: {error}"))?
        .unwrap_or_default();

    let (selected_connection_id, selected_database) = selected_runtime_context(app).await;
    let connection_id = {
        let explicit = arg_str(&args, &["connectionId", "connection_id"]);
        if explicit.is_empty() {
            selected_connection_id
        } else {
            explicit
        }
    };
    let database = {
        let explicit = arg_str(&args, &["database"]);
        if explicit.is_empty() {
            selected_database
        } else {
            explicit
        }
    };
    let table_name = arg_str(&args, &["table", "tableName"]);
    if connection_id.is_empty() || database.is_empty() || table_name.is_empty() {
        return Err("导入需要有效的 connectionId、database 和 table".to_string());
    }

    let opened = crate::commands::open_table_session(
        Some(connection_id.clone()),
        Some(database.clone()),
        table_name.clone(),
        Some(page_request(1)),
        crate::perf::PerfContext::default(),
        app.state::<AppState>(),
    )
    .await?
    .into_inner();
    let session_id = opened.session_id.clone();
    let import_result = crate::commands::replace_table_rows(
        crate::types::ReplaceTableRowsRequest {
            session_id: session_id.clone(),
            rows,
            mapped_columns,
            require_xlsx_backup: true,
        },
        crate::perf::PerfContext::default(),
        app.clone(),
        app.state::<AppState>(),
    )
    .await;
    let _ = crate::commands::close_table_session(session_id, app.state::<AppState>()).await;
    let result = import_result?;
    let mut value =
        serde_json::to_value(&result).map_err(|error| format!("序列化导入结果失败: {error}"))?;
    if let Some(object) = value.as_object_mut() {
        object.insert("database".to_string(), Value::String(database.clone()));
        object.insert("tableName".to_string(), Value::String(table_name.clone()));
        object.insert(
            "sourcePath".to_string(),
            Value::String(arg_str(&args, &["sourcePath", "source_path"])),
        );
    }

    if app
        .state::<ControlServerState>()
        .ui_ready
        .load(Ordering::Acquire)
    {
        let refresh = run_ui_action(
            app,
            "refresh_table",
            serde_json::json!({
                "connectionId": connection_id,
                "database": database,
                "tableName": table_name,
            }),
        )
        .await;
        if let Some(object) = value.as_object_mut() {
            object.insert("uiRefresh".to_string(), Value::Bool(refresh.is_ok()));
        }
    }
    Ok(value)
}

fn quote_cli_arg(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn resolve_mcp_paths(app: &AppHandle) -> (String, String) {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let node_names: &[&str] = if cfg!(target_os = "windows") {
            &["node.exe", "node"]
        } else {
            &["node", "node.exe"]
        };
        let node = node_names
            .iter()
            .map(|name| resource_dir.join("node").join(name))
            .find(|path| path.exists())
            .unwrap_or_else(|| PathBuf::from("node"));
        let server = resource_dir.join("mcp-server.mjs");
        if server.exists() {
            return (
                node.to_string_lossy().to_string(),
                server.to_string_lossy().to_string(),
            );
        }
    }
    (
        "node".to_string(),
        std::env::current_dir()
            .unwrap_or_default()
            .join("sidecar")
            .join("mcp-server.mjs")
            .to_string_lossy()
            .to_string(),
    )
}

async fn external_mcp_status(
    app: &AppHandle,
    state: &ControlServerState,
) -> Result<ExternalMcpStatus, String> {
    let (node_path, server_path) = resolve_mcp_paths(app);
    let app_path = std::env::current_exe()
        .map_err(|error| format!("无法获取黑猫程序路径: {error}"))?
        .to_string_lossy()
        .to_string();
    let install_command = format!(
        "claude mcp add --transport stdio --scope user blackcat -- {} {} --app-executable {}",
        quote_cli_arg(&node_path),
        quote_cli_arg(&server_path),
        quote_cli_arg(&app_path),
    );
    let codex_install_command = format!(
        "codex mcp add blackcat -- {} {} --app-executable {}",
        quote_cli_arg(&node_path),
        quote_cli_arg(&server_path),
        quote_cli_arg(&app_path),
    );
    Ok(ExternalMcpStatus {
        enabled: state.enabled.load(Ordering::Acquire),
        running: state.endpoint.read().await.is_some(),
        connected_clients: state.active_clients.load(Ordering::Acquire),
        protocol_version: CONTROL_PROTOCOL_VERSION,
        endpoint_file: app_data_file(app, DISCOVERY_FILE_NAME)?
            .to_string_lossy()
            .to_string(),
        node_path,
        server_path,
        app_path,
        install_command,
        codex_install_command,
    })
}

#[tauri::command]
pub async fn get_external_mcp_status(
    app: AppHandle,
    state: State<'_, ControlServerState>,
) -> Result<ExternalMcpStatus, String> {
    external_mcp_status(&app, &state).await
}

#[tauri::command]
pub async fn set_external_mcp_enabled(
    enabled: bool,
    app: AppHandle,
    state: State<'_, ControlServerState>,
) -> Result<ExternalMcpStatus, String> {
    save_enabled(&app, enabled)?;
    state.enabled.store(enabled, Ordering::Release);
    if !enabled {
        state.queued_ui_actions.lock().await.clear();
        let pending = std::mem::take(&mut *state.pending_ui_actions.lock().await);
        for (_, sender) in pending {
            let _ = sender.send(Err("外部 MCP 已关闭".to_string()));
        }
    }
    external_mcp_status(&app, &state).await
}

#[tauri::command]
pub async fn control_frontend_ready(
    state: State<'_, ControlServerState>,
) -> Result<Vec<Value>, String> {
    state.ui_ready.store(true, Ordering::Release);
    Ok(std::mem::take(&mut *state.queued_ui_actions.lock().await))
}

#[tauri::command]
pub async fn control_frontend_unready(state: State<'_, ControlServerState>) -> Result<(), String> {
    state.ui_ready.store(false, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub async fn control_update_context(
    context: Value,
    state: State<'_, ControlServerState>,
) -> Result<(), String> {
    if !context.is_object() {
        return Err("界面上下文必须是对象".to_string());
    }
    *state.ui_context.write().await = context;
    Ok(())
}

#[tauri::command]
pub async fn control_complete_ui_action(
    request_id: String,
    ok: bool,
    message: Option<String>,
    context: Option<Value>,
    state: State<'_, ControlServerState>,
) -> Result<(), String> {
    if let Some(context) = context.clone().filter(Value::is_object) {
        *state.ui_context.write().await = context;
    }
    let sender = state
        .pending_ui_actions
        .lock()
        .await
        .remove(&request_id)
        .ok_or_else(|| "界面动作已经超时或不存在".to_string())?;
    let result = if ok {
        Ok(serde_json::json!({
            "requestId": request_id,
            "status": "completed",
            "message": message.unwrap_or_default(),
            "context": context,
        }))
    } else {
        Err(message.unwrap_or_else(|| "界面动作执行失败".to_string()))
    };
    sender
        .send(result)
        .map_err(|_| "界面动作调用方已经离开".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_mcp_is_enabled_by_default() {
        assert!(ControlServerState::default()
            .enabled
            .load(Ordering::Acquire));
    }

    #[test]
    fn rejects_write_and_unknown_db_tools() {
        assert!(is_allowed_db_tool("run_read_query"));
        assert!(is_allowed_db_tool("list_tables"));
        assert!(is_allowed_db_tool("read_table_page"));
        assert!(!is_allowed_db_tool("run_write_query"));
        assert!(!is_allowed_db_tool("restore_snapshot"));
        assert!(!is_allowed_db_tool(""));
    }

    #[test]
    fn parses_db_tool_requests_from_json_lines() {
        let request =
            parse_control_request(r#"{"op":"db_tool","id":"1","func":"list_tables","args":{}}"#)
                .unwrap();
        match request {
            ControlRequest::DbTool { id, func, .. } => {
                assert_eq!(id, "1");
                assert_eq!(func, "list_tables");
            }
            other => panic!("unexpected request: {other:?}"),
        }
    }

    #[test]
    fn only_reveal_window_bypasses_frontend_connection_readiness() {
        let reveal = parse_control_request(
            r#"{"op":"ui_action","id":"1","action":"reveal_window","args":{}}"#,
        )
        .unwrap();
        let open = parse_control_request(
            r#"{"op":"ui_action","id":"2","action":"open_table","args":{"table":"hero"}}"#,
        )
        .unwrap();
        let read =
            parse_control_request(r#"{"op":"db_tool","id":"3","func":"list_tables","args":{}}"#)
                .unwrap();

        assert!(!request_needs_frontend_ready(&reveal));
        assert!(request_needs_frontend_ready(&open));
        assert!(request_needs_frontend_ready(&read));
    }

    #[test]
    fn rejects_malformed_and_unknown_ops() {
        assert!(parse_control_request("not json").is_err());
        assert!(parse_control_request(r#"{"op":"drop_everything","id":"1"}"#).is_err());
    }

    #[test]
    fn hello_must_match_the_launch_token() {
        let ok = parse_control_request(r#"{"op":"hello","token":"secret"}"#).unwrap();
        assert!(matches!(
            ok,
            ControlRequest::Hello { token } if token == "secret"
        ));
    }

    #[test]
    fn open_table_payload_fills_selected_context_and_request_id() {
        let args = serde_json::json!({ "table": "player" });
        let payload = build_ui_action_payload("open_table", &args, "demo", "game_db").unwrap();
        assert_eq!(payload["action"], "open_table");
        assert_eq!(payload["tableName"], "player");
        assert_eq!(payload["connectionId"], "demo");
        assert_eq!(payload["database"], "game_db");
        assert!(payload["requestId"]
            .as_str()
            .unwrap()
            .starts_with("control-"));
    }

    #[test]
    fn explicit_database_wins_over_the_selected_fallback() {
        let args = serde_json::json!({ "tableName": "hero", "database": "other_db" });
        let payload = build_ui_action_payload("open_table", &args, "demo", "game_db").unwrap();
        assert_eq!(payload["database"], "other_db");
    }

    #[test]
    fn focus_actions_require_their_target_arguments() {
        let missing_column = serde_json::json!({ "table": "player" });
        assert!(build_ui_action_payload("focus_column", &missing_column, "", "").is_err());

        let with_column = serde_json::json!({ "table": "player", "column": "level" });
        let payload = build_ui_action_payload("focus_column", &with_column, "", "").unwrap();
        assert_eq!(payload["columnName"], "level");

        let missing_row = serde_json::json!({ "table": "player" });
        assert!(build_ui_action_payload("focus_row", &missing_row, "", "").is_err());

        let with_identity = serde_json::json!({ "table": "player", "rowIdentity": { "id": "1" } });
        let payload = build_ui_action_payload("focus_row", &with_identity, "", "").unwrap();
        assert_eq!(payload["rowIdentity"]["id"], "1");
    }

    #[test]
    fn ui_action_whitelist_rejects_arbitrary_actions() {
        let args = serde_json::json!({ "table": "player" });
        assert!(build_ui_action_payload("drop_table", &args, "", "").is_err());
        assert!(is_allowed_ui_action("reveal_window"));
    }

    #[test]
    fn discovery_payload_contains_all_fields_the_mcp_client_needs() {
        let payload = discovery_payload(43125, "tok", 4242, "0.1.25");
        assert_eq!(payload["port"], 43125);
        assert_eq!(payload["token"], "tok");
        assert_eq!(payload["pid"], 4242);
        assert_eq!(payload["version"], "0.1.25");
    }
}
