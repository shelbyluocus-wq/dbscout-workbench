//! Wire types shared between the server and the Tauri client.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub username: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub username: String,
}

/// Account info returned to the client after register/login and by /me.
/// `token` is the opaque bearer credential the client stores locally.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub token: String,
}

/// One audit summary pushed by a client. Identified by `client_id` so repeated
/// pushes are idempotent (INSERT OR IGNORE). Mirrors the client's local
/// `audit_log` row but omits the heavy forward/inverse SQL.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPushItem {
    pub client_id: String,
    pub ts: String,
    pub user_id: String,
    pub username: String,
    pub connection_id: String,
    pub database: String,
    pub table_name: String,
    pub operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_identity: Option<serde_json::Value>,
    pub column_name: Option<String>,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub source: String,
    pub status: String,
    #[serde(default)]
    pub is_rollback: bool,
    pub rollback_of_client_id: Option<String>,
    pub host: Option<String>,
    #[serde(default)]
    pub server_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPushRequest {
    pub items: Vec<AuditPushItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPushResponse {
    pub accepted: u64,
    pub skipped: u64,
}

/// A shared audit-log row returned to clients. Includes the actor's display
/// name so the grid can show "who changed what".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedAuditLogEntry {
    pub client_id: String,
    pub ts: String,
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub connection_id: String,
    pub database: String,
    pub table_name: String,
    pub operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_identity: Option<serde_json::Value>,
    pub column_name: Option<String>,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub source: String,
    pub status: String,
    pub is_rollback: bool,
    pub rollback_of_client_id: Option<String>,
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    pub connection_id: Option<String>,
    pub database: Option<String>,
    pub table_name: Option<String>,
    pub user_id: Option<String>,
    pub from_ts: Option<String>,
    pub to_ts: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableLatestQuery {
    pub database: String,
    pub server_key: Option<String>,
    pub connection_id: Option<String>,
}

/// Latest committed/rolled-back change timestamp per table in one database.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedTableLatestModified {
    pub table_name: String,
    pub ts: String,
    pub username: String,
    pub display_name: String,
    pub source: String,
}
