use std::collections::HashSet;

use futures_util::TryStreamExt;
use sqlx::{Connection, MySql, MySqlConnection, MySqlPool, QueryBuilder, Row};

use crate::db::escape_ident;
use crate::mysql_text;
use crate::sync;
use crate::types::{CopyTablesRequest, CopyTablesResponse, CopyTablesResult};

const COPY_BATCH_ROWS: usize = 128;
const COPY_BATCH_BYTES: usize = 4 * 1024 * 1024;
const MYSQL_BIND_LIMIT: usize = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransferKind {
    Text,
    Binary,
    Geometry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TransferColumn {
    name: String,
    kind: TransferKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TransferCell {
    Null,
    Text(Vec<u8>),
    Binary(Vec<u8>),
    Geometry { wkb: Vec<u8>, srid: u32 },
}

impl TransferCell {
    fn byte_len(&self) -> usize {
        match self {
            Self::Null => 0,
            Self::Text(value) | Self::Binary(value) => value.len(),
            Self::Geometry { wkb, .. } => wkb.len(),
        }
    }
}

pub async fn copy_tables_same_server(
    pool: &MySqlPool,
    request: &CopyTablesRequest,
) -> Result<CopyTablesResponse, String> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| format!("获取 MySQL 连接失败: {error}"))?;
    let original_time_zone = read_session_time_zone(&mut connection).await?;
    set_session_time_zone(&mut connection, "+00:00").await?;
    let result = copy_tables_same_server_with_connection(&mut connection, request).await;
    let restore = set_session_time_zone(&mut connection, &original_time_zone).await;
    finish_with_session_restores(result, [("MySQL", restore)])
}

async fn copy_tables_same_server_with_connection(
    connection: &mut MySqlConnection,
    request: &CopyTablesRequest,
) -> Result<CopyTablesResponse, String> {
    let mut existing = load_target_table_names(connection, &request.target_database).await?;
    let mut copied = Vec::new();

    for table_name in &request.table_names {
        let ddl = sync::show_create_table(connection, &request.source_database, table_name).await?;
        let target_name = resolve_copy_table_name(&existing, table_name);
        let rewritten = sync::rewrite_create_table_for_database(
            &ddl,
            &request.source_database,
            &request.target_database,
            &target_name,
        )?;
        sqlx::query(&rewritten)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("创建目标表 {target_name} 失败: {error}"))?;

        let copy_result = copy_same_server_table_rows(
            connection,
            &request.source_database,
            table_name,
            &request.target_database,
            &target_name,
        )
        .await;
        let row_count = match copy_result {
            Ok(row_count) => row_count,
            Err(error) => {
                return Err(clean_up_failed_table(
                    connection,
                    &request.target_database,
                    &target_name,
                    error,
                )
                .await);
            }
        };

        copied.push(CopyTablesResult {
            original_name: table_name.clone(),
            target_name: target_name.clone(),
            row_count,
        });
        existing.insert(target_name.to_lowercase());
    }

    Ok(CopyTablesResponse {
        status: "succeeded".into(),
        copied,
        warnings: Vec::new(),
    })
}

pub async fn copy_tables_cross_server(
    source_pool: &MySqlPool,
    target_pool: &MySqlPool,
    request: &CopyTablesRequest,
) -> Result<CopyTablesResponse, String> {
    let mut source = source_pool
        .acquire()
        .await
        .map_err(|error| format!("获取源 MySQL 连接失败: {error}"))?;
    let mut target = target_pool
        .acquire()
        .await
        .map_err(|error| format!("获取目标 MySQL 连接失败: {error}"))?;
    let source_time_zone = read_session_time_zone(&mut source).await?;
    let target_time_zone = read_session_time_zone(&mut target).await?;
    set_session_time_zone(&mut source, "+00:00").await?;
    if let Err(error) = set_session_time_zone(&mut target, "+00:00").await {
        let restore = set_session_time_zone(&mut source, &source_time_zone).await;
        return finish_with_session_restores(Err(error), [("源 MySQL", restore)]);
    }

    let result = copy_tables_cross_server_with_connections(&mut source, &mut target, request).await;
    let source_restore = set_session_time_zone(&mut source, &source_time_zone).await;
    let target_restore = set_session_time_zone(&mut target, &target_time_zone).await;
    finish_with_session_restores(
        result,
        [("源 MySQL", source_restore), ("目标 MySQL", target_restore)],
    )
}

async fn copy_tables_cross_server_with_connections(
    source: &mut MySqlConnection,
    target: &mut MySqlConnection,
    request: &CopyTablesRequest,
) -> Result<CopyTablesResponse, String> {
    let mut existing = load_target_table_names(target, &request.target_database).await?;
    let mut copied = Vec::new();

    for table_name in &request.table_names {
        let ddl = sync::show_create_table(source, &request.source_database, table_name).await?;
        let target_name = resolve_copy_table_name(&existing, table_name);
        let rewritten = sync::rewrite_create_table_for_database(
            &ddl,
            &request.source_database,
            &request.target_database,
            &target_name,
        )?;
        sqlx::query(&rewritten)
            .execute(&mut *target)
            .await
            .map_err(|error| format!("创建目标表 {target_name} 失败: {error}"))?;

        let copy_result = copy_cross_server_table_rows(
            source,
            target,
            &request.source_database,
            table_name,
            &request.target_database,
            &target_name,
        )
        .await;
        let row_count = match copy_result {
            Ok(row_count) => row_count,
            Err(error) => {
                return Err(clean_up_failed_table(
                    target,
                    &request.target_database,
                    &target_name,
                    error,
                )
                .await);
            }
        };

        copied.push(CopyTablesResult {
            original_name: table_name.clone(),
            target_name: target_name.clone(),
            row_count,
        });
        existing.insert(target_name.to_lowercase());
    }

    Ok(CopyTablesResponse {
        status: "succeeded".into(),
        copied,
        warnings: Vec::new(),
    })
}

async fn read_session_time_zone(connection: &mut MySqlConnection) -> Result<String, String> {
    let row = sqlx::query("SELECT @@SESSION.time_zone AS time_zone")
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("读取 MySQL 复制会话时区失败: {error}"))?;
    mysql_text::string(&row, "time_zone")
        .map_err(|error| format!("解析 MySQL 复制会话时区失败: {error}"))
}

async fn set_session_time_zone(
    connection: &mut MySqlConnection,
    time_zone: &str,
) -> Result<(), String> {
    sqlx::query("SET SESSION time_zone = ?")
        .bind(time_zone)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("设置 MySQL 复制会话时区 {time_zone} 失败: {error}"))?;
    Ok(())
}

fn finish_with_session_restores<const N: usize>(
    result: Result<CopyTablesResponse, String>,
    restores: [(&str, Result<(), String>); N],
) -> Result<CopyTablesResponse, String> {
    let restore_errors = restores
        .into_iter()
        .filter_map(|(label, restore)| {
            restore
                .err()
                .map(|error| format!("恢复{label} 会话失败: {error}"))
        })
        .collect::<Vec<_>>();
    match result {
        Ok(mut response) => {
            response.warnings.extend(restore_errors);
            Ok(response)
        }
        Err(error) if restore_errors.is_empty() => Err(error),
        Err(error) => Err(format!("{error}；{}", restore_errors.join("；"))),
    }
}

async fn load_target_table_names(
    connection: &mut MySqlConnection,
    target_database: &str,
) -> Result<HashSet<String>, String> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
    )
    .bind(target_database)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("读取目标库表列表失败: {error}"))?;
    Ok(rows
        .iter()
        .filter_map(|row| mysql_text::string(row, "TABLE_NAME").ok())
        .map(|name| name.to_lowercase())
        .collect())
}

fn resolve_copy_table_name(existing: &HashSet<String>, base_name: &str) -> String {
    if !existing.contains(&base_name.to_lowercase()) {
        return base_name.to_string();
    }
    let mut suffix = 1_u32;
    loop {
        let candidate = format!("{base_name}_copy{suffix}");
        if !existing.contains(&candidate.to_lowercase()) {
            return candidate;
        }
        suffix = suffix.saturating_add(1);
    }
}

async fn copy_same_server_table_rows(
    connection: &mut MySqlConnection,
    source_database: &str,
    source_table: &str,
    target_database: &str,
    target_table: &str,
) -> Result<u64, String> {
    let columns = sync::list_columns(connection, source_database, source_table).await?;
    let insertable = sync::insertable_columns(&columns);
    if insertable.is_empty() {
        let count = count_rows(connection, source_database, source_table).await?;
        insert_default_rows(connection, target_database, target_table, count).await?;
        return verify_target_row_count(connection, target_database, target_table, count).await;
    }

    let column_sql = insertable
        .iter()
        .map(|column| format!("`{}`", escape_ident(column)))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO `{}`.`{}` ({column_sql}) SELECT {column_sql} FROM `{}`.`{}`",
        escape_ident(target_database),
        escape_ident(target_table),
        escape_ident(source_database),
        escape_ident(source_table),
    );
    let result = sqlx::query(&sql)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("复制表 {source_table} 数据失败: {error}"))?;
    let row_count = result.rows_affected();
    verify_target_row_count(connection, target_database, target_table, row_count).await
}

async fn copy_cross_server_table_rows(
    source: &mut MySqlConnection,
    target: &mut MySqlConnection,
    source_database: &str,
    source_table: &str,
    target_database: &str,
    target_table: &str,
) -> Result<u64, String> {
    let metadata = sync::list_columns(source, source_database, source_table).await?;
    let insertable = sync::insertable_columns(&metadata);
    let columns = insertable
        .iter()
        .filter_map(|name| {
            metadata
                .iter()
                .find(|column| column.name == *name)
                .map(|column| TransferColumn {
                    name: name.clone(),
                    kind: transfer_kind(&column.data_type),
                })
        })
        .collect::<Vec<_>>();
    let select_sql = build_source_select_sql(source_database, source_table, &columns);
    let batch_row_limit = copy_batch_row_limit(&columns);
    let mut rows = sqlx::query(&select_sql).fetch(&mut *source);
    let mut transaction = target
        .begin()
        .await
        .map_err(|error| format!("开始目标表复制事务失败: {error}"))?;
    let mut batch = Vec::with_capacity(batch_row_limit);
    let mut batch_bytes = 0_usize;
    let mut copied_rows = 0_u64;

    let transfer_result = async {
        while let Some(row) = rows
            .try_next()
            .await
            .map_err(|error| format!("读取源表 {source_table} 数据失败: {error}"))?
        {
            let decoded = decode_transfer_row(&row, &columns, source_table)?;
            let decoded_bytes = decoded.iter().map(TransferCell::byte_len).sum::<usize>();
            if !batch.is_empty()
                && (batch.len() >= batch_row_limit
                    || batch_bytes.saturating_add(decoded_bytes) > COPY_BATCH_BYTES)
            {
                insert_cross_server_batch(
                    &mut transaction,
                    target_database,
                    target_table,
                    &columns,
                    &batch,
                )
                .await?;
                copied_rows = copied_rows.saturating_add(batch.len() as u64);
                batch.clear();
                batch_bytes = 0;
            }
            batch_bytes = batch_bytes.saturating_add(decoded_bytes);
            batch.push(decoded);
        }
        if !batch.is_empty() {
            insert_cross_server_batch(
                &mut transaction,
                target_database,
                target_table,
                &columns,
                &batch,
            )
            .await?;
            copied_rows = copied_rows.saturating_add(batch.len() as u64);
        }
        Ok::<(), String>(())
    }
    .await;

    match transfer_result {
        Ok(()) => transaction
            .commit()
            .await
            .map_err(|error| format!("提交目标表 {target_table} 数据失败: {error}"))?,
        Err(error) => {
            let rollback_error = transaction.rollback().await.err();
            return Err(match rollback_error {
                Some(rollback_error) => {
                    format!("{error}；回滚目标表数据失败: {rollback_error}")
                }
                None => error,
            });
        }
    }

    verify_target_row_count(target, target_database, target_table, copied_rows).await
}

fn transfer_kind(data_type: &str) -> TransferKind {
    match data_type.trim().to_ascii_lowercase().as_str() {
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" | "bit" => {
            TransferKind::Binary
        }
        "geometry" | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring"
        | "multipolygon" | "geometrycollection" => TransferKind::Geometry,
        _ => TransferKind::Text,
    }
}

fn build_source_select_sql(database: &str, table: &str, columns: &[TransferColumn]) -> String {
    let projection = if columns.is_empty() {
        "1".to_string()
    } else {
        columns
            .iter()
            .enumerate()
            .map(|(index, column)| {
                let name = format!("`{}`", escape_ident(&column.name));
                let expression = match column.kind {
                    TransferKind::Text => {
                        format!("HEX(CAST({name} AS CHAR CHARACTER SET utf8mb4))")
                    }
                    TransferKind::Binary => format!("HEX({name})"),
                    TransferKind::Geometry => format!(
                        "CASE WHEN {name} IS NULL THEN NULL ELSE CONCAT(LPAD(HEX(ST_SRID({name})), 8, '0'), HEX(ST_AsWKB({name}))) END"
                    ),
                };
                format!("{expression} AS `copy_col_{index}`")
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!(
        "SELECT {projection} FROM `{}`.`{}`",
        escape_ident(database),
        escape_ident(table),
    )
}

fn decode_transfer_row(
    row: &sqlx::mysql::MySqlRow,
    columns: &[TransferColumn],
    table: &str,
) -> Result<Vec<TransferCell>, String> {
    columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let encoded = mysql_text::optional_string(row, index)
                .map_err(|error| format!("读取源表 {table} 字段 {} 失败: {error}", column.name))?;
            decode_transfer_cell(encoded.as_deref(), column.kind)
                .map_err(|error| format!("解码源表 {table} 字段 {} 失败: {error}", column.name))
        })
        .collect()
}

fn decode_transfer_cell(encoded: Option<&str>, kind: TransferKind) -> Result<TransferCell, String> {
    let Some(encoded) = encoded else {
        return Ok(TransferCell::Null);
    };
    if kind == TransferKind::Geometry {
        if encoded.len() < 8 {
            return Err("空间字段编码缺少 SRID".into());
        }
        let srid = u32::from_str_radix(&encoded[..8], 16)
            .map_err(|error| format!("空间字段 SRID 无效: {error}"))?;
        return Ok(TransferCell::Geometry {
            wkb: decode_hex(&encoded[8..])?,
            srid,
        });
    }
    let bytes = decode_hex(encoded)?;
    Ok(match kind {
        TransferKind::Text => TransferCell::Text(bytes),
        TransferKind::Binary => TransferCell::Binary(bytes),
        TransferKind::Geometry => unreachable!("geometry handled above"),
    })
}

fn decode_hex(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.len() % 2 != 0 {
        return Err("十六进制数据长度无效".into());
    }
    let mut decoded = Vec::with_capacity(encoded.len() / 2);
    for pair in encoded.as_bytes().chunks_exact(2) {
        let high = decode_hex_digit(pair[0])?;
        let low = decode_hex_digit(pair[1])?;
        decoded.push((high << 4) | low);
    }
    Ok(decoded)
}

fn decode_hex_digit(value: u8) -> Result<u8, String> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(format!("无效十六进制字符: {}", value as char)),
    }
}

fn copy_batch_row_limit(columns: &[TransferColumn]) -> usize {
    let binds_per_row = columns
        .iter()
        .map(|column| usize::from(column.kind == TransferKind::Geometry) + 1)
        .sum::<usize>()
        .max(1);
    COPY_BATCH_ROWS.min((MYSQL_BIND_LIMIT / binds_per_row).max(1))
}

async fn insert_cross_server_batch(
    transaction: &mut sqlx::Transaction<'_, MySql>,
    target_database: &str,
    target_table: &str,
    columns: &[TransferColumn],
    rows: &[Vec<TransferCell>],
) -> Result<(), String> {
    let mut builder = build_insert_query(target_database, target_table, columns, rows);
    builder
        .build()
        .execute(&mut **transaction)
        .await
        .map_err(|error| format!("写入目标表 {target_table} 数据失败: {error}"))?;
    Ok(())
}

fn build_insert_query<'args>(
    target_database: &str,
    target_table: &str,
    columns: &[TransferColumn],
    rows: &'args [Vec<TransferCell>],
) -> QueryBuilder<'args, MySql> {
    let column_sql = columns
        .iter()
        .map(|column| format!("`{}`", escape_ident(&column.name)))
        .collect::<Vec<_>>()
        .join(", ");
    let mut builder = QueryBuilder::<MySql>::new(format!(
        "INSERT INTO `{}`.`{}` ({column_sql}) VALUES ",
        escape_ident(target_database),
        escape_ident(target_table),
    ));
    let mut separated_rows = builder.separated(", ");
    for row in rows {
        separated_rows.push("(");
        for (index, cell) in row.iter().enumerate() {
            if index > 0 {
                separated_rows.push_unseparated(", ");
            }
            match cell {
                TransferCell::Null => {
                    separated_rows.push_unseparated("NULL");
                }
                TransferCell::Text(value) => {
                    separated_rows.push_unseparated("CONVERT(");
                    separated_rows.push_bind_unseparated(value.as_slice());
                    separated_rows.push_unseparated(" USING utf8mb4)");
                }
                TransferCell::Binary(value) => {
                    separated_rows.push_bind_unseparated(value.as_slice());
                }
                TransferCell::Geometry { wkb, srid } => {
                    separated_rows.push_unseparated("ST_GeomFromWKB(");
                    separated_rows.push_bind_unseparated(wkb.as_slice());
                    separated_rows.push_unseparated(", ");
                    separated_rows.push_bind_unseparated(*srid);
                    separated_rows.push_unseparated(")");
                }
            }
        }
        separated_rows.push_unseparated(")");
    }
    builder
}

fn checked_row_count(count: i64, table: &str) -> Result<u64, String> {
    u64::try_from(count).map_err(|_| format!("读取表 {table} 行数失败: 返回了负数 {count}"))
}

async fn count_rows(
    connection: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<u64, String> {
    let sql = format!(
        "SELECT COUNT(*) AS row_count FROM `{}`.`{}`",
        escape_ident(database),
        escape_ident(table),
    );
    sqlx::query(&sql)
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("统计表 {table} 行数失败: {error}"))?
        .try_get::<i64, _>("row_count")
        .map_err(|error| format!("读取表 {table} 行数失败: {error}"))
        .and_then(|count| checked_row_count(count, table))
}

async fn insert_default_rows(
    connection: &mut MySqlConnection,
    target_database: &str,
    target_table: &str,
    count: u64,
) -> Result<(), String> {
    let mut remaining = count;
    while remaining > 0 {
        let batch = remaining.min(COPY_BATCH_ROWS as u64);
        let values = std::iter::repeat_n("()", batch as usize)
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT INTO `{}`.`{}` () VALUES {values}",
            escape_ident(target_database),
            escape_ident(target_table),
        );
        sqlx::query(&sql)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("复制表 {target_table} 默认行失败: {error}"))?;
        remaining -= batch;
    }
    Ok(())
}

async fn verify_target_row_count(
    connection: &mut MySqlConnection,
    target_database: &str,
    target_table: &str,
    expected: u64,
) -> Result<u64, String> {
    let actual = count_rows(connection, target_database, target_table).await?;
    if actual != expected {
        return Err(format!(
            "目标表 {target_table} 行数校验失败：预期 {expected} 行，实际 {actual} 行"
        ));
    }
    Ok(actual)
}

async fn clean_up_failed_table(
    connection: &mut MySqlConnection,
    target_database: &str,
    target_table: &str,
    error: String,
) -> String {
    let sql = format!(
        "DROP TABLE IF EXISTS `{}`.`{}`",
        escape_ident(target_database),
        escape_ident(target_table),
    );
    match sqlx::query(&sql).execute(&mut *connection).await {
        Ok(_) => format!("{error}；已清理未完成的目标表 {target_table}"),
        Err(cleanup_error) => {
            format!("{error}；清理未完成的目标表 {target_table} 失败: {cleanup_error}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str, kind: TransferKind) -> TransferColumn {
        TransferColumn {
            name: name.into(),
            kind,
        }
    }

    #[test]
    fn source_projection_preserves_text_binary_geometry_and_identifiers() {
        let sql = build_source_select_sql(
            "source`db",
            "map`objects",
            &[
                column("display_name", TransferKind::Text),
                column("raw`bytes", TransferKind::Binary),
                column("position", TransferKind::Geometry),
            ],
        );

        assert!(
            sql.contains("HEX(CAST(`display_name` AS CHAR CHARACTER SET utf8mb4)) AS `copy_col_0`")
        );
        assert!(sql.contains("HEX(`raw``bytes`) AS `copy_col_1`"));
        assert!(sql.contains("ST_SRID(`position`)"));
        assert!(sql.contains("ST_AsWKB(`position`)"));
        assert!(sql.ends_with("FROM `source``db`.`map``objects`"));
    }

    #[test]
    fn transfer_cell_decoder_distinguishes_null_empty_binary_and_geometry() {
        assert_eq!(
            decode_transfer_cell(None, TransferKind::Text).unwrap(),
            TransferCell::Null
        );
        assert_eq!(
            decode_transfer_cell(Some(""), TransferKind::Text).unwrap(),
            TransferCell::Text(Vec::new())
        );
        assert_eq!(
            decode_transfer_cell(Some("00FF"), TransferKind::Binary).unwrap(),
            TransferCell::Binary(vec![0, 255])
        );
        assert_eq!(
            decode_transfer_cell(Some("000010E6010203"), TransferKind::Geometry).unwrap(),
            TransferCell::Geometry {
                wkb: vec![1, 2, 3],
                srid: 4326,
            }
        );
    }

    #[test]
    fn insert_query_uses_typed_expressions_and_null_without_a_bind() {
        let columns = vec![
            column("title", TransferKind::Text),
            column("payload", TransferKind::Binary),
            column("shape", TransferKind::Geometry),
        ];
        let rows = vec![vec![
            TransferCell::Text(b"hello".to_vec()),
            TransferCell::Null,
            TransferCell::Geometry {
                wkb: vec![1, 2],
                srid: 4326,
            },
        ]];
        let query = build_insert_query("target`db", "items", &columns, &rows);

        assert_eq!(
            query.sql(),
            "INSERT INTO `target``db`.`items` (`title`, `payload`, `shape`) VALUES (CONVERT(? USING utf8mb4), NULL, ST_GeomFromWKB(?, ?))"
        );
    }

    #[test]
    fn batch_limit_accounts_for_geometry_double_binds() {
        let many_geometry_columns = (0..400)
            .map(|index| column(&format!("g{index}"), TransferKind::Geometry))
            .collect::<Vec<_>>();
        assert_eq!(copy_batch_row_limit(&many_geometry_columns), 75);
        assert_eq!(copy_batch_row_limit(&[]), COPY_BATCH_ROWS);
    }

    #[test]
    fn duplicate_names_start_at_copy1_and_skip_used_suffixes() {
        let existing = HashSet::from([
            "orders".to_string(),
            "orders_copy1".to_string(),
            "orders_copy2".to_string(),
        ]);
        assert_eq!(resolve_copy_table_name(&existing, "orders"), "orders_copy3");
        assert_eq!(resolve_copy_table_name(&existing, "players"), "players");
    }

    #[test]
    fn signed_mysql_row_count_is_checked_before_conversion() {
        assert_eq!(checked_row_count(42, "orders").unwrap(), 42);
        assert!(checked_row_count(-1, "orders")
            .unwrap_err()
            .contains("返回了负数 -1"));
    }

    #[test]
    fn copy_request_accepts_new_and_legacy_source_connection_fields() {
        for (field, value) in [
            ("sourceConnectionId", "source-new"),
            ("connectionId", "source-legacy"),
        ] {
            let mut request = serde_json::json!({
                "sourceDatabase": "game_db",
                "tableNames": ["orders"],
                "targetConnectionId": "target",
                "targetDatabase": "archive"
            });
            request[field] = serde_json::Value::String(value.into());
            let request: CopyTablesRequest = serde_json::from_value(request).unwrap();
            assert_eq!(request.source_connection_id, value);
        }
    }

    #[test]
    fn session_restore_failures_warn_after_success_but_extend_copy_errors() {
        let success = finish_with_session_restores(
            Ok(CopyTablesResponse {
                status: "succeeded".into(),
                copied: Vec::new(),
                warnings: Vec::new(),
            }),
            [("源 MySQL", Err("连接已关闭".into()))],
        )
        .unwrap();
        assert_eq!(success.warnings.len(), 1);
        assert!(success.warnings[0].contains("恢复源 MySQL 会话失败"));

        let failure = finish_with_session_restores(
            Err("复制失败".into()),
            [("目标 MySQL", Err("连接已关闭".into()))],
        )
        .unwrap_err();
        assert!(failure.contains("复制失败"));
        assert!(failure.contains("恢复目标 MySQL 会话失败"));
    }
}
