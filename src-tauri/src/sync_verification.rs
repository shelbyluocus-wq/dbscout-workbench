use std::collections::BTreeMap;

use sqlx::{MySqlConnection, Row};

use crate::db::escape_ident;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableFingerprint {
    pub name: String,
    pub canonical_ddl: String,
    pub rows: u64,
    pub checksum: Option<u64>,
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
    let ddl = ddl_row
        .try_get::<String, _>("Create Table")
        .or_else(|_| ddl_row.try_get::<String, _>(1))
        .map_err(|error| format!("读取表 {table} 结构失败: {error}"))?;

    let row_count = sqlx::query(&format!("SELECT COUNT(*) AS cnt FROM {qualified}"))
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("核对表 {table} 行数失败: {error}"))?
        .try_get::<i64, _>("cnt")
        .unwrap_or(0)
        .max(0) as u64;

    let checksum_row = sqlx::query(&format!("CHECKSUM TABLE {qualified}"))
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("核对表 {table} 数据校验和失败: {error}"))?;
    let checksum = checksum_row
        .try_get::<Option<i64>, _>("Checksum")
        .or_else(|_| checksum_row.try_get::<Option<i64>, _>(1))
        .unwrap_or(None)
        .map(|value| value.max(0) as u64);

    Ok(TableFingerprint {
        name: table.to_string(),
        canonical_ddl: canonicalize_create_table(&ddl, database),
        rows: row_count,
        checksum,
    })
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
        .filter_map(|row| row.try_get::<String, _>("TABLE_NAME").ok())
        .collect())
}

pub fn canonicalize_create_table(ddl: &str, database: &str) -> String {
    let body = ddl.find('(').map(|index| &ddl[index..]).unwrap_or(ddl);
    let qualified_database = format!("`{}`.", escape_ident(database));
    body.trim().replace(&qualified_database, "`<database>`.")
}

#[cfg(test)]
mod tests {
    use super::{canonicalize_create_table, compare_fingerprints, MismatchKind, TableFingerprint};

    fn table(name: &str, ddl: &str, rows: u64, checksum: Option<u64>) -> TableFingerprint {
        TableFingerprint {
            name: name.into(),
            canonical_ddl: ddl.into(),
            rows,
            checksum,
        }
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
