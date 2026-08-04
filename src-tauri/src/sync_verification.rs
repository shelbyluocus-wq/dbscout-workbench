use std::collections::BTreeMap;

use sha2::{Digest, Sha256};
use sqlx::MySqlConnection;

use crate::db::escape_ident;
use crate::mysql_text;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableFingerprint {
    pub name: String,
    pub canonical_ddl: String,
    pub rows: u64,
    pub checksum: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FingerprintColumn {
    name: String,
    data_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MismatchKind {
    MissingTable,
    ExtraTable,
    DataStructure,
    RowCount,
    DataChecksum,
    ChecksumUnavailable,
}

impl MismatchKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingTable => "missing_table",
            Self::ExtraTable => "extra_table",
            Self::DataStructure => "data_structure",
            Self::RowCount => "row_count",
            Self::DataChecksum => "data_checksum",
            Self::ChecksumUnavailable => "checksum_unavailable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableMismatch {
    pub table: String,
    pub kind: MismatchKind,
}

pub fn compare_fingerprints(
    source: &[TableFingerprint],
    target: &[TableFingerprint],
) -> Vec<TableMismatch> {
    let source_by_name = fingerprint_map(source);
    let target_by_name = fingerprint_map(target);
    let mut names = source_by_name
        .keys()
        .chain(target_by_name.keys())
        .cloned()
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();

    names
        .into_iter()
        .filter_map(|key| {
            let source = source_by_name.get(&key);
            let target = target_by_name.get(&key);
            match (source, target) {
                (Some(source), None) => Some(TableMismatch {
                    table: source.name.clone(),
                    kind: MismatchKind::MissingTable,
                }),
                (None, Some(target)) => Some(TableMismatch {
                    table: target.name.clone(),
                    kind: MismatchKind::ExtraTable,
                }),
                (Some(source), Some(target)) if source.canonical_ddl != target.canonical_ddl => {
                    Some(TableMismatch {
                        table: source.name.clone(),
                        kind: MismatchKind::DataStructure,
                    })
                }
                (Some(source), Some(target)) if source.rows != target.rows => Some(TableMismatch {
                    table: source.name.clone(),
                    kind: MismatchKind::RowCount,
                }),
                (Some(source), Some(_target)) if source.rows == 0 => None,
                (Some(source), Some(target))
                    if source.rows > 0
                        && (source.checksum.is_none() || target.checksum.is_none()) =>
                {
                    Some(TableMismatch {
                        table: source.name.clone(),
                        kind: MismatchKind::ChecksumUnavailable,
                    })
                }
                (Some(source), Some(target)) if source.checksum != target.checksum => {
                    Some(TableMismatch {
                        table: source.name.clone(),
                        kind: MismatchKind::DataChecksum,
                    })
                }
                _ => None,
            }
        })
        .collect()
}

fn fingerprint_map(tables: &[TableFingerprint]) -> BTreeMap<String, &TableFingerprint> {
    tables
        .iter()
        .map(|table| (table.name.to_lowercase(), table))
        .collect()
}

pub async fn capture_table_fingerprint(
    connection: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<TableFingerprint, String> {
    let qualified = format!("`{}`.`{}`", escape_ident(database), escape_ident(table));
    let ddl_row = sqlx::query(&format!("SHOW CREATE TABLE {qualified}"))
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("读取表 {table} 结构失败: {error}"))?;
    let ddl = mysql_text::string(&ddl_row, "Create Table")
        .or_else(|_| mysql_text::string(&ddl_row, 1))
        .map_err(|error| format!("读取表 {table} 结构失败: {error}"))?;

    let (row_count, checksum) =
        capture_semantic_data_fingerprint(connection, database, table).await?;

    Ok(TableFingerprint {
        name: table.to_string(),
        canonical_ddl: canonicalize_create_table(&ddl, database),
        rows: row_count,
        checksum: Some(checksum),
    })
}

async fn capture_semantic_data_fingerprint(
    connection: &mut MySqlConnection,
    database: &str,
    table: &str,
) -> Result<(u64, String), String> {
    let column_rows = sqlx::query(
        "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    )
    .bind(database)
    .bind(table)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("读取表 {table} 校验字段失败: {error}"))?;
    let columns = column_rows
        .into_iter()
        .map(|row| {
            Ok(FingerprintColumn {
                name: mysql_text::string(&row, "COLUMN_NAME")
                    .map_err(|error| format!("读取表 {table} 校验字段失败: {error}"))?,
                data_type: mysql_text::string(&row, "DATA_TYPE")
                    .map_err(|error| format!("读取表 {table} 校验字段失败: {error}"))?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    if columns.is_empty() {
        return Err(format!("表 {table} 没有可校验字段"));
    }

    let sql = build_semantic_checksum_sql(database, table, &columns);
    let rows = sqlx::query(&sql)
        .fetch_all(&mut *connection)
        .await
        .map_err(|error| format!("核对表 {table} 数据内容失败: {error}"))?;
    let mut row_count = 0_u64;
    let mut groups = Vec::with_capacity(rows.len());
    for row in rows {
        let digest = mysql_text::string(&row, "row_digest")
            .map_err(|error| format!("读取表 {table} 数据指纹失败: {error}"))?;
        let occurrences = mysql_text::string(&row, "occurrence_count")
            .map_err(|error| format!("读取表 {table} 数据指纹失败: {error}"))?
            .parse::<u64>()
            .map_err(|error| format!("读取表 {table} 数据行数失败: {error}"))?;
        row_count = row_count.saturating_add(occurrences);
        groups.push((digest, occurrences));
    }

    Ok((row_count, finalize_semantic_checksum(groups)))
}

fn build_semantic_checksum_sql(
    database: &str,
    table: &str,
    columns: &[FingerprintColumn],
) -> String {
    let column_tokens = columns
        .iter()
        .map(|column| {
            let name = format!("`{}`", escape_ident(&column.name));
            let canonical_value = match column.data_type.to_ascii_lowercase().as_str() {
                "json" => format!("CAST({name} AS CHAR CHARACTER SET utf8mb4)"),
                "geometry" | "point" | "linestring" | "polygon" | "multipoint"
                | "multilinestring" | "multipolygon" | "geometrycollection" => {
                    format!("ST_AsWKB({name})")
                }
                _ => format!("CAST({name} AS BINARY)"),
            };
            format!("IF({name} IS NULL, 'N', CONCAT('V', SHA2({canonical_value}, 256)))")
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT row_digest, CAST(COUNT(*) AS CHAR) AS occurrence_count \
         FROM (SELECT SHA2(CONCAT({column_tokens}), 256) AS row_digest \
         FROM `{}`.`{}`) AS checksum_rows \
         GROUP BY row_digest ORDER BY row_digest",
        escape_ident(database),
        escape_ident(table)
    )
}

fn finalize_semantic_checksum(mut groups: Vec<(String, u64)>) -> String {
    groups.sort_unstable();
    let mut hasher = Sha256::new();
    for (row_digest, occurrences) in groups {
        hasher.update((row_digest.len() as u64).to_be_bytes());
        hasher.update(row_digest.as_bytes());
        hasher.update(occurrences.to_be_bytes());
    }
    format!("{:x}", hasher.finalize())
}

pub async fn list_base_tables(
    connection: &mut MySqlConnection,
    database: &str,
) -> Result<Vec<String>, String> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    )
    .bind(database)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("读取数据库 {database} 的表列表失败: {error}"))?;
    Ok(rows
        .into_iter()
        .filter_map(|row| mysql_text::string(&row, "TABLE_NAME").ok())
        .collect())
}

pub fn canonicalize_create_table(ddl: &str, database: &str) -> String {
    let body = ddl.find('(').map(|index| &ddl[index..]).unwrap_or(ddl);
    let qualified_database = format!("`{}`.", escape_ident(database));
    body.trim().replace(&qualified_database, "`<database>`.")
}

#[cfg(test)]
mod tests {
    use super::{
        build_semantic_checksum_sql, canonicalize_create_table, compare_fingerprints,
        finalize_semantic_checksum, FingerprintColumn, MismatchKind, TableFingerprint,
    };

    fn table(name: &str, ddl: &str, rows: u64, checksum: Option<u64>) -> TableFingerprint {
        TableFingerprint {
            name: name.into(),
            canonical_ddl: ddl.into(),
            rows,
            checksum: checksum.map(|value| value.to_string()),
        }
    }

    #[test]
    fn semantic_checksum_sql_normalizes_json_and_preserves_binary_and_spatial_values() {
        let sql = build_semantic_checksum_sql(
            "source`db",
            "item`table",
            &[
                FingerprintColumn {
                    name: "payload".into(),
                    data_type: "json".into(),
                },
                FingerprintColumn {
                    name: "raw`value".into(),
                    data_type: "blob".into(),
                },
                FingerprintColumn {
                    name: "location".into(),
                    data_type: "point".into(),
                },
            ],
        );

        assert!(sql.contains("CAST(`payload` AS CHAR CHARACTER SET utf8mb4)"));
        assert!(sql.contains("CAST(`raw``value` AS BINARY)"));
        assert!(sql.contains("ST_AsWKB(`location`)"));
        assert!(sql.contains("FROM `source``db`.`item``table`"));
        assert!(sql.contains("GROUP BY row_digest ORDER BY row_digest"));
    }

    #[test]
    fn semantic_checksum_is_order_independent_and_counts_duplicate_rows() {
        let first = finalize_semantic_checksum(vec![("row-b".into(), 1), ("row-a".into(), 2)]);
        let reordered = finalize_semantic_checksum(vec![("row-a".into(), 2), ("row-b".into(), 1)]);
        let different_count =
            finalize_semantic_checksum(vec![("row-a".into(), 1), ("row-b".into(), 1)]);

        assert_eq!(first, reordered);
        assert_ne!(first, different_count);
    }

    #[test]
    fn exact_match_requires_same_tables_structure_rows_and_data() {
        let source = vec![
            table("player", "(id bigint primary key)", 2, Some(101)),
            table("quest", "(id bigint, state int)", 3, Some(202)),
        ];
        let target = source.clone();

        assert!(compare_fingerprints(&source, &target).is_empty());
    }

    #[test]
    fn empty_tables_can_match_when_the_engine_has_no_checksum() {
        let source = vec![table("empty", "(id bigint)", 0, None)];
        let target = vec![table("empty", "(id bigint)", 0, Some(0))];

        assert!(compare_fingerprints(&source, &target).is_empty());
    }

    #[test]
    fn non_empty_tables_never_pass_without_a_data_checksum() {
        let source = vec![table("data", "(id bigint)", 1, None)];
        let target = source.clone();

        assert_eq!(
            compare_fingerprints(&source, &target),
            vec![super::TableMismatch {
                table: "data".into(),
                kind: MismatchKind::ChecksumUnavailable,
            }]
        );
    }

    #[test]
    fn exact_match_reports_every_mismatch_class() {
        let source = vec![
            table("data", "(id bigint, value int)", 4, Some(11)),
            table("missing", "(id bigint)", 1, Some(12)),
            table("rows", "(id bigint)", 8, Some(13)),
            table("checksum", "(id bigint)", 2, Some(14)),
        ];
        let target = vec![
            table("data", "(id bigint, value varchar(20))", 4, Some(11)),
            table("extra", "(id bigint)", 1, Some(99)),
            table("rows", "(id bigint)", 7, Some(13)),
            table("checksum", "(id bigint)", 2, Some(15)),
        ];

        let mismatches = compare_fingerprints(&source, &target);
        let details = mismatches
            .iter()
            .map(|item| format!("{}:{}", item.table, item.kind.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(
            details,
            vec![
                "checksum:data_checksum",
                "data:data_structure",
                "extra:extra_table",
                "missing:missing_table",
                "rows:row_count",
            ]
        );
    }

    #[test]
    fn ddl_canonicalization_ignores_the_database_name_but_not_structure() {
        let source = canonicalize_create_table(
            "CREATE TABLE `child` (`id` bigint, CONSTRAINT `fk` FOREIGN KEY (`id`) REFERENCES `source_db`.`parent` (`id`)) ENGINE=InnoDB",
            "source_db",
        );
        let target = canonicalize_create_table(
            "CREATE TABLE `child` (`id` bigint, CONSTRAINT `fk` FOREIGN KEY (`id`) REFERENCES `target_db`.`parent` (`id`)) ENGINE=InnoDB",
            "target_db",
        );

        assert_eq!(source, target);
        assert_ne!(source, "(`id` varchar(20)) ENGINE=InnoDB");
    }
}
