//! Paged audit navigation. Grouping happens in SQLite, never over a UI page.
use crate::{audit, types::AppState};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, State};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRequest {
    pub connection_id: Option<String>,
    pub database: Option<String>,
    pub table_name: Option<String>,
    pub search: Option<String>,
    pub offset: Option<u32>,
    pub audit_id: Option<i64>,
    pub token: Option<String>,
}
impl HistoryRequest {
    pub fn target(&self) -> Result<(&str, &str, &str), String> {
        match (&self.connection_id, &self.database, &self.table_name) {
            (Some(c), Some(d), Some(t)) if !c.is_empty() && !d.is_empty() && !t.is_empty() => {
                Ok((c, d, t))
            }
            _ => Err("请选择连接、数据库和表".into()),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub has_more: bool,
}
pub fn page<T>(mut items: Vec<T>) -> Page<T> {
    let has_more = items.len() > 50;
    items.truncate(50);
    Page { items, has_more }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableHistory {
    pub connection_id: String,
    pub database: String,
    pub table_name: String,
    pub latest_ts: String,
    pub entry_count: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: i64,
    pub last_id: i64,
    pub ts: String,
    pub source: String,
    pub legacy: bool,
    pub entry_count: i64,
    pub inserted: i64,
    pub updated: i64,
    pub deleted: i64,
    pub blocked: bool,
}
// Exact timestamp buckets for legacy rows are labelled historical records, NOT
// inferred imports. Restoration begins before the entire timestamp bucket.
pub const GROUP_KEY: &str = "COALESCE(operation_id, 'legacy:' || ts)";

pub async fn tables(pool: &SqlitePool, r: &HistoryRequest) -> Result<Page<TableHistory>, String> {
    let rows = sqlx::query("SELECT connection_id, database, table_name, MAX(ts) latest_ts, COUNT(*) entry_count FROM audit_log WHERE (? IS NULL OR connection_id = ?) AND (? IS NULL OR database = ?) AND (? IS NULL OR table_name = ?) AND (? = '' OR instr(lower(table_name || ' ' || database), lower(?)) > 0) GROUP BY connection_id, database, table_name ORDER BY latest_ts DESC, connection_id, database, table_name LIMIT 51 OFFSET ?")
        .bind(&r.connection_id).bind(&r.connection_id).bind(&r.database).bind(&r.database)
        .bind(&r.table_name).bind(&r.table_name).bind(r.search.as_deref().unwrap_or("")).bind(r.search.as_deref().unwrap_or(""))
        .bind(r.offset.unwrap_or(0) as i64).fetch_all(pool).await.map_err(|e| e.to_string())?;
    Ok(page(
        rows.iter()
            .map(|row| TableHistory {
                connection_id: row.get("connection_id"),
                database: row.get("database"),
                table_name: row.get("table_name"),
                latest_ts: row.get("latest_ts"),
                entry_count: row.get("entry_count"),
            })
            .collect(),
    ))
}
pub async fn operations(pool: &SqlitePool, r: &HistoryRequest) -> Result<Page<Operation>, String> {
    let (c, d, t) = r.target()?;
    let sql = format!("SELECT MIN(id) id, MAX(id) last_id, MAX(ts) ts, MIN(source) source, operation_id IS NULL legacy, COUNT(*) entry_count, SUM(operation='INSERT' AND status IN ('committed','rolled_back')) inserted, SUM(operation='UPDATE' AND status IN ('committed','rolled_back')) updated, SUM(operation='DELETE' AND status IN ('committed','rolled_back')) deleted, MAX(status NOT IN ('committed','rolled_back','aborted') OR (status != 'aborted' AND (rollback_strategy != 'auto' OR inverse_sql IS NULL))) blocked FROM audit_log WHERE connection_id=? AND database=? AND table_name=? GROUP BY {GROUP_KEY} ORDER BY MAX(id) DESC LIMIT 51 OFFSET ?");
    let rows = sqlx::query(&sql)
        .bind(c)
        .bind(d)
        .bind(t)
        .bind(r.offset.unwrap_or(0) as i64)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(page(
        rows.iter()
            .map(|row| Operation {
                id: row.get("id"),
                last_id: row.get("last_id"),
                ts: row.get("ts"),
                source: row.get("source"),
                legacy: row.get::<i64, _>("legacy") != 0,
                entry_count: row.get("entry_count"),
                inserted: row.get("inserted"),
                updated: row.get("updated"),
                deleted: row.get("deleted"),
                blocked: row.get::<i64, _>("blocked") != 0,
            })
            .collect(),
    ))
}
pub async fn details(
    pool: &SqlitePool,
    r: &HistoryRequest,
) -> Result<Page<crate::types::AuditLogEntry>, String> {
    let (c, d, t) = r.target()?;
    let sql = format!("SELECT * FROM audit_log WHERE connection_id=? AND database=? AND table_name=? AND {GROUP_KEY} = (SELECT {GROUP_KEY} FROM audit_log WHERE id=?) ORDER BY id DESC LIMIT 51 OFFSET ?");
    let rows = sqlx::query(&sql)
        .bind(c)
        .bind(d)
        .bind(t)
        .bind(r.audit_id)
        .bind(r.offset.unwrap_or(0) as i64)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(page(rows.iter().map(audit::audit_log_entry).collect()))
}
#[tauri::command]
pub async fn list_audit_tables(
    request: HistoryRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Page<TableHistory>, String> {
    tables(&audit::ensure_audit_pool(&app, &state).await?, &request).await
}
#[tauri::command]
pub async fn list_audit_operations(
    request: HistoryRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Page<Operation>, String> {
    operations(&audit::ensure_audit_pool(&app, &state).await?, &request).await
}
#[tauri::command]
pub async fn list_audit_operation_details(
    request: HistoryRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Page<crate::types::AuditLogEntry>, String> {
    details(&audit::ensure_audit_pool(&app, &state).await?, &request).await
}
