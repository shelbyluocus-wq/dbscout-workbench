use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use super::{is_timestamp_dir_name, resolve_script_launch, TableTransferJobs};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupTemplate {
    script_path: String,
    project_root: String,
    #[serde(default = "default_retention")]
    retention_days: u32,
}

fn default_retention() -> u32 {
    7
}

#[derive(Default, Serialize)]
pub struct CleanupResult {
    deleted: usize,
    errors: Vec<String>,
}

pub async fn run(
    jobs: &TableTransferJobs,
    templates: Vec<CleanupTemplate>,
) -> Result<CleanupResult, String> {
    let mut roots: HashMap<PathBuf, u32> = HashMap::new();
    let mut protected = Vec::new();
    let mut result = CleanupResult::default();
    for template in templates {
        if template.retention_days > 3650 {
            return Err("产物保留天数须为 0–3650 天".into());
        }
        if !template.project_root.trim().is_empty() {
            match std::fs::canonicalize(template.project_root.trim()) {
                Ok(project) => protected.push(project),
                Err(_) if Path::new(template.script_path.trim()).is_file() => {
                    return Err("无法确认游戏工程位置，本次跳过产物清理".into());
                }
                Err(_) => {}
            }
        }
        let script = Path::new(template.script_path.trim());
        if !script.is_file() {
            continue;
        }
        protected.push(std::fs::canonicalize(script).map_err(|error| error.to_string())?);
        match resolve_script_launch(script).await {
            Ok(launch) => {
                let root =
                    std::fs::canonicalize(&launch.work_dir).map_err(|error| error.to_string())?;
                if root.parent().is_none() {
                    return Err("不能在磁盘根目录自动清理转表产物".into());
                }
                protected.push(
                    std::fs::canonicalize(launch.program).map_err(|error| error.to_string())?,
                );
                roots
                    .entry(root)
                    .and_modify(|days| {
                        *days = if *days == 0 || template.retention_days == 0 {
                            0
                        } else {
                            (*days).max(template.retention_days)
                        };
                    })
                    .or_insert(template.retention_days);
            }
            Err(error) => return Err(error),
        }
    }
    let state = Arc::clone(&jobs.state);
    tokio::task::spawn_blocking(move || {
        if state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active
            .is_some()
        {
            return result;
        }
        for (root, days) in &roots {
            if *days == 0 {
                continue;
            }
            let mut exclusions = protected.clone();
            exclusions.extend(roots.keys().filter(|other| *other != root).cloned());
            clean_root(
                root,
                *days,
                &exclusions,
                SystemTime::now(),
                &mut result,
                &|path| {
                    let state = state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if state.active.is_some() {
                        return Ok(false);
                    }
                    let pending =
                        path.with_file_name(format!(".blackcat-cleanup-{}", uuid::Uuid::new_v4()));
                    std::fs::rename(path, &pending)?;
                    drop(state);
                    if let Err(error) = std::fs::remove_dir_all(&pending) {
                        let _ = std::fs::rename(&pending, path);
                        return Err(error);
                    }
                    Ok(true)
                },
            );
        }
        result
    })
    .await
    .map_err(|error| error.to_string())
}

fn plain_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return false;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return false;
            }
        }
        true
    })
}

fn package_time(path: &Path) -> Option<SystemTime> {
    let name = path.file_name()?.to_str()?;
    if !is_timestamp_dir_name(name)
        || !plain_dir(path)
        || !plain_dir(&path.join("props"))
        || !plain_dir(&path.join("src"))
        || !plain_dir(&path.join("src/props"))
    {
        return None;
    }
    let date = chrono::NaiveDateTime::parse_from_str(name, "%Y-%m-%d %H-%M-%S").ok()?;
    let local = date.and_local_timezone(chrono::Local).single()?;
    Some(local.into())
}

fn old_plain_tree(path: &Path, cutoff: SystemTime) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || metadata.modified().map_or(true, |time| time > cutoff) {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    if metadata.is_file() {
        return true;
    }
    if !metadata.is_dir() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    for entry in entries {
        let Ok(entry) = entry else { return false };
        if entry.file_name() == ".svn"
            || entry.file_name() == ".git"
            || !old_plain_tree(&entry.path(), cutoff)
        {
            return false;
        }
    }
    true
}

fn clean_root(
    root: &Path,
    days: u32,
    protected: &[PathBuf],
    now: SystemTime,
    result: &mut CleanupResult,
    remove: &impl Fn(&Path) -> std::io::Result<bool>,
) {
    let cutoff = now - Duration::from_secs(u64::from(days) * 86400);
    let mut containers = vec![root.to_path_buf()];
    let Ok(entries) = std::fs::read_dir(root) else {
        result
            .errors
            .push(format!("无法读取产物目录：{}", root.display()));
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if plain_dir(&path)
            && !entry.file_name().to_string_lossy().starts_with('.')
            && package_time(&path).is_none()
        {
            containers.push(path);
        }
    }
    for container in containers {
        if protected.iter().any(|path| container.starts_with(path)) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&container) else {
            continue;
        };
        let packages: Vec<_> = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                package_time(&path).map(|time| (path, time))
            })
            .collect();
        let newest = packages.iter().map(|(_, time)| *time).max();
        for (path, time) in packages {
            if Some(time) == newest
                || time > cutoff
                || protected
                    .iter()
                    .any(|target| path.starts_with(target) || target.starts_with(&path))
                || !old_plain_tree(&path, cutoff)
            {
                continue;
            }
            match remove(&path) {
                Ok(true) => result.deleted += 1,
                Ok(false) => {}
                Err(error) => result
                    .errors
                    .push(format!("清理 {} 失败：{error}", path.display())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::TestTempDir;
    use super::*;

    fn remove(path: &Path) -> std::io::Result<bool> {
        std::fs::remove_dir_all(path).map(|()| true)
    }

    fn age_tree(path: &Path, time: SystemTime) {
        if path.is_dir() {
            for entry in std::fs::read_dir(path).unwrap() {
                age_tree(&entry.unwrap().path(), time);
            }
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.access_mode(0x100).custom_flags(0x02000000);
        }
        options
            .open(path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(time))
            .unwrap();
    }

    fn package(root: &Path, age: u64, now: SystemTime) -> PathBuf {
        let time = now - Duration::from_secs(age * 86400);
        let date: chrono::DateTime<chrono::Local> = time.into();
        let path = root.join(date.format("%Y-%m-%d %H-%M-%S").to_string());
        std::fs::create_dir_all(path.join("props")).unwrap();
        std::fs::create_dir_all(path.join("src/props")).unwrap();
        std::fs::write(path.join("props/config.json"), "{}").unwrap();
        age_tree(&path, time);
        path
    }

    #[test]
    fn removes_only_expired_packages_and_keeps_newest_per_container() {
        let temp = TestTempDir::create("cleanup");
        let now = SystemTime::now();
        let old = package(temp.path(), 10, now);
        let recent = package(temp.path(), 2, now);
        let nested = temp.path().join("database");
        let nested_old = package(&nested, 20, now);
        let nested_newest = package(&nested, 15, now);
        let malformed = temp.path().join("2020-99-99 00-00-00");
        std::fs::create_dir_all(malformed.join("props")).unwrap();
        std::fs::create_dir_all(malformed.join("src/props")).unwrap();
        let too_deep = package(&nested.join("deeper"), 20, now);
        let mut result = CleanupResult::default();
        clean_root(temp.path(), 7, &[], now, &mut result, &remove);
        assert_eq!(result.deleted, 2);
        assert!(!old.exists());
        assert!(!nested_old.exists());
        assert!(
            recent.exists() && nested_newest.exists() && malformed.exists() && too_deep.exists()
        );
    }

    #[test]
    fn preserves_projects_scripts_version_control_and_recent_changes() {
        let temp = TestTempDir::create("cleanup-protected");
        let now = SystemTime::now();
        package(temp.path(), 1, now);
        let project = package(temp.path(), 10, now);
        let script = package(temp.path(), 11, now);
        let changed = package(temp.path(), 12, now);
        std::fs::write(changed.join("props/config.json"), "new").unwrap();
        let versioned = package(temp.path(), 13, now);
        std::fs::create_dir(versioned.join(".svn")).unwrap();
        age_tree(&versioned, now - Duration::from_secs(13 * 86400));
        let mut result = CleanupResult::default();
        clean_root(
            temp.path(),
            7,
            &[project.join("src"), script.join("gen.sh")],
            now,
            &mut result,
            &remove,
        );
        assert_eq!(result.deleted, 0);
        assert!(project.exists() && script.exists() && changed.exists() && versioned.exists());
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_symlink_containers_or_package_contents() {
        let temp = TestTempDir::create("cleanup-links");
        let outside = TestTempDir::create("cleanup-outside");
        let now = SystemTime::now();
        let old = package(outside.path(), 10, now);
        package(outside.path(), 1, now);
        std::os::unix::fs::symlink(outside.path(), temp.path().join("database")).unwrap();
        let linked = package(temp.path(), 10, now);
        package(temp.path(), 1, now);
        std::os::unix::fs::symlink(outside.path(), linked.join("external")).unwrap();
        let mut result = CleanupResult::default();
        clean_root(temp.path(), 7, &[], now, &mut result, &remove);
        assert_eq!(result.deleted, 0);
        assert!(old.exists() && linked.exists());
    }

    #[tokio::test]
    async fn shared_directory_respects_disabled_retention_and_busy_transfer() {
        let temp = TestTempDir::create("cleanup-shared");
        let now = SystemTime::now();
        let old = package(temp.path(), 10, now);
        package(temp.path(), 1, now);
        let script = temp
            .path()
            .join(if cfg!(windows) { "gen.bat" } else { "gen.sh" });
        std::fs::write(&script, "").unwrap();
        let template = |days| CleanupTemplate {
            script_path: script.to_string_lossy().to_string(),
            project_root: String::new(),
            retention_days: days,
        };
        let jobs = TableTransferJobs::default();
        assert_eq!(
            run(&jobs, vec![template(7), template(0)])
                .await
                .unwrap()
                .deleted,
            0
        );
        assert_eq!(
            run(&jobs, vec![template(7), template(30)])
                .await
                .unwrap()
                .deleted,
            0
        );
        let guard = jobs.register("running").unwrap();
        assert_eq!(run(&jobs, vec![template(7)]).await.unwrap().deleted, 0);
        assert!(old.exists());
        drop(guard);
        assert_eq!(run(&jobs, vec![template(7)]).await.unwrap().deleted, 1);
    }
}
