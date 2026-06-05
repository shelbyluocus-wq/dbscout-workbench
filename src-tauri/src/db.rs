use std::{collections::HashMap, str::FromStr};

use sqlx::{mysql::{MySqlConnectOptions, MySqlPoolOptions}, MySqlPool, Row};

use crate::types::*;

pub fn escape_ident(value: &str) -> String {
    value.replace('`', "``")
}

pub fn normalize_page_request(request: &TablePageRequest) -> (u32, u32) {
    let page = request.page.unwrap_or(1).max(1);
    let page_size = request.page_size.unwrap_or(100).clamp(1, 10000);
    (page, page_size)
}

pub fn primary_keys(table: &TableMeta) -> Vec<String> {
    table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.clone())
        .collect()
}

pub fn build_filter_sql(columns: &[ColumnMeta], request: &TablePageRequest) -> (String, Vec<String>) {
    let Some(filter) = request.filter.as_ref() else {
        return (String::new(), Vec::new());
    };
    let query = filter.query.trim();
    if query.is_empty() {
        return (String::new(), Vec::new());
    }
    let requested = filter
        .columns
        .iter()
        .map(|value| value.to_lowercase())
        .collect::<Vec<_>>();
    let filter_columns = columns
        .iter()
        .filter(|column| requested.is_empty() || requested.contains(&column.column_name.to_lowercase()))
        .collect::<Vec<_>>();
    if filter_columns.is_empty() {
        return (String::new(), Vec::new());
    }
    let sql = format!(
        " WHERE ({})",
        filter_columns
            .iter()
            .map(|column| format!("CAST(`{}` AS CHAR) LIKE ? ESCAPE '\\\\'", escape_ident(&column.column_name)))
            .collect::<Vec<_>>()
            .join(" OR ")
    );
    let escaped_query = query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    (sql, filter_columns.iter().map(|_| format!("%{escaped_query}%")).collect())
}

pub fn build_where(identity: &HashMap<String, String>) -> Result<(String, Vec<String>), String> {
    if identity.is_empty() {
        return Err("缺少行标识".into());
    }
    let mut keys = identity.keys().cloned().collect::<Vec<_>>();
    keys.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok((
        keys.iter().map(|key| format!("`{}` <=> ?", escape_ident(key))).collect::<Vec<_>>().join(" AND "),
        keys.iter().map(|key| identity.get(key).cloned().unwrap_or_default()).collect(),
    ))
}

pub async fn connect_database(mysql_url: &str, database: Option<&str>) -> Result<MySqlPool, String> {
    let mut options = MySqlConnectOptions::from_str(mysql_url)
        .map_err(|error| format!("MySQL URL 无效: {error}"))?;
    if let Some(database) = database.filter(|value| !value.trim().is_empty()) {
        options = options.database(database.trim());
    }
    MySqlPoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .map_err(|error| format!("连接 MySQL 失败: {error}"))
}

pub async fn read_schema(pool: &MySqlPool, database: &str, table_name: &str) -> Result<TableMeta, String> {
    let table_row = sqlx::query(
        "SELECT TABLE_NAME, COALESCE(TABLE_COMMENT, '') AS TABLE_COMMENT \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1",
    )
    .bind(database)
    .bind(table_name)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("读取表信息失败: {error}"))?
    .ok_or_else(|| format!("表不存在: {table_name}"))?;

    let columns = sqlx::query(
        "SELECT COLUMN_NAME, COLUMN_TYPE, COALESCE(COLUMN_COMMENT, '') AS COLUMN_COMMENT, \
         COLUMN_KEY = 'PRI' AS IS_PRIMARY_KEY, IS_NULLABLE = 'YES' AS IS_NULLABLE \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    )
    .bind(database)
    .bind(table_name)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取字段信息失败: {error}"))?
    .into_iter()
    .map(|row| {
        Ok(ColumnMeta {
            column_name: row.try_get("COLUMN_NAME").map_err(|error| error.to_string())?,
            column_type: row.try_get("COLUMN_TYPE").map_err(|error| error.to_string())?,
            column_comment: row.try_get("COLUMN_COMMENT").unwrap_or_default(),
            is_primary_key: row.try_get::<i8, _>("IS_PRIMARY_KEY").unwrap_or(0) != 0,
            is_nullable: row.try_get::<i8, _>("IS_NULLABLE").unwrap_or(0) != 0,
        })
    })
    .collect::<Result<Vec<_>, String>>()?;

    Ok(TableMeta {
        table_name: table_row.try_get("TABLE_NAME").unwrap_or_else(|_| table_name.to_string()),
        table_comment: table_row.try_get("TABLE_COMMENT").unwrap_or_default(),
        columns,
    })
}

fn infer_default_mode(default_value: &Option<String>, nullable: bool, primary_key: bool) -> String {
    match default_value.as_deref() {
        None => "none".into(),
        Some(value) if value.eq_ignore_ascii_case("NULL") && nullable && !primary_key => "null".into(),
        Some(value) if value.contains('(') || value.eq_ignore_ascii_case("CURRENT_TIMESTAMP") || value.eq_ignore_ascii_case("CURRENT_DATE") || value.eq_ignore_ascii_case("CURRENT_TIME") => "expression".into(),
        Some(_) => "value".into(),
    }
}

fn column_support(data_type: &str, extra: &str, generation_expression: &Option<String>) -> (bool, bool, Option<String>) {
    let generated = !generation_expression.as_deref().unwrap_or_default().trim().is_empty()
        || extra.to_ascii_lowercase().contains("generated");
    if generated {
        return (true, false, Some("generated columns are read-only in table design V1".into()));
    }
    let supported = matches!(data_type.to_ascii_lowercase().as_str(),
        "char" | "varchar" | "binary" | "varbinary" | "bit" |
        "decimal" | "numeric" | "dec" | "fixed" |
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" |
        "float" | "double" | "real" |
        "tinytext" | "text" | "mediumtext" | "longtext" | "json" |
        "tinyblob" | "blob" | "mediumblob" | "longblob" |
        "date" | "datetime" | "timestamp" | "time" | "year" |
        "bool" | "boolean"
    );
    if supported {
        (false, true, None)
    } else {
        (false, false, Some(format!("unsupported column type: {data_type}")))
    }
}

pub async fn read_table_design(pool: &MySqlPool, database: &str, table_name: &str, connection_id: &str) -> Result<TableDesignMeta, String> {
    let table_row = sqlx::query(
        "SELECT TABLE_NAME, COALESCE(TABLE_COMMENT, '') AS TABLE_COMMENT \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1",
    )
    .bind(database)
    .bind(table_name)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("读取表设计失败: {error}"))?
    .ok_or_else(|| format!("表不存在: {table_name}"))?;

    let columns = sqlx::query(
        "SELECT ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, \
         CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, \
         IS_NULLABLE = 'YES' AS IS_NULLABLE, COLUMN_KEY = 'PRI' AS IS_PRIMARY_KEY, \
         COLUMN_DEFAULT, COALESCE(COLUMN_COMMENT, '') AS COLUMN_COMMENT, \
         COALESCE(EXTRA, '') AS EXTRA, GENERATION_EXPRESSION \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    )
    .bind(database)
    .bind(table_name)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取字段设计失败: {error}"))?
    .into_iter()
    .map(|row| {
        let data_type: String = row.try_get("DATA_TYPE").map_err(|error| error.to_string())?;
        let nullable = row.try_get::<i8, _>("IS_NULLABLE").unwrap_or(0) != 0;
        let primary_key = row.try_get::<i8, _>("IS_PRIMARY_KEY").unwrap_or(0) != 0;
        let default_value = row.try_get::<Option<String>, _>("COLUMN_DEFAULT").unwrap_or(None);
        let extra = row.try_get::<String, _>("EXTRA").unwrap_or_default();
        let generation_expression = row.try_get::<Option<String>, _>("GENERATION_EXPRESSION").unwrap_or(None).filter(|value| !value.trim().is_empty());
        let (is_generated, is_supported, unsupported_reason) = column_support(&data_type, &extra, &generation_expression);
        Ok(ColumnDesignMeta {
            ordinal: row.try_get::<u32, _>("ORDINAL_POSITION").unwrap_or(0),
            column_name: row.try_get("COLUMN_NAME").map_err(|error| error.to_string())?,
            column_type: row.try_get("COLUMN_TYPE").map_err(|error| error.to_string())?,
            data_type,
            length: row.try_get::<Option<u64>, _>("CHARACTER_MAXIMUM_LENGTH").unwrap_or(None)
                .or_else(|| row.try_get::<Option<u64>, _>("NUMERIC_PRECISION").unwrap_or(None)),
            scale: row.try_get::<Option<u64>, _>("NUMERIC_SCALE").unwrap_or(None),
            is_nullable: nullable,
            is_primary_key: primary_key,
            default_mode: infer_default_mode(&default_value, nullable, primary_key),
            default_value,
            column_comment: row.try_get("COLUMN_COMMENT").unwrap_or_default(),
            extra,
            generation_expression,
            is_generated,
            is_supported,
            unsupported_reason,
        })
    })
    .collect::<Result<Vec<_>, String>>()?;

    let mut design = TableDesignMeta {
        source: TableDesignSource {
            connection_id: connection_id.into(),
            database: database.into(),
            table_name: table_name.into(),
        },
        table_name: table_row.try_get("TABLE_NAME").unwrap_or_else(|_| table_name.to_string()),
        table_comment: table_row.try_get("TABLE_COMMENT").unwrap_or_default(),
        schema_signature: None,
        columns,
    };
    design.schema_signature = Some(crate::ddl::schema_signature(&design));
    Ok(design)
}

pub async fn list_tables_from_db(pool: &MySqlPool, database: &str) -> Result<Vec<TableOption>, String> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME, COALESCE(TABLE_COMMENT, '') AS TABLE_COMMENT \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
    )
    .bind(database)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取表列表失败: {error}"))?;

    Ok(rows
        .into_iter()
        .map(|row| TableOption {
            table_name: row.try_get("TABLE_NAME").unwrap_or_default(),
            table_comment: row.try_get("TABLE_COMMENT").unwrap_or_default(),
        })
        .collect())
}

pub async fn read_db_page(
    pool: &MySqlPool,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> Result<TableSessionPage, String> {
    let (page, page_size) = normalize_page_request(request);
    let offset = (page - 1) * page_size;
    let select_columns = table
        .columns
        .iter()
        .map(|column| format!("CAST(`{}` AS CHAR) AS `{}`", escape_ident(&column.column_name), escape_ident(&column.column_name)))
        .collect::<Vec<_>>()
        .join(", ");
    let (where_sql, binds) = build_filter_sql(&table.columns, request);
    let order_sql = request
        .sort
        .as_ref()
        .filter(|sort| !sort.column_name.trim().is_empty())
        .map(|sort| {
            format!(
                " ORDER BY `{}` {}",
                escape_ident(&sort.column_name),
                if sort.descending { "DESC" } else { "ASC" }
            )
        })
        .unwrap_or_default();

    let count_sql = format!("SELECT COUNT(*) AS cnt FROM `{}`{}", escape_ident(&table.table_name), where_sql);
    let mut count_query = sqlx::query(&count_sql);
    for bind in &binds {
        count_query = count_query.bind(bind);
    }
    let total_rows = count_query
        .fetch_one(pool)
        .await
        .map_err(|error| format!("统计行数失败: {error}"))?
        .try_get::<i64, _>("cnt")
        .unwrap_or(0)
        .max(0) as u64;

    let sql = format!(
        "SELECT {} FROM `{}`{}{} LIMIT {} OFFSET {}",
        select_columns,
        escape_ident(&table.table_name),
        where_sql,
        order_sql,
        page_size,
        offset
    );
    let mut query = sqlx::query(&sql);
    for bind in &binds {
        query = query.bind(bind);
    }
    let rows = query
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取数据失败: {error}"))?
        .into_iter()
        .map(|row| {
            let mut out = HashMap::new();
            for column in &table.columns {
                let value = row
                    .try_get::<Option<String>, _>(column.column_name.as_str())
                    .unwrap_or(None)
                    .unwrap_or_default();
                out.insert(column.column_name.clone(), value);
            }
            out
        })
        .collect::<Vec<_>>();

    Ok(TableSessionPage {
        session_id: session_id.into(),
        table_name: table.table_name.clone(),
        table_comment: table.table_comment.clone(),
        columns: table.columns.clone(),
        primary_keys: primary_keys(table),
        rows,
        total_rows,
        page,
        page_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_ident_doubles_backticks() {
        assert_eq!(escape_ident("normal_name"), "normal_name");
        assert_eq!(escape_ident("bad`name"), "bad``name");
    }

    #[test]
    fn normalize_page_request_clamps_page_size() {
        let request = TablePageRequest {
            page: Some(0),
            page_size: Some(999),
            filter: None,
            sort: None,
        };

        assert_eq!(normalize_page_request(&request), (1, 999));
    }

    #[test]
    fn build_filter_sql_targets_requested_columns() {
        let columns = vec![
            ColumnMeta {
                column_name: "name".into(),
                column_type: "varchar(64)".into(),
                column_comment: String::new(),
                is_primary_key: false,
                is_nullable: false,
            },
            ColumnMeta {
                column_name: "remark`text".into(),
                column_type: "text".into(),
                column_comment: String::new(),
                is_primary_key: false,
                is_nullable: true,
            },
        ];
        let request = TablePageRequest {
            page: None,
            page_size: None,
            filter: Some(TablePageFilter { query: "abc".into(), columns: vec!["remark`text".into()] }),
            sort: None,
        };

        let (sql, values) = build_filter_sql(&columns, &request);

        assert_eq!(sql, " WHERE (CAST(`remark``text` AS CHAR) LIKE ? ESCAPE '\\\\')");
        assert_eq!(values, vec!["%abc%"]);
    }

    #[test]
    fn build_where_uses_all_identity_columns() {
        let mut identity = HashMap::new();
        identity.insert("id".into(), "1".into());
        identity.insert("name`part".into(), "demo".into());

        let (sql, mut values) = build_where(&identity).expect("identity is valid");
        values.sort();

        assert!(sql.contains("`id` <=> ?"));
        assert!(sql.contains("`name``part` <=> ?"));
        assert_eq!(values, vec!["1", "demo"]);
    }
}
