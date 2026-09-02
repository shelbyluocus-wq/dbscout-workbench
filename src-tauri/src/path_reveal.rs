use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, PartialEq, Eq)]
enum RevealTarget {
    File(PathBuf),
    Directory(PathBuf),
}

fn resolve_target(path: &Path) -> Result<RevealTarget, String> {
    // 不 canonicalize：在大 SVN 工作副本上解析真实路径会明显拖慢「浏览」。
    let metadata = path
        .metadata()
        .map_err(|error| format!("导出结果不存在或已被移动: {error}"))?;
    if metadata.is_file() {
        Ok(RevealTarget::File(path.to_path_buf()))
    } else if metadata.is_dir() {
        Ok(RevealTarget::Directory(path.to_path_buf()))
    } else {
        Err("导出结果不是可打开的文件或文件夹".to_string())
    }
}

fn folder_to_open(target: &RevealTarget) -> PathBuf {
    match target {
        RevealTarget::File(path) => path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| path.clone()),
        RevealTarget::Directory(path) => path.clone(),
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
        // `explorer /select,` 会走现有资源管理器进程，经常要等一两秒。
        // `cmd /c start "" <文件夹>` 走 ShellExecute，弹出快得多；文件则打开其所在目录。
        let folder = platform_path(&folder_to_open(target));
        let mut command = Command::new("cmd");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
            command.args(["/d", "/c", "start", ""]);
            command.raw_arg(format!("\"{folder}\""));
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
    fn file_reveal_opens_the_parent_folder() {
        let root = TempDir::create();
        let file = root.0.join("export.xlsx");
        std::fs::write(&file, b"xlsx").unwrap();
        let target = resolve_target(&file).unwrap();
        assert_eq!(folder_to_open(&target), root.0);
        let dir_target = resolve_target(&root.0).unwrap();
        assert_eq!(folder_to_open(&dir_target), root.0);
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
