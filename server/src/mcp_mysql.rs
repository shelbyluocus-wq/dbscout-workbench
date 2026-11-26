//! Database tools for explicitly configured server-side MySQL connections.

use std::collections::BTreeMap;
use std::str::FromStr;
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{
    mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow},
    MySql, MySqlPool, QueryBuilder, Row, SqlitePool,
};
use uuid::Uuid;

use crate::db::{self, UserRow};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    pub id: String,
    pub name: String,
    url: String,
    pub database: String,
    tables: Vec<String>,
    #[serde(default)]
    pub writable: bool,
}

impl Connection {
    fn options(&self) -> Result<MySqlConnectOptions, String> {
        MySqlConnectOptions::from_str(&self.url)
            .map(|options| options.database(&self.database))
            .map_err(|_| "MySQL 连接配置无效".into())
    }

    pub fn valid(&self) -> bool {
        !self.id.trim().is_empty()
            && !self.name.trim().is_empty()
            && valid_identifier(&self.database)
            && !self.tables.is_empty()
            && self.tables.iter().all(|table| valid_identifier(table))
            && self.options().is_ok()
    }

    fn table_sql(&self, table: &str) -> Result<String, String> {
        if !self.tables.iter().any(|name| name == table) {
            return Err("该表未授权".into());
        }
        Ok(format!(
            "{}.{}",
            identifier(&self.database),
            identifier(table)
        ))
    }

    async fn pool(&self) -> Result<MySqlPool, String> {
        MySqlPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(self.options()?)
            .await
            .map_err(|_| format!("无法连接 MySQL 数据库 {}", self.id))
    }

    fn server_key(&self) -> Result<String, String> {
        let options = self.options()?;
        let host = options.get_host();
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host.to_ascii_lowercase()
        };
        Ok(format!("mysql://{host}:{}", options.get_port()))
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= 64 && !value.chars().any(char::is_control)
}

fn identifier(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct Column {
    name: String,
    column_type: String,
    data_type: String,
    nullable: String,
    column_key: String,
    extra: String,
}

impl Column {
    fn text_sql(&self) -> String {
        let name = identifier(&self.name);
        match self.data_type.as_str() {
            "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" | "bit"
            | "geometry" | "point" | "linestring" | "polygon" | "multipoint"
            | "multilinestring" | "multipolygon" | "geometrycollection" => {
                format!("CAST(HEX({name}) AS CHAR CHARACTER SET utf8mb4)")
            }
            _ => format!("CAST({name} AS CHAR CHARACTER SET utf8mb4)"),
        }
    }

    fn writable(&self) -> bool {
        !self.extra.contains("VIRTUAL GENERATED")
            && !self.extra.contains("STORED GENERATED")
            && matches!(
                self.data_type.as_str(),
                "char"
                    | "varchar"
                    | "tinytext"
                    | "text"
                    | "mediumtext"
                    | "longtext"
                    | "tinyint"
                    | "smallint"
                    | "mediumint"
                    | "int"
                    | "bigint"
                    | "decimal"
                    | "float"
                    | "double"
                    | "date"
                    | "datetime"
                    | "timestamp"
                    | "time"
                    | "year"
                    | "enum"
                    | "set"
            )
    }
}

async fn columns(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<Column>, String> {
    let columns = sqlx::query_as::<_, Column>(
        "SELECT CAST(c.COLUMN_NAME AS CHAR CHARACTER SET utf8mb4) AS name, \
                CAST(c.COLUMN_TYPE AS CHAR CHARACTER SET utf8mb4) AS column_type, \
                CAST(c.DATA_TYPE AS CHAR CHARACTER SET utf8mb4) AS data_type, \
                CAST(c.IS_NULLABLE AS CHAR CHARACTER SET utf8mb4) AS nullable, \
                CAST(IF(pk.COLUMN_NAME IS NULL, '', 'PRI') AS CHAR CHARACTER SET utf8mb4) AS column_key, \
                CAST(c.EXTRA AS CHAR CHARACTER SET utf8mb4) AS extra \
         FROM information_schema.COLUMNS c \
         LEFT JOIN information_schema.KEY_COLUMN_USAGE pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA \
             AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME AND pk.CONSTRAINT_NAME = 'PRIMARY' \
         WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION",
    )
    .bind(database)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|error| {
        tracing::warn!(%error, "读取 MCP 表结构失败");
        "读取表结构失败"
    })?;
    if columns.is_empty() {
        return Err("表不存在，或 MySQL 账号无读取权限".into());
    }
    Ok(columns)
}

fn primary_keys(columns: &[Column]) -> Vec<&Column> {
    columns
        .iter()
        .filter(|column| column.column_key == "PRI")
        .collect()
}

pub async fn list_tables(connection: &Connection) -> Result<Value, String> {
    let pool = connection.pool().await?;
    let tables = sqlx::query_scalar::<_, String>(
        "SELECT CAST(TABLE_NAME AS CHAR CHARACTER SET utf8mb4) \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
    )
    .bind(&connection.database)
    .fetch_all(&pool)
    .await
    .map_err(|error| {
        tracing::warn!(%error, "读取 MCP 表列表失败");
        "读取表列表失败"
    })?;
    Ok(json!({"database":connection.database,
        "tables":tables.into_iter().filter(|table| connection.tables.contains(table)).collect::<Vec<_>>()
    }))
}

pub async fn describe_table(connection: &Connection, table: &str) -> Result<Value, String> {
    connection.table_sql(table)?;
    let pool = connection.pool().await?;
    let columns = columns(&pool, &connection.database, table).await?;
    let primary_keys: Vec<_> = primary_keys(&columns)
        .into_iter()
        .map(|column| &column.name)
        .collect();
    Ok(
        json!({"database":connection.database,"table":table,"columns":columns,"primaryKey":primary_keys}),
    )
}

fn row_text(row: &MySqlRow, index: usize) -> Result<Option<String>, String> {
    row.try_get(index).map_err(|_| "读取字段值失败".into())
}

pub async fn read_table_page(
    connection: &Connection,
    table: &str,
    offset: u32,
    limit: u32,
) -> Result<Value, String> {
    if limit == 0 || limit > 100 || offset > 1_000_000 {
        return Err("limit 必须为 1–100，offset 不能超过 1000000".into());
    }
    let table_sql = connection.table_sql(table)?;
    let pool = connection.pool().await?;
    let columns = columns(&pool, &connection.database, table).await?;
    let keys = primary_keys(&columns);
    let projection = columns
        .iter()
        .map(|column| format!("LEFT({}, 4096)", column.text_sql()))
        .collect::<Vec<_>>()
        .join(", ");
    let mut sql = format!("SELECT {projection} FROM {table_sql}");
    if !keys.is_empty() {
        let order = keys
            .iter()
            .map(|column| identifier(&column.name))
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" ORDER BY {order}"));
    }
    sql.push_str(" LIMIT ? OFFSET ?");
    let page_size = limit.min((8 * 1024 * 1024 / (columns.len() * 4096 * 4)).max(1) as u32);
    let rows = sqlx::query(&sql)
        .bind(page_size + 1)
        .bind(offset)
        .fetch_all(&pool)
        .await
        .map_err(|_| "读取表数据失败")?;
    let has_more = rows.len() > page_size as usize;
    let mut records = Vec::new();
    for row in rows.iter().take(page_size as usize) {
        let values = columns
            .iter()
            .enumerate()
            .map(|(i, column)| Ok((column.name.clone(), row_text(row, i)?)))
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        records.push(values);
    }
    Ok(
        json!({"database":connection.database,"table":table,"rows":records,
        "stableOrder":!keys.is_empty(),"hasMore":has_more,
        "nextOffset":has_more.then_some(offset + records.len() as u32)}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    connection_id: String,
    table: String,
    primary_key: BTreeMap<String, String>,
    column: String,
    expected_value: Value,
    new_value: Value,
    confirmed: bool,
    request_id: Uuid,
}

pub struct AuditContext<'a> {
    pub pool: &'a SqlitePool,
    pub user: &'a UserRow,
    pub svn_username: &'a str,
    pub max_revisions_per_table: usize,
}

fn scalar(value: &Value) -> Result<Option<&str>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(value) if value.chars().count() <= 4096 => Ok(Some(value)),
        _ => Err("旧值和新值必须为 null 或最多 4096 字符的字符串".into()),
    }
}

fn push_primary_key<'a>(
    query: &mut QueryBuilder<'a, MySql>,
    keys: &[&Column],
    values: &'a BTreeMap<String, String>,
) {
    let mut predicates = query.separated(" AND ");
    for key in keys {
        predicates
            .push(format!("{} = ", identifier(&key.name)))
            .push_bind_unseparated(&values[&key.name]);
    }
}

pub async fn update_cell(
    connection: &Connection,
    edit: Edit,
    audit: AuditContext<'_>,
) -> Result<Value, String> {
    if !edit.confirmed || edit.connection_id != connection.id {
        return Err("参数未包含对该目标写入的确认".into());
    }
    let expected = scalar(&edit.expected_value)?;
    let proposed = scalar(&edit.new_value)?;
    let table_sql = connection.table_sql(&edit.table)?;
    let server_key = connection.server_key()?;
    let audit_id = format!("mcp:{}:{}", audit.user.id, edit.request_id);
    let previous =
        sqlx::query_scalar::<_, String>("SELECT status FROM mcp_write_receipts WHERE audit_id = ?")
            .bind(&audit_id)
            .fetch_optional(audit.pool)
            .await
            .map_err(|_| "无法核对请求的审计状态")?;
    if let Some(status) = previous {
        return Ok(json!({"auditId":audit_id,"status":status,"duplicate":true}));
    }

    let pool = connection.pool().await?;
    let engine = sqlx::query_scalar::<_, Option<String>>(
        "SELECT CAST(ENGINE AS CHAR CHARACTER SET utf8mb4) \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    )
    .bind(&connection.database)
    .bind(&edit.table)
    .fetch_optional(&pool)
    .await
    .map_err(|_| "无法核对表的存储引擎")?
    .flatten();
    if !engine.is_some_and(|engine| engine.eq_ignore_ascii_case("InnoDB")) {
        return Err("仅支持修改 InnoDB 表".into());
    }
    let columns = columns(&pool, &connection.database, &edit.table).await?;
    let keys = primary_keys(&columns);
    if keys.is_empty()
        || keys.len() != edit.primary_key.len()
        || keys
            .iter()
            .any(|key| !edit.primary_key.contains_key(&key.name))
    {
        return Err("必须提供完整且准确的主键字段".into());
    }
    let column = columns
        .iter()
        .find(|column| column.name == edit.column && column.column_key != "PRI")
        .filter(|column| column.writable())
        .ok_or("该字段不存在、是主键或类型不支持修改")?;
    let key_projection = keys
        .iter()
        .map(|key| key.text_sql())
        .collect::<Vec<_>>()
        .join(", ");
    let mut select = QueryBuilder::new(format!(
        "SELECT {}, {key_projection} FROM {table_sql} WHERE ",
        column.text_sql()
    ));
    push_primary_key(&mut select, &keys, &edit.primary_key);
    select.push(" FOR UPDATE");
    let mut tx = pool.begin().await.map_err(|_| "开启 MySQL 事务失败")?;
    let before = select
        .build()
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| "读取待修改记录失败")?
        .ok_or("主键对应的记录不存在")?;
    for (index, key) in keys.iter().enumerate() {
        if row_text(&before, index + 1)?.as_deref() != Some(edit.primary_key[&key.name].as_str()) {
            return Err("返回的主键值与请求不一致".into());
        }
    }
    let actual = row_text(&before, 0)?;
    if actual.as_deref() != expected {
        return Err("实际值已变化，请重新读取并确认".into());
    }
    if actual.as_deref() == proposed {
        return Ok(json!({"changed":false}));
    }

    let mut update = QueryBuilder::new(format!(
        "UPDATE {table_sql} SET {} = ",
        identifier(&column.name)
    ));
    update.push_bind(proposed).push(" WHERE ");
    push_primary_key(&mut update, &keys, &edit.primary_key);
    let written = update
        .build()
        .execute(&mut *tx)
        .await
        .map_err(|_| "MySQL 拒绝更新")?;
    if written.rows_affected() != 1 {
        return Err("受影响的行数异常，已终止写入".into());
    }
    select.reset();
    push_primary_key(&mut select, &keys, &edit.primary_key);
    select.push(" FOR UPDATE");
    let after = select
        .build()
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| "写入后的值校验失败")?;
    if row_text(&after, 0)?.as_deref() != proposed {
        return Err("MySQL 转换后的值与拟写入值不一致，已终止写入".into());
    }

    // Save the intent before committing MySQL so a disconnected client can
    // inspect an uncertain result without repeating the same write.
    let timestamp = Utc::now().to_rfc3339();
    let mut audit_tx = audit.pool.begin().await.map_err(|_| "无法开启审计事务")?;
    sqlx::query("INSERT INTO mcp_write_receipts (audit_id, status) VALUES (?, 'mcp_pending')")
        .bind(&audit_id)
        .execute(&mut *audit_tx)
        .await
        .map_err(|_| "无法登记写入请求或 requestId 已存在，已终止提交")?;
    sqlx::query(
        "INSERT INTO audit_log (client_id, ts, user_id, username, connection_id, database, \
         table_name, operation, row_identity, column_name, old_value, new_value, source, status, \
         synced_at, server_key, svn_username) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'UPDATE', ?, ?, ?, ?, 'agent', 'mcp_pending', ?, ?, ?)",
    )
    .bind(&audit_id)
    .bind(&timestamp)
    .bind(&audit.user.id)
    .bind(&audit.user.username)
    .bind(&connection.id)
    .bind(&connection.database)
    .bind(&edit.table)
    .bind(json!(edit.primary_key).to_string())
    .bind(&edit.column)
    .bind(expected)
    .bind(proposed)
    .bind(&timestamp)
    .bind(&server_key)
    .bind(audit.svn_username)
    .execute(&mut *audit_tx)
    .await
    .map_err(|_| "无法保存审计记录或 requestId 已登记，已终止提交")?;
    audit_tx
        .commit()
        .await
        .map_err(|_| "无法提交审计事务，已终止 MySQL 写入")?;
    tx.commit()
        .await
        .map_err(|_| format!("提交结果待核对。审计 ID {audit_id}，请读取当前值后处理。"))?;
    let marked = mark_committed(audit.pool, &audit_id).await.is_ok();
    if marked {
        let _ = db::prune_table_revisions(
            audit.pool,
            &server_key,
            &connection.database.to_ascii_lowercase(),
            &edit.table.to_ascii_lowercase(),
            audit.max_revisions_per_table,
        )
        .await;
    }
    Ok(
        json!({"changed":true,"auditId":audit_id,"auditStatus":if marked {"committed"} else {"mcp_pending"}}),
    )
}

async fn mark_committed(pool: &SqlitePool, audit_id: &str) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE mcp_write_receipts SET status = 'committed' WHERE audit_id = ?")
        .bind(audit_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE audit_log SET status = 'committed' WHERE client_id = ?")
        .bind(audit_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}
