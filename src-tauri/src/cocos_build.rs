//! Cocos Creator command-line builds for the release workspace. It reads a
//! client project's engine version, finds installed editors (Cocos Dashboard
//! folders and editor folders next to the project), and runs one build at a
//! time with live log lines on `cocos-build-progress`, then the project's
//! release guard (`qa-tests/QAReleaseGuard.mjs`) on the output when asked.
//! 3.x and 2.4 take different arguments ("Publish from the Command Line");
//! utils/cocosBuildCommand.js shows the same ones in the page.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

use crate::types::AppState;

pub const PROGRESS_EVENT: &str = "cocos-build-progress";
const QA_GUARD: &str = "qa-tests/QAReleaseGuard.mjs";
const LOG_TAIL_LINES: usize = 200;
const SUCCESS_3X: i32 = 36;
const INVALID_OPTIONS_3X: i32 = 32;
const BUILD_ERROR_3X: i32 = 34;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CocosEngine {
    pub version: String,
    /// 3 for Creator 3.x, 2 for 2.x, 0 when unknown.
    pub family: u8,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CocosProjectInfo {
    pub exists: bool,
    pub name: String,
    pub engine: Option<CocosEngine>,
    pub qa_guard: bool,
    /// Build configurations exported from the Build panel, relative to the project.
    pub build_configs: Vec<String>,
    pub config_exists: Option<bool>,
    pub editor_exists: Option<bool>,
    /// The version of the editor at `editorPath`, read from its install.
    pub editor_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CocosInspectRequest {
    pub project_path: String,
    #[serde(default)]
    pub config_path: String,
    #[serde(default)]
    pub editor_path: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CocosEditor {
    pub version: String,
    pub path: String,
    /// "dashboard" (installed by Cocos Dashboard) or "nearby" (next to the project).
    pub source: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CocosBuildRequest {
    pub job_id: String,
    pub editor_path: String,
    pub project_path: String,
    pub family: u8,
    pub platform: String,
    #[serde(default)]
    pub config_path: String,
    #[serde(default)]
    pub output_name: String,
    #[serde(default)]
    pub debug: bool,
    #[serde(default = "default_true")]
    pub md5_cache: bool,
    #[serde(default)]
    pub qa_guard: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CocosQaResult {
    /// "passed", "findings", "failed", "nodeMissing" or "missing".
    pub status: String,
    pub checked: u64,
    pub findings: Vec<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CocosBuildResult {
    pub exit_code: Option<i32>,
    /// "success", "invalidOptions", "buildError", "unknown" or "cancelled".
    pub outcome: String,
    pub output_dir: String,
    pub output_exists: bool,
    pub duration_ms: u64,
    pub log_path: String,
    pub lines: u64,
    pub qa: Option<CocosQaResult>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CocosBuildProgress {
    pub job_id: String,
    /// "build" or "qa".
    pub stage: String,
    /// "out", "err" or "info".
    pub stream: String,
    pub line: String,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CocosOutputStatus {
    pub exists: bool,
    pub entries: u64,
    pub modified_at: u64,
}

/* ── Projects and editors ───────────────────────────────────────────────── */

fn read_json(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 4 * 1024 * 1024 {
        return None;
    }
    serde_json::from_slice(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).ok()
}

pub fn family_of(version: &str) -> u8 {
    match version.trim().split('.').next().and_then(|major| major.parse::<u32>().ok()) {
        Some(major) if major >= 3 => 3,
        Some(2) => 2,
        _ => 0,
    }
}

/// 3.x keeps the version in package.json's `creator.version`; 2.x projects
/// carry it in project.json.
pub fn engine_of(project: &Path) -> Option<CocosEngine> {
    let modern = read_json(&project.join("package.json"))
        .and_then(|json| json.get("creator")?.get("version")?.as_str().map(str::to_string));
    let version = modern.or_else(|| {
        let json = read_json(&project.join("project.json"))?;
        let engine = json.get("engine").and_then(Value::as_str).unwrap_or("");
        if !engine.contains("cocos") {
            return None;
        }
        json.get("version").and_then(Value::as_str).map(str::to_string)
    })?;
    Some(CocosEngine { family: family_of(&version), version })
}

fn is_build_config(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        && read_json(path).is_some_and(|json| json.get("platform").and_then(Value::as_str).is_some())
}

/// Exported build configurations in the project folder or a build-config folder.
pub fn build_configs(project: &Path) -> Vec<String> {
    let mut found = Vec::new();
    for folder in ["", "build-config", "build-configs", "buildConfig", "build-templates"] {
        let directory = if folder.is_empty() { project.to_path_buf() } else { project.join(folder) };
        let Ok(entries) = std::fs::read_dir(&directory) else { continue };
        for entry in entries.flatten().take(200) {
            let path = entry.path();
            if !path.is_file() || ["package.json", "package-lock.json", "tsconfig.json", "project.json"]
                .iter()
                .any(|name| path.file_name().is_some_and(|file| file.eq_ignore_ascii_case(name)))
            {
                continue;
            }
            if is_build_config(&path) {
                let relative = path.strip_prefix(project).unwrap_or(&path);
                found.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    found.sort();
    found
}

fn editor_contents(editor: &Path) -> PathBuf {
    // …/CocosCreator.app/Contents/MacOS/CocosCreator → …/Contents/Resources
    let parent = editor.parent().unwrap_or(editor);
    if parent.file_name().is_some_and(|name| name == "MacOS") {
        parent.parent().unwrap_or(parent).join("Resources")
    } else {
        parent.join("resources")
    }
}

/// The engine version bundled with an installed editor.
pub fn editor_version(editor: &Path) -> String {
    let resources = editor_contents(editor);
    for candidate in [resources.join("resources/3d/engine/package.json"), resources.join("engine/package.json")] {
        if let Some(version) = read_json(&candidate).and_then(|json| json.get("version")?.as_str().map(str::to_string)) {
            return version;
        }
    }
    String::new()
}

fn editor_binaries() -> &'static [&'static str] {
    if cfg!(target_os = "macos") {
        &["CocosCreator.app/Contents/MacOS/CocosCreator"]
    } else {
        &["CocosCreator.exe"]
    }
}

fn version_named(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Editors in folders that hold one version each (Cocos Dashboard's layout).
fn versioned_editors(root: &Path, binaries: &[&str], source: &str, found: &mut Vec<CocosEditor>) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let folder = entry.path();
        for binary in binaries {
            let path = folder.join(binary);
            if path.is_file() {
                let mut version = editor_version(&path);
                if version.is_empty() {
                    version = version_named(&folder);
                }
                found.push(CocosEditor { version, path: path.to_string_lossy().into_owned(), source: source.into() });
            }
        }
    }
}

/// Editor folders next to the project or its parents ("client/creator3.8").
pub fn nearby_editors(project: &Path, binaries: &[&str]) -> Vec<CocosEditor> {
    let mut found = Vec::new();
    for directory in project.ancestors().skip(1).take(3) {
        let Ok(entries) = std::fs::read_dir(directory) else { continue };
        for entry in entries.flatten().take(400) {
            let folder = entry.path();
            let name = version_named(&folder).to_lowercase();
            if !folder.is_dir() || !(name.contains("creator") || name.contains("cocos")) {
                continue;
            }
            for binary in binaries {
                let path = folder.join(binary);
                if path.is_file() {
                    found.push(CocosEditor { version: editor_version(&path), path: path.to_string_lossy().into_owned(), source: "nearby".into() });
                }
            }
        }
    }
    found
}

pub fn find_editors(project: &str) -> Vec<CocosEditor> {
    let binaries = editor_binaries();
    let mut found = Vec::new();
    if !project.trim().is_empty() {
        found.extend(nearby_editors(Path::new(project.trim()), binaries));
    }
    if cfg!(target_os = "windows") {
        let program_data = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        versioned_editors(&program_data.join(r"cocos\editors\Creator"), binaries, "dashboard", &mut found);
        if let Ok(entries) = std::fs::read_dir(r"C:\") {
            for entry in entries.flatten() {
                if version_named(&entry.path()).to_lowercase().starts_with("cocosdashboard") {
                    versioned_editors(&entry.path().join(r"resources\.editors\Creator"), binaries, "dashboard", &mut found);
                }
            }
        }
    } else if cfg!(target_os = "macos") {
        for root in ["/Applications/Cocos/Creator", "/Applications/CocosCreator/Creator"] {
            versioned_editors(Path::new(root), binaries, "dashboard", &mut found);
        }
    }
    let mut seen = std::collections::HashSet::new();
    found.retain(|editor| seen.insert(editor.path.to_lowercase()));
    found
}

pub fn inspect(request: &CocosInspectRequest) -> CocosProjectInfo {
    let project = PathBuf::from(request.project_path.trim());
    let mut info = CocosProjectInfo::default();
    if !request.editor_path.trim().is_empty() {
        let editor = PathBuf::from(request.editor_path.trim());
        info.editor_exists = Some(editor.is_file());
        if editor.is_file() {
            info.editor_version = editor_version(&editor);
        }
    }
    if request.project_path.trim().is_empty() || !project.is_dir() {
        return info;
    }
    info.exists = true;
    info.name = read_json(&project.join("package.json"))
        .and_then(|json| json.get("name")?.as_str().map(str::to_string))
        .unwrap_or_else(|| version_named(&project));
    info.engine = engine_of(&project);
    info.qa_guard = project.join(QA_GUARD).is_file();
    info.build_configs = build_configs(&project);
    if !request.config_path.trim().is_empty() {
        info.config_exists = Some(Path::new(request.config_path.trim()).is_file());
    }
    info
}

/* ── Arguments and output ───────────────────────────────────────────────── */

fn valid_platform(platform: &str) -> bool {
    let mut characters = platform.chars();
    characters.next().is_some_and(|first| first.is_ascii_lowercase())
        && platform.len() <= 41
        && platform.len() >= 2
        && characters.all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
}

fn valid_output_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 80 && !name.contains(['/', '\\', ';', ':']) && name != "." && name != ".."
}

const NATIVE_2X: [&str; 5] = ["android", "ios", "win32", "mac", "android-instant"];

/// The editor's arguments, as utils/cocosBuildCommand.js shows them.
pub fn build_args(request: &CocosBuildRequest, log_path: Option<&Path>) -> Result<Vec<String>, String> {
    let platform = request.platform.trim();
    if !valid_platform(platform) {
        return Err(format!("打包平台无效：{platform}"));
    }
    let config = request.config_path.trim();
    if config.contains(';') {
        return Err("打包配置路径不能包含分号".into());
    }
    let output_name = request.output_name.trim();
    if !output_name.is_empty() && !valid_output_name(output_name) {
        return Err(format!("输出文件夹名称无效：{output_name}"));
    }
    let modern = request.family != 2;
    let mut options = Vec::new();
    if !config.is_empty() {
        options.push(format!("configPath={config}"));
    }
    if config.is_empty() || !modern {
        options.push(format!("platform={platform}"));
    }
    if config.is_empty() {
        options.push(format!("debug={}", request.debug));
        options.push(format!("md5Cache={}", request.md5_cache));
    }
    if modern && !output_name.is_empty() {
        options.push(format!("outputName={output_name}"));
    }
    if let (true, Some(log)) = (modern, log_path) {
        options.push(format!("logDest={}", log.to_string_lossy()));
    }
    Ok(vec![
        if modern { "--project" } else { "--path" }.to_string(),
        request.project_path.trim().to_string(),
        "--build".to_string(),
        options.join(";"),
    ])
}

/// Where the build lands; a 3.x build configuration may name its own folder.
pub fn output_dir(request: &CocosBuildRequest) -> PathBuf {
    let build = Path::new(request.project_path.trim()).join("build");
    if request.family == 2 {
        let platform = request.platform.trim();
        return build.join(if NATIVE_2X.contains(&platform) { "jsb-link" } else { platform });
    }
    let config = read_json(Path::new(request.config_path.trim()));
    let from_config = |key: &str| config.as_ref().and_then(|json| json.get(key)?.as_str().map(str::to_string)).filter(|value| !value.is_empty());
    let name = Some(request.output_name.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| from_config("outputName"))
        .or_else(|| from_config("platform"))
        .unwrap_or_else(|| request.platform.trim().to_string());
    build.join(name)
}

pub fn describe_exit(family: u8, code: Option<i32>) -> &'static str {
    match (family, code) {
        (2, Some(0)) => "success",
        (2, _) => "unknown",
        (_, Some(SUCCESS_3X)) => "success",
        (_, Some(INVALID_OPTIONS_3X)) => "invalidOptions",
        (_, Some(BUILD_ERROR_3X)) => "buildError",
        _ => "unknown",
    }
}

pub fn output_status(path: &Path) -> CocosOutputStatus {
    let Ok(metadata) = std::fs::metadata(path) else { return CocosOutputStatus::default() };
    if !metadata.is_dir() {
        return CocosOutputStatus::default();
    }
    let entries = std::fs::read_dir(path).map(|entries| entries.take(10_000).count() as u64).unwrap_or(0);
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    CocosOutputStatus { exists: true, entries, modified_at }
}

/* ── Jobs ───────────────────────────────────────────────────────────────── */

struct CocosBuildJob {
    id: String,
    cancelled: AtomicBool,
    pid: AtomicU32,
}

/// One build at a time; a second request waits for the person to finish or stop the first.
#[derive(Default)]
pub struct CocosBuildJobs {
    active: Mutex<Option<Arc<CocosBuildJob>>>,
}

pub struct CocosBuildGuard<'a> {
    jobs: &'a CocosBuildJobs,
    job: Arc<CocosBuildJob>,
}

impl CocosBuildJobs {
    pub fn register(&self, job_id: &str) -> Result<CocosBuildGuard<'_>, String> {
        let job_id = job_id.trim();
        if job_id.is_empty() {
            return Err("打包任务 ID 不能为空".into());
        }
        let mut active = self.active.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if active.is_some() {
            return Err("已有客户端打包正在进行，请等待完成或先停止".into());
        }
        let job = Arc::new(CocosBuildJob { id: job_id.into(), cancelled: AtomicBool::new(false), pid: AtomicU32::new(0) });
        *active = Some(Arc::clone(&job));
        Ok(CocosBuildGuard { jobs: self, job })
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        let job = self.active.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let Some(job) = job.filter(|job| job.id == job_id.trim()) else { return false };
        job.cancelled.store(true, Ordering::SeqCst);
        let pid = job.pid.load(Ordering::SeqCst);
        if pid != 0 {
            crate::table_transfer::kill_process_tree(pid);
        }
        true
    }
}

impl CocosBuildGuard<'_> {
    fn set_pid(&self, pid: u32) {
        self.job.pid.store(pid, Ordering::SeqCst);
        // A stop that arrived while the editor was starting still applies.
        if pid != 0 && self.cancelled() {
            crate::table_transfer::kill_process_tree(pid);
        }
    }

    fn cancelled(&self) -> bool {
        self.job.cancelled.load(Ordering::SeqCst)
    }
}

impl Drop for CocosBuildGuard<'_> {
    fn drop(&mut self) {
        let mut active = self.jobs.active.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if active.as_ref().is_some_and(|job| Arc::ptr_eq(job, &self.job)) {
            *active = None;
        }
    }
}

/* ── Running ────────────────────────────────────────────────────────────── */

type Emit = Arc<dyn Fn(&str, &str, String) + Send + Sync>;

async fn forward_lines<R: AsyncRead + Unpin>(reader: R, stream: &'static str, emit: Emit, count: Arc<AtomicU64>) {
    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = crate::table_transfer::decode_console(&buffer);
                let line = line.trim_end_matches(['\r', '\n']);
                if line.trim().is_empty() {
                    continue;
                }
                count.fetch_add(1, Ordering::Relaxed);
                emit("build", stream, line.to_string());
            }
        }
    }
}

fn program_on_path(program: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(target_os = "windows") {
        vec![format!("{program}.exe"), format!("{program}.cmd")]
    } else {
        vec![program.to_string()]
    };
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|directory| names.iter().map(|name| directory.join(name)).find(|path| path.is_file()))
    })
}

/// The guard's JSON report: `{ "checked": n, "findings": [{ file, markers }] }`.
pub fn parse_qa_report(stdout: &str) -> Option<(u64, Vec<String>)> {
    let start = stdout.find('{')?;
    let json: Value = serde_json::from_str(stdout[start..].trim()).ok()?;
    let checked = json.get("checked")?.as_u64()?;
    let findings = json
        .get("findings")?
        .as_array()?
        .iter()
        .map(|finding| {
            let file = finding.get("file").and_then(Value::as_str).unwrap_or("");
            let markers: Vec<&str> = finding.get("markers").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            format!("{file}: {}", markers.join(", "))
        })
        .collect();
    Some((checked, findings))
}

/// Run the project's release guard on the build output with Node.js.
pub async fn run_qa_guard(node: Option<PathBuf>, project: &Path, output: &Path, emit: &Emit) -> CocosQaResult {
    let result = |status: &str, message: String| CocosQaResult { status: status.into(), checked: 0, findings: vec![], message };
    let script = project.join(QA_GUARD);
    if !script.is_file() {
        return result("missing", String::new());
    }
    if !output.is_dir() {
        return result("failed", format!("找不到打包输出：{}", output.to_string_lossy()));
    }
    let Some(node) = node else {
        return result("nodeMissing", "找不到 Node.js（node），无法运行发布前检查".into());
    };
    emit("qa", "info", format!("> node {QA_GUARD} \"{}\"", output.to_string_lossy()));
    let mut command = tokio::process::Command::new(node);
    command.arg(&script).arg(output).current_dir(project).stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let Ok(finished) = command.output().await else {
        return result("failed", "无法运行发布前检查".into());
    };
    let stdout = crate::table_transfer::decode_console(&finished.stdout);
    let stderr = crate::table_transfer::decode_console(&finished.stderr);
    match parse_qa_report(&stdout) {
        Some((checked, findings)) => {
            for finding in &findings {
                emit("qa", "err", finding.clone());
            }
            CocosQaResult {
                status: if findings.is_empty() && finished.status.success() { "passed" } else { "findings" }.into(),
                checked,
                findings,
                message: String::new(),
            }
        }
        None => result("failed", stderr.lines().next().unwrap_or("发布前检查失败").trim().to_string()),
    }
}

fn log_tail(path: &Path) -> Vec<String> {
    let Ok(bytes) = std::fs::read(path) else { return vec![] };
    let text = crate::table_transfer::decode_console(&bytes);
    let lines: Vec<String> = text.lines().filter(|line| !line.trim().is_empty()).map(str::to_string).collect();
    lines[lines.len().saturating_sub(LOG_TAIL_LINES)..].to_vec()
}

fn check_request(request: &CocosBuildRequest) -> Result<(), String> {
    let editor = Path::new(request.editor_path.trim());
    if !editor.is_file() {
        return Err(format!("找不到 Cocos Creator：{}", request.editor_path.trim()));
    }
    let project = Path::new(request.project_path.trim());
    if !project.is_dir() {
        return Err(format!("找不到客户端工程：{}", request.project_path.trim()));
    }
    let engine = engine_of(project).ok_or("这个文件夹不是 Cocos Creator 工程（没有 package.json 的 creator.version 或 project.json）")?;
    if engine.family != 0 && request.family != 0 && engine.family != request.family {
        return Err(format!("工程使用 Cocos Creator {}，不能用 {}.x 的打包方式", engine.version, request.family));
    }
    if !request.config_path.trim().is_empty() && !Path::new(request.config_path.trim()).is_file() {
        return Err(format!("找不到打包配置：{}", request.config_path.trim()));
    }
    Ok(())
}

/// Start the editor, forward its output, wait for it and check the result.
pub async fn run_build(
    jobs: &CocosBuildJobs,
    request: CocosBuildRequest,
    log_path: Option<PathBuf>,
    node: Option<PathBuf>,
    emit: Emit,
) -> Result<CocosBuildResult, String> {
    let guard = jobs.register(&request.job_id)?;
    check_request(&request)?;
    let args = build_args(&request, log_path.as_deref())?;
    if let Some(parent) = log_path.as_deref().and_then(Path::parent) {
        let _ = std::fs::create_dir_all(parent);
    }
    let project = PathBuf::from(request.project_path.trim());
    let output = output_dir(&request);
    emit("build", "info", format!("> \"{}\" {}", request.editor_path.trim(), args.iter().map(|arg| if arg.contains([' ', ';']) { format!("\"{arg}\"") } else { arg.clone() }).collect::<Vec<_>>().join(" ")));
    let mut command = tokio::process::Command::new(request.editor_path.trim());
    command
        .args(&args)
        .current_dir(&project)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(unix)]
    command.process_group(0);
    let started = Instant::now();
    let mut child = command.spawn().map_err(|error| format!("无法启动 Cocos Creator：{error}"))?;
    guard.set_pid(child.id().unwrap_or(0));
    let count = Arc::new(AtomicU64::new(0));
    let stdout = child.stdout.take().map(|reader| tokio::spawn(forward_lines(reader, "out", Arc::clone(&emit), Arc::clone(&count))));
    let stderr = child.stderr.take().map(|reader| tokio::spawn(forward_lines(reader, "err", Arc::clone(&emit), Arc::clone(&count))));
    let status = child.wait().await.map_err(|error| format!("等待 Cocos Creator 结束失败：{error}"))?;
    for reader in [stdout, stderr].into_iter().flatten() {
        let _ = reader.await;
    }
    // Some editor builds print nothing on the console; the log file then tells what happened.
    if count.load(Ordering::Relaxed) == 0 {
        for line in log_path.as_deref().map(log_tail).unwrap_or_default() {
            count.fetch_add(1, Ordering::Relaxed);
            emit("build", "out", line);
        }
    }
    let exit_code = status.code();
    let cancelled = guard.cancelled();
    let outcome = if cancelled { "cancelled" } else { describe_exit(request.family, exit_code) };
    let qa = if outcome == "success" && request.qa_guard {
        Some(run_qa_guard(node, &project, &output, &emit).await)
    } else {
        None
    };
    Ok(CocosBuildResult {
        exit_code,
        outcome: outcome.into(),
        output_exists: output.is_dir(),
        output_dir: output.to_string_lossy().into_owned(),
        duration_ms: started.elapsed().as_millis() as u64,
        log_path: log_path.map(|path| path.to_string_lossy().into_owned()).unwrap_or_default(),
        lines: count.load(Ordering::Relaxed),
        qa,
    })
}

/* ── Commands ───────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn cocos_inspect_project(request: CocosInspectRequest) -> CocosProjectInfo {
    tokio::task::spawn_blocking(move || inspect(&request)).await.unwrap_or_default()
}

#[tauri::command]
pub async fn cocos_find_editors(project_path: String) -> Vec<CocosEditor> {
    tokio::task::spawn_blocking(move || find_editors(&project_path)).await.unwrap_or_default()
}

#[tauri::command]
pub async fn cocos_output_status(path: String) -> CocosOutputStatus {
    tokio::task::spawn_blocking(move || output_status(Path::new(path.trim()))).await.unwrap_or_default()
}

#[tauri::command]
pub async fn cocos_build_start(app: AppHandle, state: State<'_, AppState>, request: CocosBuildRequest) -> Result<CocosBuildResult, String> {
    let log_path = app
        .path()
        .app_log_dir()
        .ok()
        .map(|directory| directory.join("cocos-build").join(format!("{}.log", request.job_id.trim().replace(['/', '\\', ':'], "_"))));
    let job_id = request.job_id.trim().to_string();
    let handle = app.clone();
    let emit: Emit = Arc::new(move |stage: &str, stream: &str, line: String| {
        let _ = handle.emit(PROGRESS_EVENT, CocosBuildProgress { job_id: job_id.clone(), stage: stage.into(), stream: stream.into(), line });
    });
    run_build(&state.cocos_build, request, log_path, program_on_path("node"), emit).await
}

#[tauri::command]
pub fn cocos_build_cancel(state: State<'_, AppState>, job_id: String) -> bool {
    state.cocos_build.cancel(&job_id)
}

/// A native dialog opening in `start`, or next to it when it is a file.
fn dialog_at(start: &str) -> rfd::AsyncFileDialog {
    let path = PathBuf::from(start.trim());
    let directory = if path.is_dir() { Some(path) } else { path.parent().filter(|parent| parent.is_dir()).map(Path::to_path_buf) };
    match directory {
        Some(directory) => rfd::AsyncFileDialog::new().set_directory(directory),
        None => rfd::AsyncFileDialog::new(),
    }
}

#[tauri::command]
pub async fn cocos_pick_editor(start: String) -> Result<Option<String>, String> {
    let mut dialog = dialog_at(&start);
    if cfg!(target_os = "windows") {
        dialog = dialog.add_filter("Cocos Creator", &["exe"]);
    }
    let Some(file) = dialog.pick_file().await else { return Ok(None) };
    let path = file.path().to_path_buf();
    // A picked .app bundle stands for the editor binary inside it.
    let binary = if path.extension().is_some_and(|extension| extension == "app") { path.join("Contents/MacOS/CocosCreator") } else { path };
    Ok(Some(binary.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn cocos_pick_project(start: String) -> Result<Option<String>, String> {
    Ok(dialog_at(&start).pick_folder().await.map(|folder| folder.path().to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn cocos_pick_config(start: String) -> Result<Option<String>, String> {
    Ok(dialog_at(&start).add_filter("JSON", &["json"]).pick_file().await.map(|file| file.path().to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_temp_dir::TempDir;

    fn request(family: u8) -> CocosBuildRequest {
        CocosBuildRequest {
            job_id: "job".into(),
            editor_path: "C:/Cocos/CocosCreator.exe".into(),
            project_path: "D:/release/tw/jswz".into(),
            family,
            platform: "android".into(),
            config_path: String::new(),
            output_name: String::new(),
            debug: false,
            md5_cache: true,
            qa_guard: false,
        }
    }

    #[test]
    fn arguments_follow_the_documented_command_line() {
        let modern = build_args(&request(3), Some(Path::new("/logs/job.log"))).unwrap();
        assert_eq!(modern, ["--project", "D:/release/tw/jswz", "--build", "platform=android;debug=false;md5Cache=true;logDest=/logs/job.log"]);
        let mut configured = request(3);
        configured.config_path = "D:/release/tw/jswz/build-config/android.json".into();
        configured.output_name = "android-tw".into();
        assert_eq!(build_args(&configured, None).unwrap()[3], "configPath=D:/release/tw/jswz/build-config/android.json;outputName=android-tw");
        let legacy = build_args(&request(2), Some(Path::new("/logs/job.log"))).unwrap();
        assert_eq!(legacy, ["--path", "D:/release/tw/jswz", "--build", "platform=android;debug=false;md5Cache=true"]);
        let mut bad = request(3);
        bad.platform = "android;rm".into();
        assert!(build_args(&bad, None).is_err());
        bad.platform = "android".into();
        bad.output_name = "../x".into();
        assert!(build_args(&bad, None).is_err());
    }

    #[test]
    fn output_folders_and_exit_codes_depend_on_the_version() {
        assert_eq!(output_dir(&request(3)), Path::new("D:/release/tw/jswz/build/android"));
        assert_eq!(output_dir(&request(2)), Path::new("D:/release/tw/jswz/build/jsb-link"));
        let mut web = request(2);
        web.platform = "web-mobile".into();
        assert_eq!(output_dir(&web), Path::new("D:/release/tw/jswz/build/web-mobile"));
        assert_eq!(describe_exit(3, Some(36)), "success");
        assert_eq!(describe_exit(3, Some(32)), "invalidOptions");
        assert_eq!(describe_exit(3, Some(34)), "buildError");
        assert_eq!(describe_exit(3, Some(0)), "unknown");
        assert_eq!(describe_exit(2, Some(0)), "success");
        assert_eq!(describe_exit(2, Some(36)), "unknown");
        assert_eq!(describe_exit(3, None), "unknown");
    }

    #[test]
    fn projects_editors_and_build_configs_are_read_from_disk() {
        let temp = TempDir::create("cocos-inspect");
        let client = temp.path().join("client");
        let project = client.join("jswz");
        std::fs::create_dir_all(project.join("qa-tests")).unwrap();
        std::fs::create_dir_all(project.join("build-config")).unwrap();
        std::fs::write(project.join("package.json"), r#"{"name":"jswz","creator":{"version":"3.8.8"}}"#).unwrap();
        std::fs::write(project.join(QA_GUARD), "").unwrap();
        std::fs::write(project.join("build-config/android.json"), r#"{"platform":"android","outputName":"android-tw"}"#).unwrap();
        std::fs::write(project.join("tsconfig.json"), r#"{"platform":"x"}"#).unwrap();
        let editor_dir = client.join("creator3.8");
        std::fs::create_dir_all(editor_dir.join("resources/resources/3d/engine")).unwrap();
        std::fs::write(editor_dir.join("CocosCreator.exe"), "").unwrap();
        std::fs::write(editor_dir.join("resources/resources/3d/engine/package.json"), r#"{"version":"3.8.8"}"#).unwrap();

        let info = inspect(&CocosInspectRequest {
            project_path: project.to_string_lossy().into_owned(),
            config_path: project.join("build-config/missing.json").to_string_lossy().into_owned(),
            editor_path: editor_dir.join("CocosCreator.exe").to_string_lossy().into_owned(),
        });
        assert!(info.exists && info.qa_guard);
        assert_eq!(info.name, "jswz");
        assert_eq!(info.engine, Some(CocosEngine { version: "3.8.8".into(), family: 3 }));
        assert_eq!(info.build_configs, vec!["build-config/android.json".to_string()]);
        assert_eq!((info.config_exists, info.editor_exists, info.editor_version.as_str()), (Some(false), Some(true), "3.8.8"));

        let nearby = nearby_editors(&project, &["CocosCreator.exe"]);
        assert_eq!(nearby.len(), 1);
        assert_eq!((nearby[0].version.as_str(), nearby[0].source.as_str()), ("3.8.8", "nearby"));

        let legacy = temp.path().join("nzg");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("project.json"), r#"{"engine":"cocos-creator-js","packages":"packages","version":"2.4.13"}"#).unwrap();
        assert_eq!(engine_of(&legacy), Some(CocosEngine { version: "2.4.13".into(), family: 2 }));
        assert_eq!(engine_of(temp.path()), None);

        let mut configured = request(3);
        configured.project_path = project.to_string_lossy().into_owned();
        configured.config_path = project.join("build-config/android.json").to_string_lossy().into_owned();
        assert_eq!(output_dir(&configured), project.join("build").join("android-tw"));
    }

    #[test]
    fn the_release_guard_report_is_read() {
        let report = "{\n  \"checked\": 1286,\n  \"findings\": [{ \"file\": \"assets/main.js\", \"markers\": [\"JSWZQAToolkit\"] }]\n}";
        assert_eq!(parse_qa_report(report), Some((1286, vec!["assets/main.js: JSWZQAToolkit".to_string()])));
        assert_eq!(parse_qa_report("{\"checked\": 3, \"findings\": []}"), Some((3, vec![])));
        assert_eq!(parse_qa_report("没有可检查的脚本"), None);
    }

    #[test]
    fn only_one_build_runs_at_a_time() {
        let jobs = CocosBuildJobs::default();
        let first = jobs.register("a").unwrap();
        assert!(jobs.register("b").is_err());
        assert!(!jobs.cancel("b"));
        assert!(jobs.cancel("a"));
        assert!(first.cancelled());
        drop(first);
        assert!(jobs.register("b").is_ok());
    }

    /// A stand-in editor prints build lines and exits like Creator 3.x does.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_build_forwards_the_editor_output_and_reads_its_exit_code() {
        use std::os::unix::fs::PermissionsExt;
        let temp = TempDir::create("cocos-run");
        let project = temp.path().join("jswz");
        std::fs::create_dir_all(project.join("build/android")).unwrap();
        std::fs::write(project.join("package.json"), r#"{"creator":{"version":"3.8.8"}}"#).unwrap();
        let editor = temp.path().join("CocosCreator");
        std::fs::write(&editor, "#!/bin/sh\necho \"Start building $2\"\necho '[Build] Compile scripts done'\necho 'warning: texture' >&2\nexit 36\n").unwrap();
        std::fs::set_permissions(&editor, std::fs::Permissions::from_mode(0o755)).unwrap();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&lines);
        let emit: Emit = Arc::new(move |stage: &str, stream: &str, line: String| sink.lock().unwrap().push(format!("{stage}/{stream}: {line}")));
        let mut build = request(3);
        build.editor_path = editor.to_string_lossy().into_owned();
        build.project_path = project.to_string_lossy().into_owned();
        let jobs = CocosBuildJobs::default();
        let result = run_build(&jobs, build.clone(), None, None, Arc::clone(&emit)).await.unwrap();
        assert_eq!((result.exit_code, result.outcome.as_str(), result.output_exists), (Some(36), "success", true));
        let lines = lines.lock().unwrap().clone();
        assert!(lines[0].starts_with("build/info: > "), "{lines:?}");
        assert!(lines.contains(&format!("build/out: Start building {}", project.to_string_lossy())));
        assert!(lines.contains(&"build/err: warning: texture".to_string()));
        assert_eq!(result.lines, 3);

        std::fs::write(&editor, "#!/bin/sh\necho '[Error] Build failed'\nexit 34\n").unwrap();
        let failed = run_build(&jobs, build.clone(), None, None, Arc::clone(&emit)).await.unwrap();
        assert_eq!(failed.outcome, "buildError");

        build.family = 2;
        assert!(run_build(&jobs, build, None, None, emit).await.unwrap_err().contains("3.8.8"));
    }
}
