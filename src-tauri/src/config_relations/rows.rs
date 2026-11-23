//! Live lookups for one selected row: what each of its references points to,
//! and how many rows of other tables reference it. Always read from the
//! current data so edits show up immediately.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use sqlx::{MySqlPool, Row};

use crate::db::{escape_ident, qualified_table};
use crate::mysql_text;

use super::catalog::DbSnapshot;
use super::filter::{list_item_values, reference_predicate};
use super::formats::ITEM_KEY;
use super::model::{RelationKind, RelationStatus, RelationView};
use super::parser::ReferenceParser;

const MAX_VALUES_PER_RELATION: usize = 50;
const MAX_LOOKUP_VALUES: usize = 500;
/// Keeps one wide aggregate from exceeding MySQL's select-list comfort zone.
const MAX_COUNTS_PER_QUERY: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetState {
    Found,
    Missing,
    /// The lookup failed, e.g. the target table was just dropped.
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowTarget {
    pub value: String,
    pub state: TargetState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowOutgoing {
    pub relation_id: String,
    pub targets: Vec<RowTarget>,
    /// More references exist than are listed.
    pub truncated: bool,
    /// The cell requires a parser we cannot safely evaluate.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unparsed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowIncoming {
    pub relation_id: String,
    /// The key of the selected row the counted rows point at.
    pub value: String,
    /// `None` when counting failed.
    pub count: Option<u64>,
}

const DEFAULT_AUDIT_MAX_ROWS: usize = 20_000;
const DEFAULT_AUDIT_MAX_ISSUES: usize = 500;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrokenReferenceIssue {
    pub relation_id: String,
    pub row_index: usize,
    pub row_identity: BTreeMap<String, Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_label: Option<String>,
    pub source_column: String,
    pub target_table: String,
    pub target_table_comment: String,
    pub target_column: String,
    pub missing_value: String,
    pub cell_preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableReferenceAudit {
    pub table: String,
    pub scanned_rows: usize,
    pub checked_relations: usize,
    pub checked_references: usize,
    pub broken_count: usize,
    pub rows_truncated: bool,
    pub issues_truncated: bool,
    pub issues: Vec<BrokenReferenceIssue>,
}

fn cell<'a>(row: &'a HashMap<String, String>, column: &str) -> Option<&'a str> {
    row.iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(column))
        .map(|(_, value)| value.trim())
}

/// Config tables use 0 / -1 / empty for "no reference".
fn is_empty_reference(value: &str) -> bool {
    matches!(value.trim(), "" | "0" | "-1" | "null" | "NULL" | "[]" | "{}")
}

/// Before background format sampling finishes (or when the sampled prefix was
/// empty), infer a parser directly from the live cell value so structured
/// arrays/lists aren't queried as one raw literal key.
fn infer_cell_parser(
    view: &RelationView,
    snapshot: &DbSnapshot,
    row: &HashMap<String, String>,
) -> Option<ReferenceParser> {
    if view.parser.is_some() {
        return None;
    }
    let value = cell(row, &view.key.source_column)?;
    if super::parser::empty(value) {
        return None;
    }
    let column = snapshot
        .table(&view.key.source_table)
        .and_then(|table| table.column(&view.key.source_column));
    if column.is_some_and(|col| !col.is_text()) {
        return None;
    }
    let comment = column.map(|col| col.comment.as_str()).unwrap_or("");
    super::formats::infer_parser(&[value], comment)
}

fn reference_values_with_parser(
    view: &RelationView,
    row: &HashMap<String, String>,
    parser: Option<&ReferenceParser>,
) -> Vec<String> {
    if !super::constraints::matches(&view.source_constraints, row) {
        return Vec::new();
    }
    let Some(value) = cell(row, &view.key.source_column) else {
        return Vec::new();
    };
    if let Some(parser) = parser {
        return parser.values(value).unwrap_or_default();
    }
    let values = match view.key.kind {
        RelationKind::Value => vec![value.to_string()],
        RelationKind::List => list_item_values(value, ITEM_KEY).unwrap_or_default(),
    };
    let mut unique = Vec::new();
    for value in values {
        if !is_empty_reference(&value) && !unique.contains(&value) {
            unique.push(value);
        }
    }
    unique
}

/// Keys the row references through one relation, in cell order.
pub fn reference_values(view: &RelationView, row: &HashMap<String, String>) -> Vec<String> {
    reference_values_with_parser(view, row, view.parser.as_ref())
}

/// The key of the row that incoming relations point at.
pub fn referenced_key(view: &RelationView, row: &HashMap<String, String>) -> Option<String> {
    cell(row, &view.key.target_column)
        .filter(|value| !is_empty_reference(value))
        .map(str::to_string)
}

fn active(relations: &[RelationView]) -> impl Iterator<Item = &RelationView> {
    relations
        .iter()
        .filter(|view| view.status != RelationStatus::Rejected)
}

type Labels = HashMap<String, Option<String>>;

fn row_target(value: String, fetched: Option<&(Option<Labels>, Vec<String>)>) -> RowTarget {
    let found = fetched
        .filter(|(_, queried)| queried.contains(&value))
        .and_then(|(labels, _)| labels.as_ref())
        .map(|labels| labels.get(&value.to_lowercase()).cloned());
    let (state, label) = match found {
        None => (TargetState::Unknown, None),
        Some(None) => (TargetState::Missing, None),
        Some(Some(label)) => (TargetState::Found, label),
    };
    RowTarget { value, state, label }
}

async fn lookup_targets(
    pool: &MySqlPool,
    database: &str,
    snapshot: &DbSnapshot,
    table: &str,
    column: &str,
    values: &[String],
) -> Result<Labels, String> {
    let meta = snapshot
        .table(table)
        .ok_or_else(|| format!("找不到表 {table}"))?;
    let label_sql = meta
        .label_column()
        .map(|label| format!(", MIN(CAST(`{}` AS CHAR)) AS relation_label", escape_ident(label)))
        .unwrap_or_default();
    let placeholders = vec!["?"; values.len()].join(", ");
    // Comparing the bare column keeps its index usable; keys are matched
    // back as text below, so loose numeric conversions cannot leak through.
    // Grouping keeps non-unique key columns (part of a composite key) to one
    // row per key.
    let sql = format!(
        "SELECT /*+ MAX_EXECUTION_TIME(10000) */ CAST(`{column}` AS CHAR) AS relation_key{label_sql} \
         FROM {table_ref} WHERE `{column}` IN ({placeholders}) GROUP BY `{column}`",
        column = escape_ident(column),
        table_ref = qualified_table(database, &meta.name),
    );
    let mut query = sqlx::query(&sql);
    for value in values {
        query = query.bind(value);
    }
    let rows = query
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取关联目标失败: {error}"))?;
    let mut labels = Labels::new();
    for row in rows {
        let key = mysql_text::string(&row, "relation_key").unwrap_or_default();
        let label = if label_sql.is_empty() {
            None
        } else {
            mysql_text::optional_string(&row, "relation_label")
                .ok()
                .flatten()
                .filter(|label| !label.trim().is_empty())
        };
        labels.entry(key.trim().to_lowercase()).or_insert(label);
    }
    Ok(labels)
}

/// `is_current` turning false stops further lookups; unresolved targets are
/// then reported as unknown.
pub async fn resolve_outgoing(
    pool: &MySqlPool,
    database: &str,
    snapshot: &DbSnapshot,
    relations: &[RelationView],
    row: &HashMap<String, String>,
    is_current: &(dyn Fn() -> bool + Sync),
) -> Vec<RowOutgoing> {
    let mut wanted: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    let mut plans = Vec::new();
    for view in active(relations) {
        let inferred = infer_cell_parser(view, snapshot, row);
        let parser = view.parser.as_ref().or(inferred.as_ref());
        let unparsed = super::constraints::matches(&view.source_constraints, row) && parser.is_some_and(|parser| {
            cell(row, &view.key.source_column).is_some_and(|value| parser.values(value).is_none())
        });
        let mut values = reference_values_with_parser(view, row, parser);
        let truncated = values.len() > MAX_VALUES_PER_RELATION;
        values.truncate(MAX_VALUES_PER_RELATION);
        let target = (view.key.target_table.clone(), view.key.target_column.clone());
        let bucket = wanted.entry(target.clone()).or_default();
        for value in &values {
            if bucket.len() < MAX_LOOKUP_VALUES && !bucket.contains(value) {
                bucket.push(value.clone());
            }
        }
        plans.push((view.id.clone(), values, truncated, target, unparsed));
    }
    let mut resolved: HashMap<(String, String), (Option<Labels>, Vec<String>)> = HashMap::new();
    for ((table, column), values) in wanted {
        if values.is_empty() || !is_current() {
            continue;
        }
        let labels = lookup_targets(pool, database, snapshot, &table, &column, &values)
            .await
            .ok();
        resolved.insert((table, column), (labels, values));
    }
    plans
        .into_iter()
        .map(|(relation_id, values, truncated, target, unparsed)| {
            let fetched = resolved.get(&target);
            let targets = values
                .into_iter()
                .map(|value| row_target(value, fetched))
                .collect();
            RowOutgoing {
                relation_id,
                targets,
                truncated,
                unparsed,
            }
        })
        .collect()
}

struct CountItem {
    relation_id: String,
    column: String,
    kind: RelationKind,
    parser: Option<ReferenceParser>,
    value: String,
    source_constraints: Vec<super::constraints::RowConstraint>,
}

async fn count_in_table(
    pool: &MySqlPool,
    database: &str,
    table: &str,
    items: &[CountItem],
) -> Result<Vec<u64>, String> {
    let mut selects = Vec::with_capacity(items.len());
    let mut binds = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let column = escape_ident(&item.column);
        let (mut predicate, mut values) = reference_predicate(
            &format!("CAST(`{column}` AS CHAR)"), item.kind == RelationKind::List,
            item.parser.as_ref(), ITEM_KEY, &item.value,
        );
        let (guard, guard_binds) = super::constraints::predicate(&item.source_constraints);
        if !guard.is_empty() { predicate = format!("({predicate}) AND ({guard})"); }
        values.extend(guard_binds);
        selects.push(format!("COUNT(CASE WHEN {predicate} THEN 1 END) AS n{index}"));
        binds.extend(values);
    }
    let sql = format!(
        "SELECT /*+ MAX_EXECUTION_TIME(10000) */ {} FROM {}",
        selects.join(", "),
        qualified_table(database, table)
    );
    let mut query = sqlx::query(&sql);
    for bind in &binds {
        query = query.bind(bind);
    }
    let row = query
        .fetch_one(pool)
        .await
        .map_err(|error| format!("统计引用失败: {error}"))?;
    (0..items.len())
        .map(|index| {
            row.try_get::<i64, _>(format!("n{index}").as_str())
                .map(|count| count.max(0) as u64)
                .map_err(|error| format!("统计引用失败: {error}"))
        })
        .collect()
}

/// `is_current` turning false stops further counting; uncounted relations
/// are reported with no count.
pub async fn count_incoming(
    pool: &MySqlPool,
    database: &str,
    snapshot: &DbSnapshot,
    relations: &[RelationView],
    row: &HashMap<String, String>,
    is_current: &(dyn Fn() -> bool + Sync),
) -> Vec<RowIncoming> {
    let mut groups: BTreeMap<String, Vec<CountItem>> = BTreeMap::new();
    let mut results = Vec::new();
    for view in active(relations) {
        let Some(value) = referenced_key(view, row) else {
            continue;
        };
        if view.parser == Some(ReferenceParser::Unsupported) {
            results.push(RowIncoming { relation_id: view.id.clone(), value, count: None });
            continue;
        }
        let column = snapshot
            .table(&view.key.source_table)
            .and_then(|table| Some((table.name.clone(), table.column(&view.key.source_column)?.name.clone())));
        let Some((table, column)) = column else {
            results.push(RowIncoming {
                relation_id: view.id.clone(),
                value,
                count: None,
            });
            continue;
        };
        groups.entry(table).or_default().push(CountItem {
            relation_id: view.id.clone(),
            column,
            kind: view.key.kind,
            parser: view.parser.clone(),
            value,
            source_constraints: view.source_constraints.clone(),
        });
    }
    for (table, items) in groups {
        for chunk in items.chunks(MAX_COUNTS_PER_QUERY) {
            let counts = if is_current() {
                count_in_table(pool, database, &table, chunk).await.ok()
            } else {
                None
            };
            for (position, item) in chunk.iter().enumerate() {
                results.push(RowIncoming {
                    relation_id: item.relation_id.clone(),
                    value: item.value.clone(),
                    count: counts.as_ref().map(|counts| counts[position]),
                });
            }
        }
    }
    results
}

fn truncate_preview(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let prefix = trimmed.chars().take(max_chars.saturating_sub(1)).collect::<String>();
    format!("{prefix}…")
}

/// Pure broken-reference detector over in-memory rows and known target key sets.
/// `existing_by_target` maps `(target_table_lower, target_column_lower)` to the
/// lowercased set of keys actually found in that target table; targets absent
/// from the map (e.g. failed lookup) are skipped rather than falsely flagged.
pub(crate) fn collect_broken_references(
    table_name: &str,
    primary_keys: &[String],
    label_column: Option<&str>,
    relations: &[RelationView],
    rows: &[HashMap<String, String>],
    existing_by_target: &HashMap<(String, String), HashSet<String>>,
    target_meta: &HashMap<String, (String, String)>,
    max_issues: usize,
    rows_truncated: bool,
) -> TableReferenceAudit {
    let active_relations = active(relations).collect::<Vec<_>>();
    let mut checked_references = 0usize;
    let mut broken_count = 0usize;
    let mut issues = Vec::new();
    let mut issues_truncated = false;

    for (row_index, row) in rows.iter().enumerate() {
        for view in &active_relations {
            let target_key = (
                view.key.target_table.to_lowercase(),
                view.key.target_column.to_lowercase(),
            );
            let Some(existing) = existing_by_target.get(&target_key) else {
                continue;
            };
            let values = reference_values(view, row);
            if values.is_empty() {
                continue;
            }
            for value in values {
                checked_references += 1;
                if existing.contains(&value.to_lowercase()) {
                    continue;
                }
                broken_count += 1;
                if issues.len() >= max_issues {
                    issues_truncated = true;
                    continue;
                }
                let mut row_identity = BTreeMap::new();
                for pk in primary_keys {
                    let pk_val = row
                        .iter()
                        .find(|(k, _)| k.eq_ignore_ascii_case(pk))
                        .map(|(_, v)| v.clone());
                    row_identity.insert(pk.clone(), pk_val);
                }
                let row_label = label_column.and_then(|col| {
                    cell(row, col)
                        .filter(|val| !val.is_empty())
                        .map(|val| truncate_preview(val, 48))
                });
                let raw_cell = cell(row, &view.key.source_column).unwrap_or("");
                let (resolved_target_name, target_table_comment) = target_meta
                    .get(&view.key.target_table.to_lowercase())
                    .cloned()
                    .unwrap_or_else(|| (view.key.target_table.clone(), String::new()));
                issues.push(BrokenReferenceIssue {
                    relation_id: view.id.clone(),
                    row_index,
                    row_identity,
                    row_label,
                    source_column: view.key.source_column.clone(),
                    target_table: resolved_target_name,
                    target_table_comment,
                    target_column: view.key.target_column.clone(),
                    missing_value: value,
                    cell_preview: truncate_preview(raw_cell, 80),
                });
            }
        }
    }

    TableReferenceAudit {
        table: table_name.to_string(),
        scanned_rows: rows.len(),
        checked_relations: active_relations.len(),
        checked_references,
        broken_count,
        rows_truncated,
        issues_truncated,
        issues,
    }
}

pub async fn audit_table_references(
    pool: &MySqlPool,
    database: &str,
    snapshot: &DbSnapshot,
    table_name: &str,
    relations: &[RelationView],
    max_rows: Option<usize>,
    max_issues: Option<usize>,
) -> Result<TableReferenceAudit, String> {
    let meta = snapshot
        .table(table_name)
        .ok_or_else(|| format!("找不到表 {table_name}"))?;
    let mut active_relations = active(relations).cloned().collect::<Vec<_>>();
    if active_relations.is_empty() {
        return Ok(TableReferenceAudit {
            table: meta.name.clone(),
            scanned_rows: 0,
            checked_relations: 0,
            checked_references: 0,
            broken_count: 0,
            rows_truncated: false,
            issues_truncated: false,
            issues: Vec::new(),
        });
    }

    let safe_max_rows = max_rows.unwrap_or(DEFAULT_AUDIT_MAX_ROWS).clamp(1, 50_000);
    let safe_max_issues = max_issues.unwrap_or(DEFAULT_AUDIT_MAX_ISSUES).clamp(1, 2_000);

    // Select only the minimal columns needed: primary keys, optional label column,
    // relation source columns, and discriminator constraint columns.
    let mut select_cols: Vec<String> = Vec::new();
    let mut seen_cols: HashSet<String> = HashSet::new();
    let mut push_col = |name: &str| {
        if let Some(col) = meta.column(name) {
            let lower = col.name.to_lowercase();
            if seen_cols.insert(lower) {
                select_cols.push(col.name.clone());
            }
        }
    };
    for pk in &meta.primary_keys {
        push_col(pk);
    }
    let label_column = meta.label_column().map(str::to_string);
    if let Some(ref lbl) = label_column {
        push_col(lbl);
    }
    for view in &active_relations {
        push_col(&view.key.source_column);
        for constraint in &view.source_constraints {
            push_col(&constraint.column);
        }
    }
    if select_cols.is_empty() {
        return Ok(TableReferenceAudit {
            table: meta.name.clone(),
            scanned_rows: 0,
            checked_relations: active_relations.len(),
            checked_references: 0,
            broken_count: 0,
            rows_truncated: false,
            issues_truncated: false,
            issues: Vec::new(),
        });
    }

    let select_sql = select_cols
        .iter()
        .map(|col| format!("CAST(`{0}` AS CHAR) AS `{0}`", escape_ident(col)))
        .collect::<Vec<_>>()
        .join(", ");
    let order_sql = if meta.primary_keys.is_empty() {
        String::new()
    } else {
        format!(
            " ORDER BY {}",
            meta.primary_keys
                .iter()
                .map(|pk| format!("`{}` ASC", escape_ident(pk)))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let sql = format!(
        "SELECT /*+ MAX_EXECUTION_TIME(15000) */ {select_sql} FROM {}{order_sql} LIMIT ?",
        qualified_table(database, &meta.name)
    );
    let raw_rows = sqlx::query(&sql)
        .bind((safe_max_rows + 1) as i64)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("扫描表引用数据失败: {error}"))?;

    let rows_truncated = raw_rows.len() > safe_max_rows;
    let rows = raw_rows
        .into_iter()
        .take(safe_max_rows)
        .map(|row| {
            let mut map = HashMap::with_capacity(select_cols.len());
            for col in &select_cols {
                if let Ok(Some(val)) = mysql_text::optional_string(&row, col.as_str()) {
                    map.insert(col.clone(), val);
                }
            }
            map
        })
        .collect::<Vec<_>>();

    // If background format sampling has not finished yet, infer missing parsers
    // from the rows already loaded for this audit so structured cells aren't
    // reported as missing literal keys.
    for view in &mut active_relations {
        if view.parser.is_some() {
            continue;
        }
        let Some(col) = meta.column(&view.key.source_column).filter(|col| col.is_text()) else {
            continue;
        };
        let filled = rows
            .iter()
            .filter_map(|row| cell(row, &view.key.source_column))
            .filter(|value| !super::parser::empty(value))
            .take(200)
            .collect::<Vec<_>>();
        if !filled.is_empty() {
            view.parser = super::formats::infer_parser(&filled, &col.comment);
        }
    }

    // Gather all unique referenced values per (target_table, target_column).
    let mut wanted: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    let mut wanted_seen: HashMap<(String, String), HashSet<String>> = HashMap::new();
    let mut target_meta: HashMap<String, (String, String)> = HashMap::new();

    for view in &active_relations {
        let t_lower = view.key.target_table.to_lowercase();
        if !target_meta.contains_key(&t_lower) {
            if let Some(t) = snapshot.table(&view.key.target_table) {
                target_meta.insert(t_lower.clone(), (t.name.clone(), t.comment.clone()));
            }
        }
        let bucket_key = (t_lower, view.key.target_column.to_lowercase());
        let seen = wanted_seen.entry(bucket_key.clone()).or_default();
        let bucket = wanted.entry(bucket_key).or_default();
        for row in &rows {
            for val in reference_values(view, row) {
                if seen.insert(val.to_lowercase()) {
                    bucket.push(val);
                }
            }
        }
    }

    // Batch-check target key existence in chunks of MAX_LOOKUP_VALUES (500).
    let mut existing_by_target: HashMap<(String, String), HashSet<String>> = HashMap::new();
    for ((target_table, target_column), values) in wanted {
        let mut found_keys = HashSet::new();
        let mut lookup_failed = false;
        for chunk in values.chunks(MAX_LOOKUP_VALUES) {
            match lookup_targets(pool, database, snapshot, &target_table, &target_column, chunk).await {
                Ok(labels) => {
                    found_keys.extend(labels.into_keys());
                }
                Err(_) => {
                    lookup_failed = true;
                    break;
                }
            }
        }
        if !lookup_failed {
            existing_by_target.insert((target_table, target_column), found_keys);
        }
    }

    Ok(collect_broken_references(
        &meta.name,
        &meta.primary_keys,
        label_column.as_deref(),
        &active_relations,
        &rows,
        &existing_by_target,
        &target_meta,
        safe_max_issues,
        rows_truncated,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_relations::model::{RelationKey, StatusReason};

    fn view(column: &str, kind: RelationKind) -> RelationView {
        RelationView {
            id: format!("rewardprop.{column}>goodsprop.id"),
            key: RelationKey {
                source_table: "rewardprop".into(),
                source_column: column.into(),
                target_table: "goodsprop".into(),
                target_column: "ID".into(),
                kind,
            },
            status: RelationStatus::Unconfirmed,
            parser: None,
            source_constraints: Vec::new(),
            reason: StatusReason::CodeOnly,
            is_new: false,
            evidence: Vec::new(),
            code_target: None,
            decided_at: None,
            disagreeing_code: Default::default(),
        }
    }

    #[test]
    fn reference_values_skip_empty_markers_and_duplicates() {
        let row = HashMap::from([
            ("ItemID".to_string(), " 1001 ".to_string()),
            ("Empty".to_string(), "0".to_string()),
            ("Items".to_string(), r#"[{"ID":7,"Num":1},{"ID":7,"Num":2},{"ID":0,"Num":1},{"ID":"8","Num":1}]"#.to_string()),
        ]);
        assert_eq!(reference_values(&view("itemid", RelationKind::Value), &row), vec!["1001"]);
        assert!(reference_values(&view("Empty", RelationKind::Value), &row).is_empty());
        assert!(reference_values(&view("Missing", RelationKind::Value), &row).is_empty());
        assert_eq!(reference_values(&view("Items", RelationKind::List), &row), vec!["7", "8"]);
    }

    #[test]
    fn referenced_key_reads_the_target_column() {
        let row = HashMap::from([("id".to_string(), "1001".to_string())]);
        assert_eq!(referenced_key(&view("ItemID", RelationKind::Value), &row).as_deref(), Some("1001"));
        let empty = HashMap::from([("ID".to_string(), "".to_string())]);
        assert!(referenced_key(&view("ItemID", RelationKind::Value), &empty).is_none());
    }

    #[test]
    fn source_discriminator_applies_before_extracting_a_key() {
        let mut view = view("Param1", RelationKind::Value);
        view.source_constraints = vec![super::super::constraints::RowConstraint {
            column: "Kind".into(), values: vec!["3".into()],
        }];
        let mut row = HashMap::from([("Param1".into(), "11".into()), ("Kind".into(), "1".into())]);
        assert!(reference_values(&view, &row).is_empty());
        row.insert("Kind".into(), "3".into());
        assert_eq!(reference_values(&view, &row), ["11"]);
    }

    #[tokio::test]
    async fn incoming_relations_are_never_silently_truncated() {
        let pool = sqlx::mysql::MySqlPoolOptions::new().connect_lazy("mysql://localhost/test").unwrap();
        let mut relations = vec![view("ItemID", RelationKind::Value); 350];
        for (index, relation) in relations.iter_mut().enumerate() { relation.id = format!("relation-{index}"); }
        let result = count_incoming(&pool, "test", &DbSnapshot::default(), &relations,
            &HashMap::from([("ID".into(), "7".into())]), &|| false).await;
        assert_eq!(result.len(), 350);
        assert!(result.iter().all(|entry| entry.count.is_none()));
    }

    #[test]
    fn only_successfully_queried_keys_can_be_missing() {
        let fetched = (
            Some(HashMap::from([("1".into(), Some("Gold".into()))])),
            vec!["1".into(), "2".into()],
        );
        assert_eq!(row_target("1".into(), Some(&fetched)).state, TargetState::Found);
        assert_eq!(row_target("2".into(), Some(&fetched)).state, TargetState::Missing);
        assert_eq!(row_target("3".into(), Some(&fetched)).state, TargetState::Unknown,
            "a key omitted by the lookup cap was never checked");
        assert_eq!(row_target("1".into(), None).state, TargetState::Unknown);
        assert_eq!(row_target("1".into(), Some(&(None, vec!["1".into()]))).state, TargetState::Unknown);
    }

    #[test]
    fn collect_broken_references_detects_missing_ids_and_respects_constraints_and_caps() {
        let mut cond_view = view("Param1", RelationKind::Value);
        cond_view.source_constraints = vec![super::super::constraints::RowConstraint {
            column: "Kind".into(),
            values: vec!["2".into()],
        }];
        let mut rejected_view = view("Ignored", RelationKind::Value);
        rejected_view.status = RelationStatus::Rejected;

        let relations = vec![
            view("Items", RelationKind::List),
            cond_view,
            rejected_view,
        ];
        let rows = vec![
            HashMap::from([
                ("ID".into(), "10".into()),
                ("Name".into(), "新春礼盒".into()),
                ("Kind".into(), "2".into()),
                ("Param1".into(), "9999".into()),
                ("Items".into(), r#"[{"ID":61001,"Num":5},{"ID":88888,"Num":1}]"#.into()),
                ("Ignored".into(), "77777".into()),
            ]),
            HashMap::from([
                ("ID".into(), "11".into()),
                ("Name".into(), "普通礼包".into()),
                ("Kind".into(), "1".into()),
                ("Param1".into(), "9999".into()),
                ("Items".into(), r#"[{"ID":61001,"Num":1},{"ID":0,"Num":1}]"#.into()),
            ]),
        ];
        let existing = HashMap::from([(
            ("goodsprop".into(), "id".into()),
            HashSet::from(["61001".into()]),
        )]);
        let meta = HashMap::from([("goodsprop".into(), ("goodsprop".into(), "道具表".into()))]);

        let audit = collect_broken_references(
            "rewardprop",
            &["ID".into()],
            Some("Name"),
            &relations,
            &rows,
            &existing,
            &meta,
            1,
            false,
        );
        assert_eq!(audit.scanned_rows, 2);
        assert_eq!(audit.checked_relations, 2);
        assert_eq!(audit.checked_references, 4);
        assert_eq!(audit.broken_count, 2);
        assert_eq!(audit.issues_truncated, true);
        assert_eq!(audit.issues.len(), 1);
        assert_eq!(audit.issues[0].missing_value, "88888");
        assert_eq!(audit.issues[0].source_column, "Items");
        assert_eq!(audit.issues[0].row_label.as_deref(), Some("新春礼盒"));
        assert_eq!(audit.issues[0].target_table_comment, "道具表");
        assert_eq!(audit.issues[0].row_identity.get("ID"), Some(&Some("10".into())));
    }

    #[tokio::test]
    async fn resolve_outgoing_infers_json_and_unsupported_parsers_before_format_sampling() {
        use crate::config_relations::catalog::test_support::{snapshot, table};
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .connect_lazy("mysql://localhost/test")
            .unwrap();
        let schema = snapshot(vec![
            table(
                "rewardprop",
                &[
                    ("ID", "int", "", true),
                    ("GoodsIDs", "json", "引用goodsprop.ID", false),
                    ("Items", "text", "引用goodsprop.ID", false),
                    ("Dynamic", "text", "引用goodsprop.ID", false),
                    ("SingleID", "int", "引用goodsprop.ID", false),
                ],
            ),
            table("goodsprop", &[("ID", "int", "", true)]),
        ]);
        let relations = vec![
            view("GoodsIDs", RelationKind::Value),
            view("Items", RelationKind::Value),
            view("Dynamic", RelationKind::Value),
            view("SingleID", RelationKind::Value),
        ];
        let row = HashMap::from([
            ("GoodsIDs".into(), "[21001, 21002, 21003]".into()),
            ("Items".into(), r#"[{"ID": 61001, "Num": 2}]"#.into()),
            ("Dynamic".into(), "function(lv) { return lv; }".into()),
            ("SingleID".into(), "1001".into()),
        ]);

        // Cancel DB queries immediately via is_current=false; we still get the
        // extracted target values and unparsed flags produced before lookup.
        let result = resolve_outgoing(&pool, "test", &schema, &relations, &row, &|| false).await;
        assert_eq!(result.len(), 4);

        let goods_ids: Vec<&str> = result[0].targets.iter().map(|t| t.value.as_str()).collect();
        assert_eq!(goods_ids, vec!["21001", "21002", "21003"]);
        assert!(!result[0].unparsed);

        let items: Vec<&str> = result[1].targets.iter().map(|t| t.value.as_str()).collect();
        assert_eq!(items, vec!["61001"]);
        assert!(!result[1].unparsed);

        assert!(result[2].targets.is_empty());
        assert!(result[2].unparsed);

        let single: Vec<&str> = result[3].targets.iter().map(|t| t.value.as_str()).collect();
        assert_eq!(single, vec!["1001"]);
        assert!(!result[3].unparsed);
    }
}
