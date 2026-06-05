use std::{collections::HashMap, env};

use serde::{Deserialize, Serialize};
use sqlx::MySqlPool;
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub struct RuntimeConnection {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub mysql_url: Option<String>,
    pub database: Option<String>,
    pub pool: Option<MySqlPool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkbenchConnection {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub database: Option<String>,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableOption {
    pub table_name: String,
    pub table_comment: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnMeta {
    pub column_name: String,
    pub column_type: String,
    pub column_comment: String,
    pub is_primary_key: bool,
    pub is_nullable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableMeta {
    pub table_name: String,
    pub table_comment: String,
    pub columns: Vec<ColumnMeta>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TablePageFilter {
    pub query: String,
    #[serde(default)]
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePageSort {
    pub column_name: String,
    #[serde(default)]
    pub descending: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TablePageRequest {
    pub page: Option<u32>,
    pub page_size: Option<u32>,
    pub filter: Option<TablePageFilter>,
    pub sort: Option<TablePageSort>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSessionPage {
    pub session_id: String,
    pub table_name: String,
    pub table_comment: String,
    pub columns: Vec<ColumnMeta>,
    pub primary_keys: Vec<String>,
    pub rows: Vec<HashMap<String, String>>,
    pub total_rows: u64,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCellRequest {
    pub session_id: String,
    pub row_identity: HashMap<String, String>,
    pub column_name: String,
    pub old_value: String,
    pub new_value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCellResult {
    pub updated: bool,
    pub conflict: bool,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertRowRequest {
    pub session_id: String,
    pub draft: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRowsRequest {
    pub session_id: String,
    pub row_identities: Vec<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RowMutationResult {
    pub affected: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickSearchRequest {
    pub query: String,
    pub scope: Option<String>,
    pub table_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickSearchItem {
    pub kind: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub label: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableDesignSource {
    pub connection_id: String,
    pub database: String,
    pub table_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDesignMeta {
    pub ordinal: u32,
    pub column_name: String,
    pub column_type: String,
    pub data_type: String,
    pub length: Option<u64>,
    pub scale: Option<u64>,
    pub is_nullable: bool,
    pub is_primary_key: bool,
    pub default_mode: String,
    pub default_value: Option<String>,
    pub column_comment: String,
    pub extra: String,
    pub generation_expression: Option<String>,
    pub is_generated: bool,
    pub is_supported: bool,
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableDesignMeta {
    pub source: TableDesignSource,
    pub table_name: String,
    pub table_comment: String,
    pub schema_signature: Option<String>,
    pub columns: Vec<ColumnDesignMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDesignDraft {
    pub original_name: String,
    pub name: String,
    #[serde(rename = "type", alias = "dataType", alias = "data_type")]
    pub data_type: String,
    pub length: Option<u64>,
    pub scale: Option<u64>,
    pub nullable: bool,
    pub primary_key: bool,
    pub default_mode: String,
    pub default_value: Option<String>,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableDesignDraft {
    pub table_comment: String,
    pub columns: Vec<ColumnDesignDraft>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableDesignPreviewRequest {
    pub connection_id: String,
    pub database: String,
    pub table_name: String,
    pub draft: TableDesignDraft,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableDesignPreview {
    pub signature: String,
    pub preview_signature: String,
    pub source_signature: String,
    pub schema_signature: String,
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
    pub has_changes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyTableDesignRequest {
    pub connection_id: String,
    pub database: String,
    pub table_name: String,
    pub draft: TableDesignDraft,
    #[serde(default)]
    pub schema_signature: Option<String>,
    #[serde(default)]
    pub source_signature: Option<String>,
    #[serde(default)]
    pub preview_signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyTableDesignResult {
    pub applied: bool,
    pub schema: TableDesignMeta,
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
    pub preview_signature: String,
    pub schema_signature: String,
}

#[derive(Debug, Clone)]
pub struct TableSession {
    pub connection_id: String,
    pub database: String,
    pub table_name: String,
    pub pool: Option<MySqlPool>,
}

pub struct RuntimeState {
    pub connections: HashMap<String, RuntimeConnection>,
    pub selected_connection_id: String,
    pub selected_database: String,
    pub schema: Vec<TableMeta>,
    pub sessions: HashMap<String, TableSession>,
    pub next_session_id: u64,
    pub demo_rows: HashMap<String, Vec<HashMap<String, String>>>,
}

pub struct AppState {
    pub runtime: Mutex<RuntimeState>,
}

impl AppState {
    pub fn new() -> Self {
        let mysql_url = env::var("DBSCOUT_MYSQL_URL").ok().filter(|value| !value.trim().is_empty());
        let mut connections = HashMap::new();

        if let Some(url) = &mysql_url {
            connections.insert("mysql-env".into(), RuntimeConnection {
                id: "mysql-env".into(),
                label: "MySQL".into(),
                host: "configured".into(),
                port: 3306,
                username: "env".into(),
                mysql_url: Some(url.clone()),
                database: Some("game_db".into()),
                pool: None,
            });
        } else {
            connections.insert("demo".into(), RuntimeConnection {
                id: "demo".into(),
                label: "Demo GameDB".into(),
                host: "demo".into(),
                port: 3306,
                username: "root".into(),
                mysql_url: None,
                database: Some("game_db".into()),
                pool: None,
            });
            connections.insert("demo-staging".into(), RuntimeConnection {
                id: "demo-staging".into(),
                label: "Staging Server".into(),
                host: "staging.local".into(),
                port: 3306,
                username: "dev".into(),
                mysql_url: None,
                database: Some("game_db".into()),
                pool: None,
            });
            connections.insert("demo-test".into(), RuntimeConnection {
                id: "demo-test".into(),
                label: "Test Server".into(),
                host: "test.local".into(),
                port: 3307,
                username: "tester".into(),
                mysql_url: None,
                database: Some("game_db".into()),
                pool: None,
            });
        }

        let selected_connection_id = if mysql_url.is_some() { "mysql-env".to_string() } else { "demo".to_string() };
        let mut demo_rows = crate::demo::demo_rows();
        for (k, v) in crate::demo::demo_rows_for_new_tables() {
            demo_rows.entry(k).or_insert(v);
        }

        Self {
            runtime: Mutex::new(RuntimeState {
                connections,
                selected_connection_id: selected_connection_id.clone(),
                selected_database: "game_db".into(),
                schema: if mysql_url.is_some() { crate::demo::demo_schema() } else { crate::demo::demo_schema_for(&selected_connection_id, "game_db") },
                sessions: HashMap::new(),
                next_session_id: 0,
                demo_rows,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_session_retains_connection_and_database_source() {
        let session = TableSession {
            connection_id: "mysql-stage".into(),
            database: "stage_game".into(),
            table_name: "hero".into(),
            pool: None,
        };

        assert_eq!(session.connection_id, "mysql-stage");
        assert_eq!(session.database, "stage_game");
        assert_eq!(session.table_name, "hero");
    }
}
