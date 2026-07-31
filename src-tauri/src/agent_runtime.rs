use std::cmp::Ordering;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;
use zip::ZipArchive;

use crate::svn_updater;
use crate::types::{
    AgentRuntimeProgressPayload, AgentRuntimeStatusResponse, AgentRuntimeUpdateInfo,
};

const MANIFEST_FILE_NAME: &str = "agent-runtime.json";
const RUNTIME_DIRECTORY_NAME: &str = "agent-runtime";
const STATE_FILE_NAME: &str = "state.json";
const PREVIOUS_STATE_FILE_NAME: &str = "state.previous.json";
const PROGRESS_EVENT: &str = "agent-runtime-progress";
const MAX_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

static INSTALL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeManifest {
    version: u64,
    min_app_version: String,
    package: String,
    sha256: String,
    size: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct InstalledRuntimeState {
    version: u64,
    sha256: String,
    install_dir: String,
    installed_at: u64,
    files: Vec<RuntimeFileFingerprint>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeFileFingerprint {
    path: String,
    size: u64,
    sha256: String,
    modified_at: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentRuntimePaths {
    pub node_path: PathBuf,
    pub native_cli_path: PathBuf,
    pub version: Option<u64>,
}

#[derive(Debug, Default)]
struct LocalInspection {
    state: Option<InstalledRuntimeState>,
    installed_version: Option<u64>,
    error: Option<String>,
}

trait RuntimePackageSource {
    fn size(&self) -> Result<u64, String>;

    fn copy_and_hash(
        &self,
        destination: &Path,
        on_progress: &mut dyn FnMut(u64),
    ) -> Result<String, String>;
}

struct LocalFilePackageSource {
    path: PathBuf,
}

impl RuntimePackageSource for LocalFilePackageSource {
    fn size(&self) -> Result<u64, String> {
        fs::metadata(&self.path)
            .map(|metadata| metadata.len())
            .map_err(|error| {
                format!(
                    "读取 AI 组件包大小失败（{}）：{error}",
                    self.path.to_string_lossy()
                )
            })
    }

    fn copy_and_hash(
        &self,
        destination: &Path,
        on_progress: &mut dyn FnMut(u64),
    ) -> Result<String, String> {
        let source = File::open(&self.path).map_err(|error| {
            format!(
                "打开 AI 组件包失败（{}）：{error}",
                self.path.to_string_lossy()
            )
        })?;
        let destination_file = File::create(destination)
            .map_err(|error| format!("创建 AI 组件临时文件失败: {error}"))?;
        let mut reader = BufReader::with_capacity(COPY_BUFFER_BYTES, source);
        let mut writer = BufWriter::with_capacity(COPY_BUFFER_BYTES, destination_file);
        let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;

        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| format!("读取 AI 组件包失败: {error}"))?;
            if read == 0 {
                break;
            }
            writer
                .write_all(&buffer[..read])
                .map_err(|error| format!("复制 AI 组件包失败: {error}"))?;
            hasher.update(&buffer[..read]);
            copied = copied.saturating_add(read as u64);
            on_progress(copied);
        }
        writer
            .flush()
            .map_err(|error| format!("写入 AI 组件临时文件失败: {error}"))?;
        Ok(format!("{:x}", hasher.finalize()))
    }
}

struct StagingDirectory(PathBuf);

impl StagingDirectory {
    fn create(root: &Path) -> Result<Self, String> {
        let path = root.join(format!(".staging-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).map_err(|error| format!("创建 AI 组件临时目录失败: {error}"))?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn status(app: &AppHandle) -> Result<AgentRuntimeStatusResponse, String> {
    if let Some(paths) = development_runtime_paths(app) {
        return Ok(ready_status(
            paths.version,
            "开发模式正在使用项目内的 AI 组件".into(),
        ));
    }

    let root = runtime_root(app)?;
    let local = inspect_local_runtime(&root, false);
    Ok(match local.state {
        Some(state) => ready_status(Some(state.version), "AI 组件已就绪".into()),
        None => AgentRuntimeStatusResponse {
            state: "needInstall".into(),
            ready: false,
            installed_version: local.installed_version,
            available_version: None,
            size: None,
            update_available: false,
            needs_directory: false,
            min_app_version: None,
            message: local
                .error
                .unwrap_or_else(|| "首次使用前需要安装 AI 组件".into()),
        },
    })
}

pub fn check(app: &AppHandle) -> Result<AgentRuntimeStatusResponse, String> {
    if development_runtime_paths(app).is_some() {
        return status(app);
    }

    let root = runtime_root(app)?;
    let local = inspect_local_runtime(&root, true);
    let Some(directory) = svn_updater::refresh_update_directory(app)? else {
        return Ok(status_without_manifest(
            local,
            true,
            "请先选择公司 SVN 更新目录，再安装 AI 组件",
        ));
    };
    let Some(manifest) = read_manifest_optional(&directory)? else {
        return Ok(status_without_manifest(
            local,
            false,
            "当前 SVN 发布目录还没有 AI 组件包",
        ));
    };

    evaluate_manifest(app, &directory, manifest, local)
}

pub fn install(app: &AppHandle) -> Result<AgentRuntimeStatusResponse, String> {
    if development_runtime_paths(app).is_some() {
        return status(app);
    }

    let _guard = INSTALL_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(directory) = svn_updater::configured_update_directory(app)? else {
        return Err("请先选择公司 SVN 更新目录，再重试安装 AI 组件".into());
    };
    let manifest = read_manifest_optional(&directory)?
        .ok_or_else(|| "当前 SVN 发布目录还没有 agent-runtime.json".to_string())?;
    ensure_app_compatible(app, &manifest)?;

    let root = runtime_root(app)?;
    fs::create_dir_all(&root).map_err(|error| format!("创建 AI 组件目录失败: {error}"))?;
    let local = inspect_local_runtime(&root, true);
    if let Some(state) = local.state.as_ref() {
        match state.version.cmp(&manifest.version) {
            Ordering::Greater => {
                return Ok(ready_status(
                    Some(state.version),
                    "本地 AI 组件版本更新，已保留本地版本".into(),
                ));
            }
            Ordering::Equal => {
                return Ok(ready_status(
                    Some(state.version),
                    "AI 组件已是最新版本".into(),
                ));
            }
            Ordering::Less => {}
        }
    }

    let package_path = svn_updater::resolve_manifest_path(&directory, &manifest.package)?;
    if !package_path.is_file() {
        return Err(format!(
            "AI 组件包不存在: {}",
            package_path.to_string_lossy()
        ));
    }
    let source = LocalFilePackageSource { path: package_path };
    let actual_size = source.size()?;
    if actual_size != manifest.size {
        return Err(format!(
            "AI 组件包大小不匹配：清单为 {} 字节，实际为 {} 字节",
            manifest.size, actual_size
        ));
    }

    let staging = StagingDirectory::create(&root)?;
    let package_copy = staging.path().join("agent-runtime.zip");
    emit_progress(app, "copying", 0, 0, manifest.size, "正在获取 AI 组件");
    let actual_sha256 = source.copy_and_hash(&package_copy, &mut |copied| {
        let percent = scaled_percent(copied, manifest.size, 0, 55);
        emit_progress(
            app,
            "copying",
            percent,
            copied,
            manifest.size,
            "正在从 SVN 获取 AI 组件",
        );
    })?;
    verify_sha256(&actual_sha256, &manifest.sha256)?;
    emit_progress(
        app,
        "verifying",
        60,
        manifest.size,
        manifest.size,
        "AI 组件校验通过",
    );

    let payload_directory = staging.path().join("payload");
    fs::create_dir_all(&payload_directory)
        .map_err(|error| format!("创建 AI 组件解压目录失败: {error}"))?;
    emit_progress(
        app,
        "extracting",
        66,
        manifest.size,
        manifest.size,
        "正在安装 AI 组件",
    );
    extract_package(&package_copy, &payload_directory)?;

    let node_relative = expected_node_relative_path();
    let cli_relative = expected_cli_relative_path();
    let node_path = payload_directory.join(&node_relative);
    let cli_path = payload_directory.join(&cli_relative);
    if !node_path.is_file() || !cli_path.is_file() {
        return Err("AI 组件包缺少 Node 或 Claude CLI，已拒绝安装".into());
    }
    ensure_executable(&node_path)?;
    ensure_executable(&cli_path)?;

    let files = vec![
        fingerprint_file(&payload_directory, &node_relative)?,
        fingerprint_file(&payload_directory, &cli_relative)?,
    ];
    let versions_directory = root.join("versions");
    fs::create_dir_all(&versions_directory)
        .map_err(|error| format!("创建 AI 组件版本目录失败: {error}"))?;
    let install_dir_name = format!("v{}-{}", manifest.version, Uuid::new_v4());
    let final_directory = versions_directory.join(&install_dir_name);
    fs::rename(&payload_directory, &final_directory)
        .map_err(|error| format!("启用新的 AI 组件目录失败: {error}"))?;

    let new_state = InstalledRuntimeState {
        version: manifest.version,
        sha256: normalize_sha256(&manifest.sha256),
        install_dir: format!("versions/{install_dir_name}"),
        installed_at: unix_millis(),
        files,
    };
    emit_progress(
        app,
        "activating",
        94,
        manifest.size,
        manifest.size,
        "正在启用新的 AI 组件",
    );
    if let Err(error) = write_active_state(&root, &new_state, local.state.as_ref()) {
        let _ = fs::remove_dir_all(&final_directory);
        return Err(error);
    }
    cleanup_old_versions(&root, &new_state, local.state.as_ref());
    emit_progress(
        app,
        "ready",
        100,
        manifest.size,
        manifest.size,
        "AI 组件已就绪",
    );

    Ok(AgentRuntimeStatusResponse {
        state: "ready".into(),
        ready: true,
        installed_version: Some(manifest.version),
        available_version: Some(manifest.version),
        size: Some(manifest.size),
        update_available: false,
        needs_directory: false,
        min_app_version: Some(manifest.min_app_version),
        message: "AI 组件已安装；当前会话不受影响，重启黑猫后使用新版本".into(),
    })
}

pub(crate) fn available_update_from_directory(
    app: &AppHandle,
    directory: &Path,
) -> Result<Option<AgentRuntimeUpdateInfo>, String> {
    let Some(manifest) = read_manifest_optional(directory)? else {
        return Ok(None);
    };
    let package_path = svn_updater::resolve_manifest_path(directory, &manifest.package)?;
    if !package_path.is_file() {
        return Err(format!(
            "AI 组件包不存在: {}",
            package_path.to_string_lossy()
        ));
    }
    let local = inspect_local_runtime(&runtime_root(app)?, false);
    let app_compatible = app_meets_minimum_version(
        &app.package_info().version.to_string(),
        &manifest.min_app_version,
    );
    // First-time installation is deliberately deferred until the user opens
    // the AI panel. The global updater only announces upgrades for an already
    // installed runtime.
    let available = app_compatible
        && local
            .state
            .as_ref()
            .is_some_and(|state| state.version < manifest.version);
    Ok(Some(AgentRuntimeUpdateInfo {
        available,
        version: manifest.version,
        size: manifest.size,
    }))
}

pub(crate) fn resolve_runtime_paths(app: &AppHandle) -> Option<AgentRuntimePaths> {
    if let Some(paths) = development_runtime_paths(app) {
        return Some(paths);
    }
    let root = runtime_root(app).ok()?;
    let local = inspect_local_runtime(&root, false);
    if let Some(state) = local.state {
        let install_directory = safe_join(&root, &state.install_dir).ok()?;
        return Some(AgentRuntimePaths {
            node_path: install_directory.join(expected_node_relative_path()),
            native_cli_path: install_directory.join(expected_cli_relative_path()),
            version: Some(state.version),
        });
    }
    None
}

fn evaluate_manifest(
    app: &AppHandle,
    directory: &Path,
    manifest: AgentRuntimeManifest,
    local: LocalInspection,
) -> Result<AgentRuntimeStatusResponse, String> {
    let package_path = svn_updater::resolve_manifest_path(directory, &manifest.package)?;
    if !package_path.is_file() {
        return Ok(AgentRuntimeStatusResponse {
            state: "error".into(),
            ready: local.state.is_some(),
            installed_version: local.state.as_ref().map(|state| state.version),
            available_version: Some(manifest.version),
            size: Some(manifest.size),
            update_available: false,
            needs_directory: false,
            min_app_version: Some(manifest.min_app_version),
            message: format!("AI 组件包不存在: {}", package_path.to_string_lossy()),
        });
    }

    let app_version = app.package_info().version.to_string();
    let app_too_old = !app_meets_minimum_version(&app_version, &manifest.min_app_version);
    let local_state = local.state.as_ref();
    let installed_version = local_state
        .map(|state| state.version)
        .or(local.installed_version);
    let update_available =
        runtime_requires_install(local_state.map(|state| state.version), manifest.version);

    if app_too_old {
        let ready = local_state.is_some();
        return Ok(AgentRuntimeStatusResponse {
            state: "appUpdateRequired".into(),
            ready,
            installed_version,
            available_version: Some(manifest.version),
            size: Some(manifest.size),
            update_available,
            needs_directory: false,
            min_app_version: Some(manifest.min_app_version.clone()),
            message: if ready {
                format!(
                    "当前 AI 组件仍可使用；升级黑猫到 {} 后可安装 AI 组件 v{}",
                    manifest.min_app_version, manifest.version
                )
            } else {
                format!(
                    "请先升级黑猫到 {}，再安装 AI 组件",
                    manifest.min_app_version
                )
            },
        });
    }

    if let Some(state) = local_state {
        if state.version > manifest.version {
            return Ok(ready_status(
                Some(state.version),
                "本地 AI 组件版本更新，不会自动降级".into(),
            ));
        }
        if state.version == manifest.version {
            return Ok(AgentRuntimeStatusResponse {
                state: "ready".into(),
                ready: true,
                installed_version: Some(state.version),
                available_version: Some(manifest.version),
                size: Some(manifest.size),
                update_available: false,
                needs_directory: false,
                min_app_version: Some(manifest.min_app_version),
                message: "AI 组件已是最新版本".into(),
            });
        }
        return Ok(AgentRuntimeStatusResponse {
            state: "ready".into(),
            ready: true,
            installed_version: Some(state.version),
            available_version: Some(manifest.version),
            size: Some(manifest.size),
            update_available: true,
            needs_directory: false,
            min_app_version: Some(manifest.min_app_version),
            message: format!(
                "AI 组件 v{} 可继续使用，v{} 正在等待后台更新",
                state.version, manifest.version
            ),
        });
    }

    Ok(AgentRuntimeStatusResponse {
        state: "needInstall".into(),
        ready: false,
        installed_version,
        available_version: Some(manifest.version),
        size: Some(manifest.size),
        update_available: true,
        needs_directory: false,
        min_app_version: Some(manifest.min_app_version),
        message: local
            .error
            .map(|error| format!("本地 AI 组件需要修复：{error}"))
            .unwrap_or_else(|| "AI 组件可以安装".into()),
    })
}

fn status_without_manifest(
    local: LocalInspection,
    needs_directory: bool,
    missing_message: &str,
) -> AgentRuntimeStatusResponse {
    match local.state {
        Some(state) => AgentRuntimeStatusResponse {
            state: "ready".into(),
            ready: true,
            installed_version: Some(state.version),
            available_version: None,
            size: None,
            update_available: false,
            needs_directory,
            min_app_version: None,
            message: "现有 AI 组件可继续使用，暂时无法检查更新".into(),
        },
        None => AgentRuntimeStatusResponse {
            state: "error".into(),
            ready: false,
            installed_version: local.installed_version,
            available_version: None,
            size: None,
            update_available: false,
            needs_directory,
            min_app_version: None,
            message: local.error.unwrap_or_else(|| missing_message.into()),
        },
    }
}

fn ready_status(version: Option<u64>, message: String) -> AgentRuntimeStatusResponse {
    AgentRuntimeStatusResponse {
        state: "ready".into(),
        ready: true,
        installed_version: version,
        available_version: version,
        size: None,
        update_available: false,
        needs_directory: false,
        min_app_version: None,
        message,
    }
}

fn read_manifest_optional(directory: &Path) -> Result<Option<AgentRuntimeManifest>, String> {
    let path = directory.join(MANIFEST_FILE_NAME);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "读取 agent-runtime.json 失败（{}）：{error}",
                path.to_string_lossy()
            ))
        }
    };
    let manifest: AgentRuntimeManifest = serde_json::from_str(&content)
        .map_err(|error| format!("agent-runtime.json 格式不正确: {error}"))?;
    validate_manifest(&manifest)?;
    Ok(Some(manifest))
}

fn validate_manifest(manifest: &AgentRuntimeManifest) -> Result<(), String> {
    if manifest.version == 0 {
        return Err("agent-runtime.json 的 version 必须大于 0".into());
    }
    if !is_numeric_app_version(&manifest.min_app_version) {
        return Err("agent-runtime.json 的 minAppVersion 必须是数字版本号".into());
    }
    if manifest.package.trim().is_empty() {
        return Err("agent-runtime.json 缺少 package".into());
    }
    let sha = normalize_sha256(&manifest.sha256);
    if sha.len() != 64 || !sha.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("agent-runtime.json 的 sha256 必须是 64 位十六进制字符串".into());
    }
    if manifest.size == 0 {
        return Err("agent-runtime.json 的 size 必须大于 0".into());
    }
    Ok(())
}

fn ensure_app_compatible(app: &AppHandle, manifest: &AgentRuntimeManifest) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    if !app_meets_minimum_version(&current, &manifest.min_app_version) {
        return Err(format!(
            "请先升级黑猫到 {}，再安装 AI 组件",
            manifest.min_app_version
        ));
    }
    Ok(())
}

fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(RUNTIME_DIRECTORY_NAME))
        .map_err(|error| format!("无法读取应用数据目录: {error}"))
}

fn inspect_local_runtime(root: &Path, full_hash: bool) -> LocalInspection {
    let mut inspection = LocalInspection::default();
    for name in [STATE_FILE_NAME, PREVIOUS_STATE_FILE_NAME] {
        let path = root.join(name);
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                inspection.error.get_or_insert_with(|| {
                    format!("读取本地 AI 组件状态失败（{}）：{error}", path.display())
                });
                continue;
            }
        };
        let state: InstalledRuntimeState = match serde_json::from_str(&content) {
            Ok(state) => state,
            Err(error) => {
                inspection
                    .error
                    .get_or_insert_with(|| format!("本地 AI 组件状态损坏：{error}"));
                continue;
            }
        };
        inspection.installed_version = Some(
            inspection
                .installed_version
                .map_or(state.version, |current| current.max(state.version)),
        );
        match validate_installed_state(root, &state, full_hash) {
            Ok(()) => {
                inspection.state = Some(state);
                inspection.error = None;
                return inspection;
            }
            Err(error) => {
                inspection.error.get_or_insert(error);
            }
        }
    }
    inspection
}

fn validate_installed_state(
    root: &Path,
    state: &InstalledRuntimeState,
    full_hash: bool,
) -> Result<(), String> {
    if state.version == 0
        || normalize_sha256(&state.sha256).len() != 64
        || !state.sha256.chars().all(|ch| ch.is_ascii_hexdigit())
    {
        return Err("本地 AI 组件状态不完整".into());
    }
    let install_directory = safe_join(root, &state.install_dir)?;
    let expected = [
        portable_path(&expected_node_relative_path()),
        portable_path(&expected_cli_relative_path()),
    ];
    if state.files.len() != expected.len()
        || expected
            .iter()
            .any(|path| !state.files.iter().any(|file| &file.path == path))
    {
        return Err("本地 AI 组件状态缺少 Node 或 Claude CLI".into());
    }
    for fingerprint in &state.files {
        if !expected.contains(&fingerprint.path)
            || normalize_sha256(&fingerprint.sha256).len() != 64
            || !fingerprint.sha256.chars().all(|ch| ch.is_ascii_hexdigit())
        {
            return Err("本地 AI 组件文件状态不完整".into());
        }
        let path = safe_join(&install_directory, &fingerprint.path)?;
        let metadata =
            fs::metadata(&path).map_err(|_| format!("AI 组件文件缺失：{}", fingerprint.path))?;
        if !metadata.is_file() || metadata.len() != fingerprint.size {
            return Err(format!("AI 组件文件大小异常：{}", fingerprint.path));
        }
        let modified = modified_millis(&metadata);
        if full_hash || modified != fingerprint.modified_at {
            let actual = hash_file(&path)?;
            if actual != normalize_sha256(&fingerprint.sha256) {
                return Err(format!("AI 组件文件校验失败：{}", fingerprint.path));
            }
        }
    }
    Ok(())
}

fn development_runtime_paths(app: &AppHandle) -> Option<AgentRuntimePaths> {
    if !cfg!(debug_assertions) {
        return None;
    }
    development_resource_directories(app)
        .into_iter()
        .find_map(|resource_directory| {
            let node_path = candidate_in_directory(&resource_directory.join("node"), node_names())?;
            let native_cli_path = candidate_in_directory(&resource_directory, native_cli_names())?;
            Some(AgentRuntimePaths {
                node_path,
                native_cli_path,
                version: None,
            })
        })
}

fn development_resource_directories(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_directory) = app.path().resource_dir() {
        candidates.push(resource_directory);
    }
    if let Ok(executable) = std::env::current_exe() {
        let mut directory = executable.parent();
        while let Some(parent) = directory {
            let candidate = parent.join("src-tauri").join("resources");
            if candidate.is_dir() && !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
            directory = parent.parent();
        }
    }
    candidates
}

fn candidate_in_directory(directory: &Path, names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .map(|name| directory.join(name))
        .find(|candidate| candidate.is_file())
}

fn node_names() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        &["node.exe", "node"]
    } else {
        &["node", "node.exe"]
    }
}

fn native_cli_names() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        &["claude-code-native.exe", "claude-code-native"]
    } else {
        &["claude-code-native", "claude-code-native.exe"]
    }
}

fn expected_node_relative_path() -> PathBuf {
    PathBuf::from("node").join(node_names()[0])
}

fn expected_cli_relative_path() -> PathBuf {
    PathBuf::from(native_cli_names()[0])
}

fn extract_package(package_path: &Path, destination: &Path) -> Result<(), String> {
    let package =
        File::open(package_path).map_err(|error| format!("打开已校验的 AI 组件包失败: {error}"))?;
    let mut archive = ZipArchive::new(package)
        .map_err(|error| format!("AI 组件包不是有效的 ZIP 文件: {error}"))?;
    let expected_node = portable_path(&expected_node_relative_path());
    let expected_cli = portable_path(&expected_cli_relative_path());
    let mut extracted = std::collections::HashSet::new();
    let mut total_size = 0_u64;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 AI 组件包条目失败: {error}"))?;
        if entry.is_dir() {
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("AI 组件包不能包含符号链接".into());
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "AI 组件包包含不安全的文件路径".to_string())?
            .to_path_buf();
        let portable = portable_path(&enclosed);
        if portable != expected_node && portable != expected_cli {
            return Err(format!("AI 组件包包含未预期的文件：{portable}"));
        }
        if !extracted.insert(portable.clone()) {
            return Err(format!("AI 组件包包含重复文件：{portable}"));
        }
        total_size = total_size
            .checked_add(entry.size())
            .ok_or_else(|| "AI 组件包解压大小溢出".to_string())?;
        if total_size > MAX_UNCOMPRESSED_BYTES {
            return Err("AI 组件包解压后体积超过安全上限".into());
        }
        let output = destination.join(&enclosed);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建 AI 组件目录失败: {error}"))?;
        }
        let mut output_file =
            File::create(&output).map_err(|error| format!("创建 AI 组件文件失败: {error}"))?;
        std::io::copy(&mut entry, &mut output_file)
            .map_err(|error| format!("解压 AI 组件文件失败: {error}"))?;
    }

    if !extracted.contains(&expected_node) || !extracted.contains(&expected_cli) {
        return Err("AI 组件包缺少必需的 Node 或 Claude CLI 文件".into());
    }
    Ok(())
}

fn fingerprint_file(root: &Path, relative: &Path) -> Result<RuntimeFileFingerprint, String> {
    let path = root.join(relative);
    let metadata =
        fs::metadata(&path).map_err(|error| format!("读取 AI 组件文件信息失败: {error}"))?;
    Ok(RuntimeFileFingerprint {
        path: portable_path(relative),
        size: metadata.len(),
        sha256: hash_file(&path)?,
        modified_at: modified_millis(&metadata),
    })
}

fn hash_file(path: &Path) -> Result<String, String> {
    let file = File::open(path)
        .map_err(|error| format!("打开文件进行校验失败（{}）：{error}", path.display()))?;
    let mut reader = BufReader::with_capacity(COPY_BUFFER_BYTES, file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取文件进行校验失败（{}）：{error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_sha256(actual: &str, expected: &str) -> Result<(), String> {
    if normalize_sha256(actual) != normalize_sha256(expected) {
        return Err("AI 组件包 SHA-256 校验失败，已拒绝安装；请重新获取后再试".into());
    }
    Ok(())
}

fn is_numeric_app_version(version: &str) -> bool {
    let core = version
        .trim()
        .split_once(['-', '+'])
        .map_or(version.trim(), |(core, _)| core);
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() >= 2
        && parts.len() <= 4
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn app_meets_minimum_version(current: &str, minimum: &str) -> bool {
    is_numeric_app_version(current)
        && is_numeric_app_version(minimum)
        && svn_updater::compare_versions(minimum, current) != Ordering::Greater
}

fn runtime_requires_install(installed: Option<u64>, available: u64) -> bool {
    installed.map_or(true, |version| version < available)
}

fn normalize_sha256(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn write_active_state(
    root: &Path,
    state: &InstalledRuntimeState,
    previous: Option<&InstalledRuntimeState>,
) -> Result<(), String> {
    if let Some(previous) = previous {
        write_json_replace(&root.join(PREVIOUS_STATE_FILE_NAME), previous)?;
    }
    write_json_replace(&root.join(STATE_FILE_NAME), state)
}

fn write_json_replace<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("序列化 AI 组件状态失败: {error}"))?;
    let temp_path = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(&temp_path, format!("{content}\n"))
        .map_err(|error| format!("写入 AI 组件状态临时文件失败: {error}"))?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("替换 AI 组件状态失败: {error}"))?;
    }
    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!("启用 AI 组件状态失败: {error}")
    })
}

fn cleanup_old_versions(
    root: &Path,
    current: &InstalledRuntimeState,
    previous: Option<&InstalledRuntimeState>,
) {
    let versions = root.join("versions");
    let Ok(entries) = fs::read_dir(&versions) else {
        return;
    };
    let keep = [
        current.install_dir.as_str(),
        previous
            .map(|state| state.install_dir.as_str())
            .unwrap_or(""),
    ];
    for entry in entries.flatten() {
        let relative = format!("versions/{}", entry.file_name().to_string_lossy());
        if keep.contains(&relative.as_str()) {
            continue;
        }
        let _ = fs::remove_dir_all(entry.path());
    }
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative.trim());
    if relative.trim().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("本地 AI 组件状态包含不安全的文件路径".into());
    }
    Ok(root.join(path))
}

fn portable_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn emit_progress(
    app: &AppHandle,
    stage: &str,
    percent: u8,
    downloaded_bytes: u64,
    total_bytes: u64,
    message: &str,
) {
    let _ = app.emit(
        PROGRESS_EVENT,
        AgentRuntimeProgressPayload {
            stage: stage.into(),
            percent,
            downloaded_bytes,
            total_bytes,
            message: message.into(),
        },
    );
}

pub(crate) fn emit_install_error(app: &AppHandle, message: &str) {
    emit_progress(app, "error", 0, 0, 0, message);
}

fn scaled_percent(value: u64, total: u64, start: u8, end: u8) -> u8 {
    if total == 0 {
        return start;
    }
    let span = u64::from(end.saturating_sub(start));
    u64::from(start)
        .saturating_add(value.min(total).saturating_mul(span) / total)
        .min(100) as u8
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("读取 AI 组件执行权限失败: {error}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("设置 AI 组件执行权限失败: {error}"))
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRuntimeRoot(PathBuf);

    impl TestRuntimeRoot {
        fn create() -> Self {
            let path =
                std::env::temp_dir().join(format!("dbscout-agent-runtime-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestRuntimeRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_integer_version_manifest() {
        let manifest: AgentRuntimeManifest = serde_json::from_str(
            r#"{
              "version": 3,
              "minAppVersion": "0.1.28",
              "package": "agent-runtime-v3-win-x64.zip",
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "size": 118000000
            }"#,
        )
        .unwrap();
        validate_manifest(&manifest).unwrap();
        assert_eq!(manifest.version, 3);
        assert_eq!(manifest.min_app_version, "0.1.28");
    }

    #[test]
    fn package_hash_mismatch_is_rejected() {
        let error = verify_sha256(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .unwrap_err();
        assert!(error.contains("SHA-256 校验失败"));
        assert!(error.contains("拒绝安装"));
    }

    #[test]
    fn local_state_paths_cannot_escape_runtime_root() {
        let root = Path::new("runtime");
        assert_eq!(
            safe_join(root, "versions/v3").unwrap(),
            root.join("versions/v3")
        );
        assert!(safe_join(root, "../outside").is_err());
        assert!(safe_join(root, "").is_err());
    }

    #[test]
    fn newer_local_runtime_is_not_an_update_candidate() {
        assert!(!runtime_requires_install(Some(4), 3));
        assert!(!runtime_requires_install(Some(3), 3));
        assert!(runtime_requires_install(Some(2), 3));
        assert!(runtime_requires_install(None, 3));
    }

    #[test]
    fn min_app_version_uses_numeric_version_order() {
        assert!(!app_meets_minimum_version("0.1.28", "0.1.29"));
        assert!(app_meets_minimum_version("0.1.29", "0.1.29"));
        assert!(app_meets_minimum_version("0.2.0", "0.1.29"));
        assert!(!app_meets_minimum_version("0.1.29", "not-a-version"));
    }

    #[test]
    fn invalid_min_app_version_manifest_is_rejected() {
        let manifest = AgentRuntimeManifest {
            version: 1,
            min_app_version: "latest".into(),
            package: "agent-runtime-v1-win-x64.zip".into(),
            sha256: "a".repeat(64),
            size: 1,
        };
        assert!(validate_manifest(&manifest).is_err());
    }

    #[test]
    fn invalid_current_state_falls_back_to_the_previous_runtime() {
        let root = TestRuntimeRoot::create();
        let valid_dir = root.path().join("versions/v1");
        fs::create_dir_all(valid_dir.join("node")).unwrap();
        fs::write(valid_dir.join(expected_node_relative_path()), b"node").unwrap();
        fs::write(valid_dir.join(expected_cli_relative_path()), b"cli").unwrap();
        let valid = InstalledRuntimeState {
            version: 1,
            sha256: "a".repeat(64),
            install_dir: "versions/v1".into(),
            installed_at: 1,
            files: vec![
                fingerprint_file(&valid_dir, &expected_node_relative_path()).unwrap(),
                fingerprint_file(&valid_dir, &expected_cli_relative_path()).unwrap(),
            ],
        };
        let invalid = InstalledRuntimeState {
            version: 2,
            sha256: "b".repeat(64),
            install_dir: "versions/v2-missing".into(),
            installed_at: 2,
            files: valid.files.clone(),
        };
        write_json_replace(&root.path().join(PREVIOUS_STATE_FILE_NAME), &valid).unwrap();
        write_json_replace(&root.path().join(STATE_FILE_NAME), &invalid).unwrap();

        let inspection = inspect_local_runtime(root.path(), true);

        assert_eq!(
            inspection.state.as_ref().map(|state| state.version),
            Some(1)
        );
        assert_eq!(inspection.installed_version, Some(2));
    }
}
