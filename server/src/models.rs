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
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub operation_size: Option<i64>,
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

/// Per-actor participation metadata attached to compacted daily/monthly summaries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuditSummaryActor {
    #[serde(default)]
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub operation_count: u64,
    pub entry_count: u64,
    #[serde(default)]
    pub sources: Vec<String>,
}

/// Summary metadata attached to daily (`14d..180d`) and monthly (`>180d`)
/// compacted audit entries so the UI can show who edited during the period
/// and distinguish lightweight zero-net-change records.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuditSummaryMeta {
    #[serde(default)]
    pub actors: Vec<AuditSummaryActor>,
    pub operation_count: u64,
    pub entry_count: u64,
    #[serde(default)]
    pub no_net_change: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub svn_username: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_period: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_meta: Option<AuditSummaryMeta>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    pub connection_id: Option<String>,
    #[serde(default)]
    pub server_key: Option<String>,
    pub database: Option<String>,
    pub table_name: Option<String>,
    pub user_id: Option<String>,
    pub from_ts: Option<String>,
    pub to_ts: Option<String>,
    #[serde(default)]
    pub committed_only: bool,
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

/// One externally observed table change pushed by a workstation.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalChangePushItem {
    pub event_id: String,
    #[serde(default)]
    pub server_key: Option<String>,
    pub database: String,
    pub table_name: String,
    pub ts: String,
    pub ts_ms: i64,
    pub time_kind: String,
    pub signal: String,
    pub host: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalChangePushRequest {
    pub items: Vec<ExternalChangePushItem>,
}

/// One shared external change returned to clients for a table's history timeline.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedExternalChangeEntry {
    pub event_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_key: Option<String>,
    pub database: String,
    pub table_name: String,
    pub ts: String,
    pub ts_ms: i64,
    pub time_kind: String,
    pub signal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_period: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurrence_count: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExternalChangeQuery {
    pub server_key: Option<String>,
    pub database: Option<String>,
    pub table_name: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

// ---- Read-only GM hourly backups (/home/servbin/dbback) --------------------

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GmBackupListQuery {
    pub database: Option<String>,
    pub date: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GmBackupItem {
    pub date: String,
    pub hour: String,
    pub file_name: String,
    pub host: String,
    pub database: String,
    pub ts: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmBackupListResponse {
    pub enabled: bool,
    pub backup_dir_configured: bool,
    pub databases: Vec<String>,
    pub dates: Vec<String>,
    pub items: Vec<GmBackupItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmBackupTablesQuery {
    pub date: String,
    pub hour: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GmBackupTableInfo {
    pub name: String,
    pub has_data: bool,
    pub insert_batches: u32,
    pub approx_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmBackupTablesResponse {
    pub database: String,
    pub ts: String,
    pub tables: Vec<GmBackupTableInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmBackupExtractRequest {
    pub date: String,
    pub hour: String,
    pub file_name: String,
    #[serde(default)]
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmBackupExtractResponse {
    pub database: String,
    pub ts: String,
    pub tables: Vec<String>,
    pub sql: String,
}

// ---- Per-table count-based backups (up to 60 changes per table) ------------

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GmTableBackupListQuery {
    pub database: Option<String>,
    pub search: Option<String>,
    #[serde(default)]
    pub include_deleted: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GmTableBackupSummary {
    pub database: String,
    pub table_name: String,
    pub version_count: u32,
    pub latest_version_id: String,
    pub latest_version_ts: String,
    pub latest_size_bytes: u64,
    pub latest_schema_changed: bool,
    pub present_in_latest: bool,
    pub last_seen_ts: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmTableBackupListResponse {
    pub enabled: bool,
    pub max_versions: usize,
    pub last_run_ts: Option<String>,
    pub databases: Vec<String>,
    pub items: Vec<GmTableBackupSummary>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmTableBackupVersionsQuery {
    pub database: String,
    pub table_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GmTableBackupVersion {
    pub version_id: String,
    pub backup_ts: String,
    pub backup_date: String,
    pub source_file_name: String,
    pub content_hash: String,
    pub schema_changed: bool,
    pub has_data: bool,
    pub compressed_bytes: u64,
    pub raw_bytes: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmTableBackupVersionsResponse {
    pub database: String,
    pub table_name: String,
    pub present_in_latest: bool,
    pub last_seen_ts: String,
    pub max_versions: usize,
    pub versions: Vec<GmTableBackupVersion>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmTableBackupExtractRequest {
    pub database: String,
    pub table_name: String,
    pub version_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmTableBackupExtractResponse {
    pub database: String,
    pub table_name: String,
    pub version_id: String,
    pub ts: String,
    pub sql: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmTableBackupRunResponse {
    pub databases_scanned: usize,
    pub tables_scanned: usize,
    pub tables_changed: usize,
    pub tables_missing: usize,
    pub skipped_archives: usize,
}
