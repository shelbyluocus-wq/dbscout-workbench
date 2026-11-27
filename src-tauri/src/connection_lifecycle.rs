//! Opening, closing and registering runtime connections.
//!
//! A closed connection leaves `RuntimeState::connections` for
//! `closed_connections`: every command that resolves a connection treats it as
//! absent, so nothing reconnects behind the user's back, while its id and
//! address stay reserved. Ids are allocated from the number of known
//! connections, so keeping closed ones counted keeps the ids of the others
//! (and the aliases, order and groups keyed by them) stable.

use reqwest::Url;
use serde::Deserialize;
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

fn decode_percent_component(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &raw[index + 1..index + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| raw.to_string())
}

pub(crate) fn describe_mysql_url(raw: &str) -> (String, u16, String) {
    let Ok(url) = Url::parse(raw) else {
        return ("configured".to_string(), 3306, "mysql".to_string());
    };
    let host = url
        .host_str()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "configured".to_string());
    let port = url.port().unwrap_or(3306);
    let username = if url.username().is_empty() {
        "mysql".to_string()
    } else {
        decode_percent_component(url.username())
    };
    (host, port, username)
}

fn describe_connection_url(kind: DatabaseKind, url: &str) -> Result<(String, u16, String), String> {
    match kind {
        DatabaseKind::MySql => Ok(describe_mysql_url(url)),
        DatabaseKind::ClickHouse => clickhouse::describe_url(url),
        DatabaseKind::MongoDb => mongodb::describe_url(url),
    }
}

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
    rt.pending_connections.remove(connection_id);
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
    if let Some(pool) = pool {
        let mut installed = false;
        let pool_for_cleanup = pool.clone();
        let attach_result = state
            .resources
            .get_or_connect_server(ServerPoolKey::new(&connection_id), || async {
                installed = true;
                Ok(pool)
            })
            .await;
        if !installed {
            pool_for_cleanup.close().await;
        }
        attach_result?;
    }
    {
        let mut rt = state.runtime.lock().await;
        if !reopen_entry(&mut rt, &connection_id) {
            return Err("连接不存在".into());
        }
        rt.pending_connections.remove(&connection_id);
    }
    Ok(databases)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnectionSpec {
    pub kind: Option<String>,
    pub url: String,
    #[serde(default)]
    pub closed: bool,
}

fn register_saved_entry(
    rt: &mut RuntimeState,
    kind: DatabaseKind,
    url: String,
    host: String,
    port: u16,
    username: String,
    closed: bool,
) -> String {
    if let Some(id) = find_open_id(rt, kind, &url) {
        return id;
    }
    if let Some(id) = find_closed_id(rt, kind, &url) {
        if !closed {
            reopen_entry(rt, &id);
            rt.pending_connections.insert(id.clone());
        }
        return id;
    }
    let number = next_connection_number(rt, kind);
    let connection = new_runtime_connection(kind, number, url, host, port, username);
    let id = connection.id.clone();
    if closed {
        rt.closed_connections.insert(id.clone(), connection);
    } else {
        rt.connections.insert(id.clone(), connection);
        rt.pending_connections.insert(id.clone());
    }
    id
}

/// Reserves deterministic runtime ids for all saved connections in saved order
/// without touching the network. Closed entries stay in `closed_connections`;
/// open entries enter `connections` + `pending_connections` until connected.
#[tauri::command]
pub async fn register_saved_connections(
    entries: Vec<SavedConnectionSpec>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let mut rt = state.runtime.lock().await;
    let mut ids = Vec::with_capacity(entries.len());
    for entry in entries {
        let trimmed = entry.url.trim();
        if trimmed.is_empty() {
            ids.push(String::new());
            continue;
        }
        let kind = DatabaseKind::infer(entry.kind.as_deref(), trimmed);
        let Ok((host, port, username)) = describe_connection_url(kind, trimmed) else {
            ids.push(String::new());
            continue;
        };
        ids.push(register_saved_entry(
            &mut rt,
            kind,
            trimmed.to_string(),
            host,
            port,
            username,
            entry.closed,
        ));
    }
    Ok(ids)
}

/// Updates credentials/address of an existing runtime connection in place
/// without allocating a duplicate id. Tests the new credentials first so an
/// invalid password never disturbs the existing runtime entry.
#[tauri::command]
pub async fn update_connection_credentials(
    connection_id: String,
    kind: Option<String>,
    url: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let trimmed = url.trim().to_string();
    let kind = DatabaseKind::infer(kind.as_deref(), &trimmed);
    let (host, port, username) = describe_connection_url(kind, &trimmed)?;
    let (pool, databases) = match kind {
        DatabaseKind::MySql => {
            let (pool, databases) = connect_mysql_server(&trimmed).await?;
            (Some(pool), databases)
        }
        DatabaseKind::ClickHouse => (None, clickhouse::list_databases(&trimmed).await?),
        DatabaseKind::MongoDb => (None, mongodb::list_databases(&trimmed).await?),
    };

    let old_mongo_url = {
        let mut rt = state.runtime.lock().await;
        if let Some(closed) = rt.closed_connections.remove(&connection_id) {
            rt.connections.insert(connection_id.clone(), closed);
        }
        let Some(connection) = rt.connections.get_mut(&connection_id) else {
            if let Some(pool) = pool {
                pool.close().await;
            }
            return Err("连接不存在".into());
        };
        let previous_mongo = connection
            .mongodb_url
            .clone()
            .filter(|old| kind != DatabaseKind::MongoDb || old != &trimmed);
        connection.kind = kind;
        connection.host = host;
        connection.port = port;
        connection.username = username;
        connection.mysql_url = (kind == DatabaseKind::MySql).then(|| trimmed.clone());
        connection.clickhouse_url = (kind == DatabaseKind::ClickHouse).then(|| trimmed.clone());
        connection.mongodb_url = (kind == DatabaseKind::MongoDb).then(|| trimmed.clone());
        rt.pending_connections.insert(connection_id.clone());
        rt.sessions.invalidate_connection(&connection_id);
        previous_mongo
    };

    release_connection_resources(
        &app,
        &state,
        connection_id.clone(),
        old_mongo_url,
        "connection-reconnected",
    )
    .await;

    if let Some(pool) = pool {
        state
            .resources
            .get_or_connect_server(ServerPoolKey::new(&connection_id), || async { Ok(pool) })
            .await?;
    }

    {
        let mut rt = state.runtime.lock().await;
        rt.pending_connections.remove(&connection_id);
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
    let (host, port, username) = describe_connection_url(kind, &url)?;
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

    #[test]
    fn describe_mysql_url_extracts_real_host_port_and_username() {
        assert_eq!(
            describe_mysql_url("mysql://game_cn:secret@127.0.0.1:13306"),
            ("127.0.0.1".into(), 13306, "game_cn".into())
        );
        assert_eq!(
            describe_mysql_url("mysql://ops%40admin:secret@192.168.1.243"),
            ("192.168.1.243".into(), 3306, "ops@admin".into())
        );
        assert_eq!(
            describe_mysql_url("not-a-url"),
            ("configured".into(), 3306, "mysql".into())
        );
    }

    #[test]
    fn register_saved_entry_reserves_ids_in_order_and_tracks_pending_vs_closed() {
        let mut rt = runtime();
        let id1 = register_saved_entry(
            &mut rt,
            DatabaseKind::MySql,
            "mysql://root:a@10.0.0.1:3306".into(),
            "10.0.0.1".into(),
            3306,
            "root".into(),
            false,
        );
        let id2 = register_saved_entry(
            &mut rt,
            DatabaseKind::MongoDb,
            "mongodb://127.0.0.1:27117".into(),
            "127.0.0.1".into(),
            27117,
            "".into(),
            true,
        );
        let id3 = register_saved_entry(
            &mut rt,
            DatabaseKind::ClickHouse,
            "http://default:@127.0.0.1:18123".into(),
            "127.0.0.1".into(),
            18123,
            "default".into(),
            false,
        );
        assert_eq!(id1, "mysql-1");
        assert_eq!(id2, "mongodb-2");
        assert_eq!(id3, "clickhouse-3");
        assert!(rt.connections.contains_key(&id1));
        assert!(rt.pending_connections.contains(&id1));
        assert!(rt.closed_connections.contains_key(&id2));
        assert!(!rt.pending_connections.contains(&id2));
        assert!(rt.connections.contains_key(&id3));
        assert!(rt.pending_connections.contains(&id3));

        // Idempotent re-registration returns the exact same ids.
        let again1 = register_saved_entry(
            &mut rt,
            DatabaseKind::MySql,
            "mysql://root:a@10.0.0.1:3306".into(),
            "10.0.0.1".into(),
            3306,
            "root".into(),
            false,
        );
        assert_eq!(again1, id1);
        assert_eq!(rt.connections.len(), 2);
        assert_eq!(rt.closed_connections.len(), 1);
    }
}
