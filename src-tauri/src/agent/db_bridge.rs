use std::collections::HashMap;

use serde_json::Value;
use sqlx::{Column as SqlxColumn, Row};
use tauri::{AppHandle, State};

use crate::agent::profile::{
    build_database_profile, get_cached_profile, related_tables, schema_signature, search_profile,
    store_profile, ProfileIndex,
};
use crate::agent::protocol::AgentContext;
use crate::agent::sql_guard::{validate_read_only_sql, ReadOnlyLimit};
use crate::audit;
use crate::clickhouse;
use crate::db::{
    connect_database, list_tables_from_db, read_db_page_in_database, read_schema,
    read_schemas_for_tables, search_value_matches_in_database,
};
use crate::demo::{
    demo_rows, demo_schema_for, read_stress_demo_page, sample_stress_rows, stress_total_rows,
};
use crate::runtime_resources::PoolKey;
use crate::types::*;

const MAX_AGENT_TABLE_PAGE_SIZE: u32 = 1_000;

#[derive(Debug, PartialEq, Eq)]
enum AgentDatabaseTarget {
    Demo,
    MySql(String),
    ClickHouse(String),
}

fn agent_database_target(
    connection: Option<&RuntimeConnection>,
) -> Result<AgentDatabaseTarget, String> {
    let Some(connection) = connection else {
        return Ok(AgentDatabaseTarget::Demo);
    };
    match connection.kind {
        DatabaseKind::MySql => Ok(connection
            .mysql_url
            .clone()
            .map(AgentDatabaseTarget::MySql)
            .unwrap_or(AgentDatabaseTarget::Demo)),
        DatabaseKind::ClickHouse => connection
            .clickhouse_url
            .clone()
            .map(AgentDatabaseTarget::ClickHouse)
            .ok_or_else(|| "missing clickhouse url".to_string()),
    }
}

pub async fn handle_db_request(
    state: State<'_, AppState>,
    app: AppHandle,
    context: &AgentContext,
    func: &str,
    args: Value,
) -> Result<Value, String> {
    let connection_id = context.connection_id.as_deref().unwrap_or("");
    let database = args
        .get("database")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            context
                .database
                .as_deref()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or("game_db")
        .to_string();

    let rt = state.runtime.lock().await;
    let connection = rt.connections.get(connection_id).cloned();
    let target = agent_database_target(connection.as_ref())?;
    drop(rt);

    match target {
        AgentDatabaseTarget::Demo => {
            let mut effective_context = context.clone();
            effective_context.database = Some(database);
            handle_demo_request(&state, &effective_context, func, args).await
        }
        AgentDatabaseTarget::MySql(mysql_url) => {
            let pool = ensure_pool(&state, connection_id, &database, &mysql_url).await?;
            handle_real_request(&pool, connection_id, &database, func, args, &state, &app).await
        }
        AgentDatabaseTarget::ClickHouse(clickhouse_url) => {
            handle_clickhouse_request(&clickhouse_url, connection_id, &database, func, args).await
        }
    }
}

async fn ensure_pool(
    state: &State<'_, AppState>,
    connection_id: &str,
    database: &str,
    mysql_url: &str,
) -> Result<sqlx::MySqlPool, String> {
    let key = PoolKey::new(connection_id, database);
    let database = key.database().to_string();
    let mysql_url = mysql_url.to_string();
    state
        .resources
        .get_or_connect_database(key, move || async move {
            connect_database(&mysql_url, Some(&database)).await
        })
        .await
}

fn table_page_args(args: &Value) -> (u64, u32) {
    let offset = arg_u64(args, "offset").unwrap_or(0);
    let limit = arg_u32(args, "limit")
        .unwrap_or(MAX_AGENT_TABLE_PAGE_SIZE)
        .clamp(1, MAX_AGENT_TABLE_PAGE_SIZE);
    (offset, limit)
}

fn table_page_request(offset: u64, limit: u32) -> TablePageRequest {
    TablePageRequest {
        page: Some(1),
        // Read one look-ahead row so hasMore is exact even when the returned
        // page happens to be completely full.
        page_size: Some(limit.saturating_add(1)),
        offset: Some(offset),
        include_total: Some(false),
        filter: None,
        sort: None,
    }
}

fn table_page_value(
    database: &str,
    table: &TableMeta,
    offset: u64,
    limit: u32,
    mut rows: Vec<HashMap<String, String>>,
    mut null_cells: Vec<Vec<String>>,
    backend_has_more: bool,
    total_rows: Option<u64>,
) -> Value {
    let overflow = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    null_cells.truncate(rows.len());
    while null_cells.len() < rows.len() {
        null_cells.push(Vec::new());
    }
    let has_more = overflow || backend_has_more;
    let next_offset = offset.saturating_add(rows.len() as u64);
    let references = row_references(database, table, &rows, None);
    let primary_keys = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    let consistency_warning = primary_keys
        .is_empty()
        .then_some("该表没有主键；分页期间若数据同时发生变化，可能出现重复或遗漏行".to_string());
    serde_json::json!({
        "tableName": table.table_name,
        "tableComment": table.table_comment,
        "columns": table.columns.iter().map(|column| column.column_name.clone()).collect::<Vec<_>>(),
        "primaryKeys": primary_keys,
        "offset": offset,
        "limit": limit,
        "returnedRowCount": rows.len(),
        "nextOffset": next_offset,
        "hasMore": has_more,
        "totalRows": total_rows,
        "rows": rows,
        "nullCells": null_cells,
        "references": references,
        "consistencyWarning": consistency_warning,
    })
}

fn table_session_page_value(
    database: &str,
    table: &TableMeta,
    offset: u64,
    limit: u32,
    page: TableSessionPage,
) -> Value {
    let total_rows = page.total_rows_exact.then_some(page.total_rows);
    table_page_value(
        database,
        table,
        offset,
        limit,
        page.rows,
        page.null_cells,
        page.has_more,
        total_rows,
    )
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
                offset: None,
                include_total: Some(false),
                filter: None,
                sort: None,
            };
            let page =
                read_db_page_in_database(pool, database, &table, "agent", &page_request).await?;
            let references = row_references(database, &table, &page.rows, None);
            Ok(serde_json::json!({
                "tableName": table.table_name,
                "rows": page.rows,
                "references": references,
            }))
        }
        "read_table_page" => {
            let table_name = table_arg(&args)?;
            let (offset, limit) = table_page_args(&args);
            let table = read_schema(pool, database, &table_name).await?;
            let page = read_db_page_in_database(
                pool,
                database,
                &table,
                "agent-table-page",
                &table_page_request(offset, limit),
            )
            .await?;
            Ok(table_session_page_value(
                database, &table, offset, limit, page,
            ))
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
                    let row_identity = item.row_identity.clone();
                    results.push(serde_json::json!({
                        "tableName": item.table_name,
                        "tableComment": item.table_comment,
                        "columnName": item.column_name,
                        "previewValue": item.preview_value,
                        "rowIdentity": row_identity,
                        "reference": value_reference(database, &table, &item.column_name, row_identity.as_ref()),
                    }));
                }
                if results.len() >= limit {
                    break;
                }
            }
            Ok(Value::Array(results))
        }
        "get_database_profile" => {
            let table_name = optional_table_arg(&args);
            let tables = list_tables_from_db(pool, database).await?;
            let schemas = read_schemas_for_tables(pool, database, &tables).await?;
            let signature = schema_signature(&schemas);
            let profile = match get_cached_profile(connection_id, database, &signature) {
                Some(profile) if profile.status == "ready" => profile,
                Some(profile) => profile,
                None => {
                    let sample_rows = sample_rows_for_profile(pool, database, &schemas).await?;
                    let (row_counts, indexes) = profile_metadata(pool, database).await?;
                    store_profile(build_database_profile(
                        connection_id,
                        database,
                        &schemas,
                        &sample_rows,
                        Some(&row_counts),
                        Some(&indexes),
                    ))
                }
            };
            Ok(profile_to_value(profile, table_name.as_deref()))
        }
        "refresh_database_profile" => {
            let tables = list_tables_from_db(pool, database).await?;
            let schemas = read_schemas_for_tables(pool, database, &tables).await?;
            let sample_rows = sample_rows_for_profile(pool, database, &schemas).await?;
            let (row_counts, indexes) = profile_metadata(pool, database).await?;
            let profile = store_profile(build_database_profile(
                connection_id,
                database,
                &schemas,
                &sample_rows,
                Some(&row_counts),
                Some(&indexes),
            ));
            Ok(serde_json::to_value(profile).unwrap_or(Value::Null))
        }
        "search_database_profile" => {
            let query = query_arg(&args)?;
            let profile = ensure_real_profile(pool, connection_id, database).await?;
            Ok(serde_json::json!({
                "query": query,
                "results": search_profile(&profile, &query),
            }))
        }
        "find_related_tables" => {
            let table_name = table_arg(&args)?;
            let profile = ensure_real_profile(pool, connection_id, database).await?;
            Ok(serde_json::to_value(related_tables(&profile, &table_name)).unwrap_or(Value::Null))
        }
        "run_read_query" => {
            let sql = arg_str(&args, "sql")?;
            let requested_limit = arg_u32(&args, "limit")
                .unwrap_or(MAX_AGENT_TABLE_PAGE_SIZE)
                .clamp(1, MAX_AGENT_TABLE_PAGE_SIZE);
            let limited = validate_read_only_sql(&sql, ReadOnlyLimit::Inject(requested_limit))?;
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

async fn handle_clickhouse_request(
    url: &str,
    connection_id: &str,
    database: &str,
    func: &str,
    args: Value,
) -> Result<Value, String> {
    match func {
        "list_databases" => {
            let databases = clickhouse::list_databases(url).await?;
            Ok(Value::Array(
                databases.into_iter().map(Value::String).collect(),
            ))
        }
        "list_tables" => {
            let tables = clickhouse::list_tables(url, database).await?;
            Ok(Value::Array(
                tables
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
            let table = clickhouse::read_schema(url, database, &table_name).await?;
            Ok(table_meta_to_value(&table))
        }
        "sample_rows" => {
            let table_name = table_arg(&args)?;
            let limit = arg_u32(&args, "limit").unwrap_or(10).clamp(1, 200);
            let table = clickhouse::read_schema(url, database, &table_name).await?;
            let page_request = TablePageRequest {
                page: Some(1),
                page_size: Some(limit),
                offset: None,
                include_total: Some(false),
                filter: None,
                sort: None,
            };
            let page = clickhouse::read_page(url, database, &table, "agent", &page_request).await?;
            let references = row_references(database, &table, &page.rows, None);
            Ok(serde_json::json!({
                "tableName": table.table_name,
                "rows": page.rows,
                "references": references,
            }))
        }
        "read_table_page" => {
            let table_name = table_arg(&args)?;
            let (offset, limit) = table_page_args(&args);
            let table = clickhouse::read_schema(url, database, &table_name).await?;
            let page = clickhouse::read_page(
                url,
                database,
                &table,
                "agent-table-page",
                &table_page_request(offset, limit),
            )
            .await?;
            Ok(table_session_page_value(
                database, &table, offset, limit, page,
            ))
        }
        "search_schema" => {
            let query = query_arg(&args)?;
            let schemas = clickhouse_schemas(url, database).await?;
            Ok(Value::Array(search_schema_results(&schemas, &query)))
        }
        "search_values" => {
            let query = query_arg(&args)?;
            let table_name = optional_table_arg(&args);
            let limit = arg_u32(&args, "limit").unwrap_or(20).clamp(1, 500) as usize;
            let schemas = if let Some(table_name) = table_name {
                vec![clickhouse::read_schema(url, database, &table_name).await?]
            } else {
                clickhouse_schemas(url, database).await?
            };
            let mut results = Vec::new();
            for table in schemas {
                let matches =
                    clickhouse::search_value_matches(url, database, &table, &query).await?;
                for item in matches
                    .into_iter()
                    .take(limit.saturating_sub(results.len()))
                {
                    results.push(serde_json::json!({
                        "tableName": item.table_name,
                        "tableComment": item.table_comment,
                        "columnName": item.column_name,
                        "previewValue": item.preview_value,
                        "rowIdentity": item.row_identity,
                        "reference": value_reference(database, &table, &item.column_name, None),
                    }));
                }
                if results.len() >= limit {
                    break;
                }
            }
            Ok(Value::Array(results))
        }
        "get_database_profile" => {
            let table_name = optional_table_arg(&args);
            let profile = ensure_clickhouse_profile(url, connection_id, database).await?;
            Ok(profile_to_value(profile, table_name.as_deref()))
        }
        "refresh_database_profile" => {
            let schemas = clickhouse_schemas(url, database).await?;
            let samples = sample_clickhouse_rows_for_profile(url, database, &schemas).await;
            let profile = store_profile(build_database_profile(
                connection_id,
                database,
                &schemas,
                &samples,
                None,
                None,
            ));
            Ok(serde_json::to_value(profile).unwrap_or(Value::Null))
        }
        "search_database_profile" => {
            let query = query_arg(&args)?;
            let profile = ensure_clickhouse_profile(url, connection_id, database).await?;
            Ok(serde_json::json!({
                "query": query,
                "results": search_profile(&profile, &query),
            }))
        }
        "find_related_tables" => {
            let table_name = table_arg(&args)?;
            let profile = ensure_clickhouse_profile(url, connection_id, database).await?;
            Ok(serde_json::to_value(related_tables(&profile, &table_name)).unwrap_or(Value::Null))
        }
        "run_read_query" => {
            let sql = arg_str(&args, "sql")?;
            let requested_limit = arg_u32(&args, "limit")
                .unwrap_or(MAX_AGENT_TABLE_PAGE_SIZE)
                .clamp(1, MAX_AGENT_TABLE_PAGE_SIZE);
            let validated = validate_read_only_sql(&sql, ReadOnlyLimit::None)?;
            let query = crate::sql_console::clickhouse_read_query_sql(&validated, requested_limit)?;
            let value = clickhouse::execute_console_json_query(url, &query).await?;
            let columns = value
                .get("meta")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.get("name").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let rows = value
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            Ok(serde_json::json!({
                "columns": columns,
                "rows": rows,
            }))
        }
        "run_write_query" => {
            Err("ClickHouse connections are read-only; run_write_query is unavailable".to_string())
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
                    let _ = audit::mark_committed(&audit_pool, &[id]).await;
                    crate::audit_sync::trigger_immediate_sync(app);
                }
            }
            let count_pool_key = PoolKey::new(connection_id, database);
            state.table_counts.invalidate_database(&count_pool_key);
            Ok(serde_json::json!({
                "affectedRows": result.rows_affected(),
                "lastInsertId": result.last_insert_id(),
            }))
        }
        Err(error) => {
            tx.rollback().await.ok();
            if let Some(id) = audit_id {
                if let Ok(audit_pool) = audit::ensure_audit_pool(app, state).await {
                    let _ = audit::mark_aborted(&audit_pool, &[id]).await;
                }
            }
            Err(format!("write query failed: {}", error))
        }
    }
}

#[cfg(test)]
mod table_count_invalidation_tests {
    #[test]
    fn successful_agent_writes_invalidate_the_database_count_generation() {
        let source = include_str!("db_bridge.rs").replace("\r\n", "\n");
        let body = source
            .split("async fn run_write_query(")
            .nth(1)
            .and_then(|tail| tail.split("async fn handle_demo_request(").next())
            .expect("run_write_query body should exist");
        assert!(
            body.contains("table_counts.invalidate_database("),
            "arbitrary Agent writes must invalidate every table count in the database",
        );
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
            let references = row_references(&database, &table, &rows, None);
            drop(rt);
            Ok(serde_json::json!({
                "tableName": table.table_name,
                "rows": rows,
                "references": references,
            }))
        }
        "read_table_page" => {
            let table_name = table_arg(&args)?;
            let (offset, limit) = table_page_args(&args);
            let table = find_table(&rt, &database, &table_name)?;
            let key = demo_row_key(&database, &table.table_name);
            if matches!(rt.demo_profile, Some(DemoProfile::Stress))
                && !rt.demo_rows.contains_key(&key)
            {
                let page = read_stress_demo_page(
                    &table,
                    "agent-table-page",
                    &table_page_request(offset, limit),
                );
                let value = table_session_page_value(&database, &table, offset, limit, page);
                drop(rt);
                return Ok(value);
            }

            let source_rows = rt
                .demo_rows
                .get(&key)
                .cloned()
                .or_else(|| demo_rows().get(&table.table_name).cloned())
                .unwrap_or_default();
            let start = usize::try_from(offset)
                .unwrap_or(usize::MAX)
                .min(source_rows.len());
            let fetch_count = limit.saturating_add(1) as usize;
            let end = start.saturating_add(fetch_count).min(source_rows.len());
            let rows = source_rows[start..end].to_vec();
            let has_more = end < source_rows.len();
            let value = table_page_value(
                &database,
                &table,
                offset,
                limit,
                rows,
                Vec::new(),
                has_more,
                Some(source_rows.len() as u64),
            );
            drop(rt);
            Ok(value)
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
                            let identity = row_identity(&table, &row);
                            results.push(serde_json::json!({
                                "tableName": table.table_name,
                                "columnName": column.column_name,
                                "previewValue": value.chars().take(80).collect::<String>(),
                                "rowIdentity": identity,
                                "reference": value_reference(&database, &table, &column.column_name, Some(&identity)),
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
        "get_database_profile" => {
            let table_name = optional_table_arg(&args);
            let schema = schema_for(&rt, &database);
            let profile = demo_profile_from_runtime(&rt, &database, &schema);
            drop(rt);
            Ok(profile_to_value(profile, table_name.as_deref()))
        }
        "refresh_database_profile" => {
            let schema = schema_for(&rt, &database);
            let profile = store_profile(demo_profile_from_runtime(&rt, &database, &schema));
            drop(rt);
            Ok(serde_json::to_value(profile).unwrap_or(Value::Null))
        }
        "search_database_profile" => {
            let query = query_arg(&args)?;
            let schema = schema_for(&rt, &database);
            let profile = demo_profile_from_runtime(&rt, &database, &schema);
            drop(rt);
            Ok(serde_json::json!({
                "query": query,
                "results": search_profile(&profile, &query),
            }))
        }
        "find_related_tables" => {
            let table_name = table_arg(&args)?;
            let schema = schema_for(&rt, &database);
            let profile = demo_profile_from_runtime(&rt, &database, &schema);
            drop(rt);
            Ok(serde_json::to_value(related_tables(&profile, &table_name)).unwrap_or(Value::Null))
        }
        "run_read_query" => {
            let sql = arg_str(&args, "sql")?;
            let requested_limit = arg_u32(&args, "limit")
                .unwrap_or(MAX_AGENT_TABLE_PAGE_SIZE)
                .clamp(1, MAX_AGENT_TABLE_PAGE_SIZE);
            let _ = validate_read_only_sql(&sql, ReadOnlyLimit::Inject(requested_limit))?;
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

async fn ensure_real_profile(
    pool: &sqlx::MySqlPool,
    connection_id: &str,
    database: &str,
) -> Result<crate::agent::profile::DatabaseProfile, String> {
    let tables = list_tables_from_db(pool, database).await?;
    let schemas = read_schemas_for_tables(pool, database, &tables).await?;
    let signature = schema_signature(&schemas);
    if let Some(profile) = get_cached_profile(connection_id, database, &signature) {
        if profile.status == "ready" {
            return Ok(profile);
        }
    }
    let sample_rows = sample_rows_for_profile(pool, database, &schemas).await?;
    let (row_counts, indexes) = profile_metadata(pool, database).await?;
    Ok(store_profile(build_database_profile(
        connection_id,
        database,
        &schemas,
        &sample_rows,
        Some(&row_counts),
        Some(&indexes),
    )))
}

async fn clickhouse_schemas(url: &str, database: &str) -> Result<Vec<TableMeta>, String> {
    let table_names = clickhouse::list_tables(url, database)
        .await?
        .into_iter()
        .map(|table| table.table_name)
        .collect::<Vec<_>>();
    clickhouse::read_schemas(url, database, &table_names).await
}

async fn ensure_clickhouse_profile(
    url: &str,
    connection_id: &str,
    database: &str,
) -> Result<crate::agent::profile::DatabaseProfile, String> {
    let schemas = clickhouse_schemas(url, database).await?;
    let signature = schema_signature(&schemas);
    if let Some(profile) = get_cached_profile(connection_id, database, &signature) {
        if profile.status == "ready" {
            return Ok(profile);
        }
    }
    let samples = sample_clickhouse_rows_for_profile(url, database, &schemas).await;
    Ok(store_profile(build_database_profile(
        connection_id,
        database,
        &schemas,
        &samples,
        None,
        None,
    )))
}

async fn sample_clickhouse_rows_for_profile(
    url: &str,
    database: &str,
    schemas: &[TableMeta],
) -> HashMap<String, Vec<HashMap<String, String>>> {
    const MAX_PROFILE_SAMPLE_TABLES: usize = 12;
    const MAX_CONCURRENT_SAMPLES: usize = 4;

    let mut samples = HashMap::new();
    let mut pending = tokio::task::JoinSet::new();
    let page_request = TablePageRequest {
        page: Some(1),
        page_size: Some(3),
        offset: None,
        include_total: Some(false),
        filter: None,
        sort: None,
    };

    for table in schemas.iter().take(MAX_PROFILE_SAMPLE_TABLES).cloned() {
        while pending.len() >= MAX_CONCURRENT_SAMPLES {
            if let Some(Ok(Some((table_name, rows)))) = pending.join_next().await {
                samples.insert(table_name, rows);
            }
        }
        let url = url.to_string();
        let database = database.to_string();
        let request = page_request.clone();
        pending.spawn(async move {
            clickhouse::read_page(&url, &database, &table, "agent-profile", &request)
                .await
                .ok()
                .map(|page| (table.table_name, page.rows))
        });
    }
    while let Some(result) = pending.join_next().await {
        if let Ok(Some((table_name, rows))) = result {
            samples.insert(table_name, rows);
        }
    }
    samples
}

async fn profile_metadata(
    pool: &sqlx::MySqlPool,
    database: &str,
) -> Result<(HashMap<String, u64>, HashMap<String, Vec<ProfileIndex>>), String> {
    let table_rows = sqlx::query(
        "SELECT TABLE_NAME, COALESCE(TABLE_ROWS, 0) AS TABLE_ROWS \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
    )
    .bind(database)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取画像表规模失败: {error}"))?;
    let row_counts = table_rows
        .into_iter()
        .filter_map(|row| {
            let table_name: String = row.try_get("TABLE_NAME").ok()?;
            let table_rows = row.try_get::<i64, _>("TABLE_ROWS").unwrap_or(0).max(0) as u64;
            Some((table_name, table_rows))
        })
        .collect::<HashMap<_, _>>();

    let index_rows = sqlx::query(
        "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = ? \
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
    )
    .bind(database)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取画像索引失败: {error}"))?;
    let mut grouped: HashMap<String, HashMap<String, ProfileIndex>> = HashMap::new();
    for row in index_rows {
        let table_name: String = row.try_get("TABLE_NAME").unwrap_or_default();
        let index_name: String = row.try_get("INDEX_NAME").unwrap_or_default();
        let column_name: String = row.try_get("COLUMN_NAME").unwrap_or_default();
        if table_name.is_empty() || index_name.is_empty() || column_name.is_empty() {
            continue;
        }
        let non_unique = row.try_get::<i64, _>("NON_UNIQUE").unwrap_or(1);
        let indexes = grouped.entry(table_name).or_default();
        let item = indexes
            .entry(index_name.clone())
            .or_insert_with(|| ProfileIndex {
                primary: index_name.eq_ignore_ascii_case("PRIMARY"),
                unique: non_unique == 0,
                index_name: index_name.clone(),
                columns: Vec::new(),
            });
        item.columns.push(column_name);
    }
    let indexes = grouped
        .into_iter()
        .map(|(table, by_name)| {
            let mut values = by_name.into_values().collect::<Vec<_>>();
            values.sort_by(|left, right| {
                right
                    .primary
                    .cmp(&left.primary)
                    .then_with(|| left.index_name.cmp(&right.index_name))
            });
            (table, values)
        })
        .collect::<HashMap<_, _>>();

    Ok((row_counts, indexes))
}

async fn sample_rows_for_profile(
    pool: &sqlx::MySqlPool,
    database: &str,
    schema: &[TableMeta],
) -> Result<HashMap<String, Vec<HashMap<String, String>>>, String> {
    let mut sample_rows = HashMap::new();
    for table in schema.iter().take(120) {
        let page_request = TablePageRequest {
            page: Some(1),
            page_size: Some(3),
            offset: None,
            include_total: Some(false),
            filter: None,
            sort: None,
        };
        if let Ok(page) =
            read_db_page_in_database(pool, database, table, "agent-profile", &page_request).await
        {
            sample_rows.insert(table.table_name.clone(), page.rows);
        }
    }
    Ok(sample_rows)
}

fn demo_profile_from_runtime(
    rt: &RuntimeState,
    database: &str,
    schema: &[TableMeta],
) -> crate::agent::profile::DatabaseProfile {
    let mut samples = HashMap::new();
    for table in schema.iter().take(120) {
        samples.insert(
            table.table_name.clone(),
            demo_rows_for_table(rt, table, database, 3),
        );
    }
    let row_counts = demo_row_counts(rt, database, schema);
    let signature = schema_signature(schema);
    if let Some(profile) = get_cached_profile(&rt.selected_connection_id, database, &signature) {
        if profile.status == "ready" {
            return profile;
        }
    }
    store_profile(build_database_profile(
        &rt.selected_connection_id,
        database,
        schema,
        &samples,
        Some(&row_counts),
        None,
    ))
}

fn demo_row_counts(
    rt: &RuntimeState,
    database: &str,
    schema: &[TableMeta],
) -> HashMap<String, u64> {
    schema
        .iter()
        .map(|table| {
            let key = demo_row_key(database, &table.table_name);
            let count = if let Some(rows) = rt.demo_rows.get(&key) {
                rows.len()
            } else if matches!(rt.demo_profile, Some(DemoProfile::Stress)) {
                stress_total_rows(&table.table_name)
            } else {
                demo_rows()
                    .get(&table.table_name)
                    .map(|rows| rows.len())
                    .unwrap_or(0)
            };
            (table.table_name.clone(), count as u64)
        })
        .collect()
}

fn profile_to_value(
    profile: crate::agent::profile::DatabaseProfile,
    table_name: Option<&str>,
) -> Value {
    if let Some(table_name) = table_name.filter(|value| !value.trim().is_empty()) {
        let table = profile
            .tables
            .iter()
            .find(|table| table.table_name.eq_ignore_ascii_case(table_name))
            .cloned();
        let relationships = crate::agent::profile::related_tables(&profile, table_name);
        return serde_json::json!({
            "version": profile.version,
            "status": profile.status,
            "connectionId": profile.connection_id,
            "database": profile.database,
            "schemaSignature": profile.schema_signature,
            "generatedAt": profile.generated_at,
            "table": table,
            "relationships": relationships.relationships,
            "relatedTables": relationships.related_tables,
            "warnings": profile.warnings,
        });
    }
    serde_json::to_value(profile).unwrap_or(Value::Null)
}

fn row_identity(table: &TableMeta, row: &HashMap<String, String>) -> HashMap<String, String> {
    let primary_keys = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    let keys = if primary_keys.is_empty() {
        table
            .columns
            .iter()
            .map(|column| column.column_name.clone())
            .collect::<Vec<_>>()
    } else {
        primary_keys
    };
    keys.into_iter()
        .filter_map(|key| row.get(&key).map(|value| (key, value.clone())))
        .collect()
}

fn row_key_for_table(table: &TableMeta, identity: &HashMap<String, String>) -> String {
    let primary_keys = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    let keys = if primary_keys.is_empty() {
        table
            .columns
            .iter()
            .map(|column| column.column_name.clone())
            .collect::<Vec<_>>()
    } else {
        primary_keys
    };
    keys.into_iter()
        .filter_map(|key| identity.get(&key).map(|value| (key, value)))
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn row_references(
    database: &str,
    table: &TableMeta,
    rows: &[HashMap<String, String>],
    column_name: Option<&str>,
) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let identity = row_identity(table, row);
            serde_json::json!({
                "kind": if column_name.is_some() { "cell" } else { "row" },
                "database": database,
                "tableName": table.table_name,
                "columnName": column_name,
                "rowIdentity": identity,
                "rowKey": row_key_for_table(table, &identity),
            })
        })
        .collect()
}

fn value_reference(
    database: &str,
    table: &TableMeta,
    column_name: &str,
    identity: Option<&HashMap<String, String>>,
) -> Value {
    let row_key = identity
        .map(|identity| row_key_for_table(table, identity))
        .unwrap_or_default();
    serde_json::json!({
        "kind": if row_key.is_empty() { "column" } else { "cell" },
        "database": database,
        "tableName": table.table_name,
        "columnName": column_name,
        "rowIdentity": identity,
        "rowKey": row_key,
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
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| format!("missing or invalid argument: {}", key))
}

fn arg_u64(args: &Value, key: &str) -> Result<u64, String> {
    args.get(key)
        .and_then(|value| value.as_u64())
        .ok_or_else(|| format!("missing or invalid argument: {}", key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_connection(
        kind: DatabaseKind,
        mysql_url: Option<&str>,
        clickhouse_url: Option<&str>,
    ) -> RuntimeConnection {
        RuntimeConnection {
            id: "test".into(),
            kind,
            label: "Test".into(),
            host: "127.0.0.1".into(),
            port: kind.default_port(),
            username: "test".into(),
            mysql_url: mysql_url.map(str::to_string),
            clickhouse_url: clickhouse_url.map(str::to_string),
            database: Some("analytics".into()),
        }
    }

    #[test]
    fn routes_clickhouse_connections_to_the_clickhouse_agent_bridge() {
        let connection = runtime_connection(
            DatabaseKind::ClickHouse,
            None,
            Some("http://default:@127.0.0.1:8123"),
        );
        assert_eq!(
            agent_database_target(Some(&connection)).unwrap(),
            AgentDatabaseTarget::ClickHouse("http://default:@127.0.0.1:8123".into())
        );
    }

    #[test]
    fn keeps_url_less_mysql_connections_on_the_demo_agent_bridge() {
        let connection = runtime_connection(DatabaseKind::MySql, None, None);
        assert_eq!(
            agent_database_target(Some(&connection)).unwrap(),
            AgentDatabaseTarget::Demo
        );
    }

    #[test]
    fn rejects_broken_clickhouse_connections_instead_of_using_demo_data() {
        let connection = runtime_connection(DatabaseKind::ClickHouse, None, None);
        assert_eq!(
            agent_database_target(Some(&connection)).unwrap_err(),
            "missing clickhouse url"
        );
    }

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

    #[test]
    fn table_page_arguments_allow_large_offsets_and_cap_each_response() {
        let args = serde_json::json!({ "offset": 4_500_000_000_u64, "limit": 9_999 });
        assert_eq!(table_page_args(&args), (4_500_000_000, 1_000));
        assert!(arg_u32(&serde_json::json!({ "limit": u64::MAX }), "limit").is_err());
    }

    #[test]
    fn table_page_response_exposes_the_next_offset_until_every_row_is_read() {
        let table = TableMeta {
            table_name: "player".into(),
            table_comment: "玩家表".into(),
            columns: vec![
                ColumnMeta::with_basic("id", "bigint", "玩家ID", true, false),
                ColumnMeta::with_basic("name", "varchar(64)", "名称", false, false),
            ],
        };
        let rows = vec![
            HashMap::from([("id".into(), "11".into()), ("name".into(), "A".into())]),
            HashMap::from([("id".into(), "12".into()), ("name".into(), "B".into())]),
            HashMap::from([("id".into(), "13".into()), ("name".into(), "C".into())]),
        ];

        let value = table_page_value("game_db", &table, 10, 2, rows, Vec::new(), false, Some(13));

        assert_eq!(value["returnedRowCount"], 2);
        assert_eq!(value["nextOffset"], 12);
        assert_eq!(value["hasMore"], true);
        assert_eq!(value["totalRows"], 13);
        assert_eq!(value["primaryKeys"][0], "id");
        assert!(value["consistencyWarning"].is_null());
    }

    #[test]
    fn database_profile_classifies_tables_and_infers_relationships() {
        let schema = vec![
            TableMeta {
                table_name: "player".into(),
                table_comment: "玩家账号表".into(),
                columns: vec![
                    ColumnMeta::with_basic("id", "bigint", "玩家ID", true, false),
                    ColumnMeta::with_basic("username", "varchar(64)", "用户名", false, false),
                    ColumnMeta::with_basic(
                        "password_hash",
                        "varchar(255)",
                        "密码哈希",
                        false,
                        false,
                    ),
                ],
            },
            TableMeta {
                table_name: "player_login_log".into(),
                table_comment: "玩家登录日志".into(),
                columns: vec![
                    ColumnMeta::with_basic("id", "bigint", "日志ID", true, false),
                    ColumnMeta::with_basic("player_id", "bigint", "玩家ID", false, false),
                    ColumnMeta::with_basic("token", "varchar(255)", "登录令牌", false, true),
                ],
            },
            TableMeta {
                table_name: "hero_config".into(),
                table_comment: "英雄配置表".into(),
                columns: vec![
                    ColumnMeta::with_basic("id", "int", "英雄ID", true, false),
                    ColumnMeta::with_basic("name", "varchar(64)", "名称", false, false),
                ],
            },
        ];
        let sample_rows = HashMap::from([
            (
                "player".to_string(),
                vec![HashMap::from([
                    ("id".to_string(), "1".to_string()),
                    ("username".to_string(), "Alice".to_string()),
                    ("password_hash".to_string(), "secret-hash".to_string()),
                ])],
            ),
            (
                "player_login_log".to_string(),
                vec![HashMap::from([
                    ("id".to_string(), "10".to_string()),
                    ("player_id".to_string(), "1".to_string()),
                    ("token".to_string(), "raw-token-value".to_string()),
                ])],
            ),
        ]);

        let profile = crate::agent::profile::build_database_profile(
            "demo",
            "game_db",
            &schema,
            &sample_rows,
            None,
            None,
        );

        assert_eq!(profile.database, "game_db");
        assert_eq!(profile.status, "ready");
        assert!(profile
            .tables
            .iter()
            .any(|table| table.table_name == "player" && table.role == "core"));
        assert!(profile
            .tables
            .iter()
            .any(|table| table.table_name == "hero_config" && table.role == "config"));
        assert!(profile
            .tables
            .iter()
            .any(|table| table.table_name == "player_login_log" && table.role == "log"));
        assert!(profile.relationships.iter().any(|rel| {
            rel.from_table == "player_login_log"
                && rel.from_column == "player_id"
                && rel.to_table == "player"
                && rel.to_column == "id"
        }));
        let player_table = profile
            .tables
            .iter()
            .find(|table| table.table_name == "player")
            .unwrap();
        let password_column = player_table
            .columns
            .iter()
            .find(|column| column.column_name == "password_hash")
            .unwrap();
        assert!(password_column.sensitive);
        assert!(password_column.sample_values.is_empty());
    }
}
