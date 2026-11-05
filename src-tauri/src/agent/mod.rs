pub mod artifact;
pub(crate) mod db_bridge;
pub mod profile;
pub mod project;
mod protocol;
pub(crate) mod sql_guard;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use tauri::{Emitter, Manager, State, Window};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::types::AppState;
pub use protocol::{AgentConfig, AgentContext, AgentEvent, AgentOp, DbRequest};

const AGENT_EVENT: &str = "agent-event";

/// Prevent a visible console window when spawning the Node sidecar on Windows.
fn configure_hidden_subprocess(cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

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
        let node_path = resolve_node_path(&window)?;
        let native_cli_path = Some(resolve_native_cli_path(&window)?);
        let mut cmd = Command::new(&node_path);
        cmd.envs(load_bundled_agent_auth_env(&window));
        let artifact_output_dir = artifact::ensure_output_dir()?;
        cmd.env("DBSCOUT_AGENT_OUTPUT_DIR", artifact_output_dir);
        cmd.arg(&sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_hidden_subprocess(&mut cmd);

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
        self.send_op(AgentOp::GetSessionMessages { session_id })
            .await
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
    // bundled, process, or user auth. Treat empty/whitespace as missing.
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

    let mut env = sanitized_env(config.env);
    merge_agent_auth_env_defaults(&mut env);

    let api_key = nonempty(config.api_key);
    let auth_token = nonempty(config.auth_token);
    let api_url = nonempty(config.api_url);
    let model = nonempty(config.model);

    if let Some(value) = &api_key {
        env.insert("ANTHROPIC_API_KEY".to_string(), value.clone());
    }
    if let Some(value) = &auth_token {
        env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), value.clone());
        env.insert("CLAUDE_CODE_OAUTH_TOKEN".to_string(), value.clone());
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

fn sanitized_env(input: HashMap<String, String>) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for (key, value) in input {
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        if is_supported_agent_env_key(key) {
            env.insert(key.to_string(), value.to_string());
        }
    }
    env
}

fn merge_agent_auth_env_defaults(env: &mut HashMap<String, String>) {
    merge_env_default(
        env,
        "ANTHROPIC_API_KEY",
        &["DBSCOUT_AGENT_API_KEY", "ANTHROPIC_API_KEY"],
    );
    merge_shared_auth_token_default(env);
    merge_env_default(
        env,
        "CLAUDE_CODE_OAUTH_TOKEN",
        &[
            "DBSCOUT_AGENT_AUTH_TOKEN",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ],
    );
    mirror_agent_auth_tokens(env);
    merge_env_default(
        env,
        "ANTHROPIC_BASE_URL",
        &["DBSCOUT_AGENT_BASE_URL", "ANTHROPIC_BASE_URL"],
    );
    merge_env_default(
        env,
        "ANTHROPIC_MODEL",
        &["DBSCOUT_AGENT_MODEL", "ANTHROPIC_MODEL"],
    );
}

fn merge_shared_auth_token_default(env: &mut HashMap<String, String>) {
    merge_env_default(
        env,
        "ANTHROPIC_AUTH_TOKEN",
        &[
            "DBSCOUT_AGENT_AUTH_TOKEN",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ],
    );
}

fn mirror_agent_auth_tokens(env: &mut HashMap<String, String>) {
    if !env.contains_key("ANTHROPIC_AUTH_TOKEN") {
        if let Some(value) = env.get("CLAUDE_CODE_OAUTH_TOKEN").cloned() {
            env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), value);
        }
    }
    if !env.contains_key("CLAUDE_CODE_OAUTH_TOKEN") {
        if let Some(value) = env.get("ANTHROPIC_AUTH_TOKEN").cloned() {
            env.insert("CLAUDE_CODE_OAUTH_TOKEN".to_string(), value);
        }
    }
}

fn merge_env_default(env: &mut HashMap<String, String>, target: &str, sources: &[&str]) {
    if env.contains_key(target) {
        return;
    }
    for source in sources {
        if let Ok(value) = std::env::var(source) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                env.insert(target.to_string(), trimmed.to_string());
                return;
            }
        }
    }
}

fn is_supported_agent_env_key(key: &str) -> bool {
    matches!(
        key,
        "ANTHROPIC_API_KEY"
            | "ANTHROPIC_AUTH_TOKEN"
            | "ANTHROPIC_BASE_URL"
            | "ANTHROPIC_MODEL"
            | "ANTHROPIC_DEFAULT_HAIKU_MODEL"
            | "ANTHROPIC_DEFAULT_OPUS_MODEL"
            | "ANTHROPIC_DEFAULT_SONNET_MODEL"
            | "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"
            | "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"
            | "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"
            | "API_TIMEOUT_MS"
            | "CLAUDE_CODE_ATTRIBUTION_HEADER"
            | "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
            | "CLAUDE_CODE_EFFORT_LEVEL"
            | "CLAUDE_CODE_OAUTH_TOKEN"
            | "ENABLE_TOOL_SEARCH"
            | "NODE_EXTRA_CA_CERTS"
    )
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
    let app = window.app_handle().clone();

    let result =
        db_bridge::handle_db_request(app_state, app, &context, &request.func, request.args).await;

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
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
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

fn resolve_native_cli_path(window: &Window) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("DBSCOUT_AGENT_NATIVE_CLI_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(normalize_path(path));
        }
    }

    let app_handle = window.app_handle();
    if let Some(runtime) = crate::agent_runtime::resolve_runtime_paths(app_handle) {
        return Ok(normalize_path(runtime.native_cli_path));
    }

    Err("AI 组件尚未安装。请打开 AI 面板完成安装后重试".into())
}

fn load_bundled_agent_auth_env(window: &Window) -> HashMap<String, String> {
    let app_handle = window.app_handle();
    let resource_dir: Result<PathBuf, tauri::Error> = app_handle.path().resource_dir();
    let Ok(resource_dir) = resource_dir else {
        return HashMap::new();
    };

    for name in ["agent-auth.local.json", "agent-auth.json"] {
        let path = resource_dir.join(name);
        if !path.exists() {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(raw) => return parse_agent_auth_env_config(&raw),
            Err(err) => {
                eprintln!("[agent] failed to read {}: {}", path.display(), err);
            }
        }
    }
    HashMap::new()
}

fn parse_agent_auth_env_config(raw: &str) -> HashMap<String, String> {
    let value = match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("[agent] failed to parse agent auth config: {}", err);
            return HashMap::new();
        }
    };

    let mut input = HashMap::new();
    if let Some(env) = value.get("env").and_then(|env| env.as_object()) {
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                input.insert(key.clone(), value.to_string());
            }
        }
    }

    for (field, env_key) in [
        ("apiKey", "ANTHROPIC_API_KEY"),
        ("authToken", "ANTHROPIC_AUTH_TOKEN"),
        ("apiUrl", "ANTHROPIC_BASE_URL"),
        ("baseUrl", "ANTHROPIC_BASE_URL"),
        ("model", "ANTHROPIC_MODEL"),
    ] {
        if let Some(value) = value.get(field).and_then(|value| value.as_str()) {
            input.insert(env_key.to_string(), value.to_string());
            if field == "authToken" {
                input.insert("CLAUDE_CODE_OAUTH_TOKEN".to_string(), value.to_string());
            }
        }
    }

    let mut env = sanitized_env(input);
    mirror_agent_auth_tokens(&mut env);
    env
}

/// Locate a Node runtime to spawn the agent sidecar with.
///
/// Resolution order:
/// 1. `DBSCOUT_AGENT_NODE_PATH` env var — developer override / CI hook.
/// 2. The independently installed AI runtime under the app data directory.
/// 3. In debug builds only, the local `src-tauri/resources/node` fallback.
fn resolve_node_path(window: &Window) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("DBSCOUT_AGENT_NODE_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(normalize_path(path));
        }
    }

    let app_handle = window.app_handle();
    if let Some(runtime) = crate::agent_runtime::resolve_runtime_paths(app_handle) {
        return Ok(normalize_path(runtime.node_path));
    }

    #[cfg(debug_assertions)]
    {
        return Ok(PathBuf::from("node"));
    }

    #[cfg(not(debug_assertions))]
    Err("AI 组件尚未安装。请打开 AI 面板完成安装后重试".into())
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
        // from falling back to bundled, process, or user auth.
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
            auth_token: Some("managed-auth-token".to_string()),
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
                .and_then(|e| e.get("ANTHROPIC_AUTH_TOKEN"))
                .and_then(|v| v.as_str()),
            Some("managed-auth-token")
        );
        assert_eq!(
            json.get("env")
                .and_then(|e| e.get("CLAUDE_CODE_OAUTH_TOKEN"))
                .and_then(|v| v.as_str()),
            Some("managed-auth-token")
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
    fn build_start_op_maps_provided_env_to_claude_code_auth_env() {
        let mut env = HashMap::new();
        env.insert(
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            "provided-auth-token".to_string(),
        );
        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            "https://proxy.example.com".to_string(),
        );
        env.insert("IGNORED_SECRET".to_string(), "must-not-leak".to_string());
        let config = AgentConfig {
            env,
            ..AgentConfig::default()
        };

        let op = build_start_op(AgentContext::default(), config, None, None);
        let json = serde_json::to_value(op).unwrap();
        let env = json.get("env").unwrap();

        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN")
                .and_then(|value| value.as_str()),
            Some("provided-auth-token")
        );
        assert_eq!(
            env.get("CLAUDE_CODE_OAUTH_TOKEN")
                .and_then(|value| value.as_str()),
            Some("provided-auth-token")
        );
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL")
                .and_then(|value| value.as_str()),
            Some("https://proxy.example.com")
        );
        assert!(env.get("IGNORED_SECRET").is_none());
    }

    #[test]
    fn build_start_op_accepts_claude_code_oauth_token_as_auth_env() {
        let mut env = HashMap::new();
        env.insert(
            "CLAUDE_CODE_OAUTH_TOKEN".to_string(),
            "provided-oauth-token".to_string(),
        );
        let config = AgentConfig {
            env,
            ..AgentConfig::default()
        };

        let op = build_start_op(AgentContext::default(), config, None, None);
        let json = serde_json::to_value(op).unwrap();
        let env = json.get("env").unwrap();

        assert_eq!(
            env.get("CLAUDE_CODE_OAUTH_TOKEN")
                .and_then(|value| value.as_str()),
            Some("provided-oauth-token")
        );
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN")
                .and_then(|value| value.as_str()),
            Some("provided-oauth-token")
        );
    }

    #[test]
    fn parse_agent_auth_env_config_accepts_safe_auth_fields_only() {
        let raw = r#"{
            "authToken": "bundled-auth-token",
            "baseUrl": "https://proxy.example.com",
            "model": "claude-test",
            "env": {
                "ENABLE_TOOL_SEARCH": "true",
                "PATH": "must-not-leak"
            }
        }"#;

        let env = parse_agent_auth_env_config(raw);

        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str),
            Some("bundled-auth-token")
        );
        assert_eq!(
            env.get("CLAUDE_CODE_OAUTH_TOKEN").map(String::as_str),
            Some("bundled-auth-token")
        );
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("https://proxy.example.com")
        );
        assert_eq!(
            env.get("ANTHROPIC_MODEL").map(String::as_str),
            Some("claude-test")
        );
        assert_eq!(
            env.get("ENABLE_TOOL_SEARCH").map(String::as_str),
            Some("true")
        );
        assert!(env.get("PATH").is_none());
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
    fn normalize_path_converts_windows_verbatim_unc_prefix() {
        let verbatim_unc = PathBuf::from(r"\\?\UNC\server\share\agent-runner.mjs");
        let normalized = normalize_path(verbatim_unc);
        assert_eq!(
            normalized,
            PathBuf::from(r"\\server\share\agent-runner.mjs")
        );
    }

    #[test]
    fn normalize_path_keeps_regular_paths_unchanged() {
        let regular = PathBuf::from(r"E:\project\dbscout\agent-runner.mjs");
        let normalized = normalize_path(regular.clone());
        assert_eq!(normalized, regular);
    }
}
