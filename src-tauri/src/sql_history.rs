use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, SqlitePool,
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::types::AppState;

pub struct SqlHistoryState {
    pool: Mutex<Option<SqlitePool>>,
}

impl Default for SqlHistoryState {
    fn default() -> Self {
        Self {
            pool: Mutex::new(None),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListSqlHistoryRequest {
    pub connection_id: Option<String>,
    pub query: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlHistoryEntry {
    pub id: i64,
    pub connection_id: String,
    pub database: String,
    pub sql: String,
    pub status: String,
    pub duration_ms: u64,
    pub affected_rows: u64,
    pub executed_at: String,
    pub favorite: bool,
    pub name: Option<String>,
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("创建应用数据目录失败: {error}"))?;
    Ok(directory.join("sql-history.sqlite"))
}

async fn ensure_pool(app: &AppHandle, state: &AppState) -> Result<SqlitePool, String> {
    {
        let guard = state.sql_history.pool.lock().await;
        if let Some(pool) = guard.as_ref() {
            return Ok(pool.clone());
        }
    }
    let options = SqliteConnectOptions::new()
        .filename(history_path(app)?)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(options)
        .await
        .map_err(|error| format!("打开 SQL 历史数据库失败: {error}"))?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sql_history (\
            id INTEGER PRIMARY KEY AUTOINCREMENT,\
            connection_id TEXT NOT NULL,\
            database_name TEXT NOT NULL,\
            sql_text TEXT NOT NULL,\
            status TEXT NOT NULL,\
            duration_ms INTEGER NOT NULL DEFAULT 0,\
            affected_rows INTEGER NOT NULL DEFAULT 0,\
            executed_at TEXT NOT NULL,\
            favorite INTEGER NOT NULL DEFAULT 0,\
            name TEXT\
        )",
    )
    .execute(&pool)
    .await
    .map_err(|error| format!("创建 SQL 历史表失败: {error}"))?;
    for statement in [
        "CREATE INDEX IF NOT EXISTS ix_sql_history_connection_time ON sql_history(connection_id, executed_at DESC)",
        "CREATE INDEX IF NOT EXISTS ix_sql_history_favorite ON sql_history(favorite, executed_at DESC)",
    ] {
        sqlx::query(statement).execute(&pool).await.map_err(|error| format!("创建 SQL 历史索引失败: {error}"))?;
    }
    let mut guard = state.sql_history.pool.lock().await;
    if let Some(existing) = guard.as_ref() {
        pool.close().await;
        return Ok(existing.clone());
    }
    *guard = Some(pool.clone());
    Ok(pool)
}

pub async fn record(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    status: &str,
    duration_ms: u64,
    affected_rows: u64,
) -> Result<(), String> {
    let pool = ensure_pool(app, state).await?;
    sqlx::query(
        "INSERT INTO sql_history (connection_id, database_name, sql_text, status, duration_ms, affected_rows, executed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(connection_id).bind(database).bind(sql).bind(status)
    .bind(duration_ms as i64).bind(affected_rows as i64).bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool).await.map_err(|error| format!("保存 SQL 历史失败: {error}"))?;
    sqlx::query(
        "DELETE FROM sql_history WHERE connection_id = ? AND favorite = 0 AND id NOT IN (\
            SELECT id FROM sql_history WHERE connection_id = ? AND favorite = 0 ORDER BY executed_at DESC LIMIT 500\
        )",
    ).bind(connection_id).bind(connection_id).execute(&pool).await
        .map_err(|error| format!("清理 SQL 历史失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn list_sql_history(
    app: AppHandle,
    request: ListSqlHistoryRequest,
    state: State<'_, AppState>,
) -> Result<Vec<SqlHistoryEntry>, String> {
    let pool = ensure_pool(&app, &state).await?;
    let connection = request.connection_id.unwrap_or_default();
    let search = request.query.unwrap_or_default();
    let pattern = format!("%{}%", search);
    let limit = request.limit.unwrap_or(500).clamp(1, 1000) as i64;
    let rows = sqlx::query(
        "SELECT id, connection_id, database_name, sql_text, status, duration_ms, affected_rows, executed_at, favorite, name \
         FROM sql_history WHERE (? = '' OR connection_id = ?) AND (? = '' OR sql_text LIKE ? OR database_name LIKE ? OR COALESCE(name, '') LIKE ?) \
         ORDER BY favorite DESC, executed_at DESC LIMIT ?",
    )
    .bind(&connection).bind(&connection).bind(&search).bind(&pattern).bind(&pattern).bind(&pattern).bind(limit)
    .fetch_all(&pool).await.map_err(|error| format!("读取 SQL 历史失败: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|row| SqlHistoryEntry {
            id: row.try_get("id").unwrap_or_default(),
            connection_id: row.try_get("connection_id").unwrap_or_default(),
            database: row.try_get("database_name").unwrap_or_default(),
            sql: row.try_get("sql_text").unwrap_or_default(),
            status: row.try_get("status").unwrap_or_default(),
            duration_ms: row
                .try_get::<i64, _>("duration_ms")
                .unwrap_or_default()
                .max(0) as u64,
            affected_rows: row
                .try_get::<i64, _>("affected_rows")
                .unwrap_or_default()
                .max(0) as u64,
            executed_at: row.try_get("executed_at").unwrap_or_default(),
            favorite: row.try_get::<i64, _>("favorite").unwrap_or_default() != 0,
            name: row.try_get("name").ok(),
        })
        .collect())
}

#[tauri::command]
pub async fn save_sql_favorite(
    app: AppHandle,
    id: i64,
    favorite: bool,
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let pool = ensure_pool(&app, &state).await?;
    let name = normalize_favorite_name(name, favorite);
    sqlx::query("UPDATE sql_history SET favorite = ?, name = ? WHERE id = ?")
        .bind(if favorite { 1 } else { 0 })
        .bind(name)
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|error| format!("更新 SQL 收藏失败: {error}"))?;
    Ok(())
}

fn normalize_favorite_name(name: Option<String>, favorite: bool) -> Option<String> {
    if !favorite {
        return None;
    }
    let name = name
        .unwrap_or_default()
        .trim()
        .chars()
        .take(80)
        .collect::<String>();
    (!name.is_empty()).then_some(name)
}

#[tauri::command]
pub async fn delete_sql_history(
    app: AppHandle,
    id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let pool = ensure_pool(&app, &state).await?;
    sqlx::query("DELETE FROM sql_history WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|error| format!("删除 SQL 历史失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn clear_sql_history(
    app: AppHandle,
    connection_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let pool = ensure_pool(&app, &state).await?;
    let result = if let Some(connection_id) = connection_id.filter(|value| !value.is_empty()) {
        sqlx::query("DELETE FROM sql_history WHERE favorite = 0 AND connection_id = ?")
            .bind(connection_id)
            .execute(&pool)
            .await
    } else {
        sqlx::query("DELETE FROM sql_history WHERE favorite = 0")
            .execute(&pool)
            .await
    }
    .map_err(|error| format!("清空 SQL 历史失败: {error}"))?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_request_deserializes_frontend_shape() {
        let request: ListSqlHistoryRequest = serde_json::from_value(serde_json::json!({
            "connectionId": "mysql-1", "query": "select", "limit": 100
        }))
        .unwrap();
        assert_eq!(request.connection_id.as_deref(), Some("mysql-1"));
        assert_eq!(request.limit, Some(100));
    }

    #[test]
    fn favorite_names_are_trimmed_bounded_and_removed_with_the_favorite() {
        assert_eq!(
            normalize_favorite_name(Some("  常用查询  ".into()), true).as_deref(),
            Some("常用查询")
        );
        assert_eq!(
            normalize_favorite_name(Some("x".repeat(90)), true)
                .unwrap()
                .chars()
                .count(),
            80
        );
        assert_eq!(
            normalize_favorite_name(Some("常用查询".into()), false),
            None
        );
    }
}
