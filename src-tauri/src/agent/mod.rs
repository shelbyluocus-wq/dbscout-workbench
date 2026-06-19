mod db_bridge;
mod protocol;
mod sql_guard;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use tauri::{Emitter, Manager, State, Window};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

pub use protocol::{AgentConfig, AgentContext, AgentEvent, AgentOp, DbRequest};
use crate::types::AppState;

const AGENT_EVENT: &str = "agent-event";

pub struct AgentSidecar {
    stdin: Arc<Mutex<ChildStdin>>,
    context: Arc<Mutex<AgentContext>>,
    native_cli_path: Option<PathBuf>,
    _child: Arc<Mutex<Child>>,
}

impl AgentSidecar {
    pub async fn spawn(
        window: Window,
        context: AgentContext,
        config: AgentConfig,
        resume_session_id: Option<String>,
    ) -> Result<Self, String> {
        let sidecar_path = resolve_sidecar_path(&window)?;
        // Prefer the Node runtime bundled into the app's resources. Falls back
        // to whatever `node` is on PATH so a developer machine without a
        // bundled binary still works during `cargo run` / `tauri dev`.
        let node_path =
            resolve_node_path(&window).unwrap_or_else(|| PathBuf::from("node"));
        let mut cmd = Command::new(&node_path);
        cmd.arg(&sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|err| format!("failed to spawn agent sidecar: {}", err))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar stdin missing".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecar stdout missing".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "sidecar stderr missing".to_string())?;

        let stdin_arc = Arc::new(Mutex::new(stdin));
        let context_arc = Arc::new(Mutex::new(context.clone()));
        let child_arc = Arc::new(Mutex::new(child));

        // Forward stdout lines as window events; db_request events are handled locally.
        tokio::spawn(read_stdout(
            window.clone(),
            stdout,
            stdin_arc.clone(),
            context_arc.clone(),
        ));
        // Forward stderr lines as error events.
        tokio::spawn(read_stderr(stderr));
        let native_cli_path = resolve_native_cli_path(&window);

        let sidecar = Self {
            stdin: stdin_arc,
            context: context_arc,
            native_cli_path: native_cli_path.clone(),
            _child: child_arc,
        };

        let op = build_start_op(context, config, resume_session_id, native_cli_path);
        sidecar.send_op(op).await?;

        Ok(sidecar)
    }

    pub async fn start_session(
        &self,
        context: AgentContext,
        config: AgentConfig,
        resume_session_id: Option<String>,
    ) -> Result<(), String> {
        {
            let mut guard = self.context.lock().await;
            *guard = context.clone();
        }
        self.send_op(build_start_op(
            context,
            config,
            resume_session_id,
            self.native_cli_path.clone(),
        ))
        .await
    }

    pub async fn send_message(
        &self,
        text: String,
        context: Option<AgentContext>,
    ) -> Result<(), String> {
        if let Some(context) = context.clone() {
            let mut guard = self.context.lock().await;
            *guard = context;
        }
        self.send_op(AgentOp::UserMessage { text, context }).await
    }

    pub async fn abort(&self) -> Result<(), String> {
        self.send_op(AgentOp::Interrupt).await
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        self.send_op(AgentOp::Shutdown).await
    }

    pub async fn send_approval_response(
        &self,
        req_id: String,
        allowed: bool,
        message: Option<String>,
    ) -> Result<(), String> {
        self.send_op(AgentOp::ApprovalResponse {
            req_id,
            allowed,
            message,
        })
        .await
    }

    pub async fn set_mode(&self, mode: String) -> Result<(), String> {
        self.send_op(AgentOp::SetMode { mode }).await
    }

    pub async fn set_auto_approve(&self, on: bool) -> Result<(), String> {
        self.send_op(AgentOp::SetAutoApprove { on }).await
    }

    pub async fn list_sessions(&self, limit: Option<usize>) -> Result<(), String> {
        self.send_op(AgentOp::ListSessions { limit }).await
    }

    pub async fn delete_session(&self, session_id: String) -> Result<(), String> {
        self.send_op(AgentOp::DeleteSession { session_id }).await
    }

    pub async fn get_session_messages(&self, session_id: String) -> Result<(), String> {
        self.send_op(AgentOp::GetSessionMessages { session_id }).await
    }

    async fn send_op(&self, op: AgentOp) -> Result<(), String> {
        let line = serde_json::to_string(&op)
            .map_err(|err| format!("failed to serialize agent op: {}", err))?;
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|err| format!("failed to write to sidecar stdin: {}", err))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|err| format!("failed to write newline to sidecar stdin: {}", err))?;
        stdin
            .flush()
            .await
            .map_err(|err| format!("failed to flush sidecar stdin: {}", err))?;
        Ok(())
    }
}

fn build_start_op(
    context: AgentContext,
    config: AgentConfig,
    resume_session_id: Option<String>,
    native_cli_path: Option<PathBuf>,
) -> AgentOp {
    // Frontend serializes empty inputs as `Some("")` rather than `None`. We
    // must NOT pass an empty string through as the env var: the SDK would
    // see `ANTHROPIC_API_KEY=""` (set but empty) and refuse to fall back to
    // the user's local Claude Code login. Treat empty/whitespace as missing.
    let nonempty = |opt: Option<String>| -> Option<String> {
        opt.and_then(|s| {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
    };

    let api_key = nonempty(config.api_key);
    let api_url = nonempty(config.api_url);
    let model = nonempty(config.model);

    let mut env = HashMap::new();
    if let Some(value) = &api_key {
        env.insert("ANTHROPIC_API_KEY".to_string(), value.clone());
    }
    if let Some(value) = &api_url {
        env.insert("ANTHROPIC_BASE_URL".to_string(), value.clone());
    }
    if let Some(value) = &model {
        env.insert("ANTHROPIC_MODEL".to_string(), value.clone());
    }
    if let Some(native_cli_path) = native_cli_path {
        env.insert(
            "DBSCOUT_AGENT_NATIVE_CLI_PATH".to_string(),
            native_cli_path.to_string_lossy().to_string(),
        );
    }

    AgentOp::Start {
        context,
        env: if env.is_empty() { None } else { Some(env) },
        resume_session_id,
        permission_mode: if config.permission_mode.is_empty() {
            None
        } else {
            Some(config.permission_mode)
        },
        model,
        auto_approve_writes: Some(config.auto_approve_writes),
    }
}

async fn read_stdout(
    window: Window,
    stdout: tokio::process::ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    context: Arc<Mutex<AgentContext>>,
) {
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<AgentEvent>(&line) {
            Ok(event) => {
                if event.ev == "db_request" {
                    let stdin = stdin.clone();
                    let window = window.clone();
                    let context = context.clone();
                    tokio::spawn(async move {
                        let context = context.lock().await.clone();
                        handle_db_request(window, stdin, context, event.payload).await;
                    });
                    continue;
                }
                let _ = window.emit(AGENT_EVENT, event);
            }
            Err(err) => {
                let _ = window.emit(
                    AGENT_EVENT,
                    AgentEvent {
                        ev: "error".to_string(),
                        payload: serde_json::json!({
                            "message": "failed to parse sidecar event",
                            "details": err.to_string(),
                            "line": line,
                        }),
                    },
                );
            }
        }
    }
}

async fn handle_db_request(
    window: Window,
    stdin: Arc<Mutex<ChildStdin>>,
    context: AgentContext,
    payload: serde_json::Value,
) {
    let request = match serde_json::from_value::<DbRequest>(payload) {
        Ok(request) => request,
        Err(err) => {
            eprintln!("[agent] failed to parse db_request: {}", err);
            return;
        }
    };

    let app_state: State<'_, AppState> = window.app_handle().state::<AppState>();

    let result = db_bridge::handle_db_request(
        app_state,
        &context,
        &request.func,
        request.args,
    )
    .await;

    let response = AgentOp::DbResponse {
        req_id: request.req_id,
        ok: result.is_ok(),
        data: result.as_ref().ok().cloned(),
        error: result.as_ref().err().cloned(),
    };

    let line = match serde_json::to_string(&response) {
        Ok(line) => line,
        Err(err) => {
            eprintln!("[agent] failed to serialize db_response: {}", err);
            return;
        }
    };

    let mut stdin = stdin.lock().await;
    let _ = stdin.write_all(line.as_bytes()).await;
    let _ = stdin.write_all(b"\n").await;
    let _ = stdin.flush().await;
}

async fn read_stderr(stderr: tokio::process::ChildStderr) {
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        eprintln!("[agent sidecar stderr] {}", line);
    }
}

fn normalize_path(path: PathBuf) -> PathBuf {
    // Node.js on Windows does not accept verbatim/UNC paths (\\?\C:\...) as an
    // ESM entry point, and std::env::current_exe() returns such paths. Strip the
    // prefix so the sidecar and native CLI paths are regular Windows paths.
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

fn resolve_sidecar_path(window: &Window) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("DBSCOUT_AGENT_SIDECAR_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(normalize_path(path));
        }
    }

    let app_handle = window.app_handle();
    let resource_dir: Result<PathBuf, tauri::Error> = app_handle.path().resource_dir();
    if let Ok(resource_dir) = resource_dir {
        let bundled = resource_dir.join("agent-runner.mjs");
        if bundled.exists() {
            return Ok(normalize_path(bundled));
        }
    }

    // Development fallback: walk up from the executable to find the project root.
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent();
        while let Some(d) = dir {
            let candidate = d.join("sidecar").join("agent-runner.mjs");
            if candidate.exists() {
                return Ok(normalize_path(candidate));
            }
            dir = d.parent();
        }
    }

    Err("agent sidecar not found".to_string())
}

fn resolve_native_cli_path(window: &Window) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("DBSCOUT_AGENT_NATIVE_CLI_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(normalize_path(path));
        }
    }

    let app_handle = window.app_handle();
    let resource_dir: Result<PathBuf, tauri::Error> = app_handle.path().resource_dir();
    if let Ok(resource_dir) = resource_dir {
        // On Windows the executable must carry the .exe extension; prefer it.
        let names: &[&str] = if cfg!(target_os = "windows") {
            &["claude-code-native.exe", "claude-code-native"]
        } else {
            &["claude-code-native", "claude-code-native.exe"]
        };
        for name in names {
            let candidate = resource_dir.join(name);
            if candidate.exists() {
                return Some(normalize_path(candidate));
            }
        }
    }

    None
}

/// Locate a Node runtime to spawn the agent sidecar with.
///
/// Resolution order:
/// 1. `DBSCOUT_AGENT_NODE_PATH` env var — developer override / CI hook.
/// 2. Bundled portable Node under `<resource_dir>/node/node[.exe]`. This is
///    what end users get: shipping the runtime alongside the app removes the
///    "please install Node 18+" prerequisite for non-developer coworkers and
///    keeps users on legacy Node (e.g. 14) from accidentally driving the
///    sidecar with an incompatible runtime.
/// 3. Returns `None` so the caller falls back to plain `node` on PATH.
fn resolve_node_path(window: &Window) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("DBSCOUT_AGENT_NODE_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(normalize_path(path));
        }
    }

    let app_handle = window.app_handle();
    let resource_dir: Result<PathBuf, tauri::Error> = app_handle.path().resource_dir();
    if let Ok(resource_dir) = resource_dir {
        let names: &[&str] = if cfg!(target_os = "windows") {
            &["node.exe", "node"]
        } else {
            &["node", "node.exe"]
        };
        for name in names {
            let candidate = resource_dir.join("node").join(name);
            if candidate.exists() {
                return Some(normalize_path(candidate));
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_start_op_can_carry_resolved_native_cli_path() {
        let native_cli_path = PathBuf::from("C:/dbscout/claude-code-native.exe");

        let op = build_start_op(
            AgentContext::default(),
            AgentConfig::default(),
            None,
            Some(native_cli_path.clone()),
        );

        let json = serde_json::to_value(op).unwrap();
        assert_eq!(
            json.get("env")
                .and_then(|env| env.get("DBSCOUT_AGENT_NATIVE_CLI_PATH"))
                .and_then(|value| value.as_str()),
            Some(native_cli_path.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn build_start_op_carries_auto_approve_writes_config() {
        let config = AgentConfig {
            auto_approve_writes: true,
            ..AgentConfig::default()
        };

        let op = build_start_op(AgentContext::default(), config, None, None);

        let json = serde_json::to_value(op).unwrap();
        assert_eq!(json.get("autoApproveWrites").unwrap(), true);
    }

    #[test]
    fn build_start_op_treats_empty_strings_as_unset() {
        // The frontend serializes empty inputs as `Some("")`. Those must not
        // turn into env vars — `ANTHROPIC_API_KEY=""` would prevent the SDK
        // from falling back to the user's local Claude Code login.
        let config = AgentConfig {
            api_key: Some(String::new()),
            api_url: Some("   ".to_string()),
            model: Some(String::new()),
            ..AgentConfig::default()
        };

        let op = build_start_op(AgentContext::default(), config, None, None);
        let json = serde_json::to_value(op).unwrap();

        // No env block at all (or at least no auth keys in it) when every
        // user-controlled field is empty/whitespace.
        let env = json.get("env");
        assert!(
            env.is_none() || env == Some(&serde_json::Value::Null),
            "expected no env block, got {env:?}"
        );

        // The returned `model` field is also normalized to None.
        assert!(json.get("model").is_none() || json.get("model") == Some(&serde_json::Value::Null));
    }

    #[test]
    fn build_start_op_passes_through_real_values() {
        let config = AgentConfig {
            api_key: Some("sk-ant-real-key".to_string()),
            api_url: Some("https://api.example.com".to_string()),
            model: Some("claude-fable-5".to_string()),
            ..AgentConfig::default()
        };

        let op = build_start_op(AgentContext::default(), config, None, None);
        let json = serde_json::to_value(op).unwrap();

        assert_eq!(
            json.get("env")
                .and_then(|e| e.get("ANTHROPIC_API_KEY"))
                .and_then(|v| v.as_str()),
            Some("sk-ant-real-key")
        );
        assert_eq!(
            json.get("env")
                .and_then(|e| e.get("ANTHROPIC_BASE_URL"))
                .and_then(|v| v.as_str()),
            Some("https://api.example.com")
        );
        assert_eq!(
            json.get("model").and_then(|v| v.as_str()),
            Some("claude-fable-5")
        );
    }

    #[test]
    fn normalize_path_strips_windows_verbatim_prefix() {
        let verbatim = PathBuf::from(r"\\?\E:\project\dbscout\agent-runner.mjs");
        let normalized = normalize_path(verbatim);
        assert_eq!(
            normalized,
            PathBuf::from(r"E:\project\dbscout\agent-runner.mjs")
        );
    }

    #[test]
    fn normalize_path_keeps_regular_paths_unchanged() {
        let regular = PathBuf::from(r"E:\project\dbscout\agent-runner.mjs");
        let normalized = normalize_path(regular.clone());
        assert_eq!(normalized, regular);
    }
}
