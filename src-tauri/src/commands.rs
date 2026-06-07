use std::collections::HashMap;

use sqlx::{MySqlPool, Row};
use tauri::{Emitter, State, Window};

use crate::db::{
    build_where, connect_database, escape_ident, list_tables_from_db, read_db_page, read_schema,
    read_table_design, search_first_value_match,
};
use crate::demo::{
    materialize_stress_rows, read_stress_or_materialized_page, resolve_demo_table,
    sample_stress_rows, search_demo_values, stress_databases, stress_schema_for,
};
use crate::sync::{self, DATABASE_SYNC_PROGRESS_EVENT};
use crate::types::*;

const SEARCH_VALUES_TABLE_SCAN_LIMIT: usize = 200;

fn no_demo_error() -> String {
    "没有可用的内置演示数据，请先新建 MySQL 连接".into()
}

fn demo_row_key(database: &str, table_name: &str) -> String {
    format!("{database}\x1f{table_name}")
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
    rows.get_mut(&row_key)
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

fn table_names(schema: &[TableMeta]) -> Vec<String> {
    schema.iter().map(|table| table.table_name.clone()).collect()
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
        rows.insert(demo_row_key(&request.target_database, &table.table_name), source_rows);
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
    let (mysql_url, pool, demo_profile, selected_database, selected_schema, overrides, rows) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.mysql_url.clone(),
            connection.pool.clone(),
            rt.demo_profile,
            rt.selected_database.clone(),
            rt.schema.clone(),
            rt.demo_schema_overrides.clone(),
            rt.demo_rows.clone(),
        )
    };
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
    let (mysql_url, pool, demo_profile) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.mysql_url.clone(),
            connection.pool.clone(),
            rt.demo_profile,
        )
    };
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
    let result = execute_demo_database_sync(
        &request,
        &mut schemas,
        &mut rt.demo_rows,
        |payload| {
            let _ = window.emit(DATABASE_SYNC_PROGRESS_EVENT, payload);
        },
    )?;
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
    let (mysql_url, pool) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (connection.mysql_url.clone(), connection.pool.clone())
    };
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
        let source_rows = materialized_demo_rows_for(
            &request.source_database,
            &rt.demo_rows,
            &source_table,
        );
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
    state: State<'_, AppState>,
) -> Result<RenameTableResponse, String> {
    let (mysql_url, pool) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (connection.mysql_url.clone(), connection.pool.clone())
    };
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
        sqlx::query(&sql)
            .execute(&pool)
            .await
            .map_err(|e| format!("重命名失败: {e}"))?;
        return Ok(RenameTableResponse {
            renamed: true,
            from: table_name,
            to: new_name,
        });
    }
    // Demo path
    let mut rt = state.runtime.lock().await;
    let mut schemas = rt.demo_schema_overrides.remove(&database).unwrap_or_else(|| {
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
    if schemas
        .iter()
        .any(|t| t.table_name.eq_ignore_ascii_case(&new_name) && t.table_name != schemas[idx].table_name)
    {
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
    if !schema.iter().any(|t| t.table_name.eq_ignore_ascii_case(base_name)) {
        return base_name.to_string();
    }
    let candidate = format!("{base_name}_copy");
    if !schema.iter().any(|t| t.table_name.eq_ignore_ascii_case(&candidate)) {
        return candidate;
    }
    let mut n = 1_u32;
    loop {
        let next = format!("{base_name}_copy{n}");
        if !schema.iter().any(|t| t.table_name.eq_ignore_ascii_case(&next)) {
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
        let ddl = sync::show_create_table(&mut connection, &request.source_database, table_name).await?;
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

        let columns = sync::list_columns(&mut connection, &request.source_database, table_name).await?;
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

fn resolve_copy_table_name_from_set(existing: &std::collections::HashSet<String>, base_name: &str) -> String {
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
    let (pool, selected_database, schema, demo_profile, overrides) = {
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
            rt.demo_profile,
            rt.demo_schema_overrides.clone(),
        )
    };
    let database = database.unwrap_or(selected_database);
    if let Some(pool) = pool {
        list_tables_from_db(&pool, &database).await
    } else {
        Ok(demo_schema_for_runtime(&overrides, demo_profile, &database, &database, &schema)
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
    let (pool, database, schema, demo_profile, overrides, selected_database) = {
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
            rt.demo_schema_overrides.clone(),
            rt.selected_database.clone(),
        )
    };
    if let Some(pool) = pool {
        read_schema(&pool, &database, &table_name).await
    } else if demo_profile.is_some() {
        let demo_schema =
            demo_schema_for_runtime(&overrides, demo_profile, &database, &selected_database, &schema);
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
    update_demo_rows_for_renames(rows, &demo_row_key(&request.database, &request.table_name), &renames);
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
    let (connection_id, pool, database, schema, demo_profile, overrides, selected_database) = {
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
            rt.demo_profile,
            rt.demo_schema_overrides.clone(),
            rt.selected_database.clone(),
        )
    };
    if let Some(pool) = pool {
        read_table_design(&pool, &database, &table_name, &connection_id).await
    } else {
        let demo_schema =
            demo_schema_for_runtime(&overrides, demo_profile, &database, &selected_database, &schema);
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
    let request = build_table_design_preview_request(request, connection_id, database, table_name, draft)?;
    let (pool, schema, demo_profile, overrides, selected_database) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&request.connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.pool.clone(),
            rt.schema.clone(),
            rt.demo_profile,
            rt.demo_schema_overrides.clone(),
            rt.selected_database.clone(),
        )
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
            database,
            connection.mysql_url.clone(),
            schema,
            rt.demo_profile,
            rt.demo_rows.get(&row_key).cloned(),
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
        let schema = demo_schema_for_runtime(
            &rt.demo_schema_overrides,
            rt.demo_profile,
            &session.database,
            &rt.selected_database,
            &rt.schema,
        );
        let row_key = demo_row_key(&session.database, &session.table_name);
        let materialized_rows = rt.demo_rows.get(&row_key).cloned();
        (
            session,
            schema,
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
        let table = read_schema(&pool, &session.database, &session.table_name).await?;
        if let Err(error) =
            crate::validation::validate_column_value(&table, &request.column_name, &request.new_value)
        {
            return Err(error.message);
        }
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
                crate::validation::mysql_error_message(&error)
                    .unwrap_or_else(|| format!("保存失败: {error}"))
            })?
            .rows_affected();
        return Ok(UpdateCellResult {
            updated: affected > 0,
            conflict: affected == 0,
            value: request.new_value,
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
    let rows =
        ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &session.database, &table);
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
        if let Err(error) = crate::validation::validate_cell_value(
            &table,
            rows,
            row_index,
            &request.column_name,
            &request.new_value,
        ) {
            return Err(error.message);
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
        let mut query = sqlx::query(&sql);
        for key in keys {
            query = query.bind(draft.get(&key).cloned().unwrap_or_default());
        }
        let affected = query
            .execute(&pool)
            .await
            .map_err(|error| {
                crate::validation::mysql_error_message(&error)
                    .unwrap_or_else(|| format!("插入失败: {error}"))
            })?
            .rows_affected();
        return Ok(RowMutationResult { affected });
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
    let rows =
        ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &session.database, &table);
    if let Err(error) = crate::validation::validate_row_draft(&table, rows, &draft) {
        return Err(error.message);
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
    let (_connection_id, database, mysql_url, demo_rows, schema) = {
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
            connection.mysql_url.clone(),
            rt.demo_rows.clone(),
            schema,
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

    let scoped_rows = schema
        .iter()
        .filter_map(|table| {
            demo_rows
                .get(&demo_row_key(&database, &table.table_name))
                .cloned()
                .map(|rows| (table.table_name.clone(), rows))
        })
        .collect::<HashMap<_, _>>();
    Ok(search_demo_values(&schema, &scoped_rows, &query, limit))
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
            crate::validation::validate_cell_value(&table, &rows, 0, "id", "2")
                .unwrap_err()
                .code,
            "duplicate-primary-key"
        );
        assert!(crate::validation::validate_cell_value(&table, &rows, 0, "id", "1").is_ok());
        assert!(crate::validation::validate_cell_value(&table, &rows, 0, "name", "bob").is_ok());
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
            ("game_db_01".to_string(), crate::demo::stress_schema_for("game_db_01")),
            ("game_db_04".to_string(), crate::demo::stress_schema_for("game_db_04")),
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

        assert!(preview.source_tables.contains(&"db01_config_0001".to_string()));
        assert!(preview.included_tables.contains(&"db01_config_0001".to_string()));
        assert!(!preview.included_tables.contains(&"db01_activity_0002".to_string()));
        assert!(preview.target_only_tables_to_drop.contains(&"db04_config_0001".to_string()));
        assert_eq!(preview.excluded_tables, vec!["db01_activity_0002"]);
    }

    #[test]
    fn demo_database_sync_execute_isolates_target_schema_and_rows() {
        let mut schemas = HashMap::from([
            ("game_db_01".to_string(), crate::demo::stress_schema_for("game_db_01")),
            ("game_db_04".to_string(), crate::demo::stress_schema_for("game_db_04")),
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
        assert!(result.copied_tables.contains(&"db01_config_0001".to_string()));
        assert!(!result.copied_tables.contains(&"db01_activity_0002".to_string()));
        assert!(result.dropped_tables.contains(&"db04_config_0001".to_string()));
        assert!(schemas["game_db_04"].iter().any(|table| table.table_name == "db01_config_0001"));
        assert!(!schemas["game_db_04"].iter().any(|table| table.table_name == "db04_config_0001"));
        assert!(schemas["game_db_01"].iter().any(|table| table.table_name == "db01_config_0001"));
        assert!(rows.contains_key("game_db_04\x1fdb01_config_0001"));
        assert!(!rows.contains_key("game_db_01\x1fdb01_config_0001"));
        assert!(events.iter().any(|event| event.status == "completed"));

        let fresh = RuntimeState::new(
            None,
            RuntimeOptions {
                demo_profile: Some(DemoProfile::Stress),
            },
        );
        assert!(fresh.schema.iter().any(|table| table.table_name == "db01_config_0001"));
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
