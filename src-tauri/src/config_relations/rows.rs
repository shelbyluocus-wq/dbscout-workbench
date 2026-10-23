//! Live lookups for one selected row: what each of its references points to,
//! and how many rows of other tables reference it. Always read from the
//! current data so edits show up immediately.

use std::collections::{BTreeMap, HashMap};

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

fn cell<'a>(row: &'a HashMap<String, String>, column: &str) -> Option<&'a str> {
    row.iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(column))
        .map(|(_, value)| value.trim())
}

/// Config tables use 0 / -1 / empty for "no reference".
fn is_empty_reference(value: &str) -> bool {
    matches!(value.trim(), "" | "0" | "-1" | "null" | "NULL" | "[]")
}

/// Keys the row references through one relation, in cell order.
pub fn reference_values(view: &RelationView, row: &HashMap<String, String>) -> Vec<String> {
    if !super::constraints::matches(&view.source_constraints, row) {
        return Vec::new();
    }
    let Some(value) = cell(row, &view.key.source_column) else {
        return Vec::new();
    };
    if let Some(parser) = &view.parser {
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
        let unparsed = super::constraints::matches(&view.source_constraints, row) && view.parser.as_ref().is_some_and(|parser| {
            cell(row, &view.key.source_column).is_some_and(|value| parser.values(value).is_none())
        });
        let mut values = reference_values(view, row);
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
}
