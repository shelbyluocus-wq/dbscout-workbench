use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sqlx::{MySqlPool, Row};
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::audit;
use crate::backup;
use crate::clickhouse;
use crate::db::{
    connect_database, escape_ident, list_tables_from_db, read_db_page, read_schema,
    read_schemas_for_tables, read_table_design, search_value_matches_in_database,
    test_database_connection,
};
use crate::demo::{
    materialize_stress_rows, read_stress_or_materialized_page, resolve_demo_table,
    sample_stress_rows, search_single_demo_table, stress_databases, stress_schema_for,
};
use crate::sync::{self, DATABASE_SYNC_PROGRESS_EVENT};
use crate::types::*;
use crate::agent::{AgentConfig, AgentContext, AgentSidecar};

const SEARCH_VALUES_TABLE_SCAN_LIMIT: usize = 1500;
const SEARCH_VALUES_PROGRESS_EVENT: &str = "search-values-progress";

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFilePayload {
    file_name: String,
    data: Vec<u8>,
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

fn no_demo_error() -> String {
    "没有可用的内置演示数据，请先新建 MySQL 连接".into()
}

fn read_only_error(kind: DatabaseKind) -> String {
    format!("{} 连接仅支持查看，不能执行写入操作", kind.label())
}

fn connection_connected(connection: &RuntimeConnection) -> bool {
    match connection.kind {
        DatabaseKind::MySql => connection.mysql_url.is_none() || connection.pool.is_some(),
        DatabaseKind::ClickHouse => connection.clickhouse_url.is_some(),
    }
}

fn demo_row_key(database: &str, table_name: &str) -> String {
    format!("{database}\x1f{table_name}")
}

/// Best-effort: write a pending audit row. Returns its id, or None if the audit
/// store is unavailable. Audit must never block a user's edit.
async fn best_effort_audit(
    app: &AppHandle,
    state: &State<'_, AppState>,
    ctx: audit::AuditContext,
    pending: audit::PendingAudit,
) -> Option<i64> {
    let pool = audit::ensure_audit_pool(app, state).await.ok()?;
    audit::record_pending(&pool, &ctx, &pending).await.ok()
}

/// Flip a pending audit row to committed (applied) or aborted (not applied).
async fn mark_audit(app: &AppHandle, state: &State<'_, AppState>, id: Option<i64>, applied: bool) {
    let Some(id) = id else { return };
    let Ok(pool) = audit::ensure_audit_pool(app, state).await else {
        return;
    };
    if applied {
        audit::mark_committed(&pool, &[id]).await;
        crate::audit_sync::trigger_immediate_sync(app);
    } else {
        audit::mark_aborted(&pool, &[id]).await;
    }
}

async fn mark_audit_many(
    app: &AppHandle,
    state: &State<'_, AppState>,
    ids: &[i64],
    applied: bool,
) {
    if ids.is_empty() {
        return;
    }
    let Ok(pool) = audit::ensure_audit_pool(app, state).await else {
        return;
    };
    if applied {
        audit::mark_committed(&pool, ids).await;
        crate::audit_sync::trigger_immediate_sync(app);
    } else {
        audit::mark_aborted(&pool, ids).await;
    }
}

/// Read a row's full preimage as a column→string map, for building the inverse
/// INSERT of a delete. Columns are CAST to CHAR so every type decodes cleanly.
async fn fetch_preimage(
    pool: &MySqlPool,
    database: &str,
    table: &str,
    columns: &[String],
    identity: &HashMap<String, String>,
) -> Result<Option<HashMap<String, String>>, String> {
    if columns.is_empty() {
        return Ok(None);
    }
    let (where_sql, values) = crate::db::build_where(identity)?;
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
        "SELECT {} FROM `{}`.`{}` WHERE {} LIMIT 1",
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
        .fetch_optional(pool)
        .await
        .map_err(|error| format!("读取前镜像失败: {error}"))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut map = HashMap::new();
    for (i, column) in columns.iter().enumerate() {
        let value = row
            .try_get::<Option<String>, _>(i)
            .ok()
            .flatten()
            .unwrap_or_default();
        map.insert(column.clone(), value);
    }
    Ok(Some(map))
}

/// After a successful INSERT, compute the row's real identity (explicit primary
/// key from the draft, or the auto_increment id) and finalize the pending audit
/// row with its inverse DELETE. Tables without a usable primary key stay manual.
async fn finalize_insert_audit_row(
    app: &AppHandle,
    state: &State<'_, AppState>,
    table_name: &str,
    audit_id: i64,
    table: &TableMeta,
    draft: &HashMap<String, String>,
    last_insert_id: u64,
) {
    let Ok(pool) = audit::ensure_audit_pool(app, state).await else {
        return;
    };
    let mut identity = HashMap::new();
    for column in table.columns.iter().filter(|column| column.is_primary_key) {
        if let Some(value) = draft.get(&column.column_name) {
            if !value.is_empty() {
                identity.insert(column.column_name.clone(), value.clone());
            }
        }
    }
    if identity.is_empty() && last_insert_id > 0 {
        if let Some(column) = table
            .columns
            .iter()
            .find(|column| column.is_primary_key && column.is_auto_increment)
        {
            identity.insert(column.column_name.clone(), last_insert_id.to_string());
        }
    }
    let (inverse_sql, inverse_binds, strategy) =
        match audit::build_insert_inverse(table_name, &identity) {
            Ok(value) => value,
            Err(_) => (None, Vec::new(), audit::STRATEGY_MANUAL),
        };
    let _ = audit::finalize_insert_audit(
        &pool,
        audit_id,
        &identity,
        inverse_sql,
        inverse_binds,
        strategy,
    )
    .await;
    crate::audit_sync::trigger_immediate_sync(app);
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

fn demo_schema_for_runtime(
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
            None => Vec::new(),
        };
        rows.insert(row_key.clone(), generated);
    }
    rows.get_mut(&row_key).expect("demo rows were inserted")
}

#[tauri::command]
pub async fn list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<WorkbenchConnection>, String> {
    let rt = state.runtime.lock().await;
    Ok(rt
        .connections
        .values()
        .map(|connection| WorkbenchConnection {
            id: connection.id.clone(),
            kind: connection.kind,
            label: connection.label.clone(),
            host: connection.host.clone(),
            port: connection.port,
            username: connection.username.clone(),
            database: connection.database.clone(),
            connected: connection_connected(connection),
            read_only: connection.kind.is_read_only(),
        })
        .collect())
}

async fn real_connection_pool(
    connection_id: &str,
    state: &State<'_, AppState>,
) -> Result<MySqlPool, String> {
    let (kind, mysql_url, pool) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (connection.kind, connection.mysql_url.clone(), connection.pool.clone())
    };
    if kind != DatabaseKind::MySql {
        return Err(read_only_error(kind));
    }
    let Some(mysql_url) = mysql_url else {
        return Err("演示连接不支持数据库覆盖同步，请连接真实 MySQL 后重试".into());
    };
    if let Some(pool) = pool {
        return Ok(pool);
    }
    let pool = connect_database(&mysql_url, None).await?;
    let mut rt = state.runtime.lock().await;
    if let Some(connection) = rt.connections.get_mut(connection_id) {
        connection.pool = Some(pool.clone());
    }
    Ok(pool)
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
        "completed",
        "演示数据库覆盖同步完成",
        None,
        copied_tables.len() as u64,
        copied_tables.len() as u64,
        Some(copied_rows),
        Some(copied_rows),
        None,
        "completed",
    ));
    Ok(SyncDatabaseOverwriteResponse {
        job_id: request.job_id.clone(),
        status: "succeeded".into(),
        copied_tables,
        copied_rows,
        dropped_tables: preview.target_only_tables_to_drop,
        backup_database: None,
        message: "演示数据库覆盖同步完成".into(),
        warnings: preview.warnings,
    })
}

fn build_table_design_preview_request(
    request: Option<TableDesignPreviewRequest>,
    connection_id: Option<String>,
    database: Option<String>,
    table_name: Option<String>,
    draft: Option<TableDesignDraft>,
) -> Result<TableDesignPreviewRequest, String> {
    if let Some(request) = request {
        return Ok(request);
    }
    Ok(TableDesignPreviewRequest {
        connection_id: connection_id.ok_or_else(|| "缺少连接 ID".to_string())?,
        database: database.ok_or_else(|| "缺少数据库".to_string())?,
        table_name: table_name.ok_or_else(|| "缺少表名".to_string())?,
        draft: draft.ok_or_else(|| "缺少表设计草案".to_string())?,
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
    state: State<'_, AppState>,
) -> Result<PreviewDatabaseSyncResponse, String> {
    let (kind, mysql_url, pool, demo_profile, selected_database, selected_schema, overrides, rows) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.kind,
            connection.mysql_url.clone(),
            connection.pool.clone(),
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
    if mysql_url.is_some() {
        let pool = if let Some(pool) = pool {
            pool
        } else {
            real_connection_pool(&request.connection_id, &state).await?
        };
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
    window: Window,
    request: SyncDatabaseOverwriteRequest,
    state: State<'_, AppState>,
) -> Result<SyncDatabaseOverwriteResponse, String> {
    let (kind, mysql_url, pool, demo_profile) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.kind,
            connection.mysql_url.clone(),
            connection.pool.clone(),
            rt.demo_profile,
        )
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    if mysql_url.is_some() {
        let pool = if let Some(pool) = pool {
            pool
        } else {
            real_connection_pool(&request.connection_id, &state).await?
        };
        return sync::execute_database_sync(&pool, request, |payload| {
            let _ = window.emit(DATABASE_SYNC_PROGRESS_EVENT, payload);
        })
        .await;
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
    Ok(result)
}

#[tauri::command]
pub async fn copy_tables(
    request: CopyTablesRequest,
    state: State<'_, AppState>,
) -> Result<CopyTablesResponse, String> {
    let (kind, target_kind, mysql_url, pool) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        let target_connection = rt
            .connections
            .get(&request.target_connection_id)
            .ok_or_else(|| "目标连接不存在".to_string())?;
        (
            connection.kind,
            target_connection.kind,
            connection.mysql_url.clone(),
            connection.pool.clone(),
        )
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    if target_kind.is_read_only() {
        return Err(read_only_error(target_kind));
    }
    if mysql_url.is_some() {
        let pool = if let Some(pool) = pool {
            pool
        } else {
            real_connection_pool(&request.connection_id, &state).await?
        };
        return copy_tables_mysql(&pool, &request).await;
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

    for table_name in &request.table_names {
        let source_table = source_schema
            .iter()
            .find(|t| t.table_name.eq_ignore_ascii_case(table_name))
            .ok_or_else(|| format!("源表不存在: {table_name}"))?
            .clone();

        let target_name = resolve_copy_table_name(target_schema, table_name);
        let source_rows =
            materialized_demo_rows_for(&request.source_database, &rt.demo_rows, &source_table);
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
        });
    }
    rt.demo_schema_overrides = schemas;
    if rt.selected_database == request.target_database {
        if let Some(schema) = rt.demo_schema_overrides.get(&request.target_database) {
            rt.schema = schema.clone();
        }
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
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RenameTableResponse, String> {
    let (kind, mysql_url, pool) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (connection.kind, connection.mysql_url.clone(), connection.pool.clone())
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    if mysql_url.is_some() {
        let pool = if let Some(pool) = pool {
            pool
        } else {
            real_connection_pool(&connection_id, &state).await?
        };
        let sql = format!(
            "RENAME TABLE `{}`.`{}` TO `{}`.`{}`",
            database, table_name, database, new_name
        );
        let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
        let audit_id = best_effort_audit(
            &app,
            &state,
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
                mark_audit(&app, &state, audit_id, true).await;
                return Ok(RenameTableResponse {
                    renamed: true,
                    from: table_name,
                    to: new_name,
                });
            }
            Err(e) => {
                mark_audit(&app, &state, audit_id, false).await;
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
    Ok(RenameTableResponse {
        renamed: true,
        from: table_name,
        to: new_name,
    })
}

fn resolve_copy_table_name(schema: &[TableMeta], base_name: &str) -> String {
    if !schema
        .iter()
        .any(|t| t.table_name.eq_ignore_ascii_case(base_name))
    {
        return base_name.to_string();
    }
    let candidate = format!("{base_name}_copy");
    if !schema
        .iter()
        .any(|t| t.table_name.eq_ignore_ascii_case(&candidate))
    {
        return candidate;
    }
    let mut n = 1_u32;
    loop {
        let next = format!("{base_name}_copy{n}");
        if !schema
            .iter()
            .any(|t| t.table_name.eq_ignore_ascii_case(&next))
        {
            return next;
        }
        n = n.saturating_add(1);
    }
}

async fn copy_tables_mysql(
    pool: &sqlx::MySqlPool,
    request: &CopyTablesRequest,
) -> Result<CopyTablesResponse, String> {
    use sqlx::Row;

    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| format!("获取 MySQL 连接失败: {error}"))?;
    let mut copied = Vec::new();
    let warnings = Vec::new();

    let existing_rows = sqlx::query(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
    )
    .bind(&request.target_database)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("读取目标库表列表失败: {error}"))?;
    let existing: std::collections::HashSet<String> = existing_rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>("TABLE_NAME").ok())
        .collect();

    for table_name in &request.table_names {
        let ddl =
            sync::show_create_table(&mut connection, &request.source_database, table_name).await?;
        let target_name = resolve_copy_table_name_from_set(&existing, table_name);

        let rewritten = sync::rewrite_create_table_for_database(
            &ddl,
            &request.source_database,
            &request.target_database,
            &target_name,
        )?;
        sqlx::query(&rewritten)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("创建目标表 {target_name} 失败: {error}"))?;

        let columns =
            sync::list_columns(&mut connection, &request.source_database, table_name).await?;
        let insertable = sync::insertable_columns(&columns);
        let column_sql = insertable
            .iter()
            .map(|c| format!("`{}`", escape_ident(c)))
            .collect::<Vec<_>>()
            .join(", ");
        let copy_sql = format!(
            "INSERT INTO `{}`.`{}` ({}) SELECT {} FROM `{}`.`{}`",
            escape_ident(&request.target_database),
            escape_ident(&target_name),
            column_sql,
            column_sql,
            escape_ident(&request.source_database),
            escape_ident(table_name),
        );
        sqlx::query(&copy_sql)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("复制表 {table_name} 数据失败: {error}"))?;

        copied.push(CopyTablesResult {
            original_name: table_name.clone(),
            target_name,
        });
    }

    Ok(CopyTablesResponse {
        status: "succeeded".into(),
        copied,
        warnings,
    })
}

fn resolve_copy_table_name_from_set(
    existing: &std::collections::HashSet<String>,
    base_name: &str,
) -> String {
    if !existing.contains(&base_name.to_lowercase()) {
        return base_name.to_string();
    }
    let candidate = format!("{base_name}_copy");
    if !existing.contains(&candidate.to_lowercase()) {
        return candidate;
    }
    let mut n = 1_u32;
    loop {
        let next = format!("{base_name}_copy{n}");
        if !existing.contains(&next.to_lowercase()) {
            return next;
        }
        n = n.saturating_add(1);
    }
}

#[tauri::command]
pub async fn list_databases(
    connection_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let (connection_id, kind, mysql_url, clickhouse_url, pool, demo_profile) = {
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
            connection.pool.clone(),
            rt.demo_profile,
        )
    };
    if let Some(url) = clickhouse_url.filter(|_| kind == DatabaseKind::ClickHouse) {
        return clickhouse::list_databases(&url).await;
    }
    let Some(mysql_url) = mysql_url else {
        return Ok(match demo_profile {
            Some(DemoProfile::Stress) => stress_databases(&connection_id),
            None => Vec::new(),
        });
    };
    let pool = if let Some(pool) = pool {
        pool
    } else {
        let pool = connect_database(&mysql_url, None).await?;
        let mut rt = state.runtime.lock().await;
        if let Some(connection) = rt.connections.get_mut(&connection_id) {
            connection.pool = Some(pool.clone());
        }
        pool
    };
    let rows = sqlx::query("SHOW DATABASES")
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("读取数据库失败: {error}"))?;
    Ok(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>(0).ok())
        .filter(|name| {
            !matches!(
                name.as_str(),
                "information_schema" | "mysql" | "performance_schema" | "sys"
            )
        })
        .collect())
}

#[tauri::command]
pub async fn select_database(
    connection_id: Option<String>,
    database: String,
    state: State<'_, AppState>,
) -> Result<HashMap<String, u64>, String> {
    let (connection_id, kind, mysql_url, clickhouse_url, demo_profile) = {
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
            rt.demo_profile,
        )
    };
    if let Some(url) = clickhouse_url.filter(|_| kind == DatabaseKind::ClickHouse) {
        let tables = clickhouse::list_tables(&url, &database).await?;
        let mut rt = state.runtime.lock().await;
        rt.selected_connection_id = connection_id.clone();
        rt.selected_database = database.clone();
        if let Some(connection) = rt.connections.get_mut(&connection_id) {
            connection.database = Some(database);
        }
        rt.schema = tables
            .iter()
            .map(|table| TableMeta {
                table_name: table.table_name.clone(),
                table_comment: table.table_comment.clone(),
                columns: Vec::new(),
            })
            .collect();
    } else if let Some(mysql_url) = mysql_url {
        let pool = connect_database(&mysql_url, Some(&database)).await?;
        let tables = list_tables_from_db(&pool, &database).await?;
        let mut rt = state.runtime.lock().await;
        rt.selected_connection_id = connection_id.clone();
        rt.selected_database = database.clone();
        if let Some(connection) = rt.connections.get_mut(&connection_id) {
            connection.database = Some(database);
            connection.pool = Some(pool);
        }
        rt.schema = tables
            .iter()
            .map(|table| TableMeta {
                table_name: table.table_name.clone(),
                table_comment: table.table_comment.clone(),
                columns: Vec::new(),
            })
            .collect();
    } else {
        let mut rt = state.runtime.lock().await;
        rt.selected_connection_id = connection_id.clone();
        rt.selected_database = database.clone();
        if let Some(connection) = rt.connections.get_mut(&connection_id) {
            connection.database = Some(database.clone());
        }
        let next_schema = demo_schema_for_runtime(
            &rt.demo_schema_overrides,
            demo_profile,
            &database,
            &rt.selected_database,
            &rt.schema,
        );
        rt.schema = next_schema;
    }

    let rt = state.runtime.lock().await;
    Ok(HashMap::from([
        ("tableCount".into(), rt.schema.len() as u64),
        (
            "columnCount".into(),
            rt.schema
                .iter()
                .map(|table| table.columns.len() as u64)
                .sum(),
        ),
    ]))
}

#[tauri::command]
pub async fn list_tables(
    connection_id: Option<String>,
    database: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<TableOption>, String> {
    let (kind, clickhouse_url, pool, selected_database, schema, demo_profile, overrides) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.kind,
            connection.clickhouse_url.clone(),
            connection.pool.clone(),
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
        clickhouse::list_tables(&url, &database).await
    } else if let Some(pool) = pool {
        list_tables_from_db(&pool, &database).await
    } else {
        Ok(
            demo_schema_for_runtime(&overrides, demo_profile, &database, &database, &schema)
                .into_iter()
                .map(|table| TableOption {
                    table_name: table.table_name,
                    table_comment: table.table_comment,
                })
                .collect(),
        )
    }
}

#[tauri::command]
pub async fn get_table_schema(
    connection_id: Option<String>,
    database: Option<String>,
    table_name: String,
    state: State<'_, AppState>,
) -> Result<TableMeta, String> {
    let (kind, clickhouse_url, pool, database, schema, demo_profile, overrides, selected_database) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.kind,
            connection.clickhouse_url.clone(),
            connection.pool.clone(),
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
    if let Some(url) = clickhouse_url.filter(|_| kind == DatabaseKind::ClickHouse) {
        clickhouse::read_schema(&url, &database, &table_name).await
    } else if let Some(pool) = pool {
        read_schema(&pool, &database, &table_name).await
    } else if demo_profile.is_some() {
        let demo_schema = demo_schema_for_runtime(
            &overrides,
            demo_profile,
            &database,
            &selected_database,
            &schema,
        );
        resolve_demo_table(&table_name, &demo_schema)
    } else {
        Err(no_demo_error())
    }
}

fn parse_demo_column_type(column_type: &str) -> (String, Option<u64>, Option<u64>) {
    let raw = column_type.trim();
    if let Some(open) = raw.find('(') {
        if raw.ends_with(')') {
            let data_type = raw[..open].trim().to_ascii_lowercase();
            let inner = &raw[open + 1..raw.len() - 1];
            let mut parts = inner.split(',').map(|part| part.trim().parse::<u64>().ok());
            return (data_type, parts.next().flatten(), parts.next().flatten());
        }
    }
    (raw.to_ascii_lowercase(), None, None)
}

fn demo_column_design(column: &ColumnMeta, ordinal: u32) -> ColumnDesignMeta {
    let (data_type, length, scale) = parse_demo_column_type(&column.column_type);
    let is_supported = matches!(
        data_type.as_str(),
        "char"
            | "varchar"
            | "binary"
            | "varbinary"
            | "bit"
            | "decimal"
            | "numeric"
            | "dec"
            | "fixed"
            | "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "float"
            | "double"
            | "real"
            | "tinytext"
            | "text"
            | "mediumtext"
            | "longtext"
            | "json"
            | "tinyblob"
            | "blob"
            | "mediumblob"
            | "longblob"
            | "date"
            | "datetime"
            | "timestamp"
            | "time"
            | "year"
            | "bool"
            | "boolean"
    );
    ColumnDesignMeta {
        ordinal,
        column_name: column.column_name.clone(),
        column_type: column.column_type.clone(),
        data_type: data_type.clone(),
        length,
        scale,
        is_nullable: column.is_nullable,
        is_primary_key: column.is_primary_key,
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
        columns: table
            .columns
            .iter()
            .enumerate()
            .map(|(index, column)| demo_column_design(column, index as u32 + 1))
            .collect(),
    };
    design.schema_signature = Some(crate::ddl::schema_signature(&design));
    Ok(design)
}

fn draft_column_type(column: &ColumnDesignDraft) -> Result<String, String> {
    crate::ddl::column_type_sql(column)
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
    let preview = crate::ddl::verify_table_design_apply(&current, &request)?;
    let draft_lookup = request
        .draft
        .columns
        .iter()
        .map(|column| (column.original_name.to_ascii_lowercase(), column))
        .collect::<HashMap<_, _>>();
    let mut renames = Vec::new();
    let table = schema
        .iter_mut()
        .find(|table| table.table_name.eq_ignore_ascii_case(&request.table_name))
        .ok_or_else(|| format!("表不存在: {}", request.table_name))?;
    let table_before_apply = table.clone();
    table.table_comment = request.draft.table_comment.clone();
    for column in &mut table.columns {
        let draft = draft_lookup
            .get(&column.column_name.to_ascii_lowercase())
            .ok_or_else(|| format!("drop column is not supported in V1: {}", column.column_name))?;
        if column.column_name != draft.name {
            renames.push((column.column_name.clone(), draft.name.clone()));
        }
        column.column_name = draft.name.clone();
        column.column_type = draft_column_type(draft)?;
        column.column_comment = draft.comment.clone();
        column.is_primary_key = draft.primary_key;
        column.is_nullable = if draft.primary_key {
            false
        } else {
            draft.nullable
        };
    }
    if matches!(demo_profile, Some(DemoProfile::Stress))
        && !renames.is_empty()
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
    let (connection_id, kind, pool, database, schema, demo_profile, overrides, selected_database) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection_id,
            connection.kind,
            connection.pool.clone(),
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
    if let Some(pool) = pool {
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
    state: State<'_, AppState>,
) -> Result<TableDesignPreview, String> {
    let request =
        build_table_design_preview_request(request, connection_id, database, table_name, draft)?;
    let (kind, pool, schema, demo_profile, overrides, selected_database) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.kind,
            connection.pool.clone(),
            rt.schema.clone(),
            rt.demo_profile,
            rt.demo_schema_overrides.clone(),
            rt.selected_database.clone(),
        )
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    let current = if let Some(pool) = pool {
        read_table_design(
            &pool,
            &request.database,
            &request.table_name,
            &request.connection_id,
        )
        .await?
    } else {
        let schema = demo_schema_for_runtime(
            &overrides,
            demo_profile,
            &request.database,
            &selected_database,
            &schema,
        );
        demo_table_design_from_schema(
            &request.connection_id,
            &request.database,
            &request.table_name,
            &schema,
        )?
    };
    crate::ddl::preview_table_design_change(&current, &request.draft)
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
    let (kind, pool) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (connection.kind, connection.pool.clone())
    };
    if kind.is_read_only() {
        return Err(read_only_error(kind));
    }
    if let Some(pool) = pool {
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
        let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
        let audit_id = best_effort_audit(
            &app,
            &state,
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
                new_value: None,
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
        let mut applied_ok = true;
        for statement in &preview.statements {
            if let Err(error) = sqlx::query(statement).execute(&pool).await {
                applied_ok = false;
                mark_audit(&app, &state, audit_id, false).await;
                return Err(format!("应用表设计失败: {error}"));
            }
        }
        mark_audit(&app, &state, audit_id, applied_ok).await;
        let schema = read_table_design(
            &pool,
            &request.database,
            &request.table_name,
            &request.connection_id,
        )
        .await?;
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
    result
}

#[tauri::command]
pub async fn open_table_session(
    connection_id: Option<String>,
    database: Option<String>,
    table_name: String,
    options: Option<TablePageRequest>,
    state: State<'_, AppState>,
) -> Result<TableSessionPage, String> {
    let request = options.unwrap_or_default();
    let requested_table_name = table_name.clone();
    let (
        connection_id,
        kind,
        database,
        mysql_url,
        clickhouse_url,
        cached_pool,
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
        let schema = demo_schema_for_runtime(
            &rt.demo_schema_overrides,
            rt.demo_profile,
            &database,
            &rt.selected_database,
            &rt.schema,
        );
        let row_key = demo_row_key(&database, &requested_table_name);
        (
            connection_id,
            connection.kind,
            database,
            connection.mysql_url.clone(),
            connection.clickhouse_url.clone(),
            connection.pool.clone(),
            schema,
            rt.demo_profile,
            rt.demo_rows.get(&row_key).cloned(),
        )
    };
    // Reuse the cached MySQL pool when available; only build (and cache) a new
    // one on first access so opening a table does not pay the connect+auth cost
    // every time. Mirrors real_connection_pool's write-back pattern.
    let pool = match (kind, mysql_url, cached_pool) {
        (DatabaseKind::MySql, Some(_), Some(pool)) => Some(pool),
        (DatabaseKind::MySql, Some(mysql_url), None) => {
            let pool = connect_database(&mysql_url, Some(&database)).await?;
            let mut rt = state.runtime.lock().await;
            if let Some(connection) = rt.connections.get_mut(&connection_id) {
                connection.pool = Some(pool.clone());
            }
            Some(pool)
        }
        _ => None,
    };
    let table = if let Some(url) = clickhouse_url.as_ref().filter(|_| kind == DatabaseKind::ClickHouse) {
        clickhouse::read_schema(url, &database, &table_name).await?
    } else if let Some(pool) = pool.as_ref() {
        read_schema(pool, &database, &table_name).await?
    } else {
        resolve_demo_table(&table_name, &schema)?
    };
    let session_id = {
        let mut rt = state.runtime.lock().await;
        rt.next_session_id = rt.next_session_id.saturating_add(1);
        let session_id = format!("table-session-{}", rt.next_session_id);
        rt.sessions.insert(
            session_id.clone(),
            TableSession {
                connection_id,
                kind,
                database: database.clone(),
                table_name: table_name.clone(),
                clickhouse_url: clickhouse_url.clone(),
                pool: pool.clone(),
            },
        );
        session_id
    };
    if let Some(url) = clickhouse_url.filter(|_| kind == DatabaseKind::ClickHouse) {
        clickhouse::read_page(&url, &database, &table, &session_id, &request).await
    } else if let Some(pool) = pool {
        read_db_page(&pool, &table, &session_id, &request).await
    } else if matches!(demo_profile, Some(DemoProfile::Stress)) {
        Ok(read_stress_or_materialized_page(
            materialized_rows.as_ref(),
            &table,
            &session_id,
            &request,
        ))
    } else {
        Err(no_demo_error())
    }
}

#[tauri::command]
pub async fn fetch_table_page(
    session_id: String,
    request: Option<TablePageRequest>,
    state: State<'_, AppState>,
) -> Result<TableSessionPage, String> {
    let request = request.unwrap_or_default();
    let (session, schema, demo_profile, materialized_rows) = {
        let rt = state.runtime.lock().await;
        let session = rt
            .sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?;
        let schema = demo_schema_for_runtime(
            &rt.demo_schema_overrides,
            rt.demo_profile,
            &session.database,
            &rt.selected_database,
            &rt.schema,
        );
        let row_key = demo_row_key(&session.database, &session.table_name);
        let materialized_rows = rt.demo_rows.get(&row_key).cloned();
        (session, schema, rt.demo_profile, materialized_rows)
    };
    let table = if let Some(url) = session
        .clickhouse_url
        .as_ref()
        .filter(|_| session.kind == DatabaseKind::ClickHouse)
    {
        clickhouse::read_schema(url, &session.database, &session.table_name).await?
    } else if let Some(pool) = session.pool.as_ref() {
        read_schema(pool, &session.database, &session.table_name).await?
    } else {
        resolve_demo_table(&session.table_name, &schema)?
    };
    if let Some(url) = session
        .clickhouse_url
        .as_ref()
        .filter(|_| session.kind == DatabaseKind::ClickHouse)
    {
        clickhouse::read_page(url, &session.database, &table, &session_id, &request).await
    } else if let Some(pool) = session.pool {
        read_db_page(&pool, &table, &session_id, &request).await
    } else if matches!(demo_profile, Some(DemoProfile::Stress)) {
        Ok(read_stress_or_materialized_page(
            materialized_rows.as_ref(),
            &table,
            &session_id,
            &request,
        ))
    } else {
        Err(no_demo_error())
    }
}

#[tauri::command]
pub async fn update_cell(
    request: UpdateCellRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateCellResult, String> {
    // Normalize the new value: None = SQL NULL, Some(s) = literal value (incl.
    // the empty string). The old value is always a string read from a previous
    // query result. NULL (None) is distinct from the empty string (#5).
    let new_value = request.new_value.clone();
    let new_value_ref = new_value.as_deref();
    let unchanged = match new_value_ref {
        Some(v) => v == request.old_value,
        None => false, // setting to NULL is always a change from a non-null old value
    };
    if unchanged {
        return Ok(UpdateCellResult {
            updated: false,
            conflict: false,
            value: new_value,
        });
    }
    let session = {
        let rt = state.runtime.lock().await;
        rt.sessions
            .get(&request.session_id)
            .cloned()
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };

    if session.kind.is_read_only() {
        return Err(read_only_error(session.kind));
    }

    if let Some(pool) = session.pool {
        let table = read_schema(&pool, &session.database, &session.table_name).await?;
        if let Err(error) = crate::validation::validate_column_value(
            &table,
            &request.column_name,
            new_value_ref,
        ) {
            return Err(error.message);
        }
        // The forward UPDATE applies the new value (NULL or literal); the
        // inverse UPDATE restores the old value. For NULL writes the SET clause
        // uses `col = NULL` and the inverse locates the row with `<=> NULL`
        // (#5). The `AND col = ?` tail is the optimistic-concurrency guard.
        let (forward_sql, forward_binds, inverse_sql, inverse_binds) = audit::build_update_inverse(
            &session.table_name,
            &request.column_name,
            &request.row_identity,
            &request.old_value,
            new_value_ref,
        )?;
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
            operation: "UPDATE",
            column_name: Some(request.column_name.clone()),
            old_value: Some(request.old_value.clone()),
            new_value: new_value.clone(),
            row_identity: Some(serde_json::to_value(&request.row_identity).unwrap_or_default()),
            forward_sql: forward_sql.clone(),
            forward_binds: forward_binds.clone(),
            inverse_sql: Some(inverse_sql.clone()),
            inverse_binds,
            rollback_strategy: audit::STRATEGY_AUTO,
            notes: None,
        };
        let audit_id = best_effort_audit(&app, &state, ctx, pending).await;
        let mut query = sqlx::query(&forward_sql);
        for bind in &forward_binds {
            query = query.bind(bind);
        }
        match query.execute(&pool).await {
            Ok(result) => {
                let affected = result.rows_affected();
                mark_audit(&app, &state, audit_id, affected > 0).await;
                return Ok(UpdateCellResult {
                    updated: affected > 0,
                    conflict: affected == 0,
                    value: new_value,
                });
            }
            Err(error) => {
                mark_audit(&app, &state, audit_id, false).await;
                let message = crate::validation::mysql_error_message(&error)
                    .unwrap_or_else(|| format!("保存失败: {error}"));
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
    let matched_index = rows.iter().position(|row| {
        request.row_identity.iter().all(|(key, value)| {
            row.get(key)
                .map(|current| current == value)
                .unwrap_or(false)
        })
    });
    if let Some(row_index) = matched_index {
        let current = rows[row_index]
            .get(&request.column_name)
            .cloned()
            .unwrap_or_default();
        if current != request.old_value {
            return Ok(UpdateCellResult {
                updated: false,
                conflict: true,
                value: Some(current),
            });
        }
        if let Err(error) = crate::validation::validate_cell_value(
            &table,
            rows,
            row_index,
            &request.column_name,
            new_value_ref,
        ) {
            return Err(error.message);
        }
        // Demo rows are HashMap<String, String>; represent SQL NULL by removing
        // the key so downstream `row.get()` returns None (rendered as "NULL").
        // An explicit empty string is stored as "" (#5).
        match &new_value {
            Some(v) => {
                rows[row_index].insert(request.column_name.clone(), v.clone());
            }
            None => {
                rows[row_index].remove(&request.column_name);
            }
        }
        return Ok(UpdateCellResult {
            updated: true,
            conflict: false,
            value: new_value,
        });
    }
    Ok(UpdateCellResult {
        updated: false,
        conflict: true,
        value: Some(request.old_value),
    })
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

#[tauri::command]
pub async fn insert_row(
    request: InsertRowRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RowMutationResult, String> {
    let session = {
        let rt = state.runtime.lock().await;
        rt.sessions
            .get(&request.session_id)
            .cloned()
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };
    let has_content = request.draft.values().any(|value| !value.trim().is_empty());
    if !has_content {
        return Ok(RowMutationResult { affected: 0 });
    }
    if session.kind.is_read_only() {
        return Err(read_only_error(session.kind));
    }
    let draft = request.draft;

    if let Some(pool) = session.pool {
        let table = read_schema(&pool, &session.database, &session.table_name).await?;
        if let Err(error) = crate::validation::validate_row_draft(&table, &[], &draft) {
            return Err(error.message);
        }
        if let Some((where_sql, values)) = build_primary_key_where(&table, &draft) {
            let sql = format!(
                "SELECT 1 FROM `{}` WHERE {} LIMIT 1",
                escape_ident(&session.table_name),
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
        let sql = format!(
            "INSERT INTO `{}` ({}) VALUES ({})",
            escape_ident(&session.table_name),
            keys.iter()
                .map(|key| format!("`{}`", escape_ident(key)))
                .collect::<Vec<_>>()
                .join(", "),
            keys.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
        );
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
            new_value: None,
            row_identity: None,
            forward_sql: sql.clone(),
            forward_binds: forward_binds.clone(),
            inverse_sql: None,
            inverse_binds: Vec::new(),
            rollback_strategy: audit::STRATEGY_MANUAL,
            notes: None,
        };
        let audit_id = best_effort_audit(&app, &state, ctx, pending).await;

        let mut query = sqlx::query(&sql);
        for bind in &forward_binds {
            query = query.bind(bind);
        }
        match query.execute(&pool).await {
            Ok(result) => {
                let affected = result.rows_affected();
                let last_id = result.last_insert_id();
                if let Some(id) = audit_id {
                    finalize_insert_audit_row(
                        &app,
                        &state,
                        &session.table_name,
                        id,
                        &table,
                        &draft,
                        last_id,
                    )
                    .await;
                }
                return Ok(RowMutationResult { affected });
            }
            Err(error) => {
                mark_audit(&app, &state, audit_id, false).await;
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
    rows.push(draft);
    Ok(RowMutationResult { affected: 1 })
}

#[tauri::command]
pub async fn delete_rows(
    request: DeleteRowsRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RowMutationResult, String> {
    let session = {
        let rt = state.runtime.lock().await;
        rt.sessions
            .get(&request.session_id)
            .cloned()
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };

    if session.kind.is_read_only() {
        return Err(read_only_error(session.kind));
    }

    if let Some(pool) = session.pool {
        let table = read_schema(&pool, &session.database, &session.table_name).await?;
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

        // Capture each row's full preimage and write a pending audit row (with an
        // inverse INSERT to undo the delete). Rows whose preimage cannot be read
        // are recorded as manual-rollback.
        let mut audit_ids: Vec<i64> = Vec::new();
        let mut plans: Vec<(String, Vec<String>)> = Vec::new();
        for identity in &request.row_identities {
            let (forward_sql, forward_binds) =
                audit::build_delete_forward(&session.table_name, identity)?;
            let preimage = fetch_preimage(
                &pool,
                &session.database,
                &session.table_name,
                &insertable_cols,
                identity,
            )
            .await?;
            let (inverse_sql, inverse_binds, strategy) = match &preimage {
                Some(preimage) => {
                    let (sql, binds) = audit::build_delete_inverse(
                        &session.table_name,
                        &insertable_cols,
                        &audit::preimage_vector(&insertable_cols, preimage),
                    );
                    (Some(sql), binds, audit::STRATEGY_AUTO)
                }
                None => (None, Vec::new(), audit::STRATEGY_MANUAL),
            };
            let pending = audit::PendingAudit {
                operation: "DELETE",
                column_name: None,
                old_value: preimage
                    .as_ref()
                    .map(|value| serde_json::to_string(value).unwrap_or_default()),
                new_value: None,
                row_identity: Some(serde_json::to_value(identity).unwrap_or_default()),
                forward_sql: forward_sql.clone(),
                forward_binds: forward_binds.clone(),
                inverse_sql,
                inverse_binds,
                rollback_strategy: strategy,
                notes: if preimage.is_none() {
                    Some("行不存在，未捕获前镜像".into())
                } else {
                    None
                },
            };
            if let Some(id) = best_effort_audit(&app, &state, ctx.clone(), pending).await {
                audit_ids.push(id);
            }
            plans.push((forward_sql, forward_binds));
        }

        // Execute all deletes inside one transaction so a mid-batch failure
        // leaves no partial delete (previously each row committed independently).
        let mut tx = pool
            .begin()
            .await
            .map_err(|error| format!("开启事务失败: {error}"))?;
        let mut affected = 0u64;
        let mut exec_error: Option<String> = None;
        for (forward_sql, forward_binds) in &plans {
            let mut query = sqlx::query(forward_sql);
            for bind in forward_binds {
                query = query.bind(bind);
            }
            match query.execute(&mut *tx).await {
                Ok(result) => affected += result.rows_affected(),
                Err(error) => {
                    exec_error = Some(format!("删除失败: {error}"));
                    break;
                }
            }
        }
        match exec_error {
            Some(error) => {
                tx.rollback().await.ok();
                mark_audit_many(&app, &state, &audit_ids, false).await;
                return Err(error);
            }
            None => {
                tx.commit()
                    .await
                    .map_err(|error| format!("提交删除事务失败: {error}"))?;
                mark_audit_many(&app, &state, &audit_ids, true).await;
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
    let before = rows.len();
    rows.retain(|row| {
        !request.row_identities.iter().any(|identity| {
            identity.iter().all(|(key, value)| {
                row.get(key)
                    .map(|current| current == value)
                    .unwrap_or(false)
            })
        })
    });
    Ok(RowMutationResult {
        affected: before.saturating_sub(rows.len()) as u64,
    })
}

#[tauri::command]
pub async fn search_values(
    window: Window,
    request: SearchValuesRequest,
    state: State<'_, AppState>,
) -> Result<Vec<SearchValueItem>, String> {
    let query = request.query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = request.limit.unwrap_or(1500).clamp(1, 1500);
    let (connection_id, database, kind, mysql_url, clickhouse_url, pool, demo_rows, schema) = {
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
            connection.pool.clone(),
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
            clickhouse::list_tables(&url, &database).await?,
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
            let table = match clickhouse::read_schema(&url, &database, &table_option.table_name).await {
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
            let matches = match clickhouse::search_value_matches(&url, &database, &table, &query).await {
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
        let pool = if let Some(pool) = pool {
            pool
        } else {
            real_connection_pool(&connection_id, &state).await?
        };
        let mut results = Vec::new();
        let tables = order_tables_by_priority(
            list_tables_from_db(&pool, &database).await?,
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

    let tables = order_tables_by_priority(
        schema
            .iter()
            .map(|table| TableOption {
                table_name: table.table_name.clone(),
                table_comment: table.table_comment.clone(),
            })
            .collect(),
        &request.priority_tables,
    )
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

    fn cm(name: &str, pk: bool) -> ColumnMeta {
        ColumnMeta::with_basic(name, "varchar(32)", "", pk, !pk)
    }

    #[test]
    fn demo_update_cell_primary_key_conflict_detection_ignores_current_row_only() {
        let table = TableMeta {
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
        assert!(crate::validation::validate_cell_value(&table, &rows, 0, "name", Some("bob")).is_ok());
    }

    #[test]
    fn validation_rejects_duplicate_and_incomplete_composite_primary_keys() {
        let table = TableMeta {
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
            .and_then(|tail| tail.split("async fn mark_audit_many").next())
            .expect("mark_audit helper should exist");
        assert!(
            mark_audit_body.contains("trigger_immediate_sync"),
            "single-row committed audit writes should trigger immediate central sync"
        );

        let mark_many_body = source
            .split("async fn mark_audit_many(")
            .nth(1)
            .and_then(|tail| tail.split("/// Read a row's full preimage").next())
            .expect("mark_audit_many helper should exist");
        assert!(
            mark_many_body.contains("trigger_immediate_sync"),
            "batch committed audit writes should trigger immediate central sync"
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
                    length: column.length,
                    scale: column.scale,
                    nullable: column.is_nullable,
                    primary_key: column.is_primary_key,
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
    fn stress_demo_column_rename_preserves_generated_row_values() {
        let mut schema = crate::demo::stress_schema_for("game_db_01");
        let mut rows = HashMap::new();
        let table_name = "db01_config_0001";
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
            .contains(&"db01_config_0001".to_string()));
        assert!(preview
            .included_tables
            .contains(&"db01_config_0001".to_string()));
        assert!(!preview
            .included_tables
            .contains(&"db01_activity_0002".to_string()));
        assert!(preview
            .target_only_tables_to_drop
            .contains(&"db04_config_0001".to_string()));
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
            .contains(&"db01_config_0001".to_string()));
        assert!(!result
            .copied_tables
            .contains(&"db01_activity_0002".to_string()));
        assert!(result
            .dropped_tables
            .contains(&"db04_config_0001".to_string()));
        assert!(schemas["game_db_04"]
            .iter()
            .any(|table| table.table_name == "db01_config_0001"));
        assert!(!schemas["game_db_04"]
            .iter()
            .any(|table| table.table_name == "db04_config_0001"));
        assert!(schemas["game_db_01"]
            .iter()
            .any(|table| table.table_name == "db01_config_0001"));
        assert!(rows.contains_key("game_db_04\x1fdb01_config_0001"));
        assert!(!rows.contains_key("game_db_01\x1fdb01_config_0001"));
        assert!(events.iter().any(|event| event.status == "completed"));

        let fresh = RuntimeState::new(
            None,
            RuntimeOptions {
                demo_profile: Some(DemoProfile::Stress),
            },
        );
        assert!(fresh
            .schema
            .iter()
            .any(|table| table.table_name == "db01_config_0001"));
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
}

async fn connect_mysql_and_store(
    url: String,
    state: State<'_, AppState>,
    select: bool,
) -> Result<Vec<String>, String> {
    let pool = connect_database(&url, None).await?;
    let rows = sqlx::query("SHOW DATABASES")
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("读取数据库列表失败: {error}"))?;
    let db_list: Vec<String> = rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>(0).ok())
        .filter(|name| {
            !matches!(
                name.as_str(),
                "information_schema" | "mysql" | "performance_schema" | "sys"
            )
        })
        .collect();
    let mut rt = state.runtime.lock().await;
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
            database: None,
            pool: Some(pool),
        },
    );
    if select {
        rt.selected_connection_id = id;
    }
    Ok(db_list)
}

async fn connect_clickhouse_and_store(
    url: String,
    state: State<'_, AppState>,
    select: bool,
) -> Result<Vec<String>, String> {
    let db_list = clickhouse::list_databases(&url).await?;
    let (host, port, username) = clickhouse::describe_url(&url)?;
    let mut rt = state.runtime.lock().await;
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
            database: None,
            pool: None,
        },
    );
    if select {
        rt.selected_connection_id = id;
    }
    Ok(db_list)
}

async fn connect_and_store(
    kind: Option<String>,
    url: String,
    state: State<'_, AppState>,
    select: bool,
) -> Result<Vec<String>, String> {
    match DatabaseKind::infer(kind.as_deref(), &url) {
        DatabaseKind::MySql => connect_mysql_and_store(url, state, select).await,
        DatabaseKind::ClickHouse => connect_clickhouse_and_store(url, state, select).await,
    }
}

#[tauri::command]
pub async fn test_connection(kind: Option<String>, url: String) -> Result<(), String> {
    match DatabaseKind::infer(kind.as_deref(), &url) {
        DatabaseKind::MySql => test_database_connection(&url).await,
        DatabaseKind::ClickHouse => clickhouse::test_connection(&url).await,
    }
}

#[tauri::command]
pub async fn add_connection(
    kind: Option<String>,
    url: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    connect_and_store(kind, url, state, true).await
}

#[tauri::command]
pub async fn restore_connection(
    kind: Option<String>,
    url: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    connect_and_store(kind, url, state, false).await
}

#[tauri::command]
pub async fn remove_connection(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut rt = state.runtime.lock().await;
    rt.connections
        .remove(&connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
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
pub async fn agent_start_session(
    context: AgentContext,
    config: AgentConfig,
    resume_session_id: Option<String>,
    window: Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
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
pub async fn agent_approve_tool(
    req_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
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
pub async fn agent_set_mode(
    mode: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.agent_sidecar.lock().await;
    let sidecar = guard.as_ref().ok_or("Agent 会话未启动")?;
    sidecar.set_mode(mode).await
}

#[tauri::command]
pub async fn agent_set_auto_approve(
    on: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
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
pub async fn clear_audit_logs(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let pool = audit::ensure_audit_pool(&app, &state).await?;
    audit::clear_audit_logs(&pool).await
}

#[tauri::command]
pub async fn rollback_audit_entry(
    request: RollbackRequest,
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
    let pool = real_connection_pool(&entry.connection_id, &state).await?;

    // For an INSERT being undone (inverse = DELETE), accept idempotent no-op if
    // the row is already gone. For a DELETE being undone (inverse = INSERT), a
    // duplicate-key error is a conflict. For an UPDATE, affected == 0 means the
    // row changed since (optimistic conflict).
    let is_undo_insert = entry.operation == "INSERT";
    if is_undo_insert {
        let exists = row_exists_for_identity(&pool, &entry).await?;
        if !exists {
            let new_id = record_rollback_audit(&audit_pool, &app, &entry, inverse_sql, actor.clone(), uuid::Uuid::new_v4().to_string()).await?;
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

    let new_id = record_rollback_audit(&audit_pool, &app, &entry, inverse_sql, actor.clone(), uuid::Uuid::new_v4().to_string()).await?;
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
    entry: &audit::AuditEntry,
    executed_inverse_sql: &str,
    actor: Option<String>,
    client_id: String,
) -> Result<i64, String> {
    let new_id = audit::record_rollback(
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
    .await?;
    let _ = app.emit(
        audit::BACKUP_JOB_EVENT,
        serde_json::json!({ "kind": "rollback", "database": entry.database, "table": entry.table_name }),
    );
    crate::audit_sync::trigger_immediate_sync(app);
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
        "SELECT 1 FROM `{}` WHERE {} LIMIT 1",
        escape_ident(&entry.table_name),
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
    let manifest: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("解析快照清单失败: {error}"))?;
    manifest
        .get("database")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| "快照清单缺少数据库信息".into())
}

fn backup_config_response(app: &AppHandle, config: BackupConfig) -> Result<BackupConfigResponse, String> {
    let resolved_storage_dir = backup::resolved_storage_root(app, &config)?
        .to_string_lossy()
        .to_string();
    Ok(BackupConfigResponse::from_config(config, resolved_storage_dir))
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
        config.snapshot_enabled_databases.retain(|existing| existing != &key);
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
            if let Ok(name) = row.try_get::<String, _>(0) {
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

#[tauri::command]
pub async fn set_account_server(
    request: SetAccountServerRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AccountView, String> {
    let _ = crate::account::ensure_loaded(&app, &state).await;
    let mut config = state.account.config.lock().await;
    config.server_url = Some(request.server_url);
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
            let Some(window) = handle.get_webview_window("main") else {
                return;
            };
            // Toggle: hide when visible, show+focus when hidden/minimized.
            let is_visible = window.is_visible().unwrap_or(false);
            let is_minimized = window.is_minimized().unwrap_or(false);
            if is_visible && !is_minimized {
                let _ = window.hide();
            } else {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
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
