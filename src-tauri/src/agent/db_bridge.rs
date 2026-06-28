use std::collections::HashMap;

use serde_json::Value;
use sqlx::{Column as SqlxColumn, Row};
use tauri::{AppHandle, State};

use crate::agent::protocol::AgentContext;
use crate::agent::sql_guard::{validate_read_only_sql, ReadOnlyLimit};
use crate::audit;
use crate::db::{
    connect_database, list_tables_from_db, read_db_page, read_schema, read_schemas_for_tables,
    search_value_matches_in_database,
};
use crate::demo::{demo_rows, demo_schema_for, sample_stress_rows};
use crate::types::*;

pub async fn handle_db_request(
    state: State<'_, AppState>,
    app: AppHandle,
    context: &AgentContext,
    func: &str,
    args: Value,
) -> Result<Value, String> {
    let connection_id = context.connection_id.as_deref().unwrap_or("");
    let database = context
        .database
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or("game_db");

    let rt = state.runtime.lock().await;
    let connection = rt.connections.get(connection_id).cloned();
    let is_demo = connection.as_ref().map_or(true, |c| c.mysql_url.is_none());
    drop(rt);

    if is_demo {
        handle_demo_request(&state, context, func, args).await
    } else {
        let connection = connection.ok_or_else(|| "connection not found".to_string())?;
        let mysql_url = connection
            .mysql_url
            .ok_or_else(|| "missing mysql url".to_string())?;
        let pool = ensure_pool(&state, connection_id, &mysql_url).await?;
        handle_real_request(&pool, connection_id, database, func, args, &state, &app).await
    }
}

async fn ensure_pool(
    state: &State<'_, AppState>,
    connection_id: &str,
    mysql_url: &str,
) -> Result<sqlx::MySqlPool, String> {
    {
        let rt = state.runtime.lock().await;
        if let Some(connection) = rt.connections.get(connection_id) {
            if let Some(pool) = &connection.pool {
                return Ok(pool.clone());
            }
        }
    }

    let pool = connect_database(mysql_url, None).await?;
    let mut rt = state.runtime.lock().await;
    if let Some(connection) = rt.connections.get_mut(connection_id) {
        connection.pool = Some(pool.clone());
    }
    Ok(pool)
}

async fn handle_real_request(
    pool: &sqlx::MySqlPool,
    connection_id: &str,
    database: &str,
    func: &str,
    args: Value,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<Value, String> {
    match func {
        "list_databases" => {
            let rows = sqlx::query(
                "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME",
            )
            .fetch_all(pool)
            .await
            .map_err(|error| format!("list databases failed: {}", error))?;
            let databases: Vec<String> = rows
                .into_iter()
                .map(|row| row.try_get::<String, _>("SCHEMA_NAME").unwrap_or_default())
                .filter(|name: &String| !name.is_empty())
                .collect();
            Ok(Value::Array(
                databases.into_iter().map(Value::String).collect(),
            ))
        }
        "list_tables" => {
            let tables = list_tables_from_db(pool, database).await?;
            let values: Vec<Value> = tables
                .into_iter()
                .map(|table| {
                    serde_json::json!({
                        "tableName": table.table_name,
                        "tableComment": table.table_comment,
                    })
                })
                .collect();
            Ok(Value::Array(values))
        }
        "describe_table" => {
            let table_name = table_arg(&args)?;
            let table = read_schema(pool, database, &table_name).await?;
            Ok(table_meta_to_value(&table))
        }
        "sample_rows" => {
            let table_name = table_arg(&args)?;
            let limit: u32 = arg_u32(&args, "limit").unwrap_or(10);
            let table = read_schema(pool, database, &table_name).await?;
            let page_request = TablePageRequest {
                page: Some(1),
                page_size: Some(limit),
                include_total: Some(false),
                filter: None,
                sort: None,
            };
            let page = read_db_page(pool, &table, "agent", &page_request).await?;
            Ok(serde_json::json!({
                "tableName": table.table_name,
                "rows": page.rows,
            }))
        }
        "search_schema" => {
            let query = query_arg(&args)?;
            let tables = list_tables_from_db(pool, database).await?;
            let schemas = read_schemas_for_tables(pool, database, &tables).await?;
            Ok(Value::Array(search_schema_results(&schemas, &query)))
        }
        "search_values" => {
            let query = query_arg(&args)?;
            let table_name = optional_table_arg(&args);
            let limit: usize = arg_u32(&args, "limit").unwrap_or(20) as usize;
            let tables = list_tables_from_db(pool, database).await?;
            let schemas = read_schemas_for_tables(pool, database, &tables).await?;
            let mut results = Vec::new();
            for table in schemas {
                if let Some(ref name) = table_name {
                    if !table.table_name.eq_ignore_ascii_case(name) {
                        continue;
                    }
                }
                let matches =
                    search_value_matches_in_database(pool, Some(database), &table, &query).await?;
                for item in matches
                    .into_iter()
                    .take(limit.saturating_sub(results.len()))
                {
                    results.push(serde_json::json!({
                        "tableName": item.table_name,
                        "tableComment": item.table_comment,
                        "columnName": item.column_name,
                        "previewValue": item.preview_value,
                    }));
                }
                if results.len() >= limit {
                    break;
                }
            }
            Ok(Value::Array(results))
        }
        "run_read_query" => {
            let sql = arg_str(&args, "sql")?;
            let limited = validate_read_only_sql(&sql, ReadOnlyLimit::Inject(100))?;
            let rows = sqlx::query(&limited)
                .fetch_all(pool)
                .await
                .map_err(|error| format!("query failed: {}", error))?;
            let columns: Vec<String> = rows
                .first()
                .map(|row| {
                    row.columns()
                        .iter()
                        .map(|col| col.name().to_string())
                        .collect()
                })
                .unwrap_or_default();
            let mut result_rows = Vec::new();
            for row in &rows {
                let mut map = serde_json::Map::new();
                for (i, column) in row.columns().iter().enumerate() {
                    let name: &str = column.name();
                    let value: Value = row
                        .try_get::<serde_json::Value, _>(i)
                        .unwrap_or(Value::Null);
                    map.insert(name.to_string(), value);
                }
                result_rows.push(Value::Object(map));
            }
            Ok(serde_json::json!({
                "columns": columns,
                "rows": result_rows,
            }))
        }
        "run_write_query" => {
            let sql = arg_str(&args, "sql")?;
            run_write_query(pool, connection_id, database, &sql, state, app).await
        }
        _ => Err(format!("unknown db function: {}", func)),
    }
}

async fn run_write_query(
    pool: &sqlx::MySqlPool,
    connection_id: &str,
    database: &str,
    sql: &str,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<Value, String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("SQL is empty".to_string());
    }

    // Reject multiple statements.
    let without_strings = crate::agent::sql_guard::mask_quoted_strings(trimmed);
    if without_strings
        .split(';')
        .filter(|part: &&str| !part.trim().is_empty())
        .count()
        > 1
    {
        return Err("multiple SQL statements are not allowed".to_string());
    }

    // Require a known write statement.
    let first_word = without_strings
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    let allowed = ["INSERT", "UPDATE", "DELETE", "REPLACE"];
    if !allowed.contains(&first_word.as_str()) {
        return Err(format!(
            "write queries must start with INSERT/UPDATE/DELETE/REPLACE, got: {}",
            first_word
        ));
    }

    // Best-effort audit: record the raw SQL as a manual-rollback entry. Arbitrary
    // agent SQL cannot be reliably inverted, so one-click rollback is not offered
    // for these rows — the snapshot layer (层1) is the recovery path. Recording
    // still gives a full "who ran what, when" trail.
    let operation = match first_word.as_str() {
        "INSERT" => "INSERT",
        "UPDATE" => "UPDATE",
        "DELETE" => "DELETE",
        _ => "REPLACE",
    };
    let (actor, client_id) = crate::account::audit_actor_and_id(app, state).await;
    let ctx = audit::AuditContext {
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        table_name: "(agent)".to_string(),
        session_id: None,
        source: audit::SOURCE_AGENT,
        actor,
        client_id,
    };
    let pending = audit::PendingAudit {
        operation,
        column_name: None,
        old_value: None,
        new_value: None,
        row_identity: None,
        forward_sql: trimmed.to_string(),
        forward_binds: Vec::new(),
        inverse_sql: None,
        inverse_binds: Vec::new(),
        rollback_strategy: audit::STRATEGY_MANUAL,
        notes: Some("Agent 任意 SQL，需手动回滚".into()),
    };
    let audit_id = match audit::ensure_audit_pool(app, state).await {
        Ok(pool) => audit::record_pending(&pool, &ctx, &pending).await.ok(),
        Err(_) => None,
    };

    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("failed to begin transaction: {}", error))?;

    let result = sqlx::query(trimmed).execute(&mut *tx).await;

    match result {
        Ok(result) => {
            tx.commit()
                .await
                .map_err(|error| format!("failed to commit transaction: {}", error))?;
            if let Some(id) = audit_id {
                if let Ok(audit_pool) = audit::ensure_audit_pool(app, state).await {
                    audit::mark_committed(&audit_pool, &[id]).await;
                    crate::audit_sync::trigger_immediate_sync(app);
                }
            }
            Ok(serde_json::json!({
                "affectedRows": result.rows_affected(),
                "lastInsertId": result.last_insert_id(),
            }))
        }
        Err(error) => {
            tx.rollback().await.ok();
            if let Some(id) = audit_id {
                if let Ok(audit_pool) = audit::ensure_audit_pool(app, state).await {
                    audit::mark_aborted(&audit_pool, &[id]).await;
                }
            }
            Err(format!("write query failed: {}", error))
        }
    }
}

async fn handle_demo_request(
    state: &State<'_, AppState>,
    _context: &AgentContext,
    func: &str,
    args: Value,
) -> Result<Value, String> {
    let rt = state.runtime.lock().await;
    let database = _context
        .database
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(&rt.selected_database)
        .to_string();

    match func {
        "list_databases" => {
            let mut databases: std::collections::HashSet<String> = rt
                .demo_schema_overrides
                .keys()
                .filter_map(|key| key.split('/').nth(1).map(String::from))
                .collect();
            databases.insert(rt.selected_database.clone());
            databases.insert(database.clone());
            if databases.iter().all(|db| db.is_empty()) {
                databases.insert("game_db".into());
            }
            let mut result: Vec<String> =
                databases.into_iter().filter(|db| !db.is_empty()).collect();
            result.sort();
            drop(rt);
            Ok(Value::Array(
                result.into_iter().map(Value::String).collect(),
            ))
        }
        "list_tables" => {
            let schema = schema_for(&rt, &database);
            drop(rt);
            Ok(Value::Array(
                schema
                    .into_iter()
                    .map(|table| {
                        serde_json::json!({
                            "tableName": table.table_name,
                            "tableComment": table.table_comment,
                        })
                    })
                    .collect(),
            ))
        }
        "describe_table" => {
            let table_name = table_arg(&args)?;
            let table = find_table(&rt, &database, &table_name)?;
            drop(rt);
            Ok(table_meta_to_value(&table))
        }
        "sample_rows" => {
            let table_name = table_arg(&args)?;
            let limit: usize = arg_u32(&args, "limit").unwrap_or(10) as usize;
            let table = find_table(&rt, &database, &table_name)?;
            let rows = demo_rows_for_table(&rt, &table, &database, limit);
            drop(rt);
            Ok(serde_json::json!({
                "tableName": table.table_name,
                "rows": rows,
            }))
        }
        "search_schema" => {
            let query = query_arg(&args)?;
            let schema = schema_for(&rt, &database);
            drop(rt);
            Ok(Value::Array(search_schema_results(&schema, &query)))
        }
        "search_values" => {
            let query = query_arg(&args)?;
            let table_name = optional_table_arg(&args);
            let limit: usize = arg_u32(&args, "limit").unwrap_or(20) as usize;
            let schema = schema_for(&rt, &database);
            let mut results = Vec::new();
            for table in schema {
                if let Some(ref name) = table_name {
                    if !table.table_name.eq_ignore_ascii_case(name) {
                        continue;
                    }
                }
                let rows = demo_rows_for_table(&rt, &table, &database, 500);
                for row in rows {
                    for column in &table.columns {
                        let value: String =
                            row.get(&column.column_name).cloned().unwrap_or_default();
                        if value.to_lowercase().contains(&query.to_lowercase()) {
                            results.push(serde_json::json!({
                                "tableName": table.table_name,
                                "columnName": column.column_name,
                                "previewValue": value.chars().take(80).collect::<String>(),
                            }));
                            if results.len() >= limit {
                                return Ok(Value::Array(results));
                            }
                        }
                    }
                }
            }
            drop(rt);
            Ok(Value::Array(results))
        }
        "run_read_query" => {
            let sql = arg_str(&args, "sql")?;
            let _ = validate_read_only_sql(&sql, ReadOnlyLimit::Inject(100))?;
            drop(rt);
            Err("run_read_query is not supported in demo mode".to_string())
        }
        "run_write_query" => {
            drop(rt);
            Err("run_write_query is not supported in demo mode".to_string())
        }
        _ => {
            drop(rt);
            Err(format!("unknown db function: {}", func))
        }
    }
}

fn schema_for(rt: &RuntimeState, database: &str) -> Vec<TableMeta> {
    if database == rt.selected_database && !rt.schema.is_empty() {
        return rt.schema.clone();
    }
    let prefix = format!("{}/{}", rt.selected_connection_id, database);
    rt.demo_schema_overrides
        .iter()
        .filter(|(key, _)| key.starts_with(&prefix))
        .map(|(_, tables)| tables.clone())
        .next()
        .unwrap_or_else(|| demo_schema_for(&rt.selected_connection_id, database))
}

fn demo_row_key(database: &str, table_name: &str) -> String {
    format!("{database}\x1f{table_name}")
}

fn demo_rows_for_table(
    rt: &RuntimeState,
    table: &TableMeta,
    database: &str,
    limit: usize,
) -> Vec<HashMap<String, String>> {
    let key = demo_row_key(database, &table.table_name);
    if let Some(rows) = rt.demo_rows.get(&key) {
        return rows.iter().take(limit).cloned().collect();
    }
    if matches!(rt.demo_profile, Some(DemoProfile::Stress)) {
        return sample_stress_rows(table, limit);
    }
    demo_rows()
        .get(&table.table_name)
        .map(|rows| rows.iter().take(limit).cloned().collect())
        .unwrap_or_default()
}

fn find_table(rt: &RuntimeState, database: &str, table_name: &str) -> Result<TableMeta, String> {
    schema_for(rt, database)
        .into_iter()
        .find(|table| table.table_name.eq_ignore_ascii_case(table_name))
        .ok_or_else(|| format!("table not found: {}", table_name))
}

fn table_meta_to_value(table: &TableMeta) -> Value {
    serde_json::json!({
        "tableName": table.table_name,
        "tableComment": table.table_comment,
        "columns": table.columns.iter().map(|column| {
            serde_json::json!({
                "columnName": column.column_name,
                "columnType": column.column_type,
                "columnComment": column.column_comment,
                "isPrimaryKey": column.is_primary_key,
                "isNullable": column.is_nullable,
                "dataType": column.data_type,
            })
        }).collect::<Vec<_>>(),
    })
}

fn search_schema_results(schema: &[TableMeta], query: &str) -> Vec<Value> {
    let q = query.to_lowercase();
    let mut results = Vec::new();
    for table in schema {
        if table.table_name.to_lowercase().contains(&q)
            || table.table_comment.to_lowercase().contains(&q)
        {
            results.push(serde_json::json!({
                "kind": "table",
                "tableName": table.table_name,
                "tableComment": table.table_comment,
            }));
        }
        for column in &table.columns {
            if column.column_name.to_lowercase().contains(&q)
                || column.column_comment.to_lowercase().contains(&q)
            {
                results.push(serde_json::json!({
                    "kind": "column",
                    "tableName": table.table_name,
                    "columnName": column.column_name,
                    "columnType": column.column_type,
                    "columnComment": column.column_comment,
                }));
            }
        }
    }
    results
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(String::from)
        .ok_or_else(|| format!("missing or invalid argument: {}", key))
}

fn table_arg(args: &Value) -> Result<String, String> {
    arg_str_alias(args, &["tableName", "table"], "tableName/table")
}

fn optional_table_arg(args: &Value) -> Option<String> {
    arg_str_alias(args, &["tableName", "table"], "tableName/table").ok()
}

fn query_arg(args: &Value) -> Result<String, String> {
    arg_str_alias(args, &["query", "keyword"], "query/keyword")
}

fn arg_str_alias(args: &Value, keys: &[&str], label: &str) -> Result<String, String> {
    for key in keys {
        if let Some(value) = args.get(*key).and_then(|value| value.as_str()) {
            return Ok(value.to_string());
        }
    }
    Err(format!("missing or invalid argument: {}", label))
}

fn arg_u32(args: &Value, key: &str) -> Result<u32, String> {
    args.get(key)
        .and_then(|value| value.as_u64())
        .map(|value| value as u32)
        .ok_or_else(|| format!("missing or invalid argument: {}", key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_table_argument_from_sidecar_tool_schema_name() {
        let args = serde_json::json!({ "table": "player" });
        assert_eq!(
            arg_str_alias(&args, &["tableName", "table"], "tableName").unwrap(),
            "player"
        );
    }

    #[test]
    fn reads_query_argument_from_sidecar_keyword_schema_name() {
        let args = serde_json::json!({ "keyword": "level" });
        assert_eq!(
            arg_str_alias(&args, &["query", "keyword"], "query").unwrap(),
            "level"
        );
    }
}
