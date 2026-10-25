//! Release guide: pick a file or folder to keep out of a client sync. The
//! choice must lie inside one of the client folders the sync uses. Both sides
//! are compared after resolving `..` and symbolic links, so neither can lead
//! outside, and a client folder itself cannot be excluded.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionPickRequest {
    /// Client folders of the sync; the dialog opens in the first one that exists.
    pub roots: Vec<String>,
    /// "file" or "folder".
    pub kind: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionPick {
    /// "picked", "cancelled", "outside", "isRoot", "rootMissing" or "missing".
    pub status: String,
    /// "file" or "folder", as found on disk.
    pub kind: String,
    /// The choice relative to its client folder, with "/" separators.
    pub relative: String,
    /// The client folder (as given) that contains the choice.
    pub root: String,
    /// The chosen path as the dialog returned it.
    pub path: String,
}

impl ExclusionPick {
    fn status(status: &str, path: &Path) -> Self {
        Self {
            status: status.to_string(),
            kind: String::new(),
            relative: String::new(),
            root: String::new(),
            path: path.to_string_lossy().into_owned(),
        }
    }
}

/// Where `picked` lies relative to the client folders, after resolving it.
pub fn classify(roots: &[String], picked: &Path) -> ExclusionPick {
    let Ok(resolved) = std::fs::canonicalize(picked) else {
        return ExclusionPick::status("missing", picked);
    };
    let mut any_root = false;
    for root in roots {
        let given = root.trim();
        if given.is_empty() {
            continue;
        }
        let Ok(base) = std::fs::canonicalize(given) else {
            continue;
        };
        any_root = true;
        if resolved == base {
            return ExclusionPick::status("isRoot", picked);
        }
        let Ok(rest) = resolved.strip_prefix(&base) else {
            continue;
        };
        let relative = rest
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        return ExclusionPick {
            status: "picked".into(),
            kind: if resolved.is_dir() { "folder" } else { "file" }.into(),
            relative,
            root: given.to_string(),
            path: picked.to_string_lossy().into_owned(),
        };
    }
    ExclusionPick::status(if any_root { "outside" } else { "rootMissing" }, picked)
}

fn first_existing_root(roots: &[String]) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| PathBuf::from(root.trim()))
        .find(|root| !root.as_os_str().is_empty() && root.is_dir())
}

/// Open the native picker in the client folder and check the choice.
pub async fn pick_exclusion(request: ExclusionPickRequest) -> Result<ExclusionPick, String> {
    let Some(start) = first_existing_root(&request.roots) else {
        return Ok(ExclusionPick::status("rootMissing", Path::new("")));
    };
    let mut dialog = rfd::AsyncFileDialog::new().set_directory(&start);
    if !request.title.trim().is_empty() {
        dialog = dialog.set_title(request.title.trim());
    }
    let picked = if request.kind == "folder" {
        dialog.pick_folder().await
    } else {
        dialog.pick_file().await
    };
    let Some(handle) = picked else {
        return Ok(ExclusionPick::status("cancelled", Path::new("")));
    };
    let path = handle.path().to_path_buf();
    let roots = request.roots;
    tokio::task::spawn_blocking(move || classify(&roots, &path))
        .await
        .map_err(|error| format!("检查排除路径失败: {error}"))
}

#[tauri::command]
pub async fn release_pick_exclusion(request: ExclusionPickRequest) -> Result<ExclusionPick, String> {
    pick_exclusion(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_temp_dir::TempDir;

    fn layout() -> (TempDir, PathBuf, PathBuf) {
        let temp = TempDir::create("release-paths");
        let client = temp.path().join("client");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(client.join("assets/config")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(client.join("assets/config/Config.ts"), "x").unwrap();
        std::fs::write(outside.join("secret.txt"), "x").unwrap();
        (temp, client, outside)
    }

    fn roots(client: &Path) -> Vec<String> {
        vec![client.to_string_lossy().into_owned()]
    }

    #[test]
    fn a_file_or_folder_inside_the_client_is_relative_to_it() {
        let (_temp, client, _) = layout();
        let file = classify(&roots(&client), &client.join("assets/config/Config.ts"));
        assert_eq!((file.status.as_str(), file.kind.as_str(), file.relative.as_str()), ("picked", "file", "assets/config/Config.ts"));
        let folder = classify(&roots(&client), &client.join("assets/config"));
        assert_eq!((folder.status.as_str(), folder.kind.as_str(), folder.relative.as_str()), ("picked", "folder", "assets/config"));
    }

    #[test]
    fn parent_steps_and_other_folders_are_outside() {
        let (_temp, client, outside) = layout();
        let escaped = client.join("assets").join("..").join("..").join("outside").join("secret.txt");
        assert_eq!(classify(&roots(&client), &escaped).status, "outside");
        assert_eq!(classify(&roots(&client), &outside.join("secret.txt")).status, "outside");
        // A sibling whose name only starts like the client folder is not inside it.
        let sibling = client.with_file_name("client-old");
        std::fs::create_dir_all(&sibling).unwrap();
        assert_eq!(classify(&roots(&client), &sibling).status, "outside");
    }

    #[test]
    fn the_client_folder_itself_and_missing_paths_are_refused() {
        let (_temp, client, _) = layout();
        assert_eq!(classify(&roots(&client), &client).status, "isRoot");
        assert_eq!(classify(&roots(&client), &client.join("assets").join("..")).status, "isRoot");
        assert_eq!(classify(&roots(&client), &client.join("nope.txt")).status, "missing");
        let gone = vec![client.join("gone").to_string_lossy().into_owned()];
        assert_eq!(classify(&gone, &client.join("assets")).status, "rootMissing");
    }

    #[test]
    fn a_second_client_folder_also_counts() {
        let (_temp, client, outside) = layout();
        let both = vec![client.to_string_lossy().into_owned(), outside.to_string_lossy().into_owned()];
        let pick = classify(&both, &outside.join("secret.txt"));
        assert_eq!((pick.status.as_str(), pick.relative.as_str()), ("picked", "secret.txt"));
        assert_eq!(pick.root, outside.to_string_lossy());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_inside_the_client_that_points_outside_is_refused() {
        let (_temp, client, outside) = layout();
        let link = client.join("assets/linked");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert_eq!(classify(&roots(&client), &link.join("secret.txt")).status, "outside");
        assert_eq!(classify(&roots(&client), &link).status, "outside");
        let inner = client.join("assets/config-link");
        std::os::unix::fs::symlink(client.join("assets/config"), &inner).unwrap();
        let pick = classify(&roots(&client), &inner);
        assert_eq!((pick.status.as_str(), pick.relative.as_str()), ("picked", "assets/config"));
    }
}
