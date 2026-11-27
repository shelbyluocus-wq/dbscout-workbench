//! Opening, closing and registering runtime connections.
//!
//! A closed connection leaves `RuntimeState::connections` for
//! `closed_connections`: every command that resolves a connection treats it as
//! absent, so nothing reconnects behind the user's back, while its id and
//! address stay reserved. Ids are allocated from the number of known
//! connections, so keeping closed ones counted keeps the ids of the others
//! (and the aliases, order and groups keyed by them) stable.

use sqlx::MySqlPool;
use tauri::{AppHandle, Emitter, State};

use crate::clickhouse;
use crate::commands::{
    runtime_connection_matches_url, TableSessionsInvalidatedPayload,
    TABLE_SESSIONS_INVALIDATED_EVENT,
};
use crate::db::connect_database;
use crate::mongodb;
use crate::mysql_text;
use crate::runtime_resources::ServerPoolKey;
use crate::types::{AppState, DatabaseKind, RuntimeConnection, RuntimeState};

const MYSQL_SYSTEM_DATABASES: [&str; 4] =
    ["information_schema", "mysql", "performance_schema", "sys"];

fn kind_naming(kind: DatabaseKind) -> (&'static str, &'static str) {
    match kind {
        DatabaseKind::MySql => ("mysql", "MySQL"),
        DatabaseKind::ClickHouse => ("clickhouse", "ClickHouse"),
        DatabaseKind::MongoDb => ("mongodb", "MongoDB"),
    }
}

fn connection_url(connection: &RuntimeConnection) -> Option<&str> {
    match connection.kind {
        DatabaseKind::MySql => connection.mysql_url.as_deref(),
        DatabaseKind::ClickHouse => connection.clickhouse_url.as_deref(),
        DatabaseKind::MongoDb => connection.mongodb_url.as_deref(),
    }
}

fn id_taken(rt: &RuntimeState, id: &str) -> bool {
    rt.connections.contains_key(id) || rt.closed_connections.contains_key(id)
}

/// The number for a new connection id: one past every known connection, and
/// never one that is still in use (a connection removed from the middle
/// would otherwise hand its successor's id to the next new connection).
pub(crate) fn next_connection_number(rt: &RuntimeState, kind: DatabaseKind) -> usize {
    let (prefix, _) = kind_naming(kind);
    let mut number = rt.connections.len() + rt.closed_connections.len() + 1;
    while id_taken(rt, &format!("{prefix}-{number}")) {
        number += 1;
    }
    number
}

pub(crate) fn new_runtime_connection(
    kind: DatabaseKind,
    number: usize,
    url: String,
    host: String,
    port: u16,
    username: String,
) -> RuntimeConnection {
    let (prefix, label) = kind_naming(kind);
    RuntimeConnection {
        id: format!("{prefix}-{number}"),
        kind,
        label: format!("{label} {number}"),
        host,
        port,
        username,
        mysql_url: (kind == DatabaseKind::MySql).then(|| url.clone()),
        clickhouse_url: (kind == DatabaseKind::ClickHouse).then(|| url.clone()),
        mongodb_url: (kind == DatabaseKind::MongoDb).then_some(url),
        database: None,
    }
}

fn find_open_id(rt: &RuntimeState, kind: DatabaseKind, url: &str) -> Option<String> {
    rt.connections.iter().find_map(|(id, connection)| {
        runtime_connection_matches_url(connection, kind, url).then(|| id.clone())
    })
}

fn find_closed_id(rt: &RuntimeState, kind: DatabaseKind, url: &str) -> Option<String> {
    rt.closed_connections.iter().find_map(|(id, connection)| {
        runtime_connection_matches_url(connection, kind, url).then(|| id.clone())
    })
}

/// The id of a known connection to this address. A closed one is opened
/// again: callers only reuse an id after they connected to it successfully.
pub(crate) fn reuse_connection_id(
    rt: &mut RuntimeState,
    kind: DatabaseKind,
    url: &str,
) -> Option<String> {
    if let Some(id) = find_open_id(rt, kind, url) {
        return Some(id);
    }
    let id = find_closed_id(rt, kind, url)?;
    reopen_entry(rt, &id);
    Some(id)
}

fn reopen_entry(rt: &mut RuntimeState, connection_id: &str) -> bool {
    match rt.closed_connections.remove(connection_id) {
        Some(connection) => {
            rt.connections.insert(connection_id.to_string(), connection);
            true
        }
        None => rt.connections.contains_key(connection_id),
    }
}

/// When the selected connection leaves the open set, another open one (if
/// any) becomes the backend's default selection.
pub(crate) fn reselect_after_detach(rt: &mut RuntimeState, connection_id: &str) {
    if rt.selected_connection_id != connection_id {
        return;
    }
    let next_id = rt.connections.keys().next().cloned().unwrap_or_default();
    rt.selected_connection_id = next_id.clone();
    if let Some(next) = rt.connections.get(&next_id) {
        rt.selected_database = next.database.clone().unwrap_or_default();
    } else {
        rt.selected_database.clear();
        rt.schema.clear();
    }
}

/// Closes every pool, cache and session that belongs to the connection and
/// tells the windows that its table sessions are gone.
pub(crate) async fn release_connection_resources(
    app: &AppHandle,
    state: &State<'_, AppState>,
    connection_id: String,
    mongodb_url: Option<String>,
    reason: &str,
) {
    if let Some(url) = mongodb_url {
        mongodb::disconnect(&url).await;
    }
    state.schema_cache.invalidate_connection(&connection_id);
    state.table_counts.invalidate_connection(&connection_id);
    state
        .table_counts
        .close_connection_pools(&connection_id)
        .await;
    state.resources.close_connection(&connection_id).await;
    let _ = app.emit(
        TABLE_SESSIONS_INVALIDATED_EVENT,
        TableSessionsInvalidatedPayload {
            connection_id,
            session_ids: Vec::new(),
            reason: reason.into(),
        },
    );
}

/// Connects to a MySQL server and lists its user databases.
pub(crate) async fn connect_mysql_server(url: &str) -> Result<(MySqlPool, Vec<String>), String> {
    let pool = connect_database(url, None).await?;
    let rows = sqlx::query("SHOW DATABASES")
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("读取数据库列表失败: {error}"))?;
    let databases = rows
        .into_iter()
        .filter_map(|row| mysql_text::string(&row, 0).ok())
        .filter(|name| !MYSQL_SYSTEM_DATABASES.contains(&name.as_str()))
        .collect();
    Ok((pool, databases))
}

fn detach_for_close(
    rt: &mut RuntimeState,
    connection_id: &str,
) -> Result<Option<Option<String>>, String> {
    if rt.closed_connections.contains_key(connection_id) {
        return Ok(None);
    }
    let connection = rt
        .connections
        .get(connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
    if connection_url(connection).is_none() {
        return Err("演示连接无需关闭".into());
    }
    let connection = rt
        .connections
        .remove(connection_id)
        .expect("connection was just found");
    rt.sessions.invalidate_connection(connection_id);
    reselect_after_detach(rt, connection_id);
    let mongodb_url = connection.mongodb_url.clone();
    rt.closed_connections
        .insert(connection_id.to_string(), connection);
    Ok(Some(mongodb_url))
}

#[tauri::command]
pub async fn close_connection(
    connection_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let detached = {
        let mut rt = state.runtime.lock().await;
        detach_for_close(&mut rt, &connection_id)?
    };
    if let Some(mongodb_url) = detached {
        release_connection_resources(
            &app,
            &state,
            connection_id,
            mongodb_url,
            "connection-closed",
        )
        .await;
    }
    Ok(())
}

/// Connects a closed connection again under the same id and returns its
/// databases. An open connection is only listed.
#[tauri::command]
pub async fn open_connection(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let (kind, url) = {
        let rt = state.runtime.lock().await;
        let connection = rt
            .closed_connections
            .get(&connection_id)
            .or_else(|| rt.connections.get(&connection_id))
            .ok_or_else(|| "连接不存在".to_string())?;
        let url = connection_url(connection)
            .ok_or_else(|| "演示连接无需打开".to_string())?
            .to_string();
        (connection.kind, url)
    };
    let (pool, databases) = match kind {
        DatabaseKind::MySql => {
            let (pool, databases) = connect_mysql_server(&url).await?;
            (Some(pool), databases)
        }
        DatabaseKind::ClickHouse => (None, clickhouse::list_databases(&url).await?),
        DatabaseKind::MongoDb => (None, mongodb::list_databases(&url).await?),
    };
    {
        let mut rt = state.runtime.lock().await;
        if !reopen_entry(&mut rt, &connection_id) {
            return Err("连接不存在".into());
        }
    }
    if let Some(pool) = pool {
        state
            .resources
            .get_or_connect_server(ServerPoolKey::new(&connection_id), || async { Ok(pool) })
            .await?;
    }
    Ok(databases)
}

fn register_entry(
    rt: &mut RuntimeState,
    kind: DatabaseKind,
    url: String,
    host: String,
    port: u16,
    username: String,
) -> String {
    if let Some(id) = find_open_id(rt, kind, &url).or_else(|| find_closed_id(rt, kind, &url)) {
        return id;
    }
    let number = next_connection_number(rt, kind);
    let connection = new_runtime_connection(kind, number, url, host, port, username);
    let id = connection.id.clone();
    rt.closed_connections.insert(id.clone(), connection);
    id
}

/// Reserves an id for a saved connection the user left closed, without
/// touching the network, so the connections restored after it keep theirs.
#[tauri::command]
pub async fn register_connection(
    kind: Option<String>,
    url: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let kind = DatabaseKind::infer(kind.as_deref(), &url);
    let (host, port, username) = match kind {
        DatabaseKind::MySql => ("configured".to_string(), 3306, "mysql".to_string()),
        DatabaseKind::ClickHouse => clickhouse::describe_url(&url)?,
        DatabaseKind::MongoDb => mongodb::describe_url(&url)?,
    };
    let mut rt = state.runtime.lock().await;
    Ok(register_entry(&mut rt, kind, url, host, port, username))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::RuntimeOptions;

    fn runtime() -> RuntimeState {
        RuntimeState::new(None, RuntimeOptions::for_environment(false, None))
    }

    fn mysql(rt: &mut RuntimeState, url: &str) -> String {
        let number = next_connection_number(rt, DatabaseKind::MySql);
        let connection = new_runtime_connection(
            DatabaseKind::MySql,
            number,
            url.into(),
            "configured".into(),
            3306,
            "mysql".into(),
        );
        let id = connection.id.clone();
        rt.connections.insert(id.clone(), connection);
        id
    }

    #[test]
    fn closing_keeps_the_id_reserved_and_hides_the_connection() {
        let mut rt = runtime();
        let first = mysql(&mut rt, "mysql://a@1:3306");
        let second = mysql(&mut rt, "mysql://b@2:3306");
        rt.selected_connection_id = first.clone();

        assert_eq!(detach_for_close(&mut rt, &first), Ok(Some(None)));
        assert!(!rt.connections.contains_key(&first));
        assert!(rt.closed_connections.contains_key(&first));
        assert_eq!(rt.selected_connection_id, second);
        assert_eq!(detach_for_close(&mut rt, &first), Ok(None));

        let third = mysql(&mut rt, "mysql://c@3:3306");
        assert_eq!(third, "mysql-3");
    }

    #[test]
    fn new_ids_skip_ids_still_in_use_after_a_removal() {
        let mut rt = runtime();
        mysql(&mut rt, "mysql://a@1:3306");
        let second = mysql(&mut rt, "mysql://b@2:3306");
        mysql(&mut rt, "mysql://c@3:3306");
        rt.connections.remove(&second);

        let next = mysql(&mut rt, "mysql://d@4:3306");
        assert_eq!(next, "mysql-4");
        assert_eq!(rt.connections.len(), 3);
    }

    #[test]
    fn registering_reserves_ids_in_order_and_reuses_known_addresses() {
        let mut rt = runtime();
        let closed = register_entry(
            &mut rt,
            DatabaseKind::MySql,
            "mysql://a@1:3306".into(),
            "configured".into(),
            3306,
            "mysql".into(),
        );
        assert_eq!(closed, "mysql-1");
        assert!(rt.closed_connections.contains_key(&closed));
        assert_eq!(mysql(&mut rt, "mysql://b@2:3306"), "mysql-2");

        let again = register_entry(
            &mut rt,
            DatabaseKind::MySql,
            "mysql://a@1:3306".into(),
            "configured".into(),
            3306,
            "mysql".into(),
        );
        assert_eq!(again, closed);
        assert_eq!(rt.closed_connections.len(), 1);
    }

    #[test]
    fn reusing_a_closed_address_opens_it_under_its_id() {
        let mut rt = runtime();
        let id = mysql(&mut rt, "mysql://a@1:3306");
        detach_for_close(&mut rt, &id).unwrap();

        assert_eq!(
            reuse_connection_id(&mut rt, DatabaseKind::MySql, "mysql://a@1:3306"),
            Some(id.clone())
        );
        assert!(rt.connections.contains_key(&id));
        assert!(rt.closed_connections.is_empty());
        assert_eq!(
            reuse_connection_id(&mut rt, DatabaseKind::ClickHouse, "mysql://a@1:3306"),
            None
        );
    }

    #[test]
    fn sample_data_connections_cannot_be_closed() {
        let mut rt = RuntimeState::new(None, RuntimeOptions::for_environment(true, None));
        let id = rt.selected_connection_id.clone();
        assert!(detach_for_close(&mut rt, &id).is_err());
        assert!(rt.connections.contains_key(&id));
    }
}
