use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, PartialEq, Eq)]
enum RevealTarget {
    File(PathBuf),
    Directory(PathBuf),
}

fn resolve_target(path: &Path) -> Result<RevealTarget, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("导出结果不存在或已被移动: {error}"))?;
    if canonical.is_file() {
        Ok(RevealTarget::File(canonical))
    } else if canonical.is_dir() {
        Ok(RevealTarget::Directory(canonical))
    } else {
        Err("导出结果不是可打开的文件或文件夹".to_string())
    }
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

fn reveal_target(target: &RevealTarget) -> Result<(), String> {
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("explorer.exe");
        match target {
            RevealTarget::File(path) => {
                command.arg(format!("/select,{}", platform_path(path)));
            }
            RevealTarget::Directory(path) => {
                command.arg(platform_path(path));
            }
        }
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        match target {
            RevealTarget::File(path) => {
                command.arg("-R").arg(path);
            }
            RevealTarget::Directory(path) => {
                command.arg(path);
            }
        }
        command
    } else {
        let mut command = Command::new("xdg-open");
        match target {
            RevealTarget::File(path) => {
                command.arg(path.parent().unwrap_or(path));
            }
            RevealTarget::Directory(path) => {
                command.arg(path);
            }
        }
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开导出结果所在位置失败: {error}"))
}

#[tauri::command]
pub fn reveal_local_path(path: String) -> Result<(), String> {
    let requested = path.trim();
    if requested.is_empty() {
        return Err("导出结果路径为空".to_string());
    }
    reveal_target(&resolve_target(Path::new(requested))?)
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
                "dbscout-path-reveal-{}-{}",
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
    fn resolves_files_and_directories_without_launching_the_file_manager() {
        let root = TempDir::create();
        let file = root.0.join("export.xlsx");
        std::fs::write(&file, b"xlsx").unwrap();

        assert!(matches!(
            resolve_target(&root.0),
            Ok(RevealTarget::Directory(_))
        ));
        assert!(matches!(resolve_target(&file), Ok(RevealTarget::File(_))));
    }

    #[test]
    fn rejects_missing_paths() {
        let root = TempDir::create();
        let error = resolve_target(&root.0.join("missing.xlsx")).unwrap_err();
        assert!(error.contains("不存在或已被移动"));
    }

    #[test]
    fn strips_windows_verbatim_prefixes_for_explorer() {
        assert_eq!(
            platform_path(Path::new(r"\\?\E:\exports\report.xlsx")),
            r"E:\exports\report.xlsx"
        );
        assert_eq!(
            platform_path(Path::new(r"\\?\UNC\server\share\report.xlsx")),
            r"\\server\share\report.xlsx"
        );
    }
}
