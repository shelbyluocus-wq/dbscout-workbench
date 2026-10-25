//! SVN working-copy operations for the release workspace's SVN tool, after
//! Cairn's change list: status, one file's diff, commit (unversioned choices
//! are added and missing ones deleted first, as a commit dialog does),
//! revert, resolve and the log. Every command runs non-interactively through
//! the shared client (svn_client.rs). File arguments are relative to the
//! working copy and never leave it. Errors read "code: detail" so the page
//! can explain the common ones.

use std::path::{Component, Path, PathBuf};
use std::process::Output;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::svn_client::SvnClient;

const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_LOG_LIMIT: u32 = 30;
const MAX_LOG_LIMIT: u32 = 200;
pub const RESOLVE_CHOICES: [&str; 4] = ["working", "theirs-full", "mine-full", "base"];

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SvnWcInfo {
    pub root: String,
    pub url: String,
    pub relative_url: String,
    pub repository_root: String,
    pub revision: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SvnWcEntry {
    /// Relative to the working copy with "/" separators; "." is the root.
    pub path: String,
    /// svn's item status: modified, added, deleted, replaced, unversioned,
    /// missing, conflicted, obstructed, incomplete.
    pub item: String,
    pub props: String,
    pub kind: String,
    pub tree_conflict: bool,
    pub locked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnFileDiff {
    pub path: String,
    /// `svn diff` output for a versioned file.
    pub diff: String,
    /// The text of an unversioned file, which svn has nothing to compare with.
    pub content: Option<String>,
    pub binary: bool,
    pub too_large: bool,
    pub encoding: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnCommitResult {
    pub revision: Option<u64>,
    pub added: Vec<String>,
    pub deleted: Vec<String>,
    pub output: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnChangeResult {
    pub paths: Vec<String>,
    pub output: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SvnLogPath {
    pub action: String,
    pub kind: String,
    pub path: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SvnLogEntry {
    pub revision: u64,
    pub author: String,
    pub date: String,
    pub message: String,
    pub paths: Vec<SvnLogPath>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnPathsRequest {
    pub root: String,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub accept: String,
    #[serde(default)]
    pub unversioned: bool,
    #[serde(default)]
    pub limit: u32,
}

/* ── Output ─────────────────────────────────────────────────────────────── */

/// UTF-8, or GB 18030 for older Chinese files and consoles.
fn decode_text(bytes: &[u8]) -> (String, &'static str) {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), "utf-8"),
        Err(_) => (encoding_rs::GB18030.decode(bytes).0.into_owned(), "gb18030"),
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|byte| *byte == 0)
}

/// The kind of failure svn reports, from its error codes.
pub fn classify_error(stderr: &str) -> &'static str {
    let upper = stderr.to_ascii_uppercase();
    let has = |codes: &[&str]| codes.iter().any(|code| upper.contains(code));
    if has(&["E155007", "E155036"]) {
        "notWorkingCopy"
    } else if has(&["E155011", "E160028", "E160024", "E170004", "E155035"]) {
        "outOfDate"
    } else if has(&["E155004", "E155037", "E200033"]) {
        "locked"
    } else if has(&["E215004", "E170001", "E230001", "E170013"]) {
        "auth"
    } else if has(&["E175012", "E731001", "E120171", "E120108", "E175002", "E670002"]) {
        "network"
    } else if has(&["E155015", "E200009"]) {
        "conflict"
    } else {
        "failed"
    }
}

fn svn_error(output: &Output) -> String {
    let (stderr, _) = decode_text(&output.stderr);
    let detail = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join("\n");
    format!("{}: {detail}", classify_error(&stderr))
}

fn checked(output: Output) -> Result<String, String> {
    if output.status.success() {
        Ok(decode_text(&output.stdout).0)
    } else {
        Err(svn_error(&output))
    }
}

/* ── Paths ──────────────────────────────────────────────────────────────── */

fn working_copy(root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root.trim().trim_end_matches(['/', '\\']));
    if root.as_os_str().is_empty() || !root.is_dir() {
        return Err("notWorkingCopy: 找不到工作副本文件夹".into());
    }
    Ok(root)
}

/// A path of the working copy, refusing absolute paths and `..`.
pub fn member(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative == "." {
        return Ok(root.to_path_buf());
    }
    let candidate = Path::new(relative);
    if relative.is_empty() || candidate.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err(format!("failed: 路径必须位于工作副本内：{relative}"));
    }
    Ok(root.join(candidate))
}

fn members(root: &Path, paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Err("failed: 没有选择文件".into());
    }
    paths.iter().map(|path| member(root, path)).collect()
}

fn relative_path(target: &str, path: &str) -> String {
    let normalize = |value: &str| value.replace('\\', "/").trim_end_matches('/').to_string();
    let base = normalize(target);
    let full = normalize(path);
    if full == base {
        return ".".into();
    }
    full.strip_prefix(&format!("{base}/")).map(str::to_string).unwrap_or(full)
}

/* ── Parsing ────────────────────────────────────────────────────────────── */

fn parse_document(xml: &str) -> Result<roxmltree::Document<'_>, String> {
    roxmltree::Document::parse(xml).map_err(|error| format!("failed: 无法读取 SVN 输出：{error}"))
}

fn child_text(node: roxmltree::Node<'_, '_>, name: &str) -> String {
    node.descendants()
        .find(|child| child.has_tag_name(name))
        .and_then(|child| child.text())
        .unwrap_or("")
        .trim()
        .to_string()
}

pub fn parse_info(xml: &str) -> Result<SvnWcInfo, String> {
    let document = parse_document(xml)?;
    let entry = document
        .descendants()
        .find(|node| node.has_tag_name("entry"))
        .ok_or_else(|| "notWorkingCopy: 这个文件夹不是 SVN 工作副本".to_string())?;
    Ok(SvnWcInfo {
        root: child_text(entry, "wcroot-abspath"),
        url: child_text(entry, "url"),
        relative_url: child_text(entry, "relative-url"),
        repository_root: child_text(entry, "root"),
        revision: entry.attribute("revision").and_then(|value| value.parse().ok()).unwrap_or(0),
    })
}

/// Changed entries of `svn status --xml <target>`; externals and unchanged
/// entries are left out.
pub fn parse_status(xml: &str, target: &str) -> Result<Vec<SvnWcEntry>, String> {
    let document = parse_document(xml)?;
    let mut entries = Vec::new();
    for entry in document.descendants().filter(|node| node.has_tag_name("entry")) {
        let Some(path) = entry.attribute("path") else { continue };
        let Some(status) = entry.children().find(|node| node.has_tag_name("wc-status")) else { continue };
        let item = status.attribute("item").unwrap_or("normal");
        let props = status.attribute("props").unwrap_or("none");
        let tree_conflict = status.attribute("tree-conflicted") == Some("true");
        let locked = status.attribute("wc-locked") == Some("true");
        if matches!(item, "external" | "ignored") {
            continue;
        }
        if item == "normal" && matches!(props, "none" | "normal") && !tree_conflict && !locked {
            continue;
        }
        entries.push(SvnWcEntry {
            path: relative_path(target, path),
            item: item.to_string(),
            props: props.to_string(),
            kind: String::new(),
            tree_conflict,
            locked,
        });
    }
    Ok(entries)
}

pub fn parse_log(xml: &str) -> Result<Vec<SvnLogEntry>, String> {
    let document = parse_document(xml)?;
    Ok(document
        .descendants()
        .filter(|node| node.has_tag_name("logentry"))
        .map(|entry| SvnLogEntry {
            revision: entry.attribute("revision").and_then(|value| value.parse().ok()).unwrap_or(0),
            author: child_text(entry, "author"),
            date: child_text(entry, "date"),
            message: entry
                .children()
                .find(|node| node.has_tag_name("msg"))
                .and_then(|node| node.text())
                .unwrap_or("")
                .trim_end()
                .to_string(),
            paths: entry
                .descendants()
                .filter(|node| node.has_tag_name("path"))
                .map(|node| SvnLogPath {
                    action: node.attribute("action").unwrap_or("").to_string(),
                    kind: node.attribute("kind").unwrap_or("").to_string(),
                    path: node.text().unwrap_or("").to_string(),
                })
                .collect(),
        })
        .collect())
}

/// The new revision from a commit's output ("Committed revision 52818." or
/// its translations): the last number on the last line that has one.
pub fn committed_revision(output: &str) -> Option<u64> {
    output.lines().rev().find_map(|line| {
        let digits: Vec<&str> = line.split(|character: char| !character.is_ascii_digit()).filter(|part| !part.is_empty()).collect();
        digits.last().and_then(|value| value.parse().ok())
    })
}

/* ── Operations ─────────────────────────────────────────────────────────── */

pub async fn info(client: &SvnClient, root: &Path) -> Result<SvnWcInfo, String> {
    let output = client.run_targets(&["info", "--xml", "--non-interactive"], &[root.to_path_buf()]).await?;
    parse_info(&checked(output)?)
}

pub async fn status(client: &SvnClient, root: &Path) -> Result<Vec<SvnWcEntry>, String> {
    let output = client.run_targets(&["status", "--xml", "--non-interactive"], &[root.to_path_buf()]).await?;
    let mut entries = parse_status(&checked(output)?, &root.to_string_lossy())?;
    for entry in &mut entries {
        let is_dir = member(root, &entry.path).map(|path| path.is_dir()).unwrap_or(false);
        entry.kind = if is_dir { "dir" } else { "file" }.into();
    }
    entries.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(entries)
}

pub async fn file_diff(client: &SvnClient, root: &Path, relative: &str, unversioned: bool) -> Result<SvnFileDiff, String> {
    let file = member(root, relative)?;
    let mut diff = SvnFileDiff {
        path: relative.to_string(),
        diff: String::new(),
        content: None,
        binary: false,
        too_large: false,
        encoding: "utf-8".into(),
    };
    if unversioned {
        if !file.is_file() {
            return Ok(diff);
        }
        let bytes = tokio::fs::read(&file).await.map_err(|error| format!("failed: 读取文件失败：{error}"))?;
        if bytes.len() > MAX_TEXT_BYTES {
            diff.too_large = true;
        } else if looks_binary(&bytes) {
            diff.binary = true;
        } else {
            let (text, encoding) = decode_text(&bytes);
            diff.content = Some(text);
            diff.encoding = encoding.into();
        }
        return Ok(diff);
    }
    // The built-in diff, so an external diff tool in the person's SVN settings is never started.
    let output = client.run_targets(&["diff", "--internal-diff", "--non-interactive"], &[file]).await?;
    if !output.status.success() {
        return Err(svn_error(&output));
    }
    if output.stdout.len() > MAX_TEXT_BYTES {
        diff.too_large = true;
        return Ok(diff);
    }
    let (text, encoding) = decode_text(&output.stdout);
    diff.binary = text.contains("Cannot display: file marked as a binary type");
    diff.diff = text;
    diff.encoding = encoding.into();
    Ok(diff)
}

struct MessageFile(PathBuf);

impl MessageFile {
    fn write(message: &str) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!(
            "blackcat-svn-message-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&path, message.as_bytes()).map_err(|error| format!("failed: 无法写入提交说明：{error}"))?;
        Ok(Self(path))
    }
}

impl Drop for MessageFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub async fn commit(client: &SvnClient, root: &Path, paths: &[String], message: &str) -> Result<SvnCommitResult, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("failed: 请填写提交说明".into());
    }
    members(root, paths)?;
    let entries = status(client, root).await?;
    let item_of = |path: &String| entries.iter().find(|entry| &entry.path == path).map(|entry| entry.item.as_str());
    let added: Vec<String> = paths.iter().filter(|path| item_of(path) == Some("unversioned")).cloned().collect();
    let deleted: Vec<String> = paths.iter().filter(|path| item_of(path) == Some("missing")).cloned().collect();
    if !added.is_empty() {
        checked(client.run_targets(&["add", "--parents", "--non-interactive"], &members(root, &added)?).await?)?;
    }
    if !deleted.is_empty() {
        checked(client.run_targets(&["delete", "--non-interactive"], &members(root, &deleted)?).await?)?;
    }
    let message_file = MessageFile::write(message)?;
    let message_path = message_file.0.to_string_lossy().into_owned();
    let output = client
        .run_targets(&["commit", "--non-interactive", "--encoding", "utf-8", "-F", &message_path], &members(root, paths)?)
        .await?;
    let output = checked(output)?;
    Ok(SvnCommitResult { revision: committed_revision(&output), added, deleted, output })
}

pub async fn revert(client: &SvnClient, root: &Path, paths: &[String]) -> Result<SvnChangeResult, String> {
    let output = client.run_targets(&["revert", "--depth", "infinity", "--non-interactive"], &members(root, paths)?).await?;
    Ok(SvnChangeResult { paths: paths.to_vec(), output: checked(output)? })
}

pub async fn resolve(client: &SvnClient, root: &Path, paths: &[String], accept: &str) -> Result<SvnChangeResult, String> {
    if !RESOLVE_CHOICES.contains(&accept) {
        return Err(format!("failed: 不支持的解决方式：{accept}"));
    }
    let output = client.run_targets(&["resolve", "--accept", accept, "--non-interactive"], &members(root, paths)?).await?;
    Ok(SvnChangeResult { paths: paths.to_vec(), output: checked(output)? })
}

pub async fn log(client: &SvnClient, root: &Path, limit: u32) -> Result<Vec<SvnLogEntry>, String> {
    let limit = if limit == 0 { DEFAULT_LOG_LIMIT } else { limit.min(MAX_LOG_LIMIT) }.to_string();
    // From HEAD, so commits not yet updated into the working copy show too.
    let output = client
        .run_targets(&["log", "--xml", "-v", "--non-interactive", "-r", "HEAD:1", "-l", &limit], &[root.to_path_buf()])
        .await?;
    parse_log(&checked(output)?)
}

/* ── Commands ───────────────────────────────────────────────────────────── */

async fn client_for(app: &AppHandle, root: &Path) -> Result<SvnClient, String> {
    SvnClient::for_working_copy(app, root).await.map_err(|error| format!("svnMissing: {error}"))
}

#[tauri::command]
pub async fn svn_wc_info(app: AppHandle, request: SvnPathsRequest) -> Result<SvnWcInfo, String> {
    let root = working_copy(&request.root)?;
    info(&client_for(&app, &root).await?, &root).await
}

#[tauri::command]
pub async fn svn_wc_status(app: AppHandle, request: SvnPathsRequest) -> Result<Vec<SvnWcEntry>, String> {
    let root = working_copy(&request.root)?;
    status(&client_for(&app, &root).await?, &root).await
}

#[tauri::command]
pub async fn svn_wc_file_diff(app: AppHandle, request: SvnPathsRequest) -> Result<SvnFileDiff, String> {
    let root = working_copy(&request.root)?;
    let path = request.paths.first().cloned().unwrap_or_default();
    file_diff(&client_for(&app, &root).await?, &root, &path, request.unversioned).await
}

#[tauri::command]
pub async fn svn_wc_commit(app: AppHandle, request: SvnPathsRequest) -> Result<SvnCommitResult, String> {
    let root = working_copy(&request.root)?;
    commit(&client_for(&app, &root).await?, &root, &request.paths, &request.message).await
}

#[tauri::command]
pub async fn svn_wc_revert(app: AppHandle, request: SvnPathsRequest) -> Result<SvnChangeResult, String> {
    let root = working_copy(&request.root)?;
    revert(&client_for(&app, &root).await?, &root, &request.paths).await
}

#[tauri::command]
pub async fn svn_wc_resolve(app: AppHandle, request: SvnPathsRequest) -> Result<SvnChangeResult, String> {
    let root = working_copy(&request.root)?;
    resolve(&client_for(&app, &root).await?, &root, &request.paths, &request.accept).await
}

#[tauri::command]
pub async fn svn_wc_log(app: AppHandle, request: SvnPathsRequest) -> Result<Vec<SvnLogEntry>, String> {
    let root = working_copy(&request.root)?;
    log(&client_for(&app, &root).await?, &root, request.limit).await
}

#[tauri::command]
pub async fn svn_wc_pick_folder(start: String) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    let start = PathBuf::from(start.trim());
    if start.is_dir() {
        dialog = dialog.set_directory(&start);
    }
    Ok(dialog.pick_folder().await.map(|folder| folder.path().to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_temp_dir::TempDir;

    const STATUS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<status><target path="D:\jswz\tw">
<entry path="D:\jswz\tw\assets\config\Config.ts"><wc-status item="modified" props="none" revision="52817"><commit revision="52800"><author>a</author></commit></wc-status></entry>
<entry path="D:\jswz\tw\assets\new.png"><wc-status item="unversioned" props="none"></wc-status></entry>
<entry path="D:\jswz\tw\assets\gone.ts"><wc-status item="missing" props="none" revision="52817"></wc-status></entry>
<entry path="D:\jswz\tw\assets\props"><wc-status item="normal" props="none" tree-conflicted="true" revision="52817"></wc-status></entry>
<entry path="D:\jswz\tw\libs"><wc-status item="external" props="none"></wc-status></entry>
<entry path="D:\jswz\tw"><wc-status item="normal" props="modified" revision="52817"></wc-status></entry>
<entry path="D:\jswz\tw\ok.ts"><wc-status item="normal" props="none" revision="52817"></wc-status></entry>
</target></status>"#;

    #[test]
    fn status_lists_changes_relative_to_the_working_copy() {
        let entries = parse_status(STATUS_XML, r"D:\jswz\tw").unwrap();
        let summary: Vec<(&str, &str, bool)> = entries.iter().map(|entry| (entry.path.as_str(), entry.item.as_str(), entry.tree_conflict)).collect();
        assert_eq!(summary, vec![
            ("assets/config/Config.ts", "modified", false),
            ("assets/new.png", "unversioned", false),
            ("assets/gone.ts", "missing", false),
            ("assets/props", "normal", true),
            (".", "normal", false),
        ]);
        assert_eq!(entries[4].props, "modified");
    }

    #[test]
    fn info_and_log_read_their_xml() {
        let info = parse_info(r#"<info><entry kind="dir" path="D:\jswz\tw" revision="52817"><url>https://svn.example/jswz/trunk</url><relative-url>^/jswz/trunk</relative-url><repository><root>https://svn.example</root><uuid>x</uuid></repository><wc-info><wcroot-abspath>D:/jswz/tw</wcroot-abspath></wc-info></entry></info>"#).unwrap();
        assert_eq!(info, SvnWcInfo {
            root: "D:/jswz/tw".into(),
            url: "https://svn.example/jswz/trunk".into(),
            relative_url: "^/jswz/trunk".into(),
            repository_root: "https://svn.example".into(),
            revision: 52817,
        });
        let log = parse_log(r#"<log><logentry revision="52818"><author>qa</author><date>2026-10-25T02:00:00.000000Z</date><paths><path action="M" kind="file" text-mods="true">/jswz/trunk/assets/a.ts</path><path action="A" kind="dir">/jswz/trunk/assets/new</path></paths><msg>更新开放规划
第二行</msg></logentry></log>"#).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!((log[0].revision, log[0].author.as_str(), log[0].message.as_str()), (52818, "qa", "更新开放规划\n第二行"));
        assert_eq!(log[0].paths[1], SvnLogPath { action: "A".into(), kind: "dir".into(), path: "/jswz/trunk/assets/new".into() });
        assert!(parse_info("<info/>").unwrap_err().starts_with("notWorkingCopy:"));
    }

    #[test]
    fn errors_and_revisions_are_read_from_svn_output() {
        assert_eq!(classify_error("svn: E155011: File 'x' is out of date"), "outOfDate");
        assert_eq!(classify_error("svn: E155004: Run 'svn cleanup' to remove locks"), "locked");
        assert_eq!(classify_error("svn: E215004: No more credentials"), "auth");
        assert_eq!(classify_error("svn: E155007: 'D:\\x' is not a working copy"), "notWorkingCopy");
        assert_eq!(classify_error("svn: E731001: No such host is known."), "network");
        assert_eq!(classify_error("something else"), "failed");
        assert_eq!(committed_revision("Sending        a.ts\nTransmitting file data .done\nCommitting transaction...\nCommitted revision 52818.\n"), Some(52818));
        assert_eq!(committed_revision("正在发送       a.ts\n提交后的版本为 52819。\n"), Some(52819));
        assert_eq!(committed_revision(""), None);
    }

    #[test]
    fn file_arguments_stay_inside_the_working_copy() {
        let root = Path::new("/wc");
        assert_eq!(member(root, "assets/a.ts").unwrap(), PathBuf::from("/wc/assets/a.ts"));
        assert_eq!(member(root, ".").unwrap(), PathBuf::from("/wc"));
        for bad in ["../x", "assets/../../x", "/etc/passwd", ""] {
            assert!(member(root, bad).is_err(), "{bad}");
        }
        assert_eq!(decode_text("\u{feff}abc".as_bytes()).0, "abc");
        let (text, encoding) = decode_text(&encoding_rs::GB18030.encode("中文").0);
        assert_eq!((text.as_str(), encoding), ("中文", "gb18030"));
    }

    fn svn_available() -> Option<(PathBuf, PathBuf)> {
        let svn = which("svn")?;
        let svnadmin = which("svnadmin")?;
        Some((svn, svnadmin))
    }

    fn which(program: &str) -> Option<PathBuf> {
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths).map(|dir| dir.join(program)).find(|path| path.is_file())
        })
    }

    /// The whole round trip against a real repository when svn is installed.
    #[tokio::test]
    async fn status_diff_commit_revert_and_log_on_a_real_working_copy() {
        let Some((svn, svnadmin)) = svn_available() else {
            eprintln!("svn not installed; skipped");
            return;
        };
        let temp = TempDir::create("svn-wc");
        let repo = temp.path().join("repo");
        let wc = temp.path().join("wc");
        assert!(std::process::Command::new(&svnadmin).arg("create").arg(&repo).status().unwrap().success());
        let url = format!("file://{}", repo.to_string_lossy());
        assert!(std::process::Command::new(&svn).args(["checkout", "-q", &url]).arg(&wc).status().unwrap().success());
        std::fs::create_dir_all(wc.join("assets")).unwrap();
        std::fs::write(wc.join("assets/a.ts"), "let a = 1;\nlet b = 2;\n").unwrap();
        let client = SvnClient::for_tests(svn);

        let entries = status(&client, &wc).await.unwrap();
        assert_eq!(entries.iter().map(|entry| (entry.path.as_str(), entry.item.as_str())).collect::<Vec<_>>(), vec![("assets", "unversioned")]);
        let added = commit(&client, &wc, &["assets".into()], "首次提交").await.unwrap();
        assert_eq!((added.revision, added.added.clone()), (Some(1), vec!["assets".to_string()]));

        std::fs::write(wc.join("assets/a.ts"), "let a = 1;\nlet b = 3;\n").unwrap();
        let diff = file_diff(&client, &wc, "assets/a.ts", false).await.unwrap();
        assert!(diff.diff.contains("-let b = 2;") && diff.diff.contains("+let b = 3;"), "{}", diff.diff);
        assert_eq!(status(&client, &wc).await.unwrap()[0].item, "modified");

        revert(&client, &wc, &["assets/a.ts".into()]).await.unwrap();
        assert!(status(&client, &wc).await.unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(wc.join("assets/a.ts")).unwrap(), "let a = 1;\nlet b = 2;\n");

        std::fs::remove_file(wc.join("assets/a.ts")).unwrap();
        let removed = commit(&client, &wc, &["assets/a.ts".into()], "remove").await.unwrap();
        assert_eq!((removed.revision, removed.deleted.len()), (Some(2), 1));
        let history = log(&client, &wc, 10).await.unwrap();
        assert_eq!(history.iter().map(|entry| entry.revision).collect::<Vec<_>>(), vec![2, 1]);
        assert_eq!(history[1].message, "首次提交");
        assert_eq!(info(&client, &wc).await.unwrap().url, url);
        assert!(commit(&client, &wc, &["../x".into()], "x").await.is_err());
    }
}
