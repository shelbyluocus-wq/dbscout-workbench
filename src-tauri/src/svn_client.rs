//! Shared SVN execution with a server-scoped, upgrade-persistent SSL fallback.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

const PREFERENCES_FILE: &str = "svn-client-preferences.json";
const INITIAL_ERROR_MARKER: &str = "svn: Initial SSL failure before client fallback:";
static PREFERENCES_LOCK: Mutex<()> = Mutex::new(());
const TRUSTED_SERVERS_FILE: &str = "svn-trusted-servers.json";
const CERTIFICATE_EXCEPTION: &str = "--trust-server-cert-failures=unknown-ca,cn-mismatch,expired,not-yet-valid,other";

pub(crate) struct SvnClient {
    primary: PathBuf,
    compatibility: Option<PathBuf>,
    use_compatibility: bool,
    switched: bool,
    preferences: Option<PathBuf>,
    server: Option<String>,
    legacy_tls_config: Option<PathBuf>,
    trust_certificate: bool,
}

impl SvnClient {
    pub(crate) async fn for_working_copy(app: &AppHandle, target: &Path) -> Result<Self, String> {
        let primary = crate::svn_updater::resolve_svn_exe(app)
            .ok_or_else(crate::svn_updater::svn_not_found_message)?;
        let compatibility = if cfg!(target_os = "windows") {
            app.path()
                .resource_dir()
                .ok()
                .map(|dir| dir.join("svn/compat-1.9.7/svn.exe"))
                .filter(|path| path.is_file() && *path != primary)
        } else {
            None
        };
        let preferences = app
            .path()
            .app_config_dir()
            .ok()
            .map(|dir| dir.join(PREFERENCES_FILE));
        if compatibility.is_none() && !cfg!(target_os = "macos") {
            return Ok(Self::new(primary, None, preferences, None));
        }
        // Local info does not contact the server. Never persist credentials or repository paths.
        let url = execute(
            primary.clone(),
            command_args(&["info", "--show-item", "url", "--non-interactive"], target),
        )
        .await
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned());
        let mut client = Self::new(
            primary,
            compatibility,
            preferences,
            url.as_deref(),
        );
        #[cfg(target_os = "macos")]
        if let (Some(server), Ok(directory)) = (&client.server, app.path().app_config_dir()) {
            client.legacy_tls_config = legacy_tls_config(&directory, server);
            client.trust_certificate = load_preferences(&directory.join(TRUSTED_SERVERS_FILE)).contains(server);
        }
        Ok(client)
    }

    fn new(
        primary: PathBuf,
        compatibility: Option<PathBuf>,
        preferences: Option<PathBuf>,
        url: Option<&str>,
    ) -> Self {
        let server = url.and_then(server_key);
        let use_compatibility = compatibility.is_some()
            && preferences
                .as_ref()
                .zip(server.as_ref())
                .is_some_and(|(path, server)| load_preferences(path).contains(server));
        Self {
            primary,
            compatibility,
            use_compatibility,
            switched: false,
            preferences,
            server,
            legacy_tls_config: None,
            trust_certificate: false,
        }
    }

    pub(crate) fn executable(&self) -> &Path {
        if self.use_compatibility {
            self.compatibility.as_deref().unwrap_or(&self.primary)
        } else {
            &self.primary
        }
    }

    pub(crate) async fn run(
        &mut self,
        args: &[&str],
        target: &Path,
        log: &(dyn Fn(String) + Sync),
    ) -> Result<Output, String> {
        let config = self.legacy_tls_config.clone();
        let mut args = args.to_vec();
        if (config.is_some() || self.trust_certificate) && args.first() == Some(&"update") {
            // An external can point at another server; never give it this server's TLS policy.
            args.push("--ignore-externals");
            log("正在使用此服务器专用的连接配置，本次不更新外部引用。".into());
        }
        if self.trust_certificate {
            args.push(CERTIFICATE_EXCEPTION);
            if args.first() == Some(&"update") {
                log("已按你的授权信任此 SVN 服务器的证书，仅对此服务器生效。".into());
            }
        }
        let output = self.run_with(&args, target, log, |program, args| {
            let config = config.clone();
            async move { execute_with_config(program, args, config.as_deref()).await }
        }).await?;
        if !output.status.success() && String::from_utf8_lossy(&output.stderr).contains("E230001") {
            log("SVN 服务器证书未通过校验。请先由管理员核对证书并配置受信任证书；黑猫不会自动忽略证书错误。".into());
        }
        if !output.status.success() && String::from_utf8_lossy(&output.stderr).contains("E215004") {
            log("已连接 SVN 服务器，但当前 SVN 客户端没有可用的登录凭据。Cairn 内保存的账号密码不会自动共享给黑猫，请先为此客户端登录。".into());
        }
        Ok(output)
    }

    async fn run_with<F, Fut>(
        &mut self,
        args: &[&str],
        target: &Path,
        log: &(dyn Fn(String) + Sync),
        mut runner: F,
    ) -> Result<Output, String>
    where
        F: FnMut(PathBuf, Vec<OsString>) -> Fut,
        Fut: Future<Output = Result<Output, String>>,
    {
        let command = command_args(args, target);
        let mut output = runner(self.executable().to_path_buf(), command.clone()).await?;
        if args.first() == Some(&"update")
            && !output.status.success()
            && !self.switched
            && self.compatibility.is_some()
            && is_ssl_communication_error(&String::from_utf8_lossy(&output.stderr))
        {
            self.switched = true;
            self.use_compatibility = !self.use_compatibility;
            let version = if self.use_compatibility {
                "兼容版 SVN 1.9.7"
            } else {
                "默认 SVN"
            };
            log(format!("SVN SSL 通信失败，正在自动切换至{version}重试…"));
            let first_error = output.stderr;
            output = runner(self.executable().to_path_buf(), command)
                .await
                .map_err(|error| {
                    format!(
                        "{error}\n首次 SVN 错误：{}",
                        String::from_utf8_lossy(&first_error)
                    )
                })?;
            if !output.status.success() {
                // Keep both attempts visible; callers still receive the actual last exit status.
                output
                    .stderr
                    .extend_from_slice(format!("\n{INITIAL_ERROR_MARKER}\n").as_bytes());
                output.stderr.extend_from_slice(&first_error);
            } else {
                log(format!("已自动切换至{version}，SVN 更新成功。"));
            }
        }
        if args.first() == Some(&"update") && output.status.success() {
            if let Some((path, server)) = self.preferences.as_ref().zip(self.server.as_ref()) {
                if let Err(error) = save_preference(path, server, self.use_compatibility) {
                    log(format!("SVN 更新成功，但未能保存兼容选择：{error}"));
                }
            }
        }
        Ok(output)
    }
}

fn command_args(args: &[&str], target: &Path) -> Vec<OsString> {
    args.iter()
        .map(OsString::from)
        .chain([target.as_os_str().to_owned()])
        .collect()
}

async fn execute(program: PathBuf, args: Vec<OsString>) -> Result<Output, String> {
    execute_with_config(program, args, None).await
}

async fn execute_with_config(program: PathBuf, args: Vec<OsString>, config: Option<&Path>) -> Result<Output, String> {
    let mut command = tokio::process::Command::new(program);
    if let Some(config) = config {
        command.env("OPENSSL_CONF", config);
    }
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000);
    // Finder/Dock launches may have no locale (or a non-UTF-8 LC_ALL). SVN
    // otherwise misdecodes Chinese paths before checking the working copy.
    #[cfg(target_os = "macos")]
    command.env("LANG", "en_US.UTF-8").env("LC_ALL", "en_US.UTF-8");
    command
        .args(args)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| format!("执行 SVN 失败: {error}"))
}

// Explicit local opt-in by exact HTTPS origin. No automatic downgrade for arbitrary servers.
fn legacy_tls_config(directory: &Path, server: &str) -> Option<PathBuf> {
    let content = std::fs::read(directory.join("svn-legacy-tls.json")).ok()?;
    let profiles: std::collections::BTreeMap<String, PathBuf> = serde_json::from_slice(&content).ok()?;
    let path = profiles.get(server)?;
    (path.is_absolute() && path.is_file()).then(|| path.clone())
}

fn is_ssl_communication_error(error: &str) -> bool {
    // An external may belong to another server; never pin its failure to the parent server.
    // Do not retry certificate trust, authentication, permission or working-copy failures.
    let upper = error.to_ascii_uppercase();
    upper.contains("E120171")
        && ![
            "E230001", "E215004", "E170001", "E175013", "E155", "E205011",
        ]
        .iter()
        .any(|code| upper.contains(code))
}

pub(crate) fn update_connection_failed(error: &str) -> bool {
    // The last attempt may have connected and reached ordinary conflict handling.
    let last_error = error.split(INITIAL_ERROR_MARKER).next().unwrap_or(error);
    [
        "E120171",
        "E170013",
        "E230001",
        "E215004",
        "E170001",
        "E175013",
        "执行 SVN 失败",
    ]
    .iter()
    .any(|code| last_error.contains(code))
}

fn server_key(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    (parsed.scheme() == "https" && parsed.host_str().is_some())
        .then(|| parsed.origin().ascii_serialization())
}

fn load_preferences(path: &Path) -> BTreeSet<String> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_preference(path: &Path, server: &str, compatibility: bool) -> Result<(), String> {
    let _guard = PREFERENCES_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut servers = load_preferences(path);
    let changed = if compatibility {
        servers.insert(server.to_owned())
    } else {
        servers.remove(server)
    };
    if !changed {
        return Ok(());
    }
    let content = serde_json::to_vec_pretty(&servers).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, content)
        .and_then(|()| std::fs::rename(&temp, path))
        .map_err(|error| {
            let _ = std::fs::remove_file(&temp);
            error.to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_tls_profile_is_exact_origin_and_requires_existing_absolute_file() {
        let fixture = Fixture::new();
        std::fs::create_dir_all(&fixture.directory).unwrap();
        let config = fixture.directory.join("legacy.cnf");
        std::fs::write(&config, "openssl_conf = default_conf\n").unwrap();
        std::fs::write(fixture.directory.join("svn-legacy-tls.json"),
            serde_json::to_vec(&serde_json::json!({"https://svn.example.test": config})).unwrap()).unwrap();
        assert_eq!(legacy_tls_config(&fixture.directory, "https://svn.example.test"), Some(config));
        assert!(legacy_tls_config(&fixture.directory, "https://svn.example.test:444").is_none());
        assert!(legacy_tls_config(&fixture.directory, "https://other.example.test").is_none());
        assert!(legacy_tls_config(&fixture.directory, "http://svn.example.test").is_none());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn legacy_tls_update_excludes_externals_and_never_bypasses_certificates() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        std::fs::create_dir_all(&fixture.directory).unwrap();
        let program = fixture.directory.join("svn");
        std::fs::write(&program, "#!/bin/sh\nprintf '%s\\n' \"$OPENSSL_CONF\" \"$@\"\necho 'svn: E230001: certificate not trusted' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut client = SvnClient::new(program, None, None, Some("https://svn.example.test/repo"));
        client.legacy_tls_config = Some(fixture.directory.join("legacy.cnf"));
        let output = client.run(&["update", "--non-interactive"], Path::new("project"), &|_| {}).await.unwrap();
        assert!(!output.status.success());
        let args = String::from_utf8(output.stdout).unwrap();
        assert!(args.contains("legacy.cnf"));
        assert!(args.contains("--ignore-externals"));
        assert!(!args.contains("--trust-server-cert"));
        client.trust_certificate = true;
        let output = client.run(&["update", "--non-interactive"], Path::new("project"), &|_| {}).await.unwrap();
        let args = String::from_utf8(output.stdout).unwrap();
        assert!(args.contains(CERTIFICATE_EXCEPTION));
        assert!(args.contains("--ignore-externals"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn mac_svn_process_has_an_explicit_utf8_locale() {
        let output = execute("/usr/bin/env".into(), Vec::new()).await.unwrap();
        assert!(output.status.success());
        let environment = String::from_utf8(output.stdout).unwrap();
        assert!(environment.lines().any(|line| line == "LANG=en_US.UTF-8"));
        assert!(environment.lines().any(|line| line == "LC_ALL=en_US.UTF-8"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires svn and svnadmin; run with LANG/LC_ALL unset and with LC_ALL=C"]
    async fn mac_svn_updates_chinese_paths_through_production_runner() {
        let fixture = Fixture::new();
        std::fs::create_dir_all(&fixture.directory).unwrap();
        let repo = fixture.directory.join("repository");
        let project = fixture.directory.join("客户端 with spaces");
        let output = execute("svnadmin".into(), vec!["create".into(), repo.as_os_str().to_owned()]).await.unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let url = format!("file://{}", repo.display());
        for args in [
            command_args(&["checkout", &url, "--non-interactive"], &project),
            command_args(&["info", "--show-item", "wc-root"], &project),
            command_args(&["update", "--non-interactive", "--accept", "postpone"], &project),
            command_args(&["status", "--non-interactive"], &project),
        ] {
            let output = execute("svn".into(), args).await.unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        }
    }

    struct Fixture {
        directory: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                directory: std::env::temp_dir()
                    .join(format!("svn-client-test-{}", uuid::Uuid::new_v4())),
            }
        }
        fn preferences(&self) -> PathBuf {
            self.directory.join(PREFERENCES_FILE)
        }
        fn client(&self, url: &str) -> SvnClient {
            SvnClient::new(
                "current/svn.exe".into(),
                Some("compat/svn.exe".into()),
                Some(self.preferences()),
                Some(url),
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn output(error: &str) -> Output {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        Output {
            status: std::process::ExitStatus::from_raw(if error.is_empty() { 0 } else { 256 }),
            stdout: Vec::new(),
            stderr: error.as_bytes().to_vec(),
        }
    }

    const SSL_ERROR: &str = "svn: E170013: Unable to connect\nsvn: E120171: Error running context: An error occurred during SSL communication";

    #[tokio::test]
    async fn ssl_retry_preserves_arguments_and_remembers_only_this_server_across_install_paths() {
        let fixture = Fixture::new();
        let mut client = fixture.client("https://user:secret@svn.example.test/repo/game");
        let mut calls = Vec::new();
        let args = ["update", "--non-interactive", "--accept", "postpone"];
        let target = Path::new("project with spaces/工程");
        let result = client
            .run_with(&args, target, &|_| {}, |program, arguments| {
                calls.push((program, arguments));
                std::future::ready(Ok(output(if calls.len() == 1 { SSL_ERROR } else { "" })))
            })
            .await
            .unwrap();
        assert!(result.status.success());
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, Path::new("current/svn.exe"));
        assert_eq!(calls[1].0, Path::new("compat/svn.exe"));
        assert_eq!(calls[0].1, calls[1].1);
        assert_eq!(calls[1].1.last().unwrap(), target.as_os_str());
        assert_eq!(
            std::fs::read_to_string(fixture.preferences()).unwrap(),
            "[\n  \"https://svn.example.test\"\n]"
        );
        let upgraded = SvnClient::new(
            "new-install/svn.exe".into(),
            Some("new-install/compat/svn.exe".into()),
            Some(fixture.preferences()),
            Some("https://svn.example.test/other-repo"),
        );
        assert_eq!(
            upgraded.executable(),
            Path::new("new-install/compat/svn.exe")
        );
        assert_eq!(
            fixture
                .client("https://other.example.test/repo")
                .executable(),
            Path::new("current/svn.exe")
        );
        assert_eq!(
            fixture
                .client("https://svn.example.test:8443/repo")
                .executable(),
            Path::new("current/svn.exe")
        );
    }

    #[tokio::test]
    async fn normal_success_auth_certificate_conflict_and_network_errors_do_not_retry() {
        let fixture = Fixture::new();
        for error in [
            "",
            "svn: E230001: Server SSL certificate verification failed",
            "svn: E215004: Authentication failed",
            "svn: E175013: Access denied",
            "svn: E155027: Tree conflict",
            "svn: E170013: Connection timed out",
            "svn: E120171: SSL\nsvn: E230001: certificate failed",
            "svn: E120171: SSL\nsvn: E205011: Failure occurred processing externals",
        ] {
            let mut calls = 0;
            fixture
                .client("https://svn.example.test/repo")
                .run_with(&["update"], Path::new("wc"), &|_| {}, |_, _| {
                    calls += 1;
                    std::future::ready(Ok(output(error)))
                })
                .await
                .unwrap();
            assert_eq!(calls, 1, "unexpected retry for {error}");
            assert!(!fixture.preferences().exists());
        }
    }

    #[tokio::test]
    async fn failed_fallback_is_bounded_retains_both_errors_and_is_not_saved() {
        let fixture = Fixture::new();
        let mut client = fixture.client("https://svn.example.test/repo");
        let mut calls = 0;
        let result = client
            .run_with(&["update"], Path::new("wc"), &|_| {}, |_, _| {
                calls += 1;
                std::future::ready(Ok(output(if calls == 1 {
                    SSL_ERROR
                } else {
                    "svn: E230001: certificate failed"
                })))
            })
            .await
            .unwrap();
        assert_eq!(calls, 2);
        assert!(!result.status.success());
        let error = String::from_utf8(result.stderr).unwrap();
        assert!(error.contains("E120171") && error.contains("E230001"));
        assert!(!fixture.preferences().exists());
        client
            .run_with(&["update"], Path::new("wc"), &|_| {}, |_, _| {
                calls += 1;
                std::future::ready(Ok(output(SSL_ERROR)))
            })
            .await
            .unwrap();
        assert_eq!(calls, 3);
    }

    #[tokio::test]
    async fn remembered_compatibility_can_recover_to_default_after_server_upgrade() {
        let fixture = Fixture::new();
        save_preference(&fixture.preferences(), "https://svn.example.test", true).unwrap();
        save_preference(&fixture.preferences(), "https://another.example.test", true).unwrap();
        let mut client = fixture.client("https://svn.example.test/repo");
        let mut programs = Vec::new();
        client
            .run_with(&["update"], Path::new("wc"), &|_| {}, |program, _| {
                programs.push(program);
                std::future::ready(Ok(output(if programs.len() == 1 { SSL_ERROR } else { "" })))
            })
            .await
            .unwrap();
        assert_eq!(
            programs,
            vec![
                PathBuf::from("compat/svn.exe"),
                PathBuf::from("current/svn.exe")
            ]
        );
        assert_eq!(
            load_preferences(&fixture.preferences()),
            BTreeSet::from(["https://another.example.test".to_owned()])
        );
        assert_eq!(
            fixture.client("https://svn.example.test/repo").executable(),
            Path::new("current/svn.exe")
        );
    }

    #[tokio::test]
    async fn local_commands_and_missing_compatibility_never_retry() {
        let fixture = Fixture::new();
        for operation in ["cleanup", "status", "revert", "resolve", "info", "update"] {
            let mut client = fixture.client("https://svn.example.test/repo");
            if operation == "update" {
                client.compatibility = None;
            }
            let mut calls = 0;
            client
                .run_with(&[operation], Path::new("wc"), &|_| {}, |_, _| {
                    calls += 1;
                    std::future::ready(Ok(output(SSL_ERROR)))
                })
                .await
                .unwrap();
            assert_eq!(calls, 1);
        }
    }

    #[test]
    fn server_keys_normalize_https_without_credentials_or_repository_paths() {
        assert_eq!(
            server_key("https://alice:secret@SVN.example.test:443/repo?q=secret#fragment"),
            Some("https://svn.example.test".into())
        );
        assert_eq!(
            server_key("https://[::1]:8443/repo"),
            Some("https://[::1]:8443".into())
        );
        assert_eq!(server_key("file:///repo"), None);
        assert_eq!(server_key("http://svn.example.test/repo"), None);
        assert_eq!(server_key("invalid"), None);
    }

    #[test]
    fn last_attempt_decides_whether_conflict_handling_can_continue() {
        let conflict_after_retry =
            format!("svn: E155027: Tree conflict\n{INITIAL_ERROR_MARKER}\n{SSL_ERROR}");
        assert!(!update_connection_failed(&conflict_after_retry));
        for error in [
            SSL_ERROR,
            "svn: E230001: Certificate failed",
            "svn: E175013: Access denied",
            "执行 SVN 失败: missing DLL",
        ] {
            assert!(update_connection_failed(error));
        }
    }
}
