use std::cmp::Ordering;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::types::AgentRuntimeUpdateInfo;

const CONFIG_FILE_NAME: &str = "svn-update.json";
const MANIFEST_FILE_NAME: &str = "latest.json";
const WINDOWS_PLATFORM: &str = "windows-x86_64";
const REQUIRED_DIRECTORY_NAME: &str = "navicat";
const BACKGROUND_CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
const UPDATE_AVAILABLE_EVENT: &str = "svn-update-available";

static UPDATE_CHECK_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SvnUpdateConfig {
    pub directory: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnCheckResponse {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
    pub installer_path: Option<String>,
    pub directory: Option<String>,
    pub needs_directory: bool,
    pub agent_runtime_update: Option<AgentRuntimeUpdateInfo>,
}

#[derive(Debug, serde::Deserialize)]
struct UpdateManifest {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
    platforms: std::collections::HashMap<String, ManifestPlatform>,
}

#[derive(Debug, serde::Deserialize)]
struct ManifestPlatform {
    path: String,
    #[allow(dead_code)]
    signature: Option<String>,
}

pub fn load_config(app: &AppHandle) -> SvnUpdateConfig {
    let Ok(path) = config_path(app) else {
        return SvnUpdateConfig::default();
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return SvnUpdateConfig::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

pub fn save_config(app: &AppHandle, config: &SvnUpdateConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建更新配置目录失败: {error}"))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("写入更新配置失败: {error}"))?;
    std::fs::write(path, format!("{content}\n"))
        .map_err(|error| format!("保存更新配置失败: {error}"))
}

pub async fn pick_directory(app: AppHandle) -> Result<Option<SvnUpdateConfig>, String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择 SVN 更新目录")
        .pick_folder()
        .await;
    let Some(folder) = folder else {
        return Ok(None);
    };
    validate_directory_name(folder.path())?;
    let config = SvnUpdateConfig {
        directory: Some(folder.path().to_string_lossy().to_string()),
    };
    save_config(&app, &config)?;
    Ok(Some(config))
}

pub fn check(app: &AppHandle) -> Result<SvnCheckResponse, String> {
    let _guard = UPDATE_CHECK_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    check_locked(app)
}

pub fn spawn_background_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(BACKGROUND_CHECK_INTERVAL).await;
            let check_app = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || try_check(&check_app)).await;
            let Ok(Some(Ok(response))) = result else {
                continue;
            };
            if response.available
                || response
                    .agent_runtime_update
                    .as_ref()
                    .is_some_and(|update| update.available)
            {
                let _ = app.emit(UPDATE_AVAILABLE_EVENT, response);
            }
        }
    });
}

fn try_check(app: &AppHandle) -> Option<Result<SvnCheckResponse, String>> {
    let Ok(_guard) = UPDATE_CHECK_LOCK.try_lock() else {
        return None;
    };
    Some(check_locked(app))
}

fn check_locked(app: &AppHandle) -> Result<SvnCheckResponse, String> {
    let current_version = app.package_info().version.to_string();
    let Some(directory) = resolve_update_directory(app)? else {
        return Ok(SvnCheckResponse {
            available: false,
            current_version,
            version: None,
            date: None,
            body: None,
            installer_path: None,
            directory: None,
            needs_directory: true,
            agent_runtime_update: None,
        });
    };

    run_svn_update(app, &directory)?;

    let manifest = read_manifest(&directory)?;
    let platform = manifest
        .platforms
        .get(WINDOWS_PLATFORM)
        .ok_or_else(|| "latest.json 缺少 windows-x86_64 安装包信息".to_string())?;
    let installer_path = resolve_manifest_path(&directory, &platform.path)?;
    if !installer_path.is_file() {
        return Err(format!(
            "安装包不存在: {}",
            installer_path.to_string_lossy()
        ));
    }

    let available = compare_versions(&manifest.version, &current_version) == Ordering::Greater;
    Ok(SvnCheckResponse {
        available,
        current_version,
        version: Some(manifest.version),
        date: manifest.pub_date,
        body: manifest.notes,
        installer_path: Some(installer_path.to_string_lossy().to_string()),
        directory: Some(directory.to_string_lossy().to_string()),
        needs_directory: false,
        agent_runtime_update: None,
    })
}

pub(crate) fn refresh_update_directory(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let _guard = UPDATE_CHECK_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(directory) = configured_update_directory(app)? else {
        return Ok(None);
    };
    run_svn_update(app, &directory)?;
    Ok(Some(directory))
}

pub(crate) fn configured_update_directory(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    resolve_update_directory(app)
}

pub fn install(installer_path: String) -> Result<(), String> {
    let path = PathBuf::from(installer_path);
    if !path.is_file() {
        return Err(format!("安装包不存在: {}", path.to_string_lossy()));
    }
    Command::new(&path)
        .spawn()
        .map_err(|error| format!("启动安装包失败: {error}"))?;
    Ok(())
}

pub fn open_update_directory(path: String) -> Result<(), String> {
    open_directory(Path::new(&path))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(CONFIG_FILE_NAME))
        .map_err(|error| format!("无法读取应用配置目录: {error}"))
}

fn read_manifest(directory: &Path) -> Result<UpdateManifest, String> {
    let path = directory.join(MANIFEST_FILE_NAME);
    let content = std::fs::read_to_string(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            if !directory.is_dir() {
                return format!("SVN 更新目录不存在: {}", directory.to_string_lossy());
            }
            return format!(
                "所选 SVN 更新目录中没有 latest.json：{}。请选择包含 latest.json 的发布目录，或让发布者先提交 latest.json。",
                directory.to_string_lossy()
            );
        }
        format!("读取 latest.json 失败（{}）：{error}", path.to_string_lossy())
    })?;
    serde_json::from_str(&content).map_err(|error| format!("latest.json 格式不正确: {error}"))
}

fn run_svn_update(app: &AppHandle, directory: &Path) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        let mut svn = crate::svn_client::SvnClient::for_working_copy(app, directory).await?;
        run_svn_command(&mut svn, "cleanup", directory).await?;
        run_svn_command(&mut svn, "update", directory).await
    })
}

pub(crate) fn svn_not_found_message() -> String {
    if cfg!(target_os = "windows") {
        "没有找到随附的 SVN 命令行。请重新安装黑猫，或安装 SVN 命令行工具后重试。".to_string()
    } else {
        "没有找到 svn。请安装 SVN 命令行工具后重新启动应用。".to_string()
    }
}

async fn run_svn_command(
    svn: &mut crate::svn_client::SvnClient,
    operation: &str,
    directory: &Path,
) -> Result<(), String> {
    let output = svn
        .run(&[operation, "--non-interactive"], directory, &|line| {
            eprintln!("[svn] {line}");
        })
        .await?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let details = [stdout, stderr]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if details.is_empty() {
        Err(format!("SVN {operation} 失败: {}", output.status))
    } else {
        Err(format!(
            "SVN {operation} 失败: {}\n{}",
            output.status, details
        ))
    }
}

fn is_c_drive_root(path: &Path) -> bool {
    let text = path.to_string_lossy();
    let trimmed = text.trim_end_matches(['\\', '/']);
    trimmed.eq_ignore_ascii_case("C:")
}

fn is_valid_update_dir(path: &Path) -> bool {
    validate_directory_name(path).is_ok() && path.join(MANIFEST_FILE_NAME).is_file()
}

fn join_rel(root: &Path, parts: &[&str]) -> PathBuf {
    parts.iter().fold(root.to_path_buf(), |acc, part| acc.join(part))
}

fn push_unique(found: &mut Vec<PathBuf>, path: PathBuf) {
    if !found.iter().any(|existing| existing == &path) {
        found.push(path);
    }
}

fn collect_update_dirs_from_root(root: &Path, found: &mut Vec<PathBuf>) {
    let preferred = join_rel(root, &["开发工具", "Navicat Pro"]);
    if is_valid_update_dir(&preferred) {
        push_unique(found, preferred);
    }
    let tools = root.join("开发工具");
    if let Ok(entries) = std::fs::read_dir(&tools) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && is_valid_update_dir(&path) {
                push_unique(found, path);
            }
        }
    }
    if is_valid_update_dir(root) {
        push_unique(found, root.to_path_buf());
    }
}

fn manifest_version(directory: &Path) -> Option<String> {
    let content = std::fs::read_to_string(directory.join(MANIFEST_FILE_NAME)).ok()?;
    let manifest: UpdateManifest = serde_json::from_str(&content).ok()?;
    let version = manifest.version.trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn pick_newest_update_dir(dirs: Vec<PathBuf>) -> Option<PathBuf> {
    dirs.into_iter().max_by(|left, right| {
        let left_version = manifest_version(left).unwrap_or_default();
        let right_version = manifest_version(right).unwrap_or_default();
        compare_versions(&left_version, &right_version).then_with(|| left.cmp(right))
    })
}

fn discover_in_roots(roots: &[PathBuf]) -> Option<PathBuf> {
    let mut found = Vec::new();
    for root in roots {
        if is_c_drive_root(root) {
            continue;
        }
        collect_update_dirs_from_root(root, &mut found);
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_update_dirs_from_root(&path, &mut found);
            }
        }
    }
    pick_newest_update_dir(found)
}

fn search_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        (b'D'..=b'Z')
            .filter_map(|letter| {
                let root = PathBuf::from(format!("{}:\\", letter as char));
                root.exists().then_some(root)
            })
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

fn discover_update_directory() -> Option<PathBuf> {
    discover_in_roots(&search_roots())
}

fn resolve_update_directory(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let config = load_config(app);
    if let Some(directory) = config
        .directory
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let directory = PathBuf::from(directory);
        if directory.is_dir() && validate_directory_name(&directory).is_ok() {
            return Ok(Some(directory));
        }
    }
    let Some(found) = discover_update_directory() else {
        return Ok(None);
    };
    let config = SvnUpdateConfig {
        directory: Some(found.to_string_lossy().into_owned()),
    };
    let _ = save_config(app, &config);
    Ok(Some(found))
}

fn validate_directory_name(directory: &Path) -> Result<(), String> {
    let name = directory
        .file_name()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name.contains(REQUIRED_DIRECTORY_NAME) {
        Ok(())
    } else {
        Err("SVN 更新文件夹名称必须包含 navicat（不区分大小写）".to_string())
    }
}

pub(crate) fn resolve_svn_exe(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        pick_windows_svn_exe(
            find_tortoise_svn().as_deref(),
            find_on_path("svn.exe").as_deref(),
            bundled_svn_exe(app).as_deref(),
        )
    } else {
        find_on_path("svn").or_else(find_svn_in_standard_locations)
    }
}

fn tortoise_svn_from_program_files(program_files: &Path) -> PathBuf {
    program_files
        .join("TortoiseSVN")
        .join("bin")
        .join("svn.exe")
}

fn tortoise_program_files_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(value) = std::env::var_os(key) {
            let path = PathBuf::from(value);
            if !roots.contains(&path) {
                roots.push(path);
            }
        }
    }
    for fallback in [r"C:\Program Files", r"C:\Program Files (x86)"] {
        let path = PathBuf::from(fallback);
        if !roots.contains(&path) {
            roots.push(path);
        }
    }
    roots
}

fn find_tortoise_svn() -> Option<PathBuf> {
    tortoise_program_files_roots()
        .into_iter()
        .map(|root| tortoise_svn_from_program_files(&root))
        .find(|path| path.is_file())
}

fn bundled_svn_exe(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let bundled = resource_dir.join("svn").join("svn.exe");
    bundled.is_file().then_some(bundled)
}

fn pick_windows_svn_exe(
    tortoise: Option<&Path>,
    path_svn: Option<&Path>,
    bundled: Option<&Path>,
) -> Option<PathBuf> {
    [tortoise, path_svn, bundled]
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
        .map(Path::to_path_buf)
}

fn find_svn_in_standard_locations() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME") {
            let local = PathBuf::from(home).join(".local/bin/svn");
            if local.is_file() {
                return Some(local);
            }
        }
    }
    let locations: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/bin/svn",
            "/usr/local/bin/svn",
            "/usr/bin/svn",
        ]
    } else {
        &["/usr/local/bin/svn", "/usr/bin/svn"]
    };
    locations
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

pub(crate) fn resolve_manifest_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let trimmed = relative.trim();
    if trimmed.is_empty() {
        return Err("latest.json 中的安装包路径为空".to_string());
    }
    let relative_path = Path::new(trimmed);
    if relative_path.is_absolute() {
        return Err("latest.json 中的安装包路径必须是相对路径".to_string());
    }
    if relative_path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("latest.json 中的安装包路径不能跳出 SVN 更新目录".to_string());
    }
    Ok(root.join(relative_path))
}

pub(crate) fn compare_versions(left: &str, right: &str) -> Ordering {
    let left_parts = parse_version_parts(left);
    let right_parts = parse_version_parts(right);
    let max_len = left_parts.len().max(right_parts.len());
    for index in 0..max_len {
        let left_value = *left_parts.get(index).unwrap_or(&0);
        let right_value = *right_parts.get(index).unwrap_or(&0);
        match left_value.cmp(&right_value) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    Ordering::Equal
}

fn parse_version_parts(version: &str) -> Vec<u64> {
    version
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

fn open_directory(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        Command::new("explorer.exe")
            .arg(explorer_directory_arg(path))
            .spawn()
            .map_err(|error| format!("打开资源管理器失败: {error}"))?;
        Ok(())
    } else if cfg!(target_os = "macos") {
        open_directory_with_status("open", path)
    } else {
        open_directory_with_status("xdg-open", path)
    }
}

fn open_directory_with_status(program: &str, path: &Path) -> Result<(), String> {
    let status = Command::new(program)
        .arg(path)
        .status()
        .map_err(|error| format!("打开文件夹失败: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("打开文件夹失败: {status}"))
    }
}

fn explorer_directory_arg(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        value.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEMP_DIR_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    struct TestTempDir {
        path: PathBuf,
    }

    impl TestTempDir {
        fn create(prefix: &str) -> Self {
            let path = unique_temp_path(prefix);
            std::fs::create_dir(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn unique_temp_path(prefix: &str) -> PathBuf {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = TEMP_DIR_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "{prefix}-{}-{timestamp}-{counter}",
            std::process::id()
        ))
    }

    fn write_latest_json(dir: &Path) {
        write_latest_json_version(dir, "0.1.0");
    }

    fn write_latest_json_version(dir: &Path, version: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("latest.json"),
            format!(r#"{{"version":"{version}","platforms":{{}}}}"#),
        )
        .unwrap();
    }

    #[test]
    fn discovers_navicat_pro_under_planner_tools() {
        let temp = TestTempDir::create("svn-update-discover");
        let wanted = temp
            .path()
            .join("策划2策划目录0902")
            .join("开发工具")
            .join("Navicat Pro");
        write_latest_json(&wanted);
        let decoy = temp
            .path()
            .join("策划2策划目录0902")
            .join("开发工具")
            .join("黑猫");
        write_latest_json(&decoy);

        let found = discover_in_roots(&[temp.path().to_path_buf()]).expect("should find Navicat Pro");
        assert_eq!(found, wanted);
    }

    #[test]
    fn discover_picks_the_newest_latest_json_when_several_copies_exist() {
        let temp = TestTempDir::create("svn-update-newest");
        let older = temp
            .path()
            .join("aaa-old")
            .join("开发工具")
            .join("Navicat Pro");
        let newer = temp
            .path()
            .join("zzz-new")
            .join("开发工具")
            .join("Navicat Pro");
        write_latest_json_version(&older, "0.1.40");
        write_latest_json_version(&newer, "0.1.44");

        let found = discover_in_roots(&[temp.path().to_path_buf()]).expect("should pick a copy");
        assert_eq!(found, newer);
    }

    #[test]
    fn discover_skips_c_drive_root() {
        assert!(is_c_drive_root(Path::new(r"C:\")));
        assert!(!is_c_drive_root(Path::new(r"G:\策划2策划目录0902")));
    }

    fn write_dummy_exe(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, b"").unwrap();
    }

    #[test]
    fn tortoise_svn_path_is_under_program_files() {
        assert_eq!(
            tortoise_svn_from_program_files(Path::new(r"C:\Program Files")),
            PathBuf::from(r"C:\Program Files\TortoiseSVN\bin\svn.exe")
        );
    }

    #[test]
    fn windows_svn_prefers_tortoise_over_bundled() {
        let temp = TestTempDir::create("svn-prefer-tortoise");
        let tortoise = temp.path().join("TortoiseSVN").join("bin").join("svn.exe");
        let bundled = temp.path().join("resources").join("svn").join("svn.exe");
        write_dummy_exe(&tortoise);
        write_dummy_exe(&bundled);
        assert_eq!(
            pick_windows_svn_exe(Some(&tortoise), None, Some(&bundled)),
            Some(tortoise)
        );
    }

    #[test]
    fn windows_svn_prefers_path_over_bundled_when_tortoise_is_missing() {
        let temp = TestTempDir::create("svn-prefer-path");
        let path_svn = temp.path().join("path").join("svn.exe");
        let bundled = temp.path().join("resources").join("svn").join("svn.exe");
        write_dummy_exe(&path_svn);
        write_dummy_exe(&bundled);
        assert_eq!(
            pick_windows_svn_exe(None, Some(&path_svn), Some(&bundled)),
            Some(path_svn)
        );
    }

    #[test]
    fn windows_svn_falls_back_to_bundled_without_tortoise() {
        let temp = TestTempDir::create("svn-fallback-bundled");
        let missing_tortoise = temp
            .path()
            .join("TortoiseSVN")
            .join("bin")
            .join("svn.exe");
        let bundled = temp.path().join("resources").join("svn").join("svn.exe");
        write_dummy_exe(&bundled);
        assert_eq!(
            pick_windows_svn_exe(Some(&missing_tortoise), None, Some(&bundled)),
            Some(bundled)
        );
    }

    #[test]
    fn version_comparison_handles_dotted_numeric_versions() {
        assert_eq!(compare_versions("0.1.5", "0.1.4"), Ordering::Greater);
        assert_eq!(compare_versions("0.1.4", "0.1.4"), Ordering::Equal);
        assert_eq!(compare_versions("0.1.4", "0.2.0"), Ordering::Less);
        assert_eq!(compare_versions("0.10.0", "0.2.9"), Ordering::Greater);
    }

    #[test]
    fn manifest_path_must_stay_inside_update_directory() {
        let root = Path::new("updates");
        assert_eq!(
            resolve_manifest_path(root, "blackcat_0.1.5_x64-setup.exe").unwrap(),
            root.join("blackcat_0.1.5_x64-setup.exe")
        );
        assert!(resolve_manifest_path(root, "../other.exe").is_err());
    }

    #[test]
    fn update_directory_name_requires_navicat_in_the_leaf_folder() {
        assert!(validate_directory_name(Path::new("updates/NavicatRelease")).is_ok());
        assert!(validate_directory_name(Path::new("updates/NAVICAT-release")).is_ok());
        assert!(validate_directory_name(Path::new("navicat/release")).is_err());
        assert!(validate_directory_name(Path::new("updates/blackcat-release")).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_manifest_paths_reject_parent_and_drive_prefixes() {
        let root = Path::new(r"E:\updates");
        assert!(resolve_manifest_path(root, r"..\other.exe").is_err());
        assert!(resolve_manifest_path(root, r"C:\other.exe").is_err());
    }

    #[test]
    fn parses_local_manifest_with_relative_installer_path() {
        let manifest: UpdateManifest = serde_json::from_str(
            r#"{
              "version": "0.1.5",
              "notes": "Release notes",
              "pub_date": "2026-06-28T12:00:00Z",
              "platforms": {
                "windows-x86_64": {
                  "path": "blackcat_0.1.5_x64-setup.exe",
                  "signature": "abc"
                }
              }
            }"#,
        )
        .unwrap();

        let platform = manifest.platforms.get(WINDOWS_PLATFORM).unwrap();
        assert_eq!(manifest.version, "0.1.5");
        assert_eq!(manifest.notes.as_deref(), Some("Release notes"));
        assert_eq!(platform.path, "blackcat_0.1.5_x64-setup.exe");
    }

    #[test]
    fn missing_manifest_reports_selected_directory_and_next_step() {
        let directory = TestTempDir::create("dbscout-missing-manifest");

        let error = read_manifest(directory.path()).unwrap_err();

        assert!(error.contains("所选 SVN 更新目录中没有 latest.json"));
        assert!(error.contains(&directory.path().to_string_lossy().to_string()));
        assert!(error.contains("请选择包含 latest.json 的发布目录"));
    }

    #[test]
    fn missing_manifest_distinguishes_disappeared_directory() {
        let directory = unique_temp_path("dbscout-missing-directory");

        let error = read_manifest(&directory).unwrap_err();

        assert!(error.contains("SVN 更新目录不存在"));
        assert!(error.contains(&directory.to_string_lossy().to_string()));
        assert!(!error.contains("没有 latest.json"));
    }

    #[test]
    fn explorer_arg_strips_windows_verbatim_prefixes() {
        assert_eq!(
            explorer_directory_arg(Path::new(r"\\?\E:\updates")),
            r"E:\updates"
        );
        assert_eq!(
            explorer_directory_arg(Path::new(r"\\?\UNC\server\share\updates")),
            r"\\server\share\updates"
        );
    }
}
