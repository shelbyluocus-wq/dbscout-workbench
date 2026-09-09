use std::{
    collections::HashMap,
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::{
    mysql::{MySqlConnection, MySqlRow},
    Column, Executor, MySql, Pool, Row, TypeInfo, ValueRef,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{watch, Mutex};
use uuid::Uuid;

use crate::{
    audit, clickhouse,
    db::connect_database,
    runtime_resources::PoolKey,
    sql_history,
    types::{AppState, DatabaseKind, RuntimeConnection},
};

const EVENT_NAME: &str = "sql-execution-event";
const CANCELLED: &str = "__SQL_EXECUTION_CANCELLED__";
const ROW_BATCH_SIZE: usize = 200;

pub struct SqlConsoleState {
    jobs: Mutex<HashMap<String, watch::Sender<bool>>>,
    transactions: Mutex<HashMap<String, Arc<SqlTransactionSession>>>,
}

impl Default for SqlConsoleState {
    fn default() -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            transactions: Mutex::new(HashMap::new()),
        }
    }
}

struct SqlTransactionSession {
    connection_id: String,
    database: String,
    query_tab_id: String,
    connection: Mutex<Option<sqlx::pool::PoolConnection<MySql>>>,
    audit_ids: Mutex<Vec<i64>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSqlExecutionRequest {
    pub connection_id: String,
    pub database: String,
    pub query_tab_id: String,
    pub sql: String,
    #[serde(default)]
    pub statements: Vec<String>,
    #[serde(default)]
    pub scope: String,
    #[serde(default = "default_row_limit")]
    pub row_limit: u32,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    pub transaction_session_id: Option<String>,
    #[serde(default)]
    pub confirmed_risky: bool,
}

fn default_row_limit() -> u32 {
    1000
}
fn default_timeout() -> u64 {
    60
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSqlExecutionResponse {
    pub job_id: String,
    pub execution_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginSqlTransactionRequest {
    pub connection_id: String,
    pub database: String,
    pub query_tab_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginSqlTransactionResponse {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileResponse {
    pub path: String,
    pub file_name: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSqlFileRequest {
    pub path: Option<String>,
    pub file_name: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSqlFileResponse {
    pub path: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SqlColumn {
    name: String,
    key: String,
    type_name: String,
    nullable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatementCategory {
    Read,
    Write,
    Transaction,
}

#[derive(Debug, Clone)]
pub struct StatementClassification {
    pub keyword: String,
    pub category: StatementCategory,
    pub high_risk: bool,
}

impl StatementClassification {
    fn label(&self) -> &'static str {
        match self.category {
            StatementCategory::Read => "read",
            StatementCategory::Write => "write",
            StatementCategory::Transaction => "transaction",
        }
    }
}

fn emit(
    app: &AppHandle,
    request: &StartSqlExecutionRequest,
    job_id: &str,
    execution_id: &str,
    mut payload: Value,
) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    object.insert(
        "queryTabId".into(),
        Value::String(request.query_tab_id.clone()),
    );
    object.insert(
        "connectionId".into(),
        Value::String(request.connection_id.clone()),
    );
    object.insert("database".into(), Value::String(request.database.clone()));
    object.insert("jobId".into(), Value::String(job_id.to_string()));
    object.insert(
        "executionId".into(),
        Value::String(execution_id.to_string()),
    );
    let _ = app.emit(EVENT_NAME, payload);
}

async fn resolve_connection(
    state: &AppState,
    connection_id: &str,
) -> Result<RuntimeConnection, String> {
    state
        .runtime
        .lock()
        .await
        .connections
        .get(connection_id)
        .cloned()
        .ok_or_else(|| "连接不存在".to_string())
}

async fn mysql_pool(
    state: &AppState,
    connection: &RuntimeConnection,
    database: &str,
) -> Result<Pool<MySql>, String> {
    let url = connection
        .mysql_url
        .clone()
        .ok_or_else(|| "演示连接不使用 MySQL 连接池".to_string())?;
    let key = PoolKey::new(&connection.id, database);
    let database = key.database().to_string();
    state
        .resources
        .get_or_connect_database(key, move || async move {
            connect_database(&url, Some(&database)).await
        })
        .await
}

fn validate_request(
    request: &mut StartSqlExecutionRequest,
    connection: &RuntimeConnection,
) -> Result<Vec<String>, String> {
    request.row_limit = request.row_limit.clamp(1, 10_000);
    request.timeout_seconds = request.timeout_seconds.clamp(1, 600);
    let statements = requested_sql_statements(request);
    if statements.is_empty() {
        return Err("没有可执行的 SQL".into());
    }
    let classifications = statements
        .iter()
        .map(|sql| classify_statement(sql))
        .collect::<Vec<_>>();
    if classifications
        .iter()
        .any(|item| item.category == StatementCategory::Transaction)
    {
        return Err(
            "请使用查询标签的自动提交开关以及提交、回滚按钮管理事务，不能直接执行事务控制语句"
                .into(),
        );
    }
    if connection.kind == DatabaseKind::MongoDb {
        return Err("MongoDB 连接不支持 SQL 控制台".into());
    }
    if connection.kind.is_read_only()
        && classifications
            .iter()
            .any(|item| item.category != StatementCategory::Read)
    {
        return Err("ClickHouse 连接为只读连接，只允许 SELECT、SHOW、DESCRIBE 和 EXPLAIN".into());
    }
    if classifications.iter().any(|item| item.high_risk) && !request.confirmed_risky {
        return Err("该批次包含高风险 SQL，需要确认后才能执行".into());
    }
    Ok(statements)
}

fn requested_sql_statements(request: &StartSqlExecutionRequest) -> Vec<String> {
    let provided = request
        .statements
        .iter()
        .map(|statement| statement.trim())
        .filter(|statement| !statement.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if provided.is_empty() {
        split_sql_statements(&request.sql)
    } else {
        provided
    }
}

#[tauri::command]
pub async fn start_sql_execution(
    app: AppHandle,
    mut request: StartSqlExecutionRequest,
    state: State<'_, AppState>,
) -> Result<StartSqlExecutionResponse, String> {
    let connection = resolve_connection(&state, &request.connection_id).await?;
    let statements = validate_request(&mut request, &connection)?;
    if let Some(session_id) = request.transaction_session_id.as_deref() {
        let transactions = state.sql_console.transactions.lock().await;
        let session = transactions
            .get(session_id)
            .ok_or_else(|| "事务会话不存在或已经结束".to_string())?;
        if session.connection_id != request.connection_id
            || session.database != request.database
            || session.query_tab_id != request.query_tab_id
        {
            return Err("事务会话与当前查询标签不匹配".into());
        }
    }
    let job_id = Uuid::new_v4().to_string();
    let execution_id = Uuid::new_v4().to_string();
    let (cancel_tx, cancel_rx) = watch::channel(false);
    state
        .sql_console
        .jobs
        .lock()
        .await
        .insert(job_id.clone(), cancel_tx);

    let task_app = app.clone();
    let task_job_id = job_id.clone();
    let task_execution_id = execution_id.clone();
    tokio::spawn(async move {
        let state = task_app.state::<AppState>();
        emit(
            &task_app,
            &request,
            &task_job_id,
            &task_execution_id,
            json!({ "type": "execution-started" }),
        );
        let result = match connection.kind {
            DatabaseKind::MySql if connection.mysql_url.is_some() => {
                run_mysql_job(
                    &task_app,
                    &state,
                    &connection,
                    &request,
                    &statements,
                    &task_job_id,
                    &task_execution_id,
                    cancel_rx,
                )
                .await
            }
            DatabaseKind::ClickHouse => {
                run_clickhouse_job(
                    &task_app,
                    &state,
                    &connection,
                    &request,
                    &statements,
                    &task_job_id,
                    &task_execution_id,
                    cancel_rx,
                )
                .await
            }
            DatabaseKind::MongoDb => Err("MongoDB 连接不支持 SQL 控制台".into()),
            _ => {
                run_demo_job(
                    &task_app,
                    &state,
                    &request,
                    &statements,
                    &task_job_id,
                    &task_execution_id,
                    cancel_rx,
                )
                .await
            }
        };
        if matches!(&result, Err(error) if error == CANCELLED) {
            emit(
                &task_app,
                &request,
                &task_job_id,
                &task_execution_id,
                json!({ "type": "cancelled", "message": "查询已停止" }),
            );
        }
        emit(
            &task_app,
            &request,
            &task_job_id,
            &task_execution_id,
            json!({ "type": "execution-completed" }),
        );
        state.sql_console.jobs.lock().await.remove(&task_job_id);
    });
    Ok(StartSqlExecutionResponse {
        job_id,
        execution_id,
    })
}

#[tauri::command]
pub async fn cancel_sql_execution(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let jobs = state.sql_console.jobs.lock().await;
    let Some(sender) = jobs.get(&job_id) else {
        return Ok(false);
    };
    sender
        .send(true)
        .map_err(|_| "查询任务已经结束".to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn begin_sql_transaction(
    request: BeginSqlTransactionRequest,
    state: State<'_, AppState>,
) -> Result<BeginSqlTransactionResponse, String> {
    let connection = resolve_connection(&state, &request.connection_id).await?;
    if connection.kind != DatabaseKind::MySql {
        return Err("只有 MySQL 查询标签支持事务".into());
    }
    let connection_handle = if connection.mysql_url.is_some() {
        let pool = mysql_pool(&state, &connection, &request.database).await?;
        let mut handle = pool
            .acquire()
            .await
            .map_err(|error| format!("获取事务连接失败: {error}"))?;
        sqlx::query("START TRANSACTION")
            .execute(&mut *handle)
            .await
            .map_err(|error| format!("开始事务失败: {error}"))?;
        Some(handle)
    } else {
        None
    };
    let session_id = Uuid::new_v4().to_string();
    state.sql_console.transactions.lock().await.insert(
        session_id.clone(),
        Arc::new(SqlTransactionSession {
            connection_id: request.connection_id,
            database: request.database,
            query_tab_id: request.query_tab_id,
            connection: Mutex::new(connection_handle),
            audit_ids: Mutex::new(Vec::new()),
        }),
    );
    Ok(BeginSqlTransactionResponse { session_id })
}

async fn finish_transaction(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    commit: bool,
) -> Result<(), String> {
    let session = state
        .sql_console
        .transactions
        .lock()
        .await
        .remove(session_id)
        .ok_or_else(|| "事务会话不存在或已经结束".to_string())?;
    let ids = session.audit_ids.lock().await.clone();
    let audit_pool = if ids.is_empty() {
        None
    } else {
        match audit::ensure_audit_pool(app, state).await {
            Ok(pool) => Some(pool),
            Err(error) => {
                state
                    .sql_console
                    .transactions
                    .lock()
                    .await
                    .insert(session_id.to_string(), session.clone());
                return Err(error);
            }
        }
    };
    let mut connection = session.connection.lock().await;
    if commit {
        if let Some(pool) = audit_pool.as_ref() {
            for id in &ids {
                if let Err(error) = audit::mark_committed_required(pool, *id).await {
                    if let Some(connection) = connection.as_mut() {
                        if let Err(rollback_error) =
                            sqlx::query("ROLLBACK").execute(&mut **connection).await
                        {
                            state
                                .sql_console
                                .transactions
                                .lock()
                                .await
                                .insert(session_id.to_string(), session.clone());
                            return Err(format!(
                                "更新审计状态失败: {error}; 随后的回滚也失败: {rollback_error}"
                            ));
                        }
                    }
                    for id in &ids {
                        let _ = audit::mark_aborted_required(pool, *id).await;
                    }
                    return Err(error);
                }
            }
        }
        if let Some(connection) = connection.as_mut() {
            if let Err(error) = sqlx::query("COMMIT").execute(&mut **connection).await {
                let rollback_error = sqlx::query("ROLLBACK")
                    .execute(&mut **connection)
                    .await
                    .err();
                if let Some(pool) = audit_pool.as_ref() {
                    for id in &ids {
                        let _ = audit::mark_aborted_required(pool, *id).await;
                    }
                }
                if rollback_error.is_some() {
                    state
                        .sql_console
                        .transactions
                        .lock()
                        .await
                        .insert(session_id.to_string(), session.clone());
                }
                return Err(match rollback_error {
                    Some(rollback_error) => {
                        format!("提交事务失败: {error}; 随后的回滚也失败: {rollback_error}")
                    }
                    None => format!("提交事务失败: {error}"),
                });
            }
        }
        if !ids.is_empty() {
            crate::audit_sync::trigger_immediate_sync(app);
        }
    } else {
        if let Some(connection) = connection.as_mut() {
            if let Err(error) = sqlx::query("ROLLBACK").execute(&mut **connection).await {
                state
                    .sql_console
                    .transactions
                    .lock()
                    .await
                    .insert(session_id.to_string(), session.clone());
                return Err(format!("回滚事务失败: {error}"));
            }
        }
        if let Some(pool) = audit_pool.as_ref() {
            for id in &ids {
                audit::mark_aborted_required(pool, *id).await?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn commit_sql_transaction(
    app: AppHandle,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    finish_transaction(&app, &state, &session_id, true).await
}

#[tauri::command]
pub async fn rollback_sql_transaction(
    app: AppHandle,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    finish_transaction(&app, &state, &session_id, false).await
}

async fn cancellable<T, F>(
    receiver: &mut watch::Receiver<bool>,
    timeout: Duration,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, sqlx::Error>>,
{
    if *receiver.borrow() {
        return Err(CANCELLED.into());
    }
    tokio::select! {
        _ = receiver.changed() => Err(CANCELLED.into()),
        result = tokio::time::timeout(timeout, future) => match result {
            Ok(value) => value.map_err(|error| error.to_string()),
            Err(_) => Err(format!("查询超时（{} 秒）", timeout.as_secs())),
        }
    }
}

async fn run_mysql_job(
    app: &AppHandle,
    state: &AppState,
    connection: &RuntimeConnection,
    request: &StartSqlExecutionRequest,
    statements: &[String],
    job_id: &str,
    execution_id: &str,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    if let Some(session_id) = request.transaction_session_id.as_deref() {
        let session = state
            .sql_console
            .transactions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "事务会话已经结束".to_string())?;
        let mut guard = session.connection.lock().await;
        let connection = guard
            .as_mut()
            .ok_or_else(|| "演示事务没有真实连接".to_string())?;
        run_mysql_statements(
            app,
            state,
            &mut **connection,
            request,
            statements,
            job_id,
            execution_id,
            &mut cancel,
            Some(&session),
        )
        .await
    } else {
        let pool = mysql_pool(state, connection, &request.database).await?;
        let mut handle = pool
            .acquire()
            .await
            .map_err(|error| format!("获取查询连接失败: {error}"))?;
        run_mysql_statements(
            app,
            state,
            &mut *handle,
            request,
            statements,
            job_id,
            execution_id,
            &mut cancel,
            None,
        )
        .await
    }
}

async fn prepare_audit(
    app: &AppHandle,
    state: &AppState,
    request: &StartSqlExecutionRequest,
    sql: &str,
    class: &StatementClassification,
) -> Result<Option<(sqlx::SqlitePool, i64)>, String> {
    if class.category != StatementCategory::Write {
        return Ok(None);
    }
    let (actor, client_id) = crate::account::audit_actor_and_id(app, state).await;
    let context = audit::AuditContext {
        connection_id: request.connection_id.clone(),
        database: request.database.clone(),
        table_name: affected_object(sql),
        session_id: request.transaction_session_id.clone(),
        source: audit::SOURCE_SQL_CONSOLE,
        actor,
        client_id,
    };
    let operation = operation_name(&class.keyword);
    let pending = audit::PendingAudit {
        operation,
        column_name: None,
        old_value: None,
        new_value: None,
        row_identity: None,
        forward_sql: sql.to_string(),
        forward_binds: Vec::new(),
        inverse_sql: None,
        inverse_binds: Vec::new(),
        rollback_strategy: audit::STRATEGY_MANUAL,
        notes: Some("SQL 控制台任意语句，需手动回滚".into()),
    };
    let pool = audit::ensure_audit_pool(app, state).await?;
    let id = audit::record_pending(&pool, &context, &pending).await?;
    Ok(Some((pool, id)))
}

async fn run_mysql_statements(
    app: &AppHandle,
    state: &AppState,
    connection: &mut MySqlConnection,
    request: &StartSqlExecutionRequest,
    statements: &[String],
    job_id: &str,
    execution_id: &str,
    cancel: &mut watch::Receiver<bool>,
    transaction: Option<&Arc<SqlTransactionSession>>,
) -> Result<(), String> {
    let timeout = Duration::from_secs(request.timeout_seconds);
    for (index, statement) in statements.iter().enumerate() {
        let class = classify_statement(statement);
        emit(
            app,
            request,
            job_id,
            execution_id,
            json!({ "type": "statement-started", "statementIndex": index, "sql": statement, "category": class.label() }),
        );
        let started = Instant::now();
        let audit_row = match prepare_audit(app, state, request, statement, &class).await {
            Ok(value) => value,
            Err(error) => {
                emit_statement_error(
                    app,
                    request,
                    job_id,
                    execution_id,
                    index,
                    statement,
                    started,
                    &error,
                );
                let _ = sql_history::record(
                    app,
                    state,
                    &request.connection_id,
                    &request.database,
                    statement,
                    "failed",
                    started.elapsed().as_millis() as u64,
                    0,
                )
                .await;
                return Err(error);
            }
        };
        let local_transaction = transaction.is_none()
            && ["INSERT", "UPDATE", "DELETE", "REPLACE"].contains(&class.keyword.as_str());
        if local_transaction {
            if let Err(error) = cancellable(
                cancel,
                timeout,
                sqlx::query("START TRANSACTION").execute(&mut *connection),
            )
            .await
            {
                if let Some((pool, id)) = audit_row.as_ref() {
                    let _ = audit::mark_aborted_required(pool, *id).await;
                }
                return Err(error);
            }
        }
        let outcome = if class.category == StatementCategory::Read {
            let query_sql = mysql_limited_sql(statement, request.row_limit);
            cancellable(
                cancel,
                timeout,
                (&mut *connection).fetch_all(sqlx::raw_sql(&query_sql)),
            )
            .await
            .map(|rows| {
                let truncated = rows.len() > request.row_limit as usize;
                let rows = rows
                    .into_iter()
                    .take(request.row_limit as usize)
                    .collect::<Vec<_>>();
                let (columns, values) = convert_mysql_rows(&rows);
                emit(
                    app,
                    request,
                    job_id,
                    execution_id,
                    json!({ "type": "result-meta", "statementIndex": index, "columns": columns }),
                );
                for batch in values.chunks(ROW_BATCH_SIZE) {
                    emit(
                        app,
                        request,
                        job_id,
                        execution_id,
                        json!({ "type": "row-batch", "statementIndex": index, "rows": batch }),
                    );
                }
                let plan = if class.keyword == "EXPLAIN" {
                    Some(Value::Array(values.clone()))
                } else {
                    None
                };
                (values.len() as u64, 0, truncated, plan)
            })
        } else {
            cancellable(
                cancel,
                timeout,
                (&mut *connection).execute(sqlx::raw_sql(statement)),
            )
            .await
            .map(|result| (0, result.rows_affected(), false, None))
        };
        match outcome {
            Ok((row_count, affected_rows, truncated, plan)) => {
                let mut should_sync_audit = false;
                if let Some((pool, id)) = audit_row.as_ref() {
                    if let Some(transaction) = transaction {
                        transaction.audit_ids.lock().await.push(*id);
                    } else {
                        if let Err(error) = audit::mark_committed_required(pool, *id).await {
                            if local_transaction {
                                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                            }
                            let _ = audit::mark_aborted_required(pool, *id).await;
                            emit_statement_error(
                                app,
                                request,
                                job_id,
                                execution_id,
                                index,
                                statement,
                                started,
                                &error,
                            );
                            return Err(error);
                        }
                        should_sync_audit = true;
                    }
                }
                if local_transaction {
                    if let Err(error) = sqlx::query("COMMIT").execute(&mut *connection).await {
                        if let Some((pool, id)) = audit_row.as_ref() {
                            let _ = audit::mark_aborted_required(pool, *id).await;
                        }
                        emit_statement_error(
                            app,
                            request,
                            job_id,
                            execution_id,
                            index,
                            statement,
                            started,
                            &error.to_string(),
                        );
                        return Err(format!("提交 SQL 写入事务失败: {error}"));
                    }
                }
                if should_sync_audit {
                    crate::audit_sync::trigger_immediate_sync(app);
                }
                let duration = started.elapsed().as_millis() as u64;
                let message = if class.category == StatementCategory::Read {
                    format!("返回 {row_count} 行")
                } else {
                    format!("影响 {affected_rows} 行")
                };
                emit(
                    app,
                    request,
                    job_id,
                    execution_id,
                    json!({
                        "type": "statement-completed", "statementIndex": index, "durationMs": duration,
                        "rowCount": row_count, "affectedRows": affected_rows, "truncated": truncated,
                        "warnings": [], "message": message, "plan": plan,
                    }),
                );
                let _ = sql_history::record(
                    app,
                    state,
                    &request.connection_id,
                    &request.database,
                    statement,
                    "success",
                    duration,
                    affected_rows,
                )
                .await;
                if class.category == StatementCategory::Write {
                    invalidate_after_write(app, state, request, job_id, execution_id);
                }
            }
            Err(error) => {
                if local_transaction {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                }
                if let Some((pool, id)) = audit_row {
                    let _ = audit::mark_aborted_required(&pool, id).await;
                }
                if error == CANCELLED {
                    return Err(error);
                }
                emit_statement_error(
                    app,
                    request,
                    job_id,
                    execution_id,
                    index,
                    statement,
                    started,
                    &error,
                );
                let _ = sql_history::record(
                    app,
                    state,
                    &request.connection_id,
                    &request.database,
                    statement,
                    "failed",
                    started.elapsed().as_millis() as u64,
                    0,
                )
                .await;
                return Err(error);
            }
        }
    }
    Ok(())
}

fn emit_statement_error(
    app: &AppHandle,
    request: &StartSqlExecutionRequest,
    job_id: &str,
    execution_id: &str,
    index: usize,
    sql: &str,
    started: Instant,
    error: &str,
) {
    emit(
        app,
        request,
        job_id,
        execution_id,
        json!({
            "type": "statement-error", "statementIndex": index,
            "durationMs": started.elapsed().as_millis() as u64, "error": error,
            "errorOffset": error_offset(sql, error),
        }),
    );
}

fn error_offset(sql: &str, error: &str) -> usize {
    let lower = error.to_ascii_lowercase();
    let Some(marker) = lower.rfind("at line ") else {
        return 0;
    };
    let line = lower[marker + 8..]
        .split(|ch: char| !ch.is_ascii_digit())
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1);
    sql.match_indices('\n')
        .nth(line.saturating_sub(2))
        .map(|(index, _)| index + 1)
        .unwrap_or(0)
}

fn invalidate_after_write(
    app: &AppHandle,
    state: &AppState,
    request: &StartSqlExecutionRequest,
    job_id: &str,
    execution_id: &str,
) {
    state
        .schema_cache
        .invalidate_database(&request.connection_id, &request.database);
    state
        .table_counts
        .invalidate_database(&PoolKey::new(&request.connection_id, &request.database));
    emit(
        app,
        request,
        job_id,
        execution_id,
        json!({ "type": "schema-changed" }),
    );
}

fn convert_mysql_rows(rows: &[MySqlRow]) -> (Vec<SqlColumn>, Vec<Value>) {
    let Some(first) = rows.first() else {
        return (Vec::new(), Vec::new());
    };
    let mut counts = HashMap::<String, usize>::new();
    let columns = first
        .columns()
        .iter()
        .map(|column| {
            let name = column.name().to_string();
            let count = counts.entry(name.clone()).or_default();
            *count += 1;
            let key = if *count == 1 {
                name.clone()
            } else {
                format!("{name}#{}", *count)
            };
            SqlColumn {
                name,
                key,
                type_name: column.type_info().name().to_string(),
                nullable: true,
            }
        })
        .collect::<Vec<_>>();
    let values = rows
        .iter()
        .map(|row| {
            let mut object = Map::new();
            for (index, column) in columns.iter().enumerate() {
                object.insert(
                    column.key.clone(),
                    mysql_cell(row, index, &column.type_name),
                );
            }
            Value::Object(object)
        })
        .collect();
    (columns, values)
}

fn mysql_cell(row: &MySqlRow, index: usize, type_name: &str) -> Value {
    if row
        .try_get_raw(index)
        .map(|value| value.is_null())
        .unwrap_or(true)
    {
        return Value::Null;
    }
    let upper = type_name.to_ascii_uppercase();
    if upper.contains("UNSIGNED") {
        if let Ok(value) = row.try_get::<u64, _>(index) {
            return Value::from(value);
        }
    }
    if ["TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT", "YEAR"]
        .iter()
        .any(|kind| upper.starts_with(kind))
    {
        if let Ok(value) = row.try_get::<i64, _>(index) {
            return Value::from(value);
        }
    }
    if upper.starts_with("FLOAT") || upper.starts_with("DOUBLE") {
        if let Ok(value) = row.try_get::<f64, _>(index) {
            return serde_json::Number::from_f64(value)
                .map(Value::Number)
                .unwrap_or(Value::Null);
        }
    }
    if upper.starts_with("JSON") {
        if let Ok(value) = row.try_get::<Value, _>(index) {
            return value;
        }
    }
    if let Ok(value) = row.try_get::<String, _>(index) {
        return Value::String(value);
    }
    if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
        return json!({ "kind": "binary", "length": value.len(), "base64": base64::engine::general_purpose::STANDARD.encode(value) });
    }
    Value::String(format!("<{}>", type_name))
}

async fn run_clickhouse_job(
    app: &AppHandle,
    state: &AppState,
    connection: &RuntimeConnection,
    request: &StartSqlExecutionRequest,
    statements: &[String],
    job_id: &str,
    execution_id: &str,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    let url = connection
        .clickhouse_url
        .as_deref()
        .ok_or_else(|| "ClickHouse 连接地址缺失".to_string())?;
    for (index, statement) in statements.iter().enumerate() {
        let class = classify_statement(statement);
        emit(
            app,
            request,
            job_id,
            execution_id,
            json!({ "type": "statement-started", "statementIndex": index, "sql": statement, "category": class.label() }),
        );
        let started = Instant::now();
        let query = clickhouse_console_sql(statement, request.row_limit)?;
        let future = clickhouse::execute_console_json_query(url, &query);
        let value = tokio::select! {
            _ = cancel.changed() => return Err(CANCELLED.into()),
            result = tokio::time::timeout(Duration::from_secs(request.timeout_seconds), future) => match result {
                Ok(value) => value,
                Err(_) => Err(format!("查询超时（{} 秒）", request.timeout_seconds)),
            }
        };
        match value {
            Ok(value) => {
                let columns = value
                    .get("meta")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .enumerate()
                    .map(|(index, item)| {
                        let name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        SqlColumn {
                            key: if name.is_empty() {
                                format!("column_{}", index + 1)
                            } else {
                                name.clone()
                            },
                            name,
                            type_name: item
                                .get("type")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            nullable: true,
                        }
                    })
                    .collect::<Vec<_>>();
                let mut rows = value
                    .get("data")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let truncated = rows.len() > request.row_limit as usize;
                rows.truncate(request.row_limit as usize);
                emit(
                    app,
                    request,
                    job_id,
                    execution_id,
                    json!({ "type": "result-meta", "statementIndex": index, "columns": columns }),
                );
                for batch in rows.chunks(ROW_BATCH_SIZE) {
                    emit(
                        app,
                        request,
                        job_id,
                        execution_id,
                        json!({ "type": "row-batch", "statementIndex": index, "rows": batch }),
                    );
                }
                let duration = started.elapsed().as_millis() as u64;
                let plan = if class.keyword == "EXPLAIN" {
                    Some(Value::Array(rows.clone()))
                } else {
                    None
                };
                emit(
                    app,
                    request,
                    job_id,
                    execution_id,
                    json!({ "type": "statement-completed", "statementIndex": index, "durationMs": duration, "rowCount": rows.len(), "affectedRows": 0, "truncated": truncated, "warnings": [], "message": format!("返回 {} 行", rows.len()), "plan": plan }),
                );
                let _ = sql_history::record(
                    app,
                    state,
                    &request.connection_id,
                    &request.database,
                    statement,
                    "success",
                    duration,
                    0,
                )
                .await;
            }
            Err(error) => {
                emit_statement_error(
                    app,
                    request,
                    job_id,
                    execution_id,
                    index,
                    statement,
                    started,
                    &error,
                );
                let _ = sql_history::record(
                    app,
                    state,
                    &request.connection_id,
                    &request.database,
                    statement,
                    "failed",
                    started.elapsed().as_millis() as u64,
                    0,
                )
                .await;
                return Err(error);
            }
        }
    }
    Ok(())
}

async fn run_demo_job(
    app: &AppHandle,
    state: &AppState,
    request: &StartSqlExecutionRequest,
    statements: &[String],
    job_id: &str,
    execution_id: &str,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    for (index, statement) in statements.iter().enumerate() {
        let class = classify_statement(statement);
        emit(
            app,
            request,
            job_id,
            execution_id,
            json!({ "type": "statement-started", "statementIndex": index, "sql": statement, "category": class.label() }),
        );
        let started = Instant::now();
        if statement.to_ascii_uppercase().contains("SLEEP") {
            tokio::select! { _ = cancel.changed() => return Err(CANCELLED.into()), _ = tokio::time::sleep(Duration::from_secs(5)) => {} }
        }
        if statement.to_ascii_uppercase().contains("SYNTAX_ERROR") {
            let error = "演示错误：SQL 语法错误，位于第 1 行";
            emit_statement_error(
                app,
                request,
                job_id,
                execution_id,
                index,
                statement,
                started,
                error,
            );
            let _ = sql_history::record(
                app,
                state,
                &request.connection_id,
                &request.database,
                statement,
                "failed",
                started.elapsed().as_millis() as u64,
                0,
            )
            .await;
            return Err(error.into());
        }
        let duration = started.elapsed().as_millis() as u64;
        if class.category == StatementCategory::Read {
            let rows = if class.keyword == "EXPLAIN" {
                vec![
                    json!({ "id": 1, "select_type": "SIMPLE", "table": "player", "type": "ALL", "rows": 3 }),
                ]
            } else if statement.to_ascii_lowercase().contains("from player") {
                vec![
                    json!({ "id": 1001, "nickname": "北辰", "level": 42 }),
                    json!({ "id": 1002, "nickname": "夏栀", "level": 37 }),
                    json!({ "id": 1003, "nickname": "青禾", "level": 51 }),
                ]
            } else {
                vec![json!({ "result": 1, "environment": "browser-demo" })]
            };
            let columns = rows
                .first()
                .and_then(Value::as_object)
                .map(|object| {
                    object
                        .keys()
                        .map(|name| SqlColumn {
                            name: name.clone(),
                            key: name.clone(),
                            type_name: "String".into(),
                            nullable: true,
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            emit(
                app,
                request,
                job_id,
                execution_id,
                json!({ "type": "result-meta", "statementIndex": index, "columns": columns }),
            );
            emit(
                app,
                request,
                job_id,
                execution_id,
                json!({ "type": "row-batch", "statementIndex": index, "rows": rows }),
            );
            let plan = if class.keyword == "EXPLAIN" {
                Some(Value::Array(rows.clone()))
            } else {
                None
            };
            emit(
                app,
                request,
                job_id,
                execution_id,
                json!({ "type": "statement-completed", "statementIndex": index, "durationMs": duration, "rowCount": rows.len(), "affectedRows": 0, "truncated": false, "warnings": [], "message": format!("返回 {} 行", rows.len()), "plan": plan }),
            );
        } else {
            emit(
                app,
                request,
                job_id,
                execution_id,
                json!({ "type": "statement-completed", "statementIndex": index, "durationMs": duration, "rowCount": 0, "affectedRows": 1, "truncated": false, "warnings": ["演示模式未修改真实数据库"], "message": "演示写入完成" }),
            );
            invalidate_after_write(app, state, request, job_id, execution_id);
        }
        let _ = sql_history::record(
            app,
            state,
            &request.connection_id,
            &request.database,
            statement,
            "success",
            duration,
            if class.category == StatementCategory::Write {
                1
            } else {
                0
            },
        )
        .await;
    }
    Ok(())
}

fn has_top_level_keyword(masked: &str, keyword: &str) -> bool {
    top_level_words(masked)
        .iter()
        .any(|(word, _)| word == keyword)
}

fn has_top_level_format_clause(masked: &str) -> bool {
    top_level_words(masked).iter().any(|(word, offset)| {
        if word != "FORMAT" {
            return false;
        }
        masked[offset + word.len()..]
            .chars()
            .find(|char| !char.is_whitespace())
            .is_some_and(|char| char != '(')
    })
}

fn cap_top_level_limit(sql: &str, masked: &str, maximum: u32) -> String {
    let Some((_, limit_offset)) = top_level_words(masked)
        .into_iter()
        .find(|(word, _)| word == "LIMIT")
    else {
        return sql.to_string();
    };
    let bytes = sql.as_bytes();
    let mut cursor = limit_offset + "LIMIT".len();
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    let first_start = cursor;
    while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
        cursor += 1;
    }
    if first_start == cursor {
        return sql.to_string();
    }
    let first_end = cursor;
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    let (count_start, count_end) = if bytes.get(cursor) == Some(&b',') {
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if start == cursor {
            return sql.to_string();
        }
        (start, cursor)
    } else {
        (first_start, first_end)
    };
    let count = sql[count_start..count_end]
        .parse::<u128>()
        .unwrap_or(u128::MAX);
    if count <= maximum as u128 {
        return sql.to_string();
    }
    format!("{}{}{}", &sql[..count_start], maximum, &sql[count_end..])
}

fn mysql_limited_sql(sql: &str, limit: u32) -> String {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let class = classify_statement(trimmed);
    let masked = mask_sql(trimmed);
    if class.keyword == "SELECT" && has_top_level_keyword(&masked, "LIMIT") {
        cap_top_level_limit(trimmed, &masked, limit.saturating_add(1))
    } else if class.keyword == "SELECT" {
        format!("{trimmed} LIMIT {}", limit.saturating_add(1))
    } else {
        trimmed.to_string()
    }
}

fn clickhouse_json_query_sql(
    sql: &str,
    limit: u32,
    include_extra_row: bool,
) -> Result<String, String> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let masked = mask_sql(trimmed);
    if has_top_level_format_clause(&masked) {
        return Err("SQL 控制台不支持自定义 ClickHouse FORMAT，请移除 FORMAT 子句".into());
    }
    let class = classify_statement(trimmed);
    let effective_limit = limit.saturating_add(u32::from(include_extra_row));
    let limited = if class.keyword == "SELECT" && has_top_level_keyword(&masked, "LIMIT") {
        cap_top_level_limit(trimmed, &masked, effective_limit)
    } else if class.keyword == "SELECT" {
        format!("{trimmed} LIMIT {effective_limit}")
    } else {
        trimmed.to_string()
    };
    Ok(format!("{limited} FORMAT JSON"))
}

fn clickhouse_console_sql(sql: &str, limit: u32) -> Result<String, String> {
    clickhouse_json_query_sql(sql, limit, true)
}

pub(crate) fn clickhouse_read_query_sql(sql: &str, limit: u32) -> Result<String, String> {
    clickhouse_json_query_sql(sql, limit, false)
}

fn operation_name(keyword: &str) -> &'static str {
    match keyword {
        "INSERT" => "INSERT",
        "UPDATE" => "UPDATE",
        "DELETE" => "DELETE",
        "REPLACE" => "REPLACE",
        "CREATE" => "CREATE",
        "ALTER" => "ALTER",
        "DROP" => "DROP",
        "TRUNCATE" => "TRUNCATE",
        "RENAME" => "RENAME",
        _ => "SQL",
    }
}

fn affected_object(sql: &str) -> String {
    let masked = mask_sql(sql);
    let tokens = top_level_words(&masked);
    let operation_offset = operation_token(&tokens)
        .map(|(_, offset)| *offset)
        .unwrap_or(0);
    let words = masked[operation_offset..]
        .split_whitespace()
        .map(|word| {
            word.trim_matches(|ch: char| "`\"'(),;".contains(ch))
                .to_string()
        })
        .collect::<Vec<_>>();
    let upper = words
        .iter()
        .map(|word| word.to_ascii_uppercase())
        .collect::<Vec<_>>();
    let keyword = upper.first().map(String::as_str).unwrap_or("");
    let index = match keyword {
        "UPDATE" => Some(1),
        "INSERT" | "REPLACE" => upper
            .iter()
            .position(|word| word == "INTO")
            .map(|value| value + 1),
        "DELETE" => upper
            .iter()
            .position(|word| word == "FROM")
            .map(|value| value + 1),
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" => upper
            .iter()
            .position(|word| ["TABLE", "VIEW", "DATABASE", "INDEX"].contains(&word.as_str()))
            .map(|value| value + 1),
        _ => None,
    };
    index
        .and_then(|value| words.get(value))
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| "(sql_console)".into())
}

pub fn classify_statement(sql: &str) -> StatementClassification {
    let masked = mask_sql(sql);
    let tokens = top_level_words(&masked);
    let operation = operation_token(&tokens);
    let keyword = operation
        .map(|(word, _)| word.clone())
        .unwrap_or_else(|| "UNKNOWN".to_string());
    let read = ["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES"];
    let transaction = [
        "BEGIN",
        "START",
        "COMMIT",
        "ROLLBACK",
        "SAVEPOINT",
        "RELEASE",
    ];
    let high = [
        "DROP", "TRUNCATE", "ALTER", "CREATE", "RENAME", "GRANT", "REVOKE", "OPTIMIZE", "REPAIR",
        "ANALYZE",
    ];
    if read.contains(&keyword.as_str()) {
        return StatementClassification {
            keyword,
            category: StatementCategory::Read,
            high_risk: false,
        };
    }
    if transaction.contains(&keyword.as_str()) {
        return StatementClassification {
            keyword,
            category: StatementCategory::Transaction,
            high_risk: false,
        };
    }
    if high.contains(&keyword.as_str()) {
        return StatementClassification {
            keyword,
            category: StatementCategory::Write,
            high_risk: true,
        };
    }
    let operation_offset = operation.map(|(_, offset)| *offset).unwrap_or(0);
    let missing_where = ["UPDATE", "DELETE"].contains(&keyword.as_str())
        && !tokens
            .iter()
            .any(|(word, offset)| word == "WHERE" && *offset > operation_offset);
    let known_write = [
        "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "CALL", "LOAD",
    ]
    .contains(&keyword.as_str());
    StatementClassification {
        keyword,
        category: StatementCategory::Write,
        high_risk: missing_where || !known_write,
    }
}

fn top_level_words(masked: &str) -> Vec<(String, usize)> {
    let bytes = masked.as_bytes();
    let mut tokens = Vec::new();
    let (mut depth, mut index) = (0usize, 0usize);
    while index < bytes.len() {
        match bytes[index] {
            b'(' => {
                depth += 1;
                index += 1;
            }
            b')' => {
                depth = depth.saturating_sub(1);
                index += 1;
            }
            byte if depth == 0 && (byte.is_ascii_alphabetic() || byte == b'_') => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric()
                        || bytes[index] == b'_'
                        || bytes[index] == b'$')
                {
                    index += 1;
                }
                tokens.push((masked[start..index].to_ascii_uppercase(), start));
            }
            _ => index += 1,
        }
    }
    tokens
}

fn operation_token(tokens: &[(String, usize)]) -> Option<&(String, usize)> {
    let first = tokens.first()?;
    if first.0 != "WITH" {
        return Some(first);
    }
    tokens
        .iter()
        .skip(1)
        .find(|(word, _)| {
            [
                "SELECT", "VALUES", "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE",
            ]
            .contains(&word.as_str())
        })
        .or(Some(first))
}

pub fn split_sql_statements(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut output = Vec::new();
    let mut delimiter = b";".to_vec();
    let (mut start, mut index, mut state) = (0usize, 0usize, 0u8);
    while index < bytes.len() {
        if state == 0 {
            let line_start = index == 0
                || bytes
                    .get(index.wrapping_sub(1))
                    .is_some_and(|byte| *byte == b'\n' || *byte == b'\r');
            if line_start {
                let end = bytes[index..]
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map(|value| index + value)
                    .unwrap_or(bytes.len());
                let line = source[index..end].trim();
                if line.len() >= 10
                    && line[..9].eq_ignore_ascii_case("DELIMITER")
                    && line.as_bytes()[9].is_ascii_whitespace()
                {
                    push_statement(source, start, index, &mut output);
                    delimiter = line[9..].trim().as_bytes().to_vec();
                    index = if end < bytes.len() { end + 1 } else { end };
                    start = index;
                    continue;
                }
            }
            if !delimiter.is_empty() && bytes[index..].starts_with(&delimiter) {
                push_statement(source, start, index, &mut output);
                index += delimiter.len();
                start = index;
                continue;
            }
            match bytes[index] {
                b'\'' => state = 1,
                b'"' => state = 2,
                b'`' => state = 3,
                b'#' => state = 4,
                b'-' if bytes.get(index + 1) == Some(&b'-')
                    && bytes.get(index + 2).map_or(true, u8::is_ascii_whitespace) =>
                {
                    state = 4;
                    index += 1;
                }
                b'/' if bytes.get(index + 1) == Some(&b'*') => {
                    state = 5;
                    index += 1;
                }
                _ => {}
            }
        } else if state <= 3 {
            let quote = [0, b'\'', b'"', b'`'][state as usize];
            if bytes[index] == b'\\' && state != 3 {
                index += 1;
            } else if bytes[index] == quote {
                if bytes.get(index + 1) == Some(&quote) {
                    index += 1;
                } else {
                    state = 0;
                }
            }
        } else if state == 4 {
            if bytes[index] == b'\n' {
                state = 0;
            }
        } else if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
            state = 0;
            index += 1;
        }
        index += 1;
    }
    push_statement(source, start, source.len(), &mut output);
    output
}

fn push_statement(source: &str, start: usize, end: usize, output: &mut Vec<String>) {
    let value = source[start..end].trim();
    if !value.is_empty() {
        output.push(value.to_string());
    }
}

fn mask_sql(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = bytes.to_vec();
    let (mut index, mut state) = (0usize, 0u8);
    while index < bytes.len() {
        if state == 0 {
            match bytes[index] {
                b'\'' => {
                    state = 1;
                    out[index] = b' ';
                }
                b'"' => {
                    state = 2;
                    out[index] = b' ';
                }
                b'`' => {
                    state = 3;
                    out[index] = b' ';
                }
                b'#' => {
                    state = 4;
                    out[index] = b' ';
                }
                b'-' if bytes.get(index + 1) == Some(&b'-')
                    && bytes.get(index + 2).map_or(true, u8::is_ascii_whitespace) =>
                {
                    state = 4;
                    out[index] = b' ';
                    if index + 1 < out.len() {
                        out[index + 1] = b' ';
                    }
                    index += 1;
                }
                b'/' if bytes.get(index + 1) == Some(&b'*') => {
                    state = 5;
                    out[index] = b' ';
                    out[index + 1] = b' ';
                    index += 1;
                }
                _ => {}
            }
        } else if state <= 3 {
            let quote = [0, b'\'', b'"', b'`'][state as usize];
            out[index] = if bytes[index] == b'\n' { b'\n' } else { b' ' };
            if bytes[index] == b'\\' && state != 3 && index + 1 < bytes.len() {
                index += 1;
                out[index] = b' ';
            } else if bytes[index] == quote {
                if bytes.get(index + 1) == Some(&quote) {
                    index += 1;
                    out[index] = b' ';
                } else {
                    state = 0;
                }
            }
        } else if state == 4 {
            out[index] = if bytes[index] == b'\n' {
                state = 0;
                b'\n'
            } else {
                b' '
            };
        } else {
            out[index] = if bytes[index] == b'\n' { b'\n' } else { b' ' };
            if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
                index += 1;
                out[index] = b' ';
                state = 0;
            }
        }
        index += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| source.to_string())
}

#[tauri::command]
pub async fn open_sql_file(path: Option<String>) -> Result<Option<SqlFileResponse>, String> {
    let path = if let Some(path) = path.filter(|value| !value.trim().is_empty()) {
        std::path::PathBuf::from(path)
    } else {
        let Some(file) = rfd::AsyncFileDialog::new()
            .add_filter("SQL 文件", &["sql"])
            .pick_file()
            .await
        else {
            return Ok(None);
        };
        file.path().to_path_buf()
    };
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|error| format!("读取 SQL 文件失败: {error}"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("query.sql")
        .to_string();
    Ok(Some(SqlFileResponse {
        path: path.to_string_lossy().to_string(),
        file_name,
        content,
    }))
}

#[tauri::command]
pub async fn save_sql_file(request: SaveSqlFileRequest) -> Result<SaveSqlFileResponse, String> {
    let path = if let Some(path) = request.path.filter(|value| !value.trim().is_empty()) {
        std::path::PathBuf::from(path)
    } else {
        let Some(file) = rfd::AsyncFileDialog::new()
            .set_file_name(&request.file_name)
            .add_filter("SQL 文件", &["sql"])
            .save_file()
            .await
        else {
            return Err("用户取消了保存".into());
        };
        file.path().to_path_buf()
    };
    tokio::fs::write(&path, request.content)
        .await
        .map_err(|error| format!("保存 SQL 文件失败: {error}"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("query.sql")
        .to_string();
    Ok(SaveSqlFileResponse {
        path: path.to_string_lossy().to_string(),
        file_name,
    })
}

#[tauri::command]
pub async fn save_sql_result_file(file_name: String, data: Vec<u8>) -> Result<String, String> {
    let extension = std::path::Path::new(&file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("csv")
        .to_ascii_lowercase();
    let filter_name = if extension == "xlsx" { "Excel" } else { "CSV" };
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name(&file_name)
        .add_filter(filter_name, &[extension.as_str()])
        .save_file()
        .await
    else {
        return Err("用户取消了保存".into());
    };
    tokio::fs::write(file.path(), data)
        .await
        .map_err(|error| format!("保存查询结果失败: {error}"))?;
    Ok(file.path().to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn execution_request(sql: &str, statements: Vec<String>) -> StartSqlExecutionRequest {
        StartSqlExecutionRequest {
            connection_id: "mysql-1".into(),
            database: "demo".into(),
            query_tab_id: "query-1".into(),
            sql: sql.into(),
            statements,
            scope: "all".into(),
            row_limit: 1000,
            timeout_seconds: 60,
            transaction_session_id: None,
            confirmed_risky: true,
        }
    }

    #[test]
    fn splitter_ignores_literals_comments_and_supports_delimiter() {
        let sql = "SELECT ';'; -- ;\nSELECT 2;";
        assert_eq!(
            split_sql_statements(sql),
            vec!["SELECT ';'", "-- ;\nSELECT 2"]
        );
        let routine = "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 3;";
        assert_eq!(split_sql_statements(routine).len(), 2);
        assert!(split_sql_statements(routine)[0].contains("SELECT 2;"));
    }

    #[test]
    fn structured_routine_body_is_not_split_again() {
        let routine = "CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END";
        let request = execution_request(routine, vec![routine.into()]);
        assert_eq!(requested_sql_statements(&request), vec![routine]);
    }

    #[test]
    fn mysql_console_sql_does_not_use_a_prepared_statement() {
        fn assert_unprepared<'q>(mut query: impl sqlx::Execute<'q, MySql>) {
            assert!(query.statement().is_none());
            assert!(query.take_arguments().unwrap().is_none());
        }

        let query = sqlx::raw_sql("USE demo");
        assert_unprepared(query);
    }

    #[tokio::test]
    async fn mysql_text_protocol_executes_stored_procedure_script() {
        let Ok(url) = std::env::var("DBSCOUT_TEST_MYSQL_URL") else {
            return;
        };
        let pool = connect_database(&url, None).await.unwrap();
        let database = format!("dbscout_sql_console_{}", Uuid::new_v4().simple());
        let create_database = format!("CREATE DATABASE `{database}`");
        (&pool)
            .execute(sqlx::raw_sql(&create_database))
            .await
            .unwrap();

        let mut connection = pool.acquire().await.unwrap();
        let use_database = format!("USE `{database}`");
        (&mut *connection)
            .execute(sqlx::raw_sql(&use_database))
            .await
            .unwrap();
        (&mut *connection)
            .execute(sqlx::raw_sql(
                "DROP PROCEDURE IF EXISTS dbscout_protocol_test",
            ))
            .await
            .unwrap();
        (&mut *connection)
            .execute(sqlx::raw_sql(
                "CREATE PROCEDURE dbscout_protocol_test() BEGIN SELECT 1; SELECT 2; END",
            ))
            .await
            .unwrap();

        let routine_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?",
        )
        .bind(&database)
        .bind("dbscout_protocol_test")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(routine_count, 1);

        (&mut *connection)
            .execute(sqlx::raw_sql("DROP PROCEDURE dbscout_protocol_test"))
            .await
            .unwrap();
        drop(connection);
        let drop_database = format!("DROP DATABASE `{database}`");
        (&pool)
            .execute(sqlx::raw_sql(&drop_database))
            .await
            .unwrap();
        pool.close().await;
    }

    #[tokio::test]
    async fn sql_file_can_be_reopened_by_path() {
        let path = std::env::temp_dir().join(format!("dbscout-sql-{}.sql", Uuid::new_v4()));
        tokio::fs::write(&path, "SELECT 42;").await.unwrap();
        let result = open_sql_file(Some(path.to_string_lossy().to_string()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.content, "SELECT 42;");
        assert!(result.file_name.ends_with(".sql"));
        let _ = tokio::fs::remove_file(path).await;
    }

    #[test]
    fn classification_protects_risky_and_unknown_statements() {
        assert_eq!(
            classify_statement("SELECT 1").category,
            StatementCategory::Read
        );
        assert!(classify_statement("UPDATE player SET level = 1").high_risk);
        assert!(!classify_statement("DELETE FROM player WHERE id = 1").high_risk);
        assert!(classify_statement("DROP TABLE player").high_risk);
        assert!(classify_statement("mystery command").high_risk);
        assert_eq!(
            classify_statement("WITH active AS (SELECT id FROM player) SELECT * FROM active")
                .category,
            StatementCategory::Read
        );
        let cte_delete = classify_statement(
            "WITH active AS (SELECT id FROM player WHERE level > 1) DELETE FROM player",
        );
        assert_eq!(cte_delete.keyword, "DELETE");
        assert_eq!(cte_delete.category, StatementCategory::Write);
        assert!(cte_delete.high_risk);
        assert!(
            classify_statement(
                "UPDATE player SET level = (SELECT MAX(level) FROM player WHERE id > 1)"
            )
            .high_risk
        );
    }

    #[test]
    fn limit_injection_does_not_touch_existing_limit_or_explain() {
        assert_eq!(
            mysql_limited_sql("SELECT * FROM player", 100),
            "SELECT * FROM player LIMIT 101"
        );
        assert_eq!(
            mysql_limited_sql("SELECT * FROM player LIMIT 5", 100),
            "SELECT * FROM player LIMIT 5"
        );
        assert_eq!(
            mysql_limited_sql("SELECT * FROM player LIMIT 5000", 100),
            "SELECT * FROM player LIMIT 101"
        );
        assert_eq!(
            mysql_limited_sql("SELECT * FROM player LIMIT 20, 5000", 100),
            "SELECT * FROM player LIMIT 20, 101"
        );
        assert_eq!(
            mysql_limited_sql("SELECT * FROM player LIMIT 5000 OFFSET 20", 100),
            "SELECT * FROM player LIMIT 101 OFFSET 20"
        );
        assert_eq!(
            mysql_limited_sql("EXPLAIN SELECT * FROM player", 100),
            "EXPLAIN SELECT * FROM player"
        );
        assert_eq!(
            mysql_limited_sql("SELECT *\nFROM player\nLIMIT 5", 100),
            "SELECT *\nFROM player\nLIMIT 5"
        );
        assert_eq!(
            mysql_limited_sql(
                "WITH recent AS (SELECT * FROM player LIMIT 5) SELECT * FROM recent",
                100,
            ),
            "WITH recent AS (SELECT * FROM player LIMIT 5) SELECT * FROM recent LIMIT 101"
        );
        assert_eq!(
            clickhouse_console_sql("SELECT format(value) FROM player", 100).unwrap(),
            "SELECT format(value) FROM player LIMIT 101 FORMAT JSON"
        );
        assert_eq!(
            clickhouse_read_query_sql("SELECT format(value) FROM player", 100).unwrap(),
            "SELECT format(value) FROM player LIMIT 100 FORMAT JSON"
        );
        assert_eq!(
            clickhouse_read_query_sql("SELECT * FROM player LIMIT 5000", 100).unwrap(),
            "SELECT * FROM player LIMIT 100 FORMAT JSON"
        );
    }

    #[test]
    fn request_caps_rows_and_timeout() {
        let mut request: StartSqlExecutionRequest = serde_json::from_value(json!({
            "connectionId": "demo", "database": "game_db", "queryTabId": "tab-1",
            "sql": "SELECT 1", "rowLimit": 999999, "timeoutSeconds": 0
        }))
        .unwrap();
        let connection = RuntimeConnection {
            id: "demo".into(),
            kind: DatabaseKind::MySql,
            label: "Demo".into(),
            host: "demo".into(),
            port: 3306,
            username: "root".into(),
            mysql_url: None,
            clickhouse_url: None,
            mongodb_url: None,
            database: Some("game_db".into()),
        };
        validate_request(&mut request, &connection).unwrap();
        assert_eq!(request.row_limit, 10_000);
        assert_eq!(request.timeout_seconds, 1);
        request.sql = "BEGIN".into();
        assert!(validate_request(&mut request, &connection)
            .unwrap_err()
            .contains("提交、回滚按钮"));
    }
}
