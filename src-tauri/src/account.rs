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
use tauri::{AppHandle, Emitter, Manager};

use crate::types::{AccountConfig, AccountInfo, AccountView, AppState, UserSession};

/// Event emitted whenever the backend refreshes or clears the persisted account
/// session (for example after silent re-login or token invalidation on 401).
pub const ACCOUNT_SESSION_CHANGED_EVENT: &str = "account-session-changed";

/// Default LAN central server used when no custom server URL has been saved yet.
pub const DEFAULT_SERVER_URL: &str = "http://192.168.1.243:8766";

/// Previous default central server addresses that should migrate once to
/// `DEFAULT_SERVER_URL` when upgrading existing installations.
const LEGACY_DEFAULT_SERVER_URLS: &[(&str, u32)] = &[
    ("http://192.168.1.193:8765", 1),
    ("http://192.168.1.243:8765", 2),
];

/// Current schema version for one-time `server_url` default migrations.
pub const SERVER_URL_MIGRATION_VERSION: u32 = 2;

const STARTUP_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
const SESSION_RECOVERY_TIMEOUT: Duration = Duration::from_secs(3);

fn is_legacy_default_server_url(url: &str, migration_version: u32) -> bool {
    let normalized = url.trim().trim_end_matches('/');
    LEGACY_DEFAULT_SERVER_URLS
        .iter()
        .any(|(legacy, version)| {
            migration_version < *version && normalized.eq_ignore_ascii_case(legacy)
        })
}

fn apply_default_and_migrate_server_url(mut config: AccountConfig) -> (AccountConfig, bool) {
    if config.server_url.is_none() {
        config.server_url = Some(DEFAULT_SERVER_URL.to_string());
        config.server_url_migration_version = Some(SERVER_URL_MIGRATION_VERSION);
        return (config, false);
    }

    let migration_version = config.server_url_migration_version.unwrap_or(0);
    if migration_version < SERVER_URL_MIGRATION_VERSION {
        let should_migrate = config
            .server_url
            .as_deref()
            .map(|url| is_legacy_default_server_url(url, migration_version))
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

/// Result of attempting to silently re-login with the saved username after a
/// central server rejected an expired/unknown token with 401 Unauthorized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReloginOutcome {
    Refreshed(UserSession),
    Rejected,
    TransientError,
}

/// Outcome of `recover_unauthorized_session` for callers that received a 401.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionRecovery {
    /// Silently obtained a fresh token for the same username (or another
    /// concurrent request already refreshed the session).
    Refreshed(UserSession),
    /// Server confirmed the account cannot be re-authenticated (e.g. 404);
    /// the stale local session has been cleared and the frontend notified.
    Cleared,
    /// Server was unreachable or returned 5xx; local session left untouched.
    Unchanged,
}

/// Result of validating a stored session against `GET /me` (with silent
/// `/login` fallback on 401).
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionCheckOutcome {
    Valid(UserSession),
    Refreshed(UserSession),
    Cleared,
    Unreachable,
}

fn emit_account_session_changed(app: &AppHandle, config: &AccountConfig) {
    let _ = app.emit(
        ACCOUNT_SESSION_CHANGED_EVENT,
        AccountView {
            server_url: config.server_url.clone(),
            session: config.session.clone(),
        },
    );
}

fn session_from_account_info(info: AccountInfo) -> UserSession {
    UserSession {
        user_id: info.user_id,
        username: info.username,
        display_name: info.display_name,
        token: info.token,
    }
}

/// Attempt to silently re-login via `POST /login` for `username`.
/// Because Blackcat central server uses username + opaque token (no password),
/// this seamlessly restores sessions after a central-server migration or token
/// rotation when the account exists on the target server, while distinguishing
/// definitive rejections (4xx) from transient network/5xx errors.
pub async fn try_relogin_with_username(
    http: &reqwest::Client,
    base_url: &str,
    username: &str,
    timeout: Duration,
) -> ReloginOutcome {
    let trimmed_base = base_url.trim().trim_end_matches('/');
    let trimmed_user = username.trim();
    if trimmed_base.is_empty() || trimmed_user.is_empty() {
        return ReloginOutcome::Rejected;
    }
    let login_url = format!("{trimmed_base}/login");
    let Ok(url) = reqwest::Url::parse(&login_url) else {
        return ReloginOutcome::TransientError;
    };
    let resp = match http
        .post(url)
        .timeout(timeout)
        .json(&serde_json::json!({ "username": trimmed_user }))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(_) => return ReloginOutcome::TransientError,
    };
    match resp.status() {
        status if status.is_success() => match resp.json::<AccountInfo>().await {
            Ok(info) if !info.token.trim().is_empty() => {
                ReloginOutcome::Refreshed(session_from_account_info(info))
            }
            _ => ReloginOutcome::TransientError,
        },
        StatusCode::NOT_FOUND
        | StatusCode::UNAUTHORIZED
        | StatusCode::FORBIDDEN
        | StatusCode::BAD_REQUEST => ReloginOutcome::Rejected,
        _ => ReloginOutcome::TransientError,
    }
}

/// Validate `session` against `GET /me`, falling back to `POST /login` on 401.
#[cfg(test)]
pub async fn check_session_with_server(
    http: &reqwest::Client,
    base_url: &str,
    session: &UserSession,
    timeout: Duration,
) -> SessionCheckOutcome {
    let trimmed_base = base_url.trim().trim_end_matches('/');
    if trimmed_base.is_empty() {
        return SessionCheckOutcome::Unreachable;
    }
    let me_url = format!("{trimmed_base}/me");
    let Ok(url) = reqwest::Url::parse(&me_url) else {
        return SessionCheckOutcome::Unreachable;
    };
    let resp = match http
        .get(url)
        .bearer_auth(&session.token)
        .timeout(timeout)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(_) => return SessionCheckOutcome::Unreachable,
    };
    match resp.status() {
        status if status.is_success() => match resp.json::<AccountInfo>().await {
            Ok(info) if !info.token.trim().is_empty() => {
                SessionCheckOutcome::Valid(session_from_account_info(info))
            }
            _ => SessionCheckOutcome::Valid(session.clone()),
        },
        StatusCode::UNAUTHORIZED => {
            match try_relogin_with_username(http, trimmed_base, &session.username, timeout).await {
                ReloginOutcome::Refreshed(refreshed) => SessionCheckOutcome::Refreshed(refreshed),
                ReloginOutcome::Rejected => SessionCheckOutcome::Cleared,
                ReloginOutcome::TransientError => SessionCheckOutcome::Unreachable,
            }
        }
        _ => SessionCheckOutcome::Unreachable,
    }
}

/// Handle a `401 Unauthorized` response from the central server:
/// 1. Serializes concurrent 401s so multiple background/foreground requests
///    coalesce into one recovery check.
/// 2. Attempts silent `POST /login` with the saved username. If it succeeds,
///    updates `session.json` and notifies the frontend so the caller can retry.
/// 3. If the server explicitly rejects the username (e.g. 404 on a fresh 243
///    server), clears the stale local session, persists `session.json`, and
///    emits `account-session-changed` so the UI immediately reflects logged-out
///    state instead of showing a misleading logged-in badge.
/// 4. On transient network/5xx errors, leaves the local session intact.
pub async fn recover_unauthorized_session(
    app: &AppHandle,
    state: &AppState,
    base_url: &str,
    failed_session: &UserSession,
) -> SessionRecovery {
    let _recovery_guard = state.account.recovery_lock.lock().await;

    // Re-check current state in case another caller already refreshed/cleared
    // or the user manually switched accounts while we waited for the lock.
    {
        let config = state.account.config.lock().await;
        match config.session.as_ref() {
            None => return SessionRecovery::Cleared,
            Some(current) if current.token != failed_session.token => {
                return SessionRecovery::Refreshed(current.clone());
            }
            Some(_) => {}
        }
    }

    let outcome = try_relogin_with_username(
        &state.account.http,
        base_url,
        &failed_session.username,
        SESSION_RECOVERY_TIMEOUT,
    )
    .await;

    match outcome {
        ReloginOutcome::Refreshed(new_session) => {
            let (snapshot, changed) = {
                let mut config = state.account.config.lock().await;
                let still_same = config
                    .session
                    .as_ref()
                    .map(|s| s.token == failed_session.token)
                    .unwrap_or(false);
                if still_same {
                    config.session = Some(new_session.clone());
                    (config.clone(), true)
                } else {
                    (config.clone(), false)
                }
            };
            if changed {
                let _ = save_account(app, &snapshot);
                emit_account_session_changed(app, &snapshot);
                state.table_modified.clear_shared_fetch_debounce();
                SessionRecovery::Refreshed(new_session)
            } else {
                match snapshot.session {
                    Some(current) => SessionRecovery::Refreshed(current),
                    None => SessionRecovery::Cleared,
                }
            }
        }
        ReloginOutcome::Rejected => {
            let (snapshot, changed) = {
                let mut config = state.account.config.lock().await;
                let still_same = config
                    .session
                    .as_ref()
                    .map(|s| s.token == failed_session.token)
                    .unwrap_or(false);
                if still_same {
                    config.session = None;
                    (config.clone(), true)
                } else {
                    (config.clone(), false)
                }
            };
            if changed {
                let _ = save_account(app, &snapshot);
                emit_account_session_changed(app, &snapshot);
                SessionRecovery::Cleared
            } else {
                match snapshot.session {
                    Some(current) => SessionRecovery::Refreshed(current),
                    None => SessionRecovery::Cleared,
                }
            }
        }
        ReloginOutcome::TransientError => SessionRecovery::Unchanged,
    }
}

/// Validate any persisted session against `base_url` (used on startup probe and
/// after changing the central server URL). Returns `(latest_session, reachable)`.
/// Offline-first: if the server is unreachable, keeps the local session intact
/// and returns `(session, false)`.
pub async fn validate_or_recover_session(
    app: &AppHandle,
    state: &AppState,
    base_url: &str,
) -> (Option<UserSession>, bool) {
    let Some(session) = current_session(state).await else {
        let reachable = probe_server_reachable(&state.account.http, base_url).await;
        return (None, reachable);
    };

    let trimmed_base = base_url.trim().trim_end_matches('/');
    if trimmed_base.is_empty() {
        return (Some(session), false);
    }
    let me_url = format!("{trimmed_base}/me");
    let Ok(url) = reqwest::Url::parse(&me_url) else {
        return (Some(session), false);
    };

    let resp = match state
        .account
        .http
        .get(url)
        .bearer_auth(&session.token)
        .timeout(STARTUP_PROBE_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(_) => return (Some(session), false),
    };

    match resp.status() {
        status if status.is_success() => {
            if let Ok(info) = resp.json::<AccountInfo>().await {
                if !info.token.trim().is_empty() {
                    let latest = session_from_account_info(info);
                    if latest.display_name != session.display_name
                        || latest.user_id != session.user_id
                        || latest.username != session.username
                    {
                        let (snapshot, updated) = {
                            let mut config = state.account.config.lock().await;
                            let still_same = config
                                .session
                                .as_ref()
                                .map(|s| s.token == session.token)
                                .unwrap_or(false);
                            if still_same {
                                config.session = Some(latest.clone());
                                (config.clone(), true)
                            } else {
                                (config.clone(), false)
                            }
                        };
                        if updated {
                            let _ = save_account(app, &snapshot);
                            emit_account_session_changed(app, &snapshot);
                        }
                        return (snapshot.session, true);
                    }
                }
            }
            (Some(session), true)
        }
        StatusCode::UNAUTHORIZED => {
            match recover_unauthorized_session(app, state, trimmed_base, &session).await {
                SessionRecovery::Refreshed(refreshed) => (Some(refreshed), true),
                SessionRecovery::Cleared => (None, true),
                SessionRecovery::Unchanged => (Some(session), false),
            }
        }
        _ => (Some(session), false),
    }
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

        // Installations previously migrated to 243:8765 (v1) also migrate once to 243:8766 (v2).
        let (migrated_v1, persist_v1) = apply_default_and_migrate_server_url(AccountConfig {
            server_url: Some("http://192.168.1.243:8765".into()),
            session: Some(existing_session.clone()),
            server_url_migration_version: Some(1),
            loaded: false,
        });
        assert_eq!(migrated_v1.server_url.as_deref(), Some(DEFAULT_SERVER_URL));
        assert_eq!(
            migrated_v1.server_url_migration_version,
            Some(SERVER_URL_MIGRATION_VERSION)
        );
        assert_eq!(
            migrated_v1.session.as_ref().map(|s| s.token.as_str()),
            Some("tok-1")
        );
        assert!(persist_v1);

        // Once marked migrated, an explicit override back to a legacy host is respected.
        let (explicit_rollback_v1, persist_rollback_v1) =
            apply_default_and_migrate_server_url(AccountConfig {
                server_url: Some("http://192.168.1.193:8765".into()),
                session: None,
                server_url_migration_version: Some(1),
                loaded: false,
            });
        assert_eq!(
            explicit_rollback_v1.server_url.as_deref(),
            Some("http://192.168.1.193:8765")
        );
        assert_eq!(
            explicit_rollback_v1.server_url_migration_version,
            Some(SERVER_URL_MIGRATION_VERSION)
        );
        assert!(!persist_rollback_v1);

        let (explicit_rollback_v2, persist_rollback_v2) =
            apply_default_and_migrate_server_url(AccountConfig {
                server_url: Some("http://192.168.1.243:8765".into()),
                session: None,
                server_url_migration_version: Some(SERVER_URL_MIGRATION_VERSION),
                loaded: false,
            });
        assert_eq!(
            explicit_rollback_v2.server_url.as_deref(),
            Some("http://192.168.1.243:8765")
        );
        assert!(!persist_rollback_v2);

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

    async fn spawn_routed_http_server(
        routes: Vec<(&'static str, &'static str, &'static str)>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for _ in 0..routes.len() {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = [0_u8; 4096];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");
                let (status_line, body) = routes
                    .iter()
                    .find(|(prefix, _, _)| first_line.starts_with(prefix))
                    .map(|(_, status, body)| (*status, *body))
                    .unwrap_or(("404 Not Found", ""));
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn check_session_with_server_handles_valid_relogin_rejected_and_offline() {
        let client = reqwest::Client::new();
        let saved = UserSession {
            user_id: "u-old".into(),
            username: "alice".into(),
            display_name: "Alice".into(),
            token: "old-token".into(),
        };

        // 1) /me returns 200 OK -> Valid with latest user info.
        let valid_url = spawn_routed_http_server(vec![(
            "GET /me",
            "200 OK",
            r#"{"userId":"u-old","username":"alice","displayName":"Alice Updated","token":"old-token"}"#,
        )])
        .await;
        assert_eq!(
            check_session_with_server(&client, &valid_url, &saved, Duration::from_secs(2)).await,
            SessionCheckOutcome::Valid(UserSession {
                user_id: "u-old".into(),
                username: "alice".into(),
                display_name: "Alice Updated".into(),
                token: "old-token".into(),
            })
        );

        // 2) /me returns 401 and /login succeeds -> silently Refreshed.
        let refresh_url = spawn_routed_http_server(vec![
            ("GET /me", "401 Unauthorized", "令牌无效或已失效"),
            (
                "POST /login",
                "200 OK",
                r#"{"userId":"u-new","username":"alice","displayName":"Alice","token":"fresh-token"}"#,
            ),
        ])
        .await;
        assert_eq!(
            check_session_with_server(&client, &refresh_url, &saved, Duration::from_secs(2)).await,
            SessionCheckOutcome::Refreshed(UserSession {
                user_id: "u-new".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                token: "fresh-token".into(),
            })
        );

        // 3) /me returns 401 and /login returns 404 -> Cleared (account missing on new server).
        let cleared_url = spawn_routed_http_server(vec![
            ("GET /me", "401 Unauthorized", "令牌无效或已失效"),
            ("POST /login", "404 Not Found", "用户不存在，请先注册"),
        ])
        .await;
        assert_eq!(
            check_session_with_server(&client, &cleared_url, &saved, Duration::from_secs(2)).await,
            SessionCheckOutcome::Cleared
        );

        // 4) /me returns 401 and /login returns 500 -> Unreachable (offline-first: do not clear).
        let transient_url = spawn_routed_http_server(vec![
            ("GET /me", "401 Unauthorized", "令牌无效或已失效"),
            ("POST /login", "500 Internal Server Error", "db busy"),
        ])
        .await;
        assert_eq!(
            check_session_with_server(&client, &transient_url, &saved, Duration::from_secs(2))
                .await,
            SessionCheckOutcome::Unreachable
        );

        // 5) /me returns 500 -> Unreachable (offline-first: keep local session).
        let down_url = spawn_routed_http_server(vec![(
            "GET /me",
            "500 Internal Server Error",
            "server error",
        )])
        .await;
        assert_eq!(
            check_session_with_server(&client, &down_url, &saved, Duration::from_secs(2)).await,
            SessionCheckOutcome::Unreachable
        );
    }
}
