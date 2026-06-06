use std::collections::HashMap;

use sqlx::{MySqlPool, Row};
use tauri::{Emitter, State, Window};

use crate::db::{
    build_where, connect_database, escape_ident, list_tables_from_db, read_db_page, read_schema,
};
use crate::demo::{demo_databases, demo_schema_for, read_demo_page, resolve_demo_table};
use crate::sync::{self, DATABASE_SYNC_PROGRESS_EVENT};
use crate::types::*;

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
    let (connection_id, mysql_url, pool) = {
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
        )
    };
    let Some(mysql_url) = mysql_url else {
        return Ok(demo_databases(&connection_id));
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
    let (connection_id, mysql_url) = {
        let rt = state.runtime.lock().await;
        let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (connection_id, connection.mysql_url.clone())
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
        rt.schema = demo_schema_for(&connection_id, &database);
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
    let (pool, database, schema) = {
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
        )
    };
    if let Some(pool) = pool {
        read_schema(&pool, &database, &table_name).await
    } else {
        resolve_demo_table(&table_name, &schema)
    }
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
    let (connection_id, database, mysql_url, schema, demo_rows) = {
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
            rt.demo_rows.clone(),
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
    } else {
        Ok(read_demo_page(&demo_rows, &table, &session_id, &request))
    }
}

#[tauri::command]
pub async fn fetch_table_page(
    session_id: String,
    request: Option<TablePageRequest>,
    state: State<'_, AppState>,
) -> Result<TableSessionPage, String> {
    let request = request.unwrap_or_default();
    let (session, schema, demo_rows) = {
        let rt = state.runtime.lock().await;
        let session = rt
            .sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?;
        (session, rt.schema.clone(), rt.demo_rows.clone())
    };
    let table = if let Some(pool) = session.pool.as_ref() {
        read_schema(pool, &session.database, &session.table_name).await?
    } else {
        resolve_demo_table(&session.table_name, &schema)?
    };
    if let Some(pool) = session.pool {
        read_db_page(&pool, &table, &session_id, &request).await
    } else {
        Ok(read_demo_page(&demo_rows, &table, &session_id, &request))
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
            .map_err(|error| format!("保存失败: {error}"))?
            .rows_affected();
        return Ok(UpdateCellResult {
            updated: affected > 0,
            conflict: affected == 0,
            value: request.new_value,
        });
    }

    let mut rt = state.runtime.lock().await;
    let rows = rt.demo_rows.entry(session.table_name).or_default();
    for row in rows {
        let matched = request.row_identity.iter().all(|(key, value)| {
            row.get(key)
                .map(|current| current == value)
                .unwrap_or(false)
        });
        if matched {
            let current = row.get(&request.column_name).cloned().unwrap_or_default();
            if current != request.old_value {
                return Ok(UpdateCellResult {
                    updated: false,
                    conflict: true,
                    value: current,
                });
            }
            row.insert(request.column_name, request.new_value.clone());
            return Ok(UpdateCellResult {
                updated: true,
                conflict: false,
                value: request.new_value,
            });
        }
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
    let rows = rt.demo_rows.entry(session.table_name).or_default();
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
    let rows = rt.demo_rows.entry(session.table_name).or_default();
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
pub async fn quick_search(
    request: QuickSearchRequest,
    state: State<'_, AppState>,
) -> Result<Vec<QuickSearchItem>, String> {
    let query = request.query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let scope = request.scope.unwrap_or_else(|| "schema".into());
    let (schema, demo_rows) = {
        let rt = state.runtime.lock().await;
        (rt.schema.clone(), rt.demo_rows.clone())
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
            for row in demo_rows
                .get(&table.table_name)
                .into_iter()
                .flatten()
                .take(20)
            {
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
