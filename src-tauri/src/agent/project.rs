use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub short_path: String,
    pub available: bool,
    pub read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn pick_project_directory() -> Result<Option<ProjectDirectoryInfo>, String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择 Agent 可读取的项目文件夹")
        .pick_folder()
        .await;
    let Some(folder) = folder else {
        return Ok(None);
    };
    project_info_from_path(folder.path()).map(Some)
}

pub fn validate_project_directory(path: String) -> ProjectDirectoryInfo {
    validate_project_directory_path(Path::new(&path))
}

pub fn validate_project_directory_path(path: &Path) -> ProjectDirectoryInfo {
    match project_info_from_path(path) {
        Ok(info) => info,
        Err(error) => {
            let normalized = normalize_display_path(path.to_path_buf());
            ProjectDirectoryInfo {
                id: project_id_from_path(path),
                name: directory_name(path),
                short_path: normalized.clone(),
                path: normalized,
                available: false,
                read_only: true,
                error: Some(error),
            }
        }
    }
}

pub fn project_info_from_path(path: &Path) -> Result<ProjectDirectoryInfo, String> {
    if !path.exists() {
        return Err(format!("项目文件夹不存在: {}", path.to_string_lossy()));
    }
    if !path.is_dir() {
        return Err(format!("所选路径不是文件夹: {}", path.to_string_lossy()));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法访问项目文件夹: {error}"))?;
    // Cheap permission check only; selection must not recursively scan a project.
    std::fs::read_dir(&canonical).map_err(|error| format!("没有权限读取项目文件夹: {error}"))?;
    let display = normalize_display_path(canonical.clone());
    Ok(ProjectDirectoryInfo {
        id: project_id_from_path(&canonical),
        name: directory_name(&canonical),
        path: display.clone(),
        short_path: display,
        available: true,
        read_only: true,
        error: None,
    })
}

pub fn project_id_from_path(path: &Path) -> String {
    let normalized = normalize_display_path(path.to_path_buf()).replace('\\', "/");
    let mut id = String::new();
    for ch in normalized.chars() {
        if ch.is_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            id.extend(ch.to_lowercase());
        } else if !id.ends_with('-') {
            id.push('-');
        }
    }
    let trimmed = id.trim_matches('-');
    let readable = if trimmed.is_empty() {
        "project"
    } else {
        trimmed
    };
    format!("{}-{:016x}", readable, stable_hash64(&normalized))
}

fn stable_hash64(value: &str) -> u64 {
    const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x00000100000001b3;

    let mut hash = FNV_OFFSET_BASIS;
    for byte in value.to_lowercase().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

fn directory_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("项目文件夹")
        .to_string()
}

fn normalize_display_path(path: PathBuf) -> String {
    let s = path.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("dbscout-{name}-{suffix}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn project_info_uses_directory_name_and_read_only_flag() {
        let dir = temp_dir("project-info");
        let info = project_info_from_path(&dir).unwrap();

        assert!(info.id.contains("dbscout-project-info"));
        assert!(info.name.starts_with("dbscout-project-info"));
        assert_eq!(info.available, true);
        assert_eq!(info.read_only, true);
        assert_eq!(info.error, None);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validate_reports_missing_directory_without_panicking() {
        let path = std::env::temp_dir().join("dbscout-project-missing-for-test");
        let info = validate_project_directory_path(&path);

        assert_eq!(info.available, false);
        assert_eq!(info.read_only, true);
        assert!(info.error.unwrap().contains("不存在"));
    }

    #[test]
    fn project_id_is_stable_for_path_variants() {
        let a = project_id_from_path(Path::new(r"E:\project\dbscout-workbench"));
        let b = project_id_from_path(Path::new("E:/project/dbscout-workbench"));

        assert_eq!(a, b);
        assert!(
            a.starts_with("e-project-dbscout-workbench-"),
            "expected readable project slug with deterministic suffix, got {a}"
        );
        assert_eq!(a.len(), "e-project-dbscout-workbench-".len() + 16);
    }

    #[test]
    fn project_id_distinguishes_unicode_paths() {
        let one = project_id_from_path(Path::new(r"D:\项目一"));
        let two = project_id_from_path(Path::new(r"D:\项目二"));

        assert_ne!(one, two);
        assert!(
            one.starts_with("d-项目一-"),
            "unexpected id for first project: {one}"
        );
        assert!(
            two.starts_with("d-项目二-"),
            "unexpected id for second project: {two}"
        );
    }

    #[test]
    fn project_id_distinguishes_separator_and_hyphen_variants() {
        let hyphen = project_id_from_path(Path::new(r"C:\foo-bar"));
        let nested = project_id_from_path(Path::new(r"C:\foo\bar"));

        assert_ne!(hyphen, nested);
        assert!(
            hyphen.starts_with("c-foo-bar-"),
            "unexpected id for hyphen path: {hyphen}"
        );
        assert!(
            nested.starts_with("c-foo-bar-"),
            "unexpected id for nested path: {nested}"
        );
    }
}
