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

#[allow(dead_code)]
pub fn escape_like_pattern(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

#[allow(dead_code)]
pub fn value_search_pattern(query: &str) -> Option<String> {
    let query = query.trim();
    if query.is_empty() {
        return None;
    }
    Some(escape_like_pattern(query))
}

#[allow(dead_code)]
pub fn build_value_search_sql(table: &TableMeta) -> Result<(String, usize), String> {
    let columns = table
        .columns
        .iter()
        .filter(|column| !column.column_name.trim().is_empty())
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Err("没有可搜索字段".into());
    }

    let select_sql = columns
        .iter()
        .map(|column| format!("CAST(`{}` AS CHAR) AS `{}`", escape_ident(&column.column_name), escape_ident(&column.column_name)))
        .collect::<Vec<_>>()
        .join(", ");
    let where_sql = columns
        .iter()
        .map(|column| format!("CAST(`{}` AS CHAR) LIKE ? ESCAPE '\\\\'", escape_ident(&column.column_name)))
        .collect::<Vec<_>>()
        .join(" OR ");
    let sql = format!(
        "SELECT {} FROM `{}` WHERE ({}) LIMIT 1",
        select_sql,
        escape_ident(&table.table_name),
        where_sql
    );
    Ok((sql, columns.len()))
}

#[allow(dead_code)]
pub fn build_value_search_column_sql(table: &TableMeta, column: &ColumnMeta) -> Result<String, String> {
    if column.column_name.trim().is_empty() {
        return Err("no searchable column".into());
    }
    let column_name = escape_ident(&column.column_name);
    Ok(format!(
        "SELECT CAST(`{}` AS CHAR) AS preview_value FROM `{}` WHERE CAST(`{}` AS CHAR) LIKE ? ESCAPE '\\\\' LIMIT 1",
        column_name,
        escape_ident(&table.table_name),
        column_name
    ))
}

#[allow(dead_code)]
pub async fn search_first_value_match(
    pool: &MySqlPool,
    table: &TableMeta,
    query: &str,
) -> Result<Option<SearchValueItem>, String> {
    let Some(pattern) = value_search_pattern(query) else {
        return Ok(None);
    };

    for column in &table.columns {
        let sql = match build_value_search_column_sql(table, column) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let row = sqlx::query(&sql)
            .bind(&pattern)
            .fetch_optional(pool)
            .await
            .map_err(|error| format!("搜索值失败: {error}"))?;
        let Some(row) = row else {
            continue;
        };
        let value = row
            .try_get::<Option<String>, _>("preview_value")
            .unwrap_or(None)
            .unwrap_or_default();
        return Ok(Some(SearchValueItem {
            table_name: table.table_name.clone(),
            table_comment: table.table_comment.clone(),
            column_name: column.column_name.clone(),
            preview_value: value.chars().take(80).collect(),
            row_identity: None,
        }));
    }
    Ok(None)
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

    #[test]
    fn escape_like_pattern_escapes_wildcards_and_backslashes() {
        assert_eq!(escape_like_pattern("a%b_c\\d"), "%a\\%b\\_c\\\\d%");
    }

    #[test]
    fn build_value_search_sql_uses_cast_like_and_limit_one() {
        let table = TableMeta {
            table_name: "player`profile".into(),
            table_comment: String::new(),
            columns: vec![
                ColumnMeta {
                    column_name: "nickname".into(),
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
            ],
        };

        let (sql, bind_count) = build_value_search_sql(&table).expect("columns are searchable");

        assert!(sql.contains("FROM `player``profile`"));
        assert!(sql.contains("CAST(`nickname` AS CHAR) LIKE ? ESCAPE '\\\\'"));
        assert!(sql.contains("CAST(`remark``text` AS CHAR) LIKE ? ESCAPE '\\\\'"));
        assert!(sql.ends_with(" LIMIT 1"));
        assert_eq!(bind_count, 2);
    }

    #[test]
    fn build_value_search_column_sql_selects_preview_for_one_column() {
        let table = TableMeta {
            table_name: "player`profile".into(),
            table_comment: String::new(),
            columns: Vec::new(),
        };
        let column = ColumnMeta {
            column_name: "remark`text".into(),
            column_type: "text".into(),
            column_comment: String::new(),
            is_primary_key: false,
            is_nullable: true,
        };

        let sql = build_value_search_column_sql(&table, &column).expect("column is searchable");

        assert_eq!(
            sql,
            "SELECT CAST(`remark``text` AS CHAR) AS preview_value FROM `player``profile` WHERE CAST(`remark``text` AS CHAR) LIKE ? ESCAPE '\\\\' LIMIT 1"
        );
    }

    #[test]
    fn value_search_pattern_trims_and_rejects_empty_queries() {
        assert_eq!(value_search_pattern("  a%b_c\\d  "), Some("%a\\%b\\_c\\\\d%".into()));
        assert_eq!(value_search_pattern("   "), None);
    }
}
