//! 一键转表：运行用户选择的外部转表脚本（.exe/.bat/.cmd/.lnk），定位脚本
//! 产出的时间戳配置包，对用户选择的游戏工程目录执行带自动冲突处理的 SVN
//! 更新（等同于在该文件夹上点「SVN 更新」），最后把包内 `props` /
//! `src/props` 合并覆盖进工程。
//!
//! 只支持 Windows（转表脚本本身是 Windows 工具链）；所有写操作限定在用户
//! 选择的脚本工作目录与游戏工程目录内。

use std::collections::{HashMap, VecDeque};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Emitter, Window};

use crate::svn_updater;
use crate::types::{
    TableTransferProgress, TableTransferRunRequest, TableTransferRunResult, TableTransferTemplatePaths,
};
use crate::work_scheduler::WorkCancellation;

pub const TABLE_TRANSFER_PROGRESS_EVENT: &str = "table-transfer-progress";

const STAGE_SCRIPT: &str = "script";
const STAGE_LOCATE: &str = "locate";
const STAGE_SVN: &str = "svn";
const STAGE_COPY: &str = "copy";
const STAGE_DONE: &str = "done";

const STATUS_RUNNING: &str = "running";
const STATUS_SUCCEEDED: &str = "succeeded";
const STATUS_FAILED: &str = "failed";
const STATUS_CANCELLED: &str = "cancelled";

/// 脚本退出后留一点缓冲等产出目录落盘稳定。
const OUTPUT_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_DISCOVERY_POLL: Duration = Duration::from_millis(500);
/// 系统时钟与文件系统时间戳之间允许的偏差。
const CREATED_SKEW_TOLERANCE: Duration = Duration::from_secs(5);
const COPY_PROGRESS_INTERVAL: u64 = 50;
const COMPLETED_JOB_HISTORY_LIMIT: usize = 64;
/// 脚本跑完后只把日志末尾送进界面；过程中不把 stdout 接进管道，
/// 避免 window.emit 堵住子进程（手动双击 20 秒、软件代跑变几分钟的根因）。
const SCRIPT_LOG_TAIL_LINES: usize = 80;
const SVN_LOG_TAIL_LINES: usize = 80;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── 任务注册表 ─────────────────────────────────────────────────

/// 一个进行中的转表任务：取消令牌 + 正在运行的脚本进程 PID（取消时按进程
/// 树杀掉，否则 `cmd /c` 派生的 node 子进程会变孤儿继续写产出目录）。
struct TableTransferJob {
    cancellation: WorkCancellation,
    child_pid: AtomicU32,
}

#[derive(Default)]
struct TableTransferJobState {
    active: Option<(String, Arc<TableTransferJob>)>,
    completed: VecDeque<String>,
}

/// 转表任务注册表：同一时刻只允许一个转表任务，任务结束（guard 掉落）后
/// 其 job_id 进入完成历史，防止同一任务被误重入。
#[derive(Default)]
pub struct TableTransferJobs {
    state: Arc<StdMutex<TableTransferJobState>>,
}

pub struct TableTransferJobGuard {
    job_id: String,
    job: Arc<TableTransferJob>,
    state: Arc<StdMutex<TableTransferJobState>>,
}

impl TableTransferJobs {
    pub fn register(&self, job_id: &str) -> Result<TableTransferJobGuard, String> {
        let job_id = job_id.trim();
        if job_id.is_empty() {
            return Err("转表任务 ID 不能为空".into());
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.completed.iter().any(|completed| completed == job_id) {
            return Err("该转表任务已执行过，请重新开始转表".into());
        }
        if state.active.is_some() {
            return Err("已有转表任务正在进行，请等待完成或先取消".into());
        }
        let job = Arc::new(TableTransferJob {
            cancellation: WorkCancellation::new(),
            child_pid: AtomicU32::new(0),
        });
        state.active = Some((job_id.to_string(), Arc::clone(&job)));
        Ok(TableTransferJobGuard {
            job_id: job_id.to_string(),
            job,
            state: Arc::clone(&self.state),
        })
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        let job = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match &state.active {
                Some((id, job)) if id == job_id.trim() => Some(Arc::clone(job)),
                _ => None,
            }
        };
        let Some(job) = job else {
            return false;
        };
        job.cancellation.cancel();
        let pid = job.child_pid.load(Ordering::Relaxed);
        if pid != 0 {
            kill_process_tree(pid);
        }
        true
    }
}

impl TableTransferJobGuard {
    fn cancellation(&self) -> WorkCancellation {
        self.job.cancellation.clone()
    }

    fn store_child_pid(&self, pid: u32) {
        self.job.child_pid.store(pid, Ordering::Relaxed);
    }

    fn clear_child_pid(&self) {
        self.job.child_pid.store(0, Ordering::Relaxed);
    }
}

impl Drop for TableTransferJobGuard {
    fn drop(&mut self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let is_current = state.active.as_ref().is_some_and(|(id, job)| {
            id == &self.job_id && Arc::ptr_eq(job, &self.job)
        });
        if is_current {
            state.active = None;
            if state.completed.len() >= COMPLETED_JOB_HISTORY_LIMIT {
                state.completed.pop_front();
            }
            state.completed.push_back(self.job_id.clone());
        }
    }
}

// ── 进度事件 ───────────────────────────────────────────────────

#[derive(Clone)]
struct ProgressEmitter {
    window: Window,
    job_id: String,
}

impl ProgressEmitter {
    fn new(window: &Window, job_id: &str) -> Self {
        Self {
            window: window.clone(),
            job_id: job_id.to_string(),
        }
    }

    fn emit(&self, stage: &str, status: &str, message: impl Into<String>, line: Option<String>) {
        let _ = self.window.emit(
            TABLE_TRANSFER_PROGRESS_EVENT,
            TableTransferProgress {
                job_id: self.job_id.clone(),
                stage: stage.to_string(),
                status: status.to_string(),
                message: message.into(),
                line,
            },
        );
    }

    fn log(&self, stage: &str, line: impl Into<String>) {
        self.emit(stage, STATUS_RUNNING, "", Some(line.into()));
    }
}

// ── 文件选择 ───────────────────────────────────────────────────

pub async fn pick_script() -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title("选择转表脚本");
    if cfg!(target_os = "windows") {
        dialog = dialog.add_filter("转表脚本", &["exe", "bat", "cmd", "lnk"]);
    }
    let file = dialog.pick_file().await;
    Ok(file.map(|file| file.path().to_string_lossy().to_string()))
}

pub async fn pick_project_dir() -> Result<Option<String>, String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择游戏工程文件夹（或其中的 assets 目录）")
        .pick_folder()
        .await;
    Ok(folder.map(|folder| folder.path().to_string_lossy().to_string()))
}

// ── 路径自动探测 ───────────────────────────────────────────────

const TEMPLATE_JUESHENG_1: &str = "juesheng-1";
const TEMPLATE_JUESHENG_2: &str = "juesheng-2";

#[derive(Debug, Default, Clone)]
struct DiscoveredLayout {
    script_path: Option<PathBuf>,
    project_root: Option<PathBuf>,
}

fn is_c_drive_root(path: &Path) -> bool {
    let text = path.to_string_lossy();
    let trimmed = text.trim_end_matches(['\\', '/']);
    trimmed.eq_ignore_ascii_case("C:")
}

fn json_name_field(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("name")?.as_str().map(str::to_string)
}

fn is_jswz_project(dir: &Path) -> bool {
    dir.join("assets").is_dir() && json_name_field(&dir.join("package.json")).as_deref() == Some("jswz")
}

fn is_nzg_project(dir: &Path) -> bool {
    dir.join("assets").is_dir() && json_name_field(&dir.join("project.json")).as_deref() == Some("nzg")
}

fn first_matching_script(dir: &Path, prefer: &str) -> Option<PathBuf> {
    let preferred = dir.join(prefer);
    if preferred.is_file() {
        return Some(preferred);
    }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut fallback = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.contains("生成全部配置") || name.contains("3区") {
            continue;
        }
        let extension = entry
            .path()
            .extension()
            .map(|value| value.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !matches!(extension.as_str(), "bat" | "cmd" | "lnk" | "exe") {
            continue;
        }
        if name.contains(prefer.trim_end_matches(".bat")) {
            return Some(entry.path());
        }
        if fallback.is_none() {
            fallback = Some(entry.path());
        }
    }
    fallback
}

fn join_rel(root: &Path, parts: &[&str]) -> PathBuf {
    parts.iter().fold(root.to_path_buf(), |acc, part| acc.join(part))
}

fn script_dirs_walking_up(project: &Path, tails: &[&[&str]]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut current = project.parent();
    for _ in 0..5 {
        let Some(dir) = current else {
            break;
        };
        for tail in tails {
            dirs.push(join_rel(dir, tail));
        }
        current = dir.parent();
    }
    dirs
}

fn jswz_script_for_project(project: &Path) -> Option<PathBuf> {
    let tails: &[&[&str]] = &[
        &["tool", "生成配置", "1-生成全部配置-客户端"],
        &["chengxu", "tool", "生成配置", "1-生成全部配置-客户端"],
        &["client", "tool", "生成配置", "1-生成全部配置-客户端"],
    ];
    for dir in script_dirs_walking_up(project, tails) {
        if let Some(script) = first_matching_script(&dir, "4区生成全部配置.bat") {
            return Some(script);
        }
    }
    None
}

fn nzg_script_for_project(project: &Path) -> Option<PathBuf> {
    let tails: &[&[&str]] = &[
        &["tools", "生成配置", "1-生成全部配置-客户端"],
        &["trunk", "tools", "生成配置", "1-生成全部配置-客户端"],
    ];
    for dir in script_dirs_walking_up(project, tails) {
        if let Some(script) = first_matching_script(&dir, "1.生成全部配置.bat") {
            return Some(script);
        }
    }
    None
}

fn try_fill_jswz(root: &Path, found: &mut DiscoveredLayout) {
    if found.project_root.is_some() && found.script_path.is_some() {
        return;
    }
    let candidates = [
        join_rel(root, &["chengxu", "client", "jswz"]),
        join_rel(root, &["client", "jswz"]),
        join_rel(root, &["jswz"]),
        root.to_path_buf(),
    ];
    for relative in candidates {
        if !is_jswz_project(&relative) {
            continue;
        }
        if found.project_root.is_none() {
            found.project_root = Some(relative.clone());
        }
        if found.script_path.is_none() {
            found.script_path = jswz_script_for_project(&relative);
        }
        if found.project_root.is_some() && found.script_path.is_some() {
            return;
        }
    }
}

fn try_fill_nzg(root: &Path, found: &mut DiscoveredLayout) {
    if found.project_root.is_some() && found.script_path.is_some() {
        return;
    }
    let candidates = [
        join_rel(root, &["trunk", "client", "nzg"]),
        join_rel(root, &["client", "nzg"]),
        join_rel(root, &["Versions", "nzg"]),
        join_rel(root, &["nzg"]),
        root.to_path_buf(),
    ];
    for relative in candidates {
        if !is_nzg_project(&relative) {
            continue;
        }
        if found.project_root.is_none() {
            found.project_root = Some(relative.clone());
        }
        if found.script_path.is_none() {
            found.script_path = nzg_script_for_project(&relative);
        }
        if found.project_root.is_some() && found.script_path.is_some() {
            return;
        }
    }
}

fn discover_in_roots(roots: &[PathBuf]) -> HashMap<String, DiscoveredLayout> {
    let mut jswz = DiscoveredLayout::default();
    let mut nzg = DiscoveredLayout::default();
    for root in roots {
        if is_c_drive_root(root) {
            continue;
        }
        try_fill_jswz(root, &mut jswz);
        try_fill_nzg(root, &mut nzg);
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                try_fill_jswz(&path, &mut jswz);
                try_fill_nzg(&path, &mut nzg);
            }
        }
    }
    let mut map = HashMap::new();
    map.insert(TEMPLATE_JUESHENG_2.to_string(), jswz);
    map.insert(TEMPLATE_JUESHENG_1.to_string(), nzg);
    map
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

fn apply_discovered(
    current: Vec<TableTransferTemplatePaths>,
    found: &HashMap<String, DiscoveredLayout>,
) -> Vec<TableTransferTemplatePaths> {
    let templates = if current.is_empty() {
        vec![
            TableTransferTemplatePaths {
                id: TEMPLATE_JUESHENG_1.to_string(),
                script_path: String::new(),
                project_root: String::new(),
            },
            TableTransferTemplatePaths {
                id: TEMPLATE_JUESHENG_2.to_string(),
                script_path: String::new(),
                project_root: String::new(),
            },
        ]
    } else {
        current
    };
    templates
        .into_iter()
        .map(|mut item| {
            let hit = found.get(item.id.trim());
            if !Path::new(item.script_path.trim()).is_file() {
                if let Some(path) = hit.and_then(|layout| layout.script_path.as_ref()) {
                    item.script_path = path.to_string_lossy().into_owned();
                }
            }
            if !Path::new(item.project_root.trim()).is_dir() {
                if let Some(path) = hit.and_then(|layout| layout.project_root.as_ref()) {
                    item.project_root = path.to_string_lossy().into_owned();
                }
            }
            item
        })
        .collect()
}

/// 当前路径仍然有效则保留；否则按 SVN 仓库相对路径补全决胜1/决胜2
/// （`chengxu/client/jswz` + `chengxu/tool`，`trunk/client/nzg` + `trunk/tools`，
/// 以及本机常见的 `client/jswz`、`Versions/nzg`）。不扫 C 盘。
pub fn discover_template_paths(
    current: Vec<TableTransferTemplatePaths>,
) -> Vec<TableTransferTemplatePaths> {
    let needs_scan = current.iter().any(|item| {
        !Path::new(item.script_path.trim()).is_file() || !Path::new(item.project_root.trim()).is_dir()
    });
    let found = if needs_scan || current.is_empty() {
        discover_in_roots(&search_roots())
    } else {
        HashMap::new()
    };
    apply_discovered(current, &found)
}

// ── 主流程 ─────────────────────────────────────────────────────

pub async fn run(
    app: &AppHandle,
    window: &Window,
    jobs: &TableTransferJobs,
    request: TableTransferRunRequest,
) -> Result<TableTransferRunResult, String> {
    let guard = jobs.register(&request.job_id)?;
    let progress = ProgressEmitter::new(window, &guard.job_id);
    let result = run_inner(app, &guard, &progress, &request).await;
    match &result {
        Ok(result) => progress.emit(
            STAGE_DONE,
            STATUS_SUCCEEDED,
            format!("转表完成：已覆盖 {} 个文件", result.copied_files),
            None,
        ),
        Err(_) if guard.cancellation().is_cancelled() => {
            progress.emit(STAGE_DONE, STATUS_CANCELLED, "转表已取消", None)
        }
        Err(error) => progress.emit(STAGE_DONE, STATUS_FAILED, error.clone(), None),
    }
    result
}

async fn run_inner(
    app: &AppHandle,
    guard: &TableTransferJobGuard,
    progress: &ProgressEmitter,
    request: &TableTransferRunRequest,
) -> Result<TableTransferRunResult, String> {
    let script = PathBuf::from(request.script_path.trim());
    if !script.is_file() {
        return Err(format!("转表脚本不存在: {}", script.display()));
    }
    let project_root = PathBuf::from(request.project_root.trim());
    let assets = resolve_assets_dir(&project_root);
    if !assets.is_dir() {
        return Err(format!(
            "游戏工程目录下没有 assets 目录: {}（可选择工程根目录或直接选择 assets 目录）",
            assets.display()
        ));
    }
    let strategy = parse_conflict_strategy(request.conflict_strategy.as_deref());

    // 1. 解析脚本（.lnk 先解析出真实目标），并启动。完整路径进日志，状态
    //    消息保持简短（对话框状态行空间有限）。
    let launch = resolve_script_launch(&script).await?;
    progress.log(
        STAGE_SCRIPT,
        format!("开始运行转表脚本: {}", launch.display()),
    );
    progress.emit(
        STAGE_SCRIPT,
        STATUS_RUNNING,
        "脚本运行中（完成后显示日志摘要）",
        None,
    );
    let started_at = SystemTime::now();
    let script_started = Instant::now();
    let status = run_script(&launch, guard, progress).await?;
    progress.log(
        STAGE_SCRIPT,
        format!(
            "脚本结束，耗时 {:.1} 秒",
            script_started.elapsed().as_secs_f64()
        ),
    );
    ensure_not_cancelled(guard)?;
    if !status.success() {
        return Err(format!("转表脚本执行失败（{status}），详见日志"));
    }

    // 2. 定位产出目录（脚本目录或其一层子目录下、本次开始后创建的
    //    时间戳文件夹，须含 props 与 src/props）。
    progress.emit(
        STAGE_LOCATE,
        STATUS_RUNNING,
        "脚本执行完成，正在定位转表产出目录…",
        None,
    );
    let output_dir = locate_output_dir(&launch.work_dir, started_at).await?;
    progress.emit(
        STAGE_LOCATE,
        STATUS_RUNNING,
        format!("找到产出目录: {}", output_dir.display()),
        None,
    );
    ensure_not_cancelled(guard)?;

    // 3. SVN 更新用户选择的游戏工程目录（等同于在资源管理器里对该文件夹
    //    点「SVN 更新」）。只更新 assets/props 与 src/props 时，工程里其它
    //    已提交改动不会被拉下来，日志会显示 At revision N，看起来像没更新。
    let svn = svn_updater::resolve_svn_exe(app).ok_or_else(svn_updater::svn_not_found_message)?;
    let svn_target = resolve_svn_update_dir(&project_root).to_path_buf();
    let props_dir = assets.join("props");
    let src_props_dir = assets.join("src").join("props");
    ensure_not_cancelled(guard)?;
    let svn_started = Instant::now();
    let leftover = svn_update_with_strategy(&svn, &svn_target, strategy, progress).await?;
    progress.log(
        STAGE_SVN,
        format!(
            "SVN 更新结束，耗时 {:.1} 秒",
            svn_started.elapsed().as_secs_f64()
        ),
    );
    if !leftover.is_empty() {
        return Err(format_manual_conflict_error(&svn_target, &leftover));
    }
    let updated_dirs = vec![svn_target.to_string_lossy().to_string()];

    // 4. 合并覆盖拷贝 props/* 与 src/props/* 进工程 assets。
    ensure_not_cancelled(guard)?;
    progress.emit(
        STAGE_COPY,
        STATUS_RUNNING,
        format!("开始拷贝产出到工程: {}", assets.display()),
        None,
    );
    let copy_pairs = [
        (output_dir.join("props"), props_dir),
        (output_dir.join("src").join("props"), src_props_dir),
    ];
    let copy_progress = progress.clone();
    let cancellation = guard.cancellation();
    let copy_started = Instant::now();
    let copied_files = tokio::task::spawn_blocking(move || {
        let mut count = 0u64;
        for (from, to) in &copy_pairs {
            merge_copy_dir(from, to, &mut count, Some(&copy_progress), &cancellation)?;
        }
        Ok::<u64, String>(count)
    })
    .await
    .map_err(|error| format!("拷贝任务执行失败: {error}"))??;
    progress.log(
        STAGE_COPY,
        format!(
            "拷贝结束，耗时 {:.1} 秒，共 {copied_files} 个文件",
            copy_started.elapsed().as_secs_f64()
        ),
    );

    Ok(TableTransferRunResult {
        output_dir: output_dir.to_string_lossy().to_string(),
        updated_dirs,
        copied_files,
    })
}

fn ensure_not_cancelled(guard: &TableTransferJobGuard) -> Result<(), String> {
    if guard.cancellation().is_cancelled() {
        Err("转表已取消".into())
    } else {
        Ok(())
    }
}

/// 用户既可能选工程根目录（`D:\client\jswz`），也可能直接选到 assets 层
/// （`D:\client\jswz\assets`）——两种情况都归一到 assets 目录。
fn resolve_assets_dir(project_root: &Path) -> PathBuf {
    let leaf_is_assets = project_root
        .file_name()
        .map(|name| name.to_string_lossy().eq_ignore_ascii_case("assets"))
        .unwrap_or(false);
    if leaf_is_assets {
        project_root.to_path_buf()
    } else {
        project_root.join("assets")
    }
}

/// 覆盖前 SVN 更新的目标：用户选的游戏工程文件夹（或其中的 assets）。
/// 等同于在该文件夹上点「SVN 更新」，而不是只更新 props 两个子目录。
fn resolve_svn_update_dir(project_root: &Path) -> &Path {
    project_root
}

// ── 脚本解析与执行 ─────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
enum ScriptKind {
    Exe,
    Batch,
}

struct ScriptLaunch {
    program: PathBuf,
    args: Vec<String>,
    work_dir: PathBuf,
    kind: ScriptKind,
}

impl ScriptLaunch {
    fn display(&self) -> String {
        self.program.to_string_lossy().to_string()
    }
}

/// 把用户选择的脚本解析成可直接执行的形态。`.lnk` 快捷方式先经
/// PowerShell COM 解析出目标/参数/工作目录；bat 类脚本的工作目录必须是
/// 脚本所在目录，因为脚本内部普遍使用 `../../props` 这类相对路径。
async fn resolve_script_launch(script: &Path) -> Result<ScriptLaunch, String> {
    if !cfg!(target_os = "windows") {
        return Err("一键转表仅支持 Windows（转表脚本是 Windows 工具链）".into());
    }
    let extension = script
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "exe" => Ok(ScriptLaunch {
            program: script.to_path_buf(),
            args: Vec::new(),
            work_dir: script
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(".")),
            kind: ScriptKind::Exe,
        }),
        "bat" | "cmd" => Ok(ScriptLaunch {
            program: script.to_path_buf(),
            args: Vec::new(),
            work_dir: script
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(".")),
            kind: ScriptKind::Batch,
        }),
        "lnk" => {
            if !cfg!(target_os = "windows") {
                return Err("快捷方式(.lnk)仅支持 Windows".into());
            }
            let shortcut = resolve_windows_shortcut(script).await?;
            let target = PathBuf::from(shortcut.target_path.trim());
            if !target.is_file() {
                return Err(format!(
                    "快捷方式指向的目标不存在: {}",
                    target.display()
                ));
            }
            let target_extension = target
                .extension()
                .map(|value| value.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let kind = match target_extension.as_str() {
                "exe" => ScriptKind::Exe,
                "bat" | "cmd" => ScriptKind::Batch,
                other => {
                    return Err(format!(
                        "快捷方式指向的目标类型（.{other}）不是可执行脚本，仅支持 exe/bat/cmd"
                    ))
                }
            };
            let work_dir = if shortcut.working_directory.trim().is_empty() {
                target
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| PathBuf::from("."))
            } else {
                PathBuf::from(shortcut.working_directory.trim())
            };
            Ok(ScriptLaunch {
                program: target,
                args: split_shortcut_arguments(&shortcut.arguments),
                work_dir,
                kind,
            })
        }
        other => Err(format!(
            "不支持的脚本类型（.{other}），请选择 exe / bat / cmd / lnk 转表脚本"
        )),
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WindowsShortcutInfo {
    target_path: Option<String>,
    arguments: Option<String>,
    working_directory: Option<String>,
}

#[cfg(target_os = "windows")]
struct ResolvedShortcut {
    target_path: String,
    arguments: String,
    working_directory: String,
}

/// 通过 PowerShell 的 WScript.Shell COM 解析 .lnk。PowerShell 在受支持的
/// Windows 版本上始终可用；输出为 JSON，避免逐行文本解析的编码问题。
#[cfg(target_os = "windows")]
async fn resolve_windows_shortcut(path: &Path) -> Result<ResolvedShortcut, String> {
    let escaped = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{escaped}'); \
         [PSCustomObject]@{{ TargetPath=$s.TargetPath; Arguments=$s.Arguments; \
         WorkingDirectory=$s.WorkingDirectory }} | ConvertTo-Json -Compress"
    );
    let output = tokio_command_without_window("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .await
        .map_err(|error| format!("解析快捷方式失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "解析快捷方式失败（{}）: {}",
            output.status,
            decode_console(&output.stderr)
        ));
    }
    // PowerShell 在中文系统上按 GBK 输出，含中文路径时直接 from_slice 会因
    // 非法 UTF-8 字节失败；先经 decode_console（UTF-8 → GBK 回退）再解析。
    let info: WindowsShortcutInfo = serde_json::from_str(&decode_console(&output.stdout))
        .map_err(|error| format!("解析快捷方式结果失败: {error}"))?;
    let target_path = info.target_path.unwrap_or_default();
    if target_path.trim().is_empty() {
        return Err("快捷方式没有指向任何目标".into());
    }
    Ok(ResolvedShortcut {
        target_path,
        arguments: info.arguments.unwrap_or_default(),
        working_directory: info.working_directory.unwrap_or_default(),
    })
}

/// 快捷方式的参数字符串按空白切分。转表脚本约定"双击式无参数"，这里只为
/// 兼容带简单参数的快捷方式；含引号的复杂参数行不支持。
fn split_shortcut_arguments(arguments: &str) -> Vec<String> {
    arguments
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

#[cfg(target_os = "windows")]
fn build_script_command(launch: &ScriptLaunch) -> tokio::process::Command {
    if launch.kind == ScriptKind::Exe && launch.args.is_empty() {
        let mut command = tokio::process::Command::new(&launch.program);
        // tokio::process::Command 自带 creation_flags 固有方法，无需扩展 trait。
        command.creation_flags(CREATE_NO_WINDOW);
        return command;
    }
    // bat/cmd 经 cmd 解释执行。必须用 /d /s /c + raw_arg 手工拼命令行：
    // 用普通 .arg() 传带引号的字符串时，Rust 会把内嵌引号转义成 \"，
    // 而 cmd 不认这种转义，最终路径带着引号执行，报"不是内部或外部命令"。
    // /s /c ""path"" 是 cmd 官方文档形态：剥掉最外层引号后原样执行。
    let line = if launch.args.is_empty() {
        format!("\"{}\"", launch.program.display())
    } else {
        format!("\"{}\" {}", launch.program.display(), launch.args.join(" "))
    };
    let mut command = tokio::process::Command::new("cmd");
    command.creation_flags(CREATE_NO_WINDOW);
    {
        use std::os::windows::process::CommandExt;
        command
            .as_std_mut()
            .args(["/d", "/s", "/c"])
            .raw_arg(format!("\"{line}\""));
    }
    command
}

#[cfg(not(target_os = "windows"))]
fn build_script_command(_launch: &ScriptLaunch) -> tokio::process::Command {
    // 转表脚本仅支持 Windows（resolve_script_launch 已先行拒绝），此分支只
    // 为保证非 Windows 平台可编译；直接返回一个立即失败的命令。
    tokio::process::Command::new("false")
}

/// 打开一份可被脚本进程和本进程同时使用的日志文件。Windows 必须显式
/// FILE_SHARE_READ|WRITE，否则子进程继承句柄后本进程无法再读。
fn open_shared_log_file(path: &Path) -> Result<std::fs::File, String> {
    let mut opts = OpenOptions::new();
    opts.create(true).write(true).truncate(true).read(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.share_mode(0x0000_0007);
    }
    opts.open(path)
        .map_err(|error| format!("创建脚本日志失败（{}）: {error}", path.display()))
}

fn script_log_path(job_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("dbscout-{job_id}-script.log"))
}

/// 读脚本日志并截成末尾若干行。中文 Windows 上 cmd/svn/node 常是 GBK。
fn read_log_tail(path: &Path, max_lines: usize) -> (usize, Vec<String>) {
    let bytes = std::fs::read(path).unwrap_or_default();
    let text = decode_console(&bytes);
    let lines: Vec<String> = text
        .lines()
        .map(|line| line.trim_end().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    let total = lines.len();
    if total <= max_lines {
        (total, lines)
    } else {
        (total, lines[total - max_lines..].to_vec())
    }
}

fn emit_log_tail<F: Fn(String)>(sink: &F, total: usize, tail: &[String], label: &str) {
    if total == 0 {
        return;
    }
    if total > tail.len() {
        sink(format!(
            "… {label}共 {total} 行，已省略前 {} 行",
            total - tail.len()
        ));
    }
    if !tail.is_empty() {
        sink(tail.join("\n"));
    }
}

/// 按既定方式启动转表脚本：工作目录、stdin 置 null（bat 末尾的 `pause`
/// 会因此立即返回而不是等按键）、stdout/stderr 写入共享日志文件、无窗口。
/// 不把输出接到管道上——管道一满且 UI 来不及读，脚本自己就会停。
fn spawn_script(
    launch: &ScriptLaunch,
    log_path: &Path,
) -> Result<tokio::process::Child, String> {
    let log_file = open_shared_log_file(log_path)?;
    let stdout = log_file
        .try_clone()
        .map_err(|error| format!("复制脚本日志句柄失败: {error}"))?;
    let mut command = build_script_command(launch);
    command
        .current_dir(&launch.work_dir)
        .stdin(std::process::Stdio::null())
        .stdout(stdout)
        .stderr(log_file)
        .kill_on_drop(true);
    command.spawn().map_err(|error| {
        format!(
            "启动转表脚本失败（{}）: {error}",
            launch.program.display()
        )
    })
}

/// 运行转表脚本。过程中不把输出转发到 UI；结束后把日志末尾一次送进 sink。
/// 取消时按进程树强杀。
async fn run_script(
    launch: &ScriptLaunch,
    guard: &TableTransferJobGuard,
    progress: &ProgressEmitter,
) -> Result<std::process::ExitStatus, String> {
    let progress = progress.clone();
    run_script_with_log_sink(launch, guard, move |line| progress.log(STAGE_SCRIPT, line)).await
}

async fn run_script_with_log_sink<F>(
    launch: &ScriptLaunch,
    guard: &TableTransferJobGuard,
    sink: F,
) -> Result<std::process::ExitStatus, String>
where
    F: Fn(String),
{
    let log_path = script_log_path(&guard.job_id);
    let mut child = spawn_script(launch, &log_path)?;
    if let Some(pid) = child.id() {
        guard.store_child_pid(pid);
    }

    let cancellation = guard.cancellation();
    let status = tokio::select! {
        result = child.wait() => {
            result.map_err(|error| format!("等待转表脚本结束失败: {error}"))?
        }
        _ = cancellation.cancelled() => {
            if let Some(pid) = child.id() {
                kill_process_tree(pid);
            }
            guard.clear_child_pid();
            let _ = std::fs::remove_file(&log_path);
            return Err("转表已取消".into());
        }
    };
    guard.clear_child_pid();
    let (total, tail) = read_log_tail(&log_path, SCRIPT_LOG_TAIL_LINES);
    emit_log_tail(&sink, total, &tail, "脚本输出");
    let _ = std::fs::remove_file(&log_path);
    Ok(status)
}

// ── 产出目录探测 ───────────────────────────────────────────────

/// 产出目录名形如 `2026-06-30 10-58-23`（YYYY-MM-DD HH-mm-ss，19 字符）。
fn is_timestamp_dir_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.len() != 19 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        4 | 7 | 13 | 16 => *byte == b'-',
        10 => *byte == b' ',
        _ => byte.is_ascii_digit(),
    })
}

async fn locate_output_dir(work_dir: &Path, started_at: SystemTime) -> Result<PathBuf, String> {
    let deadline = tokio::time::Instant::now() + OUTPUT_DISCOVERY_TIMEOUT;
    loop {
        if let Some(dir) = find_latest_output_dir(work_dir, started_at) {
            return Ok(dir);
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(OUTPUT_DISCOVERY_POLL).await;
    }
    Err(format!(
        "没有在 {} 及其一层子目录里找到本次生成的转表产出目录（名称形如 \"YYYY-MM-DD HH-mm-ss\" 且包含 props 与 src/props 子目录）",
        work_dir.display()
    ))
}

/// 在脚本工作目录及其一层子目录（决胜2 会先套一层库名目录）里找最新的
/// 有效产出目录：名称是时间戳、创建时间不早于本次开始、含 props 与
/// src/props。
fn find_latest_output_dir(work_dir: &Path, started_at: SystemTime) -> Option<PathBuf> {
    let mut containers = vec![work_dir.to_path_buf()];
    if let Ok(entries) = std::fs::read_dir(work_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                containers.push(path);
            }
        }
    }
    let mut best: Option<(PathBuf, SystemTime)> = None;
    for container in containers {
        let Ok(entries) = std::fs::read_dir(&container) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !is_timestamp_dir_name(name) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let created = metadata
                .created()
                .or_else(|_| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            if created + CREATED_SKEW_TOLERANCE < started_at {
                continue;
            }
            if !path.join("props").is_dir() || !path.join("src").join("props").is_dir() {
                continue;
            }
            if best.as_ref().map_or(true, |(_, time)| created > *time) {
                best = Some((path, created));
            }
        }
    }
    best.map(|(path, _)| path)
}

// ── SVN 更新与冲突处理 ─────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConflictStrategy {
    Theirs,
    Mine,
    Manual,
}

fn parse_conflict_strategy(value: Option<&str>) -> ConflictStrategy {
    match value.map(str::trim) {
        Some("mine") => ConflictStrategy::Mine,
        Some("manual") => ConflictStrategy::Manual,
        _ => ConflictStrategy::Theirs,
    }
}

fn svn_update_accept_arg(strategy: ConflictStrategy) -> &'static str {
    match strategy {
        ConflictStrategy::Theirs => "theirs-full",
        ConflictStrategy::Mine => "mine-full",
        ConflictStrategy::Manual => "postpone",
    }
}

fn conflict_strategy_auto_resolves(strategy: ConflictStrategy) -> bool {
    !matches!(strategy, ConflictStrategy::Manual)
}

fn format_manual_conflict_error(target: &Path, conflicts: &[PathBuf]) -> String {
    let listing = conflicts
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "发现 {} 个 SVN 冲突（{}），已暂停覆盖拷贝。当前是「遇到冲突由我处理」，请手动解决后再转表:\n{listing}",
        conflicts.len(),
        target.display()
    )
}

/// 对一个工作副本目录执行 update。云端/本地为准时自动消冲突；
/// 「由我处理」只 postpone，把残留冲突交还给调用方，不覆盖拷贝。
async fn svn_update_with_strategy(
    svn: &Path,
    target: &Path,
    strategy: ConflictStrategy,
    progress: &ProgressEmitter,
) -> Result<Vec<PathBuf>, String> {
    progress.emit(
        STAGE_SVN,
        STATUS_RUNNING,
        format!("SVN 更新: {}", target.display()),
        None,
    );
    let accept = svn_update_accept_arg(strategy);
    // 不先 cleanup：大工作副本上每次 cleanup 都要扫一遍，多数时候是浪费。
    // 只有 update 报锁定时才清理再试。
    let update_args = ["update", "--non-interactive", "--accept", accept];
    let mut update_result = run_svn(svn, target, &update_args, progress).await;
    let update_error = update_result.as_ref().err().cloned();
    if let Some(first_error) = update_error {
        let locked = first_error.contains("locked")
            || first_error.contains("E155004")
            || first_error.contains("工作副本");
        if locked {
            progress.log(STAGE_SVN, "检测到工作副本锁定，自动清理后重试…".to_string());
            run_svn(svn, target, &["cleanup", "--non-interactive"], progress)
                .await
                .map_err(|error| format!("svn cleanup 重试失败（{}）: {error}", target.display()))?;
            update_result = run_svn(svn, target, &update_args, progress).await;
        } else if conflict_strategy_auto_resolves(strategy) {
            return Err(format!(
                "svn update 失败（{}）: {first_error}",
                target.display()
            ));
        }
    }

    let conflicts = svn_conflicted_paths(svn, target).await?;
    if conflicts.is_empty() {
        update_result.map_err(|error| format!("svn update 失败（{}）: {error}", target.display()))?;
        return Ok(Vec::new());
    }
    if !conflict_strategy_auto_resolves(strategy) {
        progress.log(
            STAGE_SVN,
            format!(
                "发现 {} 个冲突，按「遇到冲突由我处理」暂停覆盖拷贝",
                conflicts.len()
            ),
        );
        return Ok(conflicts);
    }
    progress.log(
        STAGE_SVN,
        format!(
            "发现 {} 个残留冲突，按\"{}\"策略自动处理…",
            conflicts.len(),
            if strategy == ConflictStrategy::Theirs {
                "云端为准"
            } else {
                "本地为准"
            }
        ),
    );
    if strategy == ConflictStrategy::Theirs {
        for path in &conflicts {
            run_svn(svn, path, &["revert", "-R", "--non-interactive"], progress)
                .await
                .map_err(|error| format!("svn revert 失败（{}）: {error}", path.display()))?;
        }
        run_svn(svn, target, &update_args, progress)
            .await
            .map_err(|error| format!("冲突处理后 svn update 失败（{}）: {error}", target.display()))?;
    } else {
        run_svn(
            svn,
            target,
            &["resolve", "--accept", "working", "-R", "--non-interactive"],
            progress,
        )
        .await
        .map_err(|error| format!("svn resolve 失败（{}）: {error}", target.display()))?;
    }

    let remaining = svn_conflicted_paths(svn, target).await?;
    if !remaining.is_empty() {
        let listing = remaining
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!(
            "仍有 {} 个 SVN 冲突无法自动处理（{}），请手动解决后重试:\n{listing}",
            remaining.len(),
            target.display()
        ));
    }
    Ok(Vec::new())
}

async fn run_svn(
    svn: &Path,
    target: &Path,
    args: &[&str],
    progress: &ProgressEmitter,
) -> Result<(), String> {
    let output = tokio_command_without_window(svn)
        .args(args)
        .arg(target)
        .output()
        .await
        .map_err(|error| format!("执行 svn {} 失败: {error}", args[0]))?;
    let stdout = decode_console(&output.stdout);
    let stderr = decode_console(&output.stderr);
    let svn_lines: Vec<String> = stdout
        .lines()
        .chain(stderr.lines())
        .map(|line| line.trim_end().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    let total = svn_lines.len();
    let tail = if total > SVN_LOG_TAIL_LINES {
        &svn_lines[total - SVN_LOG_TAIL_LINES..]
    } else {
        svn_lines.as_slice()
    };
    emit_log_tail(
        &|line| progress.log(STAGE_SVN, line),
        total,
        tail,
        &format!("svn {}", args[0]),
    );
    if output.status.success() {
        return Ok(());
    }
    let details = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if details.is_empty() {
        Err(format!("svn {} 失败: {}", args[0], output.status))
    } else {
        Err(format!("svn {} 失败: {}\n{}", args[0], output.status, details))
    }
}

async fn svn_conflicted_paths(svn: &Path, target: &Path) -> Result<Vec<PathBuf>, String> {
    let output = tokio_command_without_window(svn)
        .args(["status", "--non-interactive"])
        .arg(target)
        .output()
        .await
        .map_err(|error| format!("执行 svn status 失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "svn status 失败: {}\n{}",
            output.status,
            decode_console(&output.stderr)
        ));
    }
    Ok(parse_svn_conflicts(&decode_console(&output.stdout)))
}

/// 解析 `svn status` 输出里的冲突项：首列 `C`（文本/属性冲突）或第 7 列
/// `C`（树冲突）。路径从第 9 列开始（前 8 字节是 ASCII 状态列，切片安全）。
/// 目标以绝对路径传给 svn 时，输出路径同样是绝对路径。
fn parse_svn_conflicts(status_output: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for line in status_output.lines() {
        let bytes = line.as_bytes();
        if bytes.len() <= 8 {
            continue;
        }
        let text_conflict = bytes[0] == b'C';
        let tree_conflict = bytes[6] == b'C';
        if !text_conflict && !tree_conflict {
            continue;
        }
        let path = line[8..].trim();
        if !path.is_empty() {
            paths.push(PathBuf::from(path));
        }
    }
    paths
}

// ── 合并拷贝 ───────────────────────────────────────────────────

/// 递归合并拷贝：覆盖同名文件、保留目标目录里多出来的文件（.meta、
/// propfunction.js 等），不删除任何目标文件。`progress` 为 None 时只拷贝
/// 不上报（单元测试用）。
fn merge_copy_dir(
    from: &Path,
    to: &Path,
    count: &mut u64,
    progress: Option<&ProgressEmitter>,
    cancellation: &WorkCancellation,
) -> Result<(), String> {
    if cancellation.is_cancelled() {
        return Err("转表已取消".into());
    }
    std::fs::create_dir_all(to)
        .map_err(|error| format!("创建目录失败（{}）: {error}", to.display()))?;
    let entries = std::fs::read_dir(from)
        .map_err(|error| format!("读取目录失败（{}）: {error}", from.display()))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("读取目录项失败（{}）: {error}", from.display()))?;
        let source = entry.path();
        let destination = to.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取文件类型失败（{}）: {error}", source.display()))?;
        if file_type.is_dir() {
            merge_copy_dir(&source, &destination, count, progress, cancellation)?;
        } else if file_type.is_file() {
            std::fs::copy(&source, &destination).map_err(|error| {
                format!(
                    "复制文件失败 {} → {}: {error}",
                    source.display(),
                    destination.display()
                )
            })?;
            *count += 1;
            if *count % COPY_PROGRESS_INTERVAL == 0 {
                if let Some(progress) = progress {
                    progress.emit(
                        STAGE_COPY,
                        STATUS_RUNNING,
                        format!("已复制 {count} 个文件…"),
                        None,
                    );
                }
            }
        }
    }
    Ok(())
}

// ── 工具 ───────────────────────────────────────────────────────

fn tokio_command_without_window(program: impl AsRef<Path>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program.as_ref());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Windows 控制台程序输出通常是 GBK（中文系统）；先按 UTF-8 尝试，失败再
/// 按 GBK 解码，保证脚本与 svn 的日志在前端可读。
fn decode_console(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    #[cfg(target_os = "windows")]
    {
        let (text, _, _) = encoding_rs::GBK.decode(bytes);
        return text.into_owned();
    }
    #[cfg(not(target_os = "windows"))]
    String::from_utf8_lossy(bytes).into_owned()
}

/// 按进程树强杀（cmd /c 派生的子进程一并结束）。尽力而为，失败静默。
fn kill_process_tree(pid: u32) {
    if cfg!(target_os = "windows") {
        let mut command = std::process::Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = command.status();
    } else {
        let _ = std::process::Command::new("kill")
            .arg(pid.to_string())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestTempDir {
        path: PathBuf,
    }

    impl TestTempDir {
        fn create(prefix: &str) -> Self {
            let timestamp = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let counter = TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "{prefix}-{}-{timestamp}-{counter}",
                std::process::id()
            ));
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

    #[cfg(target_os = "windows")]
    #[test]
    fn shortcut_json_with_chinese_parses_after_console_decode() {
        // 中文系统上 PowerShell 输出 GBK 字节；decode_console 必须能还原含
        // 中文路径的 JSON，否则 serde_json 会报 invalid unicode code point。
        let json = r#"{"TargetPath":"D:\\client\\tool\\生成配置\\gen.bat","Arguments":"","WorkingDirectory":"D:\\client\\tool\\生成配置"}"#;
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode(json);
        let decoded = decode_console(gbk_bytes.as_ref());
        let info: serde_json::Value = serde_json::from_str(&decoded).unwrap();
        assert_eq!(
            info["TargetPath"].as_str().unwrap(),
            "D:\\client\\tool\\生成配置\\gen.bat"
        );
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn batch_script_with_gbk_output_and_pause_completes() {
        // 真实模拟转表 bat：GBK 编码的中文 echo + 末尾 pause。回归验证：
        // GBK 输出不再冲垮读取器（曾经 .lines() 遇 GBK 报错→管道关闭→
        // node 写输出撞 broken pipe 退出 1→pause 写不动退出码变 1）。
        let temp = TestTempDir::create("table-transfer-bat");
        let (gbk, _, _) = encoding_rs::GBK.encode("@echo off\r\necho 转表开始-决胜\r\npause\r\n");
        let bat_path = temp.path().join("gen.bat");
        std::fs::write(&bat_path, gbk.as_ref()).unwrap();
        let launch = ScriptLaunch {
            program: bat_path,
            args: Vec::new(),
            work_dir: temp.path().to_path_buf(),
            kind: ScriptKind::Batch,
        };
        let log_path = temp.path().join("script.log");
        let mut child = spawn_script(&launch, &log_path).expect("spawn bat");
        let status = child.wait().await.expect("wait bat");
        assert!(status.success(), "bat should exit 0, got {status}");
        let (_total, lines) = read_log_tail(&log_path, 50);
        assert!(
            lines.iter().any(|line| line.contains("转表开始-决胜")),
            "GBK 中文输出应被正确解码: {lines:?}"
        );
        assert!(
            lines.iter().any(|line| line.contains("请按任意键继续")),
            "pause 的提示行也应出现: {lines:?}"
        );
    }

    fn write_identity(path: &Path, file_name: &str, name: &str) {
        std::fs::create_dir_all(path.join("assets")).unwrap();
        std::fs::write(
            path.join(file_name),
            format!(r#"{{"name":"{name}"}}"#),
        )
        .unwrap();
    }

    #[test]
    fn skips_c_drive_and_discovers_juesheng_layouts() {
        assert!(is_c_drive_root(Path::new(r"C:\")));
        assert!(is_c_drive_root(Path::new("C:")));
        assert!(!is_c_drive_root(Path::new(r"C:\Users")));
        assert!(!is_c_drive_root(Path::new(r"D:\client\jswz")));

        let temp = TestTempDir::create("table-transfer-discover");
        let jswz = temp.path().join("client").join("jswz");
        write_identity(&jswz, "package.json", "jswz");
        let jswz_script_dir = temp
            .path()
            .join("client")
            .join("tool")
            .join("生成配置")
            .join("1-生成全部配置-客户端");
        std::fs::create_dir_all(&jswz_script_dir).unwrap();
        let jswz_script = jswz_script_dir.join("4区生成全部配置.bat");
        std::fs::write(&jswz_script, b"@echo off\r\n").unwrap();
        std::fs::write(jswz_script_dir.join("3区生成全部配置.bat"), b"@echo off\r\n").unwrap();

        let nzg = temp.path().join("Versions").join("nzg");
        write_identity(&nzg, "project.json", "nzg");
        let nzg_script_dir = temp
            .path()
            .join("Versions")
            .join("tools")
            .join("生成配置")
            .join("1-生成全部配置-客户端");
        std::fs::create_dir_all(&nzg_script_dir).unwrap();
        let nzg_script = nzg_script_dir.join("1.生成全部配置.bat");
        std::fs::write(&nzg_script, b"@echo off\r\n").unwrap();

        let found = discover_in_roots(&[temp.path().to_path_buf()]);
        let juesheng2 = found.get("juesheng-2").unwrap();
        assert_eq!(juesheng2.project_root.as_ref(), Some(&jswz));
        assert_eq!(juesheng2.script_path.as_ref(), Some(&jswz_script));
        let juesheng1 = found.get("juesheng-1").unwrap();
        assert_eq!(juesheng1.project_root.as_ref(), Some(&nzg));
        assert_eq!(juesheng1.script_path.as_ref(), Some(&nzg_script));
    }

    #[test]
    fn discover_keeps_existing_valid_paths_and_fills_missing() {
        let temp = TestTempDir::create("table-transfer-resolve");
        let jswz = temp.path().join("client").join("jswz");
        write_identity(&jswz, "package.json", "jswz");
        let script_dir = temp
            .path()
            .join("client")
            .join("tool")
            .join("生成配置")
            .join("1-生成全部配置-客户端");
        std::fs::create_dir_all(&script_dir).unwrap();
        let script = script_dir.join("4区生成全部配置.bat");
        std::fs::write(&script, b"@echo off\r\n").unwrap();
        let custom_script = temp.path().join("my.bat");
        std::fs::write(&custom_script, b"@echo off\r\n").unwrap();

        let found = discover_in_roots(&[temp.path().to_path_buf()]);
        let resolved = apply_discovered(
            vec![
                TableTransferTemplatePaths {
                    id: "juesheng-2".into(),
                    script_path: custom_script.to_string_lossy().into_owned(),
                    project_root: "Z:\\missing-project".into(),
                },
                TableTransferTemplatePaths {
                    id: "juesheng-1".into(),
                    script_path: String::new(),
                    project_root: String::new(),
                },
            ],
            &found,
        );
        assert_eq!(resolved[0].script_path, custom_script.to_string_lossy());
        assert_eq!(resolved[0].project_root, jswz.to_string_lossy());
        assert_eq!(resolved[1].script_path, "");
        assert_eq!(resolved[1].project_root, "");
    }

    #[test]
    fn discovers_svn_relative_chengxu_and_trunk_layouts() {
        let temp = TestTempDir::create("table-transfer-svn-layout");
        let repo2 = temp.path().join("juesheng2");
        let jswz = repo2.join("chengxu").join("client").join("jswz");
        write_identity(&jswz, "package.json", "jswz");
        let jswz_script_dir = repo2
            .join("chengxu")
            .join("tool")
            .join("生成配置")
            .join("1-生成全部配置-客户端");
        std::fs::create_dir_all(&jswz_script_dir).unwrap();
        let jswz_script = jswz_script_dir.join("4区生成全部配置.bat");
        std::fs::write(&jswz_script, b"@echo off\r\n").unwrap();

        let repo1 = temp.path().join("edota");
        let nzg = repo1.join("trunk").join("client").join("nzg");
        write_identity(&nzg, "project.json", "nzg");
        let nzg_script_dir = repo1
            .join("trunk")
            .join("tools")
            .join("生成配置")
            .join("1-生成全部配置-客户端");
        std::fs::create_dir_all(&nzg_script_dir).unwrap();
        let nzg_script = nzg_script_dir.join("1.生成全部配置.bat");
        std::fs::write(&nzg_script, b"@echo off\r\n").unwrap();

        let found = discover_in_roots(&[temp.path().to_path_buf()]);
        let juesheng2 = found.get("juesheng-2").unwrap();
        assert_eq!(juesheng2.project_root.as_ref(), Some(&jswz));
        assert_eq!(juesheng2.script_path.as_ref(), Some(&jswz_script));
        let juesheng1 = found.get("juesheng-1").unwrap();
        assert_eq!(juesheng1.project_root.as_ref(), Some(&nzg));
        assert_eq!(juesheng1.script_path.as_ref(), Some(&nzg_script));
    }

    #[test]
    fn assets_dir_accepts_both_project_root_and_assets_layer() {
        assert_eq!(
            resolve_assets_dir(Path::new("D:\\client\\jswz")),
            PathBuf::from("D:\\client\\jswz\\assets")
        );
        assert_eq!(
            resolve_assets_dir(Path::new("D:\\client\\jswz\\assets")),
            PathBuf::from("D:\\client\\jswz\\assets")
        );
        assert_eq!(
            resolve_assets_dir(Path::new("D:\\client\\jswz\\Assets")),
            PathBuf::from("D:\\client\\jswz\\Assets")
        );
        assert_eq!(
            resolve_assets_dir(Path::new("D:\\Versions\\nzg")),
            PathBuf::from("D:\\Versions\\nzg\\assets")
        );
    }

    #[test]
    fn svn_update_target_is_the_selected_game_project_folder() {
        // 覆盖前要跟手动点工程目录「SVN 更新」一样，不能只更新 props 子目录。
        assert_eq!(
            resolve_svn_update_dir(Path::new(r"D:\client2\jswz")),
            Path::new(r"D:\client2\jswz")
        );
        assert_eq!(
            resolve_svn_update_dir(Path::new(r"D:\client2\jswz\assets")),
            Path::new(r"D:\client2\jswz\assets")
        );
        assert_eq!(
            resolve_svn_update_dir(Path::new(r"D:\Versions\nzg")),
            Path::new(r"D:\Versions\nzg")
        );
    }

    #[test]
    fn timestamp_dir_name_matches_generation_format() {        assert!(is_timestamp_dir_name("2026-06-30 10-58-23"));
        assert!(is_timestamp_dir_name("2026-08-17 14-53-56"));
        assert!(!is_timestamp_dir_name("2026-06-30_10-58-23"));
        assert!(!is_timestamp_dir_name("2026-06-30 10:58:23"));
        assert!(!is_timestamp_dir_name("newsg_4cfg"));
        assert!(!is_timestamp_dir_name("2026-06-30 10-58-2"));
        assert!(!is_timestamp_dir_name(""));
    }

    #[test]
    fn finds_newest_valid_output_dir_in_first_level_subdir() {
        let temp = TestTempDir::create("table-transfer-output");
        // 决胜2 形态：工作目录下先套一层库名目录。
        let container = temp.path().join("newsg_4cfg");
        std::fs::create_dir(&container).unwrap();
        let package = container.join("2026-08-17 14-53-56");
        std::fs::create_dir_all(package.join("props")).unwrap();
        std::fs::create_dir_all(package.join("src").join("props")).unwrap();
        // 缺 src/props 的不合格目录不能被选中。
        let incomplete = temp.path().join("2026-08-17 15-00-00");
        std::fs::create_dir_all(incomplete.join("props")).unwrap();

        // 用一个过去的时间作为"本次开始时间"，刚创建的目录都算新产出。
        let started_at = SystemTime::now() - Duration::from_secs(60);
        assert_eq!(find_latest_output_dir(temp.path(), started_at), Some(package));
    }

    #[test]
    fn ignores_dirs_older_than_run_start() {
        let temp = TestTempDir::create("table-transfer-stale");
        let package = temp.path().join("2026-08-17 14-53-56");
        std::fs::create_dir_all(package.join("props")).unwrap();
        std::fs::create_dir_all(package.join("src").join("props")).unwrap();

        // "开始时间"在未来 → 目录视为上一轮产出，不能被选中。
        let started_at = SystemTime::now() + Duration::from_secs(3600);
        assert_eq!(find_latest_output_dir(temp.path(), started_at), None);
    }

    #[test]
    fn conflict_strategy_maps_to_svn_accept_and_manual_stops_copy() {
        assert_eq!(parse_conflict_strategy(None), ConflictStrategy::Theirs);
        assert_eq!(parse_conflict_strategy(Some("mine")), ConflictStrategy::Mine);
        assert_eq!(parse_conflict_strategy(Some("manual")), ConflictStrategy::Manual);
        assert_eq!(parse_conflict_strategy(Some("bogus")), ConflictStrategy::Theirs);
        assert_eq!(svn_update_accept_arg(ConflictStrategy::Theirs), "theirs-full");
        assert_eq!(svn_update_accept_arg(ConflictStrategy::Mine), "mine-full");
        assert_eq!(svn_update_accept_arg(ConflictStrategy::Manual), "postpone");
        assert!(!conflict_strategy_auto_resolves(ConflictStrategy::Manual));
        assert!(conflict_strategy_auto_resolves(ConflictStrategy::Theirs));

        let message = format_manual_conflict_error(
            Path::new(r"D:\client\jswz\assets\props"),
            &[PathBuf::from(r"D:\client\jswz\assets\props\hero.json")],
        );
        assert!(message.contains("已暂停覆盖拷贝"));
        assert!(message.contains("hero.json"));
        assert!(message.contains("由我处理"));
    }

    #[test]
    fn parses_text_and_tree_conflicts_from_svn_status() {
        let output = "\
M       D:\\client\\jswz\\assets\\props\\hero.json
C       D:\\client\\jswz\\assets\\props\\skill.json
      C D:\\client\\jswz\\assets\\props\\monster.json
A       D:\\client\\jswz\\assets\\props\\new.json
?       D:\\client\\jswz\\assets\\props\\local.json
Summary of conflicts:
  Text conflicts: 1
  Tree conflicts: 1
";
        let conflicts = parse_svn_conflicts(output);
        assert_eq!(
            conflicts,
            vec![
                PathBuf::from("D:\\client\\jswz\\assets\\props\\skill.json"),
                PathBuf::from("D:\\client\\jswz\\assets\\props\\monster.json"),
            ]
        );
    }

    #[test]
    fn merge_copy_overwrites_same_name_and_keeps_extras() {
        let temp = TestTempDir::create("table-transfer-copy");
        let source = temp.path().join("src");
        let target = temp.path().join("dst");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(source.join("a.json"), "new-a").unwrap();
        std::fs::write(source.join("nested").join("b.json"), "new-b").unwrap();
        std::fs::write(target.join("a.json"), "old-a").unwrap();
        std::fs::write(target.join("keep.meta"), "keep").unwrap();

        let jobs = TableTransferJobs::default();
        let guard = jobs.register("copy-test").unwrap();
        let mut count = 0u64;
        merge_copy_dir(&source, &target, &mut count, None, &guard.cancellation()).unwrap();

        assert_eq!(count, 2);
        assert_eq!(std::fs::read_to_string(target.join("a.json")).unwrap(), "new-a");
        assert_eq!(
            std::fs::read_to_string(target.join("nested").join("b.json")).unwrap(),
            "new-b"
        );
        assert_eq!(std::fs::read_to_string(target.join("keep.meta")).unwrap(), "keep");
    }

    #[test]
    fn log_tail_keeps_last_lines_and_counts_total() {
        let temp = TestTempDir::create("table-transfer-log-tail");
        let path = temp.path().join("out.log");
        let body: String = (0..120).map(|index| format!("line-{index}\n")).collect();
        std::fs::write(&path, body).unwrap();
        let (total, tail) = read_log_tail(&path, 80);
        assert_eq!(total, 120);
        assert_eq!(tail.len(), 80);
        assert_eq!(tail[0], "line-40");
        assert_eq!(tail[79], "line-119");
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn chatty_script_does_not_block_on_slow_log_sink() {
        // 回归：脚本 stdout 若走管道且日志 sink（window.emit）在读取热路径上，
        // 4KB 管道一满子进程就会停写。手动双击 bat 是控制台、不堵；软件代跑
        // 就会从十几秒变成几分钟。这个测试用慢 sink 卡住读取，断言子进程
        // 仍能在几秒内跑完（输出改走文件，不再等 UI）。
        let temp = TestTempDir::create("table-transfer-chatty");
        let bat_path = temp.path().join("chatty.bat");
        std::fs::write(
            &bat_path,
            "@echo off\r\nnode -e \"for (let i=0;i<12000;i++) console.log('line-'+i)\"\r\n",
        )
        .unwrap();
        let launch = ScriptLaunch {
            program: bat_path,
            args: Vec::new(),
            work_dir: temp.path().to_path_buf(),
            kind: ScriptKind::Batch,
        };
        let jobs = TableTransferJobs::default();
        let guard = jobs.register("chatty-script").unwrap();
        let collected = std::sync::Mutex::new(Vec::<String>::new());
        let started = std::time::Instant::now();
        let status = run_script_with_log_sink(&launch, &guard, |line| {
            std::thread::sleep(Duration::from_millis(30));
            collected.lock().unwrap().push(line);
        })
        .await
        .expect("run chatty script");
        let elapsed = started.elapsed();
        assert!(status.success(), "chatty script failed: {status}");
        assert!(
            elapsed < Duration::from_secs(4),
            "转表脚本被日志转发堵住了（子进程 {elapsed:?} 才退出）。脚本输出必须离开管道读取热路径。"
        );
        let logs = collected.lock().unwrap().join("\n");
        assert!(
            logs.contains("line-11999") || logs.contains("line-11998"),
            "结束后仍应能看到脚本日志末尾: {logs}"
        );
    }

    #[test]
    fn cancelled_copy_stops_early() {
        let temp = TestTempDir::create("table-transfer-copy-cancel");
        let source = temp.path().join("src");
        let target = temp.path().join("dst");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("a.json"), "a").unwrap();

        let jobs = TableTransferJobs::default();
        let guard = jobs.register("copy-cancel-test").unwrap();
        guard.cancellation().cancel();
        let mut count = 0u64;
        let result = merge_copy_dir(&source, &target, &mut count, None, &guard.cancellation());
        assert!(result.is_err());
        assert_eq!(count, 0);
    }
}
