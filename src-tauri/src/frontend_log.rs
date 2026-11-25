use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::Manager;

const LOG_DIR_NAME: &str = "logs";
const LOG_FILE_NAME: &str = "frontend-errors.log";
const LOG_BACKUP_NAME: &str = "frontend-errors.log.1";
const MAX_LOG_FILE_BYTES: u64 = 512 * 1024;
const MAX_MESSAGE_BYTES: usize = 2 * 1024;
const MAX_STACK_BYTES: usize = 12 * 1024;
const MAX_META_BYTES: usize = 256;

static LOG_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendErrorEntry {
    pub kind: String,
    pub message: String,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub component: Option<String>,
    #[serde(default)]
    pub info: Option<String>,
    #[serde(default)]
    pub area: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedFrontendError {
    ts: String,
    kind: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    stack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    component: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    info: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    area: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_version: Option<String>,
}

fn truncate_utf8(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = input[..end].to_string();
    out.push_str("...[truncated]");
    out
}

/// Strip credentials from database URLs (`scheme://user:pass@host`) and
/// `Bearer <token>` strings before anything is written to disk.
pub(crate) fn redact_sensitive(input: &str) -> String {
    let mut text = input.to_string();
    for scheme in [
        "mysql://",
        "mariadb://",
        "postgres://",
        "postgresql://",
        "mongodb://",
        "mongodb+srv://",
        "clickhouse://",
        "http://",
        "https://",
    ] {
        text = redact_url_credentials(&text, scheme);
    }
    redact_bearer_tokens(&text)
}

fn redact_url_credentials(input: &str, scheme: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(rel) = lower[cursor..].find(scheme) {
        let scheme_start = cursor + rel;
        let authority_start = scheme_start + scheme.len();
        out.push_str(&input[cursor..authority_start]);
        let rest = &input[authority_start..];
        let boundary = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '?' | '#' | '"' | '\'' | ')' | ']'))
            .unwrap_or(rest.len());
        let authority = &rest[..boundary];
        if let Some(at_pos) = authority.rfind('@') {
            out.push_str("***@");
            out.push_str(&authority[at_pos + 1..]);
        } else {
            out.push_str(authority);
        }
        cursor = authority_start + boundary;
    }
    out.push_str(&input[cursor..]);
    out
}

fn redact_bearer_tokens(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let needle = "bearer ";
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(rel) = lower[cursor..].find(needle) {
        let start = cursor + rel;
        let token_start = start + needle.len();
        out.push_str(&input[cursor..token_start]);
        let rest = &input[token_start..];
        let token_len = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ';' | ')' | ']'))
            .unwrap_or(rest.len());
        if token_len > 0 {
            out.push_str("***");
        }
        cursor = token_start + token_len;
    }
    out.push_str(&input[cursor..]);
    out
}

fn clean_optional(value: Option<String>, max_bytes: usize) -> Option<String> {
    let raw = value?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate_utf8(&redact_sensitive(trimmed), max_bytes))
}

fn format_log_line(entry: FrontendErrorEntry) -> Result<String, String> {
    let kind = clean_optional(Some(entry.kind), MAX_META_BYTES)
        .unwrap_or_else(|| "unknown".to_string());
    let message = clean_optional(Some(entry.message), MAX_MESSAGE_BYTES)
        .unwrap_or_else(|| "(empty error message)".to_string());
    let persisted = PersistedFrontendError {
        ts: Utc::now().to_rfc3339(),
        kind,
        message,
        stack: clean_optional(entry.stack, MAX_STACK_BYTES),
        component: clean_optional(entry.component, MAX_META_BYTES),
        info: clean_optional(entry.info, MAX_META_BYTES),
        area: clean_optional(entry.area, MAX_META_BYTES),
        app_version: clean_optional(entry.app_version, MAX_META_BYTES),
    };
    let mut line = serde_json::to_string(&persisted)
        .map_err(|err| format!("serialize frontend error failed: {err}"))?;
    line.push('\n');
    Ok(line)
}

pub(crate) fn append_log_to_dir(
    log_dir: &Path,
    entry: FrontendErrorEntry,
    max_file_bytes: u64,
) -> Result<PathBuf, String> {
    let line = format_log_line(entry)?;
    let _guard = LOG_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "frontend log lock poisoned".to_string())?;

    fs::create_dir_all(log_dir)
        .map_err(|err| format!("create frontend log dir failed: {err}"))?;
    let log_path = log_dir.join(LOG_FILE_NAME);
    if let Ok(meta) = fs::metadata(&log_path) {
        if meta.len().saturating_add(line.len() as u64) > max_file_bytes {
            let backup_path = log_dir.join(LOG_BACKUP_NAME);
            let _ = fs::remove_file(&backup_path);
            let _ = fs::rename(&log_path, &backup_path);
        }
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| format!("open frontend log failed: {err}"))?;
    file.write_all(line.as_bytes())
        .map_err(|err| format!("write frontend log failed: {err}"))?;
    Ok(log_path)
}

#[tauri::command]
pub async fn log_frontend_error(
    app: tauri::AppHandle,
    mut entry: FrontendErrorEntry,
) -> Result<(), String> {
    if entry.app_version.as_deref().unwrap_or("").trim().is_empty() {
        entry.app_version = Some(app.package_info().version.to_string());
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("resolve app_data_dir failed: {err}"))?;
    let log_dir = app_data_dir.join(LOG_DIR_NAME);
    tauri::async_runtime::spawn_blocking(move || {
        let _ = append_log_to_dir(&log_dir, entry, MAX_LOG_FILE_BYTES);
    })
    .await
    .map_err(|err| format!("frontend log task failed: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_temp_dir::TempDir;

    #[test]
    fn redacts_database_credentials_and_bearer_tokens() {
        let raw = "connect mysql://root:s3cr3t@192.168.1.243:8306/newsg_4cfg failed; auth=Bearer eyJhbGciOiJIUzI1NiJ9.abc";
        let cleaned = redact_sensitive(raw);
        assert!(!cleaned.contains("s3cr3t"));
        assert!(!cleaned.contains("eyJhbGci"));
        assert!(cleaned.contains("mysql://***@192.168.1.243:8306/newsg_4cfg"));
        assert!(cleaned.contains("Bearer ***"));
    }

    #[test]
    fn truncates_utf8_safely_and_rotates_log_file() {
        let dir = TempDir::create("frontend-log-test");
        let long_msg = "中文错误信息".repeat(120);
        let entry = FrontendErrorEntry {
            kind: "vue-error".into(),
            message: long_msg,
            stack: Some("at render (index.js:1:2)".into()),
            component: Some("WorkbenchPane".into()),
            info: Some("render".into()),
            area: Some("pane".into()),
            app_version: Some("0.1.75".into()),
        };
        let path = append_log_to_dir(dir.path(), entry.clone(), 400).expect("first append");
        assert!(path.exists());
        let first_content = fs::read_to_string(&path).expect("read first");
        let parsed: serde_json::Value =
            serde_json::from_str(first_content.trim()).expect("valid jsonl");
        assert_eq!(parsed["kind"], "vue-error");
        assert_eq!(parsed["component"], "WorkbenchPane");

        // Second write exceeds tiny 400-byte rotation threshold and rotates to .1
        append_log_to_dir(dir.path(), entry, 400).expect("second append");
        let backup = dir.path().join(LOG_BACKUP_NAME);
        assert!(backup.exists());
        assert!(path.exists());
    }
}
