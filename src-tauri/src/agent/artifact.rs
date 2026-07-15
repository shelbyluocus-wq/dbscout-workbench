use std::path::{Path, PathBuf};
use std::process::Command;

const OUTPUT_DIR_ENV: &str = "DBSCOUT_AGENT_OUTPUT_DIR";
const ALLOWED_EXTENSIONS: &[&str] = &["xlsx", "txt", "md", "json", "csv", "html", "sql"];

fn user_home_dir() -> Result<PathBuf, String> {
    let candidates = if cfg!(target_os = "windows") {
        ["USERPROFILE", "HOME"]
    } else {
        ["HOME", "USERPROFILE"]
    };
    for key in candidates {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() {
                return Ok(PathBuf::from(value));
            }
        }
    }
    Err("无法确定当前用户目录，Agent 不能创建本地文件".to_string())
}

fn default_output_dir(home: &Path) -> PathBuf {
    home.join("Documents")
        .join("DB Scout Workbench")
        .join("Agent Files")
}

pub fn output_dir() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var(OUTPUT_DIR_ENV) {
        let value = value.trim();
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    Ok(default_output_dir(&user_home_dir()?))
}

pub fn ensure_output_dir() -> Result<PathBuf, String> {
    let path = output_dir()?;
    std::fs::create_dir_all(&path).map_err(|error| format!("创建 Agent 文件目录失败: {error}"))?;
    path.canonicalize()
        .map_err(|error| format!("读取 Agent 文件目录失败: {error}"))
}

fn normalized_path(path: &Path) -> Option<String> {
    let canonical = path.canonicalize().ok()?;
    let text = canonical.to_string_lossy();
    let normalized = if cfg!(target_os = "windows") {
        text.strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .or_else(|| text.strip_prefix(r"\\?\").map(|rest| rest.to_string()))
            .unwrap_or_else(|| text.into_owned())
            .to_lowercase()
    } else {
        text.into_owned()
    };
    Some(normalized)
}

fn validate_artifact_path_with_root(root: &Path, requested: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("读取 Agent 文件目录失败: {error}"))?;
    let canonical_file = requested
        .canonicalize()
        .map_err(|error| format!("文件不存在或已被移动: {error}"))?;
    if !canonical_file.is_file() {
        return Err("只能打开 Agent 已生成的文件".to_string());
    }

    let root_normalized =
        normalized_path(&canonical_root).ok_or_else(|| "无法校验 Agent 文件目录".to_string())?;
    let file_normalized =
        normalized_path(&canonical_file).ok_or_else(|| "无法校验 Agent 文件路径".to_string())?;
    let separator = if cfg!(target_os = "windows") {
        '\\'
    } else {
        '/'
    };
    if file_normalized != root_normalized
        && !file_normalized.starts_with(&format!("{root_normalized}{separator}"))
    {
        return Err("出于安全考虑，只能打开 Agent 生成文件目录中的文件".to_string());
    }

    let extension = canonical_file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !ALLOWED_EXTENSIONS.contains(&extension.as_str()) {
        return Err("该文件类型不属于 Agent 支持的产物格式".to_string());
    }
    Ok(canonical_file)
}

fn validate_artifact_path(path: &str) -> Result<PathBuf, String> {
    let root = ensure_output_dir()?;
    validate_artifact_path_with_root(&root, Path::new(path))
}

fn platform_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        value.into_owned()
    }
}

fn open_file(path: &Path) -> Result<(), String> {
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("rundll32.exe");
        command
            .arg("url.dll,FileProtocolHandler")
            .arg(platform_path(path));
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(path);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开文件失败: {error}"))
}

fn reveal_file(path: &Path) -> Result<(), String> {
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("explorer.exe");
        command.arg(format!("/select,{}", platform_path(path)));
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg("-R").arg(path);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(path.parent().unwrap_or(path));
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开文件所在位置失败: {error}"))
}

#[tauri::command]
pub fn agent_open_artifact(path: String) -> Result<(), String> {
    open_file(&validate_artifact_path(&path)?)
}

#[tauri::command]
pub fn agent_reveal_artifact(path: String) -> Result<(), String> {
    reveal_file(&validate_artifact_path(&path)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn create() -> Self {
            let path = std::env::temp_dir().join(format!(
                "dbscout-agent-artifact-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn default_directory_is_user_facing_and_stable() {
        assert_eq!(
            default_output_dir(Path::new("C:/Users/Demo")),
            Path::new("C:/Users/Demo")
                .join("Documents")
                .join("DB Scout Workbench")
                .join("Agent Files")
        );
    }

    #[test]
    fn validates_supported_files_inside_output_root() {
        let root = TempDir::create();
        let file = root.0.join("report.xlsx");
        std::fs::write(&file, b"xlsx").unwrap();

        assert_eq!(
            validate_artifact_path_with_root(&root.0, &file).unwrap(),
            file.canonicalize().unwrap()
        );
    }

    #[test]
    fn rejects_files_outside_output_root() {
        let root = TempDir::create();
        let outside = TempDir::create();
        let file = outside.0.join("secret.xlsx");
        std::fs::write(&file, b"xlsx").unwrap();

        let error = validate_artifact_path_with_root(&root.0, &file).unwrap_err();
        assert!(error.contains("只能打开 Agent 生成文件目录"));
    }

    #[test]
    fn rejects_unsupported_extensions() {
        let root = TempDir::create();
        let file = root.0.join("run.exe");
        std::fs::write(&file, b"exe").unwrap();

        let error = validate_artifact_path_with_root(&root.0, &file).unwrap_err();
        assert!(error.contains("不属于 Agent 支持"));
    }
}
