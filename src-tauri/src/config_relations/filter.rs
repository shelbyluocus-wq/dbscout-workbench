//! Row filter for config relations: "rows of this table whose column links to
//! these values". Used when jumping from one config row to related rows.

use std::collections::HashMap;

use serde_json::Value;

use crate::db::escape_ident;
use crate::types::{ColumnMeta, RelationFilter, RelationMatchKind, TablePageRequest};
use super::parser::ReferenceParser;

const MATCH_NOTHING_SQL: &str = "(1 = 0)";

fn active(relation: Option<&RelationFilter>) -> Option<&RelationFilter> {
    relation.filter(|relation| !relation.is_empty())
}

fn find_column<'a>(columns: &'a [ColumnMeta], name: &str) -> Option<&'a ColumnMeta> {
    let name = name.trim();
    columns
        .iter()
        .find(|column| column.column_name.eq_ignore_ascii_case(name))
}

/// Relation filters are only implemented for MySQL and demo data; other
/// engines must refuse them rather than silently return unfiltered rows.
pub fn ensure_engine_supports(request: &TablePageRequest) -> Result<(), String> {
    let relation = request
        .filter
        .as_ref()
        .and_then(|filter| active(filter.relation.as_ref()));
    if relation.is_some() {
        return Err("关联筛选只支持 MySQL 配置库".into());
    }
    Ok(())
}

/// MySQL predicate (wrapped in parentheses) plus its bound values.
pub fn sql_clause(
    columns: &[ColumnMeta],
    relation: Option<&RelationFilter>,
) -> Option<(String, Vec<String>)> {
    let relation = active(relation)?;
    if relation.source_constraints.iter().any(|guard| find_column(columns, &guard.column).is_none()) {
        return Some((MATCH_NOTHING_SQL.into(), Vec::new()));
    }
    let (mut sql, mut binds) = value_clause(columns, Some(relation))?;
    let (guard, parameters) = super::constraints::predicate(&relation.source_constraints);
    if !guard.is_empty() { sql = format!("({sql} AND ({guard}))"); }
    binds.extend(parameters);
    Some((sql, binds))
}

fn value_clause(columns: &[ColumnMeta], relation: Option<&RelationFilter>) -> Option<(String, Vec<String>)> {
    let relation = active(relation)?;
    let values = relation.normalized_values();
    let Some(column) = find_column(columns, &relation.column) else {
        return Some((MATCH_NOTHING_SQL.into(), Vec::new()));
    };
    if values.is_empty() {
        return Some((MATCH_NOTHING_SQL.into(), Vec::new()));
    }
    let column_sql = format!("CAST(`{}` AS CHAR)", escape_ident(&column.column_name));
    if let Some(parser) = &relation.parser {
        let mut predicates = Vec::new();
        let mut binds = Vec::new();
        for value in values {
            let (predicate, parameters) = parser.predicate(&column_sql, &value);
            predicates.push(predicate);
            binds.extend(parameters);
        }
        return Some((format!("({})", predicates.join(" OR ")), binds));
    }
    match relation.kind {
        RelationMatchKind::Equals => {
            let placeholders = vec!["?"; values.len()].join(", ");
            Some((format!("({column_sql} IN ({placeholders}))"), values))
        }
        RelationMatchKind::ListContains => {
            let item_key = relation.item_key();
            let predicates = values
                .iter()
                .map(|_| format!("{column_sql} REGEXP ?"))
                .collect::<Vec<_>>()
                .join(" OR ");
            let binds = values
                .iter()
                .map(|value| list_item_pattern(item_key, value))
                .collect();
            Some((format!("({predicates})"), binds))
        }
    }
}

pub fn reference_predicate(column: &str, list: bool, parser: Option<&ReferenceParser>,
                           item_key: &str, value: &str) -> (String, Vec<String>) {
    if let Some(parser) = parser {
        parser.predicate(column, value)
    } else if list {
        (format!("{column} REGEXP ?"), vec![list_item_pattern(item_key, value)])
    } else {
        (format!("{column} = ?"), vec![value.to_string()])
    }
}

/// Regular expression matching one complete `"<key>": <value>` JSON member,
/// with the value optionally quoted. Rows it selects are a superset only when
/// the text is not valid JSON; valid JSON lists match exactly.
pub fn list_item_pattern(item_key: &str, value: &str) -> String {
    format!(
        "\"{}\"[[:space:]]*:[[:space:]]*\"?{}\"?[[:space:]]*[,}}]",
        escape_regex_literal(item_key),
        escape_regex_literal(value)
    )
}

fn escape_regex_literal(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if "\\^$.|?*+()[]{}".contains(ch) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

/// In-memory equivalent of [`sql_clause`] for demo and fixture rows.
pub fn row_matches(
    row: &HashMap<String, String>,
    columns: &[ColumnMeta],
    relation: Option<&RelationFilter>,
) -> bool {
    let Some(relation) = active(relation) else {
        return true;
    };
    if !super::constraints::matches(&relation.source_constraints, row) { return false; }
    let Some(column) = find_column(columns, &relation.column) else {
        return false;
    };
    let Some(cell) = row.get(&column.column_name) else {
        return false;
    };
    let values = relation.normalized_values();
    if let Some(parser) = &relation.parser {
        return parser.values(cell).is_some_and(|items| items.iter().any(|item| values.contains(item)));
    }
    match relation.kind {
        RelationMatchKind::Equals => values.iter().any(|value| value == cell.trim()),
        RelationMatchKind::ListContains => list_item_values(cell, relation.item_key())
            .is_some_and(|items| items.iter().any(|item| values.contains(item))),
    }
}

/// Values of `item_key` in a JSON list cell such as `[{"ID":1001,"Num":2}]`.
/// Returns `None` when the text is not a JSON list of objects.
pub fn list_item_values(text: &str, item_key: &str) -> Option<Vec<String>> {
    let trimmed = text.trim();
    if !trimmed.starts_with('[') {
        return None;
    }
    let Value::Array(items) = serde_json::from_str::<Value>(trimmed).ok()? else {
        return None;
    };
    let mut values = Vec::new();
    for item in items {
        let Value::Object(object) = item else {
            return None;
        };
        let found = object
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(item_key))
            .map(|(_, value)| value);
        match found {
            Some(Value::Number(number)) => values.push(number.to_string()),
            Some(Value::String(text)) if !text.trim().is_empty() => {
                values.push(text.trim().to_string())
            }
            _ => {}
        }
    }
    Some(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TablePageFilter;

    fn columns() -> Vec<ColumnMeta> {
        vec![
            ColumnMeta::with_basic("ID", "int", "", true, false),
            ColumnMeta::with_basic("Reward", "text", "", false, true),
        ]
    }

    fn relation(column: &str, kind: RelationMatchKind, values: &[&str]) -> RelationFilter {
        RelationFilter {
            column: column.into(),
            kind,
            values: values.iter().map(|value| value.to_string()).collect(),
            item_key: None,
            parser: None,
            source_constraints: Vec::new(),
        }
    }

    #[test]
    fn equals_clause_binds_each_distinct_value() {
        let filter = relation("id", RelationMatchKind::Equals, &["1001", " 1001 ", "1002"]);
        let (sql, binds) = sql_clause(&columns(), Some(&filter)).unwrap();
        assert_eq!(sql, "(CAST(`ID` AS CHAR) IN (?, ?))");
        assert_eq!(binds, vec!["1001", "1002"]);
    }

    #[test]
    fn overloaded_parameters_keep_discriminators_in_counts_and_tabs() {
        let mut filter = relation("ID", RelationMatchKind::Equals, &["11"]);
        filter.source_constraints = vec![super::super::constraints::RowConstraint {
            column: "Kind".into(), values: vec!["3".into()],
        }];
        assert_eq!(sql_clause(&columns(), Some(&filter)).unwrap().0, MATCH_NOTHING_SQL);
        let mut columns = columns();
        columns.push(ColumnMeta::with_basic("Kind", "int", "", false, false));
        let (sql, binds) = sql_clause(&columns, Some(&filter)).unwrap();
        assert!(sql.contains("AND (BINARY TRIM(CAST(`Kind` AS CHAR)) IN (?))"));
        assert_eq!(binds, ["11", "3"]);
        assert!(!row_matches(&HashMap::from([("ID".into(), "11".into()), ("Kind".into(), "1".into())]), &columns, Some(&filter)));
        assert!(row_matches(&HashMap::from([("ID".into(), "11".into()), ("Kind".into(), "3".into())]), &columns, Some(&filter)));
        assert!(row_matches(&HashMap::from([("ID".into(), "11".into()), ("Kind".into(), " 3 ".into())]), &columns, Some(&filter)));
    }

    #[test]
    fn list_clause_matches_whole_json_members() {
        let filter = relation("Reward", RelationMatchKind::ListContains, &["7"]);
        let (sql, binds) = sql_clause(&columns(), Some(&filter)).unwrap();
        assert_eq!(sql, "(CAST(`Reward` AS CHAR) REGEXP ?)");
        assert_eq!(
            binds,
            vec!["\"ID\"[[:space:]]*:[[:space:]]*\"?7\"?[[:space:]]*[,}]"]
        );
        assert_eq!(list_item_pattern("ID", "1.5"), "\"ID\"[[:space:]]*:[[:space:]]*\"?1\\.5\"?[[:space:]]*[,}]");
    }

    #[test]
    fn unknown_column_or_empty_values_match_nothing() {
        let missing = relation("Nope", RelationMatchKind::Equals, &["1"]);
        assert_eq!(sql_clause(&columns(), Some(&missing)).unwrap().0, MATCH_NOTHING_SQL);
        let empty = relation("ID", RelationMatchKind::Equals, &[" "]);
        assert_eq!(sql_clause(&columns(), Some(&empty)).unwrap().0, MATCH_NOTHING_SQL);
        assert!(sql_clause(&columns(), None).is_none());
    }

    #[test]
    fn in_memory_matching_follows_the_sql_semantics() {
        let row = HashMap::from([
            ("ID".to_string(), "1001".to_string()),
            ("Reward".to_string(), r#"[{"ID":7,"Num":2},{"ID":"70","Num":1}]"#.to_string()),
        ]);
        let cols = columns();
        assert!(row_matches(&row, &cols, Some(&relation("ID", RelationMatchKind::Equals, &["1001"]))));
        assert!(!row_matches(&row, &cols, Some(&relation("ID", RelationMatchKind::Equals, &["100"]))));
        assert!(row_matches(&row, &cols, Some(&relation("reward", RelationMatchKind::ListContains, &["70"]))));
        assert!(!row_matches(&row, &cols, Some(&relation("Reward", RelationMatchKind::ListContains, &["2"]))));
        assert!(row_matches(&row, &cols, None));
    }

    #[test]
    fn list_values_require_a_json_list_of_objects() {
        assert_eq!(
            list_item_values(r#" [{"id":1,"Num":2},{"Num":3}] "#, "ID"),
            Some(vec!["1".to_string()])
        );
        assert_eq!(list_item_values("[1,2]", "ID"), None);
        assert_eq!(list_item_values("1001", "ID"), None);
        assert_eq!(list_item_values("[{bad", "ID"), None);
    }

    #[test]
    fn other_engines_reject_relation_filters() {
        let mut request = TablePageRequest::default();
        assert!(ensure_engine_supports(&request).is_ok());
        request.filter = Some(TablePageFilter {
            query: String::new(),
            columns: Vec::new(),
            mode: None,
            relation: Some(relation("ID", RelationMatchKind::Equals, &["1"])),
        });
        assert!(ensure_engine_supports(&request).is_err());
    }

    #[test]
    fn adapted_filters_share_the_incoming_count_predicate() {
        let parser = ReferenceParser::Keys { delimiter: ",".into() };
        let mut filter = relation("Reward", RelationMatchKind::ListContains, &["7"]);
        filter.parser = Some(parser.clone());
        let (sql, binds) = sql_clause(&columns(), Some(&filter)).unwrap();
        let (count_sql, count_binds) = reference_predicate("CAST(`Reward` AS CHAR)", false, Some(&parser), "ID", "7");
        assert_eq!(sql, format!("({count_sql})"));
        assert_eq!(binds, count_binds);
        assert!(row_matches(&HashMap::from([("Reward".into(), "70,7".into())]), &columns(), Some(&filter)));
        assert!(!row_matches(&HashMap::from([("Reward".into(), "70,17".into())]), &columns(), Some(&filter)));
    }
}
