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
use crate::db::{
    connect_database, list_tables_from_db, read_db_page_in_database, read_schema,
    read_schemas_for_tables, search_value_matches_in_database,
};
use crate::demo::{demo_rows, demo_schema_for, sample_stress_rows, stress_total_rows};
use crate::runtime_resources::PoolKey;
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
        let pool = ensure_pool(&state, connection_id, database, &mysql_url).await?;
        handle_real_request(&pool, connection_id, database, func, args, &state, &app).await
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
            let page =
                read_db_page_in_database(pool, database, &table, "agent", &page_request).await?;
            let references = row_references(database, &table, &page.rows, None);
            Ok(serde_json::json!({
                "tableName": table.table_name,
                "rows": page.rows,
                "references": references,
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
                    let _ = audit::mark_committed(&audit_pool, &[id]).await;
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
                    let _ = audit::mark_aborted(&audit_pool, &[id]).await;
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
            let references = row_references(&database, &table, &rows, None);
            drop(rt);
            Ok(serde_json::json!({
                "tableName": table.table_name,
                "rows": rows,
                "references": references,
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
