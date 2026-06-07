use std::collections::HashMap;

use sqlx::{MySqlPool, Row};
use tauri::{Emitter, State, Window};

use crate::db::{
    build_where, connect_database, escape_ident, list_tables_from_db, read_db_page, read_schema,
    read_table_design, search_first_value_match,
};
use crate::demo::{
    demo_schema_for, materialize_stress_rows, read_stress_or_materialized_page,
    resolve_demo_table, sample_stress_rows, search_demo_values, stress_databases, stress_schema_for,
};
use crate::sync::{self, DATABASE_SYNC_PROGRESS_EVENT};
use crate::types::*;

const SEARCH_VALUES_TABLE_SCAN_LIMIT: usize = 200;

fn no_demo_error() -> String {
    "没有可用的内置演示数据，请先新建 MySQL 连接".into()
}

fn ensure_demo_rows_for_mutation<'a>(
    rows: &'a mut HashMap<String, Vec<HashMap<String, String>>>,
    profile: Option<DemoProfile>,
    table: &TableMeta,
) -> &'a mut Vec<HashMap<String, String>> {
    if !rows.contains_key(&table.table_name) {
        let generated = match profile {
            Some(DemoProfile::Stress) => materialize_stress_rows(table),
            None => Vec::new(),
        };
        rows.insert(table.table_name.clone(), generated);
    }
    rows.get_mut(&table.table_name)
        .expect("demo rows were inserted")
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
            label: connection.label.clone(),
            host: connection.host.clone(),
            port: connection.port,
            username: connection.username.clone(),
            database: connection.database.clone(),
            connected: connection.mysql_url.is_none() || connection.pool.is_some(),
        })
        .collect())
}

async fn real_connection_pool(
    connection_id: &str,
    state: &State<'_, AppState>,
) -> Result<MySqlPool, String> {
    let (mysql_url, pool) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (connection.mysql_url.clone(), connection.pool.clone())
    };
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

fn build_preview_sync_request(
    request: Option<PreviewDatabaseSyncRequest>,
    connection_id: Option<String>,
    source_database: Option<String>,
    target_database: Option<String>,
    excluded_tables: Option<Vec<String>>,
) -> Result<PreviewDatabaseSyncRequest, String> {
    if let Some(request) = request {
        return Ok(request);
    }
    Ok(PreviewDatabaseSyncRequest {
        connection_id: connection_id.ok_or_else(|| "缺少连接 ID".to_string())?,
        source_database: source_database.ok_or_else(|| "缺少源数据库".to_string())?,
        target_database: target_database.ok_or_else(|| "缺少目标数据库".to_string())?,
        excluded_tables: excluded_tables.unwrap_or_default(),
    })
}

fn build_overwrite_sync_request(
    request: Option<SyncDatabaseOverwriteRequest>,
    job_id: Option<String>,
    connection_id: Option<String>,
    source_database: Option<String>,
    target_database: Option<String>,
    excluded_tables: Option<Vec<String>>,
) -> Result<SyncDatabaseOverwriteRequest, String> {
    if let Some(request) = request {
        return Ok(request);
    }
    Ok(SyncDatabaseOverwriteRequest {
        job_id: job_id.ok_or_else(|| "缺少同步任务 ID".to_string())?,
        connection_id: connection_id.ok_or_else(|| "缺少连接 ID".to_string())?,
        source_database: source_database.ok_or_else(|| "缺少源数据库".to_string())?,
        target_database: target_database.ok_or_else(|| "缺少目标数据库".to_string())?,
        excluded_tables: excluded_tables.unwrap_or_default(),
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
    request: Option<PreviewDatabaseSyncRequest>,
    connection_id: Option<String>,
    source_database: Option<String>,
    target_database: Option<String>,
    excluded_tables: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<PreviewDatabaseSyncResponse, String> {
    let request = build_preview_sync_request(
        request,
        connection_id,
        source_database,
        target_database,
        excluded_tables,
    )?;
    let pool = real_connection_pool(&request.connection_id, &state).await?;
    sync::preview_database_sync(
        &pool,
        &request.source_database,
        &request.target_database,
        request.excluded_tables,
    )
    .await
}

#[tauri::command]
pub async fn sync_database_overwrite(
    window: Window,
    request: Option<SyncDatabaseOverwriteRequest>,
    job_id: Option<String>,
    connection_id: Option<String>,
    source_database: Option<String>,
    target_database: Option<String>,
    excluded_tables: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<SyncDatabaseOverwriteResponse, String> {
    let request = build_overwrite_sync_request(
        request,
        job_id,
        connection_id,
        source_database,
        target_database,
        excluded_tables,
    )?;
    let pool = real_connection_pool(&request.connection_id, &state).await?;
    sync::execute_database_sync(&pool, request, |payload| {
        let _ = window.emit(DATABASE_SYNC_PROGRESS_EVENT, payload);
    })
    .await
}

#[tauri::command]
pub async fn list_databases(
    connection_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let (connection_id, mysql_url, pool, demo_profile) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection_id,
            connection.mysql_url.clone(),
            connection.pool.clone(),
            rt.demo_profile,
        )
    };
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
    let (connection_id, mysql_url, demo_profile) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (connection_id, connection.mysql_url.clone(), rt.demo_profile)
    };
    if let Some(mysql_url) = mysql_url {
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
        rt.schema = match demo_profile {
            Some(DemoProfile::Stress) => stress_schema_for(&database),
            None => Vec::new(),
        };
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
    let (pool, selected_database, schema) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.pool.clone(),
            connection
                .database
                .clone()
                .unwrap_or_else(|| rt.selected_database.clone()),
            rt.schema.clone(),
        )
    };
    let database = database.unwrap_or(selected_database);
    if let Some(pool) = pool {
        list_tables_from_db(&pool, &database).await
    } else {
        Ok(schema
            .into_iter()
            .map(|table| TableOption {
                table_name: table.table_name,
                table_comment: table.table_comment,
            })
            .collect())
    }
}

#[tauri::command]
pub async fn get_table_schema(
    connection_id: Option<String>,
    database: Option<String>,
    table_name: String,
    state: State<'_, AppState>,
) -> Result<TableMeta, String> {
    let (pool, database, schema, demo_profile) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.pool.clone(),
            database.unwrap_or_else(|| {
                connection
                    .database
                    .clone()
                    .unwrap_or_else(|| rt.selected_database.clone())
            }),
            rt.schema.clone(),
            rt.demo_profile,
        )
    };
    if let Some(pool) = pool {
        read_schema(&pool, &database, &table_name).await
    } else if demo_profile.is_some() {
        resolve_demo_table(&table_name, &schema)
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
    update_demo_rows_for_renames(rows, &request.table_name, &renames);
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
    let (connection_id, pool, database, schema) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection_id,
            connection.pool.clone(),
            database.unwrap_or_else(|| {
                connection
                    .database
                    .clone()
                    .unwrap_or_else(|| rt.selected_database.clone())
            }),
            rt.schema.clone(),
        )
    };
    if let Some(pool) = pool {
        read_table_design(&pool, &database, &table_name, &connection_id).await
    } else {
        demo_table_design_from_schema(&connection_id, &database, &table_name, &schema)
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
    let request = build_table_design_preview_request(request, connection_id, database, table_name, draft)?;
    let (pool, schema) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (connection.pool.clone(), rt.schema.clone())
    };
    let current = if let Some(pool) = pool {
        read_table_design(
            &pool,
            &request.database,
            &request.table_name,
            &request.connection_id,
        )
        .await?
    } else {
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
    state: State<'_, AppState>,
) -> Result<ApplyTableDesignResult, String> {
    let request = build_apply_table_design_request(request, connection_id, database, table_name, draft, schema_signature, source_signature, preview_signature)?;
    let pool = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        connection.pool.clone()
    };
    if let Some(pool) = pool {
        let current = read_table_design(
            &pool,
            &request.database,
            &request.table_name,
            &request.connection_id,
        )
        .await?;
        let preview = crate::ddl::verify_table_design_apply(&current, &request)?;
        for statement in &preview.statements {
            sqlx::query(statement)
                .execute(&pool)
                .await
                .map_err(|error| format!("应用表设计失败: {error}"))?;
        }
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
    let result = apply_demo_table_design_change(&mut rt.schema, &mut rows, request);
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
    let (connection_id, database, mysql_url, schema, demo_profile, materialized_rows) = {
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
        (
            connection_id,
            database,
            connection.mysql_url.clone(),
            rt.schema.clone(),
            rt.demo_profile,
            rt.demo_rows.get(&requested_table_name).cloned(),
        )
    };
    let pool = match mysql_url {
        Some(mysql_url) => Some(connect_database(&mysql_url, Some(&database)).await?),
        None => None,
    };
    let table = if let Some(pool) = pool.as_ref() {
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
                database,
                table_name: table_name.clone(),
                pool: pool.clone(),
            },
        );
        session_id
    };
    if let Some(pool) = pool {
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
        let materialized_rows = rt.demo_rows.get(&session.table_name).cloned();
        (
            session,
            rt.schema.clone(),
            rt.demo_profile,
            materialized_rows,
        )
    };
    let table = if let Some(pool) = session.pool.as_ref() {
        read_schema(pool, &session.database, &session.table_name).await?
    } else {
        resolve_demo_table(&session.table_name, &schema)?
    };
    if let Some(pool) = session.pool {
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

fn would_duplicate_primary_key_update(
    table: &TableMeta,
    rows: &[HashMap<String, String>],
    row_index: usize,
    column_name: &str,
    new_value: &str,
) -> bool {
    let primary_keys = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    if primary_keys.is_empty() || !primary_keys.iter().any(|key| key == column_name) {
        return false;
    }
    let Some(row) = rows.get(row_index) else {
        return false;
    };
    let next_values = primary_keys
        .iter()
        .map(|key| {
            if key == column_name {
                new_value.to_string()
            } else {
                row.get(key).cloned().unwrap_or_default()
            }
        })
        .collect::<Vec<_>>();
    if next_values.iter().any(|value| value.trim().is_empty()) {
        return false;
    }
    rows.iter().enumerate().any(|(index, candidate)| {
        index != row_index
            && primary_keys.iter().zip(next_values.iter()).all(|(key, value)| {
                candidate
                    .get(key)
                    .map(|current| current.trim() == value.trim())
                    .unwrap_or(false)
            })
    })
}

#[tauri::command]
pub async fn update_cell(
    request: UpdateCellRequest,
    state: State<'_, AppState>,
) -> Result<UpdateCellResult, String> {
    if request.old_value == request.new_value {
        return Ok(UpdateCellResult {
            updated: false,
            conflict: false,
            value: request.new_value,
        });
    }
    let session = {
        let rt = state.runtime.lock().await;
        rt.sessions
            .get(&request.session_id)
            .cloned()
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };

    if let Some(pool) = session.pool {
        let (where_sql, mut values) = build_where(&request.row_identity)?;
        let sql = format!(
            "UPDATE `{}` SET `{}` = ? WHERE {} AND `{}` = ? LIMIT 1",
            escape_ident(&session.table_name),
            escape_ident(&request.column_name),
            where_sql,
            escape_ident(&request.column_name)
        );
        let mut query = sqlx::query(&sql).bind(&request.new_value);
        values.push(request.old_value.clone());
        for value in values {
            query = query.bind(value);
        }
        let affected = query
            .execute(&pool)
            .await
            .map_err(|error| {
                if is_duplicate_key_error(&error) {
                    PRIMARY_KEY_DUPLICATE_MESSAGE.to_string()
                } else {
                    format!("保存失败: {error}")
                }
            })?
            .rows_affected();
        return Ok(UpdateCellResult {
            updated: affected > 0,
            conflict: affected == 0,
            value: request.new_value,
        });
    }

    let mut rt = state.runtime.lock().await;
    let table = resolve_demo_table(&session.table_name, &rt.schema)?;
    let profile = rt.demo_profile;
    let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &table);
    let matched_index = rows.iter().position(|row| {
        request.row_identity.iter().all(|(key, value)| {
            row.get(key)
                .map(|current| current == value)
                .unwrap_or(false)
        })
    });
    if let Some(row_index) = matched_index {
        let current = rows[row_index].get(&request.column_name).cloned().unwrap_or_default();
        if current != request.old_value {
            return Ok(UpdateCellResult {
                updated: false,
                conflict: true,
                value: current,
            });
        }
        if would_duplicate_primary_key_update(&table, rows, row_index, &request.column_name, &request.new_value) {
            return Err(PRIMARY_KEY_DUPLICATE_MESSAGE.into());
        }
        rows[row_index].insert(request.column_name, request.new_value.clone());
        return Ok(UpdateCellResult {
            updated: true,
            conflict: false,
            value: request.new_value,
        });
    }
    Ok(UpdateCellResult {
        updated: false,
        conflict: true,
        value: request.old_value,
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

fn has_primary_key_conflict(
    table: &TableMeta,
    rows: &[HashMap<String, String>],
    draft: &HashMap<String, String>,
) -> bool {
    let Some(values) = complete_primary_key_values(table, draft) else {
        return false;
    };
    rows.iter().any(|row| {
        values.iter().all(|(key, value)| {
            row.get(key)
                .map(|current| current.trim() == value)
                .unwrap_or(false)
        })
    })
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

fn is_duplicate_key_error(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::Database(db_error) if db_error.code().as_deref() == Some("1062"))
}

#[tauri::command]
pub async fn insert_row(
    request: InsertRowRequest,
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
    let draft = request.draft;

    if let Some(pool) = session.pool {
        let table = read_schema(&pool, &session.database, &session.table_name).await?;
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
        let mut query = sqlx::query(&sql);
        for key in keys {
            query = query.bind(draft.get(&key).cloned().unwrap_or_default());
        }
        let affected = query
            .execute(&pool)
            .await
            .map_err(|error| {
                if is_duplicate_key_error(&error) {
                    PRIMARY_KEY_DUPLICATE_MESSAGE.to_string()
                } else {
                    format!("插入失败: {error}")
                }
            })?
            .rows_affected();
        return Ok(RowMutationResult { affected });
    }

    let mut rt = state.runtime.lock().await;
    let table = resolve_demo_table(&session.table_name, &rt.schema)?;
    let profile = rt.demo_profile;
    let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &table);
    if has_primary_key_conflict(&table, rows, &draft) {
        return Err(PRIMARY_KEY_DUPLICATE_MESSAGE.into());
    }
    rows.push(draft);
    Ok(RowMutationResult { affected: 1 })
}

#[tauri::command]
pub async fn delete_rows(
    request: DeleteRowsRequest,
    state: State<'_, AppState>,
) -> Result<RowMutationResult, String> {
    let session = {
        let rt = state.runtime.lock().await;
        rt.sessions
            .get(&request.session_id)
            .cloned()
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?
    };

    if let Some(pool) = session.pool {
        let mut affected = 0;
        for identity in &request.row_identities {
            let (where_sql, values) = build_where(identity)?;
            let sql = format!(
                "DELETE FROM `{}` WHERE {} LIMIT 1",
                escape_ident(&session.table_name),
                where_sql
            );
            let mut query = sqlx::query(&sql);
            for value in values {
                query = query.bind(value);
            }
            affected += query
                .execute(&pool)
                .await
                .map_err(|error| format!("删除失败: {error}"))?
                .rows_affected();
        }
        return Ok(RowMutationResult { affected });
    }

    let mut rt = state.runtime.lock().await;
    let table = resolve_demo_table(&session.table_name, &rt.schema)?;
    let profile = rt.demo_profile;
    let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &table);
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
    request: SearchValuesRequest,
    state: State<'_, AppState>,
) -> Result<Vec<SearchValueItem>, String> {
    let query = request.query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = request.limit.unwrap_or(50).clamp(1, 50);
    let (connection_id, database, mysql_url, demo_rows) = {
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
        (
            connection_id,
            database,
            connection.mysql_url.clone(),
            rt.demo_rows.clone(),
        )
    };

    if database.trim().is_empty() {
        return Err("请先选择数据库".into());
    }

    if let Some(mysql_url) = mysql_url {
        let pool = connect_database(&mysql_url, Some(&database)).await?;
        let mut results = Vec::new();
        let tables = list_tables_from_db(&pool, &database).await?;
        for table_ref in tables.into_iter().take(SEARCH_VALUES_TABLE_SCAN_LIMIT) {
            let table = read_schema(&pool, &database, &table_ref.table_name).await?;
            if let Some(item) = search_first_value_match(&pool, &table, &query).await? {
                results.push(item);
                if results.len() >= limit {
                    break;
                }
            }
        }
        return Ok(results);
    }

    let schema = demo_schema_for(&connection_id, &database);
    Ok(search_demo_values(&schema, &demo_rows, &query, limit))
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
    let (schema, demo_profile, demo_rows) = {
        let rt = state.runtime.lock().await;
        (rt.schema.clone(), rt.demo_profile, rt.demo_rows.clone())
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
                .get(&table.table_name)
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
        ColumnMeta {
            column_name: name.into(),
            column_type: "varchar(32)".into(),
            column_comment: String::new(),
            is_primary_key: pk,
            is_nullable: !pk,
        }
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

        assert!(would_duplicate_primary_key_update(&table, &rows, 0, "id", "2"));
        assert!(!would_duplicate_primary_key_update(&table, &rows, 0, "id", "1"));
        assert!(!would_duplicate_primary_key_update(&table, &rows, 0, "name", "bob"));
    }

    #[test]
    fn primary_key_conflict_detection_matches_complete_composite_keys_only() {
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

        assert!(has_primary_key_conflict(&table, &rows, &duplicate));
        assert!(!has_primary_key_conflict(&table, &rows, &partial));
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
            "player".into(),
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
            rows["player"][0].get("login_name"),
            Some(&"alice".to_string())
        );
        assert!(!rows["player"][0].contains_key("username"));
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
            apply_demo_table_design_change(&mut schema, &mut rows, missing)
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
            apply_demo_table_design_change(&mut schema, &mut rows, stale)
                .unwrap_err()
                .to_lowercase()
                .contains("signature")
        );
    }
}

async fn connect_and_store(
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
            label: format!("MySQL {connection_number}"),
            host: "configured".into(),
            port: 3306,
            username: "mysql".into(),
            mysql_url: Some(url),
            database: None,
            pool: Some(pool),
        },
    );
    if select {
        rt.selected_connection_id = id;
    }
    Ok(db_list)
}

#[tauri::command]
pub async fn add_connection(
    url: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    connect_and_store(url, state, true).await
}

#[tauri::command]
pub async fn restore_connection(
    url: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    connect_and_store(url, state, false).await
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
