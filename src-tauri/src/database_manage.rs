use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::MySqlPool;
use tauri::{AppHandle, Emitter, State};

use crate::audit;
use crate::clickhouse;
use crate::commands::{
    best_effort_audit, demo_databases_for_runtime, demo_row_key, demo_schema_for_runtime,
    invalidate_database_count, invalidate_table_count, mark_audit, read_only_error,
    real_connection_pool, real_database_pool, reject_mongo, TableSessionsInvalidatedPayload,
    TABLE_SESSIONS_INVALIDATED_EVENT,
};
use crate::db::escape_ident;
use crate::mysql_text;
use crate::perf::PerfContext;
use crate::runtime_resources::PoolKey;
use crate::sync;
use crate::types::{AppState, DatabaseKind, TableMeta};

const MYSQL_SYSTEM_DATABASES: [&str; 4] =
    ["information_schema", "mysql", "performance_schema", "sys"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CharsetOption {
    pub charset: String,
    pub default_collation: String,
    pub collations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProperties {
    pub database: String,
    pub charset: String,
    pub collation: String,
    pub charsets: Vec<CharsetOption>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabaseRequest {
    pub connection_id: String,
    pub database: String,
    #[serde(default)]
    pub charset: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlterDatabaseRequest {
    pub connection_id: String,
    pub database: String,
    pub charset: String,
    #[serde(default)]
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropDatabaseRequest {
    pub connection_id: String,
    pub database: String,
    pub confirmed_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseMutationResponse {
    pub database: String,
    pub databases: Vec<String>,
    pub sql: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShowCreateTableResponse {
    pub database: String,
    pub table_name: String,
    pub ddl: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncateTablesRequest {
    pub connection_id: String,
    pub database: String,
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TruncateTableResult {
    pub table_name: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TruncateTablesResponse {
    pub truncated: Vec<TruncateTableResult>,
    pub failed: Vec<TruncateTableResult>,
}

pub fn is_system_database(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    MYSQL_SYSTEM_DATABASES.iter().any(|sys| *sys == lower)
}

pub fn validate_database_name(name: &str, action_is_drop: bool) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("数据库名称不能为空".into());
    }
    if trimmed.chars().count() > 64 {
        return Err("数据库名称不能超过 64 个字符".into());
    }
    if is_system_database(trimmed) {
        return Err(if action_is_drop {
            "禁止删除系统数据库".into()
        } else {
            "不能创建或修改系统数据库".into()
        });
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '$'))
    {
        return Err("数据库名称仅支持字母、数字、下划线(_)、连字符(-)和 $".into());
    }
    Ok(trimmed.to_string())
}

pub fn validate_charset_or_collation(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label}不能为空"));
    }
    if trimmed.chars().count() > 64 {
        return Err(format!("{label}不能超过 64 个字符"));
    }
    if !trimmed.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        return Err(format!("{label}格式无效: {trimmed}"));
    }
    Ok(trimmed.to_string())
}

pub fn build_create_database_sql(
    database: &str,
    charset: Option<&str>,
    collation: Option<&str>,
) -> Result<String, String> {
    let db = validate_database_name(database, false)?;
    let mut sql = format!("CREATE DATABASE `{}`", escape_ident(&db));
    if let Some(charset) = charset.map(str::trim).filter(|s| !s.is_empty()) {
        let cs = validate_charset_or_collation(charset, "字符集")?;
        sql.push_str(&format!(" CHARACTER SET {cs}"));
    }
    if let Some(collation) = collation.map(str::trim).filter(|s| !s.is_empty()) {
        let col = validate_charset_or_collation(collation, "排序规则")?;
        sql.push_str(&format!(" COLLATE {col}"));
    }
    Ok(sql)
}

pub fn build_alter_database_sql(
    database: &str,
    charset: &str,
    collation: Option<&str>,
) -> Result<String, String> {
    let db = validate_database_name(database, false)?;
    let cs = validate_charset_or_collation(charset, "字符集")?;
    let mut sql = format!("ALTER DATABASE `{}` CHARACTER SET {cs}", escape_ident(&db));
    if let Some(collation) = collation.map(str::trim).filter(|s| !s.is_empty()) {
        let col = validate_charset_or_collation(collation, "排序规则")?;
        sql.push_str(&format!(" COLLATE {col}"));
    }
    Ok(sql)
}

pub fn build_drop_database_sql(database: &str) -> Result<String, String> {
    let db = validate_database_name(database, true)?;
    Ok(format!("DROP DATABASE `{}`", escape_ident(&db)))
}

pub fn default_charset_options() -> Vec<CharsetOption> {
    vec![
        CharsetOption {
            charset: "utf8mb4".into(),
            default_collation: "utf8mb4_general_ci".into(),
            collations: vec![
                "utf8mb4_general_ci".into(),
                "utf8mb4_unicode_ci".into(),
                "utf8mb4_0900_ai_ci".into(),
                "utf8mb4_bin".into(),
            ],
        },
        CharsetOption {
            charset: "utf8mb3".into(),
            default_collation: "utf8mb3_general_ci".into(),
            collations: vec![
                "utf8mb3_general_ci".into(),
                "utf8mb3_unicode_ci".into(),
                "utf8mb3_bin".into(),
            ],
        },
        CharsetOption {
            charset: "utf8".into(),
            default_collation: "utf8_general_ci".into(),
            collations: vec![
                "utf8_general_ci".into(),
                "utf8_unicode_ci".into(),
                "utf8_bin".into(),
            ],
        },
        CharsetOption {
            charset: "latin1".into(),
            default_collation: "latin1_swedish_ci".into(),
            collations: vec!["latin1_swedish_ci".into(), "latin1_bin".into()],
        },
        CharsetOption {
            charset: "gbk".into(),
            default_collation: "gbk_chinese_ci".into(),
            collations: vec!["gbk_chinese_ci".into(), "gbk_bin".into()],
        },
        CharsetOption {
            charset: "ascii".into(),
            default_collation: "ascii_general_ci".into(),
            collations: vec!["ascii_general_ci".into(), "ascii_bin".into()],
        },
    ]
}

async fn load_mysql_charsets(pool: &MySqlPool) -> Vec<CharsetOption> {
    let Ok(cs_rows) = sqlx::query(
        "SELECT CHARACTER_SET_NAME, DEFAULT_COLLATE_NAME \
         FROM information_schema.CHARACTER_SETS ORDER BY CHARACTER_SET_NAME",
    )
    .fetch_all(pool)
    .await
    else {
        return default_charset_options();
    };
    let Ok(col_rows) = sqlx::query(
        "SELECT CHARACTER_SET_NAME, COLLATION_NAME \
         FROM information_schema.COLLATIONS ORDER BY CHARACTER_SET_NAME, COLLATION_NAME",
    )
    .fetch_all(pool)
    .await
    else {
        return default_charset_options();
    };

    let mut collations_by_charset: HashMap<String, Vec<String>> = HashMap::new();
    for row in col_rows {
        let Ok(cs) = mysql_text::string(&row, "CHARACTER_SET_NAME") else {
            continue;
        };
        let Ok(col) = mysql_text::string(&row, "COLLATION_NAME") else {
            continue;
        };
        collations_by_charset.entry(cs).or_default().push(col);
    }

    let mut options: Vec<CharsetOption> = cs_rows
        .into_iter()
        .filter_map(|row| {
            let charset = mysql_text::string(&row, "CHARACTER_SET_NAME").ok()?;
            let default_collation = mysql_text::string(&row, "DEFAULT_COLLATE_NAME").ok()?;
            let mut collations = collations_by_charset.remove(&charset).unwrap_or_default();
            if collations.is_empty() && !default_collation.is_empty() {
                collations.push(default_collation.clone());
            }
            Some(CharsetOption {
                charset,
                default_collation,
                collations,
            })
        })
        .collect();

    if options.is_empty() {
        return default_charset_options();
    }

    let priority = ["utf8mb4", "utf8mb3", "utf8", "latin1", "gbk", "ascii"];
    options.sort_by(|left, right| {
        let l_rank = priority
            .iter()
            .position(|item| item.eq_ignore_ascii_case(&left.charset))
            .unwrap_or(usize::MAX);
        let r_rank = priority
            .iter()
            .position(|item| item.eq_ignore_ascii_case(&right.charset))
            .unwrap_or(usize::MAX);
        l_rank.cmp(&r_rank).then_with(|| left.charset.cmp(&right.charset))
    });
    options
}

async fn list_mysql_user_databases(pool: &MySqlPool) -> Result<Vec<String>, String> {
    let rows = sqlx::query("SHOW DATABASES")
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取数据库列表失败: {error}"))?;
    Ok(rows
        .into_iter()
        .filter_map(|row| mysql_text::string(&row, 0).ok())
        .filter(|name| !is_system_database(name))
        .collect())
}

async fn resolve_mysql_connection(
    connection_id: &str,
    state: &State<'_, AppState>,
    feature: &str,
) -> Result<bool, String> {
    let rt = state.runtime.lock().await;
    let connection = rt
        .connections
        .get(connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
    if connection.kind.is_read_only() {
        return Err(read_only_error(connection.kind));
    }
    reject_mongo(connection.kind, feature)?;
    Ok(connection.mysql_url.is_some())
}

#[tauri::command]
pub async fn list_server_charsets(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CharsetOption>, String> {
    let is_real_mysql = {
        let rt = state.runtime.lock().await;
        rt.connections
            .get(&connection_id)
            .is_some_and(|c| c.kind == DatabaseKind::MySql && c.mysql_url.is_some())
    };
    if !is_real_mysql {
        return Ok(default_charset_options());
    }
    match real_connection_pool(&connection_id, &state, &PerfContext::default()).await {
        Ok(pool) => Ok(load_mysql_charsets(&pool).await),
        Err(_) => Ok(default_charset_options()),
    }
}

#[tauri::command]
pub async fn get_database_properties(
    connection_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<DatabaseProperties, String> {
    let db = validate_database_name(&database, false)?;
    let is_real_mysql = resolve_mysql_connection(&connection_id, &state, "编辑数据库").await?;
    if !is_real_mysql {
        return Ok(DatabaseProperties {
            database: db,
            charset: "utf8mb4".into(),
            collation: "utf8mb4_general_ci".into(),
            charsets: default_charset_options(),
        });
    }
    let pool = real_connection_pool(&connection_id, &state, &PerfContext::default()).await?;
    let row = sqlx::query(
        "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME \
         FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ? LIMIT 1",
    )
    .bind(&db)
    .fetch_optional(&pool)
    .await
    .map_err(|error| format!("读取数据库属性失败: {error}"))?
    .ok_or_else(|| format!("数据库不存在: {db}"))?;
    let charset = mysql_text::string(&row, "DEFAULT_CHARACTER_SET_NAME")
        .unwrap_or_else(|_| "utf8mb4".into());
    let collation = mysql_text::string(&row, "DEFAULT_COLLATION_NAME")
        .unwrap_or_else(|_| "utf8mb4_general_ci".into());
    let charsets = load_mysql_charsets(&pool).await;
    Ok(DatabaseProperties {
        database: db,
        charset,
        collation,
        charsets,
    })
}

#[tauri::command]
pub async fn create_database(
    request: CreateDatabaseRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DatabaseMutationResponse, String> {
    let db = validate_database_name(&request.database, false)?;
    let sql = build_create_database_sql(
        &db,
        request.charset.as_deref(),
        request.collation.as_deref(),
    )?;
    let is_real_mysql =
        resolve_mysql_connection(&request.connection_id, &state, "创建数据库").await?;

    if is_real_mysql {
        let pool =
            real_connection_pool(&request.connection_id, &state, &PerfContext::default()).await?;
        let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
        let audit_id = best_effort_audit(
            &app,
            &state,
            &PerfContext::default(),
            audit::AuditContext {
                connection_id: request.connection_id.clone(),
                database: db.clone(),
                table_name: String::new(),
                session_id: None,
                source: audit::SOURCE_DDL,
                actor,
                client_id,
            },
            audit::PendingAudit {
                operation: "DDL",
                column_name: None,
                old_value: None,
                new_value: Some(db.clone()),
                row_identity: None,
                forward_sql: sql.clone(),
                forward_binds: Vec::new(),
                inverse_sql: Some(format!("DROP DATABASE IF EXISTS `{}`", escape_ident(&db))),
                inverse_binds: Vec::new(),
                rollback_strategy: audit::STRATEGY_DDL,
                notes: Some("创建数据库".into()),
            },
        )
        .await;
        match sqlx::query(&sql).execute(&pool).await {
            Ok(_) => {
                mark_audit(&app, &state, &PerfContext::default(), audit_id, true).await;
            }
            Err(error) => {
                mark_audit(&app, &state, &PerfContext::default(), audit_id, false).await;
                return Err(format!("创建数据库失败: {error}"));
            }
        }
        let databases = list_mysql_user_databases(&pool).await?;
        return Ok(DatabaseMutationResponse {
            database: db,
            databases,
            sql,
        });
    }

    let mut rt = state.runtime.lock().await;
    let existing = demo_databases_for_runtime(&rt, &request.connection_id);
    if existing.iter().any(|item| item.eq_ignore_ascii_case(&db)) {
        return Err(format!("数据库 {db} 已存在"));
    }
    rt.demo_removed_databases.remove(&db.to_lowercase());
    rt.demo_schema_overrides.insert(db.clone(), Vec::new());
    let databases = demo_databases_for_runtime(&rt, &request.connection_id);
    Ok(DatabaseMutationResponse {
        database: db,
        databases,
        sql,
    })
}

#[tauri::command]
pub async fn alter_database(
    request: AlterDatabaseRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DatabaseMutationResponse, String> {
    let db = validate_database_name(&request.database, false)?;
    let sql = build_alter_database_sql(&db, &request.charset, request.collation.as_deref())?;
    let is_real_mysql =
        resolve_mysql_connection(&request.connection_id, &state, "编辑数据库").await?;

    if is_real_mysql {
        let pool =
            real_connection_pool(&request.connection_id, &state, &PerfContext::default()).await?;
        let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
        let audit_id = best_effort_audit(
            &app,
            &state,
            &PerfContext::default(),
            audit::AuditContext {
                connection_id: request.connection_id.clone(),
                database: db.clone(),
                table_name: String::new(),
                session_id: None,
                source: audit::SOURCE_DDL,
                actor,
                client_id,
            },
            audit::PendingAudit {
                operation: "DDL",
                column_name: None,
                old_value: None,
                new_value: Some(format!(
                    "{}/{}",
                    request.charset.trim(),
                    request.collation.as_deref().unwrap_or("")
                )),
                row_identity: None,
                forward_sql: sql.clone(),
                forward_binds: Vec::new(),
                inverse_sql: None,
                inverse_binds: Vec::new(),
                rollback_strategy: audit::STRATEGY_DDL,
                notes: Some("修改数据库字符集/排序规则".into()),
            },
        )
        .await;
        match sqlx::query(&sql).execute(&pool).await {
            Ok(_) => {
                mark_audit(&app, &state, &PerfContext::default(), audit_id, true).await;
            }
            Err(error) => {
                mark_audit(&app, &state, &PerfContext::default(), audit_id, false).await;
                return Err(format!("修改数据库失败: {error}"));
            }
        }
        let databases = list_mysql_user_databases(&pool).await?;
        return Ok(DatabaseMutationResponse {
            database: db,
            databases,
            sql,
        });
    }

    let rt = state.runtime.lock().await;
    let databases = demo_databases_for_runtime(&rt, &request.connection_id);
    if !databases.iter().any(|item| item.eq_ignore_ascii_case(&db)) {
        return Err(format!("数据库不存在: {db}"));
    }
    Ok(DatabaseMutationResponse {
        database: db,
        databases,
        sql,
    })
}

#[tauri::command]
pub async fn drop_database(
    request: DropDatabaseRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DatabaseMutationResponse, String> {
    let db = validate_database_name(&request.database, true)?;
    if request.confirmed_name.trim() != db {
        return Err("输入的数据库名称不匹配，已取消删除".into());
    }
    let sql = build_drop_database_sql(&db)?;
    let is_real_mysql =
        resolve_mysql_connection(&request.connection_id, &state, "删除数据库").await?;

    let databases = if is_real_mysql {
        let pool =
            real_connection_pool(&request.connection_id, &state, &PerfContext::default()).await?;
        let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
        let audit_id = best_effort_audit(
            &app,
            &state,
            &PerfContext::default(),
            audit::AuditContext {
                connection_id: request.connection_id.clone(),
                database: db.clone(),
                table_name: String::new(),
                session_id: None,
                source: audit::SOURCE_DDL,
                actor,
                client_id,
            },
            audit::PendingAudit {
                operation: "DDL",
                column_name: None,
                old_value: Some(db.clone()),
                new_value: None,
                row_identity: None,
                forward_sql: sql.clone(),
                forward_binds: Vec::new(),
                inverse_sql: None,
                inverse_binds: Vec::new(),
                rollback_strategy: audit::STRATEGY_DDL,
                notes: Some("删除数据库无法行级回滚，请通过备份恢复".into()),
            },
        )
        .await;
        match sqlx::query(&sql).execute(&pool).await {
            Ok(_) => {
                mark_audit(&app, &state, &PerfContext::default(), audit_id, true).await;
            }
            Err(error) => {
                mark_audit(&app, &state, &PerfContext::default(), audit_id, false).await;
                return Err(format!("删除数据库失败: {error}"));
            }
        }
        state
            .resources
            .close_database(&PoolKey::new(&request.connection_id, &db))
            .await;
        list_mysql_user_databases(&pool).await?
    } else {
        let mut rt = state.runtime.lock().await;
        let existing = demo_databases_for_runtime(&rt, &request.connection_id);
        if !existing.iter().any(|item| item.eq_ignore_ascii_case(&db)) {
            return Err(format!("数据库不存在: {db}"));
        }
        rt.demo_removed_databases.insert(db.to_lowercase());
        let schema_keys: Vec<String> = rt
            .demo_schema_overrides
            .keys()
            .filter(|key| key.eq_ignore_ascii_case(&db))
            .cloned()
            .collect();
        for key in schema_keys {
            rt.demo_schema_overrides.remove(&key);
        }
        let prefix = format!("{db}\x1f");
        rt.demo_rows.retain(|key, _| !key.starts_with(&prefix));
        if rt.selected_database.eq_ignore_ascii_case(&db) {
            rt.selected_database.clear();
            rt.schema.clear();
        }
        demo_databases_for_runtime(&rt, &request.connection_id)
    };

    state
        .schema_cache
        .invalidate_database(&request.connection_id, &db);
    invalidate_database_count(&state, &request.connection_id, &db);
    let invalidated = {
        let mut rt = state.runtime.lock().await;
        rt.sessions.invalidate_database(&request.connection_id, &db)
    };
    if !invalidated.is_empty() {
        let _ = app.emit(
            TABLE_SESSIONS_INVALIDATED_EVENT,
            TableSessionsInvalidatedPayload {
                connection_id: request.connection_id.clone(),
                session_ids: invalidated,
                reason: "database-dropped".into(),
            },
        );
    }

    Ok(DatabaseMutationResponse {
        database: db,
        databases,
        sql,
    })
}

fn demo_create_table_ddl(database: &str, table: &TableMeta) -> String {
    let mut lines: Vec<String> = table
        .columns
        .iter()
        .map(|col| {
            let mut parts = vec![format!(
                "  `{}` {}",
                escape_ident(&col.column_name),
                col.column_type
            )];
            if col.is_primary_key || !col.is_nullable {
                parts.push("NOT NULL".into());
            } else {
                parts.push("NULL".into());
            }
            if !col.column_comment.trim().is_empty() {
                let escaped = col.column_comment.replace('\\', "\\\\").replace('\'', "''");
                parts.push(format!("COMMENT '{escaped}'"));
            }
            parts.join(" ")
        })
        .collect();
    let pks: Vec<String> = if !table.primary_key_order.is_empty() {
        table
            .primary_key_order
            .iter()
            .map(|name| format!("`{}`", escape_ident(name)))
            .collect()
    } else {
        table
            .columns
            .iter()
            .filter(|col| col.is_primary_key)
            .map(|col| format!("`{}`", escape_ident(&col.column_name)))
            .collect()
    };
    if !pks.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", pks.join(", ")));
    }
    let comment = table.table_comment.replace('\\', "\\\\").replace('\'', "''");
    format!(
        "CREATE TABLE `{}`.`{}` (\n{}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='{}'",
        escape_ident(database),
        escape_ident(&table.table_name),
        lines.join(",\n"),
        comment
    )
}

#[tauri::command]
pub async fn show_create_table(
    connection_id: String,
    database: String,
    table_name: String,
    state: State<'_, AppState>,
) -> Result<ShowCreateTableResponse, String> {
    let db = database.trim().to_string();
    let table = table_name.trim().to_string();
    if db.is_empty() || table.is_empty() {
        return Err("必须指定有效的数据库和表名".into());
    }
    let (kind, mysql_url, clickhouse_url) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        (
            connection.kind,
            connection.mysql_url.clone(),
            connection.clickhouse_url.clone(),
        )
    };
    if kind == DatabaseKind::MongoDb {
        return Err("MongoDB 连接不支持查看建表语句".into());
    }
    if kind == DatabaseKind::ClickHouse {
        let url = clickhouse_url.ok_or_else(|| "ClickHouse 连接未配置".to_string())?;
        let ddl = clickhouse::show_create_table(&url, &db, &table).await?;
        return Ok(ShowCreateTableResponse {
            database: db,
            table_name: table,
            ddl,
        });
    }
    if mysql_url.is_some() {
        let pool = real_database_pool(&connection_id, &db, &state, &PerfContext::default()).await?;
        let mut conn = pool
            .acquire()
            .await
            .map_err(|error| format!("获取 MySQL 连接失败: {error}"))?;
        let ddl = sync::show_create_table(&mut conn, &db, &table).await?;
        return Ok(ShowCreateTableResponse {
            database: db,
            table_name: table,
            ddl,
        });
    }

    let rt = state.runtime.lock().await;
    let schema = demo_schema_for_runtime(
        &rt.demo_schema_overrides,
        rt.demo_profile,
        &db,
        &rt.selected_database,
        &rt.schema,
    );
    let found = schema
        .iter()
        .find(|item| item.table_name.eq_ignore_ascii_case(&table))
        .ok_or_else(|| format!("表不存在: {table}"))?;
    Ok(ShowCreateTableResponse {
        database: db.clone(),
        table_name: found.table_name.clone(),
        ddl: demo_create_table_ddl(&db, found),
    })
}

#[tauri::command]
pub async fn truncate_tables(
    request: TruncateTablesRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TruncateTablesResponse, String> {
    let table_names: Vec<String> = request
        .tables
        .iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    if table_names.is_empty() {
        return Err("请选择要清空的表".into());
    }
    let is_real_mysql =
        resolve_mysql_connection(&request.connection_id, &state, "清空表").await?;

    if is_real_mysql {
        let pool =
            real_connection_pool(&request.connection_id, &state, &perf_context).await?;
        let mut truncated = Vec::new();
        let mut failed = Vec::new();
        for table_name in &table_names {
            let sql = format!(
                "TRUNCATE TABLE `{}`.`{}`",
                escape_ident(&request.database),
                escape_ident(table_name)
            );
            let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
            let audit_id = best_effort_audit(
                &app,
                &state,
                &perf_context,
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
                    notes: Some("清空表无法行级回滚，请通过备份恢复".into()),
                },
            )
            .await;
            match sqlx::query(&sql).execute(&pool).await {
                Ok(_) => {
                    mark_audit(&app, &state, &perf_context, audit_id, true).await;
                    invalidate_table_count(
                        &state,
                        &request.connection_id,
                        &request.database,
                        table_name,
                    );
                    truncated.push(TruncateTableResult {
                        table_name: table_name.clone(),
                        error: None,
                    });
                }
                Err(error) => {
                    mark_audit(&app, &state, &perf_context, audit_id, false).await;
                    failed.push(TruncateTableResult {
                        table_name: table_name.clone(),
                        error: Some(error.to_string()),
                    });
                }
            }
        }
        let truncated_names: Vec<String> =
            truncated.iter().map(|item| item.table_name.clone()).collect();
        if !truncated_names.is_empty() {
            crate::table_modified::record_local_change_owned(
                &app,
                &state,
                &request.connection_id,
                &request.database,
                &truncated_names,
            )
            .await;
        }
        return Ok(TruncateTablesResponse { truncated, failed });
    }

    let mut rt = state.runtime.lock().await;
    let schema = demo_schema_for_runtime(
        &rt.demo_schema_overrides,
        rt.demo_profile,
        &request.database,
        &rt.selected_database,
        &rt.schema,
    );
    let mut truncated = Vec::new();
    let mut failed = Vec::new();
    for table_name in table_names {
        if let Some(found) = schema
            .iter()
            .find(|item| item.table_name.eq_ignore_ascii_case(&table_name))
        {
            rt.demo_rows.insert(
                demo_row_key(&request.database, &found.table_name),
                Vec::new(),
            );
            invalidate_table_count(
                &state,
                &request.connection_id,
                &request.database,
                &found.table_name,
            );
            truncated.push(TruncateTableResult {
                table_name: found.table_name.clone(),
                error: None,
            });
        } else {
            failed.push(TruncateTableResult {
                table_name,
                error: Some("表不存在".into()),
            });
        }
    }
    Ok(TruncateTablesResponse { truncated, failed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_database_names_and_rejects_system_databases() {
        assert_eq!(validate_database_name("  game_prod_1 ", false).unwrap(), "game_prod_1");
        assert!(validate_database_name("", false).is_err());
        assert!(validate_database_name("bad name", false).is_err());
        assert!(validate_database_name("bad`name", false).is_err());
        assert!(validate_database_name("mysql", false).is_err());
        assert!(validate_database_name("INFORMATION_SCHEMA", true).is_err());
        assert!(validate_database_name("performance_schema", true).is_err());
        assert!(validate_database_name("sys", true).is_err());
    }

    #[test]
    fn builds_create_alter_and_drop_database_sql() {
        assert_eq!(
            build_create_database_sql("app_db", Some("utf8mb4"), Some("utf8mb4_unicode_ci")).unwrap(),
            "CREATE DATABASE `app_db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        );
        assert_eq!(
            build_create_database_sql("app_db", None, None).unwrap(),
            "CREATE DATABASE `app_db`"
        );
        assert_eq!(
            build_alter_database_sql("app_db", "utf8mb4", Some("utf8mb4_bin")).unwrap(),
            "ALTER DATABASE `app_db` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
        );
        assert_eq!(
            build_drop_database_sql("app_db").unwrap(),
            "DROP DATABASE `app_db`"
        );
    }

    #[test]
    fn rejects_invalid_charset_or_collation_tokens() {
        assert!(build_create_database_sql("app_db", Some("utf8mb4; DROP TABLE x"), None).is_err());
        assert!(build_alter_database_sql("app_db", "utf8mb4", Some("utf8mb4_general_ci --")).is_err());
    }
}
