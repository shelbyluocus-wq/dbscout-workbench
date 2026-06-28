//! Account/session persistence + central-server client helpers.
//!
//! Mirrors the `backup.rs` config-root pattern: the account config (server URL
//! + opaque token session) is stored as pretty JSON at
//! `<app_data_dir>/account/session.json`, loaded lazily on first use because
//! `AppState::new()` runs before the Tauri app handle exists.
//!
//! Security model: username + opaque token only (no passwords). The token is
//! stored in plaintext on disk — acceptable for an internal single-user
//! workstation tool on a trusted LAN. Documented in the server README.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::types::{AccountConfig, AppState, UserSession};

/// Directory holding `session.json`. Sibling of the `backup/` config dir so
/// both live under the platform app-data directory.
pub fn account_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录: {error}"))?;
    let dir = base.join("account");
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建账号目录失败: {error}"))?;
    Ok(dir)
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(account_root(app)?.join("session.json"))
}

/// Read the persisted account config from disk. Returns `Default` if missing or
/// unparseable (same lenient fallback as `backup::load_config`).
pub fn load_account(app: &AppHandle) -> AccountConfig {
    let path = match session_path(app) {
        Ok(path) => path,
        Err(_) => return AccountConfig::default(),
    };
    match std::fs::read_to_string(&path) {
        Ok(content) if !content.trim().is_empty() => {
            serde_json::from_str(&content).unwrap_or_default()
        }
        _ => AccountConfig::default(),
    }
}

/// Persist the account config to disk.
pub fn save_account(app: &AppHandle, config: &AccountConfig) -> Result<(), String> {
    let path = session_path(app)?;
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("序列化账号配置失败: {error}"))?;
    std::fs::write(&path, content).map_err(|error| format!("写入账号配置失败: {error}"))?;
    Ok(())
}

/// Lazily load the persisted account config into `AppState` on first access.
/// Subsequent calls are no-ops once a config has been loaded (detected by
/// `loaded` flag — we re-use `server_url.is_some() || session.is_some()` is not
/// reliable since a user may have logged out, so we track a separate flag).
pub async fn ensure_loaded(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let mut config = state.account.config.lock().await;
    if config.loaded {
        return Ok(());
    }
    *config = load_account(app);
    config.loaded = true;
    Ok(())
}

/// The display name of the currently logged-in user, or `None` when logged
/// out. Used to stamp the `actor` field on every audit row.
pub async fn current_actor(state: &AppState) -> Option<String> {
    let config = state.account.config.lock().await;
    config
        .session
        .as_ref()
        .map(|session| session.display_name.clone())
}

/// Convenience: return `(actor, client_id)` for building an `AuditContext`.
/// `actor` is the current user's display name (or `None`); `client_id` is a
/// fresh UUID. Every audit write site calls this so actor/client_id are stamped
/// uniformly. The account config is loaded lazily on first use.
pub async fn audit_actor_and_id(app: &AppHandle, state: &AppState) -> (Option<String>, String) {
    let _ = ensure_loaded(app, state).await;
    let actor = current_actor(state).await;
    let client_id = uuid::Uuid::new_v4().to_string();
    (actor, client_id)
}

/// A snapshot of the current session (cloned out of the lock).
pub async fn current_session(state: &AppState) -> Option<UserSession> {
    state.account.config.lock().await.session.clone()
}

/// Base URL of the central server (without trailing slash), when configured.
pub async fn server_url(state: &AppState) -> Option<String> {
    state
        .account
        .config
        .lock()
        .await
        .server_url
        .clone()
        .map(|url| url.trim_end_matches('/').to_string())
        .filter(|url| !url.is_empty())
}
