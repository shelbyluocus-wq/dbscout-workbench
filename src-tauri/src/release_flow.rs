//! Backend execution primitives for the Release Update workspace:
//! - Incremental client file sync (`sourceClient -> targetClient`) with
//!   gitignore-like exclusion rules matching `releaseFileRules.js` and
//!   byte-accurate change detection across separate SVN working copies.
//! - Live relay-database open-plan flag reads (`heroprop`, `buildopenplatprop`,
//!   etc.) and atomic transactional plan `UPDATE` execution.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{Emitter, State, Window};

use crate::db::escape_ident;
use crate::perf::PerfContext;
use crate::types::AppState;

pub const CLIENT_SYNC_PROGRESS_EVENT: &str = "release-client-sync-progress";
pub const ALWAYS_EXCLUDED_RULES: [&str; 1] = [".svn/"];
const MAX_PREVIEW_ITEMS: usize = 1500;
const PROGRESS_THROTTLE: Duration = Duration::from_millis(150);

/* ── Exclusion rules (1:1 with src/workbench/utils/releaseFileRules.js) ─── */

#[derive(Debug, Clone, PartialEq, Eq)]
enum GlobToken {
    Literal(char),
    Question,
    Star,
    DoubleStar,
}

#[derive(Debug, Clone)]
pub struct CompiledExclusionRule {
    pub raw: String,
    pub folder: bool,
    pub anchored: bool,
    tokens: Vec<GlobToken>,
}

pub fn normalize_client_path(path: &str) -> String {
    let replaced = path.trim().replace('\\', "/");
    replaced
        .strip_prefix("./")
        .unwrap_or(&replaced)
        .to_string()
}

pub fn normalize_exclusion_rule(rule: &str) -> String {
    let raw = normalize_client_path(rule);
    let mut collapsed = String::with_capacity(raw.len());
    let mut prev_slash = false;
    for ch in raw.chars() {
        if ch == '/' {
            if !prev_slash {
                collapsed.push('/');
            }
            prev_slash = true;
        } else {
            collapsed.push(ch);
            prev_slash = false;
        }
    }
    collapsed
}

fn tokenize_glob(pattern: &str) -> Vec<GlobToken> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut tokens = Vec::with_capacity(chars.len());
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '*' if chars.get(index + 1) == Some(&'*') => {
                if !matches!(tokens.last(), Some(GlobToken::DoubleStar)) {
                    tokens.push(GlobToken::DoubleStar);
                }
                index += 2;
            }
            '*' => {
                tokens.push(GlobToken::Star);
                index += 1;
            }
            '?' => {
                tokens.push(GlobToken::Question);
                index += 1;
            }
            ch => {
                tokens.push(GlobToken::Literal(ch));
                index += 1;
            }
        }
    }
    tokens
}

fn match_tokens_from(
    tokens: &[GlobToken],
    text: &[char],
    t_idx: usize,
    s_idx: usize,
    folder: bool,
) -> bool {
    if t_idx == tokens.len() {
        return if folder {
            text.get(s_idx) == Some(&'/')
        } else {
            s_idx == text.len() || text.get(s_idx) == Some(&'/')
        };
    }
    match tokens[t_idx] {
        GlobToken::Literal(expected) => {
            text.get(s_idx) == Some(&expected)
                && match_tokens_from(tokens, text, t_idx + 1, s_idx + 1, folder)
        }
        GlobToken::Question => {
            matches!(text.get(s_idx), Some(&ch) if ch != '/')
                && match_tokens_from(tokens, text, t_idx + 1, s_idx + 1, folder)
        }
        GlobToken::Star => {
            let mut pos = s_idx;
            loop {
                if match_tokens_from(tokens, text, t_idx + 1, pos, folder) {
                    return true;
                }
                match text.get(pos) {
                    Some(&ch) if ch != '/' => pos += 1,
                    _ => return false,
                }
            }
        }
        GlobToken::DoubleStar => {
            for pos in s_idx..=text.len() {
                if match_tokens_from(tokens, text, t_idx + 1, pos, folder) {
                    return true;
                }
            }
            false
        }
    }
}

impl CompiledExclusionRule {
    pub fn compile(rule: &str) -> Option<Self> {
        let normalized = normalize_exclusion_rule(rule);
        let folder = normalized.ends_with('/');
        let without_trailing = normalized.trim_end_matches('/');
        let anchored = without_trailing.contains('/');
        let body = without_trailing.trim_start_matches('/').to_lowercase();
        if body.is_empty() {
            return None;
        }
        Some(Self {
            raw: normalized,
            folder,
            anchored,
            tokens: tokenize_glob(&body),
        })
    }

    pub fn matches(&self, normalized_lower_chars: &[char]) -> bool {
        if self.anchored {
            return match_tokens_from(&self.tokens, normalized_lower_chars, 0, 0, self.folder);
        }
        if match_tokens_from(&self.tokens, normalized_lower_chars, 0, 0, self.folder) {
            return true;
        }
        for (idx, ch) in normalized_lower_chars.iter().enumerate() {
            if *ch == '/'
                && match_tokens_from(&self.tokens, normalized_lower_chars, 0, idx + 1, self.folder)
            {
                return true;
            }
        }
        false
    }
}

pub struct ExclusionMatcher {
    rules: Vec<CompiledExclusionRule>,
}

impl ExclusionMatcher {
    pub fn new(user_rules: &[String]) -> Self {
        let mut seen = HashSet::new();
        let mut rules = Vec::new();
        for candidate in ALWAYS_EXCLUDED_RULES
            .iter()
            .copied()
            .chain(user_rules.iter().map(String::as_str))
        {
            if let Some(compiled) = CompiledExclusionRule::compile(candidate) {
                let key = compiled.raw.to_lowercase();
                if seen.insert(key) {
                    rules.push(compiled);
                }
            }
        }
        Self { rules }
    }

    pub fn excluding_rule(&self, path: &str) -> Option<&str> {
        let lower: Vec<char> = normalize_client_path(path).to_lowercase().chars().collect();
        self.rules
            .iter()
            .find(|rule| rule.matches(&lower))
            .map(|rule| rule.raw.as_str())
    }

    /// True when a directory itself is excluded by a folder rule (e.g. `.svn/`
    /// or `library/`), allowing the walker to skip descending into it.
    pub fn excluding_dir_rule(&self, dir_rel: &str) -> Option<&str> {
        let with_slash = format!("{}/", normalize_client_path(dir_rel).trim_end_matches('/'));
        let lower: Vec<char> = with_slash.to_lowercase().chars().collect();
        self.rules
            .iter()
            .filter(|rule| rule.folder)
            .find(|rule| rule.matches(&lower))
            .map(|rule| rule.raw.as_str())
    }
}

/* ── Client Sync Job Registry ──────────────────────────────────────────── */

#[derive(Default)]
pub struct ReleaseClientSyncJobs {
    active: Mutex<Option<(String, Arc<AtomicBool>)>>,
}

struct ClientSyncJobGuard<'a> {
    jobs: &'a ReleaseClientSyncJobs,
    job_id: String,
    cancelled: Arc<AtomicBool>,
}

impl ReleaseClientSyncJobs {
    fn register(&self, job_id: &str) -> Result<ClientSyncJobGuard<'_>, String> {
        let trimmed = job_id.trim();
        let id = if trimmed.is_empty() {
            "client-sync"
        } else {
            trimmed
        };
        let mut guard = self
            .active
            .lock()
            .map_err(|_| "文件同步状态锁异常".to_string())?;
        if guard.is_some() {
            return Err("已有客户端文件同步任务正在运行".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *guard = Some((id.to_string(), cancelled.clone()));
        Ok(ClientSyncJobGuard {
            jobs: self,
            job_id: id.to_string(),
            cancelled,
        })
    }

    pub fn cancel(&self, job_id: Option<&str>) -> bool {
        let Ok(guard) = self.active.lock() else {
            return false;
        };
        let Some((active_id, flag)) = guard.as_ref() else {
            return false;
        };
        if let Some(requested) = job_id.map(str::trim).filter(|id| !id.is_empty()) {
            if requested != active_id {
                return false;
            }
        }
        flag.store(true, Ordering::SeqCst);
        true
    }
}

impl Drop for ClientSyncJobGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.jobs.active.lock() {
            if guard.as_ref().is_some_and(|(id, _)| id == &self.job_id) {
                *guard = None;
            }
        }
    }
}

/* ── Incremental Client File Sync ──────────────────────────────────────── */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseClientFileChange {
    pub status: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseClientExcludedFile {
    pub status: String,
    pub path: String,
    pub rule: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseClientSyncCounts {
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub kept: usize,
    pub excluded: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseClientSyncPreviewResponse {
    pub copy: Vec<ReleaseClientFileChange>,
    pub remove: Vec<ReleaseClientFileChange>,
    pub kept: Vec<ReleaseClientFileChange>,
    pub excluded: Vec<ReleaseClientExcludedFile>,
    pub counts: ReleaseClientSyncCounts,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseClientSyncPreviewRequest {
    pub source_client: String,
    pub target_client: String,
    #[serde(default)]
    pub rules: Vec<String>,
    #[serde(default)]
    pub mirror_deletes: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseClientSyncRunRequest {
    #[serde(default)]
    pub job_id: String,
    pub source_client: String,
    pub target_client: String,
    #[serde(default)]
    pub rules: Vec<String>,
    #[serde(default)]
    pub mirror_deletes: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseClientSyncCancelRequest {
    pub job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseClientSyncWarning {
    pub code: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseClientSyncRunResponse {
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub excluded: usize,
    pub warnings: Vec<ReleaseClientSyncWarning>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseClientSyncProgressPayload {
    pub job_id: String,
    pub done: usize,
    pub total: usize,
    pub current_path: String,
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
}

#[derive(Debug, Clone)]
struct ScannedFile {
    rel: String,
    abs: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

struct FullSyncPlan {
    copy: Vec<(ReleaseClientFileChange, ScannedFile, PathBuf)>,
    remove: Vec<(ReleaseClientFileChange, PathBuf)>,
    kept: Vec<ReleaseClientFileChange>,
    excluded: Vec<ReleaseClientExcludedFile>,
}

fn validate_client_roots(source_raw: &str, target_raw: &str) -> Result<(PathBuf, PathBuf), String> {
    let source = PathBuf::from(source_raw.trim());
    let target = PathBuf::from(target_raw.trim());
    if source_raw.trim().is_empty() || !source.is_dir() {
        return Err(format!("找不到开发客户端目录：{}", source_raw.trim()));
    }
    if target_raw.trim().is_empty() || !target.is_dir() {
        return Err(format!("找不到平台客户端目录：{}", target_raw.trim()));
    }
    let canon_source = fs::canonicalize(&source)
        .map_err(|error| format!("无法解析开发客户端目录（{}）：{error}", source.display()))?;
    let canon_target = fs::canonicalize(&target)
        .map_err(|error| format!("无法解析平台客户端目录（{}）：{error}", target.display()))?;
    if canon_source == canon_target {
        return Err("开发客户端与平台客户端不能是同一个目录".into());
    }
    if canon_target.starts_with(&canon_source) || canon_source.starts_with(&canon_target) {
        return Err("开发客户端与平台客户端目录不能互相嵌套".into());
    }
    Ok((canon_source, canon_target))
}

fn scan_client_tree(
    root: &Path,
    matcher: &ExclusionMatcher,
    files: &mut BTreeMap<String, ScannedFile>,
    excluded: &mut BTreeMap<String, ReleaseClientExcludedFile>,
    cancelled: Option<&AtomicBool>,
) -> Result<(), String> {
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel_prefix)) = stack.pop() {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return Err("cancelled".into());
        }
        let entries = fs::read_dir(&dir)
            .map_err(|error| format!("读取目录失败（{}）：{error}", dir.display()))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("读取目录项失败（{}）：{error}", dir.display()))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("读取文件类型失败（{}）：{error}", entry.path().display()))?;
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if rel_prefix.is_empty() {
                name
            } else {
                format!("{rel_prefix}/{name}")
            };
            if file_type.is_dir() {
                if let Some(rule) = matcher.excluding_dir_rule(&rel) {
                    let display = format!("{rel}/");
                    excluded
                        .entry(display.to_lowercase())
                        .or_insert_with(|| ReleaseClientExcludedFile {
                            status: "M".into(),
                            path: display,
                            rule: rule.to_string(),
                        });
                    continue;
                }
                stack.push((entry.path(), rel));
            } else if file_type.is_file() {
                if let Some(rule) = matcher.excluding_rule(&rel) {
                    excluded
                        .entry(rel.to_lowercase())
                        .or_insert_with(|| ReleaseClientExcludedFile {
                            status: "M".into(),
                            path: rel,
                            rule: rule.to_string(),
                        });
                    continue;
                }
                let meta = entry
                    .metadata()
                    .map_err(|error| format!("读取文件信息失败（{}）：{error}", entry.path().display()))?;
                files.insert(
                    rel.to_lowercase(),
                    ScannedFile {
                        rel,
                        abs: entry.path(),
                        len: meta.len(),
                        modified: meta.modified().ok(),
                    },
                );
            }
        }
    }
    Ok(())
}

fn files_identical(src: &ScannedFile, dst: &ScannedFile) -> Result<bool, String> {
    if src.len != dst.len {
        return Ok(false);
    }
    if src.len == 0 {
        return Ok(true);
    }
    if let (Some(src_m), Some(dst_m)) = (src.modified, dst.modified) {
        if src_m == dst_m {
            return Ok(true);
        }
    }
    let mut left = BufReader::with_capacity(64 * 1024, File::open(&src.abs).map_err(|e| format!("读取文件失败（{}）：{e}", src.abs.display()))?);
    let mut right = BufReader::with_capacity(64 * 1024, File::open(&dst.abs).map_err(|e| format!("读取文件失败（{}）：{e}", dst.abs.display()))?);
    let mut buf_l = [0u8; 64 * 1024];
    let mut buf_r = [0u8; 64 * 1024];
    loop {
        let read_l = left
            .read(&mut buf_l)
            .map_err(|e| format!("读取文件失败（{}）：{e}", src.abs.display()))?;
        if read_l == 0 {
            return Ok(true);
        }
        right
            .read_exact(&mut buf_r[..read_l])
            .map_err(|e| format!("读取文件失败（{}）：{e}", dst.abs.display()))?;
        if buf_l[..read_l] != buf_r[..read_l] {
            return Ok(false);
        }
    }
}

fn build_sync_plan(
    source_root: &Path,
    target_root: &Path,
    rules: &[String],
    mirror_deletes: bool,
    cancelled: Option<&AtomicBool>,
) -> Result<FullSyncPlan, String> {
    let matcher = ExclusionMatcher::new(rules);
    let mut source_files = BTreeMap::new();
    let mut target_files = BTreeMap::new();
    let mut excluded_map = BTreeMap::new();

    scan_client_tree(source_root, &matcher, &mut source_files, &mut excluded_map, cancelled)?;
    scan_client_tree(target_root, &matcher, &mut target_files, &mut excluded_map, cancelled)?;

    let mut copy = Vec::new();
    for (key, src) in &source_files {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return Err("cancelled".into());
        }
        match target_files.get(key) {
            None => {
                let dst_path = target_root.join(Path::new(&src.rel));
                copy.push((
                    ReleaseClientFileChange {
                        status: "A".into(),
                        path: src.rel.clone(),
                    },
                    src.clone(),
                    dst_path,
                ));
            }
            Some(dst) => {
                if !files_identical(src, dst)? {
                    copy.push((
                        ReleaseClientFileChange {
                            status: "M".into(),
                            path: src.rel.clone(),
                        },
                        src.clone(),
                        dst.abs.clone(),
                    ));
                }
            }
        }
    }

    let mut remove = Vec::new();
    let mut kept = Vec::new();
    for (key, dst) in &target_files {
        if source_files.contains_key(key) {
            continue;
        }
        let change = ReleaseClientFileChange {
            status: "D".into(),
            path: dst.rel.clone(),
        };
        if mirror_deletes {
            remove.push((change, dst.abs.clone()));
        } else {
            kept.push(change);
        }
    }

    Ok(FullSyncPlan {
        copy,
        remove,
        kept,
        excluded: excluded_map.into_values().collect(),
    })
}

pub fn preview_client_sync(
    source_raw: &str,
    target_raw: &str,
    rules: &[String],
    mirror_deletes: bool,
) -> Result<ReleaseClientSyncPreviewResponse, String> {
    let (source_root, target_root) = validate_client_roots(source_raw, target_raw)?;
    let plan = build_sync_plan(&source_root, &target_root, rules, mirror_deletes, None)?;
    let added = plan.copy.iter().filter(|(change, _, _)| change.status == "A").count();
    let modified = plan.copy.iter().filter(|(change, _, _)| change.status == "M").count();
    let counts = ReleaseClientSyncCounts {
        added,
        modified,
        deleted: plan.remove.len(),
        kept: plan.kept.len(),
        excluded: plan.excluded.len(),
    };
    let truncated = plan.copy.len() > MAX_PREVIEW_ITEMS
        || plan.remove.len() > MAX_PREVIEW_ITEMS
        || plan.kept.len() > MAX_PREVIEW_ITEMS
        || plan.excluded.len() > MAX_PREVIEW_ITEMS;

    Ok(ReleaseClientSyncPreviewResponse {
        copy: plan
            .copy
            .into_iter()
            .take(MAX_PREVIEW_ITEMS)
            .map(|(change, _, _)| change)
            .collect(),
        remove: plan
            .remove
            .into_iter()
            .take(MAX_PREVIEW_ITEMS)
            .map(|(change, _)| change)
            .collect(),
        kept: plan.kept.into_iter().take(MAX_PREVIEW_ITEMS).collect(),
        excluded: plan.excluded.into_iter().take(MAX_PREVIEW_ITEMS).collect(),
        counts,
        truncated,
    })
}

fn prune_empty_ancestors(file_path: &Path, stop_root: &Path) {
    let mut current = file_path.parent();
    while let Some(dir) = current {
        if dir == stop_root || !dir.starts_with(stop_root) {
            break;
        }
        if dir.join(".svn").exists() {
            break;
        }
        let is_empty = fs::read_dir(dir)
            .ok()
            .is_some_and(|mut iter| iter.next().is_none());
        if !is_empty || fs::remove_dir(dir).is_err() {
            break;
        }
        current = dir.parent();
    }
}

pub fn execute_client_sync<F>(
    source_raw: &str,
    target_raw: &str,
    rules: &[String],
    mirror_deletes: bool,
    cancelled: &AtomicBool,
    mut on_progress: F,
) -> Result<ReleaseClientSyncRunResponse, String>
where
    F: FnMut(usize, usize, &str, usize, usize, usize),
{
    let (source_root, target_root) = validate_client_roots(source_raw, target_raw)?;
    let plan = build_sync_plan(&source_root, &target_root, rules, mirror_deletes, Some(cancelled))?;
    let total = plan.copy.len() + plan.remove.len();
    let excluded_count = plan.excluded.len();
    let mut added = 0usize;
    let mut modified = 0usize;
    let mut deleted = 0usize;
    let mut done = 0usize;
    let mut warnings = Vec::new();
    let mut last_emit = Instant::now() - PROGRESS_THROTTLE;

    for (change, src, dst) in &plan.copy {
        if cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        if !src.abs.is_file() {
            warnings.push(ReleaseClientSyncWarning {
                code: "missing".into(),
                path: change.path.clone(),
            });
            done += 1;
            continue;
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建目标目录失败（{}）：{error}", parent.display()))?;
        }
        match fs::copy(&src.abs, dst) {
            Ok(_) => {
                if let Some(mtime) = src.modified {
                    if let Ok(dest_file) = File::options().write(true).open(dst) {
                        let _ = dest_file.set_modified(mtime);
                    }
                }
                if change.status == "A" {
                    added += 1;
                } else {
                    modified += 1;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                warnings.push(ReleaseClientSyncWarning {
                    code: "missing".into(),
                    path: change.path.clone(),
                });
            }
            Err(error) => {
                return Err(format!("复制文件失败（{}）：{error}", change.path));
            }
        }
        done += 1;
        if last_emit.elapsed() >= PROGRESS_THROTTLE || done == total {
            on_progress(done, total, &change.path, added, modified, deleted);
            last_emit = Instant::now();
        }
    }

    for (change, dst) in &plan.remove {
        if cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        match fs::remove_file(dst) {
            Ok(()) => {
                deleted += 1;
                prune_empty_ancestors(dst, &target_root);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("删除目标多余文件失败（{}）：{error}", change.path));
            }
        }
        done += 1;
        if last_emit.elapsed() >= PROGRESS_THROTTLE || done == total {
            on_progress(done, total, &change.path, added, modified, deleted);
            last_emit = Instant::now();
        }
    }

    Ok(ReleaseClientSyncRunResponse {
        added,
        modified,
        deleted,
        excluded: excluded_count,
        warnings,
    })
}

#[tauri::command]
pub async fn release_client_sync_preview(
    request: ReleaseClientSyncPreviewRequest,
) -> Result<ReleaseClientSyncPreviewResponse, String> {
    tokio::task::spawn_blocking(move || {
        preview_client_sync(
            &request.source_client,
            &request.target_client,
            &request.rules,
            request.mirror_deletes,
        )
    })
    .await
    .map_err(|error| format!("文件差异扫描任务异常：{error}"))?
}

#[tauri::command]
pub async fn release_client_sync_run(
    window: Window,
    state: State<'_, AppState>,
    request: ReleaseClientSyncRunRequest,
) -> Result<ReleaseClientSyncRunResponse, String> {
    let guard = state.release_client_sync.register(&request.job_id)?;
    let job_id = guard.job_id.clone();
    let cancelled = guard.cancelled.clone();
    let emit_window = window.clone();
    let result = tokio::task::spawn_blocking(move || {
        execute_client_sync(
            &request.source_client,
            &request.target_client,
            &request.rules,
            request.mirror_deletes,
            &cancelled,
            |done, total, current_path, added, modified, deleted| {
                let _ = emit_window.emit(
                    CLIENT_SYNC_PROGRESS_EVENT,
                    ReleaseClientSyncProgressPayload {
                        job_id: job_id.clone(),
                        done,
                        total,
                        current_path: current_path.to_string(),
                        added,
                        modified,
                        deleted,
                    },
                );
            },
        )
    })
    .await
    .map_err(|error| format!("文件同步执行异常：{error}"))?;
    drop(guard);
    result
}

#[tauri::command]
pub async fn release_client_sync_cancel(
    state: State<'_, AppState>,
    request: ReleaseClientSyncCancelRequest,
) -> Result<bool, String> {
    Ok(state.release_client_sync.cancel(request.job_id.as_deref()))
}

/* ── Relay Database Open-Plan Flag Read & Transactional Write ──────────── */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePlanQueryItem {
    pub id: String,
    pub keys: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePlanQueryGroup {
    pub table: String,
    pub key_columns: Vec<String>,
    pub flag_column: String,
    pub items: Vec<ReleasePlanQueryItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseReadPlanFlagsRequest {
    pub connection_id: String,
    pub database: String,
    pub groups: Vec<ReleasePlanQueryGroup>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseReadPlanFlagsResponse {
    pub flags: HashMap<String, i64>,
    pub missing_tables: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePlanWriteGroup {
    pub table: String,
    pub key_columns: Vec<String>,
    pub flag_column: String,
    pub flag: i64,
    pub keys: Vec<Vec<i64>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseExecutePlanWritesRequest {
    pub connection_id: String,
    pub database: String,
    pub writes: Vec<ReleasePlanWriteGroup>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseExecutePlanWritesResponse {
    pub statements: usize,
    pub affected_rows: u64,
    pub executed_sql: Vec<String>,
}

fn validate_ident<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(format!("无效的{label}名称"));
    }
    Ok(trimmed)
}

fn quote_ident(value: &str) -> String {
    format!("`{}`", escape_ident(value))
}

fn build_in_clause_placeholders(arity: usize, tuple_count: usize) -> String {
    if arity == 1 {
        vec!["?"; tuple_count].join(", ")
    } else {
        let single = format!("({})", vec!["?"; arity].join(", "));
        vec![single; tuple_count].join(", ")
    }
}

pub fn format_plan_update_sql(table: &str, key_columns: &[String], flag_column: &str, flag: i64, keys: &[Vec<i64>]) -> Result<String, String> {
    let table_ident = quote_ident(validate_ident(table, "数据表")?);
    let flag_ident = quote_ident(validate_ident(flag_column, "状态字段")?);
    if flag != 0 && flag != 1 {
        return Err(format!("开放规划状态值仅支持 0 或 1，收到：{flag}"));
    }
    if key_columns.is_empty() {
        return Err("开放规划缺少主键列定义".into());
    }
    if keys.is_empty() {
        return Err("开放规划没有需要更新的主键值".into());
    }
    let mut col_idents = Vec::with_capacity(key_columns.len());
    for col in key_columns {
        col_idents.push(quote_ident(validate_ident(col, "主键字段")?));
    }
    for tuple in keys {
        if tuple.len() != key_columns.len() {
            return Err(format!(
                "表 {table} 主键元组长度（{}）与字段数（{}）不一致",
                tuple.len(),
                key_columns.len()
            ));
        }
    }
    let target = if col_idents.len() == 1 {
        col_idents[0].clone()
    } else {
        format!("({})", col_idents.join(", "))
    };
    let values = if col_idents.len() == 1 {
        keys.iter().map(|tuple| tuple[0].to_string()).collect::<Vec<_>>().join(", ")
    } else {
        keys.iter()
            .map(|tuple| {
                format!(
                    "({})",
                    tuple.iter().map(i64::to_string).collect::<Vec<_>>().join(", ")
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    Ok(format!(
        "UPDATE {table_ident} SET {flag_ident} = {flag} WHERE {target} IN ({values});"
    ))
}

async fn load_existing_table_names(
    pool: &sqlx::MySqlPool,
    database: &str,
) -> Result<HashMap<String, String>, String> {
    let rows = sqlx::query(
        "SELECT CAST(TABLE_NAME AS CHAR) AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
    )
    .bind(database)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取数据库 {database} 表清单失败：{error}"))?;
    let mut map = HashMap::with_capacity(rows.len());
    for row in rows {
        if let Ok(name) = row.try_get::<String, _>("table_name") {
            map.insert(name.to_lowercase(), name);
        }
    }
    Ok(map)
}

#[tauri::command]
pub async fn release_read_plan_flags(
    request: ReleaseReadPlanFlagsRequest,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<ReleaseReadPlanFlagsResponse, String> {
    let database = validate_ident(&request.database, "目标数据库")?;
    if request.groups.is_empty() {
        return Ok(ReleaseReadPlanFlagsResponse::default());
    }
    let pool = crate::commands::real_database_pool(
        &request.connection_id,
        database,
        &state,
        &perf_context,
    )
    .await?;
    let existing_tables = load_existing_table_names(&pool, database).await?;
    let mut flags = HashMap::new();
    let mut missing_tables = Vec::new();

    for group in &request.groups {
        let requested_table = validate_ident(&group.table, "数据表")?;
        let Some(actual_table) = existing_tables.get(&requested_table.to_lowercase()) else {
            if !missing_tables.iter().any(|item: &String| item.eq_ignore_ascii_case(requested_table)) {
                missing_tables.push(requested_table.to_string());
            }
            continue;
        };
        if group.key_columns.is_empty() {
            continue;
        }
        let valid_items: Vec<&ReleasePlanQueryItem> = group
            .items
            .iter()
            .filter(|item| item.keys.len() == group.key_columns.len())
            .collect();
        if valid_items.is_empty() {
            continue;
        }

        let arity = group.key_columns.len();
        let mut select_cols = Vec::with_capacity(arity + 1);
        let mut key_idents = Vec::with_capacity(arity);
        for (idx, col) in group.key_columns.iter().enumerate() {
            let ident = quote_ident(validate_ident(col, "主键字段")?);
            select_cols.push(format!("CAST({ident} AS SIGNED) AS k{idx}"));
            key_idents.push(ident);
        }
        let flag_ident = quote_ident(validate_ident(&group.flag_column, "状态字段")?);
        select_cols.push(format!("CAST({flag_ident} AS SIGNED) AS flag_val"));
        let target_expr = if arity == 1 {
            key_idents[0].clone()
        } else {
            format!("({})", key_idents.join(", "))
        };
        let placeholders = build_in_clause_placeholders(arity, valid_items.len());
        let sql = format!(
            "SELECT {} FROM {} WHERE {} IN ({})",
            select_cols.join(", "),
            quote_ident(actual_table),
            target_expr,
            placeholders
        );

        let mut query = sqlx::query(&sql);
        for item in &valid_items {
            for value in &item.keys {
                query = query.bind(*value);
            }
        }
        let rows = match query.fetch_all(&pool).await {
            Ok(rows) => rows,
            Err(_) => {
                // If a non-standard database lacks the expected column, fall back gracefully.
                continue;
            }
        };

        let mut by_tuple: HashMap<Vec<i64>, i64> = HashMap::with_capacity(rows.len());
        for row in rows {
            let mut tuple = Vec::with_capacity(arity);
            let mut ok = true;
            for idx in 0..arity {
                let col_alias = format!("k{idx}");
                match row.try_get::<Option<i64>, _>(col_alias.as_str()) {
                    Ok(Some(v)) => tuple.push(v),
                    _ => {
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                if let Ok(Some(flag_val)) = row.try_get::<Option<i64>, _>("flag_val") {
                    by_tuple.insert(tuple, flag_val);
                }
            }
        }

        for item in valid_items {
            if let Some(flag_val) = by_tuple.get(&item.keys) {
                flags.insert(item.id.clone(), *flag_val);
            }
        }
    }

    Ok(ReleaseReadPlanFlagsResponse {
        flags,
        missing_tables,
    })
}

#[tauri::command]
pub async fn release_execute_plan_writes(
    request: ReleaseExecutePlanWritesRequest,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<ReleaseExecutePlanWritesResponse, String> {
    let database = validate_ident(&request.database, "目标数据库")?;
    let active_writes: Vec<&ReleasePlanWriteGroup> =
        request.writes.iter().filter(|group| !group.keys.is_empty()).collect();
    if active_writes.is_empty() {
        return Ok(ReleaseExecutePlanWritesResponse {
            statements: 0,
            affected_rows: 0,
            executed_sql: Vec::new(),
        });
    }

    // Validate all groups up-front before opening a transaction.
    for group in &active_writes {
        format_plan_update_sql(
            &group.table,
            &group.key_columns,
            &group.flag_column,
            group.flag,
            &group.keys,
        )?;
    }

    let pool = crate::commands::real_database_pool(
        &request.connection_id,
        database,
        &state,
        &perf_context,
    )
    .await?;
    let existing_tables = load_existing_table_names(&pool, database).await?;

    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("开启开放规划数据库事务失败：{error}"))?;
    let mut affected_rows = 0u64;
    let mut executed_sql = Vec::with_capacity(active_writes.len());

    for group in active_writes {
        let actual_table = existing_tables
            .get(&group.table.trim().to_lowercase())
            .map(String::as_str)
            .unwrap_or_else(|| group.table.trim());
        let display_sql = format_plan_update_sql(
            actual_table,
            &group.key_columns,
            &group.flag_column,
            group.flag,
            &group.keys,
        )?;
        let arity = group.key_columns.len();
        let key_idents: Vec<String> = group
            .key_columns
            .iter()
            .map(|col| quote_ident(col.trim()))
            .collect();
        let target_expr = if arity == 1 {
            key_idents[0].clone()
        } else {
            format!("({})", key_idents.join(", "))
        };
        let placeholders = build_in_clause_placeholders(arity, group.keys.len());
        let parameterized = format!(
            "UPDATE {} SET {} = ? WHERE {} IN ({})",
            quote_ident(actual_table),
            quote_ident(group.flag_column.trim()),
            target_expr,
            placeholders
        );

        let mut query = sqlx::query(&parameterized).bind(group.flag);
        for tuple in &group.keys {
            for value in tuple {
                query = query.bind(*value);
            }
        }
        let outcome = query
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("写入开放规划失败（{actual_table}）：{error}"))?;
        affected_rows += outcome.rows_affected();
        executed_sql.push(display_sql);
    }

    tx.commit()
        .await
        .map_err(|error| format!("提交开放规划事务失败：{error}"))?;

    Ok(ReleaseExecutePlanWritesResponse {
        statements: executed_sql.len(),
        affected_rows,
        executed_sql,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_temp_dir::TempDir;

    fn excluding(path: &str, rules: &[&str]) -> String {
        let owned: Vec<String> = rules.iter().map(|r| (*r).to_string()).collect();
        ExclusionMatcher::new(&owned)
            .excluding_rule(path)
            .unwrap_or("")
            .to_string()
    }

    #[test]
    fn exclusion_matcher_matches_js_release_file_rules_semantics() {
        assert_eq!(excluding("library/imports/3a/x.json", &["library/"]), "library/");
        assert_eq!(excluding("tools/library/readme.md", &["library/"]), "library/");
        assert_eq!(
            excluding("assets/resources/channel/tw/sdk.json", &["assets/resources/channel/"]),
            "assets/resources/channel/"
        );
        assert_eq!(
            excluding("other/assets/resources/channel/a.json", &["assets/resources/channel/"]),
            ""
        );
        assert_eq!(excluding("assets/library.ts", &["library/"]), "");
        assert_eq!(
            excluding("assets\\script\\config\\ChannelConfig.ts", &["assets/script/config/channelconfig.ts"]),
            "assets/script/config/channelconfig.ts"
        );
        assert_eq!(excluding("assets/a/b/c.meta", &["*.meta"]), "*.meta");
        assert_eq!(excluding("assets/a/b/c.meta.bak", &["*.meta"]), "");
        assert_eq!(excluding("assets/x/deep/y.json", &["assets/**/y.json"]), "assets/**/y.json");
        assert_eq!(excluding("assets/x/y.json", &["assets/*/y.json"]), "assets/*/y.json");
        assert_eq!(excluding("assets/x/deep/y.json", &["assets/*/y.json"]), "");
        assert_eq!(excluding(".svn/wc.db", &[]), ".svn/");
        assert_eq!(excluding("assets/.svn/entries", &[]), ".svn/");
        assert_eq!(excluding("build/android/main.js", &["/build/"]), "/build/");
        assert_eq!(excluding("assets/build/main.js", &["/build/"]), "");
    }

    #[test]
    fn incremental_sync_detects_byte_changes_preserves_exclusions_and_mirrors_deletes() {
        let temp = TempDir::create("release-client-sync");
        let src = temp.path().join("dev-client");
        let dst = temp.path().join("plat-client");
        fs::create_dir_all(src.join("assets/src")).unwrap();
        fs::create_dir_all(src.join("assets/config")).unwrap();
        fs::create_dir_all(src.join("library/imports")).unwrap();
        fs::create_dir_all(src.join(".svn")).unwrap();
        fs::create_dir_all(dst.join("assets/src")).unwrap();
        fs::create_dir_all(dst.join("assets/config")).unwrap();
        fs::create_dir_all(dst.join("assets/legacy")).unwrap();
        fs::create_dir_all(dst.join(".svn")).unwrap();

        // Identical content (even if timestamps differ between two SVN checkouts) -> NOT marked M!
        fs::write(src.join("assets/src/same.ts"), "export const v = 1;\n").unwrap();
        fs::write(dst.join("assets/src/same.ts"), "export const v = 1;\n").unwrap();

        // Same byte length ("10" vs "20") -> MUST be caught as M by byte comparison!
        fs::write(src.join("assets/src/hero.ts"), "export const hero = 20;\n").unwrap();
        fs::write(dst.join("assets/src/hero.ts"), "export const hero = 10;\n").unwrap();

        // Added in dev
        fs::write(src.join("assets/src/new_pet.ts"), "export const pet = 1;\n").unwrap();

        // Excluded platform config & library & .svn must never be overwritten or deleted
        fs::write(src.join("assets/config/Config.ts"), "DEV_ENDPOINT").unwrap();
        fs::write(dst.join("assets/config/Config.ts"), "TW_PROD_ENDPOINT").unwrap();
        fs::write(src.join("library/imports/cache.json"), "{}").unwrap();
        fs::write(src.join(".svn/wc.db"), "dev-svn").unwrap();
        fs::write(dst.join(".svn/wc.db"), "tw-svn").unwrap();

        // Target-only file
        fs::write(dst.join("assets/legacy/old.png"), "old").unwrap();

        let rules = vec![
            "library/".to_string(),
            "assets/config/Config.ts".to_string(),
        ];

        // 1. Preview without mirror_deletes keeps target-only file
        let preview_keep = preview_client_sync(
            &src.to_string_lossy(),
            &dst.to_string_lossy(),
            &rules,
            false,
        )
        .unwrap();
        assert_eq!(preview_keep.counts.added, 1);
        assert_eq!(preview_keep.counts.modified, 1);
        assert_eq!(preview_keep.counts.deleted, 0);
        assert_eq!(preview_keep.counts.kept, 1);
        assert!(preview_keep.counts.excluded >= 2);

        // 2. Execute with mirror_deletes = true
        let cancelled = AtomicBool::new(false);
        let outcome = execute_client_sync(
            &src.to_string_lossy(),
            &dst.to_string_lossy(),
            &rules,
            true,
            &cancelled,
            |_, _, _, _, _, _| {},
        )
        .unwrap();
        assert_eq!(outcome.added, 1);
        assert_eq!(outcome.modified, 1);
        assert_eq!(outcome.deleted, 1);
        assert!(outcome.warnings.is_empty());

        // Verify disk state
        assert_eq!(fs::read_to_string(dst.join("assets/src/hero.ts")).unwrap(), "export const hero = 20;\n");
        assert_eq!(fs::read_to_string(dst.join("assets/src/new_pet.ts")).unwrap(), "export const pet = 1;\n");
        assert_eq!(fs::read_to_string(dst.join("assets/config/Config.ts")).unwrap(), "TW_PROD_ENDPOINT");
        assert_eq!(fs::read_to_string(dst.join(".svn/wc.db")).unwrap(), "tw-svn");
        assert!(!dst.join("assets/legacy/old.png").exists());
        assert!(!dst.join("assets/legacy").exists());

        // 3. Re-running preview immediately sees zero remaining changes
        let after = preview_client_sync(
            &src.to_string_lossy(),
            &dst.to_string_lossy(),
            &rules,
            true,
        )
        .unwrap();
        assert_eq!((after.counts.added, after.counts.modified, after.counts.deleted), (0, 0, 0));
    }

    #[test]
    fn nested_or_identical_client_roots_are_refused() {
        let temp = TempDir::create("release-client-nested");
        let outer = temp.path().join("client");
        let inner = outer.join("sub");
        fs::create_dir_all(&inner).unwrap();
        assert!(validate_client_roots(&outer.to_string_lossy(), &outer.to_string_lossy()).is_err());
        assert!(validate_client_roots(&outer.to_string_lossy(), &inner.to_string_lossy()).is_err());
    }

    #[test]
    fn plan_update_sql_supports_single_and_composite_keys_and_rejects_bad_flags() {
        let hero_sql = format_plan_update_sql(
            "heroprop",
            &["ID".into()],
            "OpenFlag",
            1,
            &[vec![1061], vec![6505]],
        )
        .unwrap();
        assert_eq!(
            hero_sql,
            "UPDATE `heroprop` SET `OpenFlag` = 1 WHERE `ID` IN (1061, 6505);"
        );

        let feat_sql = format_plan_update_sql(
            "buildopenplatprop",
            &["BuildID".into(), "Idx".into()],
            "IsOpen",
            0,
            &[vec![81, 100], vec![134, 100]],
        )
        .unwrap();
        assert_eq!(
            feat_sql,
            "UPDATE `buildopenplatprop` SET `IsOpen` = 0 WHERE (`BuildID`, `Idx`) IN ((81, 100), (134, 100));"
        );

        assert!(format_plan_update_sql("heroprop", &["ID".into()], "OpenFlag", 2, &[vec![1061]]).is_err());
    }
}
