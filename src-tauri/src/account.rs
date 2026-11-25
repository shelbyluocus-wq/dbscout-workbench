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
use std::time::Duration;

use reqwest::StatusCode;
use tauri::{AppHandle, Manager};

use crate::types::{AccountConfig, AppState, UserSession};

/// Default LAN central server used when no custom server URL has been saved yet.
pub const DEFAULT_SERVER_URL: &str = "http://192.168.1.243:8765";

/// Previous default central server addresses that should migrate once to
/// `DEFAULT_SERVER_URL` when upgrading existing installations.
const LEGACY_DEFAULT_SERVER_URLS: &[&str] = &["http://192.168.1.193:8765"];

/// Current schema version for one-time `server_url` default migrations.
pub const SERVER_URL_MIGRATION_VERSION: u32 = 1;

const STARTUP_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

fn is_legacy_default_server_url(url: &str) -> bool {
    let normalized = url.trim().trim_end_matches('/');
    LEGACY_DEFAULT_SERVER_URLS
        .iter()
        .any(|legacy| normalized.eq_ignore_ascii_case(legacy))
}

fn apply_default_and_migrate_server_url(mut config: AccountConfig) -> (AccountConfig, bool) {
    if config.server_url.is_none() {
        config.server_url = Some(DEFAULT_SERVER_URL.to_string());
        config.server_url_migration_version = Some(SERVER_URL_MIGRATION_VERSION);
        return (config, false);
    }

    if config.server_url_migration_version.unwrap_or(0) < SERVER_URL_MIGRATION_VERSION {
        let should_migrate = config
            .server_url
            .as_deref()
            .map(is_legacy_default_server_url)
            .unwrap_or(false);
        config.server_url_migration_version = Some(SERVER_URL_MIGRATION_VERSION);
        if should_migrate {
            config.server_url = Some(DEFAULT_SERVER_URL.to_string());
            return (config, true);
        }
    }

    (config, false)
}

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

/// Read the persisted account config from disk. Returns the default central
/// server URL when missing or unparseable so fresh installs connect out of the
/// box without manual URL entry, and migrates legacy default addresses once.
pub fn load_account(app: &AppHandle) -> AccountConfig {
    let path = match session_path(app) {
        Ok(path) => path,
        Err(_) => return apply_default_and_migrate_server_url(AccountConfig::default()).0,
    };
    let loaded = match std::fs::read_to_string(&path) {
        Ok(content) if !content.trim().is_empty() => {
            serde_json::from_str(&content).unwrap_or_default()
        }
        _ => AccountConfig::default(),
    };
    let (migrated, should_persist) = apply_default_and_migrate_server_url(loaded);
    if should_persist {
        let _ = save_account(app, &migrated);
    }
    migrated
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
        .map(|url| url.trim().trim_end_matches('/').to_string())
        .filter(|url| !url.is_empty())
}

/// Lightweight, silent reachability check against `GET /me`.
/// `dbscout-server` rejects unauthenticated `/me` requests with 401 Unauthorized,
/// so both 401 and 2xx confirm a live central server without mutating any state.
pub async fn probe_server_reachable(http: &reqwest::Client, base_url: &str) -> bool {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return false;
    }
    let probe_url = format!("{trimmed}/me");
    let Ok(url) = reqwest::Url::parse(&probe_url) else {
        return false;
    };
    let Ok(resp) = http.get(url).timeout(STARTUP_PROBE_TIMEOUT).send().await else {
        return false;
    };
    resp.status() == StatusCode::UNAUTHORIZED || resp.status().is_success()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn spawn_one_shot_http_server(status_line: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0_u8; 1024];
                let _ = socket.read(&mut buf).await;
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        format!("http://{addr}")
    }

    #[test]
    fn default_server_url_applies_and_migrates_legacy_default_once() {
        let (fresh, persist_fresh) = apply_default_and_migrate_server_url(AccountConfig::default());
        assert_eq!(fresh.server_url.as_deref(), Some(DEFAULT_SERVER_URL));
        assert_eq!(
            fresh.server_url_migration_version,
            Some(SERVER_URL_MIGRATION_VERSION)
        );
        assert!(!persist_fresh);

        let existing_session = UserSession {
            user_id: "u1".into(),
            username: "alice".into(),
            display_name: "Alice".into(),
            token: "tok-1".into(),
        };
        let (migrated, persist_migrated) = apply_default_and_migrate_server_url(AccountConfig {
            server_url: Some("  HTTP://192.168.1.193:8765/ ".into()),
            session: Some(existing_session.clone()),
            server_url_migration_version: None,
            loaded: false,
        });
        assert_eq!(migrated.server_url.as_deref(), Some(DEFAULT_SERVER_URL));
        assert_eq!(
            migrated.server_url_migration_version,
            Some(SERVER_URL_MIGRATION_VERSION)
        );
        assert_eq!(
            migrated.session.as_ref().map(|s| s.token.as_str()),
            Some("tok-1")
        );
        assert!(persist_migrated);

        // Once marked migrated, an explicit override back to the legacy host is respected.
        let (explicit_rollback, persist_rollback) =
            apply_default_and_migrate_server_url(AccountConfig {
                server_url: Some("http://192.168.1.193:8765".into()),
                session: None,
                server_url_migration_version: Some(SERVER_URL_MIGRATION_VERSION),
                loaded: false,
            });
        assert_eq!(
            explicit_rollback.server_url.as_deref(),
            Some("http://192.168.1.193:8765")
        );
        assert!(!persist_rollback);

        let (custom, persist_custom) = apply_default_and_migrate_server_url(AccountConfig {
            server_url: Some("http://10.0.0.5:8765".into()),
            session: None,
            server_url_migration_version: None,
            loaded: false,
        });
        assert_eq!(custom.server_url.as_deref(), Some("http://10.0.0.5:8765"));
        assert!(!persist_custom);

        let (opted_out, persist_opted_out) = apply_default_and_migrate_server_url(AccountConfig {
            server_url: Some(String::new()),
            session: None,
            server_url_migration_version: None,
            loaded: false,
        });
        assert_eq!(opted_out.server_url.as_deref(), Some(""));
        assert!(!persist_opted_out);
    }

    #[tokio::test]
    async fn probe_server_reachable_accepts_401_and_200_and_rejects_errors_or_closed_ports() {
        let client = reqwest::Client::new();

        let auth_server = spawn_one_shot_http_server("401 Unauthorized", "缺少认证令牌").await;
        assert!(probe_server_reachable(&client, &auth_server).await);

        let ok_server = spawn_one_shot_http_server("200 OK", "{}").await;
        assert!(probe_server_reachable(&client, &ok_server).await);

        let not_found_server = spawn_one_shot_http_server("404 Not Found", "").await;
        assert!(!probe_server_reachable(&client, &not_found_server).await);

        let error_server = spawn_one_shot_http_server("500 Internal Server Error", "").await;
        assert!(!probe_server_reachable(&client, &error_server).await);

        // Bind and immediately drop a listener to obtain a closed local port.
        let closed_port = TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(
            !probe_server_reachable(&client, &format!("http://127.0.0.1:{closed_port}")).await
        );
        assert!(!probe_server_reachable(&client, "").await);
    }
}
