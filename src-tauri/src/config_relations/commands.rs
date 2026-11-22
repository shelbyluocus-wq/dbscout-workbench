//! Tauri commands behind the inspector's relation page, the relation review
//! dialog and the client folder binding.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::work_scheduler::WorkClass;

use super::catalog::DbSnapshot;
use super::discovery::ClientCandidate;
use super::engine::{self, Overview};
use super::model::{RelationKey, RelationStatus, RelationView, TableCoverage};
use super::rows::{self, RowIncoming, RowOutgoing, TableReferenceAudit};
use super::store::Verdict;

const DEFAULT_CHANNEL: &str = "default";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeRequest {
    pub connection_id: String,
    pub database: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRequest {
    pub connection_id: String,
    pub database: String,
    pub table: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableAuditRequest {
    pub connection_id: String,
    pub database: String,
    pub table: String,
    #[serde(default)]
    pub max_rows: Option<usize>,
    #[serde(default)]
    pub max_issues: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowRequest {
    pub connection_id: String,
    pub database: String,
    pub table: String,
    /// Cell values of the selected row as the grid shows them.
    pub row: HashMap<String, Value>,
    /// Requests on one channel supersede each other; one per inspector.
    #[serde(default)]
    pub channel: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub connection_id: String,
    pub database: String,
    pub relation_ids: Vec<String>,
    /// `None` withdraws an earlier decision.
    #[serde(default)]
    pub verdict: Option<Verdict>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientPathRequest {
    pub connection_id: String,
    pub database: String,
    pub path: String,
}

/// Display data for a table named by a relation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableLabel {
    /// Table name in database case, used to open it.
    pub name: String,
    pub comment: String,
    /// Lowercase column name -> comment, for the columns the listed relations
    /// use that have one, so a field can show its comment on hover.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub columns: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRelations {
    pub outgoing: Vec<RelationView>,
    pub incoming: Vec<RelationView>,
    pub coverage: TableCoverage,
    /// Lowercase table name -> label, for every table named above.
    pub tables: BTreeMap<String, TableLabel>,
    pub revision: u64,
}

/// One relation without its evidence; enough to draw it on the relation graph.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub id: String,
    #[serde(flatten)]
    pub key: RelationKey,
    pub status: RelationStatus,
}

impl From<&RelationView> for GraphEdge {
    fn from(view: &RelationView) -> Self {
        Self {
            id: view.id.clone(),
            key: view.key.clone(),
            status: view.status,
        }
    }
}

/// Every relation of one database, for the relation graph.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationGraph {
    pub edges: Vec<GraphEdge>,
    /// Lowercase table name -> label, for every table named above.
    pub tables: BTreeMap<String, TableLabel>,
    pub revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowTargets {
    pub outgoing: Vec<RowOutgoing>,
    pub revision: u64,
    pub superseded: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowReferences {
    pub incoming: Vec<RowIncoming>,
    pub revision: u64,
    pub superseded: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewList {
    /// Relations still waiting for a person: stale and conflicting ones.
    pub items: Vec<RelationView>,
    pub tables: BTreeMap<String, TableLabel>,
    pub overview: Overview,
}

fn table_labels<'a>(snapshot: &DbSnapshot, views: impl Iterator<Item = &'a RelationView>) -> BTreeMap<String, TableLabel> {
    let mut labels: BTreeMap<String, TableLabel> = BTreeMap::new();
    for view in views {
        let ends = [
            (&view.key.source_table, &view.key.source_column),
            (&view.key.target_table, &view.key.target_column),
        ];
        for (table, column) in ends {
            let Some(meta) = snapshot.table(table) else {
                continue;
            };
            let label = labels.entry(table.clone()).or_insert_with(|| TableLabel {
                name: meta.name.clone(),
                comment: meta.comment.clone(),
                columns: BTreeMap::new(),
            });
            let lower = column.to_lowercase();
            if label.columns.contains_key(&lower) {
                continue;
            }
            if let Some(found) = meta.column(column).filter(|found| !found.comment.trim().is_empty()) {
                label.columns.insert(lower, found.comment.clone());
            }
        }
    }
    labels
}

/// Grid cells arrive as JSON scalars; SQL NULL means "no reference".
fn row_text(row: HashMap<String, Value>) -> HashMap<String, String> {
    row.into_iter()
        .filter_map(|(column, value)| {
            let text = match value {
                Value::Null => return None,
                Value::String(text) => text,
                Value::Bool(flag) => flag.to_string(),
                Value::Number(number) => number.to_string(),
                other => other.to_string(),
            };
            Some((column, text))
        })
        .collect()
}

fn channel(kind: &str, channel: Option<&str>) -> String {
    let channel = channel.map(str::trim).filter(|channel| !channel.is_empty());
    format!("{kind}:{}", channel.unwrap_or(DEFAULT_CHANNEL))
}

#[tauri::command]
pub async fn config_relations_overview(app: AppHandle, request: ScopeRequest) -> Result<Overview, String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    engine::overview(&app, &context).await
}

#[tauri::command]
pub async fn config_relations_table(app: AppHandle, request: TableRequest) -> Result<TableRelations, String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    let (snapshot, index) = engine::index(&app, &context).await?;
    let outgoing = index.outgoing(&request.table);
    let incoming = index.incoming(&request.table);
    let tables = table_labels(&snapshot, outgoing.iter().chain(incoming.iter()));
    Ok(TableRelations {
        coverage: index.coverage(&request.table),
        outgoing,
        incoming,
        tables,
        revision: engine::revision(&context),
    })
}

#[tauri::command]
pub async fn config_relations_graph(app: AppHandle, request: ScopeRequest) -> Result<RelationGraph, String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    let (snapshot, index) = engine::index(&app, &context).await?;
    let views = index.all();
    Ok(RelationGraph {
        edges: views.iter().map(GraphEdge::from).collect(),
        tables: table_labels(&snapshot, views.iter()),
        revision: engine::revision(&context),
    })
}

#[tauri::command]
pub async fn config_relations_row_targets(app: AppHandle, request: RowRequest) -> Result<RowTargets, String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    let ticket = engine::row_ticket(&context, &channel("targets", request.channel.as_deref()));
    let (snapshot, index) = engine::index(&app, &context).await?;
    let relations = index.outgoing(&request.table);
    let row = row_text(request.row);
    let pool = engine::pool(&app, &context).await?;
    let is_current = || ticket.is_current();
    let outgoing = engine::run_db(&app, &context, WorkClass::Foreground, async {
        Ok(rows::resolve_outgoing(&pool, &context.database, &snapshot, &relations, &row, &is_current).await)
    })
    .await?;
    Ok(RowTargets {
        outgoing,
        revision: engine::revision(&context),
        superseded: !ticket.is_current(),
    })
}

#[tauri::command]
pub async fn config_relations_row_references(app: AppHandle, request: RowRequest) -> Result<RowReferences, String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    let ticket = engine::row_ticket(&context, &channel("references", request.channel.as_deref()));
    let (snapshot, index) = engine::index(&app, &context).await?;
    let relations = index.incoming(&request.table);
    let row = row_text(request.row);
    let pool = engine::pool(&app, &context).await?;
    let is_current = || ticket.is_current();
    // Counting scans whole tables, so it yields to grid paging.
    let incoming = engine::run_db(&app, &context, WorkClass::Background, async {
        Ok(rows::count_incoming(&pool, &context.database, &snapshot, &relations, &row, &is_current).await)
    })
    .await?;
    Ok(RowReferences {
        incoming,
        revision: engine::revision(&context),
        superseded: !ticket.is_current(),
    })
}

#[tauri::command]
pub async fn config_relations_audit_table(
    app: AppHandle,
    request: TableAuditRequest,
) -> Result<TableReferenceAudit, String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    let (snapshot, index) = engine::index(&app, &context).await?;
    let relations = index.outgoing(&request.table);
    let pool = engine::pool(&app, &context).await?;
    engine::run_db(&app, &context, WorkClass::Background, async {
        rows::audit_table_references(
            &pool,
            &context.database,
            &snapshot,
            &request.table,
            &relations,
            request.max_rows,
            request.max_issues,
        )
        .await
    })
    .await
}

#[tauri::command]
pub async fn config_relations_review_list(app: AppHandle, request: ScopeRequest) -> Result<ReviewList, String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    let (snapshot, index) = engine::index(&app, &context).await?;
    let items = index.open_items();
    let tables = table_labels(&snapshot, items.iter());
    Ok(ReviewList {
        items,
        tables,
        overview: engine::overview(&app, &context).await?,
    })
}

#[tauri::command]
pub async fn config_relations_review(app: AppHandle, request: ReviewRequest) -> Result<Overview, String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    engine::review(&app, &context, &request.relation_ids, request.verdict).await?;
    engine::overview(&app, &context).await
}

#[tauri::command]
pub async fn config_relations_refresh(app: AppHandle, request: ScopeRequest) -> Result<(), String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    engine::schedule_refresh(&app, &context, true);
    Ok(())
}

#[tauri::command]
pub async fn config_relations_discover_clients(
    app: AppHandle,
    request: ScopeRequest,
) -> Result<Vec<ClientCandidate>, String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    engine::discover_clients(&app, &context).await
}

#[tauri::command]
pub async fn config_relations_inspect_client(
    app: AppHandle,
    request: ClientPathRequest,
) -> Result<ClientCandidate, String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    engine::inspect_client(&app, &context, &request.path).await
}

#[tauri::command]
pub async fn config_relations_bind_client(app: AppHandle, request: ClientPathRequest) -> Result<Overview, String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    engine::bind_client(&app, &context, &request.path).await?;
    engine::overview(&app, &context).await
}

#[tauri::command]
pub async fn config_relations_unbind_client(app: AppHandle, request: ScopeRequest) -> Result<Overview, String> {
    let context = engine::resolve(&app, &request.connection_id, &request.database).await?;
    engine::unbind_client(&app, &context).await?;
    engine::overview(&app, &context).await
}

#[tauri::command]
pub async fn config_relations_pick_client_dir() -> Result<Option<String>, String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择游戏客户端工程目录")
        .pick_folder()
        .await;
    Ok(folder.map(|folder| folder.path().to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_text_keeps_scalars_and_drops_nulls() {
        let row = HashMap::from([
            ("ID".to_string(), Value::from(1001)),
            ("Name".to_string(), Value::from("铁剑")),
            ("Items".to_string(), Value::Null),
            ("Flag".to_string(), Value::from(true)),
        ]);
        let text = row_text(row);
        assert_eq!(text.get("ID").map(String::as_str), Some("1001"));
        assert_eq!(text.get("Name").map(String::as_str), Some("铁剑"));
        assert_eq!(text.get("Flag").map(String::as_str), Some("true"));
        assert!(!text.contains_key("Items"));
    }

    #[test]
    fn graph_edges_carry_the_key_and_status_but_no_evidence() {
        use super::super::model::{Evidence, RelationKind, StatusReason};
        let key = RelationKey {
            source_table: "hero".into(),
            source_column: "Skill_ID".into(),
            target_table: "skill".into(),
            target_column: "ID".into(),
            kind: RelationKind::List,
        };
        let view = RelationView {
            id: key.id(),
            key,
            status: RelationStatus::Stale,
            parser: None,
            source_constraints: Vec::new(),
            reason: StatusReason::CodeChanged,
            is_new: false,
            evidence: vec![Evidence::Comment { text: "技能".into() }],
            code_target: None,
            decided_at: None,
            disagreeing_code: Default::default(),
        };
        let json = serde_json::to_value(GraphEdge::from(&view)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "hero.skill_id[]>skill.id",
                "sourceTable": "hero",
                "sourceColumn": "Skill_ID",
                "targetTable": "skill",
                "targetColumn": "ID",
                "kind": "list",
                "status": "stale",
            })
        );
    }

    #[test]
    fn table_labels_carry_comments_of_the_columns_relations_use() {
        use super::super::catalog::test_support::{snapshot, table};
        use super::super::model::{RelationKind, StatusReason};
        let mut hero = table("Hero", &[("ID", "int", "英雄ID", true), ("Skill_ID", "int", "技能", false), ("Name", "varchar", "名称", false)]);
        hero.comment = "英雄表".into();
        let skill = table("skill", &[("ID", "int", "", true)]);
        let snapshot = snapshot(vec![hero, skill]);
        let key = RelationKey {
            source_table: "hero".into(),
            source_column: "skill_id".into(),
            target_table: "skill".into(),
            target_column: "ID".into(),
            kind: RelationKind::Value,
        };
        let view = RelationView {
            id: key.id(),
            key,
            status: RelationStatus::Confirmed,
            parser: None,
            source_constraints: Vec::new(),
            reason: StatusReason::MatchesCode,
            is_new: false,
            evidence: Vec::new(),
            code_target: None,
            decided_at: None,
            disagreeing_code: Default::default(),
        };
        let json = serde_json::to_value(table_labels(&snapshot, [view].iter())).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "hero": { "name": "Hero", "comment": "英雄表", "columns": { "skill_id": "技能" } },
                "skill": { "name": "skill", "comment": "" },
            })
        );
    }

    #[test]
    fn channels_are_separated_by_kind() {
        assert_eq!(channel("targets", None), "targets:default");
        assert_eq!(channel("targets", Some("  ")), "targets:default");
        assert_eq!(channel("references", Some("main")), "references:main");
    }
}
