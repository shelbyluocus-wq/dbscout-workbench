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
    _child: Arc<Mutex<Child>>,
    context: AgentContext,
}

impl AgentSidecar {
    pub async fn spawn(
        window: Window,
        context: AgentContext,
        config: AgentConfig,
        resume_session_id: Option<String>,
    ) -> Result<Self, String> {
        let sidecar_path = resolve_sidecar_path(&window)?;
        let mut cmd = Command::new("node");
        cmd.arg(sidecar_path)
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
        let child_arc = Arc::new(Mutex::new(child));

        // Forward stdout lines as window events; db_request events are handled locally.
        tokio::spawn(read_stdout(window, stdout, stdin_arc.clone()));
        // Forward stderr lines as error events.
        tokio::spawn(read_stderr(stderr));

        let sidecar = Self {
            stdin: stdin_arc,
            _child: child_arc,
            context: context.clone(),
        };

        let mut env = HashMap::new();
        if let Some(api_key) = config.api_key {
            env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), api_key);
        }
        if let Some(api_url) = config.api_url {
            env.insert("ANTHROPIC_BASE_URL".to_string(), api_url);
        }
        if let Some(model) = &config.model {
            env.insert("ANTHROPIC_MODEL".to_string(), model.clone());
        }

        sidecar
            .send_op(AgentOp::Start {
                context,
                env: if env.is_empty() { None } else { Some(env) },
                resume_session_id,
                permission_mode: if config.permission_mode.is_empty() {
                    None
                } else {
                    Some(config.permission_mode)
                },
                model: config.model,
            })
            .await?;

        Ok(sidecar)
    }

    pub async fn send_message(&self, text: String) -> Result<(), String> {
        self.send_op(AgentOp::UserMessage { text }).await
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

    pub async fn list_sessions(&self, limit: Option<usize>) -> Result<(), String> {
        self.send_op(AgentOp::ListSessions { limit }).await
    }

    pub async fn delete_session(&self, session_id: String) -> Result<(), String> {
        self.send_op(AgentOp::DeleteSession { session_id }).await
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

async fn read_stdout(
    window: Window,
    stdout: tokio::process::ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
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
                    tokio::spawn(async move {
                        handle_db_request(window, stdin, event.payload).await;
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
        &AgentContext::default(),
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

fn resolve_sidecar_path(window: &Window) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("DBSCOUT_AGENT_SIDECAR_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }

    let app_handle = window.app_handle();
    let resource_dir: Result<PathBuf, tauri::Error> = app_handle.path().resource_dir();
    if let Ok(resource_dir) = resource_dir {
        let bundled = resource_dir.join("agent-runner.mjs");
        if bundled.exists() {
            return Ok(bundled);
        }
    }

    // Development fallback: walk up from the executable to find the project root.
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent();
        while let Some(d) = dir {
            let candidate = d.join("sidecar").join("agent-runner.mjs");
            if candidate.exists() {
                return Ok(candidate);
            }
            dir = d.parent();
        }
    }

    Err("agent sidecar not found".to_string())
}
