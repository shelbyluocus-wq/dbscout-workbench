//! 表内查找替换（Ctrl+H 全部替换）的核心逻辑。
//!
//! 候选行通过 LIKE 粗筛（大小写不敏感时用 `LOWER(...)`，注意 MySQL `LOWER`
//! 只折叠 ASCII，非 ASCII 查询退化为全表扫描以免漏命中），随后在 Rust 内存中
//! 按统一语义精确替换并产出 `UpdateRowPatch`，交由 `commands::update_cells_impl`
//! 走既有的原子事务 + 审计逆操作路径，保证可回滚。

use std::collections::HashMap;

use sqlx::mysql::MySqlPool;
use sqlx::Row;

use crate::db;
use crate::types::{CellUpdateChange, TableMeta, UpdateRowPatch};

/// Excel 式子串替换：把 `value` 中所有 `query` 片段替换为 `replacement`。
/// 默认大小写不敏感；返回 `(新文本, 替换处数)`，`query` 为空时原样返回。
///
/// 大小写不敏感匹配按 char 小写展开并记录原始字符下标，因此小写化改变字符
/// 数（如 `İ`）时仍能正确映射回原文。
pub fn replace_text(value: &str, query: &str, replacement: &str, case_sensitive: bool) -> (String, u64) {
    if query.is_empty() {
        return (value.to_string(), 0);
    }
    let source: Vec<char> = value.chars().collect();
    // (比较用字符, 原始字符下标)
    let mut folded: Vec<(char, usize)> = Vec::with_capacity(source.len());
    for (index, ch) in source.iter().enumerate() {
        if case_sensitive {
            folded.push((*ch, index));
        } else {
            for lowered in ch.to_lowercase() {
                folded.push((lowered, index));
            }
        }
    }
    let needle: Vec<char> = if case_sensitive {
        query.chars().collect()
    } else {
        query.chars().flat_map(char::to_lowercase).collect()
    };
    if needle.is_empty() || needle.len() > folded.len() {
        return (value.to_string(), 0);
    }

    let mut out = String::with_capacity(value.len());
    let mut count = 0u64;
    let mut cursor = 0usize; // folded 下标
    let mut emitted = 0usize; // 已输出的原始字符下标
    while cursor + needle.len() <= folded.len() {
        let window = &folded[cursor..cursor + needle.len()];
        if window.iter().map(|entry| entry.0).eq(needle.iter().copied()) {
            let start = window[0].1;
            let end = window[window.len() - 1].1 + 1;
            for ch in &source[emitted..start] {
                out.push(*ch);
            }
            out.push_str(replacement);
            count += 1;
            emitted = end;
            cursor += needle.len();
        } else {
            cursor += 1;
        }
    }
    if count == 0 {
        return (value.to_string(), 0);
    }
    for ch in &source[emitted..] {
        out.push(*ch);
    }
    (out, count)
}

/// 行标识列：主键列；无主键时退化为全部列（与前端行标识规则一致）。
fn identity_columns(table: &TableMeta) -> Vec<&str> {
    let primary: Vec<&str> = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.as_str())
        .collect();
    if primary.is_empty() {
        table
            .columns
            .iter()
            .map(|column| column.column_name.as_str())
            .collect()
    } else {
        primary
    }
}

/// 对扫描行（列名 → 字符串值，NULL 已归一为 ""）逐格精确替换，产出批量
/// patch 与替换总处数。未命中的行不会出现在结果里。
pub fn collect_patches_from_rows(
    table: &TableMeta,
    rows: &[HashMap<String, String>],
    query: &str,
    replacement: &str,
    case_sensitive: bool,
) -> (Vec<UpdateRowPatch>, u64) {
    let identity = identity_columns(table);
    let mut patches = Vec::new();
    let mut occurrences = 0u64;
    for row in rows {
        let mut changes = Vec::new();
        for column in &table.columns {
            let name = column.column_name.as_str();
            let Some(value) = row.get(name) else { continue };
            let (next, count) = replace_text(value, query, replacement, case_sensitive);
            if count == 0 {
                continue;
            }
            occurrences += count;
            changes.push(CellUpdateChange {
                column_name: name.to_string(),
                old_value: Some(value.clone()),
                new_value: Some(next),
            });
        }
        if changes.is_empty() {
            continue;
        }
        let row_identity = identity
            .iter()
            .map(|name| ((*name).to_string(), row.get(*name).cloned()))
            .collect();
        patches.push(UpdateRowPatch {
            row_identity,
            changes,
        });
    }
    (patches, occurrences)
}

/// 构造候选行粗筛 WHERE。非 ASCII 查询在大小写不敏感时返回 `None`
/// （MySQL `LOWER` 不折叠非 ASCII，粗筛会漏命中，退化为全表扫描）。
fn replace_filter_where(table: &TableMeta, query: &str, case_sensitive: bool) -> Option<(String, Vec<String>)> {
    if !case_sensitive && !query.is_ascii() {
        return None;
    }
    let pattern = if case_sensitive {
        db::escape_like_pattern(query)
    } else {
        db::escape_like_pattern(&query.to_lowercase())
    };
    let conditions = table
        .columns
        .iter()
        .map(|column| {
            let casted = format!("CAST(`{}` AS CHAR)", db::escape_ident(&column.column_name));
            if case_sensitive {
                format!("{casted} LIKE BINARY ? ESCAPE '\\\\'")
            } else {
                format!("LOWER({casted}) LIKE ? ESCAPE '\\\\'")
            }
        })
        .collect::<Vec<_>>();
    if conditions.is_empty() {
        return None;
    }
    let binds = conditions.iter().map(|_| pattern.clone()).collect();
    Some((format!(" WHERE ({})", conditions.join(" OR ")), binds))
}

/// 拉取全部可能命中的候选行（列值统一 CAST AS CHAR，NULL 归一为 ""，
/// 与表搜索扫描页的取值语义一致）。
pub async fn fetch_replace_candidate_rows(
    pool: &MySqlPool,
    database: &str,
    table: &TableMeta,
    query: &str,
    case_sensitive: bool,
) -> Result<Vec<HashMap<String, String>>, String> {
    let select_columns = table
        .columns
        .iter()
        .map(|column| {
            format!(
                "CAST(`{}` AS CHAR) AS `{}`",
                db::escape_ident(&column.column_name),
                db::escape_ident(&column.column_name)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let (where_sql, binds) = replace_filter_where(table, query, case_sensitive)
        .unwrap_or_else(|| (String::new(), Vec::new()));
    let sql = format!(
        "SELECT /*+ MAX_EXECUTION_TIME(30000) */ {} FROM {}{}",
        select_columns,
        db::qualified_table(database, &table.table_name),
        where_sql
    );
    let mut statement = sqlx::query(&sql);
    for bind in &binds {
        statement = statement.bind(bind);
    }
    let rows = statement
        .fetch_all(pool)
        .await
        .map_err(|error| format!("扫描替换候选行失败: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|row| {
            table
                .columns
                .iter()
                .map(|column| {
                    let value = row
                        .try_get::<Option<String>, _>(column.column_name.as_str())
                        .unwrap_or(None)
                        .unwrap_or_default();
                    (column.column_name.clone(), value)
                })
                .collect()
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_every_occurrence_case_insensitively() {
        assert_eq!(
            replace_text("abc_def_def", "DEF", "xyz", false),
            ("abc_xyz_xyz".to_string(), 2)
        );
        assert_eq!(
            replace_text("Hello hello HELLO", "hello", "hi", false),
            ("hi hi hi".to_string(), 3)
        );
    }

    #[test]
    fn honors_case_sensitive_matching() {
        assert_eq!(
            replace_text("Foo foo FOO", "foo", "bar", true),
            ("Foo bar FOO".to_string(), 1)
        );
    }

    #[test]
    fn empty_query_or_no_match_is_noop() {
        assert_eq!(replace_text("abc", "", "x", false), ("abc".to_string(), 0));
        assert_eq!(replace_text("abc", "zzz", "x", false), ("abc".to_string(), 0));
    }

    #[test]
    fn supports_deletion_and_adjacent_matches() {
        assert_eq!(replace_text("a-b-c", "-", "", false), ("abc".to_string(), 2));
        assert_eq!(replace_text("aaaa", "aa", "b", false), ("bb".to_string(), 2));
    }

    #[test]
    fn handles_unicode_with_expanding_lowercase() {
        // İ 小写化为两个 char（i +  combining dot），替换结果必须映射回原文。
        let (text, count) = replace_text("İxİ", "i̇", "y", false);
        assert_eq!(count, 2);
        assert_eq!(text, "yxy");
    }

    #[test]
    fn handles_cjk_content() {
        assert_eq!(
            replace_text("开服礼包-老玩家礼包", "礼包", "福利", false),
            ("开服福利-老玩家福利".to_string(), 2)
        );
    }

    #[test]
    fn collects_patches_only_for_matching_rows() {
        fn column(name: &str, primary: bool) -> crate::types::ColumnMeta {
            crate::types::ColumnMeta {
                column_name: name.to_string(),
                column_type: "varchar(64)".to_string(),
                column_comment: String::new(),
                is_primary_key: primary,
                is_nullable: true,
                data_type: Some("varchar".to_string()),
                character_maximum_length: Some(64),
                numeric_precision: None,
                numeric_scale: None,
                is_unsigned: false,
                is_auto_increment: false,
                enum_values: Vec::new(),
                set_values: Vec::new(),
                is_generated: false,
                default_value: None,
                default_mode: None,
            }
        }
        let table = TableMeta {
            table_name: "player".to_string(),
            table_comment: String::new(),
            columns: vec![column("id", true), column("name", false)],
        };
        let rows = vec![
            HashMap::from([
                ("id".to_string(), "1".to_string()),
                ("name".to_string(), "abc_def".to_string()),
            ]),
            HashMap::from([
                ("id".to_string(), "2".to_string()),
                ("name".to_string(), "无关".to_string()),
            ]),
        ];
        let (patches, occurrences) = collect_patches_from_rows(&table, &rows, "def", "xyz", false);
        assert_eq!(occurrences, 1);
        assert_eq!(patches.len(), 1);
        assert_eq!(patches[0].row_identity.get("id"), Some(&Some("1".to_string())));
        assert_eq!(patches[0].changes.len(), 1);
        assert_eq!(patches[0].changes[0].new_value, Some("abc_xyz".to_string()));
    }
}
