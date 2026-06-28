use std::cmp::Ordering;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager};

const CONFIG_FILE_NAME: &str = "svn-update.json";
const MANIFEST_FILE_NAME: &str = "latest.json";
const WINDOWS_PLATFORM: &str = "windows-x86_64";

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SvnUpdateConfig {
    pub directory: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnCheckResponse {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
    pub installer_path: Option<String>,
    pub directory: Option<String>,
    pub needs_directory: bool,
}

#[derive(Debug, serde::Deserialize)]
struct UpdateManifest {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
    platforms: std::collections::HashMap<String, ManifestPlatform>,
}

#[derive(Debug, serde::Deserialize)]
struct ManifestPlatform {
    path: String,
    #[allow(dead_code)]
    signature: Option<String>,
}

pub fn load_config(app: &AppHandle) -> SvnUpdateConfig {
    let Ok(path) = config_path(app) else {
        return SvnUpdateConfig::default();
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return SvnUpdateConfig::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

pub fn save_config(app: &AppHandle, config: &SvnUpdateConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建更新配置目录失败: {error}"))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("写入更新配置失败: {error}"))?;
    std::fs::write(path, format!("{content}\n"))
        .map_err(|error| format!("保存更新配置失败: {error}"))
}

pub async fn pick_directory(app: AppHandle) -> Result<Option<SvnUpdateConfig>, String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择 SVN 更新目录")
        .pick_folder()
        .await;
    let Some(folder) = folder else {
        return Ok(None);
    };
    let config = SvnUpdateConfig {
        directory: Some(folder.path().to_string_lossy().to_string()),
    };
    save_config(&app, &config)?;
    Ok(Some(config))
}

pub fn check(app: &AppHandle) -> Result<SvnCheckResponse, String> {
    let config = load_config(app);
    let current_version = app.package_info().version.to_string();
    let Some(directory) = config.directory.as_deref().filter(|value| !value.trim().is_empty())
    else {
        return Ok(SvnCheckResponse {
            available: false,
            current_version,
            version: None,
            date: None,
            body: None,
            installer_path: None,
            directory: None,
            needs_directory: true,
        });
    };

    let directory = PathBuf::from(directory);
    if !directory.is_dir() {
        return Err(format!(
            "SVN 更新目录不存在: {}",
            directory.to_string_lossy()
        ));
    }

    run_svn_update(app, &directory).map_err(|error| {
        let _ = open_directory(&directory);
        error
    })?;

    let manifest = read_manifest(&directory)?;
    let platform = manifest
        .platforms
        .get(WINDOWS_PLATFORM)
        .ok_or_else(|| "latest.json 缺少 windows-x86_64 安装包信息".to_string())?;
    let installer_path = resolve_manifest_path(&directory, &platform.path)?;
    if !installer_path.is_file() {
        return Err(format!(
            "安装包不存在: {}",
            installer_path.to_string_lossy()
        ));
    }

    let available = compare_versions(&manifest.version, &current_version) == Ordering::Greater;
    Ok(SvnCheckResponse {
        available,
        current_version,
        version: Some(manifest.version),
        date: manifest.pub_date,
        body: manifest.notes,
        installer_path: Some(installer_path.to_string_lossy().to_string()),
        directory: Some(directory.to_string_lossy().to_string()),
        needs_directory: false,
    })
}

pub fn install(installer_path: String) -> Result<(), String> {
    let path = PathBuf::from(installer_path);
    if !path.is_file() {
        return Err(format!("安装包不存在: {}", path.to_string_lossy()));
    }
    Command::new(&path)
        .spawn()
        .map_err(|error| format!("启动安装包失败: {error}"))?;
    Ok(())
}

pub fn open_update_directory(path: String) -> Result<(), String> {
    open_directory(Path::new(&path))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(CONFIG_FILE_NAME))
        .map_err(|error| format!("无法读取应用配置目录: {error}"))
}

fn read_manifest(directory: &Path) -> Result<UpdateManifest, String> {
    let path = directory.join(MANIFEST_FILE_NAME);
    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("读取 latest.json 失败: {error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("latest.json 格式不正确: {error}"))
}

fn run_svn_update(app: &AppHandle, directory: &Path) -> Result<(), String> {
    let svn = resolve_svn_exe(app).ok_or_else(|| {
        "没有找到 svn.exe。请安装 SVN 命令行工具，或让发布包随软件携带 svn.exe。".to_string()
    })?;
    let output = Command::new(&svn)
        .arg("update")
        .arg(directory)
        .output()
        .map_err(|error| format!("执行 svn update 失败: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let details = [stdout, stderr]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if details.is_empty() {
        Err(format!("SVN 更新失败: {}", output.status))
    } else {
        Err(format!("SVN 更新失败: {}\n{}", output.status, details))
    }
}

fn resolve_svn_exe(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        if let Ok(resource_dir) = app.path().resource_dir() {
            let bundled = resource_dir.join("svn").join("svn.exe");
            if bundled.is_file() {
                return Some(bundled);
            }
        }
        find_on_path("svn.exe")
    } else {
        find_on_path("svn")
    }
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

fn resolve_manifest_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let trimmed = relative.trim();
    if trimmed.is_empty() {
        return Err("latest.json 中的安装包路径为空".to_string());
    }
    let relative_path = Path::new(trimmed);
    if relative_path.is_absolute() {
        return Err("latest.json 中的安装包路径必须是相对路径".to_string());
    }
    if relative_path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("latest.json 中的安装包路径不能跳出 SVN 更新目录".to_string());
    }
    Ok(root.join(relative_path))
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    let left_parts = parse_version_parts(left);
    let right_parts = parse_version_parts(right);
    let max_len = left_parts.len().max(right_parts.len());
    for index in 0..max_len {
        let left_value = *left_parts.get(index).unwrap_or(&0);
        let right_value = *right_parts.get(index).unwrap_or(&0);
        match left_value.cmp(&right_value) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    Ordering::Equal
}

fn parse_version_parts(version: &str) -> Vec<u64> {
    version
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

fn open_directory(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        Command::new("explorer.exe")
            .arg(explorer_directory_arg(path))
            .spawn()
            .map_err(|error| format!("打开资源管理器失败: {error}"))?;
        Ok(())
    } else if cfg!(target_os = "macos") {
        open_directory_with_status("open", path)
    } else {
        open_directory_with_status("xdg-open", path)
    }
}

fn open_directory_with_status(program: &str, path: &Path) -> Result<(), String> {
    let status = Command::new(program)
        .arg(path)
        .status()
        .map_err(|error| format!("打开文件夹失败: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("打开文件夹失败: {status}"))
    }
}

fn explorer_directory_arg(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        value.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison_handles_dotted_numeric_versions() {
        assert_eq!(compare_versions("0.1.5", "0.1.4"), Ordering::Greater);
        assert_eq!(compare_versions("0.1.4", "0.1.4"), Ordering::Equal);
        assert_eq!(compare_versions("0.1.4", "0.2.0"), Ordering::Less);
        assert_eq!(compare_versions("0.10.0", "0.2.9"), Ordering::Greater);
    }

    #[test]
    fn manifest_path_must_stay_inside_update_directory() {
        let root = Path::new(r"E:\updates");
        assert_eq!(
            resolve_manifest_path(root, "blackcat_0.1.5_x64-setup.exe").unwrap(),
            PathBuf::from(r"E:\updates").join("blackcat_0.1.5_x64-setup.exe")
        );
        assert!(resolve_manifest_path(root, r"..\other.exe").is_err());
        assert!(resolve_manifest_path(root, r"C:\other.exe").is_err());
    }

    #[test]
    fn parses_local_manifest_with_relative_installer_path() {
        let manifest: UpdateManifest = serde_json::from_str(
            r#"{
              "version": "0.1.5",
              "notes": "Release notes",
              "pub_date": "2026-06-28T12:00:00Z",
              "platforms": {
                "windows-x86_64": {
                  "path": "blackcat_0.1.5_x64-setup.exe",
                  "signature": "abc"
                }
              }
            }"#,
        )
        .unwrap();

        let platform = manifest.platforms.get(WINDOWS_PLATFORM).unwrap();
        assert_eq!(manifest.version, "0.1.5");
        assert_eq!(manifest.notes.as_deref(), Some("Release notes"));
        assert_eq!(platform.path, "blackcat_0.1.5_x64-setup.exe");
    }

    #[test]
    fn explorer_arg_strips_windows_verbatim_prefixes() {
        assert_eq!(
            explorer_directory_arg(Path::new(r"\\?\E:\updates")),
            r"E:\updates"
        );
        assert_eq!(
            explorer_directory_arg(Path::new(r"\\?\UNC\server\share\updates")),
            r"\\server\share\updates"
        );
    }
}
