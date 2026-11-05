use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};
use super::assisted_rules::digest;

const MAX_BYTES: u64 = 1_000_000;

fn permitted(path: &Path) -> bool {
    let forbidden = [".git", ".svn", "node_modules", "target", "dist", "build", "library", "temp", ".ssh"];
    if path.components().any(|part| {
        let name = part.as_os_str().to_string_lossy().to_lowercase();
        name.starts_with('.') || forbidden.contains(&name.as_str())
    }) { return false; }
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
    if ["config.ts", "config.js", "agent-auth.json", "package-lock.json"].contains(&name.as_str())
        || ["secret", "credential", "password", "private-key", "token"].iter().any(|word| name.contains(word)) { return false; }
    matches!(path.extension().and_then(|value| value.to_str()), Some("ts" | "js" | "mjs" | "json" | "md" | "txt" | "lua" | "cs"))
}

pub fn permitted_relative(relative: &str) -> bool {
    let normalized = relative.replace('\\', "/");
    let path = Path::new(&normalized);
    !path.is_absolute() && !normalized.contains(':') && path.components().all(|part| matches!(part,Component::Normal(_))) && permitted(path)
}

pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = relative.replace('\\', "/");
    let path = Path::new(&normalized);
    if !permitted_relative(relative) {
        return Err("只允许读取绑定项目内的普通代码/文档；敏感文件和越界路径不可读取".into());
    }
    let root = root.canonicalize().map_err(|_| "绑定项目不可用")?;
    let real = root.join(path).canonicalize().map_err(|_| "文件不存在")?;
    if !real.starts_with(&root) || !permitted(real.strip_prefix(&root).map_err(|_| "路径越界")?) || !real.is_file() { return Err("文件不在授权范围内".into()); }
    Ok(real)
}

fn read(root: &Path, relative: &str) -> Result<String, String> {
    let path = resolve(root, relative)?;
    if fs::metadata(&path).map_err(|error| error.to_string())?.len() > MAX_BYTES { return Err("文件超过 1MB 上限，未读取".into()); }
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|error| error.to_string())?.take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES || bytes.contains(&0) { return Err("文件过大或不是文本".into()); }
    String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 文本".into())
}

fn redact(line: &str) -> String {
    let lower = line.to_lowercase();
    if ["password", "passwd", "secret", "api_key", "apikey", "token", "authorization", "private key", "mysql://"].iter().any(|word| lower.contains(word)) {
        "[敏感内容已隐藏]".into()
    } else { line.chars().take(1000).collect() }
}

pub fn redact_text(text: &str) -> String {
    text.lines().take(200).map(redact).collect::<Vec<_>>().join("\n")
}

pub fn read_lines(root: &Path, relative: &str, start: usize, limit: usize) -> Result<Value, String> {
    if start == 0 || limit == 0 || limit > 200 { return Err("startLine 从 1 开始，limit 为 1-200".into()); }
    let text = read(root, relative)?;
    let lines: Vec<_> = text.lines().collect();
    let result = lines.iter().enumerate().skip(start - 1).take(limit).map(|(index, line)| json!({"line":index+1,"text":redact(line),"truncated":line.chars().count()>1000})).collect::<Vec<_>>();
    Ok(json!({"path":relative,"fileHash":digest(text.as_bytes()),"lines":result,"totalLines":lines.len(),"nextLine":start-1+result.len()+1,"hasMore":start-1+result.len()<lines.len()}))
}

fn files(root: &Path) -> Result<(Vec<String>, bool), String> {
    let root = root.canonicalize().map_err(|_| "绑定目录不存在")?;
    let mut pending = vec![root.clone()];
    let mut result = Vec::new();
    let mut visited = 0;
    while let Some(directory) = pending.pop() {
        let mut entries = fs::read_dir(directory).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            visited += 1;
            if visited > 30_000 || result.len() >= 10_000 { result.sort(); return Ok((result, true)); }
            let path = entry.path();
            let relative = path.strip_prefix(&root).map_err(|_| "路径越界")?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_symlink() { continue; }
            if kind.is_dir() {
                if permitted(&relative.join("probe.ts")) { pending.push(path); }
            } else if kind.is_file() && permitted(relative) { result.push(relative.to_string_lossy().replace('\\', "/")); }
        }
    }
    result.sort();
    Ok((result, false))
}

pub fn search(root: &Path, keyword: &str, cursor: Option<&Value>) -> Result<Value, String> {
    if keyword.trim().is_empty() || keyword.len() > 200 { return Err("关键字必须为 1-200 字节".into()); }
    let (files, truncated) = files(root)?;
    let manifest_entries = files.iter().map(|file| {
        let metadata = fs::metadata(root.join(file)).map_err(|error| error.to_string())?;
        let modified = metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_nanos());
        Ok(json!([file, metadata.len(), modified.map(|time| time.to_string())]))
    }).collect::<Result<Vec<_>, String>>()?;
    let manifest = super::assisted_rules::value_signature(manifest_entries)?;
    let query = keyword.to_lowercase();
    let query_signature = super::assisted_rules::value_signature((root.canonicalize().map_err(|error| error.to_string())?, &query))?;
    let cursor = cursor.map(|cursor| serde_json::from_value::<SearchCursor>(cursor.clone()).map_err(|_| "搜索游标无效，请从头搜索".to_string())).transpose()?;
    if cursor.as_ref().is_some_and(|cursor| cursor.manifest != manifest || cursor.query != query_signature) {
        return Err("搜索条件、绑定目录或项目文件已变化，请从头搜索".into());
    }
    let first = cursor.as_ref().map(|cursor| cursor.file).unwrap_or(0);
    let start_line = cursor.as_ref().map(|cursor| cursor.line).unwrap_or(0);
    if first > files.len() || (first == files.len() && start_line != 0) { return Err("搜索游标超出范围".into()); }
    let mut matches = Vec::new();
    let mut errors = Vec::new();
    let end = (first + 100).min(files.len());
    for (index, file) in files.iter().enumerate().take(end).skip(first) {
        match read(root, file) {
            Ok(text) => {
                let hash = digest(text.as_bytes());
                if index == first && start_line > 0 && (cursor.as_ref().and_then(|cursor| cursor.file_hash.as_ref()) != Some(&hash) || start_line > text.lines().count()) {
                    return Err("当前文件已变化或行游标无效，请从头搜索".into());
                }
                for (line, content) in text.lines().enumerate().skip(if index == first { start_line } else { 0 }) {
                    if content.to_lowercase().contains(&query) {
                        matches.push(json!({"path":file,"line":line+1,"text":redact(content),"fileHash":hash,"truncated":content.chars().count()>1000}));
                        if matches.len() == 100 { return Ok(json!({"matches":matches,"errors":errors,"hasMore":true,"nextCursor":{"manifest":manifest,"query":query_signature,"file":index,"line":line+1,"fileHash":hash},"manifestTruncated":truncated})); }
                    }
                }
            }
            Err(error) => errors.push(json!({"path":file,"error":error})),
        }
    }
    Ok(json!({"matches":matches,"errors":errors,"hasMore":end<files.len(),"nextCursor":{"manifest":manifest,"query":query_signature,"file":end,"line":0},"manifestTruncated":truncated,"filesConsidered":end.saturating_sub(first)}))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchCursor {
    manifest: String,
    query: String,
    file: usize,
    line: usize,
    file_hash: Option<String>,
}

pub fn fingerprints(root: &Path, paths: &[String]) -> Result<BTreeMap<String, String>, String> {
    paths.iter().map(|path| read(root, path).map(|text| (path.clone(), digest(text.as_bytes())))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sensitive_and_escape_paths_are_not_readable() {
        for path in ["../keys.ts", "/tmp/file.ts", "C:\\secret.ts", ".env", "assets/Config.ts", "assets/secret.json", "node_modules/code.ts"] {
            assert!(resolve(Path::new("."), path).is_err(), "{path}");
        }
        assert!(permitted(Path::new("assets/src/Reward.ts")));
        assert_eq!(redact("const password = 'value'"), "[敏感内容已隐藏]");
    }

    #[test]
    fn search_pages_bind_query_and_file_version_and_redact_secrets() {
        let root = std::env::temp_dir().join(format!("blackcat-code-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Reward.ts"), format!("{}\nconst token = 'reward-secret';", "reward\n".repeat(205))).unwrap();
        let first = search(&root,"reward",None).unwrap();
        assert_eq!(first["matches"].as_array().unwrap().len(),100);
        let second = search(&root,"reward",Some(&first["nextCursor"])).unwrap();
        assert_eq!(second["matches"][0]["line"],101);
        let last = search(&root,"reward",Some(&second["nextCursor"])).unwrap();
        assert_eq!(last["hasMore"],false);
        assert_eq!(last["matches"].as_array().unwrap().last().unwrap()["text"],"[敏感内容已隐藏]");
        assert!(search(&root,"other",Some(&first["nextCursor"])).is_err());
        let lines = read_lines(&root,"Reward.ts",101,2).unwrap();
        assert_eq!(lines["lines"][0]["line"],101);
        let before = fingerprints(&root,&["Reward.ts".into()]).unwrap();
        fs::write(root.join("Reward.ts"), "changed").unwrap();
        assert!(search(&root,"reward",Some(&first["nextCursor"])).is_err());
        assert_ne!(before,fingerprints(&root,&["Reward.ts".into()]).unwrap());
        fs::remove_file(root.join("Reward.ts")).unwrap();
        assert!(fingerprints(&root,&["Reward.ts".into()]).is_err());
        fs::write(root.join("Large.ts"), vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
        assert!(read_lines(&root,"Large.ts",1,1).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_the_bound_project() {
        let root = std::env::temp_dir().join(format!("blackcat-link-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("bound")).unwrap();
        fs::write(root.join("Outside.ts"), "reward").unwrap();
        std::os::unix::fs::symlink(root.join("Outside.ts"),root.join("bound/Link.ts")).unwrap();
        assert!(read_lines(&root.join("bound"),"Link.ts",1,1).is_err());
        assert!(search(&root.join("bound"),"reward",None).unwrap()["matches"].as_array().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
