//! Local-only persistence of client bindings and relation reviews, one record
//! per MySQL server so every zone database of the same game shares them.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::model::RelationKey;

pub const FILE_NAME: &str = "config-relations.json";
const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientBinding {
    pub path: String,
    pub dialect: String,
    pub confirmed_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Confirmed,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub verdict: Verdict,
    /// Recorded by the tool because the comment and the code agreed.
    #[serde(default)]
    pub auto: bool,
    /// Code usages the decision was based on.
    #[serde(default)]
    pub code_fingerprints: BTreeSet<String>,
    /// Usages reading the same column from another table that the person
    /// confirmed this relation over; only usages beyond these reopen it.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub overridden_code: BTreeSet<String>,
    pub relation: RelationKey,
    pub decided_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRecord {
    #[serde(default)]
    pub client: Option<ClientBinding>,
    /// The user removed the client on purpose. A recommendation must not
    /// bind itself again until they pick a folder.
    #[serde(default)]
    pub client_declined: bool,
    /// Relation ids present after the bound client was first read; later
    /// relations are flagged as new until reviewed.
    #[serde(default)]
    pub baseline: Option<BTreeSet<String>>,
    #[serde(default)]
    pub decisions: BTreeMap<String, Decision>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreData {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    servers: BTreeMap<String, ServerRecord>,
}

#[derive(Debug)]
pub struct Store {
    path: PathBuf,
    data: StoreData,
}

impl Store {
    /// Unreadable files are set aside instead of being overwritten.
    pub fn load(path: PathBuf) -> Self {
        let data = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<StoreData>(&text).unwrap_or_else(|_| {
                let _ = std::fs::rename(&path, path.with_extension("json.corrupt"));
                StoreData::default()
            }),
            Err(_) => StoreData::default(),
        };
        Self { path, data }
    }

    pub fn server(&self, key: &str) -> Option<&ServerRecord> {
        self.data.servers.get(key)
    }

    pub fn server_mut(&mut self, key: &str) -> &mut ServerRecord {
        self.data.servers.entry(key.to_string()).or_default()
    }

    pub fn save(&mut self) -> Result<(), String> {
        self.data.version = VERSION;
        self.data.servers.retain(|_, record| *record != ServerRecord::default());
        let text = serde_json::to_string_pretty(&self.data)
            .map_err(|error| format!("保存关联记录失败: {error}"))?;
        write_atomically(&self.path, text.as_bytes())
            .map_err(|error| format!("保存关联记录失败: {error}"))
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_relations::model::RelationKind;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dbscout-relations-{name}-{}", uuid::Uuid::new_v4()));
        dir.join(FILE_NAME)
    }

    #[test]
    fn round_trips_records_and_drops_empty_servers() {
        let path = temp_path("roundtrip");
        let mut store = Store::load(path.clone());
        store.server_mut("db:1").client = Some(ClientBinding {
            path: "X:/game".into(),
            dialect: "jswz".into(),
            confirmed_at: "2024-01-01 10:00".into(),
        });
        store.server_mut("db:1").decisions.insert(
            "a.b>c.d".into(),
            Decision {
                verdict: Verdict::Confirmed,
                auto: false,
                code_fingerprints: BTreeSet::from(["f1".to_string()]),
                overridden_code: BTreeSet::from(["f2".to_string()]),
                relation: RelationKey {
                    source_table: "a".into(),
                    source_column: "b".into(),
                    target_table: "c".into(),
                    target_column: "d".into(),
                    kind: RelationKind::Value,
                },
                decided_at: "2024-01-01 10:01".into(),
            },
        );
        store.server_mut("empty:2");
        store.save().unwrap();

        let reloaded = Store::load(path.clone());
        assert_eq!(reloaded.server("db:1"), store.server("db:1"));
        assert!(reloaded.server("empty:2").is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn corrupt_files_are_set_aside() {
        let path = temp_path("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        let store = Store::load(path.clone());
        assert!(store.server("any").is_none());
        assert!(path.with_extension("json.corrupt").is_file());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
