use std::{collections::HashMap, env};

use serde::{Deserialize, Serialize};
use sqlx::MySqlPool;
use tokio::sync::Mutex;
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum DatabaseKind {
    #[serde(rename = "mysql")]
    MySql,
    #[serde(rename = "clickhouse")]
    ClickHouse,
}

impl DatabaseKind {
    pub fn from_wire(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "clickhouse" | "click_house" | "ch" => Self::ClickHouse,
            _ => Self::MySql,
        }
    }

    pub fn infer(kind: Option<&str>, url: &str) -> Self {
        if let Some(kind) = kind.filter(|value| !value.trim().is_empty()) {
            return Self::from_wire(kind);
        }
        let lower = url.trim().to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            Self::ClickHouse
        } else {
            Self::MySql
        }
    }

    pub fn is_read_only(self) -> bool {
        matches!(self, Self::ClickHouse)
    }

    pub fn default_port(self) -> u16 {
        match self {
            Self::MySql => 3306,
            Self::ClickHouse => 8123,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::MySql => "MySQL",
            Self::ClickHouse => "ClickHouse",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeConnection {
    pub id: String,
    pub kind: DatabaseKind,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub mysql_url: Option<String>,
    pub clickhouse_url: Option<String>,
    pub database: Option<String>,
    pub pool: Option<MySqlPool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchConnection {
    pub id: String,
    pub kind: DatabaseKind,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub database: Option<String>,
    pub connected: bool,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableOption {
    pub table_name: String,
    pub table_comment: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnMeta {
    pub column_name: String,
    pub column_type: String,
    pub column_comment: String,
    pub is_primary_key: bool,
    pub is_nullable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_maximum_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numeric_precision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numeric_scale: Option<u64>,
    #[serde(default)]
    pub is_unsigned: bool,
    #[serde(default)]
    pub is_auto_increment: bool,
    #[serde(default)]
    pub enum_values: Vec<String>,
    #[serde(default)]
    pub set_values: Vec<String>,
    #[serde(default)]
    pub is_generated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_mode: Option<String>,
}

impl ColumnMeta {
    pub fn with_basic(
        column_name: impl Into<String>,
        column_type: impl Into<String>,
        column_comment: impl Into<String>,
        is_primary_key: bool,
        is_nullable: bool,
    ) -> Self {
        let column_type = column_type.into();
        let data_type = column_type
            .trim()
            .to_ascii_lowercase()
            .split(|ch: char| ch == '(' || ch.is_whitespace())
            .find(|part| !part.is_empty())
            .map(str::to_string);
        Self {
            column_name: column_name.into(),
            column_type: column_type.clone(),
            column_comment: column_comment.into(),
            is_primary_key,
            is_nullable,
            data_type,
            character_maximum_length: None,
            numeric_precision: None,
            numeric_scale: None,
            is_unsigned: column_type.to_ascii_lowercase().contains("unsigned"),
            is_auto_increment: false,
            enum_values: Vec::new(),
            set_values: Vec::new(),
            is_generated: false,
            default_value: None,
            default_mode: None,
        }
    }
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
    #[serde(default)]
    pub mode: Option<String>,
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
    #[serde(default)]
    pub include_total: Option<bool>,
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
    pub total_rows_exact: bool,
    pub has_more: bool,
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
    /// New cell value. `None`/null means write SQL NULL; `Some("")` means an
    /// explicit empty string. Keeping these distinct lets nullable columns
    /// store NULL while non-string columns still accept "" where allowed (#5).
    pub new_value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCellResult {
    pub updated: bool,
    pub conflict: bool,
    /// The value now stored in the cell. `None` means SQL NULL was written (or
    /// is currently present for a conflict report), serialized as JSON null so
    /// the frontend can render "NULL" (#5).
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertRowRequest {
    pub session_id: String,
    pub draft: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchImportRowsRequest {
    pub session_id: String,
    pub rows: Vec<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatchImportRowOutcome {
    pub index: usize,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatchImportRowError {
    pub index: usize,
    pub column_name: Option<String>,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatchImportRowsResult {
    pub inserted: u64,
    pub updated: u64,
    pub unchanged: u64,
    pub errors: Vec<BatchImportRowError>,
    pub outcomes: Vec<BatchImportRowOutcome>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchValuesRequest {
    pub connection_id: Option<String>,
    pub database: Option<String>,
    pub query: String,
    pub limit: Option<usize>,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub priority_tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchValuesProgress {
    pub job_id: String,
    pub query: String,
    pub database: String,
    pub done: u64,
    pub total: u64,
    pub matches: u64,
    pub current_table: Option<String>,
    pub message: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchValueItem {
    pub table_name: String,
    pub table_comment: String,
    pub column_name: String,
    pub preview_value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_identity: Option<HashMap<String, String>>,
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
    #[serde(default)]
    pub conflicts: Vec<String>,
    #[serde(default)]
    pub human_descriptions: Vec<String>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDatabaseSyncRequest {
    pub connection_id: String,
    pub source_database: String,
    pub target_database: String,
    #[serde(default)]
    pub excluded_tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSyncTablePlan {
    pub name: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDatabaseSyncResponse {
    pub source_tables: Vec<String>,
    pub target_tables: Vec<String>,
    pub included_tables: Vec<String>,
    pub excluded_tables: Vec<String>,
    pub target_only_tables_to_drop: Vec<String>,
    pub preserved_target_tables: Vec<String>,
    pub estimated_rows: u64,
    pub warnings: Vec<String>,
    pub tables: Vec<DatabaseSyncTablePlan>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDatabaseOverwriteRequest {
    pub job_id: String,
    pub connection_id: String,
    pub source_database: String,
    pub target_database: String,
    #[serde(default)]
    pub excluded_tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncDatabaseOverwriteResponse {
    pub job_id: String,
    pub status: String,
    pub copied_tables: Vec<String>,
    pub copied_rows: u64,
    pub dropped_tables: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_database: Option<String>,
    pub message: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyTablesRequest {
    pub connection_id: String,
    pub source_database: String,
    pub table_names: Vec<String>,
    pub target_connection_id: String,
    pub target_database: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopyTablesResult {
    pub original_name: String,
    pub target_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopyTablesResponse {
    pub status: String,
    pub copied: Vec<CopyTablesResult>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropTablesRequest {
    pub connection_id: String,
    pub database: String,
    #[serde(default, alias = "tableNames")]
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DropTablesResult {
    pub table_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DropTablesResponse {
    pub dropped: Vec<DropTablesResult>,
    pub failed: Vec<DropTablesResult>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameTableResponse {
    pub renamed: bool,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSyncProgress {
    pub stage: String,
    pub job_id: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_table: Option<String>,
    pub completed_tables: u64,
    pub total_tables: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_database: Option<String>,
    pub status: String,
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone)]
pub struct TableSession {
    pub connection_id: String,
    pub kind: DatabaseKind,
    pub database: String,
    pub table_name: String,
    pub clickhouse_url: Option<String>,
    pub pool: Option<MySqlPool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DemoProfile {
    Stress,
}

#[derive(Debug, Clone, Copy)]
pub struct RuntimeOptions {
    pub demo_profile: Option<DemoProfile>,
}

impl RuntimeOptions {
    pub fn for_current_build() -> Self {
        Self {
            demo_profile: if cfg!(debug_assertions) {
                Some(DemoProfile::Stress)
            } else {
                None
            },
        }
    }
}

pub struct RuntimeState {
    pub connections: HashMap<String, RuntimeConnection>,
    pub selected_connection_id: String,
    pub selected_database: String,
    pub schema: Vec<TableMeta>,
    pub sessions: HashMap<String, TableSession>,
    pub next_session_id: u64,
    pub demo_profile: Option<DemoProfile>,
    pub demo_schema_overrides: HashMap<String, Vec<TableMeta>>,
    pub demo_rows: HashMap<String, Vec<HashMap<String, String>>>,
}

pub struct AppState {
    pub runtime: Mutex<RuntimeState>,
    pub agent_sidecar: Mutex<Option<crate::agent::AgentSidecar>>,
    pub backup: BackupState,
    pub account: AccountState,
}

/// Backup/audit runtime state. The SQLite audit pool is lazily initialized
/// (AppState::new is sync and cannot await) on first use via audit::ensure_audit_pool,
/// and held in a Mutex<Option<Pool>> so it can be reset when storage_dir changes.
/// BackupConfig is file-backed (backup/config.json) rather than held in memory.
pub struct BackupState {
    pub audit_pool: tokio::sync::Mutex<Option<sqlx::SqlitePool>>,
    pub snapshot_jobs: tokio::sync::Mutex<HashMap<String, ()>>,
}

impl Default for BackupState {
    fn default() -> Self {
        Self {
            audit_pool: tokio::sync::Mutex::new(None),
            snapshot_jobs: tokio::sync::Mutex::new(HashMap::new()),
        }
    }
}

/// A logged-in user session. Persisted (token + identity) so the app can
/// restore the session across restarts. Token-based (no password): the central
/// server issues an opaque token on register/login.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSession {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub token: String,
}

/// Persisted account config stored at `<app_data_dir>/account/session.json`.
/// `server_url` is the central service base URL (e.g. http://192.168.1.10:8765);
/// `session` is `None` when logged out. `loaded` is an in-memory-only flag
/// (never serialized) tracking whether the on-disk config has been read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfig {
    #[serde(default)]
    pub server_url: Option<String>,
    #[serde(default)]
    pub session: Option<UserSession>,
    #[serde(default, skip)]
    pub loaded: bool,
}

/// Runtime account state held in `AppState`. `config` is the persisted
/// server-url + session (mutable, locked); `http` is a shared reqwest client.
pub struct AccountState {
    pub config: tokio::sync::Mutex<AccountConfig>,
    pub http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default = "default_interval_minutes")]
    pub interval_minutes: u64,
    #[serde(default = "default_large_table_threshold")]
    pub large_table_threshold: u64,
    #[serde(default = "default_max_per_db")]
    pub max_per_db: u32,
    #[serde(default = "default_databases_scope")]
    pub databases_scope: String,
    #[serde(default = "default_snapshot_enabled_databases")]
    pub snapshot_enabled_databases: Vec<SnapshotDatabaseKey>,
    #[serde(default = "default_audit_retention_days")]
    pub audit_retention_days: u32,
    #[serde(default = "default_storage_dir")]
    pub storage_dir: Option<String>,
}

/// One entry in the per-database snapshot opt-in whitelist. A database is
/// snapshotted by the scheduler only when `databases_scope == "selected"` and
/// a matching (connection_id, database) key is present here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDatabaseKey {
    pub connection_id: String,
    pub database: String,
}

fn default_enabled() -> bool {
    true
}
fn default_interval_minutes() -> u64 {
    30
}
fn default_large_table_threshold() -> u64 {
    50_000
}
fn default_max_per_db() -> u32 {
    50
}
fn default_databases_scope() -> String {
    // "selected" = only databases in `snapshot_enabled_databases` are snapshotted.
    // "all" (legacy value) = every database of every snapshotable connection.
    // New installs default to "selected" with an empty whitelist, so snapshots
    // are opt-in per database. Existing config files that stored "all" keep it.
    "selected".into()
}
fn default_snapshot_enabled_databases() -> Vec<SnapshotDatabaseKey> {
    Vec::new()
}
fn default_audit_retention_days() -> u32 {
    90
}
fn default_storage_dir() -> Option<String> {
    None
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            interval_minutes: default_interval_minutes(),
            large_table_threshold: default_large_table_threshold(),
            max_per_db: default_max_per_db(),
            databases_scope: default_databases_scope(),
            snapshot_enabled_databases: default_snapshot_enabled_databases(),
            audit_retention_days: default_audit_retention_days(),
            storage_dir: default_storage_dir(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfigResponse {
    pub enabled: bool,
    pub interval_minutes: u64,
    pub large_table_threshold: u64,
    pub max_per_db: u32,
    pub databases_scope: String,
    pub snapshot_enabled_databases: Vec<SnapshotDatabaseKey>,
    pub audit_retention_days: u32,
    pub storage_dir: Option<String>,
    pub resolved_storage_dir: String,
}

impl BackupConfigResponse {
    pub fn from_config(config: BackupConfig, resolved_storage_dir: String) -> Self {
        Self {
            enabled: config.enabled,
            interval_minutes: config.interval_minutes,
            large_table_threshold: config.large_table_threshold,
            max_per_db: config.max_per_db,
            databases_scope: config.databases_scope,
            snapshot_enabled_databases: config.snapshot_enabled_databases,
            audit_retention_days: config.audit_retention_days,
            storage_dir: config.storage_dir,
            resolved_storage_dir,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAuditLogsRequest {
    pub connection_id: Option<String>,
    pub database: Option<String>,
    pub table_name: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
    pub from_ts: Option<String>,
    pub to_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogEntry {
    pub id: i64,
    pub ts: String,
    pub connection_id: String,
    pub database: String,
    pub table_name: String,
    pub operation: String,
    pub row_identity: Option<serde_json::Value>,
    pub column_name: Option<String>,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub forward_sql: Option<String>,
    pub inverse_sql: Option<String>,
    pub rollback_strategy: String,
    pub source: String,
    pub status: String,
    pub is_rollback: bool,
    pub rollback_of: Option<i64>,
    pub notes: Option<String>,
    /// Display name of the user who made the change (None when logged out).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    /// Client-generated UUID; the idempotency key for syncing to the server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

/// A shared change-log entry fetched from the central server. Mirrors the
/// server's `SharedAuditLogEntry` and includes the actor's display name so the
/// UI can show "who changed what" across all users.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub column_name: Option<String>,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub source: String,
    pub status: String,
    pub is_rollback: bool,
    pub rollback_of_client_id: Option<String>,
    pub host: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAccountServerRequest {
    pub server_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterAccountRequest {
    pub username: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginAccountRequest {
    pub username: String,
}

/// Account info returned to the frontend (mirrors the server's `AccountInfo`).
/// The token is included so the frontend can echo it; persistence lives in Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub token: String,
}

/// The account config surfaced to the frontend via `get_account`. The token is
/// omitted (the frontend doesn't need it), so this is safe to log.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub server_url: Option<String>,
    pub session: Option<UserSession>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditSyncResult {
    pub accepted: u64,
    pub skipped: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackRequest {
    pub audit_id: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackResult {
    pub rolled_back: bool,
    pub new_audit_id: Option<i64>,
    pub conflict: bool,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSnapshotRequest {
    pub connection_id: Option<String>,
    pub database: Option<String>,
}

/// Toggle the per-database snapshot opt-in for a single (connection, database).
/// When switching scope from `"all"` to `"selected"`, the backend first seeds
/// the whitelist with every snapshotable database before applying this toggle.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSnapshotEnabledRequest {
    pub connection_id: String,
    pub database: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub path: String,
    pub connection_id: String,
    pub database: String,
    pub ts: String,
    pub size_bytes: u64,
    pub table_count: u32,
    pub manifest: Option<serde_json::Value>,
    pub location: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSnapshotRequest {
    pub snapshot_path: String,
    pub connection_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSnapshotsRequest {
    pub connection_id: Option<String>,
    pub database: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneSnapshotsRequest {
    pub connection_id: Option<String>,
    pub database: Option<String>,
}

impl RuntimeState {
    pub fn new(mysql_url: Option<String>, options: RuntimeOptions) -> Self {
        let mut connections = HashMap::new();
        let mut selected_connection_id = String::new();
        let mut selected_database = String::new();
        let mut schema = Vec::new();
        let demo_profile = if mysql_url.is_some() {
            None
        } else {
            options.demo_profile
        };

        if let Some(url) = &mysql_url {
            selected_connection_id = "mysql-env".into();
            selected_database = "game_db".into();
            connections.insert(
                "mysql-env".into(),
                RuntimeConnection {
                    id: "mysql-env".into(),
                    kind: DatabaseKind::MySql,
                    label: "MySQL".into(),
                    host: "configured".into(),
                    port: 3306,
                    username: "env".into(),
                    mysql_url: Some(url.clone()),
                    clickhouse_url: None,
                    database: Some(selected_database.clone()),
                    pool: None,
                },
            );
            schema = crate::demo::demo_schema();
        } else if matches!(demo_profile, Some(DemoProfile::Stress)) {
            selected_connection_id = crate::demo::stress_connection_id().into();
            selected_database = crate::demo::stress_default_database().into();
            connections.insert(
                selected_connection_id.clone(),
                RuntimeConnection {
                    id: selected_connection_id.clone(),
                    kind: DatabaseKind::MySql,
                    label: "Stress Demo".into(),
                    host: "demo".into(),
                    port: 3306,
                    username: "root".into(),
                    mysql_url: None,
                    clickhouse_url: None,
                    database: Some(selected_database.clone()),
                    pool: None,
                },
            );
            schema = crate::demo::stress_schema_for(&selected_database);
        }

        Self {
            connections,
            selected_connection_id,
            selected_database,
            schema,
            sessions: HashMap::new(),
            next_session_id: 0,
            demo_profile,
            demo_schema_overrides: HashMap::new(),
            demo_rows: HashMap::new(),
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        let mysql_url = env::var("DBSCOUT_MYSQL_URL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        Self::with_runtime_options(mysql_url, RuntimeOptions::for_current_build())
    }

    pub fn with_runtime_options(mysql_url: Option<String>, options: RuntimeOptions) -> Self {
        Self {
            runtime: Mutex::new(RuntimeState::new(mysql_url, options)),
            agent_sidecar: Mutex::new(None),
            backup: BackupState::default(),
            account: AccountState {
                // The persisted session.json lives under app_data_dir, which is
                // not available until the Tauri app is built. Load it lazily on
                // first use via account::ensure_loaded (mirrors ensure_audit_pool).
                config: tokio::sync::Mutex::new(AccountConfig::default()),
                http: build_account_http_client(),
            },
        }
    }
}

fn build_account_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .no_proxy()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_session_retains_connection_and_database_source() {
        let session = TableSession {
            connection_id: "mysql-stage".into(),
            kind: DatabaseKind::MySql,
            database: "stage_game".into(),
            table_name: "hero".into(),
            clickhouse_url: None,
            pool: None,
        };

        assert_eq!(session.connection_id, "mysql-stage");
        assert_eq!(session.database, "stage_game");
        assert_eq!(session.table_name, "hero");
        assert_eq!(session.kind, DatabaseKind::MySql);
    }

    #[test]
    fn account_http_client_disables_proxy_lookup() {
        let source = include_str!("types.rs").replace("\r\n", "\n");
        let marker = "fn build_account_http_client() -> reqwest::Client";
        let body = source
            .split(marker)
            .nth(1)
            .and_then(|tail| tail.split("\n}").next())
            .expect("account HTTP client builder should be factored for proxy policy");
        assert!(
            body.contains(&[".", "no_proxy", "()"].concat()),
            "account HTTP client must bypass system/env proxies for LAN center-server traffic"
        );
    }

    #[test]
    fn clickhouse_connections_are_read_only() {
        assert_eq!(
            DatabaseKind::from_wire("clickhouse"),
            DatabaseKind::ClickHouse
        );
        assert_eq!(DatabaseKind::from_wire("mysql"), DatabaseKind::MySql);
        assert!(DatabaseKind::ClickHouse.is_read_only());
        assert!(!DatabaseKind::MySql.is_read_only());
    }

    #[test]
    fn release_like_runtime_has_no_demo_connections_without_mysql_url() {
        let runtime = RuntimeState::new(None, RuntimeOptions { demo_profile: None });

        assert!(runtime.connections.is_empty());
        assert_eq!(runtime.selected_connection_id, "");
        assert_eq!(runtime.selected_database, "");
        assert!(runtime.schema.is_empty());
        assert_eq!(runtime.demo_profile, None);
        assert!(runtime.demo_rows.is_empty());
    }

    #[test]
    fn debug_stress_runtime_has_stress_demo_connection_without_mysql_url() {
        let runtime = RuntimeState::new(
            None,
            RuntimeOptions {
                demo_profile: Some(DemoProfile::Stress),
            },
        );

        assert_eq!(runtime.connections.len(), 1);
        assert_eq!(runtime.selected_connection_id, "demo-stress");
        assert_eq!(runtime.selected_database, "game_db_01");
        assert_eq!(runtime.demo_profile, Some(DemoProfile::Stress));
        assert_eq!(runtime.schema.len(), 800);
        assert!(runtime.demo_rows.is_empty());
    }

    #[test]
    fn mysql_runtime_ignores_demo_profile() {
        let runtime = RuntimeState::new(
            Some("mysql://root:secret@127.0.0.1:3306".into()),
            RuntimeOptions {
                demo_profile: Some(DemoProfile::Stress),
            },
        );

        assert_eq!(runtime.connections.len(), 1);
        assert!(runtime.connections.contains_key("mysql-env"));
        assert_eq!(runtime.selected_connection_id, "mysql-env");
        assert_eq!(runtime.demo_profile, None);
    }
}
