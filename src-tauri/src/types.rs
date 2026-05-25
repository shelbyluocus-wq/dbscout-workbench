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

#[derive(Debug, Clone)]
pub struct TableSession {
    pub table_name: String,
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
        let selected_connection_id = if mysql_url.is_some() { "mysql-env" } else { "demo" }.to_string();
        let mut connections = HashMap::new();
        connections.insert(selected_connection_id.clone(), RuntimeConnection {
            id: selected_connection_id.clone(),
            label: if mysql_url.is_some() { "MySQL".into() } else { "Demo MySQL".into() },
            host: if mysql_url.is_some() { "configured".into() } else { "demo".into() },
            port: 3306,
            username: if mysql_url.is_some() { "env".into() } else { "root".into() },
            mysql_url,
            database: Some("game_db".into()),
            pool: None,
        });
        Self {
            runtime: Mutex::new(RuntimeState {
                connections,
                selected_connection_id,
                selected_database: "game_db".into(),
                schema: crate::demo::demo_schema(),
                sessions: HashMap::new(),
                next_session_id: 0,
                demo_rows: crate::demo::demo_rows(),
            }),
        }
    }
}
