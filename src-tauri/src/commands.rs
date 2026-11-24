use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};

use sqlx::{MySqlPool, Row};
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::agent::{project::ProjectDirectoryInfo, AgentConfig, AgentContext, AgentSidecar};
use crate::audit;
use crate::backup;
use crate::clickhouse;
use crate::mongodb;
use crate::db::{
    connect_database, connect_table_count_database, escape_ident, list_tables_from_db,
    observe_tables_from_db, read_db_page_with_perf_in_database,
    read_db_search_scan_page_with_perf, read_db_table_count_with_perf, read_schemas_for_tables,
    read_table_design, search_value_matches_in_database, test_database_connection,
};
use crate::demo::{
    count_stress_or_materialized_rows, materialize_stress_rows, read_stress_or_materialized_page,
    read_stress_search_scan_page, resolve_demo_table, sample_stress_rows, search_single_demo_table,
    stress_databases, stress_schema_for,
};
use crate::mysql_column_types::supports_table_design;
use crate::mysql_text;
use crate::perf::{
    begin_controlled_run, current_build_perf_controls_allowed, PerfContext, PerfEventDetails,
    PerfOutcome, PerfPhase, PerfResponse, PerfRunMetadata, PerfSnapshot, PerfStage,
    PerformanceRecorder,
};
use crate::perf_fixture::{
    count_fixture_rows, fixture_database, fixture_metadata, fixture_schema, read_fixture_page,
    read_fixture_search_scan_page,
};
use crate::runtime_resources::{PoolKey, ServerPoolKey};
use crate::svn_updater::{self, SvnCheckResponse, SvnUpdateConfig};
use crate::sync::{self, DATABASE_SYNC_PROGRESS_EVENT};
use crate::system_fonts;
use crate::table_copy;
use crate::table_search::{TableSearchJob, TableSearchJobSpec};
use crate::types::*;
use crate::work_scheduler::{ScheduledWorkError, WorkCancellation, WorkClass, WorkScheduleError};

const SEARCH_VALUES_TABLE_SCAN_LIMIT: usize = 1500;
const SEARCH_VALUES_PROGRESS_EVENT: &str = "search-values-progress";
pub const TABLE_SESSIONS_INVALIDATED_EVENT: &str = "table-sessions-invalidated";
const TABLE_SESSION_JANITOR_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSessionsInvalidatedPayload {
    pub connection_id: String,
    pub session_ids: Vec<String>,
    pub reason: String,
}

/// Periodically prunes idle-expired table sessions and notifies the frontend
/// so affected tabs can reopen their session instead of failing lazily.
pub fn spawn_table_session_janitor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TABLE_SESSION_JANITOR_INTERVAL).await;
            let state = app.state::<AppState>();
            let pruned = {
                let mut rt = state.runtime.lock().await;
                rt.sessions.prune_expired()
            };
            if pruned.is_empty() {
                continue;
            }
            let mut by_connection: HashMap<String, Vec<String>> = HashMap::new();
            for (session_id, connection_id) in pruned {
                by_connection
                    .entry(connection_id)
                    .or_default()
                    .push(session_id);
            }
            for (connection_id, session_ids) in by_connection {
                let _ = app.emit(
                    TABLE_SESSIONS_INVALIDATED_EVENT,
                    TableSessionsInvalidatedPayload {
                        connection_id,
                        session_ids,
                        reason: "expired".into(),
                    },
                );
            }
        }
    });
}
const TABLE_COUNT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
const TABLE_SEARCH_SCAN_PAGE_SIZE: u32 = 128;
const TABLE_SEARCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const FOREGROUND_DB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const BACKGROUND_SCHEMA_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const SEARCH_VALUES_SCHEDULE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn map_scheduled_work_error<E: ToString>(error: ScheduledWorkError<E>) -> String {
    match error {
        ScheduledWorkError::Cancelled => "数据库工作已取消".into(),
        ScheduledWorkError::TimedOut => "数据库正忙，请稍后重试".into(),
        ScheduledWorkError::Work(error) => error.to_string(),
    }
}

fn map_schedule_error(error: WorkScheduleError) -> String {
    match error {
        WorkScheduleError::Cancelled => "数据库工作已取消".into(),
        WorkScheduleError::TimedOut => "数据库正忙，请稍后重试".into(),
    }
}

pub(crate) async fn run_pool_work<T, E, Fut>(
    scheduler: &crate::work_scheduler::WorkScheduler,
    pool_key: &PoolKey,
    class: WorkClass,
    timeout: std::time::Duration,
    work: Fut,
) -> Result<T, String>
where
    Fut: Future<Output = Result<T, E>>,
    E: ToString,
{
    scheduler
        .run(pool_key, class, &WorkCancellation::new(), timeout, work)
        .await
        .map_err(map_scheduled_work_error)
}

fn schema_table_options(
    missing: Vec<crate::schema_cache::SchemaCacheKey>,
) -> Vec<TableOption> {
    missing
        .into_iter()
        .map(|key| TableOption {
            table_name: key.table_name().to_string(),
            table_comment: String::new(),
            column_count: None,
            data_size_bytes: None,
            modified_at: None,
            modified_source: None,
            modified_actor: None,
        })
        .collect()
}

fn stale_schema_keys(
    cache: &crate::schema_cache::SchemaCache,
    keys: &[crate::schema_cache::SchemaCacheKey],
    snapshots: &[crate::schema_cache::SchemaSnapshot],
) -> Vec<crate::schema_cache::SchemaCacheKey> {
    keys.iter()
        .zip(snapshots.iter())
        .filter(|(key, snapshot)| !cache.is_fresh(key, snapshot))
        .map(|(key, _)| key.clone())
        .collect()
}

pub(crate) fn invalidate_table_schema(state: &AppState, connection_id: &str, database: &str, table: &str) {
    state
        .schema_cache
        .invalidate_table(&crate::schema_cache::SchemaCacheKey::new(
            connection_id,
            database,
            table,
        ));
}

fn invalidate_renamed_schema(
    state: &AppState,
    connection_id: &str,
    database: &str,
    old_table: &str,
    new_table: &str,
) {
    state.schema_cache.invalidate_rename(
        &crate::schema_cache::SchemaCacheKey::new(connection_id, database, old_table),
        &crate::schema_cache::SchemaCacheKey::new(connection_id, database, new_table),
    );
}

pub(crate) fn invalidate_table_count(state: &AppState, connection_id: &str, database: &str, table: &str) {
    state
        .table_counts
        .invalidate_table(&PoolKey::new(connection_id, database), table);
}

fn invalidate_database_count(state: &AppState, connection_id: &str, database: &str) {
    state
        .table_counts
        .invalidate_database(&PoolKey::new(connection_id, database));
}

fn invalidate_renamed_count(
    state: &AppState,
    connection_id: &str,
    database: &str,
    old_table: &str,
    new_table: &str,
) {
    invalidate_table_count(state, connection_id, database, old_table);
    invalidate_table_count(state, connection_id, database, new_table);
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFilePayload {
    file_name: String,
    data: Vec<u8>,
}

#[tauri::command]
pub fn svn_update_get_config(app: AppHandle) -> Result<SvnUpdateConfig, String> {
    Ok(svn_updater::load_config(&app))
}

#[tauri::command]
pub async fn svn_update_pick_directory(app: AppHandle) -> Result<Option<SvnUpdateConfig>, String> {
    svn_updater::pick_directory(app).await
}

#[tauri::command]
pub async fn svn_update_check(app: AppHandle) -> Result<SvnCheckResponse, String> {
    tauri::async_runtime::spawn_blocking(move || svn_updater::check(&app))
        .await
        .map_err(|error| format!("更新检查任务失败: {error}"))?
}

#[tauri::command]
pub fn svn_update_install(installer_path: String) -> Result<(), String> {
    svn_updater::install(installer_path)
}

#[tauri::command]
pub async fn list_system_fonts() -> Result<SystemFontListResponse, String> {
    let fonts = tauri::async_runtime::spawn_blocking(system_fonts::list_system_font_families)
        .await
        .map_err(|error| format!("读取系统字体任务失败: {error}"))??;
    Ok(SystemFontListResponse { fonts })
}

#[tauri::command]
pub fn svn_update_open_directory(path: String) -> Result<(), String> {
    svn_updater::open_update_directory(path)
}

#[tauri::command]
pub async fn table_transfer_pick_script() -> Result<Option<String>, String> {
    crate::table_transfer::pick_script().await
}

#[tauri::command]
pub async fn table_transfer_pick_project_dir() -> Result<Option<String>, String> {
    crate::table_transfer::pick_project_dir().await
}

#[tauri::command]
pub async fn table_transfer_discover_paths(
    templates: Vec<crate::types::TableTransferTemplatePaths>,
) -> Vec<crate::types::TableTransferTemplatePaths> {
    tokio::task::spawn_blocking(move || crate::table_transfer::discover_template_paths(templates))
        .await
        .unwrap_or(vec![])
}

#[tauri::command]
pub async fn table_transfer_cleanup(
    state: State<'_, AppState>,
    templates: Vec<crate::table_transfer::cleanup::CleanupTemplate>,
) -> Result<crate::table_transfer::cleanup::CleanupResult, String> {
    crate::table_transfer::cleanup::run(&state.table_transfer, templates).await
}

#[tauri::command]
pub async fn table_transfer_run(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    request: TableTransferRunRequest,
) -> Result<TableTransferRunResult, String> {
    crate::table_transfer::run(&app, &window, &state.table_transfer, request).await
}

#[tauri::command]
pub fn table_transfer_cancel(state: State<'_, AppState>, job_id: String) -> bool {
    state.table_transfer.cancel(&job_id)
}

#[tauri::command]
pub async fn agent_runtime_status(app: AppHandle) -> Result<AgentRuntimeStatusResponse, String> {
    tauri::async_runtime::spawn_blocking(move || crate::agent_runtime::status(&app))
        .await
        .map_err(|error| format!("读取 AI 组件状态任务失败: {error}"))?
}

#[tauri::command]
pub async fn agent_runtime_check(app: AppHandle) -> Result<AgentRuntimeStatusResponse, String> {
    tauri::async_runtime::spawn_blocking(move || crate::agent_runtime::check(&app))
        .await
        .map_err(|error| format!("检查 AI 组件任务失败: {error}"))?
}

#[tauri::command]
pub async fn agent_runtime_install(app: AppHandle) -> Result<AgentRuntimeStatusResponse, String> {
    let install_app = app.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || crate::agent_runtime::install(&install_app))
            .await
            .map_err(|error| format!("安装 AI 组件任务失败: {error}"))?;
    if let Err(error) = &result {
        crate::agent_runtime::emit_install_error(&app, error);
    }
    result
}

fn ensure_perf_controls_allowed() -> Result<(), String> {
    if current_build_perf_controls_allowed() {
        Ok(())
    } else {
        Err("性能记录器在当前构建中未启用".into())
    }
}

#[tauri::command]
pub fn perf_begin_run(
    metadata: Option<PerfRunMetadata>,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<PerfSnapshot, String> {
    begin_controlled_run(
        &state.perf,
        perf_context.run_id,
        metadata.unwrap_or_default(),
        cfg!(debug_assertions),
        std::env::var("DBSCOUT_PERF_ENABLED").ok().as_deref(),
    )
}

#[tauri::command]
pub fn perf_snapshot(state: State<'_, AppState>) -> Result<PerfSnapshot, String> {
    ensure_perf_controls_allowed()?;
    Ok(state.perf.snapshot())
}

#[tauri::command]
pub fn perf_end_run(state: State<'_, AppState>) -> Result<PerfSnapshot, String> {
    ensure_perf_controls_allowed()?;
    Ok(state.perf.end_run())
}

#[tauri::command]
pub async fn perf_fixture_metadata(
    state: State<'_, AppState>,
) -> Result<PerfFixtureMetadata, String> {
    let (selection, uses_external_database) = {
        let rt = state.runtime.lock().await;
        let selection = rt
            .demo_profile
            .and_then(DemoProfile::performance_selection)
            .ok_or_else(|| "确定性性能数据集未启用".to_string())?;
        let uses_external_database = rt.connections.values().any(|connection| {
            connection.mysql_url.is_some()
                || connection.clickhouse_url.is_some()
                || connection.mongodb_url.is_some()
        });
        (selection, uses_external_database)
    };
    Ok(fixture_metadata(
        &selection,
        cfg!(debug_assertions),
        if tauri::is_dev() {
            "devUrl"
        } else {
            "embeddedDist"
        },
        uses_external_database,
    ))
}

#[tauri::command]
pub async fn perf_fixture_reset(
    state: State<'_, AppState>,
) -> Result<PerfFixtureResetResult, String> {
    state.runtime.lock().await.reset_performance_fixture()?;
    state
        .table_counts
        .invalidate_connection(crate::perf_fixture::fixture_connection_id());
    Ok(PerfFixtureResetResult { reset: true })
}

fn order_tables_by_priority(
    tables: Vec<TableOption>,
    priority_tables: &[String],
) -> Vec<TableOption> {
    if priority_tables.is_empty() {
        return tables;
    }
    let priority = priority_tables
        .iter()
        .map(|name| name.trim().to_lowercase())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    let mut indexed = tables.into_iter().enumerate().collect::<Vec<_>>();
    indexed.sort_by_key(|(index, table)| {
        (
            priority
                .iter()
                .position(|name| name == &table.table_name.to_lowercase())
                .unwrap_or(usize::MAX),
            *index,
        )
    });
    indexed.into_iter().map(|(_, table)| table).collect()
}

fn filter_tables_by_included(
    tables: Vec<TableOption>,
    included_tables: &[String],
) -> Vec<TableOption> {
    if included_tables.is_empty() {
        return tables;
    }
    let included = included_tables
        .iter()
        .map(|name| name.trim().to_lowercase())
        .filter(|name| !name.is_empty())
        .collect::<std::collections::HashSet<_>>();
    tables
        .into_iter()
        .filter(|table| included.contains(&table.table_name.to_lowercase()))
        .collect()
}

fn no_demo_error() -> String {
    "没有可用的内置演示数据，请先新建 MySQL 连接".into()
}

fn read_only_error(kind: DatabaseKind) -> String {
    format!("{} 连接仅支持查看，不能执行写入操作", kind.label())
}

fn reject_mongo(kind: DatabaseKind, feature: &str) -> Result<(), String> {
    if kind == DatabaseKind::MongoDb {
        Err(kind.unsupported_feature(feature))
    } else {
        Ok(())
    }
}

fn session_mongo_url(session: &TableSession) -> Option<String> {
    session
        .mongodb_url
        .clone()
        .filter(|_| session.kind == DatabaseKind::MongoDb)
}

fn connection_connected(connection: &RuntimeConnection, mysql_pool_connected: bool) -> bool {
    match connection.kind {
        DatabaseKind::MySql => connection.mysql_url.is_none() || mysql_pool_connected,
        DatabaseKind::ClickHouse => connection.clickhouse_url.is_some(),
        DatabaseKind::MongoDb => connection.mongodb_url.is_some(),
    }
}

pub(crate) fn demo_row_key(database: &str, table_name: &str) -> String {
    format!("{database}\x1f{table_name}")
}

async fn record_perf_result<T, F>(
    recorder: &PerformanceRecorder,
    context: &PerfContext,
    label: &'static str,
    phase: PerfPhase,
    stage: PerfStage,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let span = recorder.begin_span(label, phase, Some(context), || {
        PerfEventDetails::stage(stage)
    });
    let result = future.await;
    if let Some(span) = span {
        span.finish(
            if result.is_ok() {
                PerfOutcome::Success
            } else {
                PerfOutcome::Error
            },
            PerfEventDetails::default,
        );
    }
    result
}

/// Best-effort: write a pending audit row. Returns its id, or None if the audit
/// store is unavailable. Audit must never block a user's edit.
async fn best_effort_audit(
    app: &AppHandle,
    state: &State<'_, AppState>,
    perf_context: &PerfContext,
    ctx: audit::AuditContext,
    pending: audit::PendingAudit,
) -> Option<i64> {
    let span = state.perf.begin_span(
        "audit.persist_pending",
        PerfPhase::Audit,
        Some(perf_context),
        || PerfEventDetails::stage(PerfStage::Audit),
    );
    let result = async {
        let pool = audit::ensure_audit_pool(app, state).await?;
        audit::record_pending(&pool, &ctx, &pending).await
    }
    .await;
    if let Some(span) = span {
        span.finish(
            if result.is_ok() {
                PerfOutcome::Success
            } else {
                PerfOutcome::Error
            },
            PerfEventDetails::default,
        );
    }
    result.ok()
}

/// Flip a pending audit row to committed (applied) or aborted (not applied).
async fn mark_audit(
    app: &AppHandle,
    state: &State<'_, AppState>,
    perf_context: &PerfContext,
    id: Option<i64>,
    applied: bool,
) {
    let Some(id) = id else { return };
    let span = state.perf.begin_span(
        "audit.persist_status",
        PerfPhase::Audit,
        Some(perf_context),
        || PerfEventDetails::stage(PerfStage::Audit),
    );
    let Ok(pool) = audit::ensure_audit_pool(app, state).await else {
        if let Some(span) = span {
            span.finish(PerfOutcome::Error, PerfEventDetails::default);
        }
        return;
    };
    let result = if applied {
        audit::mark_committed(&pool, &[id]).await
    } else {
        audit::mark_aborted(&pool, &[id]).await
    };
    if let Some(span) = span {
        span.finish(
            if result.is_ok() {
                PerfOutcome::Success
            } else {
                PerfOutcome::Error
            },
            PerfEventDetails::default,
        );
    }
    if applied {
        let enqueue_span = state.perf.begin_span(
            "audit_sync.notification_enqueue",
            PerfPhase::Audit,
            Some(perf_context),
            || PerfEventDetails::stage(PerfStage::Enqueue),
        );
        crate::audit_sync::trigger_immediate_sync(app);
        if let Some(span) = enqueue_span {
            span.finish(PerfOutcome::Success, PerfEventDetails::default);
        }
    }
}

/// Read a row's full preimage as a column→string map, for building the inverse
/// INSERT of a delete. Columns are CAST to CHAR so every type decodes cleanly.
async fn fetch_preimage(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    database: &str,
    table: &str,
    columns: &[String],
    identity: &RowIdentity,
) -> Result<Option<HashMap<String, Option<String>>>, String> {
    if columns.is_empty() {
        return Ok(None);
    }
    let (where_sql, values) = crate::db::build_nullable_where(identity)?;
    let col_list = columns
        .iter()
        .map(|column| {
            format!(
                "CAST(`{}` AS CHAR) AS `{}`",
                escape_ident(column),
                escape_ident(column)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {} FROM `{}`.`{}` WHERE {} LIMIT 1 FOR UPDATE",
        col_list,
        escape_ident(database),
        escape_ident(table),
        where_sql
    );
    let mut query = sqlx::query(&sql);
    for value in values {
        query = query.bind(value);
    }
    let row = query
        .fetch_optional(&mut **tx)
        .await
        .map_err(|error| format!("读取前镜像失败: {error}"))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut map = HashMap::new();
    for (i, column) in columns.iter().enumerate() {
        let value = row
            .try_get::<Option<String>, _>(i)
            .map_err(|error| format!("读取删除前字段 {column} 失败: {error}"))?;
        map.insert(column.clone(), value);
    }
    Ok(Some(map))
}

fn emit_search_values_progress(
    window: &Window,
    job_id: &str,
    query: &str,
    database: &str,
    done: u64,
    total: u64,
    matches: u64,
    current_table: Option<String>,
    status: &str,
) {
    if job_id.trim().is_empty() {
        return;
    }
    let message = if let Some(table) = current_table.as_deref().filter(|value| !value.is_empty()) {
        format!("正在搜索 {table}")
    } else {
        format!("已扫描 {done}/{total} 张表")
    };
    let payload = SearchValuesProgress {
        job_id: job_id.into(),
        query: query.into(),
        database: database.into(),
        done,
        total,
        matches,
        current_table,
        message,
        status: status.into(),
    };
    let _ = window.emit(SEARCH_VALUES_PROGRESS_EVENT, payload);
}

pub(crate) fn demo_schema_for_runtime(
    overrides: &HashMap<String, Vec<TableMeta>>,
    profile: Option<DemoProfile>,
    database: &str,
    selected_database: &str,
    selected_schema: &[TableMeta],
) -> Vec<TableMeta> {
    if let Some(schema) = overrides.get(database) {
        return schema.clone();
    }
    if database == selected_database && !selected_schema.is_empty() {
        return selected_schema.to_vec();
    }
    match profile {
        Some(DemoProfile::Stress) => stress_schema_for(database),
        Some(DemoProfile::Performance(scenario)) if database == fixture_database() => {
            fixture_schema(&crate::perf_fixture::PerfFixtureSelection::for_scenario(
                scenario,
            ))
        }
        Some(DemoProfile::Performance(_)) => Vec::new(),
        None => Vec::new(),
    }
}

fn ensure_demo_rows_for_mutation<'a>(
    rows: &'a mut HashMap<String, Vec<HashMap<String, String>>>,
    profile: Option<DemoProfile>,
    database: &str,
    table: &TableMeta,
) -> &'a mut Vec<HashMap<String, String>> {
    let row_key = demo_row_key(database, &table.table_name);
    if !rows.contains_key(&row_key) {
        let generated = match profile {
            Some(DemoProfile::Stress) => materialize_stress_rows(table),
            Some(DemoProfile::Performance(_)) | None => Vec::new(),
        };
        rows.insert(row_key.clone(), generated);
    }
    rows.get_mut(&row_key).expect("demo rows were inserted")
}

#[tauri::command]
pub async fn list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<WorkbenchConnection>, String> {
    let connections = {
        let rt = state.runtime.lock().await;
        rt.connections.values().cloned().collect::<Vec<_>>()
    };
    let mut result = Vec::with_capacity(connections.len());
    for connection in connections {
        let mysql_pool_connected = state.resources.has_connection_pool(&connection.id).await;
        result.push(WorkbenchConnection {
            id: connection.id.clone(),
            kind: connection.kind,
            label: connection.label.clone(),
            host: connection.host.clone(),
            port: connection.port,
            username: connection.username.clone(),
            database: connection.database.clone(),
            connected: connection_connected(&connection, mysql_pool_connected),
            read_only: connection.kind.is_read_only(),
            sample_data: connection.kind == DatabaseKind::MySql && connection.mysql_url.is_none(),
        });
    }
    Ok(result)
}

async fn real_connection_pool(
    connection_id: &str,
    state: &State<'_, AppState>,
    perf_context: &PerfContext,
) -> Result<MySqlPool, String> {
    let span = state.perf.begin_span(
        "command.pool_resolve",
        PerfPhase::Pool,
        Some(perf_context),
        || PerfEventDetails::stage(PerfStage::Pool),
    );
    let result = async {
        let (kind, mysql_url) = {
            let rt = state.runtime.lock().await;
            let connection = rt
                .connections
                .get(connection_id)
                .ok_or_else(|| "连接不存在".to_string())?;
            (connection.kind, connection.mysql_url.clone())
        };
        if kind == DatabaseKind::MongoDb {
            return Err(kind.unsupported_feature("此操作"));
        }
        if kind != DatabaseKind::MySql {
            return Err(read_only_error(kind));
        }
        let Some(mysql_url) = mysql_url else {
            return Err("演示连接不支持数据库覆盖同步，请连接真实 MySQL 后重试".into());
        };
        state
            .resources
            .get_or_connect_server(ServerPoolKey::new(connection_id), move || async move {
                connect_database(&mysql_url, None).await
            })
            .await
    }
    .await;
    if let Some(span) = span {
        span.finish(
            if result.is_ok() {
                PerfOutcome::Success
            } else {
                PerfOutcome::Error
            },
            PerfEventDetails::default,
        );
    }
    result
}

pub(crate) async fn real_database_pool(
    connection_id: &str,
    database: &str,
    state: &State<'_, AppState>,
    perf_context: &PerfContext,
) -> Result<MySqlPool, String> {
    let span = state.perf.begin_span(
        "command.pool_resolve",
        PerfPhase::Pool,
        Some(perf_context),
        || PerfEventDetails::stage(PerfStage::Pool),
    );
    let result = async {
        let (kind, mysql_url) = {
            let rt = state.runtime.lock().await;
            let connection = rt
                .connections
                .get(connection_id)
                .ok_or_else(|| "连接不存在".to_string())?;
            (connection.kind, connection.mysql_url.clone())
        };
        if kind == DatabaseKind::MongoDb {
            return Err(kind.unsupported_feature("此操作"));
        }
        if kind != DatabaseKind::MySql {
            return Err(read_only_error(kind));
        }
        let mysql_url = mysql_url.ok_or_else(|| "演示连接不使用 MySQL 连接池".to_string())?;
        let key = PoolKey::new(connection_id, database);
        let database = key.database().to_string();
        state
            .resources
            .get_or_connect_database(key, move || async move {
                connect_database(&mysql_url, Some(&database)).await
            })
            .await
    }
    .await;
    if let Some(span) = span {
        span.finish(
            if result.is_ok() {
                PerfOutcome::Success
            } else {
                PerfOutcome::Error
            },
            PerfEventDetails::default,
        );
    }
    result
}

async fn session_database_pool(
    state: &State<'_, AppState>,
    session: &TableSession,
) -> Result<Option<MySqlPool>, String> {
    let Some(key) = session.pool_key.as_ref() else {
        return Ok(None);
    };
    state
        .resources
        .database_pool(key)
        .await
        .map(Some)
        .ok_or_else(|| "表会话的数据库连接已失效，请重新打开表".to_string())
}

fn table_names(schema: &[TableMeta]) -> Vec<String> {
    schema
        .iter()
        .map(|table| table.table_name.clone())
        .collect()
}

fn demo_row_count(
    database: &str,
    rows: &HashMap<String, Vec<HashMap<String, String>>>,
    table: &TableMeta,
) -> u64 {
    rows.get(&demo_row_key(database, &table.table_name))
        .map(|rows| rows.len() as u64)
        .unwrap_or_else(|| {
            if table.table_name.starts_with("db") {
                crate::demo::stress_total_rows(&table.table_name) as u64
            } else {
                0
            }
        })
}

fn preview_demo_database_sync(
    source_database: &str,
    target_database: &str,
    excluded_tables: Vec<String>,
    schemas: &mut HashMap<String, Vec<TableMeta>>,
    rows: &HashMap<String, Vec<HashMap<String, String>>>,
) -> Result<PreviewDatabaseSyncResponse, String> {
    sync::validate_database_pair(source_database, target_database)?;
    let source_schema = schemas
        .entry(source_database.to_string())
        .or_insert_with(|| stress_schema_for(source_database))
        .clone();
    let target_schema = schemas
        .entry(target_database.to_string())
        .or_insert_with(|| stress_schema_for(target_database))
        .clone();
    let row_counts = source_schema
        .iter()
        .map(|table| {
            (
                table.table_name.clone(),
                demo_row_count(source_database, rows, table),
            )
        })
        .collect::<HashMap<_, _>>();
    Ok(sync::compute_preview(
        table_names(&source_schema),
        table_names(&target_schema),
        excluded_tables,
        &row_counts,
    ))
}

fn materialized_demo_rows_for(
    database: &str,
    rows: &HashMap<String, Vec<HashMap<String, String>>>,
    table: &TableMeta,
) -> Vec<HashMap<String, String>> {
    rows.get(&demo_row_key(database, &table.table_name))
        .cloned()
        .unwrap_or_else(|| materialize_stress_rows(table))
}

fn execute_demo_database_sync<F>(
    request: &SyncDatabaseOverwriteRequest,
    schemas: &mut HashMap<String, Vec<TableMeta>>,
    rows: &mut HashMap<String, Vec<HashMap<String, String>>>,
    mut emit: F,
) -> Result<SyncDatabaseOverwriteResponse, String>
where
    F: FnMut(DatabaseSyncProgress),
{
    let preview = preview_demo_database_sync(
        &request.source_database,
        &request.target_database,
        request.excluded_tables.clone(),
        schemas,
        rows,
    )?;
    emit(sync::progress(
        &request.job_id,
        "copyData",
        "正在同步演示数据库",
        None,
        0,
        preview.included_tables.len() as u64,
        Some(0),
        Some(preview.estimated_rows),
        None,
        "running",
    ));

    let source_schema = schemas
        .get(&request.source_database)
        .cloned()
        .unwrap_or_else(|| stress_schema_for(&request.source_database));
    let target_schema = schemas
        .get(&request.target_database)
        .cloned()
        .unwrap_or_else(|| stress_schema_for(&request.target_database));
    let preserved = preview
        .preserved_target_tables
        .iter()
        .filter_map(|table_name| {
            target_schema
                .iter()
                .find(|table| table.table_name.eq_ignore_ascii_case(table_name))
                .cloned()
        })
        .collect::<Vec<_>>();
    let included_set: std::collections::HashSet<String> = preview
        .included_tables
        .iter()
        .map(|name| name.to_lowercase())
        .collect();
    let mut next_target_schema = Vec::new();
    let mut copied_tables = Vec::new();
    let mut copied_rows = 0_u64;
    let mut index = 0_usize;

    // Iterate over the source schema in its original (natural) order so that the
    // target schema preserves the same ordering after sync.
    for table in source_schema
        .iter()
        .filter(|t| included_set.contains(&t.table_name.to_lowercase()))
    {
        index += 1;
        let table = table.clone();
        let source_rows = materialized_demo_rows_for(&request.source_database, rows, &table);
        copied_rows = copied_rows.saturating_add(source_rows.len() as u64);
        rows.insert(
            demo_row_key(&request.target_database, &table.table_name),
            source_rows,
        );
        next_target_schema.push(table.clone());
        copied_tables.push(table.table_name.clone());
        emit(sync::progress(
            &request.job_id,
            "copyData",
            &format!("已同步演示表 {}", table.table_name),
            Some(table.table_name.clone()),
            index as u64,
            preview.included_tables.len() as u64,
            Some(copied_rows),
            Some(preview.estimated_rows),
            None,
            "running",
        ));
    }
    next_target_schema.extend(preserved);
    schemas.insert(request.target_database.clone(), next_target_schema);

    emit(sync::progress(
        &request.job_id,
        "verify",
        "正在逐表校验演示数据库结构和数据",
        None,
        copied_tables.len() as u64,
        copied_tables.len() as u64,
        Some(copied_rows),
        Some(copied_rows),
        None,
        "running",
    ));
    let success_message = if preview.excluded_tables.is_empty() {
        "演示数据库覆盖同步完成，一致性校验通过：目标库与源库的基础表结构和数据完全相同"
    } else {
        "演示数据库覆盖同步完成，一致性校验通过：所有未排除表与源库相同"
    };
    emit(sync::progress(
        &request.job_id,
        "completed",
        success_message,
        None,
        copied_tables.len() as u64,
        copied_tables.len() as u64,
        Some(copied_rows),
        Some(copied_rows),
        None,
        "succeeded",
    ));
    Ok(SyncDatabaseOverwriteResponse {
        job_id: request.job_id.clone(),
        status: "succeeded".into(),
        copied_tables,
        copied_rows,
        dropped_tables: preview.target_only_tables_to_drop,
        backup_snapshot_path: None,
        message: success_message.into(),
        warnings: preview.warnings,
    })
}

fn build_table_design_preview_request(
    request: Option<TableDesignPreviewRequest>,
    connection_id: Option<String>,
    database: Option<String>,
    table_name: Option<String>,
    draft: Option<TableDesignDraft>,
    validation_id: Option<String>,
) -> Result<TableDesignPreviewRequest, String> {
    if let Some(request) = request {
        return Ok(request);
    }
    Ok(TableDesignPreviewRequest {
        connection_id: connection_id.ok_or_else(|| "缺少连接 ID".to_string())?,
        database: database.ok_or_else(|| "缺少数据库".to_string())?,
        table_name: table_name.ok_or_else(|| "缺少表名".to_string())?,
        draft: draft.ok_or_else(|| "缺少表设计草案".to_string())?,
        validation_id,
    })
}

fn build_apply_table_design_request(
    request: Option<ApplyTableDesignRequest>,
    connection_id: Option<String>,
    database: Option<String>,
    table_name: Option<String>,
    draft: Option<TableDesignDraft>,
    schema_signature: Option<String>,
    source_signature: Option<String>,
    preview_signature: Option<String>,
) -> Result<ApplyTableDesignRequest, String> {
    if let Some(request) = request {
        return Ok(request);
    }
    Ok(ApplyTableDesignRequest {
        connection_id: connection_id.ok_or_else(|| "缺少连接 ID".to_string())?,
        database: database.ok_or_else(|| "缺少数据库".to_string())?,
        table_name: table_name.ok_or_else(|| "缺少表名".to_string())?,
        draft: draft.ok_or_else(|| "缺少表设计草案".to_string())?,
        schema_signature,
        source_signature,
        preview_signature,
    })
}

#[tauri::command]
pub async fn preview_database_sync(
    request: PreviewDatabaseSyncRequest,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<PreviewDatabaseSyncResponse, String> {
    let (kind, mysql_url, demo_profile, selected_database, selected_schema, overrides, rows) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.kind,
            connection.mysql_url.clone(),
            rt.demo_profile,
            rt.selected_database.clone(),
            rt.schema.clone(),
            rt.demo_schema_overrides.clone(),
            rt.demo_rows.clone(),
        )
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    reject_mongo(kind, "覆盖同步")?;
    if mysql_url.is_some() {
        let pool = real_connection_pool(&request.connection_id, &state, &perf_context).await?;
        return sync::preview_database_sync(
            &pool,
            &request.source_database,
            &request.target_database,
            request.excluded_tables,
        )
        .await;
    }
    if !matches!(demo_profile, Some(DemoProfile::Stress)) {
        return Err(no_demo_error());
    }
    let mut schemas = overrides;
    schemas
        .entry(request.source_database.clone())
        .or_insert_with(|| {
            demo_schema_for_runtime(
                &HashMap::new(),
                demo_profile,
                &request.source_database,
                &selected_database,
                &selected_schema,
            )
        });
    schemas
        .entry(request.target_database.clone())
        .or_insert_with(|| {
            demo_schema_for_runtime(
                &HashMap::new(),
                demo_profile,
                &request.target_database,
                &selected_database,
                &selected_schema,
            )
        });
    preview_demo_database_sync(
        &request.source_database,
        &request.target_database,
        request.excluded_tables,
        &mut schemas,
        &rows,
    )
}

#[tauri::command]
pub async fn sync_database_overwrite(
    app: AppHandle,
    window: Window,
    request: SyncDatabaseOverwriteRequest,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<SyncDatabaseOverwriteResponse, String> {
    let (kind, mysql_url, demo_profile) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.kind,
            connection.mysql_url.clone(),
            rt.demo_profile,
        )
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    reject_mongo(kind, "覆盖同步")?;
    let sync_job = state.database_sync_jobs.register(
        &request.job_id,
        &request.connection_id,
        &request.target_database,
    )?;
    let cancellation = sync_job.cancellation();
    if let Some(mysql_url) = mysql_url {
        let pool = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err("覆盖同步已停止".into()),
            result = real_connection_pool(&request.connection_id, &state, &perf_context) => result?,
        };
        let connection_id = request.connection_id.clone();
        let target_database = request.target_database.clone();
        let backup_config = backup::load_config(&app);
        let emit_cancellation = cancellation.clone();
        let result = sync::execute_database_sync(
            &app,
            &mysql_url,
            &backup_config,
            &pool,
            request,
            &cancellation,
            |payload| {
                if let Err(error) = window.emit(DATABASE_SYNC_PROGRESS_EVENT, payload) {
                    eprintln!("[database-sync] progress delivery failed: {error}");
                    emit_cancellation.cancel();
                }
            },
        )
        .await?;
        state
            .schema_cache
            .invalidate_database(&connection_id, &target_database);
        invalidate_database_count(&state, &connection_id, &target_database);
        crate::table_modified::record_local_change_owned(
            &app,
            &state,
            &connection_id,
            &target_database,
            &result.copied_tables,
        )
        .await;
        crate::table_modified::record_tables_dropped(
            &app,
            &state,
            &connection_id,
            &target_database,
            &result.dropped_tables,
        )
        .await;
        return Ok(result);
    }
    if !matches!(demo_profile, Some(DemoProfile::Stress)) {
        return Err(no_demo_error());
    }
    let mut rt = state.runtime.lock().await;
    let selected_database = rt.selected_database.clone();
    let selected_schema = rt.schema.clone();
    let mut schemas = rt.demo_schema_overrides.clone();
    schemas
        .entry(request.source_database.clone())
        .or_insert_with(|| {
            demo_schema_for_runtime(
                &HashMap::new(),
                demo_profile,
                &request.source_database,
                &selected_database,
                &selected_schema,
            )
        });
    schemas
        .entry(request.target_database.clone())
        .or_insert_with(|| {
            demo_schema_for_runtime(
                &HashMap::new(),
                demo_profile,
                &request.target_database,
                &selected_database,
                &selected_schema,
            )
        });
    let result =
        execute_demo_database_sync(&request, &mut schemas, &mut rt.demo_rows, |payload| {
            let _ = window.emit(DATABASE_SYNC_PROGRESS_EVENT, payload);
        })?;
    rt.demo_schema_overrides = schemas;
    if rt.selected_database == request.target_database {
        if let Some(schema) = rt.demo_schema_overrides.get(&request.target_database) {
            rt.schema = schema.clone();
        }
    }
    state
        .schema_cache
        .invalidate_database(&request.connection_id, &request.target_database);
    invalidate_database_count(&state, &request.connection_id, &request.target_database);
    Ok(result)
}

#[tauri::command]
pub fn cancel_database_sync(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<CancelDatabaseSyncResponse, String> {
    Ok(CancelDatabaseSyncResponse {
        cancelled: state.database_sync_jobs.cancel(job_id.trim()),
    })
}

#[tauri::command]
pub async fn copy_tables(
    request: CopyTablesRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CopyTablesResponse, String> {
    let (kind, target_kind, source_is_real, target_is_real) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.source_connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        let target_connection = rt
            .connections
            .get(&request.target_connection_id)
            .ok_or_else(|| "目标连接不存在".to_string())?;
        (
            connection.kind,
            target_connection.kind,
            connection.mysql_url.is_some(),
            target_connection.mysql_url.is_some(),
        )
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    if target_kind.is_read_only() {
        return Err(read_only_error(target_kind));
    }
    reject_mongo(kind, "表复制")?;
    reject_mongo(target_kind, "表复制")?;
    if source_is_real && target_is_real {
        let source_pool =
            real_connection_pool(&request.source_connection_id, &state, &perf_context).await?;
        let result = if request.source_connection_id == request.target_connection_id {
            table_copy::copy_tables_same_server(&source_pool, &request).await?
        } else {
            let target_pool =
                real_connection_pool(&request.target_connection_id, &state, &perf_context).await?;
            table_copy::copy_tables_cross_server(&source_pool, &target_pool, &request).await?
        };
        let copied_names: Vec<String> = result
            .copied
            .iter()
            .map(|table| table.target_name.clone())
            .collect();
        for table in &result.copied {
            invalidate_table_schema(
                &state,
                &request.target_connection_id,
                &request.target_database,
                &table.target_name,
            );
            invalidate_table_count(
                &state,
                &request.target_connection_id,
                &request.target_database,
                &table.target_name,
            );
        }
        crate::table_modified::record_local_change_owned(
            &app,
            &state,
            &request.target_connection_id,
            &request.target_database,
            &copied_names,
        )
        .await;
        return Ok(result);
    }
    if source_is_real != target_is_real {
        return Err("演示连接与真实 MySQL 之间不能复制表".into());
    }
    // Demo path
    let mut rt = state.runtime.lock().await;
    let selected_database = rt.selected_database.clone();
    let selected_schema = rt.schema.clone();
    let mut schemas = rt.demo_schema_overrides.clone();
    let source_schema = demo_schema_for_runtime(
        &schemas,
        rt.demo_profile,
        &request.source_database,
        &selected_database,
        &selected_schema,
    );
    schemas
        .entry(request.target_database.clone())
        .or_insert_with(|| {
            demo_schema_for_runtime(
                &HashMap::new(),
                rt.demo_profile,
                &request.target_database,
                &selected_database,
                &selected_schema,
            )
        });
    let target_schema = schemas
        .get_mut(&request.target_database)
        .ok_or_else(|| "目标数据库 schema 不可用".to_string())?;

    let mut copied = Vec::new();
    let warnings = Vec::new();
    let overwrite = crate::types::is_overwrite_copy_mode(&request.mode);

    for table_name in &request.table_names {
        let source_table = source_schema
            .iter()
            .find(|t| t.table_name.eq_ignore_ascii_case(table_name))
            .ok_or_else(|| format!("源表不存在: {table_name}"))?
            .clone();

        let target_name = if overwrite {
            // 覆盖模式：移除目标库同名表及其数据，用源表完全替换。
            if let Some(position) = target_schema
                .iter()
                .position(|t| t.table_name.eq_ignore_ascii_case(table_name))
            {
                let removed = target_schema.remove(position);
                rt.demo_rows
                    .remove(&demo_row_key(&request.target_database, &removed.table_name));
            }
            table_name.clone()
        } else {
            resolve_copy_table_name(target_schema, table_name)
        };
        let source_rows =
            materialized_demo_rows_for(&request.source_database, &rt.demo_rows, &source_table);
        let row_count = source_rows.len() as u64;
        rt.demo_rows.insert(
            demo_row_key(&request.target_database, &target_name),
            source_rows,
        );
        let mut new_table = source_table.clone();
        new_table.table_name = target_name.clone();
        target_schema.push(new_table);
        copied.push(CopyTablesResult {
            original_name: table_name.clone(),
            target_name,
            row_count,
        });
    }
    rt.demo_schema_overrides = schemas;
    if rt.selected_database == request.target_database {
        if let Some(schema) = rt.demo_schema_overrides.get(&request.target_database) {
            rt.schema = schema.clone();
        }
    }
    for table in &copied {
        invalidate_table_schema(
            &state,
            &request.target_connection_id,
            &request.target_database,
            &table.target_name,
        );
        invalidate_table_count(
            &state,
            &request.target_connection_id,
            &request.target_database,
            &table.target_name,
        );
    }
    Ok(CopyTablesResponse {
        status: "succeeded".into(),
        copied,
        warnings,
    })
}

#[tauri::command]
pub async fn rename_table(
    connection_id: String,
    database: String,
    table_name: String,
    new_name: String,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RenameTableResponse, String> {
    let (kind, mysql_url) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (connection.kind, connection.mysql_url.clone())
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    reject_mongo(kind, "重命名表")?;
    if mysql_url.is_some() {
        let pool = real_connection_pool(&connection_id, &state, &perf_context).await?;
        let sql = format!(
            "RENAME TABLE `{}`.`{}` TO `{}`.`{}`",
            database, table_name, database, new_name
        );
        let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
        let audit_id = best_effort_audit(
            &app,
            &state,
            &perf_context,
            audit::AuditContext {
                connection_id: connection_id.clone(),
                database: database.clone(),
                table_name: table_name.clone(),
                session_id: None,
                source: audit::SOURCE_DDL,
                actor,
                client_id,
            },
            audit::PendingAudit {
                operation: "DDL",
                column_name: None,
                old_value: Some(table_name.clone()),
                new_value: Some(new_name.clone()),
                row_identity: None,
                forward_sql: sql.clone(),
                forward_binds: Vec::new(),
                inverse_sql: None,
                inverse_binds: Vec::new(),
                rollback_strategy: audit::STRATEGY_DDL,
                notes: Some("结构变更，需通过快照还原".into()),
            },
        )
        .await;
        match sqlx::query(&sql).execute(&pool).await {
            Ok(_) => {
                mark_audit(&app, &state, &perf_context, audit_id, true).await;
                invalidate_renamed_schema(
                    &state,
                    &connection_id,
                    &database,
                    &table_name,
                    &new_name,
                );
                invalidate_renamed_count(&state, &connection_id, &database, &table_name, &new_name);
                crate::table_modified::record_table_renamed(
                    &app,
                    &state,
                    &connection_id,
                    &database,
                    &table_name,
                    &new_name,
                )
                .await;
                return Ok(RenameTableResponse {
                    renamed: true,
                    from: table_name,
                    to: new_name,
                });
            }
            Err(e) => {
                mark_audit(&app, &state, &perf_context, audit_id, false).await;
                return Err(format!("重命名失败: {e}"));
            }
        }
    }
    // Demo path
    let mut rt = state.runtime.lock().await;
    let mut schemas = rt
        .demo_schema_overrides
        .remove(&database)
        .unwrap_or_else(|| {
            demo_schema_for_runtime(
                &rt.demo_schema_overrides,
                rt.demo_profile,
                &database,
                &rt.selected_database,
                &rt.schema,
            )
        });
    let idx = schemas
        .iter()
        .position(|t| t.table_name.eq_ignore_ascii_case(&table_name))
        .ok_or_else(|| format!("表不存在: {}", table_name))?;
    if schemas.iter().any(|t| {
        t.table_name.eq_ignore_ascii_case(&new_name) && t.table_name != schemas[idx].table_name
    }) {
        return Err(format!("表名已存在: {}", new_name));
    }
    let old_key = demo_row_key(&database, &schemas[idx].table_name);
    let new_key = demo_row_key(&database, &new_name);
    if let Some(rows) = rt.demo_rows.remove(&old_key) {
        rt.demo_rows.insert(new_key, rows);
    }
    schemas[idx].table_name = new_name.clone();
    if rt.selected_database == database {
        rt.schema = schemas.clone();
    }
    rt.demo_schema_overrides.insert(database.clone(), schemas);
    invalidate_renamed_schema(&state, &connection_id, &database, &table_name, &new_name);
    invalidate_renamed_count(&state, &connection_id, &database, &table_name, &new_name);
    Ok(RenameTableResponse {
        renamed: true,
        from: table_name,
        to: new_name,
    })
}

fn resolve_copy_table_name(schema: &[TableMeta], base_name: &str) -> String {
    let exists = |candidate: &str| {
        schema
            .iter()
            .any(|t| t.table_name.eq_ignore_ascii_case(candidate))
    };
    if !exists(base_name) {
        return base_name.to_string();
    }
    let mut n = 1_u32;
    loop {
        let next = format!("{base_name}_copy{n}");
        if !exists(&next) {
            return next;
        }
        n = n.saturating_add(1);
    }
}

fn drop_result(table_name: impl Into<String>, reason: Option<String>) -> DropTablesResult {
    DropTablesResult {
        table_name: table_name.into(),
        reason,
    }
}

#[tauri::command]
pub async fn drop_tables(
    request: DropTablesRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DropTablesResponse, String> {
    let table_names = request
        .tables
        .iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    if table_names.is_empty() {
        return Err("请选择要删除的表".into());
    }

    let (kind, mysql_url) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (connection.kind, connection.mysql_url.clone())
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    reject_mongo(kind, "删除表")?;

    if mysql_url.is_some() {
        let pool = real_connection_pool(&request.connection_id, &state, &perf_context).await?;
        let result =
            drop_tables_mysql(&pool, &request, &table_names, &app, &state, &perf_context).await?;
        let dropped_names: Vec<String> = result
            .dropped
            .iter()
            .map(|table| table.table_name.clone())
            .collect();
        for table in &result.dropped {
            invalidate_table_schema(
                &state,
                &request.connection_id,
                &request.database,
                &table.table_name,
            );
            invalidate_table_count(
                &state,
                &request.connection_id,
                &request.database,
                &table.table_name,
            );
        }
        crate::table_modified::record_tables_dropped(
            &app,
            &state,
            &request.connection_id,
            &request.database,
            &dropped_names,
        )
        .await;
        return Ok(result);
    }

    let mut rt = state.runtime.lock().await;
    let mut schemas = rt
        .demo_schema_overrides
        .remove(&request.database)
        .unwrap_or_else(|| {
            demo_schema_for_runtime(
                &rt.demo_schema_overrides,
                rt.demo_profile,
                &request.database,
                &rt.selected_database,
                &rt.schema,
            )
        });
    let mut dropped = Vec::new();
    let mut failed = Vec::new();

    for table_name in table_names {
        if let Some(index) = schemas
            .iter()
            .position(|table| table.table_name.eq_ignore_ascii_case(&table_name))
        {
            let removed = schemas.remove(index);
            rt.demo_rows
                .remove(&demo_row_key(&request.database, &removed.table_name));
            dropped.push(drop_result(removed.table_name, None));
        } else {
            failed.push(drop_result(
                table_name,
                Some("表不存在，可能已被删除".into()),
            ));
        }
    }

    if rt.selected_database == request.database {
        rt.schema = schemas.clone();
    }
    rt.demo_schema_overrides
        .insert(request.database.clone(), schemas);
    for table in &dropped {
        invalidate_table_schema(
            &state,
            &request.connection_id,
            &request.database,
            &table.table_name,
        );
        invalidate_table_count(
            &state,
            &request.connection_id,
            &request.database,
            &table.table_name,
        );
    }
    Ok(DropTablesResponse { dropped, failed })
}

async fn drop_tables_mysql(
    pool: &sqlx::MySqlPool,
    request: &DropTablesRequest,
    table_names: &[String],
    app: &AppHandle,
    state: &State<'_, AppState>,
    perf_context: &PerfContext,
) -> Result<DropTablesResponse, String> {
    let mut dropped = Vec::new();
    let mut failed = Vec::new();

    for table_name in table_names {
        let sql = format!(
            "DROP TABLE IF EXISTS `{}`.`{}`",
            escape_ident(&request.database),
            escape_ident(table_name),
        );
        let (actor, client_id) = crate::account::audit_actor_and_id(app, state).await;
        let audit_id = best_effort_audit(
            app,
            state,
            perf_context,
            audit::AuditContext {
                connection_id: request.connection_id.clone(),
                database: request.database.clone(),
                table_name: table_name.clone(),
                session_id: None,
                source: audit::SOURCE_DDL,
                actor,
                client_id,
            },
            audit::PendingAudit {
                operation: "DDL",
                column_name: None,
                old_value: Some(table_name.clone()),
                new_value: None,
                row_identity: None,
                forward_sql: sql.clone(),
                forward_binds: Vec::new(),
                inverse_sql: None,
                inverse_binds: Vec::new(),
                rollback_strategy: audit::STRATEGY_DDL,
                notes: Some("删除表无法行级回滚，请通过快照恢复".into()),
            },
        )
        .await;
        match sqlx::query(&sql).execute(pool).await {
            Ok(_) => {
                mark_audit(app, state, perf_context, audit_id, true).await;
                dropped.push(drop_result(table_name.clone(), None));
            }
            Err(error) => {
                mark_audit(app, state, perf_context, audit_id, false).await;
                failed.push(drop_result(table_name.clone(), Some(error.to_string())));
            }
        }
    }

    Ok(DropTablesResponse { dropped, failed })
}

#[tauri::command]
pub async fn list_databases(
    connection_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let (connection_id, kind, mysql_url, clickhouse_url, mongodb_url, demo_profile) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection_id,
            connection.kind,
            connection.mysql_url.clone(),
            connection.clickhouse_url.clone(),
            connection.mongodb_url.clone(),
            rt.demo_profile,
        )
    };
    if let Some(url) = clickhouse_url.filter(|_| kind == DatabaseKind::ClickHouse) {
        return clickhouse::list_databases(&url).await;
    }
    if let Some(url) = mongodb_url.filter(|_| kind == DatabaseKind::MongoDb) {
        return mongodb::list_databases(&url).await;
    }
    let Some(_mysql_url) = mysql_url else {
        return Ok(match demo_profile {
            Some(DemoProfile::Stress) => stress_databases(&connection_id),
            Some(DemoProfile::Performance(_)) => vec![fixture_database().into()],
            None => Vec::new(),
        });
    };
    let pool = real_connection_pool(&connection_id, &state, &PerfContext::default()).await?;
    let rows = sqlx::query("SHOW DATABASES")
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("读取数据库失败: {error}"))?;
    Ok(rows
        .into_iter()
        .filter_map(|row| mysql_text::string(&row, 0).ok())
        .filter(|name| {
            !matches!(
                name.as_str(),
                "information_schema" | "mysql" | "performance_schema" | "sys"
            )
        })
        .collect())
}

fn select_demo_database(
    runtime: &mut RuntimeState,
    connection_id: &str,
    database: &str,
) -> Vec<TableOption> {
    let previous_database = runtime.selected_database.clone();
    let previous_schema = runtime.schema.clone();
    let next_schema = demo_schema_for_runtime(
        &runtime.demo_schema_overrides,
        runtime.demo_profile,
        database,
        &previous_database,
        &previous_schema,
    );

    runtime.selected_connection_id = connection_id.to_string();
    runtime.selected_database = database.to_string();
    if let Some(connection) = runtime.connections.get_mut(connection_id) {
        connection.database = Some(database.to_string());
    }
    runtime.schema = next_schema;
    runtime
        .schema
        .iter()
        .map(|table| TableOption {
            table_name: table.table_name.clone(),
            table_comment: table.table_comment.clone(),
            column_count: Some(table.columns.len() as u64),
            data_size_bytes: None,
            modified_at: None,
            modified_source: None,
            modified_actor: None,
        })
        .collect()
}

async fn overlay_mysql_tables_fast(
    app: &AppHandle,
    state: &AppState,
    server_key: &str,
    database: &str,
    tables: Vec<TableOption>,
) -> Vec<TableOption> {
    match audit::ensure_audit_pool(app, state).await {
        Ok(audit_pool) => crate::table_modified::overlay_saved_modified_times(
            &audit_pool,
            server_key,
            database,
            tables.clone(),
        )
        .await
        .unwrap_or(tables),
        Err(_) => tables,
    }
}

fn spawn_background_mysql_observation(
    app: AppHandle,
    connection_id: String,
    database: String,
    server_key: String,
    baseline: Vec<TableOption>,
    force: bool,
) {
    let state = app.state::<AppState>();
    if !state
        .table_modified
        .claim_db_observe(&server_key, &database, force)
    {
        crate::table_modified::spawn_background_shared_refresh(
            app,
            connection_id,
            database,
            server_key,
        );
        return;
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let Ok(pool) =
            real_database_pool(&connection_id, &database, &state, &PerfContext::default()).await
        else {
            return;
        };
        let Ok(observation) = run_pool_work(
            &state.work_scheduler,
            &PoolKey::new(&connection_id, &database),
            WorkClass::Background,
            BACKGROUND_SCHEMA_TIMEOUT,
            observe_tables_from_db(&pool, &database, &server_key, &state.table_modified),
        )
        .await
        else {
            return;
        };
        let fetch_shared = state
            .table_modified
            .claim_shared_fetch(&server_key, &database, force);
        let enriched = enrich_mysql_tables(
            &app,
            &state,
            &server_key,
            &connection_id,
            &database,
            observation,
            fetch_shared,
        )
        .await;
        crate::table_modified::emit_table_option_updates(
            &app,
            &connection_id,
            &database,
            &baseline,
            &enriched,
        );
    });
}

async fn enrich_mysql_tables(
    app: &AppHandle,
    state: &AppState,
    server_key: &str,
    connection_id: &str,
    database: &str,
    observation: crate::db::MysqlDatabaseObservation,
    fetch_shared_inline: bool,
) -> Vec<TableOption> {
    let shared_updates = if fetch_shared_inline {
        state
            .table_modified
            .claim_shared_fetch(server_key, database, true);
        crate::audit_sync::fetch_shared_table_latest(
            app,
            state,
            server_key,
            connection_id,
            database,
        )
        .await
    } else {
        Vec::new()
    };

    let fallback: Vec<TableOption> = observation
        .tables
        .iter()
        .map(|item| item.option.clone())
        .collect();

    let tables = match audit::ensure_audit_pool(app, state).await {
        Ok(audit_pool) => crate::table_modified::reconcile_mysql_observation(
            &audit_pool,
            server_key,
            connection_id,
            database,
            observation,
            &shared_updates,
            crate::table_modified::now_ms(),
        )
        .await
        .unwrap_or(fallback),
        Err(_) => fallback,
    };

    if !fetch_shared_inline {
        crate::table_modified::spawn_background_shared_refresh(
            app.clone(),
            connection_id.to_string(),
            database.to_string(),
            server_key.to_string(),
        );
    }
    tables
}

async fn enrich_generic_tables(
    app: &AppHandle,
    state: &AppState,
    server_key: &str,
    connection_id: &str,
    database: &str,
    tables: Vec<TableOption>,
    fetch_shared_inline: bool,
) -> Vec<TableOption> {
    let shared_updates = if fetch_shared_inline {
        state
            .table_modified
            .claim_shared_fetch(server_key, database, true);
        crate::audit_sync::fetch_shared_table_latest(
            app,
            state,
            server_key,
            connection_id,
            database,
        )
        .await
    } else {
        Vec::new()
    };

    let enriched = match audit::ensure_audit_pool(app, state).await {
        Ok(audit_pool) => crate::table_modified::reconcile_generic_tables(
            &audit_pool,
            server_key,
            connection_id,
            database,
            tables.clone(),
            &shared_updates,
            crate::table_modified::now_ms(),
        )
        .await
        .unwrap_or(tables),
        Err(_) => tables,
    };

    if !fetch_shared_inline {
        crate::table_modified::spawn_background_shared_refresh(
            app.clone(),
            connection_id.to_string(),
            database.to_string(),
            server_key.to_string(),
        );
    }
    enriched
}

#[tauri::command]
pub async fn select_database(
    connection_id: Option<String>,
    database: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SelectDatabaseResponse, String> {
    let (connection_id, kind, server_key, mysql_url, clickhouse_url, mongodb_url) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection_id,
            connection.kind,
            crate::table_modified::server_key_for_connection(connection),
            connection.mysql_url.clone(),
            connection.clickhouse_url.clone(),
            connection.mongodb_url.clone(),
        )
    };
    let tables = if let Some(url) = clickhouse_url.filter(|_| kind == DatabaseKind::ClickHouse) {
        let raw_tables = clickhouse::list_tables(&url, &database).await?;
        let tables = enrich_generic_tables(
            &app,
            &state,
            &server_key,
            &connection_id,
            &database,
            raw_tables,
            false,
        )
        .await;
        let mut rt = state.runtime.lock().await;
        rt.selected_connection_id = connection_id.clone();
        rt.selected_database = database.clone();
        if let Some(connection) = rt.connections.get_mut(&connection_id) {
            connection.database = Some(database.clone());
        }
        rt.schema = tables
            .iter()
            .map(|table| TableMeta {
                primary_key_order: Vec::new(),
                table_name: table.table_name.clone(),
                table_comment: table.table_comment.clone(),
                columns: Vec::new(),
            })
            .collect();
        tables
    } else if let Some(url) = mongodb_url.filter(|_| kind == DatabaseKind::MongoDb) {
        let raw_tables = mongodb::list_tables(&url, &database).await?;
        let tables = enrich_generic_tables(
            &app,
            &state,
            &server_key,
            &connection_id,
            &database,
            raw_tables,
            false,
        )
        .await;
        let mut rt = state.runtime.lock().await;
        rt.selected_connection_id = connection_id.clone();
        rt.selected_database = database.clone();
        if let Some(connection) = rt.connections.get_mut(&connection_id) {
            connection.database = Some(database.clone());
        }
        rt.schema = tables
            .iter()
            .map(|table| TableMeta {
                primary_key_order: Vec::new(),
                table_name: table.table_name.clone(),
                table_comment: table.table_comment.clone(),
                columns: Vec::new(),
            })
            .collect();
        tables
    } else if mysql_url.is_some() {
        let pool =
            real_database_pool(&connection_id, &database, &state, &PerfContext::default()).await?;
        let raw_tables = run_pool_work(
            &state.work_scheduler,
            &PoolKey::new(&connection_id, &database),
            WorkClass::Foreground,
            FOREGROUND_DB_TIMEOUT,
            list_tables_from_db(&pool, &database),
        )
        .await?;
        let tables = overlay_mysql_tables_fast(
            &app,
            &state,
            &server_key,
            &database,
            raw_tables,
        )
        .await;
        spawn_background_mysql_observation(
            app.clone(),
            connection_id.clone(),
            database.clone(),
            server_key.clone(),
            tables.clone(),
            false,
        );
        let mut rt = state.runtime.lock().await;
        rt.selected_connection_id = connection_id.clone();
        rt.selected_database = database.clone();
        if let Some(connection) = rt.connections.get_mut(&connection_id) {
            connection.database = Some(database.clone());
        }
        rt.schema = tables
            .iter()
            .map(|table| TableMeta {
                primary_key_order: Vec::new(),
                table_name: table.table_name.clone(),
                table_comment: table.table_comment.clone(),
                columns: Vec::new(),
            })
            .collect();
        tables
    } else {
        let mut rt = state.runtime.lock().await;
        select_demo_database(&mut rt, &connection_id, &database)
    };

    let rt = state.runtime.lock().await;
    Ok(SelectDatabaseResponse {
        table_count: tables.len() as u64,
        column_count: rt
            .schema
            .iter()
            .map(|table| table.columns.len() as u64)
            .sum(),
        tables,
    })
}

/// Table-list reads default to foreground priority. Periodic silent refreshes
/// pass `priority: "background"` so they share the bounded background budget
/// instead of a foreground permit.
fn table_list_work(priority: Option<&str>) -> (WorkClass, std::time::Duration) {
    match priority.map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("background") => {
            (WorkClass::Background, BACKGROUND_SCHEMA_TIMEOUT)
        }
        _ => (WorkClass::Foreground, FOREGROUND_DB_TIMEOUT),
    }
}

#[tauri::command]
pub async fn list_tables(
    connection_id: Option<String>,
    database: Option<String>,
    priority: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<TableOption>, String> {
    let (work_class, work_timeout) = table_list_work(priority.as_deref());
    let is_background = work_class == WorkClass::Background;
    let (
        connection_id,
        kind,
        server_key,
        mysql_url,
        clickhouse_url,
        mongodb_url,
        selected_database,
        schema,
        demo_profile,
        overrides,
    ) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection_id,
            connection.kind,
            crate::table_modified::server_key_for_connection(connection),
            connection.mysql_url.clone(),
            connection.clickhouse_url.clone(),
            connection.mongodb_url.clone(),
            connection
                .database
                .clone()
                .unwrap_or_else(|| rt.selected_database.clone()),
            rt.schema.clone(),
            rt.demo_profile,
            rt.demo_schema_overrides.clone(),
        )
    };
    let database = database.unwrap_or(selected_database);
    if let Some(url) = clickhouse_url.filter(|_| kind == DatabaseKind::ClickHouse) {
        let raw_tables = clickhouse::list_tables(&url, &database).await?;
        Ok(enrich_generic_tables(
            &app,
            &state,
            &server_key,
            &connection_id,
            &database,
            raw_tables,
            is_background,
        )
        .await)
    } else if let Some(url) = mongodb_url.filter(|_| kind == DatabaseKind::MongoDb) {
        let raw_tables = mongodb::list_tables(&url, &database).await?;
        Ok(enrich_generic_tables(
            &app,
            &state,
            &server_key,
            &connection_id,
            &database,
            raw_tables,
            is_background,
        )
        .await)
    } else if mysql_url.is_some() {
        let pool =
            real_database_pool(&connection_id, &database, &state, &PerfContext::default()).await?;
        if is_background {
            let observation = run_pool_work(
                &state.work_scheduler,
                &PoolKey::new(&connection_id, &database),
                work_class,
                work_timeout,
                observe_tables_from_db(&pool, &database, &server_key, &state.table_modified),
            )
            .await?;
            Ok(enrich_mysql_tables(
                &app,
                &state,
                &server_key,
                &connection_id,
                &database,
                observation,
                true,
            )
            .await)
        } else {
            let raw_tables = run_pool_work(
                &state.work_scheduler,
                &PoolKey::new(&connection_id, &database),
                work_class,
                work_timeout,
                list_tables_from_db(&pool, &database),
            )
            .await?;
            let tables = overlay_mysql_tables_fast(
                &app,
                &state,
                &server_key,
                &database,
                raw_tables,
            )
            .await;
            spawn_background_mysql_observation(
                app.clone(),
                connection_id.clone(),
                database.clone(),
                server_key.clone(),
                tables.clone(),
                true,
            );
            Ok(tables)
        }
    } else {
        Ok(
            demo_schema_for_runtime(&overrides, demo_profile, &database, &database, &schema)
                .into_iter()
                .map(|table| TableOption {
                    table_name: table.table_name,
                    table_comment: table.table_comment,
                    column_count: Some(table.columns.len() as u64),
                    data_size_bytes: None,
                    modified_at: None,
                    modified_source: None,
                    modified_actor: None,
                })
                .collect(),
        )
    }
}

#[derive(Clone)]
struct SchemaLoadContext {
    connection_id: String,
    kind: DatabaseKind,
    database: String,
    mysql_url: Option<String>,
    clickhouse_url: Option<String>,
    mongodb_url: Option<String>,
    demo_profile: Option<DemoProfile>,
    demo_schema: Vec<TableMeta>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SchemaCacheLoadMode {
    Coalesced,
    Foreground,
}

fn schema_work_class(mode: SchemaCacheLoadMode) -> WorkClass {
    match mode {
        SchemaCacheLoadMode::Coalesced => WorkClass::Background,
        SchemaCacheLoadMode::Foreground => WorkClass::Foreground,
    }
}

fn schema_work_timeout(mode: SchemaCacheLoadMode) -> std::time::Duration {
    match mode {
        SchemaCacheLoadMode::Coalesced => BACKGROUND_SCHEMA_TIMEOUT,
        SchemaCacheLoadMode::Foreground => FOREGROUND_DB_TIMEOUT,
    }
}

async fn load_schema_cache<F, Fut>(
    cache: &crate::schema_cache::SchemaCache,
    keys: &[crate::schema_cache::SchemaCacheKey],
    force: bool,
    mode: SchemaCacheLoadMode,
    loader: F,
) -> Result<Vec<crate::schema_cache::SchemaSnapshot>, String>
where
    F: Fn(Vec<crate::schema_cache::SchemaCacheKey>) -> Fut,
    Fut: Future<Output = Result<Vec<TableMeta>, String>>,
{
    match mode {
        SchemaCacheLoadMode::Coalesced => cache.get_or_load_many(keys, force, loader).await,
        SchemaCacheLoadMode::Foreground => {
            let key = keys.first().filter(|_| keys.len() == 1).ok_or_else(|| {
                "foreground schema loading requires exactly one table".to_string()
            })?;
            if force {
                cache.invalidate_table(key);
            }
            cache
                .get_or_load_foreground(key, loader)
                .await
                .map(|snapshot| vec![snapshot])
        }
    }
}

async fn resolve_schema_load_context(
    connection_id: Option<String>,
    database: Option<String>,
    state: &State<'_, AppState>,
) -> Result<SchemaLoadContext, String> {
    let rt = state.runtime.lock().await;
    let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
    let connection = rt
        .connections
        .get(&connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
    let database = database.unwrap_or_else(|| {
        connection
            .database
            .clone()
            .unwrap_or_else(|| rt.selected_database.clone())
    });
    let demo_schema = if connection.mysql_url.is_some()
        || connection.clickhouse_url.is_some()
        || connection.mongodb_url.is_some()
    {
        Vec::new()
    } else {
        demo_schema_for_runtime(
            &rt.demo_schema_overrides,
            rt.demo_profile,
            &database,
            &rt.selected_database,
            &rt.schema,
        )
    };
    Ok(SchemaLoadContext {
        connection_id,
        kind: connection.kind,
        database,
        mysql_url: connection.mysql_url.clone(),
        clickhouse_url: connection.clickhouse_url.clone(),
        mongodb_url: connection.mongodb_url.clone(),
        demo_profile: rt.demo_profile,
        demo_schema,
    })
}

async fn cached_schema_snapshots(
    context: &SchemaLoadContext,
    table_names: &[String],
    force: bool,
    mode: SchemaCacheLoadMode,
    perf_context: &PerfContext,
    state: &State<'_, AppState>,
) -> Result<Vec<crate::schema_cache::SchemaSnapshot>, String> {
    let keys = table_names
        .iter()
        .map(|table_name| {
            crate::schema_cache::SchemaCacheKey::new(
                &context.connection_id,
                &context.database,
                table_name,
            )
        })
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return Ok(Vec::new());
    }

    if let Some(url) = context
        .mongodb_url
        .as_ref()
        .filter(|_| context.kind == DatabaseKind::MongoDb)
    {
        let url = url.clone();
        let database = context.database.clone();
        let scheduler = state.work_scheduler.clone();
        let pool_key = PoolKey::new(&context.connection_id, &context.database);
        let class = schema_work_class(mode);
        let timeout = schema_work_timeout(mode);
        return load_schema_cache(&state.schema_cache, &keys, force, mode, {
            let url = url.clone();
            let database = database.clone();
            let scheduler = scheduler.clone();
            let pool_key = pool_key.clone();
            move |missing| {
                let url = url.clone();
                let database = database.clone();
                let scheduler = scheduler.clone();
                let pool_key = pool_key.clone();
                async move {
                    let table_names = missing
                        .into_iter()
                        .map(|key| key.table_name().to_string())
                        .collect::<Vec<_>>();
                    run_pool_work(
                        &scheduler,
                        &pool_key,
                        class,
                        timeout,
                        mongodb::read_schemas(&url, &database, &table_names),
                    )
                    .await
                }
            }
        })
        .await;
    }
    if let Some(url) = context
        .clickhouse_url
        .as_ref()
        .filter(|_| context.kind == DatabaseKind::ClickHouse)
    {
        let url = url.clone();
        let database = context.database.clone();
        let scheduler = state.work_scheduler.clone();
        let pool_key = PoolKey::new(&context.connection_id, &context.database);
        let class = schema_work_class(mode);
        let timeout = schema_work_timeout(mode);
        let snapshots = load_schema_cache(&state.schema_cache, &keys, force, mode, {
            let url = url.clone();
            let database = database.clone();
            let scheduler = scheduler.clone();
            let pool_key = pool_key.clone();
            move |missing| {
                let url = url.clone();
                let database = database.clone();
                let scheduler = scheduler.clone();
                let pool_key = pool_key.clone();
                async move {
                    let table_names = missing
                        .into_iter()
                        .map(|key| key.table_name().to_string())
                        .collect::<Vec<_>>();
                    run_pool_work(
                        &scheduler,
                        &pool_key,
                        class,
                        timeout,
                        clickhouse::read_schemas(&url, &database, &table_names),
                    )
                    .await
                }
            }
        })
        .await?;
        if mode == SchemaCacheLoadMode::Foreground {
            spawn_stale_clickhouse_schema_refresh(
                state.schema_cache.clone(),
                stale_schema_keys(&state.schema_cache, &keys, &snapshots),
                url,
                database,
                scheduler,
                pool_key,
            );
        }
        return Ok(snapshots);
    }
    if context.mysql_url.is_some() {
        let pool = real_database_pool(
            &context.connection_id,
            &context.database,
            state,
            perf_context,
        )
        .await?;
        let database = context.database.clone();
        let scheduler = state.work_scheduler.clone();
        let pool_key = PoolKey::new(&context.connection_id, &context.database);
        let class = schema_work_class(mode);
        let timeout = schema_work_timeout(mode);
        let snapshots = load_schema_cache(&state.schema_cache, &keys, force, mode, {
            let pool = pool.clone();
            let database = database.clone();
            let scheduler = scheduler.clone();
            let pool_key = pool_key.clone();
            move |missing| {
                let pool = pool.clone();
                let database = database.clone();
                let scheduler = scheduler.clone();
                let pool_key = pool_key.clone();
                async move {
                    let tables = schema_table_options(missing);
                    run_pool_work(
                        &scheduler,
                        &pool_key,
                        class,
                        timeout,
                        read_schemas_for_tables(&pool, &database, &tables),
                    )
                    .await
                }
            }
        })
        .await?;
        if mode == SchemaCacheLoadMode::Foreground {
            spawn_stale_mysql_schema_refresh(
                state.schema_cache.clone(),
                stale_schema_keys(&state.schema_cache, &keys, &snapshots),
                pool,
                database,
                scheduler,
                pool_key,
            );
        }
        return Ok(snapshots);
    }
    if context.demo_profile.is_some() {
        let schema = context.demo_schema.clone();
        let snapshots = load_schema_cache(&state.schema_cache, &keys, force, mode, {
            let schema = schema.clone();
            move |missing| {
                let schema = schema.clone();
                async move {
                    missing
                        .into_iter()
                        .map(|key| resolve_demo_table(key.table_name(), &schema))
                        .collect()
                }
            }
        })
        .await?;
        if mode == SchemaCacheLoadMode::Foreground {
            spawn_stale_demo_schema_refresh(
                state.schema_cache.clone(),
                stale_schema_keys(&state.schema_cache, &keys, &snapshots),
                schema,
            );
        }
        return Ok(snapshots);
    }
    Err(no_demo_error())
}

fn spawn_stale_mysql_schema_refresh(
    cache: crate::schema_cache::SchemaCache,
    stale_keys: Vec<crate::schema_cache::SchemaCacheKey>,
    pool: MySqlPool,
    database: String,
    scheduler: crate::work_scheduler::WorkScheduler,
    pool_key: PoolKey,
) {
    if stale_keys.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _ = cache
            .get_or_load_many(&stale_keys, false, move |missing| {
                let pool = pool.clone();
                let database = database.clone();
                let scheduler = scheduler.clone();
                let pool_key = pool_key.clone();
                async move {
                    let tables = schema_table_options(missing);
                    run_pool_work(
                        &scheduler,
                        &pool_key,
                        WorkClass::Background,
                        BACKGROUND_SCHEMA_TIMEOUT,
                        read_schemas_for_tables(&pool, &database, &tables),
                    )
                    .await
                }
            })
            .await;
    });
}

fn spawn_stale_clickhouse_schema_refresh(
    cache: crate::schema_cache::SchemaCache,
    stale_keys: Vec<crate::schema_cache::SchemaCacheKey>,
    url: String,
    database: String,
    scheduler: crate::work_scheduler::WorkScheduler,
    pool_key: PoolKey,
) {
    if stale_keys.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _ = cache
            .get_or_load_many(&stale_keys, false, move |missing| {
                let url = url.clone();
                let database = database.clone();
                let scheduler = scheduler.clone();
                let pool_key = pool_key.clone();
                async move {
                    let table_names = missing
                        .into_iter()
                        .map(|key| key.table_name().to_string())
                        .collect::<Vec<_>>();
                    run_pool_work(
                        &scheduler,
                        &pool_key,
                        WorkClass::Background,
                        BACKGROUND_SCHEMA_TIMEOUT,
                        clickhouse::read_schemas(&url, &database, &table_names),
                    )
                    .await
                }
            })
            .await;
    });
}

fn spawn_stale_demo_schema_refresh(
    cache: crate::schema_cache::SchemaCache,
    stale_keys: Vec<crate::schema_cache::SchemaCacheKey>,
    schema: Vec<TableMeta>,
) {
    if stale_keys.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _ = cache
            .get_or_load_many(&stale_keys, false, move |missing| {
                let schema = schema.clone();
                async move {
                    missing
                        .into_iter()
                        .map(|key| resolve_demo_table(key.table_name(), &schema))
                        .collect()
                }
            })
            .await;
    });
}

#[tauri::command]
pub async fn get_table_schemas(
    connection_id: Option<String>,
    database: Option<String>,
    table_names: Vec<String>,
    force: Option<bool>,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<Vec<TableMeta>, String> {
    let context = resolve_schema_load_context(connection_id, database, &state).await?;
    // A user refresh must not join speculative metadata work or reuse its stale result.
    let mode = if force == Some(true) && table_names.len() == 1 {
        SchemaCacheLoadMode::Foreground
    } else {
        SchemaCacheLoadMode::Coalesced
    };
    record_perf_result(
        &state.perf,
        &perf_context,
        "command.schema_fetch",
        PerfPhase::Schema,
        PerfStage::Schema,
        async {
            Ok(cached_schema_snapshots(
                &context,
                &table_names,
                force.unwrap_or(false),
                mode,
                &perf_context,
                &state,
            )
            .await?
            .into_iter()
            .map(|snapshot| snapshot.schema().as_ref().clone())
            .collect())
        },
    )
    .await
}

#[tauri::command]
pub async fn get_table_schema(
    connection_id: Option<String>,
    database: Option<String>,
    table_name: String,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<TableMeta, String> {
    get_table_schemas(
        connection_id,
        database,
        vec![table_name],
        Some(false),
        perf_context,
        state,
    )
    .await?
    .into_iter()
    .next()
    .ok_or_else(|| "schema loader returned no table".into())
}

fn parse_demo_column_type(column_type: &str) -> (String, Option<u64>, Option<u64>) {
    let raw = column_type.trim();
    let data_type = crate::mysql_column_types::normalize_data_type(raw);
    if let Some(open) = raw.find('(') {
        if let Some(close) = raw[open + 1..].find(')').map(|offset| open + 1 + offset) {
            let inner = &raw[open + 1..close];
            let mut parts = inner.split(',').map(|part| part.trim().parse::<u64>().ok());
            return (data_type, parts.next().flatten(), parts.next().flatten());
        }
    }
    (data_type, None, None)
}

fn demo_column_design(
    column: &ColumnMeta,
    ordinal: u32,
    primary_key_ordinal: Option<u32>,
) -> ColumnDesignMeta {
    let (data_type, length, scale) = parse_demo_column_type(&column.column_type);
    let is_supported = supports_table_design(&data_type);
    ColumnDesignMeta {
        ordinal,
        column_name: column.column_name.clone(),
        column_type: column.column_type.clone(),
        data_type: data_type.clone(),
        length,
        scale,
        is_nullable: column.is_nullable,
        is_primary_key: column.is_primary_key,
        primary_key_ordinal,
        default_mode: "none".into(),
        default_value: None,
        column_comment: column.column_comment.clone(),
        extra: String::new(),
        generation_expression: None,
        is_generated: false,
        is_supported,
        unsupported_reason: if is_supported {
            None
        } else {
            Some(format!("unsupported column type: {data_type}"))
        },
    }
}

fn demo_table_design_from_schema(
    connection_id: &str,
    database: &str,
    table_name: &str,
    schema: &[TableMeta],
) -> Result<TableDesignMeta, String> {
    let table = resolve_demo_table(table_name, schema)?;
    let mut design = TableDesignMeta {
        source: TableDesignSource {
            connection_id: connection_id.into(),
            database: database.into(),
            table_name: table.table_name.clone(),
        },
        table_name: table.table_name.clone(),
        table_comment: table.table_comment.clone(),
        schema_signature: None,
        columns: {
            let mut next_primary_key_ordinal = 1;
            table
                .columns
                .iter()
                .enumerate()
                .map(|(index, column)| {
                    let pk_ordinal = column.is_primary_key.then(|| {
                        let value = next_primary_key_ordinal;
                        next_primary_key_ordinal += 1;
                        value
                    });
                    demo_column_design(column, index as u32 + 1, pk_ordinal)
                })
                .collect()
        },
    };
    design.schema_signature = Some(crate::ddl::schema_signature(&design));
    Ok(design)
}

fn draft_column_type(column: &ColumnDesignDraft) -> Result<String, String> {
    crate::ddl::column_type_sql(column)
}

fn demo_column_from_draft(column: &ColumnDesignDraft) -> Result<ColumnMeta, String> {
    let column_type = draft_column_type(column)?;
    let mut meta = ColumnMeta::with_basic(
        column.name.clone(),
        column_type,
        column.comment.clone(),
        column.primary_key,
        if column.primary_key {
            false
        } else {
            column.nullable
        },
    );
    meta.default_value = column.default_value.clone();
    meta.default_mode = Some(column.default_mode.clone());
    Ok(meta)
}

fn demo_row_default_value(column: &ColumnDesignDraft) -> String {
    match column.default_mode.to_ascii_lowercase().as_str() {
        "value" | "expression" => column.default_value.clone().unwrap_or_default(),
        _ => String::new(),
    }
}

fn update_demo_rows_for_renames(
    rows: &mut HashMap<String, Vec<HashMap<String, String>>>,
    table_name: &str,
    renames: &[(String, String)],
) {
    if renames.is_empty() {
        return;
    }
    let Some(table_rows) = rows.get_mut(table_name) else {
        return;
    };
    for row in table_rows {
        let original = row.clone();
        for (old_name, _) in renames {
            row.remove(old_name);
        }
        for (old_name, new_name) in renames {
            if let Some(value) = original.get(old_name) {
                row.insert(new_name.clone(), value.clone());
            }
        }
    }
}

fn update_demo_rows_for_removed_columns(
    rows: &mut HashMap<String, Vec<HashMap<String, String>>>,
    table_name: &str,
    removed_columns: &[String],
) {
    if removed_columns.is_empty() {
        return;
    }
    let Some(table_rows) = rows.get_mut(table_name) else {
        return;
    };
    for row in table_rows {
        for column_name in removed_columns {
            row.remove(column_name);
        }
    }
}

fn apply_demo_table_design_change(
    schema: &mut Vec<TableMeta>,
    rows: &mut HashMap<String, Vec<HashMap<String, String>>>,
    request: ApplyTableDesignRequest,
    demo_profile: Option<DemoProfile>,
) -> Result<ApplyTableDesignResult, String> {
    let current = demo_table_design_from_schema(
        &request.connection_id,
        &request.database,
        &request.table_name,
        schema,
    )?;
    let mut preview = crate::ddl::verify_table_design_apply(&current, &request)?;
    let row_key = demo_row_key(&request.database, &request.table_name);
    let generated_rows = if rows.contains_key(&row_key) {
        None
    } else if matches!(demo_profile, Some(DemoProfile::Stress)) {
        schema
            .iter()
            .find(|table| table.table_name.eq_ignore_ascii_case(&request.table_name))
            .map(materialize_stress_rows)
    } else if matches!(demo_profile, Some(DemoProfile::Performance(_))) {
        Some(Vec::new())
    } else {
        None
    };
    let row_snapshot = rows
        .get(&row_key)
        .map(Vec::as_slice)
        .or(generated_rows.as_deref());
    let conflicts = crate::table_design_validation::validate_optional_materialized_rows(
        &current,
        &request.draft,
        row_snapshot,
    )?;
    if !conflicts.is_empty() {
        return Err(crate::table_design_validation::blocking_conflict_message(
            &conflicts,
        ));
    }
    preview.conflicts = conflicts;
    let mut renames = Vec::new();
    let mut added_columns = Vec::new();
    let table = schema
        .iter_mut()
        .find(|table| table.table_name.eq_ignore_ascii_case(&request.table_name))
        .ok_or_else(|| format!("表不存在: {}", request.table_name))?;
    let table_before_apply = table.clone();
    table.table_comment = request.draft.table_comment.clone();
    let existing_columns = table
        .columns
        .iter()
        .map(|column| (column.column_name.to_ascii_lowercase(), column.clone()))
        .collect::<HashMap<_, _>>();
    let retained_originals = request
        .draft
        .columns
        .iter()
        .filter_map(|column| {
            let original = column.original_name.trim();
            (!original.is_empty()).then(|| original.to_ascii_lowercase())
        })
        .collect::<HashSet<_>>();
    let removed_columns = table
        .columns
        .iter()
        .filter(|column| !retained_originals.contains(&column.column_name.to_ascii_lowercase()))
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    let mut next_columns = Vec::with_capacity(request.draft.columns.len());
    for draft in &request.draft.columns {
        if draft.original_name.trim().is_empty() {
            added_columns.push((draft.name.clone(), demo_row_default_value(draft)));
            next_columns.push(demo_column_from_draft(draft)?);
            continue;
        }
        let mut column = existing_columns
            .get(&draft.original_name.to_ascii_lowercase())
            .cloned()
            .ok_or_else(|| format!("unknown original column: {}", draft.original_name))?;
        if column.column_name != draft.name {
            renames.push((column.column_name.clone(), draft.name.clone()));
        }
        column.column_name = draft.name.clone();
        let current_column = current.columns.iter()
            .find(|current| current.column_name.eq_ignore_ascii_case(&draft.original_name))
            .ok_or_else(|| format!("unknown original column: {}", draft.original_name))?;
        column.column_type = crate::ddl::column_type_definition_sql(draft, current_column)?;
        column.is_unsigned = column.column_type.to_ascii_lowercase().contains("unsigned");
        column.column_comment = draft.comment.clone();
        column.is_primary_key = draft.primary_key;
        column.is_nullable = if draft.primary_key {
            false
        } else {
            draft.nullable
        };
        column.default_value = draft.default_value.clone();
        column.default_mode = Some(draft.default_mode.clone());
        next_columns.push(column);
    }
    table.columns = next_columns;
    if matches!(demo_profile, Some(DemoProfile::Stress))
        && (!renames.is_empty() || !added_columns.is_empty() || !removed_columns.is_empty())
        && !rows.contains_key(&demo_row_key(&request.database, &request.table_name))
    {
        rows.insert(
            demo_row_key(&request.database, &request.table_name),
            materialize_stress_rows(&table_before_apply),
        );
    }
    update_demo_rows_for_renames(
        rows,
        &demo_row_key(&request.database, &request.table_name),
        &renames,
    );
    update_demo_rows_for_removed_columns(
        rows,
        &demo_row_key(&request.database, &request.table_name),
        &removed_columns,
    );
    if !added_columns.is_empty() {
        if let Some(table_rows) =
            rows.get_mut(&demo_row_key(&request.database, &request.table_name))
        {
            for row in table_rows {
                for (name, default_value) in &added_columns {
                    row.entry(name.clone())
                        .or_insert_with(|| default_value.clone());
                }
            }
        }
    }
    let schema_design = demo_table_design_from_schema(
        &request.connection_id,
        &request.database,
        &request.table_name,
        schema,
    )?;
    Ok(ApplyTableDesignResult {
        applied: preview.has_changes,
        schema: schema_design,
        statements: preview.statements,
        warnings: preview.warnings,
        preview_signature: preview.preview_signature,
        schema_signature: preview.schema_signature,
    })
}

#[tauri::command]
pub async fn get_table_design(
    connection_id: Option<String>,
    database: Option<String>,
    table_name: String,
    state: State<'_, AppState>,
) -> Result<TableDesignMeta, String> {
    let (
        connection_id,
        kind,
        mysql_url,
        database,
        schema,
        demo_profile,
        overrides,
        selected_database,
    ) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection_id,
            connection.kind,
            connection.mysql_url.clone(),
            database.unwrap_or_else(|| {
                connection
                    .database
                    .clone()
                    .unwrap_or_else(|| rt.selected_database.clone())
            }),
            rt.schema.clone(),
            rt.demo_profile,
            rt.demo_schema_overrides.clone(),
            rt.selected_database.clone(),
        )
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    reject_mongo(kind, "表设计")?;
    if mysql_url.is_some() {
        let pool =
            real_database_pool(&connection_id, &database, &state, &PerfContext::default()).await?;
        read_table_design(&pool, &database, &table_name, &connection_id).await
    } else {
        let demo_schema = demo_schema_for_runtime(
            &overrides,
            demo_profile,
            &database,
            &selected_database,
            &schema,
        );
        demo_table_design_from_schema(&connection_id, &database, &table_name, &demo_schema)
    }
}

#[tauri::command]
pub async fn preview_table_design_change(
    request: Option<TableDesignPreviewRequest>,
    connection_id: Option<String>,
    database: Option<String>,
    table_name: Option<String>,
    draft: Option<TableDesignDraft>,
    validation_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<TableDesignPreview, String> {
    let request = build_table_design_preview_request(
        request,
        connection_id,
        database,
        table_name,
        draft,
        validation_id,
    )?;
    let (kind, mysql_url, schema, demo_profile, overrides, selected_database) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.kind,
            connection.mysql_url.clone(),
            rt.schema.clone(),
            rt.demo_profile,
            rt.demo_schema_overrides.clone(),
            rt.selected_database.clone(),
        )
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    reject_mongo(kind, "表设计")?;
    if mysql_url.is_some() {
        let pool = real_database_pool(
            &request.connection_id,
            &request.database,
            &state,
            &PerfContext::default(),
        )
        .await?;
        let current = read_table_design(
            &pool,
            &request.database,
            &request.table_name,
            &request.connection_id,
        )
        .await?;
        let mut preview = crate::ddl::preview_table_design_change(&current, &request.draft)?;
        let validation = crate::table_design_validation::validate_mysql_rows(
            &pool,
            &current,
            &request.draft,
            request.validation_id.as_deref(),
        )
        .await?;
        preview.conflicts = validation.conflicts;
        preview.warnings.extend(validation.warnings);
        return Ok(preview);
    }

    let schema = demo_schema_for_runtime(
        &overrides,
        demo_profile,
        &request.database,
        &selected_database,
        &schema,
    );
    let current = demo_table_design_from_schema(
        &request.connection_id,
        &request.database,
        &request.table_name,
        &schema,
    )?;
    let (row_snapshot, fallback_rows) = {
        let rt = state.runtime.lock().await;
        let row_snapshot = rt
            .demo_rows
            .get(&demo_row_key(&request.database, &request.table_name))
            .cloned();
        let fallback_rows = match demo_profile {
            Some(DemoProfile::Stress) => schema
                .iter()
                .find(|table| table.table_name.eq_ignore_ascii_case(&request.table_name))
                .map(materialize_stress_rows),
            Some(DemoProfile::Performance(_)) => Some(Vec::new()),
            None => None,
        };
        (row_snapshot, fallback_rows)
    };
    let mut preview = crate::ddl::preview_table_design_change(&current, &request.draft)?;
    preview.conflicts = crate::table_design_validation::validate_optional_materialized_rows(
        &current,
        &request.draft,
        row_snapshot.as_deref().or(fallback_rows.as_deref()),
    )?;
    Ok(preview)
}

#[tauri::command]
pub async fn cancel_table_design_validation(validation_id: String) -> Result<bool, String> {
    if validation_id.trim().is_empty() {
        return Ok(false);
    }
    Ok(crate::table_design_validation::cancel_validation(&validation_id).await)
}

#[tauri::command]
pub async fn apply_table_design_change(
    request: Option<ApplyTableDesignRequest>,
    connection_id: Option<String>,
    database: Option<String>,
    table_name: Option<String>,
    draft: Option<TableDesignDraft>,
    schema_signature: Option<String>,
    source_signature: Option<String>,
    preview_signature: Option<String>,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ApplyTableDesignResult, String> {
    let request = build_apply_table_design_request(
        request,
        connection_id,
        database,
        table_name,
        draft,
        schema_signature,
        source_signature,
        preview_signature,
    )?;
    let (kind, mysql_url) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (connection.kind, connection.mysql_url.clone())
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    reject_mongo(kind, "表设计")?;
    if mysql_url.is_some() {
        let pool = real_database_pool(
            &request.connection_id,
            &request.database,
            &state,
            &PerfContext::default(),
        )
        .await?;
        let current = read_table_design(
            &pool,
            &request.database,
            &request.table_name,
            &request.connection_id,
        )
        .await?;
        let preview = crate::ddl::verify_table_design_apply(&current, &request)?;
        // Record the DDL change (statements joined) as a manual-rollback audit row
        // for traceability. ALTER inverses are not generally constructible, so
        // recovery is via the snapshot layer.
        let forward_sql = preview.statements.join(";\n");
        let change_details = serde_json::to_string(&preview.human_descriptions).ok();
        let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
        let audit_id = best_effort_audit(
            &app,
            &state,
            &perf_context,
            audit::AuditContext {
                connection_id: request.connection_id.clone(),
                database: request.database.clone(),
                table_name: request.table_name.clone(),
                session_id: None,
                source: audit::SOURCE_DDL,
                actor,
                client_id,
            },
            audit::PendingAudit {
                operation: "DDL",
                column_name: None,
                old_value: None,
                new_value: change_details,
                row_identity: None,
                forward_sql,
                forward_binds: Vec::new(),
                inverse_sql: None,
                inverse_binds: Vec::new(),
                rollback_strategy: audit::STRATEGY_DDL,
                notes: Some("结构变更，需通过快照还原".into()),
            },
        )
        .await;
        if let Err(error) =
            crate::table_design_validation::execute_mysql_ddl_strict(&pool, &preview.statements)
                .await
        {
            mark_audit(&app, &state, &perf_context, audit_id, false).await;
            return Err(error);
        }
        mark_audit(&app, &state, &perf_context, audit_id, true).await;
        let schema = read_table_design(
            &pool,
            &request.database,
            &request.table_name,
            &request.connection_id,
        )
        .await?;
        if preview.has_changes {
            invalidate_table_schema(
                &state,
                &request.connection_id,
                &request.database,
                &request.table_name,
            );
            invalidate_table_count(
                &state,
                &request.connection_id,
                &request.database,
                &request.table_name,
            );
            crate::table_modified::record_local_change(
                &app,
                &state,
                &request.connection_id,
                &request.database,
                &[request.table_name.as_str()],
            )
            .await;
        }
        return Ok(ApplyTableDesignResult {
            applied: preview.has_changes,
            schema,
            statements: preview.statements,
            warnings: preview.warnings,
            preview_signature: preview.preview_signature,
            schema_signature: preview.schema_signature,
        });
    }

    let mut rt = state.runtime.lock().await;
    let mut rows = std::mem::take(&mut rt.demo_rows);
    let demo_profile = rt.demo_profile;
    let selected_database = rt.selected_database.clone();
    let mut schema = demo_schema_for_runtime(
        &rt.demo_schema_overrides,
        demo_profile,
        &request.database,
        &selected_database,
        &rt.schema,
    );
    let result =
        apply_demo_table_design_change(&mut schema, &mut rows, request.clone(), demo_profile);
    if result.is_ok() {
        rt.demo_schema_overrides
            .insert(request.database.clone(), schema.clone());
        if request.database == selected_database {
            rt.schema = schema;
        }
    }
    rt.demo_rows = rows;
    if result.as_ref().is_ok_and(|result| result.applied) {
        invalidate_table_schema(
            &state,
            &request.connection_id,
            &request.database,
            &request.table_name,
        );
        invalidate_table_count(
            &state,
            &request.connection_id,
            &request.database,
            &request.table_name,
        );
    }
    result
}

fn open_session_for_live_connection(
    runtime: &mut RuntimeState,
    connection_id: &str,
    session: TableSession,
    schema: Option<crate::schema_cache::SchemaSnapshot>,
) -> Result<(String, crate::table_sessions::TableSessionLease), String> {
    if !runtime.connections.contains_key(connection_id) {
        return Err("连接不存在".into());
    }
    match schema {
        Some(schema) => runtime.sessions.open_leased_with_schema(session, schema),
        None => runtime.sessions.open_leased(session),
    }
}

async fn fresh_session_schema(
    session_id: &str,
    session: &crate::table_sessions::TableSessionLease,
    perf_context: &PerfContext,
    state: &State<'_, AppState>,
) -> Result<crate::schema_cache::SchemaSnapshot, String> {
    let key = crate::schema_cache::SchemaCacheKey::new(
        &session.connection_id,
        &session.database,
        &session.table_name,
    );
    let current = session.schema_snapshot().clone();
    if state.schema_cache.is_fresh(&key, &current) {
        return Ok(current);
    }
    let context = resolve_schema_load_context(
        Some(session.connection_id.clone()),
        Some(session.database.clone()),
        state,
    )
    .await?;
    let refreshed = cached_schema_snapshots(
        &context,
        std::slice::from_ref(&session.table_name),
        false,
        SchemaCacheLoadMode::Foreground,
        perf_context,
        state,
    )
    .await?
    .into_iter()
    .next()
    .ok_or_else(|| "schema loader returned no table".to_string())?;
    state
        .runtime
        .lock()
        .await
        .sessions
        .update_schema(session_id, refreshed.clone());
    Ok(refreshed)
}

#[tauri::command]
pub async fn open_table_session(
    connection_id: Option<String>,
    database: Option<String>,
    table_name: String,
    options: Option<TablePageRequest>,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<PerfResponse<TableSessionPage>, String> {
    let request = options.unwrap_or_default();
    let requested_table_name = table_name.clone();
    let (
        connection_id,
        kind,
        database,
        mysql_url,
        clickhouse_url,
        mongodb_url,
        schema,
        demo_profile,
        materialized_rows,
    ) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        let database = database.unwrap_or_else(|| {
            connection
                .database
                .clone()
                .unwrap_or_else(|| rt.selected_database.clone())
        });
        let schema = if connection.mysql_url.is_some()
            || connection.clickhouse_url.is_some()
            || connection.mongodb_url.is_some()
        {
            Vec::new()
        } else {
            demo_schema_for_runtime(
                &rt.demo_schema_overrides,
                rt.demo_profile,
                &database,
                &rt.selected_database,
                &rt.schema,
            )
        };
        let row_key = demo_row_key(&database, &requested_table_name);
        (
            connection_id,
            connection.kind,
            database,
            connection.mysql_url.clone(),
            connection.clickhouse_url.clone(),
            connection.mongodb_url.clone(),
            schema,
            rt.demo_profile,
            rt.demo_rows.get(&row_key).cloned(),
        )
    };
    let schema_context = SchemaLoadContext {
        connection_id: connection_id.clone(),
        kind,
        database: database.clone(),
        mysql_url: mysql_url.clone(),
        clickhouse_url: clickhouse_url.clone(),
        mongodb_url: mongodb_url.clone(),
        demo_profile,
        demo_schema: schema,
    };
    let pool = match (kind, mysql_url) {
        (DatabaseKind::MySql, Some(_)) => {
            Some(real_database_pool(&connection_id, &database, &state, &perf_context).await?)
        }
        _ => None,
    };
    let schema_snapshot = record_perf_result(
        &state.perf,
        &perf_context,
        "command.schema_fetch",
        PerfPhase::Schema,
        PerfStage::Schema,
        async {
            cached_schema_snapshots(
                &schema_context,
                std::slice::from_ref(&table_name),
                false,
                SchemaCacheLoadMode::Foreground,
                &perf_context,
                &state,
            )
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| "schema loader returned no table".to_string())
        },
    )
    .await?;
    let table = schema_snapshot.schema();
    let (session_id, _session_lease) = {
        let mut rt = state.runtime.lock().await;
        open_session_for_live_connection(
            &mut rt,
            &connection_id,
            TableSession {
                connection_id: connection_id.clone(),
                kind,
                database: database.clone(),
                table_name: table_name.clone(),
                clickhouse_url: clickhouse_url.clone(),
                mongodb_url: mongodb_url.clone(),
                pool_key: pool
                    .as_ref()
                    .map(|_| PoolKey::new(&connection_id, &database)),
            },
            Some(schema_snapshot.clone()),
        )?
    };
    let page_pool_key = PoolKey::new(&connection_id, &database);
    let page_result = if let Some(url) = mongodb_url.filter(|_| kind == DatabaseKind::MongoDb) {
        run_pool_work(
            &state.work_scheduler,
            &page_pool_key,
            WorkClass::Foreground,
            FOREGROUND_DB_TIMEOUT,
            mongodb::read_page_with_perf(
                &url,
                &database,
                table,
                &session_id,
                &request,
                &state.perf,
                &perf_context,
            ),
        )
        .await
    } else if let Some(url) = clickhouse_url.filter(|_| kind == DatabaseKind::ClickHouse)
    {
        run_pool_work(
            &state.work_scheduler,
            &page_pool_key,
            WorkClass::Foreground,
            FOREGROUND_DB_TIMEOUT,
            clickhouse::read_page_with_perf(
                &url,
                &database,
                table,
                &session_id,
                &request,
                &state.perf,
                &perf_context,
            ),
        )
        .await
    } else if let Some(pool) = pool {
        run_pool_work(
            &state.work_scheduler,
            &page_pool_key,
            WorkClass::Foreground,
            FOREGROUND_DB_TIMEOUT,
            read_db_page_with_perf_in_database(
                &pool,
                &database,
                table,
                &session_id,
                &request,
                &state.perf,
                &perf_context,
            ),
        )
        .await
    } else if let Some(selection) = demo_profile.and_then(DemoProfile::performance_selection) {
        Ok(read_fixture_page(&selection, table, &session_id, &request))
    } else if matches!(demo_profile, Some(DemoProfile::Stress)) {
        Ok(read_stress_or_materialized_page(
            materialized_rows.as_ref(),
            table,
            &session_id,
            &request,
        ))
    } else {
        Err(no_demo_error())
    };
    let page = match page_result {
        Ok(page) => page,
        Err(error) => {
            state.runtime.lock().await.sessions.close(&session_id);
            return Err(error);
        }
    };
    Ok(PerfResponse::new(page, state.perf.clone(), perf_context))
}

#[tauri::command]
pub async fn close_table_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<CloseTableSessionResponse, String> {
    let closed = state.runtime.lock().await.sessions.close(&session_id);
    Ok(CloseTableSessionResponse { closed })
}

#[tauri::command]
pub async fn fetch_table_page(
    session_id: String,
    request: Option<TablePageRequest>,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<PerfResponse<TableSessionPage>, String> {
    let request = request.unwrap_or_default();
    let (session, demo_profile, materialized_rows) = {
        let mut rt = state.runtime.lock().await;
        let session = rt
            .sessions
            .acquire(&session_id)
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?;
        let row_key = demo_row_key(&session.database, &session.table_name);
        let materialized_rows = rt.demo_rows.get(&row_key).cloned();
        (session, rt.demo_profile, materialized_rows)
    };
    let pool = session_database_pool(&state, &session).await?;
    let schema_snapshot =
        fresh_session_schema(&session_id, &session, &perf_context, &state).await?;
    let table = schema_snapshot.schema();
    let page_pool_key = session
        .pool_key
        .clone()
        .unwrap_or_else(|| PoolKey::new(&session.connection_id, &session.database));
    let page = if let Some(url) = session_mongo_url(&session) {
        run_pool_work(
            &state.work_scheduler,
            &page_pool_key,
            WorkClass::Foreground,
            FOREGROUND_DB_TIMEOUT,
            mongodb::read_page_with_perf(
                &url,
                &session.database,
                table,
                &session_id,
                &request,
                &state.perf,
                &perf_context,
            ),
        )
        .await
    } else if let Some(url) = session
        .clickhouse_url
        .as_ref()
        .filter(|_| session.kind == DatabaseKind::ClickHouse)
    {
        run_pool_work(
            &state.work_scheduler,
            &page_pool_key,
            WorkClass::Foreground,
            FOREGROUND_DB_TIMEOUT,
            clickhouse::read_page_with_perf(
                url,
                &session.database,
                table,
                &session_id,
                &request,
                &state.perf,
                &perf_context,
            ),
        )
        .await
    } else if let Some(pool) = pool {
        run_pool_work(
            &state.work_scheduler,
            &page_pool_key,
            WorkClass::Foreground,
            FOREGROUND_DB_TIMEOUT,
            read_db_page_with_perf_in_database(
                &pool,
                &session.database,
                table,
                &session_id,
                &request,
                &state.perf,
                &perf_context,
            ),
        )
        .await
    } else if let Some(selection) = demo_profile.and_then(DemoProfile::performance_selection) {
        Ok(read_fixture_page(&selection, table, &session_id, &request))
    } else if matches!(demo_profile, Some(DemoProfile::Stress)) {
        Ok(read_stress_or_materialized_page(
            materialized_rows.as_ref(),
            table,
            &session_id,
            &request,
        ))
    } else {
        Err(no_demo_error())
    }?;
    Ok(PerfResponse::new(page, state.perf.clone(), perf_context))
}

#[tauri::command]
pub async fn fetch_table_count(
    session_id: String,
    request_id: String,
    filter: Option<TablePageFilter>,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<TableCountResult, String> {
    if request_id.trim().is_empty() {
        return Err("统计请求 ID 不能为空".into());
    }
    let (session, demo_profile, materialized_rows, mysql_url) = {
        let mut rt = state.runtime.lock().await;
        let session = rt
            .sessions
            .acquire(&session_id)
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?;
        let row_key = demo_row_key(&session.database, &session.table_name);
        let materialized_rows = rt.demo_rows.get(&row_key).cloned();
        let mysql_url = rt
            .connections
            .get(&session.connection_id)
            .and_then(|connection| connection.mysql_url.clone());
        (session, rt.demo_profile, materialized_rows, mysql_url)
    };
    let schema_snapshot =
        fresh_session_schema(&session_id, &session, &perf_context, &state).await?;
    let table = schema_snapshot.schema().as_ref().clone();
    let pool_key = PoolKey::new(&session.connection_id, &session.database);
    let count_request = TablePageRequest {
        page: None,
        page_size: None,
        offset: None,
        include_total: None,
        filter: filter.clone(),
        sort: None,
    };
    let worker_pool_key = pool_key.clone();
    let table_name = session.table_name.clone();
    let table_counts = state.table_counts.clone();
    let loader_table_counts = table_counts.clone();
    let app_state: &AppState = &state;
    table_counts
        .get_or_load(
            &request_id,
            &pool_key,
            &table_name,
            filter.as_ref(),
            |cancellation| async move {
                let work = async {
                    if let Some(url) = session_mongo_url(&session) {
                        mongodb::read_table_count_with_perf(
                            &url,
                            &session.database,
                            &table,
                            &count_request,
                            &app_state.perf,
                            &perf_context,
                        )
                        .await
                    } else if let Some(url) = session
                        .clickhouse_url
                        .as_ref()
                        .filter(|_| session.kind == DatabaseKind::ClickHouse)
                    {
                        clickhouse::read_table_count_with_perf(
                            url,
                            &session.database,
                            &table,
                            &count_request,
                            &app_state.perf,
                            &perf_context,
                        )
                        .await
                    } else if let Some(mysql_url) = mysql_url.as_deref() {
                        let count_pool = loader_table_counts
                            .get_or_connect_count_pool(worker_pool_key.clone(), || {
                                connect_table_count_database(mysql_url, &session.database)
                            })
                            .await?;
                        read_db_table_count_with_perf(
                            &count_pool,
                            &session.database,
                            &table,
                            &count_request,
                            &app_state.perf,
                            &perf_context,
                        )
                        .await
                    } else if let Some(selection) =
                        demo_profile.and_then(DemoProfile::performance_selection)
                    {
                        Ok(TableCountResult {
                            total_rows: count_fixture_rows(
                                &selection,
                                &table,
                                count_request.filter.as_ref(),
                            ),
                            exact: true,
                            estimated: false,
                        })
                    } else if matches!(demo_profile, Some(DemoProfile::Stress)) {
                        Ok(TableCountResult {
                            total_rows: count_stress_or_materialized_rows(
                                materialized_rows.as_ref(),
                                &table,
                                &count_request,
                            ),
                            exact: true,
                            estimated: false,
                        })
                    } else {
                        Err(no_demo_error())
                    }
                };
                app_state
                    .work_scheduler
                    .run(
                        &worker_pool_key,
                        WorkClass::Background,
                        &cancellation,
                        TABLE_COUNT_TIMEOUT,
                        work,
                    )
                    .await
                    .map_err(|error| match error {
                        ScheduledWorkError::Cancelled => "统计已取消".into(),
                        ScheduledWorkError::TimedOut => "统计超时，请稍后重试".into(),
                        ScheduledWorkError::Work(error) => error,
                    })
            },
        )
        .await
}

#[tauri::command]
pub fn cancel_table_count(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<CancelTableCountResult, String> {
    Ok(CancelTableCountResult {
        cancelled: state.table_counts.cancel_request(&request_id),
    })
}

async fn run_table_search_page(
    job: std::sync::Arc<TableSearchJob>,
    perf_context: PerfContext,
    state: &State<'_, AppState>,
) -> Result<PerfResponse<TableSearchPage>, String> {
    let _run_guard = tokio::select! {
        _ = job.cancellation.cancelled() => return Err("搜索已取消".into()),
        guard = job.run_gate.lock() => guard,
    };
    if job.cancellation.is_cancelled() {
        return Err("搜索已取消".into());
    }
    let (session, demo_profile, materialized_rows) = {
        let mut runtime = state.runtime.lock().await;
        let session = runtime
            .sessions
            .acquire(&job.spec.session_id)
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?;
        let row_key = demo_row_key(&session.database, &session.table_name);
        let materialized_rows = runtime.demo_rows.get(&row_key).cloned();
        (session, runtime.demo_profile, materialized_rows)
    };
    let pool = session_database_pool(state, &session).await?;
    let schema_snapshot =
        fresh_session_schema(&job.spec.session_id, &session, &perf_context, state).await?;
    let table = schema_snapshot.schema().as_ref().clone();
    let live_columns = table
        .columns
        .iter()
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    if live_columns != job.spec.columns {
        state.table_search.cancel(&job.id);
        return Err("表结构已变化，请重新搜索".into());
    }
    let source_start = job.cursor.lock().await.next_source_index();
    let worker_pool_key = PoolKey::new(&session.connection_id, &session.database);
    let app_state: &AppState = state;
    let rows = app_state
        .work_scheduler
        .run(
            &worker_pool_key,
            WorkClass::Background,
            &job.cancellation,
            TABLE_SEARCH_TIMEOUT,
            async {
                if let Some(url) = session_mongo_url(&session) {
                    mongodb::read_search_scan_page_with_perf(
                        &url,
                        &session.database,
                        &table,
                        source_start,
                        TABLE_SEARCH_SCAN_PAGE_SIZE,
                        job.spec.sort.as_ref(),
                        &app_state.perf,
                        &perf_context,
                    )
                    .await
                } else if let Some(url) = session
                    .clickhouse_url
                    .as_ref()
                    .filter(|_| session.kind == DatabaseKind::ClickHouse)
                {
                    clickhouse::read_search_scan_page_with_perf(
                        url,
                        &session.database,
                        &table,
                        source_start,
                        TABLE_SEARCH_SCAN_PAGE_SIZE,
                        job.spec.sort.as_ref(),
                        &app_state.perf,
                        &perf_context,
                    )
                    .await
                } else if let Some(pool) = pool {
                    read_db_search_scan_page_with_perf(
                        &pool,
                        &session.database,
                        &table,
                        source_start,
                        TABLE_SEARCH_SCAN_PAGE_SIZE,
                        job.spec.sort.as_ref(),
                        &app_state.perf,
                        &perf_context,
                    )
                    .await
                } else if let Some(selection) =
                    demo_profile.and_then(DemoProfile::performance_selection)
                {
                    Ok(read_fixture_search_scan_page(
                        &selection,
                        &table,
                        source_start,
                        TABLE_SEARCH_SCAN_PAGE_SIZE,
                        job.spec.sort.as_ref(),
                    ))
                } else if matches!(demo_profile, Some(DemoProfile::Stress)) {
                    Ok(read_stress_search_scan_page(
                        materialized_rows.as_ref(),
                        &table,
                        source_start,
                        TABLE_SEARCH_SCAN_PAGE_SIZE,
                        job.spec.sort.as_ref(),
                    ))
                } else {
                    Err(no_demo_error())
                }
            },
        )
        .await
        .map_err(|error| match error {
            ScheduledWorkError::Cancelled => "搜索已取消".into(),
            ScheduledWorkError::TimedOut => "搜索超时，请稍后重试".into(),
            ScheduledWorkError::Work(error) => error,
        })?;
    if job.cancellation.is_cancelled() {
        return Err("搜索已取消".into());
    }
    let source_complete = rows.len() < TABLE_SEARCH_SCAN_PAGE_SIZE as usize;
    let mut cursor = job.cursor.lock().await;
    let batch = cursor.scan_batch(source_start, &rows, source_complete);
    let scanned_rows = cursor.next_source_index();
    let page = TableSearchPage {
        job_id: job.id.clone(),
        rows: batch.rows,
        row_keys: batch.row_keys,
        matches: batch.matches,
        scanned_rows,
        complete: batch.complete,
    };
    Ok(PerfResponse::new(page, state.perf.clone(), perf_context))
}

#[tauri::command]
pub async fn begin_table_search(
    request: TableSearchBeginRequest,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<PerfResponse<TableSearchPage>, String> {
    let query = request.query.trim();
    if query.is_empty() {
        return Err("搜索内容不能为空".into());
    }
    let (session, schema_snapshot) = {
        let session = state
            .runtime
            .lock()
            .await
            .sessions
            .acquire(&request.session_id)
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?;
        let schema =
            fresh_session_schema(&request.session_id, &session, &perf_context, &state).await?;
        (session, schema)
    };
    let table = schema_snapshot.schema();
    let columns = table
        .columns
        .iter()
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    let primary_keys = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    let identity_columns = if primary_keys.is_empty() {
        columns.clone()
    } else {
        primary_keys
    };
    let result_row_limit = request.result_page_size.unwrap_or(100).clamp(1, 200) as usize;
    let job = state.table_search.begin(TableSearchJobSpec {
        session_id: request.session_id,
        query: query.into(),
        mode: request.mode.unwrap_or_else(|| "fuzzy".into()),
        sort: request.sort,
        columns,
        identity_columns,
        result_row_limit,
        result_match_limit: result_row_limit.saturating_mul(4).clamp(100, 2_000),
    });
    drop(session);
    run_table_search_page(job, perf_context, &state).await
}

#[tauri::command]
pub async fn next_table_search_page(
    request: TableSearchNextRequest,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<PerfResponse<TableSearchPage>, String> {
    let job = state
        .table_search
        .get(&request.job_id)
        .ok_or_else(|| "搜索任务已结束，请重新搜索".to_string())?;
    run_table_search_page(job, perf_context, &state).await
}

#[tauri::command]
pub fn cancel_table_search(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<CancelTableSearchResult, String> {
    Ok(CancelTableSearchResult {
        cancelled: state.table_search.cancel(&job_id),
    })
}

enum DemoUpdateCellsPlan {
    Conflict,
    Apply {
        rows: Vec<HashMap<String, String>>,
        updated: u64,
    },
}

fn plan_demo_cell_updates(
    table: &TableMeta,
    original_rows: &[HashMap<String, String>],
    patches: &[UpdateRowPatch],
) -> Result<DemoUpdateCellsPlan, String> {
    let mut updated_rows = original_rows.to_vec();
    let mut matched_indexes = HashSet::new();
    let mut updated = 0u64;

    for patch in patches {
        let matches = original_rows
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                patch.row_identity.iter().all(|(key, value)| match value {
                    Some(expected) => row.get(key) == Some(expected),
                    None => !row.contains_key(key),
                })
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if matches.len() != 1 || !matched_indexes.insert(matches[0]) {
            return Ok(DemoUpdateCellsPlan::Conflict);
        }

        let row_index = matches[0];
        let mut row_changed = false;
        for change in &patch.changes {
            let current = updated_rows[row_index].get(&change.column_name).cloned();
            if current != change.old_value {
                return Ok(DemoUpdateCellsPlan::Conflict);
            }
            if change.old_value == change.new_value {
                continue;
            }
            crate::validation::validate_column_value(
                table,
                &change.column_name,
                change.new_value.as_deref(),
            )
            .map_err(|error| error.message)?;
            match &change.new_value {
                Some(value) => {
                    updated_rows[row_index].insert(change.column_name.clone(), value.clone());
                }
                None => {
                    updated_rows[row_index].remove(&change.column_name);
                }
            }
            row_changed = true;
        }
        if row_changed {
            updated += 1;
        }
    }

    crate::validation::validate_primary_key_uniqueness(table, &updated_rows)
        .map_err(|error| error.message)?;
    Ok(DemoUpdateCellsPlan::Apply {
        rows: updated_rows,
        updated,
    })
}

fn apply_demo_cell_updates(
    table: &TableMeta,
    rows: &mut Vec<HashMap<String, String>>,
    patches: &[UpdateRowPatch],
) -> Result<UpdateCellsResult, String> {
    match plan_demo_cell_updates(table, rows, patches)? {
        DemoUpdateCellsPlan::Conflict => Ok(UpdateCellsResult {
            updated: 0,
            conflict: true,
        }),
        DemoUpdateCellsPlan::Apply {
            rows: updated_rows,
            updated,
        } => {
            *rows = updated_rows;
            Ok(UpdateCellsResult {
                updated,
                conflict: false,
            })
        }
    }
}

async fn update_cells_impl(
    request: UpdateCellsRequest,
    perf_context: &PerfContext,
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<UpdateCellsResult, String> {
    let session = {
        let mut rt = state.runtime.lock().await;
        rt.sessions
            .acquire(&request.session_id)
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };
    if session.kind.is_read_only() {
        return Err(read_only_error(session.kind));
    }
    if let Some(url) = session_mongo_url(&session) {
        let schema_snapshot =
            fresh_session_schema(&request.session_id, &session, perf_context, state).await?;
        let result = mongodb::update_cells(
            &url,
            &session.database,
            schema_snapshot.schema(),
            &request.rows,
        )
        .await?;
        if result.updated > 0 {
            invalidate_table_count(
                state,
                &session.connection_id,
                &session.database,
                &session.table_name,
            );
            crate::table_modified::record_local_change(
                app,
                state,
                &session.connection_id,
                &session.database,
                &[session.table_name.as_str()],
            )
            .await;
        }
        return Ok(result);
    }
    if request.rows.is_empty() {
        return Ok(UpdateCellsResult {
            updated: 0,
            conflict: false,
        });
    }
    if request.rows.len() > 5_000
        || request
            .rows
            .iter()
            .map(|row| row.changes.len())
            .sum::<usize>()
            > 100_000
    {
        return Err("单次保存范围过大，请缩小粘贴区域后重试".into());
    }

    if let Some(pool) = session_database_pool(&state, &session).await? {
        let schema_snapshot =
            fresh_session_schema(&request.session_id, &session, perf_context, state).await?;
        let table = schema_snapshot.schema();
        let known_columns = table
            .columns
            .iter()
            .map(|column| column.column_name.as_str())
            .collect::<HashSet<_>>();
        let json_columns = table
            .columns
            .iter()
            .filter(|column| {
                column
                    .data_type
                    .as_deref()
                    .unwrap_or(&column.column_type)
                    .trim()
                    .eq_ignore_ascii_case("json")
            })
            .map(|column| column.column_name.clone())
            .collect::<HashSet<_>>();

        struct UpdatePlan {
            forward_sql: String,
            forward_binds: Vec<String>,
            pending: audit::PendingAudit,
        }

        let mut plans = Vec::with_capacity(request.rows.len());
        for row in &request.rows {
            if row.row_identity.is_empty() {
                return Err("缺少行标识，未执行保存".into());
            }
            let mut seen_columns = HashSet::new();
            let mut changes = Vec::new();
            for change in &row.changes {
                if !known_columns.contains(change.column_name.as_str()) {
                    return Err(format!("字段 {} 不存在，未执行保存", change.column_name));
                }
                if !seen_columns.insert(change.column_name.clone()) {
                    return Err(format!("字段 {} 在同一行重复出现", change.column_name));
                }
                if change.old_value == change.new_value {
                    continue;
                }
                crate::validation::validate_column_value(
                    table,
                    &change.column_name,
                    change.new_value.as_deref(),
                )
                .map_err(|error| error.message)?;
                changes.push(change.clone());
            }
            if changes.is_empty() {
                continue;
            }
            let (forward_sql, forward_binds, inverse_sql, inverse_binds) =
                audit::build_row_update_inverse(
                    &session.database,
                    &session.table_name,
                    &row.row_identity,
                    &changes,
                    &json_columns,
                )?;
            let grouped = changes.len() > 1;
            let old_value = if grouped {
                Some(
                    serde_json::to_string(
                        &changes
                            .iter()
                            .map(|change| (&change.column_name, &change.old_value))
                            .collect::<HashMap<_, _>>(),
                    )
                    .unwrap_or_default(),
                )
            } else {
                changes[0].old_value.clone()
            };
            let new_value = if grouped {
                Some(
                    serde_json::to_string(
                        &changes
                            .iter()
                            .map(|change| (&change.column_name, &change.new_value))
                            .collect::<HashMap<_, _>>(),
                    )
                    .unwrap_or_default(),
                )
            } else {
                changes[0].new_value.clone()
            };
            let pending = audit::PendingAudit {
                operation: "UPDATE",
                column_name: (!grouped).then(|| changes[0].column_name.clone()),
                old_value,
                new_value,
                row_identity: Some(serde_json::to_value(&row.row_identity).unwrap_or_default()),
                forward_sql: forward_sql.clone(),
                forward_binds: forward_binds.clone(),
                inverse_sql: Some(inverse_sql),
                inverse_binds,
                rollback_strategy: audit::STRATEGY_AUTO,
                notes: grouped.then(|| format!("批量编辑 {} 个单元格", changes.len())),
            };
            plans.push(UpdatePlan {
                forward_sql,
                forward_binds,
                pending,
            });
        }
        if plans.is_empty() {
            return Ok(UpdateCellsResult {
                updated: 0,
                conflict: false,
            });
        }

        let audit_pool = audit::ensure_audit_pool(app, state)
            .await
            .map_err(|error| format!("无法写入审计记录，未执行保存: {error}"))?;
        let (actor, client_id) = crate::account::audit_actor_and_id(app, state).await;
        let ctx = audit::AuditContext {
            connection_id: session.connection_id.clone(),
            database: session.database.clone(),
            table_name: session.table_name.clone(),
            session_id: Some(request.session_id.clone()),
            source: audit::SOURCE_GRID,
            actor,
            client_id,
        };
        let pending = plans.iter().map(|plan| plan.pending.clone()).collect::<Vec<_>>();
        let audit_ids = audit::record_pending_batch(&audit_pool, &ctx, &pending)
            .await.map_err(|error| format!("无法写入审计记录，未执行保存: {error}"))?;

        let mut tx = match pool.begin().await {
            Ok(tx) => tx,
            Err(error) => {
                let _ = audit::mark_aborted_required_batch(&audit_pool, &audit_ids).await;
                return Err(format!("开启保存事务失败: {error}"));
            }
        };
        for plan in &plans {
            let mut query = sqlx::query(&plan.forward_sql);
            for bind in &plan.forward_binds {
                query = query.bind(bind);
            }
            match query.execute(&mut *tx).await {
                Ok(result) if result.rows_affected() == 1 => {}
                Ok(result) => {
                    tx.rollback().await.ok();
                    let _ = audit::mark_aborted_required_batch(&audit_pool, &audit_ids).await;
                    return Err(format!(
                        "有行已变化或不存在，预期更新 1 行，实际影响 {} 行；本次保存已取消",
                        result.rows_affected()
                    ));
                }
                Err(error) => {
                    tx.rollback().await.ok();
                    let _ = audit::mark_aborted_required_batch(&audit_pool, &audit_ids).await;
                    let message = crate::validation::mysql_error_message(&error)
                        .unwrap_or_else(|| format!("保存失败: {error}"));
                    return Err(message);
                }
            }
        }
        if let Err(error) = audit::mark_committed_required_batch(&audit_pool, &audit_ids).await {
            tx.rollback().await.ok();
            let _ = audit::mark_aborted_required_batch(&audit_pool, &audit_ids).await;
            return Err(format!("保存审计落定失败，本次保存已回滚: {error}"));
        }
        if let Err(error) = tx.commit().await {
            let _ = audit::mark_aborted_required_batch(&audit_pool, &audit_ids).await;
            return Err(format!("提交保存事务失败: {error}"));
        }
        crate::audit_sync::trigger_immediate_sync(app);
        invalidate_table_count(
            state,
            &session.connection_id,
            &session.database,
            &session.table_name,
        );
        crate::table_modified::record_local_change(
            app,
            state,
            &session.connection_id,
            &session.database,
            &[session.table_name.as_str()],
        )
        .await;
        return Ok(UpdateCellsResult {
            updated: plans.len() as u64,
            conflict: false,
        });
    }

    let mut rt = state.runtime.lock().await;
    let schema = demo_schema_for_runtime(
        &rt.demo_schema_overrides,
        rt.demo_profile,
        &session.database,
        &rt.selected_database,
        &rt.schema,
    );
    let table = resolve_demo_table(&session.table_name, &schema)?;
    let profile = rt.demo_profile;
    let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &session.database, &table);
    let result = apply_demo_cell_updates(&table, rows, &request.rows)?;
    if result.updated > 0 {
        invalidate_table_count(
            state,
            &session.connection_id,
            &session.database,
            &session.table_name,
        );
    }
    Ok(result)
}

#[tauri::command]
pub async fn update_cell(
    request: UpdateCellRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateCellResult, String> {
    let value = request.new_value.clone();
    let result = update_cells_impl(
        UpdateCellsRequest {
            session_id: request.session_id,
            rows: vec![UpdateRowPatch {
                row_identity: request.row_identity,
                changes: vec![CellUpdateChange {
                    column_name: request.column_name,
                    old_value: request.old_value,
                    new_value: request.new_value,
                }],
            }],
        },
        &perf_context,
        &app,
        &state,
    )
    .await?;
    Ok(UpdateCellResult {
        updated: result.updated > 0,
        conflict: result.conflict,
        value,
    })
}

#[tauri::command]
pub async fn update_cells(
    request: UpdateCellsRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateCellsResult, String> {
    update_cells_impl(request, &perf_context, &app, &state).await
}

/// 表内查找替换（Ctrl+H「全部替换」）。LIKE 粗筛候选行 → Rust 内存精确替换
/// 产出 UpdateRowPatch → 复用 update_cells_impl 的原子事务 + 审计路径。
/// `dry_run` 只返回命中统计，供前端确认后再正式执行。
#[tauri::command]
pub async fn replace_in_table(
    request: ReplaceInTableRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ReplaceInTableResult, String> {
    let query = request.query.trim().to_string();
    if query.is_empty() {
        return Err("查找内容不能为空".into());
    }
    let session = {
        let mut rt = state.runtime.lock().await;
        rt.sessions
            .acquire(&request.session_id)
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };
    if session.kind.is_read_only() {
        return Err(read_only_error(session.kind));
    }
    reject_mongo(session.kind, "整表查找替换")?;

    let (patches, occurrences) = if let Some(pool) = session_database_pool(&state, &session).await?
    {
        let schema_snapshot =
            fresh_session_schema(&request.session_id, &session, &perf_context, &state).await?;
        let rows = crate::replace::fetch_replace_candidate_rows_with_options(
            &pool,
            &session.database,
            schema_snapshot.schema(),
            &query,
            request.case_sensitive,
            request.whole_cell,
            request.column_name.as_deref(),
        )
        .await?;
        crate::replace::collect_patches_from_rows_with_options(
            schema_snapshot.schema(),
            &rows,
            &query,
            &request.replacement,
            request.case_sensitive,
            request.whole_cell,
            request.column_name.as_deref(),
        )
    } else {
        let mut rt = state.runtime.lock().await;
        let schema = demo_schema_for_runtime(
            &rt.demo_schema_overrides,
            rt.demo_profile,
            &session.database,
            &rt.selected_database,
            &rt.schema,
        );
        let table = resolve_demo_table(&session.table_name, &schema)?;
        let profile = rt.demo_profile;
        let rows =
            ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &session.database, &table);
        crate::replace::collect_patches_from_rows_with_options(
            &table,
            rows,
            &query,
            &request.replacement,
            request.case_sensitive,
            request.whole_cell,
            request.column_name.as_deref(),
        )
    };

    if patches.len() > 5_000 || occurrences > 100_000 {
        return Err(format!(
            "命中范围过大（{} 行 / {} 处），请先在表格中多选单元格，把替换范围缩小到选区",
            patches.len(),
            occurrences
        ));
    }
    let replaced_rows = patches.len() as u64;
    if request.dry_run || patches.is_empty() {
        return Ok(ReplaceInTableResult {
            replaced_cells: occurrences,
            replaced_rows,
            patches: Vec::new(),
        });
    }
    let result = update_cells_impl(
        UpdateCellsRequest {
            session_id: request.session_id,
            rows: patches.clone(),
        },
        &perf_context,
        &app,
        &state,
    )
    .await?;
    if result.conflict {
        return Err("部分行已被其他操作修改，本次替换已取消".into());
    }
    Ok(ReplaceInTableResult {
        replaced_cells: occurrences,
        replaced_rows: result.updated,
        patches,
    })
}

/// 表内查找（Ctrl+F 弹窗的结果列表）：与 replace_in_table 同一套候选扫描 +
/// 内存精确匹配，只读返回命中明细与全量统计。ClickHouse 只读连接暂不支持，
/// 前端会提示改用工具栏搜索框。
#[tauri::command]
pub async fn find_in_table(
    request: FindInTableRequest,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<FindInTableResult, String> {
    let query = request.query.trim().to_string();
    if query.is_empty() {
        return Err("查找内容不能为空".into());
    }
    let session = {
        let mut rt = state.runtime.lock().await;
        rt.sessions
            .acquire(&request.session_id)
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };
    let limit = request.limit.unwrap_or(500).clamp(1, 2000) as usize;

    if let Some(pool) = session_database_pool(&state, &session).await? {
        let schema_snapshot =
            fresh_session_schema(&request.session_id, &session, &perf_context, &state).await?;
        let rows = crate::replace::fetch_replace_candidate_rows_with_options(
            &pool,
            &session.database,
            schema_snapshot.schema(),
            &query,
            request.case_sensitive,
            request.whole_cell,
            request.column_name.as_deref(),
        )
        .await?;
        let (matches, total_cells, total_occurrences, truncated) =
            crate::replace::collect_matches_from_rows_with_options(
                schema_snapshot.schema(),
                &rows,
                &query,
                request.case_sensitive,
                request.whole_cell,
                request.column_name.as_deref(),
                limit,
            );
        return Ok(FindInTableResult {
            matches,
            total_cells,
            total_occurrences,
            truncated,
        });
    }
    reject_mongo(session.kind, "整表查找，请使用表格上方的搜索框")?;
    if session.kind.is_read_only() {
        return Err("ClickHouse 连接的整表查找暂不可用，请使用表格上方的搜索框".into());
    }
    let mut rt = state.runtime.lock().await;
    let schema = demo_schema_for_runtime(
        &rt.demo_schema_overrides,
        rt.demo_profile,
        &session.database,
        &rt.selected_database,
        &rt.schema,
    );
    let table = resolve_demo_table(&session.table_name, &schema)?;
    let profile = rt.demo_profile;
    let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &session.database, &table);
    let (matches, total_cells, total_occurrences, truncated) =
        crate::replace::collect_matches_from_rows_with_options(
            &table,
            rows,
            &query,
            request.case_sensitive,
            request.whole_cell,
            request.column_name.as_deref(),
            limit,
        );
    Ok(FindInTableResult {
        matches,
        total_cells,
        total_occurrences,
        truncated,
    })
}

#[tauri::command]
pub async fn fetch_column_distinct_values(
    request: ColumnDistinctValuesRequest,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<ColumnDistinctValuesResult, String> {
    let column_name = request.column_name.trim().to_string();
    if column_name.is_empty() {
        return Err("列名不能为空".into());
    }
    let session = {
        let mut rt = state.runtime.lock().await;
        rt.sessions
            .acquire(&request.session_id)
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };
    let limit = request.limit.unwrap_or(200).clamp(1, 500);

    if let Some(pool) = session_database_pool(&state, &session).await? {
        let schema_snapshot =
            fresh_session_schema(&request.session_id, &session, &perf_context, &state).await?;
        let pool_key = session
            .pool_key
            .clone()
            .unwrap_or_else(|| PoolKey::new(&session.connection_id, &session.database));
        return run_pool_work(
            &state.work_scheduler,
            &pool_key,
            WorkClass::Foreground,
            FOREGROUND_DB_TIMEOUT,
            crate::db::read_column_distinct_values(
                &pool,
                &session.database,
                schema_snapshot.schema(),
                &column_name,
                request.search.as_deref(),
                limit,
                request.filter.as_ref(),
            ),
        )
        .await;
    }

    if session.kind == DatabaseKind::MongoDb || session.kind == DatabaseKind::ClickHouse {
        return Err("当前引擎暂不支持服务端枚举，已回退至当前页数据".into());
    }

    let mut rt = state.runtime.lock().await;
    let schema = demo_schema_for_runtime(
        &rt.demo_schema_overrides,
        rt.demo_profile,
        &session.database,
        &rt.selected_database,
        &rt.schema,
    );
    let table = resolve_demo_table(&session.table_name, &schema)?;
    let profile = rt.demo_profile;
    let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &session.database, &table);
    crate::demo::read_demo_column_distinct_values(
        rows,
        &table.columns,
        &column_name,
        request.search.as_deref(),
        limit,
        request.filter.as_ref(),
    )
}

const PRIMARY_KEY_DUPLICATE_MESSAGE: &str = "主键重复，不能保存";

fn complete_primary_key_values(
    table: &TableMeta,
    draft: &HashMap<String, String>,
) -> Option<Vec<(String, String)>> {
    let keys = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return None;
    }
    let mut values = Vec::with_capacity(keys.len());
    for key in keys {
        let value = draft
            .get(&key)
            .map(|value| value.trim())
            .unwrap_or_default();
        if value.is_empty() {
            return None;
        }
        values.push((key, value.to_string()));
    }
    Some(values)
}

fn build_primary_key_where(
    table: &TableMeta,
    draft: &HashMap<String, String>,
) -> Option<(String, Vec<String>)> {
    let values = complete_primary_key_values(table, draft)?;
    let where_sql = values
        .iter()
        .map(|(key, _)| format!("`{}` <=> ?", escape_ident(key)))
        .collect::<Vec<_>>()
        .join(" AND ");
    Some((
        where_sql,
        values.into_iter().map(|(_, value)| value).collect(),
    ))
}

async fn fetch_inserted_row(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    database: &str,
    table: &TableMeta,
    identity: &HashMap<String, String>,
) -> Result<(Option<HashMap<String, String>>, Vec<String>), String> {
    if identity.is_empty() || table.columns.is_empty() {
        return Ok((None, Vec::new()));
    }
    let (where_sql, binds) = crate::db::build_where(identity)?;
    let select_columns = table
        .columns
        .iter()
        .map(|column| {
            format!(
                "CAST(`{}` AS CHAR) AS `{}`",
                escape_ident(&column.column_name),
                escape_ident(&column.column_name)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {} FROM {} WHERE {} LIMIT 1",
        select_columns,
        crate::db::qualified_table(database, &table.table_name),
        where_sql
    );
    let mut query = sqlx::query(&sql);
    for bind in binds {
        query = query.bind(bind);
    }
    let Some(row) = query
        .fetch_optional(&mut **tx)
        .await
        .map_err(|error| format!("新增成功但读取最终行失败: {error}"))?
    else {
        return Err("新增成功但无法按最终主键读取该行".into());
    };
    let mut values = HashMap::with_capacity(table.columns.len());
    let mut null_columns = Vec::new();
    for column in &table.columns {
        let value = row
            .try_get::<Option<String>, _>(column.column_name.as_str())
            .map_err(|error| format!("读取新增行字段 {} 失败: {error}", column.column_name))?;
        if value.is_none() {
            null_columns.push(column.column_name.clone());
        }
        values.insert(column.column_name.clone(), value.unwrap_or_default());
    }
    Ok((Some(values), null_columns))
}

#[tauri::command]
pub async fn insert_row(
    request: InsertRowRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InsertRowResult, String> {
    let session = {
        let mut rt = state.runtime.lock().await;
        rt.sessions
            .acquire(&request.session_id)
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };
    if session.kind.is_read_only() {
        return Err(read_only_error(session.kind));
    }
    if let Some(url) = session_mongo_url(&session) {
        let schema_snapshot =
            fresh_session_schema(&request.session_id, &session, &perf_context, &state).await?;
        let result = mongodb::insert_row(
            &url,
            &session.database,
            schema_snapshot.schema(),
            &request.draft,
        )
        .await?;
        invalidate_table_count(
            &state,
            &session.connection_id,
            &session.database,
            &session.table_name,
        );
        crate::table_modified::record_local_change(
            &app,
            &state,
            &session.connection_id,
            &session.database,
            &[session.table_name.as_str()],
        )
        .await;
        return Ok(result);
    }
    let draft = request.draft;

    if let Some(pool) = session_database_pool(&state, &session).await? {
        let schema_snapshot =
            fresh_session_schema(&request.session_id, &session, &perf_context, &state).await?;
        let table = schema_snapshot.schema();
        if let Err(error) = crate::validation::validate_row_draft(table, &[], &draft) {
            return Err(error.message);
        }
        if let Some((where_sql, values)) = build_primary_key_where(table, &draft) {
            let sql = format!(
                "SELECT 1 FROM {} WHERE {} LIMIT 1",
                crate::db::qualified_table(&session.database, &session.table_name),
                where_sql
            );
            let mut query = sqlx::query(&sql);
            for value in values {
                query = query.bind(value);
            }
            if query
                .fetch_optional(&pool)
                .await
                .map_err(|error| format!("检查主键冲突失败: {error}"))?
                .is_some()
            {
                return Err(PRIMARY_KEY_DUPLICATE_MESSAGE.into());
            }
        }
        let mut keys = draft.keys().cloned().collect::<Vec<_>>();
        keys.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        let sql = if keys.is_empty() {
            format!(
                "INSERT INTO {} () VALUES ()",
                crate::db::qualified_table(&session.database, &session.table_name)
            )
        } else {
            format!(
                "INSERT INTO {} ({}) VALUES ({})",
                crate::db::qualified_table(&session.database, &session.table_name),
                keys.iter()
                    .map(|key| format!("`{}`", escape_ident(key)))
                    .collect::<Vec<_>>()
                    .join(", "),
                keys.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
            )
        };
        let forward_binds: Vec<String> = keys
            .iter()
            .map(|key| draft.get(key).cloned().unwrap_or_default())
            .collect();
        // Write a pending audit row before the INSERT. The inverse DELETE needs
        // the real primary key, which is only known after a successful insert
        // (auto_increment), so it is finalized afterwards.
        let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
        let ctx = audit::AuditContext {
            connection_id: session.connection_id.clone(),
            database: session.database.clone(),
            table_name: session.table_name.clone(),
            session_id: Some(request.session_id.clone()),
            source: audit::SOURCE_GRID,
            actor,
            client_id,
        };
        let pending = audit::PendingAudit {
            operation: "INSERT",
            column_name: None,
            old_value: None,
            new_value: serde_json::to_string(&draft).ok(),
            row_identity: None,
            forward_sql: sql.clone(),
            forward_binds: forward_binds.clone(),
            inverse_sql: None,
            inverse_binds: Vec::new(),
            rollback_strategy: audit::STRATEGY_MANUAL,
            notes: None,
        };
        let audit_pool = audit::ensure_audit_pool(&app, &state)
            .await
            .map_err(|error| format!("无法写入审计记录，本行未新增: {error}"))?;
        let audit_id = audit::record_pending(&audit_pool, &ctx, &pending)
            .await
            .map_err(|error| format!("无法写入审计记录，本行未新增: {error}"))?;
        let mut tx = match pool.begin().await {
            Ok(tx) => tx,
            Err(error) => {
                let _ = audit::mark_aborted_required(&audit_pool, audit_id).await;
                return Err(format!("开启新增事务失败: {error}"));
            }
        };

        let mut query = sqlx::query(&sql);
        for bind in &forward_binds {
            query = query.bind(bind);
        }
        match query.execute(&mut *tx).await {
            Ok(result) => {
                let affected = result.rows_affected();
                let last_id = result.last_insert_id();
                if affected != 1 {
                    tx.rollback().await.ok();
                    let _ = audit::mark_aborted_required(&audit_pool, audit_id).await;
                    return Err(format!("新增未生效，数据库返回影响 {affected} 行"));
                }
                let identity =
                    crate::batch_import::resolved_insert_identity(table, &draft, last_id)
                        .unwrap_or_default();
                let (row, null_columns) =
                    match fetch_inserted_row(&mut tx, &session.database, table, &identity).await {
                        Ok(value) => value,
                        Err(error) => {
                            tx.rollback().await.ok();
                            let _ = audit::mark_aborted_required(&audit_pool, audit_id).await;
                            return Err(error);
                        }
                    };
                let (inverse_sql, inverse_binds, strategy) = match audit::build_insert_inverse(
                    &session.database,
                    &session.table_name,
                    &identity,
                ) {
                    Ok(value) => value,
                    Err(error) => {
                        tx.rollback().await.ok();
                        let _ = audit::mark_aborted_required(&audit_pool, audit_id).await;
                        return Err(format!("无法生成新增回滚记录，本行已回滚: {error}"));
                    }
                };
                let postimage = row.iter().flat_map(|values| values.iter()).filter(|(key,_)| table.columns.iter().any(|c| &c.column_name == *key && !c.is_generated))
                    .map(|(key,value)| (key.clone(), if null_columns.contains(key) { None } else { Some(value.clone()) })).collect();
                if let Err(error) = crate::audit_postimage::persist(&audit_pool, &[(audit_id, postimage)]).await {
                    tx.rollback().await.ok();
                    let _ = audit::mark_aborted_required(&audit_pool, audit_id).await;
                    return Err(error);
                }
                if let Err(error) = audit::finalize_insert_audit(
                    &audit_pool,
                    audit_id,
                    &identity,
                    inverse_sql,
                    inverse_binds,
                    strategy,
                )
                .await
                {
                    tx.rollback().await.ok();
                    let _ = audit::mark_aborted_required(&audit_pool, audit_id).await;
                    return Err(format!("新增审计落定失败，本行已回滚: {error}"));
                }
                if let Err(error) = tx.commit().await {
                    let _ = audit::mark_aborted_required(&audit_pool, audit_id).await;
                    return Err(format!("提交新增事务失败: {error}"));
                }
                crate::audit_sync::trigger_immediate_sync(&app);
                invalidate_table_count(
                    &state,
                    &session.connection_id,
                    &session.database,
                    &session.table_name,
                );
                crate::table_modified::record_local_change(
                    &app,
                    &state,
                    &session.connection_id,
                    &session.database,
                    &[session.table_name.as_str()],
                )
                .await;
                return Ok(InsertRowResult {
                    affected,
                    row,
                    row_identity: identity,
                    null_columns,
                });
            }
            Err(error) => {
                tx.rollback().await.ok();
                let _ = audit::mark_aborted_required(&audit_pool, audit_id).await;
                let message = crate::validation::mysql_error_message(&error)
                    .unwrap_or_else(|| format!("插入失败: {error}"));
                return Err(message);
            }
        }
    }

    let mut rt = state.runtime.lock().await;
    let schema = demo_schema_for_runtime(
        &rt.demo_schema_overrides,
        rt.demo_profile,
        &session.database,
        &rt.selected_database,
        &rt.schema,
    );
    let table = resolve_demo_table(&session.table_name, &schema)?;
    let profile = rt.demo_profile;
    let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &session.database, &table);
    if let Err(error) = crate::validation::validate_row_draft(&table, rows, &draft) {
        return Err(error.message);
    }
    let inserted_row = draft;
    let identity =
        crate::batch_import::resolved_insert_identity(&table, &inserted_row, 0).unwrap_or_default();
    rows.push(inserted_row.clone());
    invalidate_table_count(
        &state,
        &session.connection_id,
        &session.database,
        &session.table_name,
    );
    Ok(InsertRowResult {
        affected: 1,
        row: Some(inserted_row),
        row_identity: identity,
        null_columns: Vec::new(),
    })
}

fn push_batch_import_error(
    result: &mut BatchImportRowsResult,
    index: usize,
    column_name: Option<String>,
    error: impl Into<String>,
) {
    result.errors.push(BatchImportRowError {
        index,
        column_name,
        error: error.into(),
    });
    result.outcomes.push(BatchImportRowOutcome {
        index,
        status: "error".into(),
        preview: None,
    });
}

fn push_batch_import_outcome(result: &mut BatchImportRowsResult, index: usize, status: &str) {
    match status {
        "inserted" => result.inserted += 1,
        "updated" => result.updated += 1,
        "unchanged" => result.unchanged += 1,
        _ => {}
    }
    result.outcomes.push(BatchImportRowOutcome {
        index,
        status: status.into(),
        preview: None,
    });
}

fn push_batch_import_preview_outcome(
    result: &mut BatchImportRowsResult,
    index: usize,
    status: &str,
    preview: BatchImportRowPreview,
) {
    match status {
        "inserted" => result.inserted += 1,
        "updated" => result.updated += 1,
        _ => {}
    }
    result.outcomes.push(BatchImportRowOutcome {
        index,
        status: status.into(),
        preview: Some(preview),
    });
}

#[tauri::command]
pub async fn import_rows(
    request: BatchImportRowsRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BatchImportRowsResult, String> {
    crate::batch_import::validate_batch_size(request.rows.len())?;
    let session = {
        let mut rt = state.runtime.lock().await;
        rt.sessions
            .acquire(&request.session_id)
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };
    if session.kind.is_read_only() {
        return Err(read_only_error(session.kind));
    }
    reject_mongo(session.kind, "导入")?;
    let preview_only = request.preview_only;

    let mut result = BatchImportRowsResult {
        inserted: 0,
        updated: 0,
        unchanged: 0,
        errors: Vec::new(),
        outcomes: Vec::with_capacity(request.rows.len()),
    };

    if let Some(pool) = session_database_pool(&state, &session).await? {
        let schema_snapshot =
            fresh_session_schema(&request.session_id, &session, &perf_context, &state).await?;
        let table = schema_snapshot.schema();
        crate::batch_import::validate_import_table(&table)?;

        // Phase 1 — plan (no writes): fetch existing rows in one batch query,
        // then classify every draft as update / unchanged / insert / error.
        let drafts = request.rows.into_iter().collect::<Vec<_>>();
        let mut existing_by_index: HashMap<usize, crate::batch_import::ExistingRow> =
            HashMap::new();
        if let Some(batch_plan) =
            crate::batch_import::build_batch_existing_lookup_plan(&table, &drafts)
        {
            let mut query = sqlx::query(&batch_plan.sql);
            for bind in &batch_plan.binds {
                query = query.bind(bind);
            }
            // A failed batch lookup degrades to the per-row lookups below, which
            // surface the same per-row errors the pre-batch implementation did.
            if let Ok(rows) = query.fetch_all(&pool).await {
                let pk_count = batch_plan.pk_columns.len();
                let mut fetched = HashMap::new();
                for row in rows {
                    let mut pk_values: Vec<Option<String>> = Vec::with_capacity(pk_count);
                    let mut existing = crate::batch_import::ExistingRow::new();
                    let mut decoded = true;
                    for (column_index, column_name) in batch_plan
                        .pk_columns
                        .iter()
                        .chain(batch_plan.value_columns.iter())
                        .enumerate()
                    {
                        match row.try_get::<Option<String>, _>(column_index) {
                            Ok(value) if column_index < pk_count => pk_values.push(value),
                            Ok(value) => {
                                existing.insert(column_name.clone(), value);
                            }
                            Err(_) => {
                                decoded = false;
                                break;
                            }
                        }
                    }
                    if decoded && pk_values.len() == pk_count {
                        fetched.insert(crate::batch_import::lookup_key(&pk_values), existing);
                    }
                }
                for &index in &batch_plan.draft_indexes {
                    let key = import_draft_lookup_key(&batch_plan.pk_columns, &drafts[index]);
                    if let Some(existing) = fetched.get(&key) {
                        existing_by_index.insert(index, existing.clone());
                    }
                }
            }
        }

        let mut update_stash: Vec<ImportPlannedUpdate> = Vec::new();
        let mut insert_stash: Vec<ImportPlannedInsert> = Vec::new();
        for (index, draft) in drafts.iter().enumerate() {
            let existing = if let Some(existing) = existing_by_index.remove(&index) {
                Some(existing)
            } else {
                // Per-row fallback for drafts the batch lookup did not cover
                // (incomplete primary key) or did not match byte-exactly
                // (collation-equal keys like 'ABC' vs 'abc').
                let lookup_plan =
                    match crate::batch_import::build_existing_lookup_plan(&table, draft) {
                        Ok(plan) => Some(plan),
                        Err(_) => None,
                    };
                let mut resolved = None;
                if let Some(lookup_plan) = lookup_plan {
                    let mut query = sqlx::query(&lookup_plan.sql);
                    for bind in &lookup_plan.binds {
                        query = query.bind(bind);
                    }
                    match query.fetch_optional(&pool).await {
                        Ok(Some(row)) => {
                            let values = lookup_plan
                                .columns
                                .iter()
                                .enumerate()
                                .map(|(column_index, column_name)| {
                                    row.try_get::<Option<String>, _>(column_index)
                                        .map(|value| (column_name.clone(), value))
                                        .map_err(|error| {
                                            format!(
                                                "读取导入行旧值失败（字段 {}）: {error}",
                                                column_name
                                            )
                                        })
                                })
                                .collect::<Result<crate::batch_import::ExistingRow, String>>();
                            match values {
                                Ok(values) => resolved = Some(values),
                                Err(error) => {
                                    push_batch_import_error(&mut result, index, None, error);
                                    continue;
                                }
                            }
                        }
                        Ok(None) => {}
                        Err(error) => {
                            push_batch_import_error(
                                &mut result,
                                index,
                                None,
                                format!("检查主键失败: {error}"),
                            );
                            continue;
                        }
                    }
                }
                resolved
            };

            if let Some(existing) = existing {
                let validation_error = draft.iter().find_map(|(column_name, value)| {
                    crate::validation::validate_column_value(
                        &table,
                        column_name,
                        Some(value.as_str()),
                    )
                    .err()
                });
                if let Some(error) = validation_error {
                    push_batch_import_error(
                        &mut result,
                        index,
                        Some(error.column_name),
                        error.message,
                    );
                    continue;
                }
                match crate::batch_import::build_update_plan(&table, draft, &existing) {
                    Ok(crate::batch_import::RowPlan::Update(plan)) => {
                        if preview_only {
                            let preview = build_batch_import_update_preview(&table, &plan);
                            push_batch_import_preview_outcome(
                                &mut result,
                                index,
                                "updated",
                                preview,
                            );
                        } else {
                            update_stash.push(ImportPlannedUpdate { index, plan });
                        }
                    }
                    Ok(crate::batch_import::RowPlan::Unchanged) => {
                        push_batch_import_outcome(&mut result, index, "unchanged");
                    }
                    Err(error) => {
                        push_batch_import_error(&mut result, index, None, error);
                    }
                }
                continue;
            }

            if let Err(error) = crate::validation::validate_row_draft(&table, &[], draft) {
                push_batch_import_error(&mut result, index, Some(error.column_name), error.message);
                continue;
            }
            match crate::batch_import::build_insert_plan(&session.database, &table, draft) {
                Ok(plan) => {
                    if preview_only {
                        let preview = build_batch_import_insert_preview(&table, draft, &plan);
                        push_batch_import_preview_outcome(&mut result, index, "inserted", preview);
                    } else {
                        insert_stash.push(ImportPlannedInsert { index, plan });
                    }
                }
                Err(error) => push_batch_import_error(&mut result, index, None, error),
            }
        }

        if preview_only {
            return Ok(result);
        }

        let audit_pool = audit::ensure_audit_pool(&app, &state)
            .await
            .map_err(|error| format!("初始化导入审计失败，本批次未写入: {error}"))?;
        let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
        let ctx = audit::AuditContext {
            connection_id: session.connection_id.clone(),
            database: session.database.clone(),
            table_name: session.table_name.clone(),
            session_id: Some(request.session_id.clone()),
            source: audit::SOURCE_IMPORT,
            actor,
            client_id,
        };
        let mut audit_sync_needed = false;

        // Phase 2 — write every pending audit row in ONE SQLite transaction,
        // updates first (in row order) then inserts (in row order).
        let mut pendings = Vec::with_capacity(update_stash.len() + insert_stash.len());
        for stashed in &update_stash {
            let plan = &stashed.plan;
            pendings.push(audit::PendingAudit {
                operation: "UPDATE",
                column_name: None,
                old_value: serde_json::to_string(&plan.old_values).ok(),
                new_value: serde_json::to_string(&plan.new_values).ok(),
                row_identity: serde_json::to_value(&plan.identity).ok(),
                forward_sql: plan.forward_sql.clone(),
                forward_binds: plan.forward_binds.clone(),
                inverse_sql: Some(plan.inverse_sql.clone()),
                inverse_binds: plan.inverse_binds.clone(),
                rollback_strategy: audit::STRATEGY_AUTO,
                notes: Some("批量导入更新".into()),
            });
        }
        for stashed in &insert_stash {
            let plan = &stashed.plan;
            let has_inverse = plan.inverse_sql.is_some();
            pendings.push(audit::PendingAudit {
                operation: "INSERT",
                column_name: None,
                old_value: None,
                new_value: serde_json::to_string(&drafts[stashed.index]).ok(),
                row_identity: (!plan.identity.is_empty())
                    .then(|| serde_json::to_value(&plan.identity).unwrap_or_default()),
                forward_sql: plan.forward_sql.clone(),
                forward_binds: plan.forward_binds.clone(),
                inverse_sql: plan.inverse_sql.clone(),
                inverse_binds: plan.inverse_binds.clone(),
                rollback_strategy: if has_inverse {
                    audit::STRATEGY_AUTO
                } else {
                    audit::STRATEGY_MANUAL
                },
                notes: Some("批量导入新增".into()),
            });
        }
        let audit_ids = if pendings.is_empty() {
            Vec::new()
        } else {
            match audit::record_pending_batch(&audit_pool, &ctx, &pendings).await {
                Ok(ids) => ids,
                Err(error) => {
                    for stashed in &update_stash {
                        push_batch_import_error(
                            &mut result,
                            stashed.index,
                            None,
                            format!("无法写入审计记录，本行未导入: {error}"),
                        );
                    }
                    for stashed in &insert_stash {
                        push_batch_import_error(
                            &mut result,
                            stashed.index,
                            None,
                            format!("无法写入审计记录，本行未导入: {error}"),
                        );
                    }
                    return Ok(result);
                }
            }
        };

        if !audit_ids.is_empty() {
            let (update_audit_ids, insert_audit_ids) = audit_ids.split_at(update_stash.len());
            let all_pending_ids = audit_ids.clone();
            let mut committed_ids: Vec<i64> = Vec::new();
            let mut aborted_ids: Vec<i64> = Vec::new();
            let mut finalize_items: Vec<audit::FinalizeInsertAuditItem> = Vec::new();

            // Phase 3 — execute the whole chunk in ONE MySQL transaction;
            // single-row statement errors do not abort it, so per-row best
            // effort is preserved.
            let mut tx = match pool.begin().await {
                Ok(tx) => tx,
                Err(error) => {
                    let _ = audit::mark_aborted_required_batch(&audit_pool, &all_pending_ids).await;
                    for stashed in &update_stash {
                        push_batch_import_error(
                            &mut result,
                            stashed.index,
                            None,
                            format!("开启导入事务失败: {error}"),
                        );
                    }
                    for stashed in &insert_stash {
                        push_batch_import_error(
                            &mut result,
                            stashed.index,
                            None,
                            format!("开启导入事务失败: {error}"),
                        );
                    }
                    return Ok(result);
                }
            };

            for (stashed, &audit_id) in update_stash.iter().zip(update_audit_ids) {
                let plan = &stashed.plan;
                let index = stashed.index;
                let mut query = sqlx::query(&plan.forward_sql);
                for bind in &plan.forward_binds {
                    query = query.bind(bind);
                }
                match query.execute(&mut *tx).await {
                    Ok(execution) if execution.rows_affected() >= 1 => {
                        committed_ids.push(audit_id);
                        audit_sync_needed = true;
                        push_batch_import_outcome(&mut result, index, "updated");
                    }
                    Ok(_) => {
                        // 0 rows affected: either the row changed under us or
                        // the new values normalize to the stored ones — the
                        // recheck (inside the transaction) tells which.
                        let recheck = crate::batch_import::build_expected_values_lookup_plan(
                            &table,
                            &plan.identity,
                            &plan.new_values,
                        );
                        let recheck_row = match recheck {
                            Ok(expected) => {
                                let mut query = sqlx::query(&expected.sql);
                                for bind in &expected.binds {
                                    query = query.bind(bind);
                                }
                                query
                                    .fetch_optional(&mut *tx)
                                    .await
                                    .map_err(|error| error.to_string())
                            }
                            Err(error) => Err(error),
                        };
                        aborted_ids.push(audit_id);
                        match recheck_row {
                            Ok(Some(_)) => {
                                push_batch_import_outcome(&mut result, index, "unchanged");
                            }
                            Ok(None) => {
                                push_batch_import_error(
                                    &mut result,
                                    index,
                                    None,
                                    "该行在导入期间已被修改，请重试",
                                );
                            }
                            Err(error) => {
                                push_batch_import_error(
                                    &mut result,
                                    index,
                                    None,
                                    format!("确认字段值失败: {error}"),
                                );
                            }
                        }
                    }
                    Err(error) => {
                        aborted_ids.push(audit_id);
                        let message = crate::validation::mysql_error_message(&error)
                            .unwrap_or_else(|| format!("更新失败: {error}"));
                        push_batch_import_error(&mut result, index, None, message);
                    }
                }
            }

            let insert_indexes = insert_stash
                .iter()
                .map(|stashed| stashed.index)
                .collect::<Vec<_>>();
            let insert_positions = insert_stash
                .iter()
                .enumerate()
                .map(|(position, stashed)| (stashed.index, position))
                .collect::<HashMap<_, _>>();
            for group in crate::batch_import::build_grouped_insert_statements(
                &table,
                &drafts,
                &insert_indexes,
            ) {
                let mut query = sqlx::query(&group.sql);
                for bind in &group.binds {
                    query = query.bind(bind);
                }
                match query.execute(&mut *tx).await {
                    Ok(execution) => {
                        // Within one multi-row INSERT the generated
                        // auto-increment ids are consecutive and only rows that
                        // needed generation consume them.
                        let first_id = execution.last_insert_id();
                        let mut generated = 0u64;
                        for &index in &group.draft_indexes {
                            let position = insert_positions[&index];
                            let stashed = &insert_stash[position];
                            let audit_id = insert_audit_ids[position];
                            if stashed.plan.inverse_sql.is_some() {
                                committed_ids.push(audit_id);
                                audit_sync_needed = true;
                                push_batch_import_outcome(&mut result, index, "inserted");
                                continue;
                            }
                            let generated_id =
                                first_id.checked_add(generated).filter(|_| first_id > 0);
                            generated += 1;
                            let outcome = generated_id
                                .ok_or_else(|| "新增后无法确定完整主键".to_string())
                                .and_then(|generated_id| {
                                    build_import_finalize_item(
                                        &session.database,
                                        &session.table_name,
                                        &table,
                                        &drafts[index],
                                        generated_id,
                                        audit_id,
                                    )
                                });
                            match outcome {
                                Ok(item) => {
                                    finalize_items.push(item);
                                    audit_sync_needed = true;
                                    push_batch_import_outcome(&mut result, index, "inserted");
                                }
                                Err(message) => {
                                    aborted_ids.push(audit_id);
                                    push_batch_import_error(&mut result, index, None, message);
                                }
                            }
                        }
                    }
                    Err(_) => {
                        // The group failed: retry its rows one by one inside the
                        // same transaction so good rows still import.
                        for &index in &group.draft_indexes {
                            let position = insert_positions[&index];
                            let stashed = &insert_stash[position];
                            let audit_id = insert_audit_ids[position];
                            let plan = &stashed.plan;
                            let mut query = sqlx::query(&plan.forward_sql);
                            for bind in &plan.forward_binds {
                                query = query.bind(bind);
                            }
                            match query.execute(&mut *tx).await {
                                Ok(execution) => {
                                    let outcome = if plan.inverse_sql.is_some() {
                                        committed_ids.push(audit_id);
                                        Ok(())
                                    } else {
                                        build_import_finalize_item(
                                            &session.database,
                                            &session.table_name,
                                            &table,
                                            &drafts[index],
                                            execution.last_insert_id(),
                                            audit_id,
                                        )
                                        .map(|item| finalize_items.push(item))
                                    };
                                    match outcome {
                                        Ok(()) => {
                                            audit_sync_needed = true;
                                            push_batch_import_outcome(
                                                &mut result,
                                                index,
                                                "inserted",
                                            );
                                        }
                                        Err(message) => {
                                            aborted_ids.push(audit_id);
                                            push_batch_import_error(
                                                &mut result,
                                                index,
                                                None,
                                                message,
                                            );
                                        }
                                    }
                                }
                                Err(error) => {
                                    aborted_ids.push(audit_id);
                                    let message = crate::validation::mysql_error_message(&error)
                                        .unwrap_or_else(|| format!("插入失败: {error}"));
                                    push_batch_import_error(&mut result, index, None, message);
                                }
                            }
                        }
                    }
                }
            }

            // Phase 4 — finalize the audit trail first, then commit MySQL
            // (the same ordering the per-row implementation used).
            let finalize_result = async {
                let committed_set = committed_ids.iter().copied().collect::<HashSet<_>>();
                let mut postimages = insert_stash.iter().zip(insert_audit_ids.iter())
                    .filter(|(_, id)| committed_set.contains(id))
                    .map(|(stashed,id)| (*id, stashed.plan.identity.clone())).collect::<Vec<_>>();
                postimages.extend(finalize_items.iter().map(|item| (item.id, item.identity.clone())));
                crate::audit_postimage::capture(&audit_pool, &mut tx, &session.database, &table, &postimages).await?;
                audit::finalize_insert_audit_batch(&audit_pool, &finalize_items).await?;
                if !committed_ids.is_empty() {
                    audit::mark_committed_required_batch(&audit_pool, &committed_ids).await?;
                }
                if !aborted_ids.is_empty() {
                    audit::mark_aborted_required_batch(&audit_pool, &aborted_ids).await?;
                }
                Ok::<(), String>(())
            }
            .await;
            if let Err(error) = finalize_result {
                tx.rollback().await.ok();
                let _ = audit::mark_aborted(&audit_pool, &all_pending_ids).await;
                return Err(format!("导入审计落定失败，本批次已回滚: {error}"));
            }
            if let Err(error) = tx.commit().await {
                let _ = audit::mark_aborted(&audit_pool, &all_pending_ids).await;
                return Err(format!("提交导入事务失败: {error}"));
            }
        }

        if audit_sync_needed {
            crate::audit_sync::trigger_immediate_sync(&app);
        }
        if result.inserted > 0 || result.updated > 0 {
            invalidate_table_count(
                &state,
                &session.connection_id,
                &session.database,
                &session.table_name,
            );
            crate::table_modified::record_local_change(
                &app,
                &state,
                &session.connection_id,
                &session.database,
                &[session.table_name.as_str()],
            )
            .await;
        }
        return Ok(result);
    }

    let mut rt = state.runtime.lock().await;
    let schema = demo_schema_for_runtime(
        &rt.demo_schema_overrides,
        rt.demo_profile,
        &session.database,
        &rt.selected_database,
        &rt.schema,
    );
    let table = resolve_demo_table(&session.table_name, &schema)?;
    crate::batch_import::validate_import_table(&table)?;
    let profile = rt.demo_profile;
    let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &session.database, &table);
    let primary_keys = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    for (index, draft) in request.rows.into_iter().enumerate() {
        let existing_index = if primary_keys.is_empty()
            || primary_keys.iter().any(|key| {
                draft
                    .get(key)
                    .map(|value| value.trim().is_empty())
                    .unwrap_or(true)
            }) {
            None
        } else {
            rows.iter().position(|row| {
                primary_keys
                    .iter()
                    .all(|key| row.get(key) == draft.get(key))
            })
        };
        if let Some(existing_index) = existing_index {
            let validation_error = draft.iter().find_map(|(column_name, value)| {
                crate::validation::validate_column_value(&table, column_name, Some(value.as_str()))
                    .err()
            });
            if let Some(error) = validation_error {
                push_batch_import_error(&mut result, index, Some(error.column_name), error.message);
                continue;
            }
            let current = rows[existing_index]
                .iter()
                .map(|(key, value)| (key.clone(), Some(value.clone())))
                .collect::<crate::batch_import::ExistingRow>();
            match crate::batch_import::build_update_plan(&table, &draft, &current) {
                Ok(crate::batch_import::RowPlan::Unchanged) => {
                    push_batch_import_outcome(&mut result, index, "unchanged");
                }
                Ok(crate::batch_import::RowPlan::Update(plan)) => {
                    if preview_only {
                        let preview = build_batch_import_update_preview(&table, &plan);
                        push_batch_import_preview_outcome(&mut result, index, "updated", preview);
                    } else {
                        rows[existing_index].extend(plan.new_values);
                        push_batch_import_outcome(&mut result, index, "updated");
                    }
                }
                Err(error) => push_batch_import_error(&mut result, index, None, error),
            }
            continue;
        }
        if let Err(error) = crate::validation::validate_row_draft(&table, rows, &draft) {
            push_batch_import_error(&mut result, index, Some(error.column_name), error.message);
            continue;
        }
        if preview_only {
            match crate::batch_import::build_insert_plan(&session.database, &table, &draft) {
                Ok(plan) => {
                    let preview = build_batch_import_insert_preview(&table, &draft, &plan);
                    push_batch_import_preview_outcome(&mut result, index, "inserted", preview);
                }
                Err(error) => push_batch_import_error(&mut result, index, None, error),
            }
        } else {
            rows.push(draft);
            push_batch_import_outcome(&mut result, index, "inserted");
        }
    }
    if !preview_only && (result.inserted > 0 || result.updated > 0) {
        invalidate_table_count(
            &state,
            &session.connection_id,
            &session.database,
            &session.table_name,
        );
    }
    Ok(result)
}

enum TableReplacementPlan {
    Delete {
        identity: HashMap<String, String>,
        old_values: HashMap<String, Option<String>>,
        forward_sql: String,
        forward_binds: Vec<String>,
        inverse_sql: String,
        inverse_binds: Vec<String>,
    },
    Update(crate::table_replace::UpdatePlan),
    Insert {
        plan: crate::batch_import::InsertPlan,
        new_values: HashMap<String, String>,
    },
}

const TABLE_REPLACEMENT_PREVIEW_OUTCOME_LIMIT: usize = 2000;

fn build_table_replacement_preview(
    database: &str,
    table: &TableMeta,
    mapped_columns: &HashSet<String>,
    incoming: Vec<crate::table_replace::ReplacementRow>,
    mut current_by_signature: HashMap<
        String,
        (
            crate::batch_import::ExistingRow,
            crate::table_replace::ReplacementRow,
        ),
    >,
) -> Result<ReplaceTableRowsResult, String> {
    let mut incoming_outcomes =
        Vec::with_capacity(incoming.len().min(TABLE_REPLACEMENT_PREVIEW_OUTCOME_LIMIT));
    let mut result = ReplaceTableRowsResult {
        inserted: 0,
        updated: 0,
        unchanged: 0,
        deleted: 0,
        backup_path: None,
        outcomes: Vec::new(),
        row_statuses: Vec::with_capacity(incoming.len()),
    };
    for (index, draft) in incoming.into_iter().enumerate() {
        let signature = crate::table_replace::identity_signature(table, &draft)?;
        if let Some((existing, _)) = current_by_signature.remove(&signature) {
            match crate::table_replace::build_update_plan(table, &draft, mapped_columns, &existing)?
            {
                crate::table_replace::RowPlan::Unchanged => {
                    result.unchanged += 1;
                    result.row_statuses.push("unchanged".into());
                }
                crate::table_replace::RowPlan::Update(plan) => {
                    result.updated += 1;
                    result.row_statuses.push("updated".into());
                    if incoming_outcomes.len() < TABLE_REPLACEMENT_PREVIEW_OUTCOME_LIMIT {
                        incoming_outcomes.push(TableReplacementRowOutcome {
                            status: "updated".into(),
                            index: Some(index),
                            preview: build_table_replacement_update_preview(
                                table, &plan, &existing,
                            ),
                        });
                    }
                }
            }
        } else {
            let plan = crate::batch_import::build_insert_plan(database, table, &draft)?;
            result.inserted += 1;
            result.row_statuses.push("inserted".into());
            if incoming_outcomes.len() < TABLE_REPLACEMENT_PREVIEW_OUTCOME_LIMIT {
                incoming_outcomes.push(TableReplacementRowOutcome {
                    status: "inserted".into(),
                    index: Some(index),
                    preview: build_batch_import_insert_preview(table, &draft, &plan),
                });
            }
        }
    }

    let mut remaining = current_by_signature.into_iter().collect::<Vec<_>>();
    remaining.sort_by(|left, right| left.0.cmp(&right.0));
    result.deleted = remaining.len() as u64;
    let delete_limit = remaining.len().min(TABLE_REPLACEMENT_PREVIEW_OUTCOME_LIMIT);
    let mut delete_outcomes = Vec::with_capacity(delete_limit);
    for (_, (_, current)) in remaining.into_iter().take(delete_limit) {
        delete_outcomes.push(TableReplacementRowOutcome {
            status: "deleted".into(),
            index: None,
            preview: BatchImportRowPreview {
                identity: crate::table_replace::row_identity(table, &current)?,
                changes: Vec::new(),
                before: Some(
                    current
                        .iter()
                        .map(|(key, value)| (key.clone(), Some(value.clone())))
                        .collect(),
                ),
                after: None,
            },
        });
    }
    // Each status keeps its own outcome budget so a flood of deletions
    // cannot starve inserted/updated detail rows.
    result.outcomes = delete_outcomes
        .into_iter()
        .chain(incoming_outcomes)
        .collect();
    Ok(result)
}

impl TableReplacementPlan {
    fn statement(&self) -> (&str, &[String]) {
        match self {
            Self::Delete {
                forward_sql,
                forward_binds,
                ..
            } => (forward_sql, forward_binds),
            Self::Update(plan) => plan.unguarded_statement(),
            Self::Insert { plan, .. } => (&plan.forward_sql, &plan.forward_binds),
        }
    }
}

#[tauri::command]
pub async fn replace_table_rows(
    request: ReplaceTableRowsRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ReplaceTableRowsResult, String> {
    let session = {
        let mut rt = state.runtime.lock().await;
        rt.sessions
            .acquire(&request.session_id)
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };
    if session.kind.is_read_only() {
        return Err(read_only_error(session.kind));
    }
    reject_mongo(session.kind, "整表导入替换")?;

    if let Some(pool) = session_database_pool(&state, &session).await? {
        let schema_snapshot =
            fresh_session_schema(&request.session_id, &session, &perf_context, &state).await?;
        let table = schema_snapshot.schema().as_ref().clone();
        let mapped_columns = crate::table_replace::mapped_column_names(
            &table,
            &request.mapped_columns,
            &request.rows,
        );
        let incoming = crate::table_replace::prepare_replacement_rows(&table, request.rows)?;
        let insertable_columns = table
            .columns
            .iter()
            .filter(|column| !column.is_generated)
            .map(|column| column.column_name.clone())
            .collect::<Vec<_>>();
        if insertable_columns.is_empty() {
            return Err("目标表没有可覆盖的字段".into());
        }
        let backup_columns = table
            .columns
            .iter()
            .map(|column| column.column_name.clone())
            .collect::<Vec<_>>();
        let projection_for = |columns: &[String]| {
            columns
                .iter()
                .map(|column| {
                    format!(
                        "CAST(`{}` AS CHAR) AS `{}`",
                        escape_ident(column),
                        escape_ident(column)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        if request.preview_only {
            let preview_column_names = mapped_columns
                .iter()
                .map(String::as_str)
                .chain(
                    table
                        .columns
                        .iter()
                        .filter(|column| column.is_primary_key)
                        .map(|column| column.column_name.as_str()),
                )
                .collect::<HashSet<_>>();
            let preview_columns = table
                .columns
                .iter()
                .filter(|column| preview_column_names.contains(column.column_name.as_str()))
                .map(|column| column.column_name.clone())
                .collect::<Vec<_>>();
            let projection = projection_for(&preview_columns);
            let select_sql = format!(
                "SELECT {projection} FROM {}",
                crate::db::qualified_table(&session.database, &session.table_name)
            );
            let current_query_rows = sqlx::query(&select_sql)
                .fetch_all(&pool)
                .await
                .map_err(|error| format!("读取目标表当前数据失败: {error}"))?;
            let mut current_by_signature = HashMap::new();
            for row in current_query_rows {
                let mut optional_values = crate::batch_import::ExistingRow::new();
                let mut string_values = HashMap::new();
                for (index, column) in preview_columns.iter().enumerate() {
                    let value = row.try_get::<Option<String>, _>(index).unwrap_or(None);
                    if insertable_columns.contains(column) {
                        string_values.insert(column.clone(), value.clone().unwrap_or_default());
                        optional_values.insert(column.clone(), value);
                    }
                }
                let signature = crate::table_replace::identity_signature(&table, &string_values)?;
                current_by_signature.insert(signature, (optional_values, string_values));
            }
            return build_table_replacement_preview(
                &session.database,
                &table,
                &mapped_columns,
                incoming,
                current_by_signature,
            );
        }
        let projection = projection_for(&backup_columns);
        let select_sql = format!(
            "SELECT {projection} FROM {} FOR UPDATE",
            crate::db::qualified_table(&session.database, &session.table_name)
        );
        let audit_pool = audit::ensure_audit_pool(&app, &state).await?;
        let mut tx = pool
            .begin()
            .await
            .map_err(|error| format!("开启整表覆盖事务失败: {error}"))?;
        let current_query_rows = match sqlx::query(&select_sql).fetch_all(&mut *tx).await {
            Ok(rows) => rows,
            Err(error) => {
                tx.rollback().await.ok();
                return Err(format!("读取目标表当前数据失败: {error}"));
            }
        };
        let mut current_by_signature = HashMap::new();
        let mut backup_rows = request
            .require_xlsx_backup
            .then(|| Vec::with_capacity(current_query_rows.len()));
        for row in current_query_rows {
            let mut complete_values = crate::table_xlsx::XlsxRow::new();
            for (index, column) in backup_columns.iter().enumerate() {
                let value = match row.try_get::<Option<String>, _>(index) {
                    Ok(value) => value,
                    Err(error) if request.require_xlsx_backup => {
                        tx.rollback().await.ok();
                        return Err(format!(
                            "原表 XLSX 备份失败，导入已取消: 无法完整读取字段 {column}: {error}"
                        ));
                    }
                    Err(_) => None,
                };
                complete_values.insert(column.clone(), value);
            }
            let mut optional_values = crate::batch_import::ExistingRow::new();
            let mut string_values = HashMap::new();
            for column in &insertable_columns {
                let value = complete_values.get(column).cloned().flatten();
                string_values.insert(column.clone(), value.clone().unwrap_or_default());
                optional_values.insert(column.clone(), value);
            }
            if let Some(rows) = backup_rows.as_mut() {
                rows.push(complete_values);
            }
            let signature = crate::table_replace::identity_signature(&table, &string_values)?;
            current_by_signature.insert(signature, (optional_values, string_values));
        }

        let backup_path = if let Some(rows) = backup_rows.as_deref() {
            match crate::table_xlsx::write_import_backup_async(
                session.database.clone(),
                session.table_name.clone(),
                backup_columns,
                rows.to_vec(),
            )
            .await
            {
                Ok(path) => Some(path),
                Err(error) => {
                    tx.rollback().await.ok();
                    return Err(error);
                }
            }
        } else {
            None
        };

        let mut delete_plans = Vec::new();
        let mut update_plans = Vec::new();
        let mut insert_plans = Vec::new();
        let mut result = ReplaceTableRowsResult {
            inserted: 0,
            updated: 0,
            unchanged: 0,
            deleted: 0,
            backup_path,
            outcomes: Vec::new(),
            row_statuses: Vec::new(),
        };
        for draft in incoming {
            let signature = crate::table_replace::identity_signature(&table, &draft)?;
            if let Some((existing, _)) = current_by_signature.remove(&signature) {
                match crate::table_replace::build_update_plan(
                    &table,
                    &draft,
                    &mapped_columns,
                    &existing,
                )? {
                    crate::table_replace::RowPlan::Unchanged => result.unchanged += 1,
                    crate::table_replace::RowPlan::Update(plan) => {
                        result.updated += 1;
                        update_plans.push(TableReplacementPlan::Update(plan));
                    }
                }
            } else {
                let plan =
                    crate::batch_import::build_insert_plan(&session.database, &table, &draft)?;
                result.inserted += 1;
                insert_plans.push(TableReplacementPlan::Insert {
                    plan,
                    new_values: draft,
                });
            }
        }
        for (_, (current_values, current)) in current_by_signature {
            let identity = crate::table_replace::row_identity(&table, &current)?;
            let (forward_sql, forward_binds) =
                audit::build_delete_forward(&session.database, &session.table_name, &identity)?;
            let preimage = audit::preimage_vector(&insertable_columns, &current_values);
            let (inverse_sql, inverse_binds) = audit::build_delete_inverse(
                &session.database,
                &session.table_name,
                &insertable_columns,
                &preimage,
            );
            delete_plans.push(TableReplacementPlan::Delete {
                identity,
                old_values: current_values,
                forward_sql,
                forward_binds,
                inverse_sql,
                inverse_binds,
            });
            result.deleted += 1;
        }
        let plans = delete_plans
            .into_iter()
            .chain(update_plans)
            .chain(insert_plans)
            .collect::<Vec<_>>();

        let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
        let ctx = audit::AuditContext {
            connection_id: session.connection_id.clone(),
            database: session.database.clone(),
            table_name: session.table_name.clone(),
            session_id: Some(request.session_id.clone()),
            source: audit::SOURCE_IMPORT,
            actor,
            client_id,
        };
        let pendings = plans
            .iter()
            .map(|plan| match plan {
                TableReplacementPlan::Delete {
                    identity,
                    old_values,
                    forward_sql,
                    forward_binds,
                    inverse_sql,
                    inverse_binds,
                } => audit::PendingAudit {
                    operation: "DELETE",
                    column_name: None,
                    old_value: serde_json::to_string(old_values).ok(),
                    new_value: None,
                    row_identity: serde_json::to_value(identity).ok(),
                    forward_sql: forward_sql.clone(),
                    forward_binds: forward_binds.clone(),
                    inverse_sql: Some(inverse_sql.clone()),
                    inverse_binds: inverse_binds.clone(),
                    rollback_strategy: audit::STRATEGY_AUTO,
                    notes: Some("整表覆盖导入删除".into()),
                },
                TableReplacementPlan::Update(plan) => audit::PendingAudit {
                    operation: "UPDATE",
                    column_name: None,
                    old_value: serde_json::to_string(&plan.old_values).ok(),
                    new_value: serde_json::to_string(&plan.new_values).ok(),
                    row_identity: serde_json::to_value(&plan.identity).ok(),
                    // The audit forward SQL is the statement that actually runs:
                    // PK-only WHERE, because the whole table is locked FOR
                    // UPDATE and old-value guards can false-conflict on
                    // normalize-equal values. The inverse is unchanged.
                    forward_sql: plan.unguarded_forward_sql.clone(),
                    forward_binds: plan.unguarded_forward_binds.clone(),
                    inverse_sql: Some(plan.inverse_sql.clone()),
                    inverse_binds: plan.inverse_binds.clone(),
                    rollback_strategy: audit::STRATEGY_AUTO,
                    notes: Some("整表覆盖导入更新".into()),
                },
                TableReplacementPlan::Insert { plan, new_values } => audit::PendingAudit {
                    operation: "INSERT",
                    column_name: None,
                    old_value: None,
                    new_value: serde_json::to_string(new_values).ok(),
                    row_identity: serde_json::to_value(&plan.identity).ok(),
                    forward_sql: plan.forward_sql.clone(),
                    forward_binds: plan.forward_binds.clone(),
                    inverse_sql: plan.inverse_sql.clone(),
                    inverse_binds: plan.inverse_binds.clone(),
                    rollback_strategy: audit::STRATEGY_AUTO,
                    notes: Some("整表覆盖导入新增".into()),
                },
            })
            .collect::<Vec<_>>();
        let audit_ids = if pendings.is_empty() {
            Vec::new()
        } else {
            match audit::record_pending_batch(&audit_pool, &ctx, &pendings).await {
                Ok(ids) => ids,
                Err(error) => {
                    tx.rollback().await.ok();
                    return Err(format!("无法写入覆盖导入审计，本次未修改目标表: {error}"));
                }
            }
        };

        let mut normalize_equal_audit_ids = Vec::new();
        for (plan_index, plan) in plans.iter().enumerate() {
            let (sql, binds) = plan.statement();
            let mut query = sqlx::query(sql);
            for bind in binds {
                query = query.bind(bind);
            }
            let execution = match query.execute(&mut *tx).await {
                Ok(execution) => execution,
                Err(error) => {
                    tx.rollback().await.ok();
                    let _ = audit::mark_aborted(&audit_pool, &audit_ids).await;
                    let message = crate::validation::mysql_error_message(&error)
                        .unwrap_or_else(|| format!("整表覆盖失败: {error}"));
                    return Err(format!("{message}；目标表未发生任何变化"));
                }
            };
            let affected = execution.rows_affected();
            if affected == 0 && matches!(plan, TableReplacementPlan::Update(_)) {
                // The row is locked FOR UPDATE, so 0 affected rows means the
                // new values normalize to the stored ones (e.g. '1' vs 1.00):
                // count it as unchanged, not as a conflict.
                result.updated -= 1;
                result.unchanged += 1;
                normalize_equal_audit_ids.push(audit_ids[plan_index]);
                continue;
            }
            if affected != 1 {
                tx.rollback().await.ok();
                let _ = audit::mark_aborted(&audit_pool, &audit_ids).await;
                return Err("目标表在覆盖期间被其他操作修改，本次已整体回滚".into());
            }
        }
        let committed_ids = audit_ids
            .iter()
            .copied()
            .filter(|id| !normalize_equal_audit_ids.contains(id))
            .collect::<Vec<_>>();
        let finalize_result = async {
            let postimages = plans.iter().zip(&audit_ids).filter_map(|(plan,id)| match plan {
                TableReplacementPlan::Insert { plan, .. } => Some((*id, plan.identity.clone())),
                _ => None,
            }).collect::<Vec<_>>();
            crate::audit_postimage::capture(&audit_pool, &mut tx, &session.database, &table, &postimages).await?;
            if !normalize_equal_audit_ids.is_empty() {
                audit::mark_aborted_required_batch(&audit_pool, &normalize_equal_audit_ids).await?;
            }
            if !committed_ids.is_empty() {
                audit::mark_committed_required_batch(&audit_pool, &committed_ids).await?;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = finalize_result {
            tx.rollback().await.ok();
            let _ = audit::mark_aborted(&audit_pool, &audit_ids).await;
            return Err(format!("覆盖导入审计落定失败，本次已整体回滚: {error}"));
        }
        if let Err(error) = tx.commit().await {
            let _ = audit::mark_aborted(&audit_pool, &audit_ids).await;
            return Err(format!("提交整表覆盖事务失败: {error}"));
        }
        if !plans.is_empty() {
            crate::audit_sync::trigger_immediate_sync(&app);
            invalidate_table_count(
                &state,
                &session.connection_id,
                &session.database,
                &session.table_name,
            );
            crate::table_modified::record_local_change(
                &app,
                &state,
                &session.connection_id,
                &session.database,
                &[session.table_name.as_str()],
            )
            .await;
        }
        return Ok(result);
    }

    let mut rt = state.runtime.lock().await;
    let schema = demo_schema_for_runtime(
        &rt.demo_schema_overrides,
        rt.demo_profile,
        &session.database,
        &rt.selected_database,
        &rt.schema,
    );
    let table = resolve_demo_table(&session.table_name, &schema)?;
    let mapped_columns =
        crate::table_replace::mapped_column_names(&table, &request.mapped_columns, &request.rows);
    let incoming = crate::table_replace::prepare_replacement_rows(&table, request.rows)?;
    let profile = rt.demo_profile;
    let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &session.database, &table);
    let backup_path = if request.require_xlsx_backup && !request.preview_only {
        let columns = table
            .columns
            .iter()
            .filter(|column| !column.is_generated)
            .map(|column| column.column_name.clone())
            .collect::<Vec<_>>();
        let backup_rows = rows
            .iter()
            .map(|row| {
                columns
                    .iter()
                    .map(|column| (column.clone(), row.get(column).cloned()))
                    .collect::<crate::table_xlsx::XlsxRow>()
            })
            .collect::<Vec<_>>();
        Some(
            crate::table_xlsx::write_import_backup_async(
                session.database.clone(),
                session.table_name.clone(),
                columns,
                backup_rows,
            )
            .await?,
        )
    } else {
        None
    };
    if request.preview_only {
        let current_by_signature = rows
            .iter()
            .cloned()
            .map(|row| {
                let signature = crate::table_replace::identity_signature(&table, &row)?;
                let existing = row
                    .iter()
                    .map(|(column, value)| (column.clone(), Some(value.clone())))
                    .collect::<crate::batch_import::ExistingRow>();
                Ok((signature, (existing, row)))
            })
            .collect::<Result<HashMap<_, _>, String>>()?;
        return build_table_replacement_preview(
            &session.database,
            &table,
            &mapped_columns,
            incoming,
            current_by_signature,
        );
    }
    let mut current_by_signature = rows
        .iter()
        .cloned()
        .map(|row| {
            crate::table_replace::identity_signature(&table, &row).map(|signature| (signature, row))
        })
        .collect::<Result<HashMap<_, _>, _>>()?;
    let mut replacement_rows = Vec::with_capacity(incoming.len());
    let mut result = ReplaceTableRowsResult {
        inserted: 0,
        updated: 0,
        unchanged: 0,
        deleted: 0,
        backup_path,
        outcomes: Vec::new(),
        row_statuses: Vec::new(),
    };
    for incoming_row in incoming {
        let signature = crate::table_replace::identity_signature(&table, &incoming_row)?;
        if let Some(current) = current_by_signature.remove(&signature) {
            let (current, changed) = crate::table_replace::merge_mapped_values(
                &table,
                incoming_row,
                &mapped_columns,
                current,
            )?;
            if changed {
                result.updated += 1;
            } else {
                result.unchanged += 1;
            }
            replacement_rows.push(current);
        } else {
            replacement_rows.push(crate::table_replace::materialize_insert_defaults(
                &table,
                incoming_row,
                &mapped_columns,
            )?);
            result.inserted += 1;
        }
    }
    result.deleted = current_by_signature.len() as u64;
    *rows = replacement_rows;
    if result.inserted > 0 || result.updated > 0 || result.deleted > 0 {
        invalidate_table_count(
            &state,
            &session.connection_id,
            &session.database,
            &session.table_name,
        );
    }
    Ok(result)
}

/// One planned UPDATE row of a chunked batch import (`import_rows`).
struct ImportPlannedUpdate {
    index: usize,
    plan: crate::batch_import::UpdatePlan,
}

/// One planned INSERT row of a chunked batch import (`import_rows`).
struct ImportPlannedInsert {
    index: usize,
    plan: crate::batch_import::InsertPlan,
}

const BATCH_IMPORT_PREVIEW_VALUE_LIMIT: usize = 512;

fn truncate_batch_import_preview_value(value: &str) -> (String, bool) {
    if value.chars().count() <= BATCH_IMPORT_PREVIEW_VALUE_LIMIT {
        return (value.to_string(), false);
    }
    (
        value
            .chars()
            .take(BATCH_IMPORT_PREVIEW_VALUE_LIMIT)
            .collect(),
        true,
    )
}

fn batch_import_preview_change(
    column_name: &str,
    old_value: Option<String>,
    new_value: Option<&str>,
) -> BatchImportCellChange {
    let (old_value, old_value_truncated) = match old_value {
        Some(value) => {
            let (value, truncated) = truncate_batch_import_preview_value(&value);
            (Some(value), truncated)
        }
        None => (None, false),
    };
    let (new_value, new_value_truncated) = match new_value {
        Some(value) => {
            let (value, truncated) = truncate_batch_import_preview_value(value);
            (Some(value), truncated)
        }
        None => (None, false),
    };
    BatchImportCellChange {
        column_name: column_name.to_string(),
        old_value,
        new_value,
        old_value_truncated,
        new_value_truncated,
    }
}

fn build_batch_import_update_preview(
    table: &TableMeta,
    plan: &crate::batch_import::UpdatePlan,
) -> BatchImportRowPreview {
    let changes = table
        .columns
        .iter()
        .filter_map(|column| {
            let new_value = plan.new_values.get(&column.column_name)?;
            let old_value = plan.old_values.get(&column.column_name).cloned().flatten();
            Some(batch_import_preview_change(
                &column.column_name,
                old_value,
                Some(new_value),
            ))
        })
        .collect();
    BatchImportRowPreview {
        identity: plan.identity.clone(),
        changes,
        before: None,
        after: None,
    }
}

fn build_batch_import_insert_preview(
    table: &TableMeta,
    draft: &HashMap<String, String>,
    plan: &crate::batch_import::InsertPlan,
) -> BatchImportRowPreview {
    let changes = table
        .columns
        .iter()
        .filter(|column| !column.is_generated)
        .filter_map(|column| {
            draft.get(&column.column_name).map(|new_value| {
                batch_import_preview_change(&column.column_name, None, Some(new_value))
            })
        })
        .collect();
    BatchImportRowPreview {
        identity: plan.identity.clone(),
        changes,
        before: None,
        after: Some(
            draft
                .iter()
                .map(|(key, value)| (key.clone(), Some(value.clone())))
                .collect(),
        ),
    }
}

fn build_table_replacement_update_preview(
    table: &TableMeta,
    plan: &crate::table_replace::UpdatePlan,
    existing: &crate::batch_import::ExistingRow,
) -> BatchImportRowPreview {
    let changes = table
        .columns
        .iter()
        .filter_map(|column| {
            let new_value = plan.new_values.get(&column.column_name)?;
            let old_value = plan.old_values.get(&column.column_name).cloned().flatten();
            Some(batch_import_preview_change(
                &column.column_name,
                old_value,
                new_value.as_deref(),
            ))
        })
        .collect();
    let mut after = existing.clone();
    for (column, value) in &plan.new_values {
        after.insert(column.clone(), value.clone());
    }
    BatchImportRowPreview {
        identity: plan.identity.clone(),
        changes,
        before: Some(existing.clone()),
        after: Some(after),
    }
}

/// Rebuild the batch-lookup map key for one draft from its primary-key values,
/// in the lookup plan's PK projection order.
fn import_draft_lookup_key(pk_columns: &[String], draft: &HashMap<String, String>) -> String {
    let values = pk_columns
        .iter()
        .map(|column| draft.get(column).cloned())
        .collect::<Vec<_>>();
    crate::batch_import::lookup_key(&values)
}

/// Build the audit finalization item for an inserted row whose full primary key
/// is only known after MySQL generated it (`last_insert_id`), mirroring the
/// per-row `finalize_insert_audit` path the pre-batch implementation used.
fn build_import_finalize_item(
    database: &str,
    table_name: &str,
    table: &TableMeta,
    draft: &HashMap<String, String>,
    generated_id: u64,
    audit_id: i64,
) -> Result<audit::FinalizeInsertAuditItem, String> {
    let identity = crate::batch_import::resolved_insert_identity(table, draft, generated_id)
        .ok_or_else(|| "新增后无法确定完整主键".to_string())?;
    let (inverse_sql, inverse_binds, strategy) =
        audit::build_insert_inverse(database, table_name, &identity)?;
    Ok(audit::FinalizeInsertAuditItem {
        id: audit_id,
        identity,
        inverse_sql,
        inverse_binds,
        strategy,
    })
}

#[tauri::command]
pub async fn delete_rows(
    request: DeleteRowsRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RowMutationResult, String> {
    let session = {
        let mut rt = state.runtime.lock().await;
        rt.sessions
            .acquire(&request.session_id)
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };

    if session.kind.is_read_only() {
        return Err(read_only_error(session.kind));
    }
    if let Some(url) = session_mongo_url(&session) {
        let result =
            mongodb::delete_rows(&url, &session.database, &session.table_name, &request.row_identities)
                .await?;
        if result.affected > 0 {
            invalidate_table_count(
                &state,
                &session.connection_id,
                &session.database,
                &session.table_name,
            );
            crate::table_modified::record_local_change(
                &app,
                &state,
                &session.connection_id,
                &session.database,
                &[session.table_name.as_str()],
            )
            .await;
        }
        return Ok(result);
    }

    if request.row_identities.is_empty() {
        return Ok(RowMutationResult { affected: 0 });
    }

    if let Some(pool) = session_database_pool(&state, &session).await? {
        let audit_pool = audit::ensure_audit_pool(&app, &state)
            .await
            .map_err(|error| format!("无法写入审计记录，未执行删除: {error}"))?;
        let schema_snapshot =
            fresh_session_schema(&request.session_id, &session, &perf_context, &state).await?;
        let table = schema_snapshot.schema();
        let insertable_cols: Vec<String> = table
            .columns
            .iter()
            .filter(|column| !column.is_generated)
            .map(|column| column.column_name.clone())
            .collect();
        let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
        let ctx = audit::AuditContext {
            connection_id: session.connection_id.clone(),
            database: session.database.clone(),
            table_name: session.table_name.clone(),
            session_id: Some(request.session_id.clone()),
            source: audit::SOURCE_GRID,
            actor,
            client_id,
        };

        let plans = request
            .row_identities
            .iter()
            .map(|identity| {
                audit::build_delete_forward_nullable(
                    &session.database,
                    &session.table_name,
                    identity,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut tx = pool
            .begin()
            .await
            .map_err(|error| format!("开启删除事务失败: {error}"))?;

        // Read and lock every row inside the delete transaction. This keeps the
        // rollback image aligned with the exact version that is removed.
        let mut audit_ids: Vec<i64> = Vec::new();
        let mut pendings = Vec::with_capacity(256);
        for (index, (identity, (forward_sql, forward_binds))) in
            request.row_identities.iter().zip(plans.iter()).enumerate()
        {
            let preimage = match fetch_preimage(
                &mut tx,
                &session.database,
                &session.table_name,
                &insertable_cols,
                identity,
            )
            .await
            {
                Ok(Some(preimage)) => preimage,
                Ok(None) => {
                    tx.rollback().await.ok();
                    let _ = audit::mark_aborted_batch(&audit_pool, &audit_ids).await;
                    return Err("有行已变化或不存在，本次删除已取消".into());
                }
                Err(error) => {
                    tx.rollback().await.ok();
                    let _ = audit::mark_aborted_batch(&audit_pool, &audit_ids).await;
                    return Err(error);
                }
            };
            let (inverse_sql, inverse_binds) = audit::build_delete_inverse(
                &session.database,
                &session.table_name,
                &insertable_cols,
                &audit::preimage_vector(&insertable_cols, &preimage),
            );
            let pending = audit::PendingAudit {
                operation: "DELETE",
                column_name: None,
                old_value: serde_json::to_string(&preimage).ok(),
                new_value: None,
                row_identity: Some(serde_json::to_value(identity).unwrap_or_default()),
                forward_sql: forward_sql.clone(),
                forward_binds: forward_binds.clone(),
                inverse_sql: Some(inverse_sql),
                inverse_binds,
                rollback_strategy: audit::STRATEGY_AUTO,
                notes: None,
            };
            pendings.push(pending);
            // Bound before-image memory and durable SQLite commits without
            // splitting the MySQL transaction or deleting any unaudited rows.
            if pendings.len() == 256 || index + 1 == plans.len() {
                match audit::record_pending_batch(&audit_pool, &ctx, &pendings).await {
                    Ok(ids) => audit_ids.extend(ids),
                    Err(error) => {
                        tx.rollback().await.ok();
                        let _ = audit::mark_aborted_batch(&audit_pool, &audit_ids).await;
                        return Err(format!("无法写入审计记录，未执行删除: {error}"));
                    }
                }
                pendings.clear();
            }
        }

        // Execute all deletes together so a mid-batch failure leaves no partial
        // delete and no committed audit entries.
        let mut affected = 0u64;
        let mut exec_error: Option<String> = None;
        for (forward_sql, forward_binds) in &plans {
            let mut query = sqlx::query(forward_sql);
            for bind in forward_binds {
                query = query.bind(bind);
            }
            match query.execute(&mut *tx).await {
                Ok(result) if result.rows_affected() == 1 => affected += 1,
                Ok(result) => {
                    exec_error = Some(format!(
                        "有行已变化或不存在，预期删除 1 行，实际影响 {} 行；本次删除已取消",
                        result.rows_affected()
                    ));
                    break;
                }
                Err(error) => {
                    exec_error = Some(format!("删除失败: {error}"));
                    break;
                }
            }
        }
        match exec_error {
            Some(error) => {
                tx.rollback().await.ok();
                let _ = audit::mark_aborted_batch(&audit_pool, &audit_ids).await;
                return Err(error);
            }
            None => {
                if let Err(error) = audit::mark_committed_required_batch(&audit_pool, &audit_ids).await {
                    tx.rollback().await.ok();
                    let _ = audit::mark_aborted_batch(&audit_pool, &audit_ids).await;
                    return Err(format!("删除审计落定失败，本次删除已回滚: {error}"));
                }
                if let Err(error) = tx.commit().await {
                    let _ = audit::mark_aborted_batch(&audit_pool, &audit_ids).await;
                    return Err(format!("提交删除事务失败: {error}"));
                }
                crate::audit_sync::trigger_immediate_sync(&app);
                if affected > 0 {
                    invalidate_table_count(
                        &state,
                        &session.connection_id,
                        &session.database,
                        &session.table_name,
                    );
                    crate::table_modified::record_local_change(
                        &app,
                        &state,
                        &session.connection_id,
                        &session.database,
                        &[session.table_name.as_str()],
                    )
                    .await;
                }
                return Ok(RowMutationResult { affected });
            }
        }
    }

    let mut rt = state.runtime.lock().await;
    let schema = demo_schema_for_runtime(
        &rt.demo_schema_overrides,
        rt.demo_profile,
        &session.database,
        &rt.selected_database,
        &rt.schema,
    );
    let table = resolve_demo_table(&session.table_name, &schema)?;
    let profile = rt.demo_profile;
    let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &session.database, &table);
    let mut delete_indexes = HashSet::new();
    for identity in &request.row_identities {
        if identity.is_empty() {
            return Err("删除条件不能为空".into());
        }
        let matching_indexes = rows
            .iter()
            .enumerate()
            .filter_map(|(index, row)| {
                identity
                    .iter()
                    .all(|(key, value)| match value {
                        Some(expected) => row.get(key) == Some(expected),
                        None => !row.contains_key(key),
                    })
                    .then_some(index)
            })
            .collect::<Vec<_>>();
        if matching_indexes.len() != 1 {
            return Err("有行已变化或不存在，本次删除已取消".into());
        }
        if !delete_indexes.insert(matching_indexes[0]) {
            return Err("删除列表包含重复行，本次删除已取消".into());
        }
    }
    let mut index = 0usize;
    rows.retain(|_| {
        let keep = !delete_indexes.contains(&index);
        index += 1;
        keep
    });
    let affected = delete_indexes.len() as u64;
    if affected > 0 {
        invalidate_table_count(
            &state,
            &session.connection_id,
            &session.database,
            &session.table_name,
        );
    }
    Ok(RowMutationResult { affected })
}

#[tauri::command]
pub async fn search_values(
    window: Window,
    request: SearchValuesRequest,
    perf_context: PerfContext,
    state: State<'_, AppState>,
) -> Result<Vec<SearchValueItem>, String> {
    let query = request.query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = request.limit.unwrap_or(1500).clamp(1, 1500);
    let (connection_id, database, kind, mysql_url, clickhouse_url, mongodb_url, demo_rows, schema) = {
        let rt = state.runtime.lock().await;
        let connection_id = request
            .connection_id
            .clone()
            .unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        let database = request.database.clone().unwrap_or_else(|| {
            connection
                .database
                .clone()
                .unwrap_or_else(|| rt.selected_database.clone())
        });
        let schema = demo_schema_for_runtime(
            &rt.demo_schema_overrides,
            rt.demo_profile,
            &database,
            &rt.selected_database,
            &rt.schema,
        );
        (
            connection_id,
            database,
            connection.kind,
            connection.mysql_url.clone(),
            connection.clickhouse_url.clone(),
            connection.mongodb_url.clone(),
            rt.demo_rows.clone(),
            schema,
        )
    };

    if database.trim().is_empty() {
        return Err("请先选择数据库".into());
    }

    let job_id = request.job_id.clone().unwrap_or_default();

    if let Some(url) = clickhouse_url.filter(|_| kind == DatabaseKind::ClickHouse) {
        let mut results = Vec::new();
        let tables = order_tables_by_priority(
            filter_tables_by_included(
                clickhouse::list_tables(&url, &database).await?,
                &request.included_tables,
            ),
            &request.priority_tables,
        )
        .into_iter()
        .take(SEARCH_VALUES_TABLE_SCAN_LIMIT)
        .collect::<Vec<_>>();
        let total = tables.len() as u64;
        emit_search_values_progress(
            &window, &job_id, &query, &database, 0, total, 0, None, "running",
        );
        for (index, table_option) in tables.into_iter().enumerate() {
            emit_search_values_progress(
                &window,
                &job_id,
                &query,
                &database,
                index as u64,
                total,
                results.len() as u64,
                Some(table_option.table_name.clone()),
                "running",
            );
            let table =
                match clickhouse::read_schema(&url, &database, &table_option.table_name).await {
                    Ok(value) => value,
                    Err(error) => {
                        emit_search_values_progress(
                            &window,
                            &job_id,
                            &query,
                            &database,
                            index as u64,
                            total,
                            results.len() as u64,
                            Some(table_option.table_name),
                            "failed",
                        );
                        return Err(error);
                    }
                };
            let matches =
                match clickhouse::search_value_matches(&url, &database, &table, &query).await {
                    Ok(value) => value,
                    Err(error) => {
                        emit_search_values_progress(
                            &window,
                            &job_id,
                            &query,
                            &database,
                            index as u64,
                            total,
                            results.len() as u64,
                            Some(table.table_name.clone()),
                            "failed",
                        );
                        return Err(error);
                    }
                };
            for item in matches {
                results.push(item);
                if results.len() >= limit {
                    break;
                }
            }
            emit_search_values_progress(
                &window,
                &job_id,
                &query,
                &database,
                (index + 1) as u64,
                total,
                results.len() as u64,
                Some(table.table_name),
                "running",
            );
            if results.len() >= limit {
                break;
            }
        }
        emit_search_values_progress(
            &window,
            &job_id,
            &query,
            &database,
            total,
            total,
            results.len() as u64,
            None,
            "completed",
        );
        return Ok(results);
    }

    if let Some(url) = mongodb_url.filter(|_| kind == DatabaseKind::MongoDb) {
        let mut results = Vec::new();
        let tables = order_tables_by_priority(
            filter_tables_by_included(
                mongodb::list_tables(&url, &database).await?,
                &request.included_tables,
            ),
            &request.priority_tables,
        )
        .into_iter()
        .take(SEARCH_VALUES_TABLE_SCAN_LIMIT)
        .collect::<Vec<_>>();
        let total = tables.len() as u64;
        emit_search_values_progress(
            &window, &job_id, &query, &database, 0, total, 0, None, "running",
        );
        for (index, table_option) in tables.into_iter().enumerate() {
            emit_search_values_progress(
                &window,
                &job_id,
                &query,
                &database,
                index as u64,
                total,
                results.len() as u64,
                Some(table_option.table_name.clone()),
                "running",
            );
            let table = match mongodb::read_schema(&url, &database, &table_option.table_name).await {
                Ok(value) => value,
                Err(error) => {
                    emit_search_values_progress(
                        &window,
                        &job_id,
                        &query,
                        &database,
                        index as u64,
                        total,
                        results.len() as u64,
                        Some(table_option.table_name),
                        "failed",
                    );
                    return Err(error);
                }
            };
            let matches = match mongodb::search_value_matches(&url, &database, &table, &query).await {
                Ok(value) => value,
                Err(error) => {
                    emit_search_values_progress(
                        &window,
                        &job_id,
                        &query,
                        &database,
                        index as u64,
                        total,
                        results.len() as u64,
                        Some(table.table_name.clone()),
                        "failed",
                    );
                    return Err(error);
                }
            };
            for item in matches {
                results.push(item);
                if results.len() >= limit {
                    break;
                }
            }
            emit_search_values_progress(
                &window,
                &job_id,
                &query,
                &database,
                (index + 1) as u64,
                total,
                results.len() as u64,
                Some(table.table_name),
                "running",
            );
            if results.len() >= limit {
                break;
            }
        }
        emit_search_values_progress(
            &window,
            &job_id,
            &query,
            &database,
            total,
            total,
            results.len() as u64,
            None,
            "completed",
        );
        return Ok(results);
    }

    if mysql_url.is_some() {
        let pool = real_database_pool(&connection_id, &database, &state, &perf_context).await?;
        let pool_key = PoolKey::new(&connection_id, &database);
        let _permit = state
            .work_scheduler
            .acquire(
                &pool_key,
                WorkClass::Background,
                &WorkCancellation::new(),
                SEARCH_VALUES_SCHEDULE_TIMEOUT,
            )
            .await
            .map_err(map_schedule_error)?;
        let mut results = Vec::new();
        let tables = order_tables_by_priority(
            filter_tables_by_included(
                list_tables_from_db(&pool, &database).await?,
                &request.included_tables,
            ),
            &request.priority_tables,
        )
        .into_iter()
        .take(SEARCH_VALUES_TABLE_SCAN_LIMIT)
        .collect::<Vec<_>>();
        let total = tables.len() as u64;
        emit_search_values_progress(
            &window, &job_id, &query, &database, 0, total, 0, None, "running",
        );
        let schemas = match read_schemas_for_tables(&pool, &database, &tables).await {
            Ok(value) => value,
            Err(error) => {
                emit_search_values_progress(
                    &window, &job_id, &query, &database, 0, total, 0, None, "failed",
                );
                return Err(error);
            }
        };
        for (index, table) in schemas.into_iter().enumerate() {
            let done = index as u64;
            emit_search_values_progress(
                &window,
                &job_id,
                &query,
                &database,
                done,
                total,
                results.len() as u64,
                Some(table.table_name.clone()),
                "running",
            );
            let matches = match search_value_matches_in_database(
                &pool,
                Some(&database),
                &table,
                &query,
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    emit_search_values_progress(
                        &window,
                        &job_id,
                        &query,
                        &database,
                        done,
                        total,
                        results.len() as u64,
                        Some(table.table_name.clone()),
                        "failed",
                    );
                    return Err(error);
                }
            };
            for item in matches {
                results.push(item);
                if results.len() >= limit {
                    break;
                }
            }
            emit_search_values_progress(
                &window,
                &job_id,
                &query,
                &database,
                (index + 1) as u64,
                total,
                results.len() as u64,
                Some(table.table_name.clone()),
                "running",
            );
            if results.len() >= limit {
                break;
            }
        }
        emit_search_values_progress(
            &window,
            &job_id,
            &query,
            &database,
            total,
            total,
            results.len() as u64,
            None,
            "completed",
        );
        return Ok(results);
    }

    let tables = filter_tables_by_included(
        schema
            .iter()
            .map(|table| TableOption {
                table_name: table.table_name.clone(),
                table_comment: table.table_comment.clone(),
                column_count: Some(table.columns.len() as u64),
                data_size_bytes: None,
                modified_at: None,
                modified_source: None,
                modified_actor: None,
            })
            .collect(),
        &request.included_tables,
    );
    let tables = order_tables_by_priority(tables, &request.priority_tables)
        .into_iter()
        .take(SEARCH_VALUES_TABLE_SCAN_LIMIT)
        .collect::<Vec<_>>();
    let total = tables.len() as u64;

    emit_search_values_progress(
        &window, &job_id, &query, &database, 0, total, 0, None, "running",
    );

    let mut results = Vec::new();
    for (index, table_option) in tables.iter().enumerate() {
        let table = schema
            .iter()
            .find(|t| t.table_name == table_option.table_name);
        let Some(table) = table else {
            continue;
        };

        emit_search_values_progress(
            &window,
            &job_id,
            &query,
            &database,
            index as u64,
            total,
            results.len() as u64,
            Some(table.table_name.clone()),
            "running",
        );

        let rows = materialized_demo_rows_for(&database, &demo_rows, table);
        let remaining = limit.saturating_sub(results.len());
        let hits = search_single_demo_table(table, &rows, &query, remaining);
        results.extend(hits);

        emit_search_values_progress(
            &window,
            &job_id,
            &query,
            &database,
            (index + 1) as u64,
            total,
            results.len() as u64,
            Some(table.table_name.clone()),
            "running",
        );

        if results.len() >= limit {
            break;
        }
    }

    emit_search_values_progress(
        &window,
        &job_id,
        &query,
        &database,
        total,
        total,
        results.len() as u64,
        None,
        "completed",
    );

    Ok(results)
}

#[tauri::command]
pub async fn quick_search(
    request: QuickSearchRequest,
    state: State<'_, AppState>,
) -> Result<Vec<QuickSearchItem>, String> {
    let query = request.query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let scope = request.scope.unwrap_or_else(|| "schema".into());
    let (schema, demo_profile, demo_rows, database) = {
        let rt = state.runtime.lock().await;
        (
            rt.schema.clone(),
            rt.demo_profile,
            rt.demo_rows.clone(),
            rt.selected_database.clone(),
        )
    };
    let mut out = Vec::new();

    if scope == "schema" || scope == "all" {
        for table in &schema {
            if table.table_name.to_lowercase().contains(&query)
                || table.table_comment.to_lowercase().contains(&query)
            {
                out.push(QuickSearchItem {
                    kind: "table".into(),
                    table_name: table.table_name.clone(),
                    column_name: None,
                    label: table.table_name.clone(),
                    preview: table.table_comment.clone(),
                });
            }
            for column in &table.columns {
                if column.column_name.to_lowercase().contains(&query)
                    || column.column_comment.to_lowercase().contains(&query)
                {
                    out.push(QuickSearchItem {
                        kind: "column".into(),
                        table_name: table.table_name.clone(),
                        column_name: Some(column.column_name.clone()),
                        label: format!("{}.{}", table.table_name, column.column_name),
                        preview: column.column_comment.clone(),
                    });
                }
            }
        }
    }

    if scope == "table_data_current" || scope == "table_data_limited" || scope == "all" {
        let tables = schema
            .iter()
            .filter(|table| {
                request
                    .table_name
                    .as_ref()
                    .map(|name| table.table_name.eq_ignore_ascii_case(name))
                    .unwrap_or(true)
            })
            .take(8);
        for table in tables {
            let sampled_rows = demo_rows
                .get(&demo_row_key(&database, &table.table_name))
                .map(|rows| rows.iter().take(20).cloned().collect::<Vec<_>>())
                .unwrap_or_else(|| match demo_profile {
                    Some(DemoProfile::Stress) => sample_stress_rows(table, 20),
                    Some(DemoProfile::Performance(scenario)) => {
                        let selection =
                            crate::perf_fixture::PerfFixtureSelection::for_scenario(scenario);
                        read_fixture_page(
                            &selection,
                            table,
                            "quick-search-fixture",
                            &TablePageRequest {
                                page: Some(1),
                                page_size: Some(20),
                                offset: None,
                                include_total: Some(false),
                                filter: None,
                                sort: None,
                            },
                        )
                        .rows
                    }
                    None => Vec::new(),
                });
            for row in sampled_rows {
                if let Some((column, value)) = row
                    .iter()
                    .find(|(_, value)| value.to_lowercase().contains(&query))
                {
                    out.push(QuickSearchItem {
                        kind: "row".into(),
                        table_name: table.table_name.clone(),
                        column_name: Some(column.clone()),
                        label: table.table_name.clone(),
                        preview: format!("{column}: {value}"),
                    });
                }
            }
        }
    }

    Ok(out.into_iter().take(50).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_list_priority_defaults_to_foreground() {
        assert_eq!(
            table_list_work(None),
            (WorkClass::Foreground, FOREGROUND_DB_TIMEOUT)
        );
        assert_eq!(
            table_list_work(Some("visible")),
            (WorkClass::Foreground, FOREGROUND_DB_TIMEOUT)
        );
        assert_eq!(
            table_list_work(Some(" Background ")),
            (WorkClass::Background, BACKGROUND_SCHEMA_TIMEOUT)
        );
    }

    fn cm(name: &str, pk: bool) -> ColumnMeta {
        ColumnMeta::with_basic(name, "varchar(32)", "", pk, !pk)
    }

    fn tm(name: &str) -> TableMeta {
        TableMeta {
            primary_key_order: Vec::new(),
            table_name: name.into(),
            table_comment: String::new(),
            columns: vec![],
        }
    }

    fn table_option(name: &str) -> TableOption {
        TableOption {
            table_name: name.into(),
            table_comment: String::new(),
            column_count: None,
            data_size_bytes: None,
            modified_at: None,
            modified_source: None,
            modified_actor: None,
        }
    }

    #[test]
    fn included_table_filter_is_exact_case_insensitive_and_preserves_source_order() {
        let tables = vec![
            table_option("archive"),
            table_option("VIP_users"),
            table_option("vip_orders"),
        ];

        let filtered =
            filter_tables_by_included(tables, &["vip_orders".into(), "vip_USERS".into()]);

        assert_eq!(
            filtered
                .into_iter()
                .map(|table| table.table_name)
                .collect::<Vec<_>>(),
            vec!["VIP_users", "vip_orders"]
        );
    }

    #[test]
    fn resolve_copy_table_name_starts_at_copy1() {
        let schema = vec![tm("orders")];

        assert_eq!(resolve_copy_table_name(&schema, "orders"), "orders_copy1");
    }

    #[test]
    fn resolve_copy_table_name_skips_existing_copy_suffixes() {
        let schema = vec![tm("orders"), tm("orders_copy1"), tm("orders_copy2")];

        assert_eq!(resolve_copy_table_name(&schema, "orders"), "orders_copy3");
    }

    #[test]
    fn demo_update_cell_primary_key_conflict_detection_ignores_current_row_only() {
        let table = TableMeta {
            primary_key_order: Vec::new(),
            table_name: "player".into(),
            table_comment: String::new(),
            columns: vec![cm("id", true), cm("name", false)],
        };
        let rows = vec![
            HashMap::from([("id".into(), "1".into()), ("name".into(), "alice".into())]),
            HashMap::from([("id".into(), "2".into()), ("name".into(), "bob".into())]),
        ];

        assert_eq!(
            crate::validation::validate_cell_value(&table, &rows, 0, "id", Some("2"))
                .unwrap_err()
                .code,
            "duplicate-primary-key"
        );
        assert!(crate::validation::validate_cell_value(&table, &rows, 0, "id", Some("1")).is_ok());
        assert!(
            crate::validation::validate_cell_value(&table, &rows, 0, "name", Some("bob")).is_ok()
        );
    }

    #[test]
    fn demo_batch_update_validates_composite_primary_key_from_final_row_state() {
        let table = TableMeta {
            primary_key_order: Vec::new(),
            table_name: "account_role".into(),
            table_comment: String::new(),
            columns: vec![
                cm("account_id", true),
                cm("role_id", true),
                cm("label", false),
            ],
        };
        let mut rows = vec![
            HashMap::from([
                ("account_id".into(), "1".into()),
                ("role_id".into(), "1".into()),
                ("label".into(), "first".into()),
            ]),
            HashMap::from([
                ("account_id".into(), "2".into()),
                ("role_id".into(), "1".into()),
                ("label".into(), "second".into()),
            ]),
        ];
        let patches = vec![UpdateRowPatch {
            row_identity: HashMap::from([
                ("account_id".into(), Some("1".into())),
                ("role_id".into(), Some("1".into())),
            ]),
            changes: vec![
                CellUpdateChange {
                    column_name: "account_id".into(),
                    old_value: Some("1".into()),
                    new_value: Some("2".into()),
                },
                CellUpdateChange {
                    column_name: "role_id".into(),
                    old_value: Some("1".into()),
                    new_value: Some("2".into()),
                },
            ],
        }];

        let result = apply_demo_cell_updates(&table, &mut rows, &patches)
            .expect("the final composite key (2, 2) is unique");

        assert_eq!(result.updated, 1);
        assert!(!result.conflict);
        assert_eq!(rows[0].get("account_id").map(String::as_str), Some("2"));
        assert_eq!(rows[0].get("role_id").map(String::as_str), Some("2"));
    }

    #[test]
    fn demo_batch_update_rejects_duplicate_final_composite_key_atomically() {
        let table = TableMeta {
            primary_key_order: Vec::new(),
            table_name: "account_role".into(),
            table_comment: String::new(),
            columns: vec![cm("account_id", true), cm("role_id", true)],
        };
        let mut rows = vec![
            HashMap::from([
                ("account_id".into(), "1".into()),
                ("role_id".into(), "1".into()),
            ]),
            HashMap::from([
                ("account_id".into(), "2".into()),
                ("role_id".into(), "2".into()),
            ]),
        ];
        let original_rows = rows.clone();
        let patches = vec![UpdateRowPatch {
            row_identity: HashMap::from([
                ("account_id".into(), Some("1".into())),
                ("role_id".into(), Some("1".into())),
            ]),
            changes: vec![
                CellUpdateChange {
                    column_name: "account_id".into(),
                    old_value: Some("1".into()),
                    new_value: Some("2".into()),
                },
                CellUpdateChange {
                    column_name: "role_id".into(),
                    old_value: Some("1".into()),
                    new_value: Some("2".into()),
                },
            ],
        }];

        let error = apply_demo_cell_updates(&table, &mut rows, &patches)
            .expect_err("the final composite key duplicates the second row");

        assert_eq!(error, "主键重复，不能保存");
        assert_eq!(rows, original_rows);
    }

    #[test]
    fn validation_rejects_duplicate_and_incomplete_composite_primary_keys() {
        let table = TableMeta {
            primary_key_order: Vec::new(),
            table_name: "account_role".into(),
            table_comment: String::new(),
            columns: vec![
                cm("account_id", true),
                cm("role_id", true),
                cm("label", false),
            ],
        };
        let rows = vec![HashMap::from([
            ("account_id".into(), "42".into()),
            ("role_id".into(), "7".into()),
            ("label".into(), "admin".into()),
        ])];
        let duplicate = HashMap::from([
            ("account_id".into(), "42".into()),
            ("role_id".into(), "7".into()),
            ("label".into(), "copy".into()),
        ]);
        let partial = HashMap::from([
            ("account_id".into(), "42".into()),
            ("label".into(), "auto-role".into()),
        ]);

        assert_eq!(
            crate::validation::validate_row_draft(&table, &rows, &duplicate)
                .unwrap_err()
                .code,
            "duplicate-primary-key"
        );
        assert_eq!(
            crate::validation::validate_row_draft(&table, &rows, &partial)
                .unwrap_err()
                .code,
            "required"
        );
    }

    #[test]
    fn register_account_does_not_read_server_url_while_holding_account_config_lock() {
        let source = include_str!("commands.rs").replace("\r\n", "\n");
        let account_marker = ["// ---- Account", " & shared audit-log commands"].concat();
        let register_marker = ["pub async fn register", "_account"].concat();
        let login_marker = ["#[tauri::command]\npub async fn login", "_account"].concat();
        let account_section = source
            .split(&account_marker)
            .nth(1)
            .expect("account command section should be present");
        let register_body = account_section
            .split(&register_marker)
            .nth(1)
            .and_then(|tail| tail.split(&login_marker).next())
            .expect("register_account body should be present");

        assert!(
            !register_body.contains(
                "let config = state.account.config.lock().await;\n        crate::account::server_url(&state)\n            .await"
            ),
            "register_account must not call server_url while already holding account.config"
        );
    }

    #[test]
    fn committed_audit_rows_trigger_immediate_outbox_sync() {
        let source = include_str!("commands.rs").replace("\r\n", "\n");
        let mark_audit_body = source
            .split("async fn mark_audit(")
            .nth(1)
            .and_then(|tail| tail.split("/// Read a row's full preimage").next())
            .expect("mark_audit helper should exist");
        assert!(
            mark_audit_body.contains("trigger_immediate_sync"),
            "single-row committed audit writes should trigger immediate central sync"
        );

        let delete_rows_body = source
            .split("pub async fn delete_rows(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn search_values(").next())
            .expect("delete_rows command should exist");
        assert!(
            delete_rows_body.contains("trigger_immediate_sync"),
            "committed batch deletes should trigger immediate central sync"
        );
    }

    #[test]
    fn batch_import_requires_pending_audit_before_mysql_writes() {
        let source = include_str!("commands.rs");
        let body = source
            .split("pub async fn import_rows(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn replace_table_rows(").next())
            .expect("import_rows body should exist");

        assert!(body.contains("audit::record_pending"));
        assert!(!body.contains("best_effort_audit"));
    }

    #[test]
    fn batch_import_preview_returns_before_audit_or_database_writes() {
        let source = include_str!("commands.rs").replace("\r\n", "\n");
        let body = source
            .split("pub async fn import_rows(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn replace_table_rows(").next())
            .expect("import_rows body should exist");
        let preview_return = body
            .find("if preview_only {\n            return Ok(result);\n        }")
            .expect("preview-only import should return after planning");
        let audit_start = body
            .find("audit::ensure_audit_pool")
            .expect("normal imports should initialize audit storage");

        assert!(
            preview_return < audit_start,
            "preview-only import must return before audit initialization and MySQL writes"
        );
        assert!(body.contains("if !preview_only && (result.inserted > 0 || result.updated > 0)"));
    }

    #[test]
    fn table_replacement_preview_classifies_every_change_and_identifies_deletions() {
        let table = TableMeta {
            primary_key_order: Vec::new(),
            table_name: "items".into(),
            table_comment: String::new(),
            columns: vec![cm("id", true), cm("name", false)],
        };
        let incoming = vec![
            HashMap::from([("id".into(), "1".into()), ("name".into(), "after".into())]),
            HashMap::from([("id".into(), "2".into()), ("name".into(), "same".into())]),
            HashMap::from([("id".into(), "4".into()), ("name".into(), "added".into())]),
        ];
        let current_by_signature = [
            HashMap::from([("id".into(), "1".into()), ("name".into(), "before".into())]),
            HashMap::from([("id".into(), "2".into()), ("name".into(), "same".into())]),
            HashMap::from([("id".into(), "3".into()), ("name".into(), "removed".into())]),
        ]
        .into_iter()
        .map(|row| {
            let signature = crate::table_replace::identity_signature(&table, &row).unwrap();
            let existing = row
                .iter()
                .map(|(column, value)| (column.clone(), Some(value.clone())))
                .collect::<crate::batch_import::ExistingRow>();
            (signature, (existing, row))
        })
        .collect();

        let result = build_table_replacement_preview(
            "catalog",
            &table,
            &HashSet::from(["id".into(), "name".into()]),
            incoming,
            current_by_signature,
        )
        .expect("replacement preview should classify every row");

        assert_eq!(result.inserted, 1);
        assert_eq!(result.updated, 1);
        assert_eq!(result.unchanged, 1);
        assert_eq!(result.deleted, 1);
        assert_eq!(
            result.row_statuses,
            vec!["updated", "unchanged", "inserted"]
        );
        assert_eq!(
            result
                .outcomes
                .iter()
                .map(|outcome| outcome.status.as_str())
                .collect::<Vec<_>>(),
            vec!["deleted", "updated", "inserted"]
        );
        assert_eq!(
            result.outcomes[0].preview.identity.get("id"),
            Some(&"3".to_string())
        );
        assert!(result.outcomes[0].preview.changes.is_empty());
        assert_eq!(result.outcomes[1].index, Some(0));
        assert_eq!(result.outcomes[2].index, Some(2));
    }

    #[test]
    fn table_replacement_preview_keeps_updated_details_when_deletions_fill_the_budget() {
        let table = TableMeta {
            primary_key_order: Vec::new(),
            table_name: "items".into(),
            table_comment: String::new(),
            columns: vec![cm("id", true), cm("name", false)],
        };
        let incoming = vec![HashMap::from([
            ("id".into(), "0".into()),
            ("name".into(), "after".into()),
        ])];
        let mut current_rows = vec![HashMap::from([
            ("id".into(), "0".into()),
            ("name".into(), "before".into()),
        ])];
        for index in 1..=TABLE_REPLACEMENT_PREVIEW_OUTCOME_LIMIT {
            current_rows.push(HashMap::from([
                ("id".into(), index.to_string()),
                ("name".into(), format!("removed-{index}")),
            ]));
        }
        let current_by_signature = current_rows
            .into_iter()
            .map(|row| {
                let signature = crate::table_replace::identity_signature(&table, &row).unwrap();
                let existing = row
                    .iter()
                    .map(|(column, value)| (column.clone(), Some(value.clone())))
                    .collect::<crate::batch_import::ExistingRow>();
                (signature, (existing, row))
            })
            .collect();

        let result = build_table_replacement_preview(
            "catalog",
            &table,
            &HashSet::from(["id".into(), "name".into()]),
            incoming,
            current_by_signature,
        )
        .expect("replacement preview should classify every row");

        assert_eq!(result.updated, 1);
        assert_eq!(
            result.deleted,
            TABLE_REPLACEMENT_PREVIEW_OUTCOME_LIMIT as u64
        );
        assert_eq!(
            result.outcomes.len(),
            TABLE_REPLACEMENT_PREVIEW_OUTCOME_LIMIT + 1
        );
        assert!(result
            .outcomes
            .iter()
            .any(|outcome| outcome.status == "updated"));
    }

    #[test]
    fn table_replacement_preview_returns_before_audit_or_database_writes() {
        let source = include_str!("commands.rs").replace("\r\n", "\n");
        let body = source
            .split("pub async fn replace_table_rows(")
            .nth(1)
            .and_then(|tail| tail.split("fn truncate_batch_import_preview_value(").next())
            .expect("replace_table_rows body should exist");
        let preview_start = body
            .find("if request.preview_only {")
            .expect("table replacement preview branch should exist");
        let preview_end = body[preview_start..]
            .find("        let projection = projection_for(&backup_columns);")
            .map(|offset| preview_start + offset)
            .expect("normal table replacement should start after preview planning");
        let preview_body = &body[preview_start..preview_end];
        let audit_start = body
            .find("audit::ensure_audit_pool")
            .expect("normal table replacement should initialize audit storage");

        assert!(preview_body.contains("return build_table_replacement_preview("));
        assert!(preview_end < audit_start);
        assert!(!preview_body.contains("FOR UPDATE"));
        assert!(!preview_body.contains(".begin()"));
        assert!(!preview_body.contains("write_import_backup_async"));
    }

    #[test]
    fn insert_result_returns_the_database_row_and_identity() {
        let result = InsertRowResult {
            affected: 1,
            row: Some(HashMap::from([
                ("id".into(), "42".into()),
                ("status".into(), "active".into()),
            ])),
            row_identity: HashMap::from([("id".into(), "42".into())]),
            null_columns: vec!["note".into()],
        };

        let json = serde_json::to_value(result).expect("insert result should serialize");
        assert_eq!(json["affected"], 1);
        assert_eq!(json["row"]["id"], "42");
        assert_eq!(json["rowIdentity"]["id"], "42");
        assert_eq!(json["nullColumns"][0], "note");
    }

    #[test]
    fn grid_insert_and_delete_require_audit_before_mysql_commit() {
        let source = include_str!("commands.rs");
        for (command, next_command) in [
            ("insert_row", "import_rows"),
            ("delete_rows", "search_values"),
        ] {
            let body = source
                .split(format!("pub async fn {command}(").as_str())
                .nth(1)
                .and_then(|tail| {
                    tail.split(format!("pub async fn {next_command}(").as_str())
                        .next()
                })
                .unwrap_or_else(|| panic!("{command} body should exist"));

            assert!(
                body.contains("audit::record_pending"),
                "{command} must persist audit first"
            );
            assert!(
                !body.contains("best_effort_audit"),
                "{command} must not ignore audit failure"
            );
            assert!(
                body.contains("mark_committed_required") || body.contains("finalize_insert_audit"),
                "{command} must require committed audit"
            );
            assert!(
                body.contains("tx.rollback().await"),
                "{command} must roll back on failure"
            );
            assert!(
                body.contains("tx.commit().await"),
                "{command} must commit atomically"
            );
        }
    }

    #[test]
    fn grid_cell_updates_are_atomic_and_fail_closed_when_audit_is_unavailable() {
        let source = include_str!("commands.rs");
        let body = source
            .split("async fn update_cells_impl(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn insert_row(").next())
            .expect("shared update implementation should exist");

        assert!(source.contains("pub async fn update_cells("));
        assert!(body.contains("audit::record_pending"));
        assert!(!body.contains("best_effort_audit"));
        assert!(body.contains("mark_committed_required_batch"));
        assert!(body.contains("tx.rollback().await"));
        assert!(body.contains("tx.commit().await"));
    }

    #[test]
    fn update_request_deserializes_null_and_empty_row_identity_values_distinctly() {
        let null_request: UpdateCellRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "rowIdentity": { "nullable_key": null, "empty_key": "" },
            "columnName": "note",
            "oldValue": "before",
            "newValue": "after"
        }))
        .expect("typed row identity should deserialize");

        assert_eq!(null_request.row_identity.get("nullable_key"), Some(&None));
        assert_eq!(
            null_request.row_identity.get("empty_key"),
            Some(&Some(String::new()))
        );
    }

    #[test]
    fn batch_import_commits_mysql_only_after_required_audit_finalization() {
        let source = include_str!("commands.rs");
        let body = source
            .split("pub async fn import_rows(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn replace_table_rows(").next())
            .expect("import_rows body should exist");

        assert!(body.contains("mark_committed_required"));
        assert!(body.contains("query.execute(&mut *tx)"));
        assert!(body.contains("tx.commit().await"));
        assert!(body.contains("tx.rollback().await"));
    }

    #[test]
    fn batch_import_rechecks_typed_equality_after_recording_update_audit() {
        let source = include_str!("commands.rs");
        let body = source
            .split("pub async fn import_rows(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn replace_table_rows(").next())
            .expect("import_rows body should exist");
        let pending_audit = body
            .find("audit::record_pending")
            .expect("pending audit should exist");
        let equality_check = body
            .find("build_expected_values_lookup_plan")
            .expect("typed equality recheck should exist");

        // The typed-equality recheck moved post-execution (rows_affected == 0):
        // it runs after the pending audit batch is recorded, and a matching
        // recheck marks that pending UPDATE aborted as the row was unchanged.
        assert!(pending_audit < equality_check);
    }

    #[test]
    fn batch_import_does_not_decode_old_values_as_null_on_error() {
        let source = include_str!("commands.rs");
        let body = source
            .split("pub async fn import_rows(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn replace_table_rows(").next())
            .expect("import_rows body should exist");

        assert!(!body.contains("try_get::<Option<String>, _>(column_index)\n                                        .ok()\n                                        .flatten()"));
        assert!(body.contains("读取导入行旧值失败"));
    }

    #[test]
    fn batch_import_coalesces_immediate_audit_sync_per_batch() {
        let source = include_str!("commands.rs");
        let body = source
            .split("pub async fn import_rows(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn replace_table_rows(").next())
            .expect("import_rows body should exist");

        assert!(body.contains("let mut audit_sync_needed = false"));
        assert!(body.contains("if audit_sync_needed"));
        assert_eq!(body.matches("trigger_immediate_sync").count(), 1);
    }

    #[test]
    fn table_replacement_is_atomic_audited_and_coalesces_sync() {
        let source = include_str!("commands.rs");
        let body = source
            .split("pub async fn replace_table_rows(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn delete_rows(").next())
            .expect("replace_table_rows body should exist");

        assert!(body.contains("FOR UPDATE"));
        assert!(body.contains("audit::record_pending"));
        assert!(body.contains("audit::mark_committed"));
        assert!(body.contains("tx.rollback().await"));
        assert!(body.contains("tx.commit().await"));
        assert_eq!(body.matches("trigger_immediate_sync").count(), 1);
    }

    #[test]
    fn session_write_commands_reuse_generation_checked_schema_snapshots() {
        let source = include_str!("commands.rs").replace("\r\n", "\n");
        let update_body = source
            .split("async fn update_cells_impl(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn insert_row(").next())
            .expect("shared update implementation should be present");
        assert!(update_body.contains("fresh_session_schema("));
        assert!(!update_body.contains("read_schema("));
        let commands = [
            ("insert_row", "import_rows"),
            ("import_rows", "replace_table_rows"),
            ("replace_table_rows", "delete_rows"),
            ("delete_rows", "search_values"),
        ];

        for (command, next_command) in commands {
            let marker = format!("pub async fn {command}(");
            let next_marker = format!("pub async fn {next_command}(");
            let body = source
                .split(marker.as_str())
                .nth(1)
                .and_then(|tail| tail.split(next_marker.as_str()).next())
                .unwrap_or_else(|| panic!("{command} command body should be present"));
            assert!(
                body.contains("fresh_session_schema("),
                "{command} must reuse the shared generation-checked session schema"
            );
            assert!(
                !body.contains("read_schema("),
                "{command} must not bypass the schema cache with a direct metadata read"
            );
        }
    }

    #[test]
    fn successful_mutations_invalidate_shared_table_count_generations() {
        let source = include_str!("commands.rs").replace("\r\n", "\n");
        let update_body = source
            .split("async fn update_cells_impl(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn insert_row(").next())
            .expect("shared update implementation should be present");
        assert!(update_body.contains("invalidate_table_count("));
        let contracts = [
            ("insert_row", "import_rows", "invalidate_table_count("),
            (
                "import_rows",
                "replace_table_rows",
                "invalidate_table_count(",
            ),
            (
                "replace_table_rows",
                "delete_rows",
                "invalidate_table_count(",
            ),
            ("delete_rows", "search_values", "invalidate_table_count("),
            (
                "sync_database_overwrite",
                "copy_tables",
                "invalidate_database_count(",
            ),
            ("copy_tables", "rename_table", "invalidate_table_count("),
            (
                "rename_table",
                "resolve_copy_table_name",
                "invalidate_renamed_count(",
            ),
            (
                "drop_tables",
                "drop_tables_mysql",
                "invalidate_table_count(",
            ),
            (
                "apply_table_design_change",
                "open_session_for_live_connection",
                "invalidate_table_count(",
            ),
            (
                "rollback_audit_entry",
                "record_rollback_audit",
                "invalidate_table_count(",
            ),
            (
                "restore_snapshot",
                "read_snapshot_database",
                "invalidate_database_count(",
            ),
        ];

        for (owner, next_owner, invalidation) in contracts {
            let start_marker = format!("pub async fn {owner}(");
            let end_marker = format!("fn {next_owner}(");
            let public_end_marker = format!("pub async fn {next_owner}(");
            let body = source
                .split(start_marker.as_str())
                .nth(1)
                .and_then(|tail| {
                    tail.split(public_end_marker.as_str())
                        .next()
                        .and_then(|body| body.split(end_marker.as_str()).next())
                })
                .unwrap_or_else(|| panic!("{owner} mutation body should be present"));
            assert!(
                body.contains(invalidation),
                "{owner} must call {invalidation} after a successful data mutation",
            );
        }
    }

    #[test]
    fn table_search_commands_are_cancellable_and_use_the_shared_background_scheduler() {
        let source = include_str!("commands.rs").replace("\r\n", "\n");
        let search_section = source
            .split("async fn run_table_search_page(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn update_cell(").next())
            .expect("table search execution and commands must precede update_cell");

        assert!(search_section.contains("pub async fn begin_table_search("));
        assert!(search_section.contains("pub async fn next_table_search_page("));
        assert!(search_section.contains("pub fn cancel_table_search("));
        assert!(search_section.contains("state.table_search"));
        assert!(search_section.contains(".work_scheduler"));
        assert!(search_section.contains("WorkClass::Background"));
        assert!(search_section.contains("&job.cancellation"));
    }

    #[test]
    fn table_open_and_page_reads_keep_foreground_priority_over_schema_prefetch() {
        let source = include_str!("commands.rs").replace("\r\n", "\n");
        let open_body = source
            .split("pub async fn open_table_session(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn close_table_session(").next())
            .expect("open_table_session body should exist");
        assert!(open_body.contains("SchemaCacheLoadMode::Foreground"));
        assert!(open_body.contains("WorkClass::Foreground"));

        let fresh_schema = source
            .split("async fn fresh_session_schema(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn open_table_session(").next())
            .expect("fresh_session_schema body should exist");
        assert!(fresh_schema.contains("SchemaCacheLoadMode::Foreground"));
        assert!(!fresh_schema.contains("SchemaCacheLoadMode::Coalesced"));

        let page_body = source
            .split("pub async fn fetch_table_page(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn fetch_table_count(").next())
            .expect("fetch_table_page body should exist");
        assert!(page_body.contains("WorkClass::Foreground"));

        let schema_batch = source
            .split("pub async fn get_table_schemas(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn get_table_schema(").next())
            .expect("get_table_schemas body should exist");
        assert!(schema_batch.contains("SchemaCacheLoadMode::Coalesced"));

        let search_values = source
            .split("pub async fn search_values(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn quick_search(").next())
            .expect("search_values body should exist");
        assert!(search_values.contains("WorkClass::Background"));
    }

    #[test]
    fn table_search_commands_are_registered_with_tauri() {
        let source = include_str!("lib.rs").replace("\r\n", "\n");

        assert!(source.contains("commands::begin_table_search,"));
        assert!(source.contains("commands::next_table_search_page,"));
        assert!(source.contains("commands::cancel_table_search,"));
    }

    #[test]
    fn schema_mutation_commands_invalidate_the_cache_at_their_owning_boundary() {
        let source = include_str!("commands.rs").replace("\r\n", "\n");
        let contracts = [
            (
                "sync_database_overwrite",
                "copy_tables",
                "invalidate_database(",
            ),
            ("copy_tables", "rename_table", "invalidate_table_schema("),
            (
                "rename_table",
                "resolve_copy_table_name",
                "invalidate_renamed_schema(",
            ),
            (
                "drop_tables",
                "drop_tables_mysql",
                "invalidate_table_schema(",
            ),
            (
                "apply_table_design_change",
                "open_session_for_live_connection",
                "invalidate_table_schema(",
            ),
            (
                "connect_mysql_and_store",
                "connect_clickhouse_and_store",
                "invalidate_connection(",
            ),
            (
                "connect_clickhouse_and_store",
                "test_database_connection",
                "invalidate_connection(",
            ),
            (
                "remove_connection",
                "list_snapshots",
                "invalidate_connection(",
            ),
            (
                "restore_snapshot",
                "read_snapshot_database",
                "invalidate_database(",
            ),
        ];

        for (owner, next_owner, invalidation) in contracts {
            let marker = format!("fn {owner}(");
            let public_marker = format!("pub async fn {owner}(");
            let start = source
                .find(public_marker.as_str())
                .or_else(|| source.find(marker.as_str()))
                .unwrap_or_else(|| panic!("{owner} owner should be present"));
            let tail = &source[start..];
            let next_marker = format!("fn {next_owner}(");
            let public_next_marker = format!("pub async fn {next_owner}(");
            let end = tail
                .find(public_next_marker.as_str())
                .filter(|index| *index > 0)
                .or_else(|| tail.find(next_marker.as_str()).filter(|index| *index > 0))
                .unwrap_or(tail.len());
            let body = &tail[..end];
            assert!(
                body.contains(invalidation),
                "{owner} must call {invalidation} after a successful schema mutation"
            );
        }
    }

    #[test]
    fn selecting_a_stress_database_resolves_its_schema_before_replacing_the_visible_source() {
        let mut runtime = RuntimeState::new(
            None,
            RuntimeOptions {
                demo_profile: Some(DemoProfile::Stress),
            },
        );
        let connection_id = runtime.selected_connection_id.clone();
        let original_database = runtime.selected_database.clone();
        let target_database = stress_databases(&connection_id)
            .into_iter()
            .find(|database| database != &original_database)
            .expect("stress fixture should expose a second database");
        let expected_names = stress_schema_for(&target_database)
            .into_iter()
            .map(|table| table.table_name)
            .collect::<Vec<_>>();

        let tables = select_demo_database(&mut runtime, &connection_id, &target_database);

        assert_eq!(runtime.selected_database, target_database);
        assert_eq!(
            tables
                .into_iter()
                .map(|table| table.table_name)
                .collect::<Vec<_>>(),
            expected_names
        );
        assert_eq!(
            runtime
                .schema
                .iter()
                .map(|table| table.table_name.clone())
                .collect::<Vec<_>>(),
            expected_names
        );
    }

    fn design_draft_from(meta: &TableDesignMeta) -> TableDesignDraft {
        TableDesignDraft {
            table_comment: meta.table_comment.clone(),
            columns: meta
                .columns
                .iter()
                .map(|column| ColumnDesignDraft {
                    original_name: column.column_name.clone(),
                    name: column.column_name.clone(),
                    data_type: column.data_type.clone(),
                    unsigned: None,
                    length: column.length,
                    scale: column.scale,
                    nullable: column.is_nullable,
                    primary_key: column.is_primary_key,
                    primary_key_ordinal: column.primary_key_ordinal,
                    default_mode: column.default_mode.clone(),
                    default_value: column.default_value.clone(),
                    comment: column.column_comment.clone(),
                })
                .collect(),
        }
    }

    #[test]
    fn demo_get_table_design_returns_expected_metadata() {
        let schema = crate::demo::demo_schema();

        let design = demo_table_design_from_schema("demo", "game_db", "player", &schema)
            .expect("demo design should exist");

        assert_eq!(design.source.connection_id, "demo");
        assert_eq!(design.source.database, "game_db");
        assert_eq!(design.table_name, "player");
        assert_eq!(design.table_comment, "玩家账号表");
        let username = design
            .columns
            .iter()
            .find(|column| column.column_name == "username")
            .expect("username column");
        assert_eq!(username.column_type, "varchar(32)");
        assert_eq!(username.data_type, "varchar");
        assert_eq!(username.length, Some(32));
        assert!(username.is_supported);
        assert!(!design
            .schema_signature
            .clone()
            .unwrap_or_default()
            .is_empty());
    }

    #[test]
    fn demo_unsigned_changes_match_preview_and_preserve_omitted_flags() {
        let mut schema = vec![TableMeta {
            table_name: "scores".into(), table_comment: String::new(), primary_key_order: vec![],
            columns: vec![ColumnMeta::with_basic("score", "int", String::new(), false, true)],
        }];
        let mut rows = HashMap::new();
        for unsigned in [Some(true), None, Some(false)] {
            let current = demo_table_design_from_schema("demo", "game_db", "scores", &schema).unwrap();
            let mut draft = design_draft_from(&current);
            draft.columns[0].unsigned = unsigned;
            draft.columns[0].comment = format!("{unsigned:?}");
            let preview = crate::ddl::preview_table_design_change(&current, &draft).unwrap();
            apply_demo_table_design_change(&mut schema, &mut rows, ApplyTableDesignRequest {
                connection_id: "demo".into(), database: "game_db".into(), table_name: "scores".into(), draft,
                schema_signature: Some(preview.schema_signature), source_signature: Some(preview.source_signature),
                preview_signature: Some(preview.preview_signature),
            }, None).unwrap();
            assert_eq!(schema[0].columns[0].is_unsigned, unsigned != Some(false));
            assert_eq!(schema[0].columns[0].column_type.contains("unsigned"), unsigned != Some(false));
        }
    }

    #[test]
    fn demo_preview_and_apply_table_comment_and_column_rename_mutates_schema_and_rows() {
        let mut schema = crate::demo::demo_schema();
        let mut rows = HashMap::from([(
            demo_row_key("game_db", "player"),
            vec![HashMap::from([
                ("id".into(), "1".into()),
                ("username".into(), "alice".into()),
                ("nickname".into(), "Ali".into()),
            ])],
        )]);
        let design = demo_table_design_from_schema("demo", "game_db", "player", &schema)
            .expect("demo design should exist");
        let mut draft = design_draft_from(&design);
        draft.table_comment = "玩家账号表 - applied".into();
        let username = draft
            .columns
            .iter_mut()
            .find(|column| column.original_name == "username")
            .expect("username draft");
        username.name = "login_name".into();
        username.length = Some(48);
        username.comment = "登录名".into();
        let preview = crate::ddl::preview_table_design_change(&design, &draft)
            .expect("preview should succeed");

        let result = apply_demo_table_design_change(
            &mut schema,
            &mut rows,
            ApplyTableDesignRequest {
                connection_id: "demo".into(),
                database: "game_db".into(),
                table_name: "player".into(),
                draft,
                schema_signature: Some(preview.schema_signature.clone()),
                source_signature: None,
                preview_signature: Some(preview.preview_signature.clone()),
            },
            None,
        )
        .expect("apply should succeed");

        assert!(result.applied);
        assert_eq!(result.schema.table_comment, "玩家账号表 - applied");
        assert!(result
            .schema
            .columns
            .iter()
            .any(|column| column.column_name == "login_name"));
        assert_eq!(
            rows[&demo_row_key("game_db", "player")][0].get("login_name"),
            Some(&"alice".to_string())
        );
        assert!(!rows[&demo_row_key("game_db", "player")][0].contains_key("username"));
    }

    #[test]
    fn demo_apply_added_column_mutates_schema_and_materialized_rows() {
        let mut schema = crate::demo::demo_schema();
        let mut rows = HashMap::from([(
            demo_row_key("game_db", "player"),
            vec![HashMap::from([
                ("id".into(), "1".into()),
                ("username".into(), "alice".into()),
                ("nickname".into(), "Ali".into()),
            ])],
        )]);
        let design = demo_table_design_from_schema("demo", "game_db", "player", &schema)
            .expect("demo design should exist");
        let mut draft = design_draft_from(&design);
        draft.columns.insert(
            1,
            ColumnDesignDraft {
                original_name: String::new(),
                name: "score".into(),
                data_type: "int".into(),
                unsigned: None,
                length: None,
                scale: None,
                nullable: true,
                primary_key: false,
                primary_key_ordinal: None,
                default_mode: "value".into(),
                default_value: Some("0".into()),
                comment: "评分".into(),
            },
        );
        let preview = crate::ddl::preview_table_design_change(&design, &draft)
            .expect("preview should support adding a column");

        let result = apply_demo_table_design_change(
            &mut schema,
            &mut rows,
            ApplyTableDesignRequest {
                connection_id: "demo".into(),
                database: "game_db".into(),
                table_name: "player".into(),
                draft,
                schema_signature: Some(preview.schema_signature.clone()),
                source_signature: None,
                preview_signature: Some(preview.preview_signature.clone()),
            },
            None,
        )
        .expect("apply should succeed");

        let applied_names = result
            .schema
            .columns
            .iter()
            .map(|column| column.column_name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(applied_names[..3], ["id", "score", "username"]);
        assert_eq!(
            rows[&demo_row_key("game_db", "player")][0].get("score"),
            Some(&"0".to_string())
        );
    }

    #[test]
    fn demo_apply_allows_compatible_text_to_integer_values() {
        let mut schema = crate::demo::demo_schema();
        let row_key = demo_row_key("game_db", "player");
        let mut rows = HashMap::from([(
            row_key.clone(),
            vec![
                HashMap::from([("id".into(), "1".into()), ("username".into(), "100".into())]),
                HashMap::from([("id".into(), "2".into()), ("username".into(), "-20".into())]),
            ],
        )]);
        let design = demo_table_design_from_schema("demo", "game_db", "player", &schema)
            .expect("demo design should exist");
        let mut draft = design_draft_from(&design);
        let username = draft
            .columns
            .iter_mut()
            .find(|column| column.original_name == "username")
            .expect("username draft");
        username.data_type = "int".into();
        username.length = None;
        let preview = crate::ddl::preview_table_design_change(&design, &draft)
            .expect("preview should succeed");

        let result = apply_demo_table_design_change(
            &mut schema,
            &mut rows,
            ApplyTableDesignRequest {
                connection_id: "demo".into(),
                database: "game_db".into(),
                table_name: "player".into(),
                draft,
                schema_signature: Some(preview.schema_signature.clone()),
                source_signature: None,
                preview_signature: Some(preview.preview_signature.clone()),
            },
            None,
        )
        .expect("compatible values should allow the type change");

        assert_eq!(
            result
                .schema
                .columns
                .iter()
                .find(|column| column.column_name == "username")
                .map(|column| column.column_type.as_str()),
            Some("int")
        );
        assert_eq!(rows[&row_key][0].get("username"), Some(&"100".to_string()));
    }

    #[test]
    fn demo_apply_rejects_incompatible_values_without_mutating_schema() {
        let mut schema = crate::demo::demo_schema();
        let original_username_type = schema
            .iter()
            .find(|table| table.table_name == "player")
            .and_then(|table| {
                table
                    .columns
                    .iter()
                    .find(|column| column.column_name == "username")
            })
            .map(|column| column.column_type.clone());
        let row_key = demo_row_key("game_db", "player");
        let mut rows = HashMap::from([(
            row_key,
            vec![HashMap::from([
                ("id".into(), "1".into()),
                ("username".into(), "alice".into()),
            ])],
        )]);
        let design = demo_table_design_from_schema("demo", "game_db", "player", &schema)
            .expect("demo design should exist");
        let mut draft = design_draft_from(&design);
        let username = draft
            .columns
            .iter_mut()
            .find(|column| column.original_name == "username")
            .expect("username draft");
        username.data_type = "int".into();
        username.length = None;
        let preview = crate::ddl::preview_table_design_change(&design, &draft)
            .expect("preview should succeed");

        let error = apply_demo_table_design_change(
            &mut schema,
            &mut rows,
            ApplyTableDesignRequest {
                connection_id: "demo".into(),
                database: "game_db".into(),
                table_name: "player".into(),
                draft,
                schema_signature: Some(preview.schema_signature.clone()),
                source_signature: None,
                preview_signature: Some(preview.preview_signature.clone()),
            },
            None,
        )
        .expect_err("incompatible values must block the type change");

        assert!(error.contains("alice"), "{error}");
        let current_username_type = schema
            .iter()
            .find(|table| table.table_name == "player")
            .and_then(|table| {
                table
                    .columns
                    .iter()
                    .find(|column| column.column_name == "username")
            })
            .map(|column| column.column_type.clone());
        assert_eq!(current_username_type, original_username_type);
    }

    #[test]
    fn demo_apply_removed_column_mutates_schema_and_materialized_rows() {
        let mut schema = crate::demo::demo_schema();
        let mut rows = HashMap::from([(
            demo_row_key("game_db", "player"),
            vec![HashMap::from([
                ("id".into(), "1".into()),
                ("username".into(), "alice".into()),
                ("nickname".into(), "Ali".into()),
            ])],
        )]);
        let design = demo_table_design_from_schema("demo", "game_db", "player", &schema)
            .expect("demo design should exist");
        let mut draft = design_draft_from(&design);
        draft
            .columns
            .retain(|column| column.original_name != "nickname");
        let preview = crate::ddl::preview_table_design_change(&design, &draft)
            .expect("preview should support removing a column");

        let result = apply_demo_table_design_change(
            &mut schema,
            &mut rows,
            ApplyTableDesignRequest {
                connection_id: "demo".into(),
                database: "game_db".into(),
                table_name: "player".into(),
                draft,
                schema_signature: Some(preview.schema_signature.clone()),
                source_signature: None,
                preview_signature: Some(preview.preview_signature.clone()),
            },
            None,
        )
        .expect("apply should succeed");

        assert!(!result
            .schema
            .columns
            .iter()
            .any(|column| column.column_name == "nickname"));
        assert!(!rows[&demo_row_key("game_db", "player")][0].contains_key("nickname"));
    }

    #[test]
    fn stress_demo_column_rename_preserves_generated_row_values() {
        let mut schema = crate::demo::stress_schema_for("game_db_01");
        let mut rows = HashMap::new();
        let table_name = "db01_activity_0002";
        let design = demo_table_design_from_schema(
            crate::demo::stress_connection_id(),
            "game_db_01",
            table_name,
            &schema,
        )
        .expect("stress design should exist");
        let mut draft = design_draft_from(&design);
        let id = draft
            .columns
            .iter_mut()
            .find(|column| column.original_name == "id")
            .expect("id draft");
        id.name = "id2".into();
        let preview = crate::ddl::preview_table_design_change(&design, &draft)
            .expect("preview should succeed");

        apply_demo_table_design_change(
            &mut schema,
            &mut rows,
            ApplyTableDesignRequest {
                connection_id: crate::demo::stress_connection_id().into(),
                database: "game_db_01".into(),
                table_name: table_name.into(),
                draft,
                schema_signature: Some(preview.schema_signature.clone()),
                source_signature: None,
                preview_signature: Some(preview.preview_signature.clone()),
            },
            Some(DemoProfile::Stress),
        )
        .expect("apply should succeed");

        assert_eq!(
            rows[&demo_row_key("game_db_01", table_name)][0].get("id2"),
            Some(&"1".to_string()),
            "renaming a stress demo column should preserve the original generated value"
        );
        assert!(!rows[&demo_row_key("game_db_01", table_name)][0].contains_key("id"));
    }

    #[test]
    fn demo_database_sync_preview_uses_source_tables_and_exclusions() {
        let mut schemas = HashMap::from([
            (
                "game_db_01".to_string(),
                crate::demo::stress_schema_for("game_db_01"),
            ),
            (
                "game_db_04".to_string(),
                crate::demo::stress_schema_for("game_db_04"),
            ),
        ]);
        let rows = HashMap::new();

        let preview = preview_demo_database_sync(
            "game_db_01",
            "game_db_04",
            vec!["db01_activity_0002".into()],
            &mut schemas,
            &rows,
        )
        .expect("demo preview should succeed");

        assert!(preview
            .source_tables
            .contains(&"db01_0000_large_table_5000".to_string()));
        assert!(preview
            .included_tables
            .contains(&"db01_0000_large_table_5000".to_string()));
        assert!(!preview
            .included_tables
            .contains(&"db01_activity_0002".to_string()));
        assert!(preview
            .target_only_tables_to_drop
            .contains(&"db04_0000_large_table_5000".to_string()));
        assert_eq!(preview.excluded_tables, vec!["db01_activity_0002"]);
    }

    #[test]
    fn demo_database_sync_execute_isolates_target_schema_and_rows() {
        let mut schemas = HashMap::from([
            (
                "game_db_01".to_string(),
                crate::demo::stress_schema_for("game_db_01"),
            ),
            (
                "game_db_04".to_string(),
                crate::demo::stress_schema_for("game_db_04"),
            ),
        ]);
        let mut rows = HashMap::new();
        let request = SyncDatabaseOverwriteRequest {
            job_id: "demo-sync-test".into(),
            connection_id: crate::demo::stress_connection_id().into(),
            source_database: "game_db_01".into(),
            target_database: "game_db_04".into(),
            excluded_tables: vec!["db01_activity_0002".into()],
        };
        let mut events = Vec::new();

        let result = execute_demo_database_sync(&request, &mut schemas, &mut rows, |event| {
            events.push(event);
        })
        .expect("demo sync should succeed");

        assert_eq!(result.status, "succeeded");
        assert!(result
            .copied_tables
            .contains(&"db01_0000_large_table_5000".to_string()));
        assert!(!result
            .copied_tables
            .contains(&"db01_activity_0002".to_string()));
        assert!(result
            .dropped_tables
            .contains(&"db04_0000_large_table_5000".to_string()));
        assert!(schemas["game_db_04"]
            .iter()
            .any(|table| table.table_name == "db01_0000_large_table_5000"));
        assert!(!schemas["game_db_04"]
            .iter()
            .any(|table| table.table_name == "db04_0000_large_table_5000"));
        assert!(schemas["game_db_01"]
            .iter()
            .any(|table| table.table_name == "db01_0000_large_table_5000"));
        assert!(rows.contains_key("game_db_04\x1fdb01_0000_large_table_5000"));
        assert!(!rows.contains_key("game_db_01\x1fdb01_0000_large_table_5000"));
        assert!(events
            .iter()
            .any(|event| event.stage == "completed" && event.status == "succeeded"));
        assert!(events.iter().any(|event| event.stage == "verify"));
        assert!(result.message.contains("一致性校验通过"));

        let fresh = RuntimeState::new(
            None,
            RuntimeOptions {
                demo_profile: Some(DemoProfile::Stress),
            },
        );
        assert!(fresh
            .schema
            .iter()
            .any(|table| table.table_name == "db01_0000_large_table_5000"));
        assert!(fresh.demo_rows.is_empty());
    }

    #[test]
    fn demo_apply_rejects_stale_or_missing_signatures() {
        let mut schema = crate::demo::demo_schema();
        let mut rows = HashMap::new();
        let design = demo_table_design_from_schema("demo", "game_db", "player", &schema)
            .expect("demo design should exist");
        let mut draft = design_draft_from(&design);
        draft.table_comment = "stale".into();
        let preview = crate::ddl::preview_table_design_change(&design, &draft)
            .expect("preview should succeed");

        let missing = ApplyTableDesignRequest {
            connection_id: "demo".into(),
            database: "game_db".into(),
            table_name: "player".into(),
            draft: draft.clone(),
            schema_signature: Some(preview.schema_signature.clone()),
            source_signature: None,
            preview_signature: None,
        };
        assert!(
            apply_demo_table_design_change(&mut schema, &mut rows, missing, None)
                .unwrap_err()
                .to_lowercase()
                .contains("preview")
        );

        let stale = ApplyTableDesignRequest {
            connection_id: "demo".into(),
            database: "game_db".into(),
            table_name: "player".into(),
            draft,
            schema_signature: Some(preview.schema_signature),
            source_signature: None,
            preview_signature: Some("wrong-preview".into()),
        };
        assert!(
            apply_demo_table_design_change(&mut schema, &mut rows, stale, None)
                .unwrap_err()
                .to_lowercase()
                .contains("signature")
        );
    }

    #[test]
    fn table_session_cannot_open_after_its_connection_was_removed() {
        let mut runtime = RuntimeState::new(None, RuntimeOptions::for_environment(true, None));
        let connection_id = runtime.selected_connection_id.clone();
        let database = runtime.selected_database.clone();
        runtime.connections.remove(&connection_id);

        let result = open_session_for_live_connection(
            &mut runtime,
            &connection_id,
            TableSession {
                connection_id: connection_id.clone(),
                kind: DatabaseKind::MySql,
                database,
                table_name: "player".into(),
            clickhouse_url: None,
            mongodb_url: None,
            pool_key: None,
        },
            None,
        );

        let error = match result {
            Ok(_) => panic!("removed connection unexpectedly opened a session"),
            Err(error) => error,
        };
        assert_eq!(error, "连接不存在");
    }

    #[test]
    fn restored_connection_identity_matches_kind_and_exact_address() {
        let mysql = RuntimeConnection {
            id: "mysql-1".into(),
            kind: DatabaseKind::MySql,
            label: "MySQL 1".into(),
            host: "configured".into(),
            port: 3306,
            username: "mysql".into(),
            mysql_url: Some("mysql://root:secret@127.0.0.1:3306".into()),
            clickhouse_url: None,
            mongodb_url: None,
            database: None,
        };

        assert!(runtime_connection_matches_url(
            &mysql,
            DatabaseKind::MySql,
            "mysql://root:secret@127.0.0.1:3306"
        ));
        assert!(!runtime_connection_matches_url(
            &mysql,
            DatabaseKind::ClickHouse,
            "mysql://root:secret@127.0.0.1:3306"
        ));
        assert!(!runtime_connection_matches_url(
            &mysql,
            DatabaseKind::MySql,
            "mysql://root:secret@127.0.0.1:3307"
        ));
    }
}

fn runtime_connection_matches_url(
    connection: &RuntimeConnection,
    kind: DatabaseKind,
    url: &str,
) -> bool {
    connection.kind == kind
        && match kind {
            DatabaseKind::MySql => connection.mysql_url.as_deref() == Some(url),
            DatabaseKind::ClickHouse => connection.clickhouse_url.as_deref() == Some(url),
            DatabaseKind::MongoDb => connection.mongodb_url.as_deref() == Some(url),
        }
}

async fn connect_mysql_and_store(
    url: String,
    state: State<'_, AppState>,
    select: bool,
    reuse_existing: bool,
) -> Result<Vec<String>, String> {
    let pool = connect_database(&url, None).await?;
    let rows = sqlx::query("SHOW DATABASES")
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("读取数据库列表失败: {error}"))?;
    let db_list: Vec<String> = rows
        .into_iter()
        .filter_map(|row| mysql_text::string(&row, 0).ok())
        .filter(|name| {
            !matches!(
                name.as_str(),
                "information_schema" | "mysql" | "performance_schema" | "sys"
            )
        })
        .collect();
    let (id, inserted) = {
        let mut rt = state.runtime.lock().await;
        let existing_id = reuse_existing
            .then(|| {
                rt.connections.iter().find_map(|(id, connection)| {
                    runtime_connection_matches_url(connection, DatabaseKind::MySql, &url)
                        .then(|| id.clone())
                })
            })
            .flatten();
        if let Some(id) = existing_id {
            (id, false)
        } else {
            let connection_number = rt.connections.len() + 1;
            let id = format!("mysql-{connection_number}");
            rt.connections.insert(
                id.clone(),
                RuntimeConnection {
                    id: id.clone(),
                    kind: DatabaseKind::MySql,
                    label: format!("MySQL {connection_number}"),
                    host: "configured".into(),
                    port: 3306,
                    username: "mysql".into(),
                    mysql_url: Some(url),
                    clickhouse_url: None,
                    mongodb_url: None,
                    database: None,
                },
            );
            if select {
                rt.selected_connection_id = id.clone();
            }
            (id, true)
        }
    };
    if inserted {
        state.schema_cache.invalidate_connection(&id);
        state.table_counts.invalidate_connection(&id);
    }
    state
        .resources
        .get_or_connect_server(ServerPoolKey::new(&id), || async { Ok(pool) })
        .await?;
    Ok(db_list)
}

async fn connect_clickhouse_and_store(
    url: String,
    state: State<'_, AppState>,
    select: bool,
    reuse_existing: bool,
) -> Result<Vec<String>, String> {
    let db_list = clickhouse::list_databases(&url).await?;
    let (host, port, username) = clickhouse::describe_url(&url)?;
    let (id, inserted) = {
        let mut rt = state.runtime.lock().await;
        let existing_id = reuse_existing
            .then(|| {
                rt.connections.iter().find_map(|(id, connection)| {
                    runtime_connection_matches_url(connection, DatabaseKind::ClickHouse, &url)
                        .then(|| id.clone())
                })
            })
            .flatten();
        if let Some(id) = existing_id {
            (id, false)
        } else {
            let connection_number = rt.connections.len() + 1;
            let id = format!("clickhouse-{connection_number}");
            rt.connections.insert(
                id.clone(),
                RuntimeConnection {
                    id: id.clone(),
                    kind: DatabaseKind::ClickHouse,
                    label: format!("ClickHouse {connection_number}"),
                    host,
                    port,
                    username,
                    mysql_url: None,
                    clickhouse_url: Some(url),
                    mongodb_url: None,
                    database: None,
                },
            );
            if select {
                rt.selected_connection_id = id.clone();
            }
            (id, true)
        }
    };
    if inserted {
        state.schema_cache.invalidate_connection(&id);
        state.table_counts.invalidate_connection(&id);
    }
    Ok(db_list)
}

async fn connect_mongodb_and_store(
    url: String,
    state: State<'_, AppState>,
    select: bool,
    reuse_existing: bool,
) -> Result<Vec<String>, String> {
    let db_list = mongodb::list_databases(&url).await?;
    let (host, port, username) = mongodb::describe_url(&url)?;
    let (id, inserted) = {
        let mut rt = state.runtime.lock().await;
        let existing_id = reuse_existing
            .then(|| {
                rt.connections.iter().find_map(|(id, connection)| {
                    runtime_connection_matches_url(connection, DatabaseKind::MongoDb, &url)
                        .then(|| id.clone())
                })
            })
            .flatten();
        if let Some(id) = existing_id {
            (id, false)
        } else {
            let connection_number = rt.connections.len() + 1;
            let id = format!("mongodb-{connection_number}");
            rt.connections.insert(
                id.clone(),
                RuntimeConnection {
                    id: id.clone(),
                    kind: DatabaseKind::MongoDb,
                    label: format!("MongoDB {connection_number}"),
                    host,
                    port,
                    username,
                    mysql_url: None,
                    clickhouse_url: None,
                    mongodb_url: Some(url),
                    database: None,
                },
            );
            if select {
                rt.selected_connection_id = id.clone();
            }
            (id, true)
        }
    };
    if inserted {
        state.schema_cache.invalidate_connection(&id);
        state.table_counts.invalidate_connection(&id);
    }
    Ok(db_list)
}

async fn connect_and_store(
    kind: Option<String>,
    url: String,
    state: State<'_, AppState>,
    select: bool,
    reuse_existing: bool,
) -> Result<Vec<String>, String> {
    match DatabaseKind::infer(kind.as_deref(), &url) {
        DatabaseKind::MySql => connect_mysql_and_store(url, state, select, reuse_existing).await,
        DatabaseKind::ClickHouse => {
            connect_clickhouse_and_store(url, state, select, reuse_existing).await
        }
        DatabaseKind::MongoDb => connect_mongodb_and_store(url, state, select, reuse_existing).await,
    }
}

#[tauri::command]
pub async fn test_connection(kind: Option<String>, url: String) -> Result<(), String> {
    match DatabaseKind::infer(kind.as_deref(), &url) {
        DatabaseKind::MySql => test_database_connection(&url).await,
        DatabaseKind::ClickHouse => clickhouse::test_connection(&url).await,
        DatabaseKind::MongoDb => mongodb::test_connection(&url).await,
    }
}

#[tauri::command]
pub async fn add_connection(
    kind: Option<String>,
    url: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    connect_and_store(kind, url, state, true, false).await
}

#[tauri::command]
pub async fn restore_connection(
    kind: Option<String>,
    url: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    connect_and_store(kind, url, state, false, true).await
}

#[tauri::command]
pub async fn remove_connection(
    connection_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mongo_url = {
        let mut rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .remove(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        rt.sessions.invalidate_connection(&connection_id);
        if rt.selected_connection_id == connection_id {
            let next_id = rt.connections.keys().next().cloned().unwrap_or_default();
            rt.selected_connection_id = next_id.clone();
            if let Some(next) = rt.connections.get(&next_id) {
                rt.selected_database = next.database.clone().unwrap_or_default();
            } else {
                rt.selected_database.clear();
                rt.schema.clear();
            }
        }
        connection.mongodb_url
    };
    if let Some(url) = mongo_url {
        mongodb::disconnect(&url).await;
    }
    state.schema_cache.invalidate_connection(&connection_id);
    state.table_counts.invalidate_connection(&connection_id);
    state
        .table_counts
        .close_connection_pools(&connection_id)
        .await;
    state.resources.close_connection(&connection_id).await;
    let _ = app.emit(
        TABLE_SESSIONS_INVALIDATED_EVENT,
        TableSessionsInvalidatedPayload {
            connection_id,
            session_ids: Vec::new(),
            reason: "connection-removed".into(),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn save_export_file(file_name: String, data: Vec<u8>) -> Result<String, String> {
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(&file_name)
        .add_filter("Excel", &["xlsx"])
        .save_file()
        .await
        .ok_or("用户取消了保存")?;
    let path = file.path().to_path_buf();
    std::fs::write(&path, data).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn safe_export_file_name(file_name: &str, index: usize) -> String {
    let path = Path::new(file_name);
    let candidate = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        format!("table-{}.xlsx", index + 1)
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
pub async fn save_export_files(files: Vec<ExportFilePayload>) -> Result<String, String> {
    if files.is_empty() {
        return Err("没有可保存的 Excel 文件".to_string());
    }
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择批量导出目录")
        .pick_folder()
        .await
        .ok_or("用户取消了保存")?;
    let dir = folder.path().to_path_buf();
    for (index, file) in files.into_iter().enumerate() {
        let file_name = safe_export_file_name(&file.file_name, index);
        let path: PathBuf = dir.join(file_name);
        std::fs::write(&path, file.data).map_err(|e| format!("写入文件失败: {e}"))?;
    }
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_text_file(file_name: String, content: String) -> Result<String, String> {
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(&file_name)
        .add_filter("文本文件", &["txt"])
        .save_file()
        .await
        .ok_or("用户取消了保存")?;
    let path = file.path().to_path_buf();
    std::fs::write(&path, &content).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn agent_pick_project_directory() -> Result<Option<ProjectDirectoryInfo>, String> {
    crate::agent::project::pick_project_directory().await
}

#[tauri::command]
pub async fn agent_validate_project_directory(
    path: String,
) -> Result<ProjectDirectoryInfo, String> {
    Ok(crate::agent::project::validate_project_directory(path))
}

async fn enrich_agent_context(
    mut context: AgentContext,
    state: &State<'_, AppState>,
) -> AgentContext {
    let rt = state.runtime.lock().await;
    let connection = context
        .connection_id
        .as_deref()
        .and_then(|connection_id| rt.connections.get(connection_id));
    if let Some(connection) = connection {
        context.database_kind = Some(
            match connection.kind {
                DatabaseKind::MySql => "mysql",
                DatabaseKind::ClickHouse => "clickhouse",
                DatabaseKind::MongoDb => "mongodb",
            }
            .to_string(),
        );
        context.read_only = connection.kind.is_read_only();
    }
    context
}

#[tauri::command]
pub async fn agent_start_session(
    context: AgentContext,
    config: AgentConfig,
    resume_session_id: Option<String>,
    window: Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let context = enrich_agent_context(context, &state).await;
    let mut guard = state.agent_sidecar.lock().await;
    if let Some(sidecar) = guard.as_ref() {
        match sidecar
            .start_session(context.clone(), config.clone(), resume_session_id.clone())
            .await
        {
            Ok(()) => return Ok("started".into()),
            Err(_) => {
                *guard = None;
            }
        }
    }

    let sidecar = AgentSidecar::spawn(window, context, config, resume_session_id).await?;
    *guard = Some(sidecar);
    Ok("started".into())
}

#[tauri::command]
pub async fn agent_send(
    text: String,
    context: Option<AgentContext>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let context = match context {
        Some(context) => Some(enrich_agent_context(context, &state).await),
        None => None,
    };
    let guard = state.agent_sidecar.lock().await;
    let sidecar = guard.as_ref().ok_or("Agent 会话未启动")?;
    sidecar.send_message(text, context).await
}

#[tauri::command]
pub async fn agent_abort(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.agent_sidecar.lock().await;
    let sidecar = guard.as_ref().ok_or("Agent 会话未启动")?;
    sidecar.abort().await
}

#[tauri::command]
pub async fn agent_approve_tool(req_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.agent_sidecar.lock().await;
    let sidecar = guard.as_ref().ok_or("Agent 会话未启动")?;
    sidecar.send_approval_response(req_id, true, None).await
}

#[tauri::command]
pub async fn agent_deny_tool(
    req_id: String,
    message: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.agent_sidecar.lock().await;
    let sidecar = guard.as_ref().ok_or("Agent 会话未启动")?;
    sidecar.send_approval_response(req_id, false, message).await
}

#[tauri::command]
pub async fn agent_set_mode(mode: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.agent_sidecar.lock().await;
    let sidecar = guard.as_ref().ok_or("Agent 会话未启动")?;
    sidecar.set_mode(mode).await
}

#[tauri::command]
pub async fn agent_set_auto_approve(on: bool, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.agent_sidecar.lock().await;
    let sidecar = guard.as_ref().ok_or("Agent 会话未启动")?;
    sidecar.set_auto_approve(on).await
}

#[tauri::command]
pub async fn agent_list_sessions(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.agent_sidecar.lock().await;
    let sidecar = guard.as_ref().ok_or("Agent 会话未启动")?;
    sidecar.list_sessions(limit).await
}

#[tauri::command]
pub async fn agent_delete_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.agent_sidecar.lock().await;
    let sidecar = guard.as_ref().ok_or("Agent 会话未启动")?;
    sidecar.delete_session(session_id).await
}

#[tauri::command]
pub async fn agent_get_session_messages(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.agent_sidecar.lock().await;
    let sidecar = guard.as_ref().ok_or("Agent 会话未启动")?;
    sidecar.get_session_messages(session_id).await
}

// ---- Backup & audit commands ------------------------------------------------

/// Resolve (connection_id, database, mysql_url) for a snapshot/restore request,
/// falling back to the currently selected connection/database.
async fn resolve_snapshot_target(
    connection_id: Option<String>,
    database: Option<String>,
    state: &State<'_, AppState>,
) -> Result<(String, String, String), String> {
    let rt = state.runtime.lock().await;
    let connection_id = connection_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| rt.selected_connection_id.clone());
    let connection = rt
        .connections
        .get(&connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
    if connection.kind.is_read_only() {
        return Err(read_only_error(connection.kind));
    }
    reject_mongo(connection.kind, "备份快照")?;
    let mysql_url = connection
        .mysql_url
        .clone()
        .ok_or_else(|| "演示连接不支持备份，请连接真实 MySQL".to_string())?;
    let database = database
        .filter(|value| !value.trim().is_empty())
        .or_else(|| connection.database.clone())
        .unwrap_or_else(|| rt.selected_database.clone());
    if database.trim().is_empty() {
        return Err("未指定数据库".into());
    }
    Ok((connection_id, database, mysql_url))
}

#[tauri::command]
pub async fn list_audit_logs(
    request: ListAuditLogsRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<AuditLogEntry>, String> {
    let pool = audit::ensure_audit_pool(&app, &state).await?;
    audit::list_audit_logs(&pool, &request).await
}

#[tauri::command]
pub async fn clear_audit_logs(app: AppHandle, state: State<'_, AppState>) -> Result<u64, String> {
    let pool = audit::ensure_audit_pool(&app, &state).await?;
    audit::clear_audit_logs(&pool).await
}

#[tauri::command]
pub async fn rollback_audit_entry(
    request: RollbackRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RollbackResult, String> {
    let audit_pool = audit::ensure_audit_pool(&app, &state).await?;
    let entry = audit::fetch_audit_entry(&audit_pool, request.audit_id).await?;

    if entry.status != audit::STATUS_COMMITTED {
        return Ok(audit::rollback_conflict(format!(
            "该记录状态为 {}，无法回滚",
            entry.status
        )));
    }
    if entry.is_rollback {
        return Ok(audit::rollback_conflict("回滚记录不能再次回滚"));
    }
    let inverse_sql = match entry.inverse_sql.as_deref() {
        Some(sql) if !sql.trim().is_empty() => sql,
        _ => {
            return Ok(audit::rollback_conflict(
                "该修改未保存可自动回滚的逆操作（需手动还原）",
            ))
        }
    };
    if entry.rollback_strategy != audit::STRATEGY_AUTO {
        return Ok(audit::rollback_conflict("该记录需手动回滚"));
    }

    let (actor, _client_id) = crate::account::audit_actor_and_id(&app, &state).await;
    let pool =
        real_database_pool(&entry.connection_id, &entry.database, &state, &perf_context).await?;

    // For an INSERT being undone (inverse = DELETE), accept idempotent no-op if
    // the row is already gone. For a DELETE being undone (inverse = INSERT), a
    // duplicate-key error is a conflict. For an UPDATE, affected == 0 means the
    // row changed since (optimistic conflict).
    let is_undo_insert = entry.operation == "INSERT";
    if is_undo_insert {
        let exists = row_exists_for_identity(&pool, &entry).await?;
        if !exists {
            let new_id = record_rollback_audit(
                &audit_pool,
                &app,
                &state,
                &perf_context,
                &entry,
                inverse_sql,
                actor.clone(),
                uuid::Uuid::new_v4().to_string(),
            )
            .await?;
            audit::mark_rolled_back(&audit_pool, entry.id).await;
            return Ok(RollbackResult {
                rolled_back: true,
                new_audit_id: Some(new_id),
                conflict: false,
                message: "已回滚（行已不存在，按幂等处理）".into(),
            });
        }
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("开启事务失败: {error}"))?;
    let mut query = sqlx::query(inverse_sql);
    for bind in &entry.inverse_binds {
        query = query.bind(bind);
    }
    let result = query.execute(&mut *tx).await;
    match result {
        Ok(result) => {
            let affected = result.rows_affected();
            if entry.operation == "UPDATE" && affected == 0 {
                tx.rollback().await.ok();
                return Ok(audit::rollback_conflict(
                    "目标行已被修改，未回滚以避免覆盖后续变更",
                ));
            }
            tx.commit()
                .await
                .map_err(|error| format!("提交回滚事务失败: {error}"))?;
            invalidate_table_count(
                &state,
                &entry.connection_id,
                &entry.database,
                &entry.table_name,
            );
            crate::table_modified::record_local_change(
                &app,
                &state,
                &entry.connection_id,
                &entry.database,
                &[entry.table_name.as_str()],
            )
            .await;
        }
        Err(error) => {
            tx.rollback().await.ok();
            let message = error.to_string();
            if message.contains("Duplicate") || message.contains("1062") {
                return Ok(audit::rollback_conflict("目标行已存在（主键冲突），未回滚"));
            }
            return Err(format!("回滚执行失败: {message}"));
        }
    }

    let new_id = record_rollback_audit(
        &audit_pool,
        &app,
        &state,
        &perf_context,
        &entry,
        inverse_sql,
        actor.clone(),
        uuid::Uuid::new_v4().to_string(),
    )
    .await?;
    audit::mark_rolled_back(&audit_pool, entry.id).await;
    Ok(RollbackResult {
        rolled_back: true,
        new_audit_id: Some(new_id),
        conflict: false,
        message: "已回滚".into(),
    })
}

async fn record_rollback_audit(
    audit_pool: &sqlx::SqlitePool,
    app: &AppHandle,
    state: &State<'_, AppState>,
    perf_context: &PerfContext,
    entry: &audit::AuditEntry,
    executed_inverse_sql: &str,
    actor: Option<String>,
    client_id: String,
) -> Result<i64, String> {
    let span = state.perf.begin_span(
        "audit.persist_rollback",
        PerfPhase::Audit,
        Some(perf_context),
        || PerfEventDetails::stage(PerfStage::Audit),
    );
    let result = audit::record_rollback(
        audit_pool,
        &audit::AuditContext {
            connection_id: entry.connection_id.clone(),
            database: entry.database.clone(),
            table_name: entry.table_name.clone(),
            session_id: entry.session_id.clone(),
            source: audit::SOURCE_ROLLBACK,
            actor,
            client_id,
        },
        entry,
        executed_inverse_sql,
        &entry.inverse_binds,
    )
    .await;
    if let Some(span) = span {
        span.finish(
            if result.is_ok() {
                PerfOutcome::Success
            } else {
                PerfOutcome::Error
            },
            PerfEventDetails::default,
        );
    }
    let new_id = result?;
    let _ = app.emit(
        audit::BACKUP_JOB_EVENT,
        serde_json::json!({ "kind": "rollback", "database": entry.database, "table": entry.table_name }),
    );
    let enqueue_span = state.perf.begin_span(
        "audit_sync.notification_enqueue",
        PerfPhase::Audit,
        Some(perf_context),
        || PerfEventDetails::stage(PerfStage::Enqueue),
    );
    crate::audit_sync::trigger_immediate_sync(app);
    if let Some(span) = enqueue_span {
        span.finish(PerfOutcome::Success, PerfEventDetails::default);
    }
    Ok(new_id)
}

/// For undo-INSERT (inverse DELETE), probe whether the row still exists using
/// the audit record's row_identity.
async fn row_exists_for_identity(
    pool: &MySqlPool,
    entry: &audit::AuditEntry,
) -> Result<bool, String> {
    let identity: HashMap<String, String> = entry
        .row_identity
        .as_ref()
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();
    if identity.is_empty() {
        return Ok(true);
    }
    let (where_sql, values) = crate::db::build_where(&identity)?;
    let sql = format!(
        "SELECT 1 FROM {} WHERE {} LIMIT 1",
        crate::db::qualified_table(&entry.database, &entry.table_name),
        where_sql
    );
    let mut query = sqlx::query(&sql);
    for value in values {
        query = query.bind(value);
    }
    let found = query
        .fetch_optional(pool)
        .await
        .map_err(|error| format!("检查行存在失败: {error}"))?
        .is_some();
    Ok(found)
}

#[tauri::command]
pub async fn list_snapshots(
    request: ListSnapshotsRequest,
    app: AppHandle,
) -> Result<Vec<SnapshotInfo>, String> {
    let config = backup::load_config(&app);
    backup::list_snapshots(
        &app,
        &config,
        request.connection_id.as_deref(),
        request.database.as_deref(),
    )
}

#[tauri::command]
pub async fn create_snapshot(
    request: CreateSnapshotRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SnapshotInfo, String> {
    let (connection_id, database, mysql_url) =
        resolve_snapshot_target(request.connection_id, request.database, &state).await?;
    let config = backup::load_config(&app);
    backup::scheduler::run_one(&app, &connection_id, &mysql_url, &database, &config, None).await
}

#[tauri::command]
pub async fn restore_snapshot(
    request: RestoreSnapshotRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mysql_url = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        if connection.kind.is_read_only() {
            return Err(read_only_error(connection.kind));
        }
        reject_mongo(connection.kind, "还原快照")?;
        connection
            .mysql_url
            .clone()
            .ok_or_else(|| "演示连接不支持还原".to_string())?
    };
    let database = read_snapshot_database(&request.snapshot_path)?;
    let config = backup::load_config(&app);
    let pre_restore_path = backup::restore_snapshot(
        &app,
        &mysql_url,
        &request.connection_id,
        &database,
        &request.snapshot_path,
        &config,
    )
    .await?;
    state
        .schema_cache
        .invalidate_database(&request.connection_id, &database);
    invalidate_database_count(&state, &request.connection_id, &database);
    let _ = app.emit(
        audit::BACKUP_JOB_EVENT,
        serde_json::json!({ "kind": "restore", "database": database }),
    );
    Ok(serde_json::json!({
        "preRestoreSnapshotPath": pre_restore_path.to_string_lossy(),
        "database": database,
    }))
}

fn read_snapshot_database(snapshot_path: &str) -> Result<String, String> {
    let manifest_path = std::path::Path::new(snapshot_path).with_extension("manifest.json");
    let content = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("读取快照清单失败: {error}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| format!("解析快照清单失败: {error}"))?;
    manifest
        .get("database")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| "快照清单缺少数据库信息".into())
}

#[tauri::command]
pub async fn inspect_snapshot_file(
    request: InspectSnapshotFileRequest,
) -> Result<Option<SnapshotFileInspection>, String> {
    let path = if let Some(path) = request.source_path.filter(|value| !value.trim().is_empty()) {
        std::path::PathBuf::from(path)
    } else {
        let Some(file) = rfd::AsyncFileDialog::new()
            .set_title("选择要导入的快照文件")
            .add_filter("SQL 文件", &["sql"])
            .pick_file()
            .await
        else {
            return Ok(None);
        };
        file.path().to_path_buf()
    };
    let source_path = path.to_string_lossy().to_string();
    let (header, size_bytes) = backup::inspect_snapshot_file(&source_path)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let (origin_connection_id, origin_database, origin_ts) = match header {
        Some((connection, database, ts)) => (Some(connection), Some(database), Some(ts)),
        None => (None, None, None),
    };
    Ok(Some(SnapshotFileInspection {
        source_path,
        file_name,
        size_bytes,
        origin_connection_id,
        origin_database,
        origin_ts,
    }))
}

#[tauri::command]
pub async fn import_snapshot(
    request: ImportSnapshotRequest,
    app: AppHandle,
) -> Result<SnapshotInfo, String> {
    let config = backup::load_config(&app);
    let root = backup::snapshots_root(&app, &config)?;
    backup::import_snapshot_file(
        &root,
        &request.source_path,
        &request.connection_id,
        &request.database,
    )
}

fn backup_config_response(
    app: &AppHandle,
    config: BackupConfig,
) -> Result<BackupConfigResponse, String> {
    let resolved_storage_dir = backup::resolved_storage_root(app, &config)?
        .to_string_lossy()
        .to_string();
    Ok(BackupConfigResponse::from_config(
        config,
        resolved_storage_dir,
    ))
}

#[tauri::command]
pub async fn get_backup_config(app: AppHandle) -> Result<BackupConfigResponse, String> {
    backup_config_response(&app, backup::load_config(&app))
}

#[tauri::command]
pub async fn set_backup_config(
    config: BackupConfig,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BackupConfigResponse, String> {
    // If storage_dir changed, migrate the audit DB before persisting config.
    let old_config = backup::load_config(&app);
    let storage_changed = config.storage_dir.as_deref().map(str::trim)
        != old_config.storage_dir.as_deref().map(str::trim);
    if storage_changed {
        // 1. Validate the new path is writable (create_dir_all via storage_root).
        let new_storage = backup::storage_root(&app, &config)?;
        // 2. Copy old audit.sqlite to new location (skip if target exists).
        let old_storage = backup::storage_root(&app, &old_config)?;
        if old_storage != new_storage {
            audit::migrate_audit_db(&old_storage, &new_storage)?;
        }
        // 3. Persist config.
        backup::save_config(&app, &config)?;
        // 4. Reset the cached pool so next use reconnects at the new path.
        audit::reset_audit_pool(&state).await;
    } else {
        backup::save_config(&app, &config)?;
    }
    if let Ok(pool) = audit::ensure_audit_pool(&app, &state).await {
        let _ = audit::prune_audit_logs(&pool, config.audit_retention_days).await;
    }
    backup_config_response(&app, config)
}

#[tauri::command]
pub async fn prune_snapshots(
    request: PruneSnapshotsRequest,
    app: AppHandle,
) -> Result<u64, String> {
    let config = backup::load_config(&app);
    backup::prune_snapshots(
        &app,
        &config,
        request.connection_id.as_deref(),
        request.database.as_deref(),
    )
}

#[tauri::command]
pub async fn delete_snapshot(snapshot_path: String, app: AppHandle) -> Result<(), String> {
    let config = backup::load_config(&app);
    backup::delete_snapshot(&app, &config, &snapshot_path)
}

#[tauri::command]
pub async fn open_backup_path(path: String, app: AppHandle) -> Result<(), String> {
    let config = backup::load_config(&app);
    backup::open_backup_path(&app, &config, &path)
}

#[tauri::command]
pub async fn pick_backup_directory() -> Result<Option<String>, String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择备份存储位置")
        .pick_folder()
        .await;
    Ok(folder.map(|f| f.path().to_string_lossy().to_string()))
}

/// Toggle the per-database snapshot opt-in for one (connection, database).
///
/// When the current scope is `"all"` and the user disables a database, the
/// scope switches to `"selected"` and the whitelist is seeded with every
/// snapshotable database of every MySQL connection first (so only the toggled
/// one is dropped). Enabling a database always adds it to the whitelist and
/// keeps the scope `"selected"`. The returned config reflects the new state.
#[tauri::command]
pub async fn set_snapshot_enabled(
    request: SetSnapshotEnabledRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BackupConfigResponse, String> {
    let mut config = backup::load_config(&app);

    // Transition "all" -> "selected": seed the whitelist with every snapshotable
    // database so existing coverage is preserved except for the one being toggled.
    if config.databases_scope == "all" {
        config.snapshot_enabled_databases = collect_snapshotable_databases(&state).await;
        config.databases_scope = "selected".into();
    }

    let key = SnapshotDatabaseKey {
        connection_id: request.connection_id.clone(),
        database: request.database.clone(),
    };
    if request.enabled {
        if !config.snapshot_enabled_databases.contains(&key) {
            config.snapshot_enabled_databases.push(key);
        }
    } else {
        config
            .snapshot_enabled_databases
            .retain(|existing| existing != &key);
    }

    backup::save_config(&app, &config)?;
    backup_config_response(&app, config)
}

/// Enumerate (connection_id, database) pairs that the scheduler can snapshot:
/// MySQL connections with a `mysql_url`, excluding system schemas. Used to seed
/// the whitelist when switching scope from `"all"` to `"selected"`.
async fn collect_snapshotable_databases(state: &State<'_, AppState>) -> Vec<SnapshotDatabaseKey> {
    let mut out = Vec::new();
    let connections: Vec<(String, String)> = {
        let rt = state.runtime.lock().await;
        rt.connections
            .iter()
            .filter_map(|(id, connection)| {
                connection
                    .mysql_url
                    .as_ref()
                    .map(|url| (id.clone(), url.clone()))
            })
            .collect()
    };
    for (connection_id, mysql_url) in connections {
        let pool = match connect_database(&mysql_url, None).await {
            Ok(pool) => pool,
            Err(_) => continue,
        };
        let rows = sqlx::query("SHOW DATABASES").fetch_all(&pool).await;
        pool.close().await;
        let Ok(rows) = rows else { continue };
        for row in rows {
            if let Ok(name) = mysql_text::string(&row, 0) {
                if !backup::is_system_database(&name) {
                    out.push(SnapshotDatabaseKey {
                        connection_id: connection_id.clone(),
                        database: name,
                    });
                }
            }
        }
    }
    out
}

// ---- Account & shared audit-log commands ------------------------------------
//
// These commands talk to the central `dbscout-server` over HTTP. The account
// config (server URL + token session) is persisted to <app_data_dir>/account/
// session.json and held in AppState.account. Audit rows are stamped with the
// current user's display name (actor) + a client_id, and pushed to the server
// by audit_sync (background + manual).

/// Minimal percent-encoding for query-string values (RFC 3986 unreserved set).
/// Avoids pulling in a urlencoding crate just for this one call site.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let b = *byte;
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

#[tauri::command]
pub async fn get_account(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AccountView, String> {
    let _ = crate::account::ensure_loaded(&app, &state).await;
    let config = state.account.config.lock().await;
    Ok(AccountView {
        server_url: config.server_url.clone(),
        session: config.session.clone(),
    })
}

/// Non-blocking startup probe: loads persisted account settings (defaulting to
/// the team central server URL when unset) and checks whether the server is
/// reachable when no user session is signed in yet.
#[tauri::command]
pub async fn probe_account_server(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AccountStartupProbeView, String> {
    let _ = crate::account::ensure_loaded(&app, &state).await;
    let (server_url, session) = {
        let config = state.account.config.lock().await;
        (config.server_url.clone(), config.session.clone())
    };
    if session.is_some() {
        return Ok(AccountStartupProbeView {
            server_url,
            session,
            reachable: false,
        });
    }
    let reachable = match crate::account::server_url(&state).await {
        Some(base_url) => {
            crate::account::probe_server_reachable(&state.account.http, &base_url).await
        }
        None => false,
    };
    Ok(AccountStartupProbeView {
        server_url,
        session: None,
        reachable,
    })
}

#[tauri::command]
pub async fn set_account_server(
    request: SetAccountServerRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AccountView, String> {
    let _ = crate::account::ensure_loaded(&app, &state).await;
    let mut config = state.account.config.lock().await;
    config.server_url = Some(request.server_url.trim().to_string());
    let snapshot = config.clone();
    drop(config);
    crate::account::save_account(&app, &snapshot)?;
    Ok(AccountView {
        server_url: snapshot.server_url,
        session: snapshot.session,
    })
}

async fn call_server_account(
    state: &State<'_, AppState>,
    base_url: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<AccountInfo, String> {
    let url = format!("{base_url}{path}");
    let resp = state
        .account
        .http
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("无法连接中心服务: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("中心服务返回 {status}: {text}"));
    }
    resp.json::<AccountInfo>()
        .await
        .map_err(|e| format!("解析账号响应失败: {e}"))
}

#[tauri::command]
pub async fn register_account(
    request: RegisterAccountRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AccountView, String> {
    let _ = crate::account::ensure_loaded(&app, &state).await;
    let base_url = crate::account::server_url(&state)
        .await
        .ok_or_else(|| "请先在设置中填写中心服务地址".to_string())?;
    let body = serde_json::json!({
        "username": request.username,
        "displayName": request.display_name,
    });
    let info = call_server_account(&state, &base_url, "/register", body).await?;
    let session = UserSession {
        user_id: info.user_id,
        username: info.username,
        display_name: info.display_name,
        token: info.token,
    };
    let view = {
        let mut config = state.account.config.lock().await;
        config.session = Some(session.clone());
        AccountView {
            server_url: config.server_url.clone(),
            session: Some(session),
        }
    };
    crate::account::save_account(&app, &{
        let config = state.account.config.lock().await;
        config.clone()
    })?;
    // Push any outbox that accumulated before login.
    let _ = crate::audit_sync::push_outbox(&app, &state).await;
    state.table_modified.clear_shared_fetch_debounce();
    Ok(view)
}

#[tauri::command]
pub async fn login_account(
    request: LoginAccountRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AccountView, String> {
    let _ = crate::account::ensure_loaded(&app, &state).await;
    let base_url = crate::account::server_url(&state)
        .await
        .ok_or_else(|| "请先在设置中填写中心服务地址".to_string())?;
    let body = serde_json::json!({ "username": request.username });
    let info = call_server_account(&state, &base_url, "/login", body).await?;
    let session = UserSession {
        user_id: info.user_id,
        username: info.username,
        display_name: info.display_name,
        token: info.token,
    };
    let view = {
        let mut config = state.account.config.lock().await;
        config.session = Some(session.clone());
        AccountView {
            server_url: config.server_url.clone(),
            session: Some(session),
        }
    };
    crate::account::save_account(&app, &{
        let config = state.account.config.lock().await;
        config.clone()
    })?;
    let _ = crate::audit_sync::push_outbox(&app, &state).await;
    state.table_modified.clear_shared_fetch_debounce();
    Ok(view)
}

#[tauri::command]
pub async fn logout_account(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AccountView, String> {
    let _ = crate::account::ensure_loaded(&app, &state).await;
    let view = {
        let mut config = state.account.config.lock().await;
        config.session = None;
        AccountView {
            server_url: config.server_url.clone(),
            session: None,
        }
    };
    crate::account::save_account(&app, &{
        let config = state.account.config.lock().await;
        config.clone()
    })?;
    Ok(view)
}

/// Fetch the shared (all-users) change-log from the central server.
#[tauri::command]
pub async fn list_shared_audit_logs(
    request: ListAuditLogsRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<SharedAuditLogEntry>, String> {
    let _ = crate::account::ensure_loaded(&app, &state).await;
    let base_url = crate::account::server_url(&state)
        .await
        .ok_or_else(|| "未配置中心服务地址".to_string())?;
    let session = crate::account::current_session(&state)
        .await
        .ok_or_else(|| "未登录".to_string())?;

    let mut params: Vec<(String, String)> = Vec::new();
    if let Some(v) = &request.connection_id {
        params.push(("connectionId".into(), v.clone()));
    }
    if let Some(v) = &request.database {
        params.push(("database".into(), v.clone()));
    }
    if let Some(v) = &request.table_name {
        params.push(("tableName".into(), v.clone()));
    }
    if let Some(v) = &request.from_ts {
        params.push(("fromTs".into(), v.clone()));
    }
    if let Some(v) = &request.to_ts {
        params.push(("toTs".into(), v.clone()));
    }
    params.push(("limit".into(), request.limit.unwrap_or(200).to_string()));
    params.push(("offset".into(), request.offset.unwrap_or(0).to_string()));
    let query = params
        .iter()
        .map(|(k, v)| format!("{}={}", k, percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let url = format!("{base_url}/audit?{query}");

    let resp = state
        .account
        .http
        .get(&url)
        .bearer_auth(&session.token)
        .send()
        .await
        .map_err(|e| format!("查询共享变更日志失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("中心服务返回 {status}: {text}"));
    }
    resp.json::<Vec<SharedAuditLogEntry>>()
        .await
        .map_err(|e| format!("解析共享变更日志失败: {e}"))
}

/// Manually trigger an outbox push now (e.g. after the user clicks "sync").
#[tauri::command]
pub async fn sync_audit_now(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AuditSyncResult, String> {
    let result = crate::audit_sync::push_outbox(&app, &state).await?;
    state.table_modified.clear_shared_fetch_debounce();
    Ok(AuditSyncResult {
        accepted: result.accepted,
        skipped: result.skipped,
    })
}

/// Re-register the global "open window" shortcut at runtime so the settings
/// dialog can rebind it without an app restart (#9). Any previous binding is
/// cleared first.
#[tauri::command]
pub fn register_global_shortcut(app: AppHandle, binding: String) -> Result<(), String> {
    let trimmed = binding.trim();
    if trimmed.is_empty() {
        return Err("快捷键不能为空".into());
    }
    let manager = app.global_shortcut();
    // Best-effort cleanup of a previously registered binding; ignore errors
    // when nothing was registered yet.
    let _ = manager.unregister_all();
    let handle = app.clone();
    manager
        .on_shortcut(trimmed, move |_app, _shortcut, event| {
            if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }
            crate::window_reveal::toggle_main_window(&handle);
        })
        .map_err(|error| format!("注册快捷键失败: {error}"))
}

/// Remove the global "open window" shortcut (used when clearing a binding).
#[tauri::command]
pub fn unregister_global_shortcut(app: AppHandle) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|error| format!("注销快捷键失败: {error}"))
}
