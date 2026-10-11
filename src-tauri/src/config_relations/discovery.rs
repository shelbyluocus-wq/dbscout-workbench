//! Finds game client folders that match a config database, so the user can
//! pick the right checkout instead of typing a path.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

use super::catalog::DbSnapshot;
use super::code_scan::{self, ClientDialect};

/// Below this share of matching tables a folder is not worth suggesting.
const MIN_RECOMMENDED_RATIO: f64 = 0.5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCandidate {
    pub path: String,
    pub dialect: String,
    /// Database tables the client declares.
    pub matched_tables: usize,
    pub total_tables: usize,
    /// Last change to the client's generated config definitions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub recommended: bool,
}

pub fn dialect_name(dialect: ClientDialect) -> &'static str {
    match dialect {
        ClientDialect::Jswz => "jswz",
        ClientDialect::Nzg => "nzg",
    }
}

fn format_time(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Local>::from(time)
        .format("%Y-%m-%d %H:%M")
        .to_string()
}

fn latest_modified(files: &[PathBuf]) -> Option<SystemTime> {
    files
        .iter()
        .filter_map(|file| std::fs::metadata(file).ok()?.modified().ok())
        .max()
}

/// Describes one folder, or explains why it is not a usable client.
pub fn inspect(path: &Path, snapshot: &DbSnapshot) -> Result<(ClientCandidate, Option<SystemTime>), String> {
    if !path.is_dir() {
        return Err("找不到这个目录".into());
    }
    let dialect = code_scan::detect_dialect(path)
        .ok_or_else(|| "这个目录不是可识别的游戏客户端工程".to_string())?;
    let catalog = code_scan::read_catalog(path, dialect);
    let matched_tables = snapshot
        .tables
        .keys()
        .filter(|table| catalog.tables.contains_key(*table))
        .count();
    let modified = latest_modified(&catalog.source_files);
    Ok((
        ClientCandidate {
            path: path.to_string_lossy().into_owned(),
            dialect: dialect_name(dialect).into(),
            matched_tables,
            total_tables: snapshot.tables.len(),
            updated_at: modified.map(format_time),
            recommended: false,
        },
        modified,
    ))
}

/// Ranks folders by how many of the database's tables they declare, then by
/// how recently their config definitions changed. Folders that share no
/// tables with the database belong to another game and are dropped.
pub fn rank(paths: Vec<PathBuf>, snapshot: &DbSnapshot) -> Vec<ClientCandidate> {
    let mut seen = Vec::new();
    let mut ranked = Vec::new();
    for path in paths {
        let identity = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen.contains(&identity) {
            continue;
        }
        seen.push(identity);
        if let Ok((candidate, modified)) = inspect(&path, snapshot) {
            if candidate.matched_tables > 0 {
                ranked.push((candidate, modified));
            }
        }
    }
    ranked.sort_by(|(left, left_time), (right, right_time)| {
        right
            .matched_tables
            .cmp(&left.matched_tables)
            .then_with(|| right_time.cmp(left_time))
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut candidates = ranked.into_iter().map(|(candidate, _)| candidate).collect::<Vec<_>>();
    if let Some(best) = candidates.first_mut() {
        let ratio = best.matched_tables as f64 / best.total_tables.max(1) as f64;
        best.recommended = ratio >= MIN_RECOMMENDED_RATIO;
    }
    candidates
}

pub fn discover(snapshot: &DbSnapshot, extra: Vec<PathBuf>) -> Vec<ClientCandidate> {
    let mut paths = extra;
    paths.extend(crate::table_transfer::discover_game_projects());
    rank(paths, snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_relations::catalog::test_support::{snapshot, table};

    #[test]
    fn non_client_folders_are_explained() {
        let db = snapshot(vec![table("goodsprop", &[("ID", "int", "", true)])]);
        let missing = std::env::temp_dir().join(format!("dbscout-missing-{}", uuid::Uuid::new_v4()));
        assert!(inspect(&missing, &db).is_err());
        let plain = std::env::temp_dir();
        assert!(inspect(&plain, &db).is_err());
        assert!(rank(vec![missing, plain], &db).is_empty());
    }
}
