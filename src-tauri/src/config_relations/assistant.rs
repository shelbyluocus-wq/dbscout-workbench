use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use crate::types::{AppState, RelationFilter, RelationMatchKind, TableMeta, TablePageFilter, TablePageRequest, TableSessionPage};
use crate::work_scheduler::WorkClass;
use super::assisted_rules::{RuleDraft, SavedRule, digest, value_signature, extract_keys};
use super::engine::{self, Context};
use super::model::{RelationStatus, RelationView};
use super::{commands, project_access, reference_scan};

pub const READ_TOOLS: &[&str] = &["get_relation_overview", "get_table_relations", "get_record_relations", "read_reference_rows", "get_relation_rules"];
pub const PROJECT_TOOLS: &[&str] = &["read_relation_code", "search_relation_code"];
pub const SCAN_TOOLS: &[&str] = &["start_reference_scan", "get_reference_scan", "control_reference_scan", "preview_relation_rule", "test_relation_rule_page"];
pub const RULE_TOOLS: &[&str] = &["apply_relation_rule"];

#[derive(Default)]
pub struct AssistantState {
    previews: Mutex<HashMap<String, Preview>>,
    pub scans: Mutex<HashMap<String, Arc<Mutex<reference_scan::ScanJob>>>>,
}

struct Preview {
    created: Instant,
    connection: String,
    database: String,
    rule: SavedRule,
    revision: u64,
    data_signature: String,
    applicable: bool,
    sample_offset: u64,
}

pub fn allowed(name: &str) -> bool {
    [READ_TOOLS, PROJECT_TOOLS, SCAN_TOOLS, RULE_TOOLS].iter().any(|tools| tools.contains(&name))
}

pub fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(Value::as_str).filter(|value| !value.trim().is_empty() && value.len() <= 4000).ok_or_else(|| format!("缺少有效的 {key}"))
}

pub fn integer(args: &Value, key: &str, default: u64, max: u64) -> Result<u64, String> {
    match args.get(key) {
        None => Ok(default),
        Some(value) => value.as_u64().filter(|value| *value <= max).ok_or_else(|| format!("{key} 必须是 0-{max} 的整数")),
    }
}

pub async fn context(app: &AppHandle, args: &Value) -> Result<Arc<Context>, String> {
    engine::resolve(app, text(args, "connectionId")?, text(args, "database")?).await
}

pub async fn page(app: &AppHandle, context: &Context, table: &str, offset: u64, limit: u32, relation: Option<RelationFilter>) -> Result<TableSessionPage, String> {
    cached_page(app,context,table,offset,limit,relation,&mut None).await
}

pub async fn cached_page(app: &AppHandle, context: &Context, table: &str, offset: u64, limit: u32, relation: Option<RelationFilter>, cached_meta: &mut Option<TableMeta>) -> Result<TableSessionPage, String> {
    let pool = engine::pool(app, context).await?;
    engine::run_db(app, context, WorkClass::Background, async {
        if cached_meta.as_ref().is_none_or(|meta| meta.table_name != table) {
            *cached_meta = Some(crate::db::read_schema(&pool, &context.database, table).await?);
        }
        crate::db::read_db_page_in_database(&pool, &context.database, cached_meta.as_ref().unwrap(), "mcp-relations", &TablePageRequest {
            page: Some(1), page_size: Some(limit), offset: Some(offset), include_total: Some(false),
            filter: relation.map(|relation| TablePageFilter { query: String::new(), columns: vec![], mode: None, relation: Some(relation), column_filters: Vec::new() }),
            sort: None,
        }).await
    }).await
}

pub fn row_identity(page: &TableSessionPage, row: &HashMap<String, String>) -> Option<BTreeMap<String, String>> {
    if page.primary_keys.is_empty() { return None; }
    page.primary_keys.iter().map(|key| row.get(key).map(|value| (key.clone(), value.clone()))).collect()
}

fn without_nulls(result: &TableSessionPage, position: usize) -> HashMap<String, String> {
    result.rows[position].iter().filter(|(column, _)| !result.null_cells.get(position).is_some_and(|columns| columns.contains(*column))).map(|(column, value)| (column.clone(), value.clone())).collect()
}

pub async fn record(app: &AppHandle, context: &Arc<Context>, table: &str, identity: &Value) -> Result<HashMap<String, String>, String> {
    let (snapshot, _) = engine::index(app, context).await?;
    let meta = snapshot.table(table).ok_or("表不存在")?;
    let identity = identity.as_object().ok_or("rowIdentity 必须为完整主键对象")?;
    if meta.primary_keys.is_empty() || identity.len() != meta.primary_keys.len() { return Err("请提供该表的全部主键，不能用部分主键定位".into()); }
    let mut guards = Vec::new();
    for key in &meta.primary_keys {
        let value = identity.get(key).ok_or_else(|| format!("缺少主键 {key}"))?;
        let value = match value {
            Value::String(value) if !value.is_empty() && value.trim() == value && value.len() <= 512 => value.clone(),
            Value::Number(value) if value.as_i64().is_some_and(|value| value.unsigned_abs() <= 9_007_199_254_740_991) => value.to_string(),
            _ => return Err("主键须为非空字符串或安全整数；大整数用字符串".into()),
        };
        guards.push(super::constraints::RowConstraint { column: key.clone(), values: vec![value] });
    }
    let predicates = guards.iter().map(|guard| format!("`{}` = ?",crate::db::escape_ident(&guard.column))).collect::<Vec<_>>().join(" AND ");
    let columns = meta.columns.iter().map(|column| {
        let column = crate::db::escape_ident(&column.name);
        format!("CAST(`{column}` AS CHAR) AS `{column}`")
    }).collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT /*+ MAX_EXECUTION_TIME(10000) */ {columns} FROM {} WHERE {predicates} LIMIT 2",crate::db::qualified_table(&context.database,&meta.name));
    let pool = engine::pool(app,context).await?;
    engine::run_db(app,context,WorkClass::Background,async {
        let mut query = sqlx::query(&sql);
        for guard in &guards { query = query.bind(&guard.values[0]); }
        let rows = query.fetch_all(&pool).await.map_err(|error| error.to_string())?;
        if rows.len()!=1 { return Err("主键未命中唯一记录，记录可能已被删除".into()); }
        let mut result = HashMap::new();
        for column in &meta.columns {
            if let Some(value) = crate::mysql_text::optional_string(&rows[0],column.name.as_str()).map_err(|error| error.to_string())? { result.insert(column.name.clone(),value); }
        }
        if !guards.iter().all(|guard| result.get(&guard.column) == Some(&guard.values[0])) { return Err("数据库宽松匹配结果与完整主键不一致".into()); }
        Ok(result)
    }).await
}

fn relation_filter(view: &RelationView, value: &str) -> RelationFilter {
    RelationFilter { column: view.key.source_column.clone(), values: vec![value.into()],
        kind: if view.parser.is_some() || view.key.kind == super::model::RelationKind::List { RelationMatchKind::ListContains } else { RelationMatchKind::Equals },
        parser: view.parser.clone(), source_constraints: view.source_constraints.clone(), item_key: None }
}

async fn read_references(app: &AppHandle, context: &Arc<Context>, args: &Value) -> Result<Value, String> {
    let (schema, index) = engine::index(app, context).await?;
    let revision = engine::revision(context);
    if args.get("revision").and_then(Value::as_u64).is_some_and(|expected| expected != revision) { return Err("关联依据已更新，请重新读取关联列表".into()); }
    let view = index.find(text(args, "relationId")?).ok_or("关联不存在")?;
    if view.status != RelationStatus::Confirmed || view.parser == Some(super::parser::ReferenceParser::Unsupported) { return Err("该关联尚未验证或无法解析，不返回伪造的零引用".into()); }
    let target = record(app, context, &view.key.target_table, &args["rowIdentity"]).await?;
    let value = target.get(&view.key.target_column).ok_or("目标字段为 NULL 或不存在，不能匹配引用")?;
    if super::parser::empty(value) { return Err("目标值是配置约定的空引用标记，不能据此认定零引用；可用候选扫描检查特殊用法".into()); }
    let offset = integer(args, "offset", 0, 9_007_199_254_740_991)?;
    let limit = integer(args, "limit", 50, 200)?.max(1) as u32;
    let source_table = schema.table(&view.key.source_table).ok_or("来源表已不存在，请刷新关联")?;
    let result = page(app, context, &source_table.name, offset, limit + 1, Some(relation_filter(view, value))).await?;
    let unique_target = schema.table(&view.key.target_table).is_some_and(|meta| meta.primary_keys.len() == 1 && meta.primary_keys[0].eq_ignore_ascii_case(&view.key.target_column));
    let mut mismatches = Vec::new();
    let consumed = result.rows.len().min(limit as usize);
    let include_row = args.get("includeRow").and_then(Value::as_bool)==Some(true);
    let matches = result.rows.iter().take(limit as usize).enumerate().filter_map(|(position, row)| {
        let cell = row.get(&view.key.source_column).cloned().unwrap_or_default();
        if !super::rows::reference_values(view, &without_nulls(&result,position)).contains(value) {
            mismatches.push(json!({"rowIdentity":row_identity(&result,row),"value":cell.chars().take(800).collect::<String>(),"valueTruncated":cell.chars().count()>800,"reason":"数据库筛选与本地解析不一致，未计为引用"}));
            return None;
        }
        let label = source_table.label_column().and_then(|column|row.get(column)).map(|label|label.chars().take(160).collect::<String>());
        Some(json!({"table":source_table.name,"column":view.key.source_column,"rowIdentity":row_identity(&result,row),"label":label,"value":cell.chars().take(800).collect::<String>(),"valueTruncated":cell.chars().count()>800,"row":if include_row { Some(row) } else { None },"nullColumns":result.null_cells.get(position),"relationId":view.id,"classification":if unique_target { "verifiedDirectReference" } else { "verifiedFieldReference" }}))
    }).collect::<Vec<_>>();
    Ok(json!({"matches":matches,"nextOffset":offset+consumed as u64,"hasMore":result.rows.len()>limit as usize,"parserMismatches":mismatches,"targetRecordUnambiguous":unique_target,
        "targetWarning":if unique_target { "" } else { "该字段不是单列主键；只证明字段值被引用，不能确定复合主键中的具体记录" },
        "revision":revision,"superseded":revision!=engine::revision(context),"scope":"direct references for this relation only","consistencyWarning":"实时分页不是事务快照；数据变化时需重查",
        "noPrimaryKey":result.primary_keys.is_empty()}))
}

async fn root(app: &AppHandle, context: &Context) -> Result<std::path::PathBuf, String> {
    engine::binding(app, &context.server_key).await?.map(|binding| binding.path.into()).ok_or("请先在黑猫关联设置中绑定客户端目录".into())
}

async fn rule_dependencies(app: &AppHandle, context: &Context, draft: &RuleDraft) -> Result<(BTreeMap<String, String>, String), String> {
    let binding = engine::binding(app, &context.server_key).await?;
    let signature = binding.as_ref().map(|binding| digest(binding.path.as_bytes())).unwrap_or_default();
    if draft.code_paths.is_empty() { return Ok((BTreeMap::new(), signature)); }
    if !crate::control_server::relation_permission(app, "project").await { return Err("请开启读取绑定项目代码权限".into()); }
    let root = binding.ok_or("未绑定客户端")?.path;
    let paths = draft.code_paths.clone();
    let hashes = tauri::async_runtime::spawn_blocking(move || project_access::fingerprints(std::path::Path::new(&root), &paths)).await.map_err(|error| error.to_string())??;
    Ok((hashes, signature))
}

async fn preview(app: &AppHandle, context: &Arc<Context>, args: &Value) -> Result<Value, String> {
    let mut draft: RuleDraft = serde_json::from_value(args["draft"].clone()).map_err(|error| format!("规则格式无效：{error}"))?;
    let book = engine::rule_book(app, context).await?;
    let sample_offset = integer(args,"sampleOffset",0,9_007_199_254_740_991)?;
    let (rule, result) = if draft.enabled {
        let snapshot = engine::fresh_snapshot(app, context).await?;
        let schema_signature = draft.validate(&snapshot)?;
        let (code_hashes, binding_signature) = rule_dependencies(app, context, &draft).await?;
        let result = page(app, context, &draft.source_table, sample_offset, 201, None).await?;
        (SavedRule { draft, schema_signature, code_hashes, binding_signature, saved_at:chrono::Utc::now().to_rfc3339() },Some(result))
    } else {
        let mut rule = book.rules.values().find(|rule| super::assisted_rules::same_endpoints(&rule.draft.key(),&draft.key())).cloned().ok_or("未找到可停用的本地规则")?;
        rule.draft.enabled = false;
        rule.saved_at = chrono::Utc::now().to_rfc3339();
        (rule,None)
    };
    let mut examples = Vec::new();
    let mut unparsed = 0;
    let mut parsed = 0;
    let mut extracted = 0;
    for (position, row) in result.iter().flat_map(|result| result.rows.iter()).take(200).enumerate() {
        let result = result.as_ref().unwrap();
        let draft = &rule.draft;
        if !super::constraints::matches(&draft.source_constraints, &without_nulls(result,position)) { continue; }
        let raw = row.get(&draft.source_column).map(String::as_str).unwrap_or("");
        let keys = if result.null_cells.get(position).is_some_and(|columns| columns.contains(&draft.source_column)) { Some(vec![]) } else { extract_keys(draft,raw) };
        if let Some(keys) = keys {
            parsed += 1;
            extracted += keys.len();
            if examples.len() < 10 { examples.push(json!({"rowIdentity":row_identity(&result,row),"raw":raw,"extractedKeys":keys})); }
        } else { unparsed += 1; }
    }
    let signature = result.as_ref().map(|result| value_signature((&result.rows,&result.null_cells))).transpose()?.unwrap_or_default();
    let applicable = !rule.draft.enabled || (unparsed == 0 && extracted > 0);
    let preview_id = uuid::Uuid::new_v4().to_string();
    let state = app.state::<AppState>();
    let mut previews = state.config_relations.assistant.previews.lock().await;
    previews.retain(|_, preview| preview.created.elapsed() < Duration::from_secs(900));
    if previews.len() >= 32 { return Err("待确认预览过多，请先处理或等待过期".into()); }
    let previous = book.rules.values().find(|existing| super::assisted_rules::same_endpoints(&existing.draft.key(),&rule.draft.key()));
    let response = json!({"previewId":preview_id,"expiresInSeconds":900,"rule":rule,"previous":previous,"sampleOffset":sample_offset,
        "testedRows":result.as_ref().map(|result|result.rows.len().min(200)).unwrap_or(0),"hasMoreRows":result.as_ref().is_some_and(|result|result.rows.len()>200),"parsedRows":parsed,"unparsedRows":unparsed,"extractedKeyCount":extracted,"examples":examples,
        "applicable":applicable,"blocker":if applicable { "" } else { "样本含未解析数据或没有符合条件的样本，不能直接启用规则" },
        "warnings":["仅验证所选窗口的 200 行解析，非全表通过或目标存在证明；请结合完整扫描和客户端依据确认","只修改当前库的本地关联规则，不修改数据库；最近 100 次变更可查；停用后恢复自动识别结果","仅追踪 codePaths 指定文件的变化；未绑定代码依据时不能发现实现变更；关联引擎后台刷新后显示待复核"],"revision":book.revision});
    previews.insert(preview_id, Preview { created:Instant::now(),connection:context.connection_id.clone(),database:context.database.clone(),rule,revision:book.revision,data_signature:signature,applicable,sample_offset });
    Ok(response)
}

async fn test_rule_page(app: &AppHandle, context: &Arc<Context>, args: &Value) -> Result<Value, String> {
    let mut draft: RuleDraft = serde_json::from_value(args["draft"].clone()).map_err(|error| error.to_string())?;
    let (snapshot, _) = engine::index(app, context).await?;
    draft.validate(&snapshot)?;
    let offset = integer(args,"offset",0,9_007_199_254_740_991)?;
    let limit = integer(args,"limit",50,200)?.max(1) as u32;
    let page = page(app,context,&draft.source_table,offset,limit+1,None).await?;
    let samples = page.rows.iter().take(limit as usize).enumerate().map(|(index,row)| {
        let applicable = super::constraints::matches(&draft.source_constraints,&without_nulls(&page,index));
        let raw = row.get(&draft.source_column).map(String::as_str).unwrap_or("");
        let is_null = page.null_cells.get(index).is_some_and(|columns| columns.contains(&draft.source_column));
        let keys = if !applicable || is_null { Some(vec![]) } else { extract_keys(&draft,raw) };
        json!({"rowIdentity":row_identity(&page,row),"raw":raw,"isNull":is_null,"applies":applicable,"extractedKeys":keys,"parsed":keys.is_some()})
    }).collect::<Vec<_>>();
    Ok(json!({"samples":samples,"nextOffset":offset+samples.len() as u64,"hasMore":page.rows.len()>limit as usize,
        "semanticVerified":false,"noPrimaryKey":page.primary_keys.is_empty(),"warning":"只验证解析结果；相同数字是否真为引用仍需代码/注释证据；实时分页不是事务快照"}))
}

async fn apply(app: &AppHandle, context: &Arc<Context>, args: &Value) -> Result<Value, String> {
    if args.get("confirmed").and_then(Value::as_bool) != Some(true) { return Err("必须取得用户对本次规则变更的确认".into()); }
    let state = app.state::<AppState>();
    let preview = state.config_relations.assistant.previews.lock().await.remove(text(args, "previewId")?).ok_or("预览不存在或已使用")?;
    if preview.created.elapsed() >= Duration::from_secs(900) || preview.connection != context.connection_id || preview.database != context.database { return Err("预览已过期或目标不一致，请重新预览".into()); }
    if !preview.applicable { return Err("预览存在阻断项，不能保存为启用规则".into()); }
    if preview.rule.draft.enabled {
        let snapshot = engine::fresh_snapshot(app, context).await?;
        let mut draft = preview.rule.draft.clone();
        if draft.validate(&snapshot)? != preview.rule.schema_signature { return Err("表结构已变化，请重新预览".into()); }
        let (hashes, binding_signature) = rule_dependencies(app, context, &draft).await?;
        if hashes != preview.rule.code_hashes || binding_signature != preview.rule.binding_signature { return Err("代码依据或绑定目录已变化，请重新预览".into()); }
        let rows = page(app, context, &draft.source_table, preview.sample_offset, 201, None).await?;
        if value_signature((&rows.rows, &rows.null_cells))? != preview.data_signature { return Err("验证样本已变化，请重新预览".into()); }
    }
    if !crate::control_server::relation_permission(app,"rules").await { return Err("规则修改权限已关闭".into()); }
    let refresh_warning = engine::save_rule(app, context, preview.rule, preview.revision).await?;
    Ok(json!({"saved":true,"revision":preview.revision+1,"databaseChanged":false,"refreshWarning":refresh_warning}))
}

fn sanitize_table(table: &mut commands::TableRelations, read_project: bool) {
    for view in table.outgoing.iter_mut().chain(table.incoming.iter_mut()) {
        for evidence in &mut view.evidence {
            match evidence {
                super::model::Evidence::Code { file, snippet, .. } => *snippet = if read_project && project_access::permitted_relative(file) { project_access::redact_text(snippet) } else { "[需要项目代码权限且文件须在允许范围内]".into() },
                super::model::Evidence::Rule { text } => *text = if read_project { project_access::redact_text(text) } else { "[规则依据需读取绑定项目代码权限]".into() },
                _ => {}
            }
        }
    }
    for gap in &mut table.coverage.gaps {
        if let super::model::CoverageGap::UntracedLookups { samples, .. } = gap {
            for sample in samples { sample.snippet = if read_project && project_access::permitted_relative(&sample.file) { project_access::redact_text(&sample.snippet) } else { "[需要项目代码权限且文件须在允许范围内]".into() }; }
        }
    }
}

fn sanitize_rule_value(value: &mut Value, read_project: bool) {
    match value {
        Value::Object(object) => for (key, value) in object.iter_mut() {
            match key.as_str() {
                "evidence" => *value = Value::String(if read_project { project_access::redact_text(value.as_str().unwrap_or_default()) } else { "[规则依据需读取绑定项目代码权限]".into() }),
                "codePaths" | "codeHashes" if !read_project => *value = Value::Null,
                _ => sanitize_rule_value(value, read_project),
            }
        },
        Value::Array(values) => for value in values { sanitize_rule_value(value,read_project); },
        _ => {}
    }
}

pub async fn run(app: &AppHandle, name: &str, args: Value) -> Result<Value, String> {
    let context = context(app, &args).await?;
    let scope = || commands::ScopeRequest { connection_id:context.connection_id.clone(),database:context.database.clone() };
    match name {
        "get_relation_overview" => serde_json::to_value(commands::config_relations_overview(app.clone(),scope()).await?).map_err(|error| error.to_string()),
        "get_table_relations" => {
            let mut table = commands::config_relations_table(app.clone(), commands::TableRequest { connection_id:context.connection_id.clone(),database:context.database.clone(),table:text(&args,"table")?.into() }).await?;
            sanitize_table(&mut table,crate::control_server::relation_permission(app,"project").await);
            Ok(serde_json::to_value(table).map_err(|error| error.to_string())?)
        }
        "get_record_relations" => {
            let table = text(&args,"table")?;
            let row = record(app,&context,table,&args["rowIdentity"]).await?;
            let (snapshot,index) = engine::index(app,&context).await?;
            let revision = engine::revision(&context);
            let outgoing = index.outgoing(table);
            let pool = engine::pool(app,&context).await?;
            let targets = engine::run_db(app,&context,WorkClass::Background,async {
                Ok(super::rows::resolve_outgoing(&pool,&context.database,&snapshot,&outgoing,&row,&|| true).await)
            }).await?;
            let mut relations = commands::config_relations_table(app.clone(),commands::TableRequest { connection_id:context.connection_id.clone(),database:context.database.clone(),table:table.into() }).await?;
            sanitize_table(&mut relations,crate::control_server::relation_permission(app,"project").await);
            Ok(json!({"outgoing":targets,"relations":relations,"revision":revision,"superseded":revision != relations.revision,"note":"目标存在不代表关联已确认，须同时检查 relations 中的状态；被引用记录按 incoming 逐条调用 read_reference_rows，不预先全库计数；间接使用须逐层追踪并去重"}))
        }
        "read_reference_rows" => read_references(app,&context,&args).await,
        "get_relation_rules" => {
            let book = engine::rule_book(app,&context).await?;
            let offset = integer(&args,"offset",0,500)? as usize;
            let limit = integer(&args,"limit",50,200)?.max(1) as usize;
            let selected = args.get("relationId").and_then(Value::as_str).map(|id| book.rules.get(id).ok_or("本地规则不存在")).transpose()?;
            let rules = book.rules.iter().filter(|(_,rule)| selected.is_none_or(|selected| super::assisted_rules::same_endpoints(&selected.draft.key(),&rule.draft.key()))).collect::<Vec<_>>();
            let entries = rules.iter().skip(offset).take(limit).map(|(id,rule)| json!({"id":id,"rule":rule})).collect::<Vec<_>>();
            let next = offset+entries.len();
            let history = if args.get("includeHistory").and_then(Value::as_bool)==Some(true) {
                Some(book.history.iter().filter(|change| selected.is_none_or(|selected| super::assisted_rules::same_endpoints(&selected.draft.key(),&change.current.draft.key()))).collect::<Vec<_>>())
            } else { None };
            let mut result = json!({"rules":entries,"history":history,"revision":book.revision,"totalRules":rules.len(),"nextOffset":next,"hasMore":next<rules.len(),"scope":"current database only; history contains last 100 changes; includeHistory defaults false"});
            sanitize_rule_value(&mut result,crate::control_server::relation_permission(app,"project").await);
            Ok(result)
        }
        "read_relation_code" | "search_relation_code" => {
            let root = root(app,&context).await?;
            let read_file = name == "read_relation_code";
            tauri::async_runtime::spawn_blocking(move || {
                if read_file { project_access::read_lines(&root,text(&args,"path")?,integer(&args,"startLine",1,1_000_000)? as usize,integer(&args,"limit",100,200)? as usize) }
                else { project_access::search(&root,text(&args,"keyword")?,args.get("cursor")) }
            }).await.map_err(|error| error.to_string())?
        }
        "preview_relation_rule" => {
            let mut result = preview(app,&context,&args).await?;
            sanitize_rule_value(&mut result,crate::control_server::relation_permission(app,"project").await);
            Ok(result)
        }
        "test_relation_rule_page" => test_rule_page(app,&context,&args).await,
        "apply_relation_rule" => apply(app,&context,&args).await,
        "start_reference_scan" | "get_reference_scan" | "control_reference_scan" => reference_scan::run(app,&context,name,&args).await,
        _ => Err("不支持的关联工具".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_history_does_not_leak_code_evidence_without_permission() {
        let original = json!({"ruleBook":{"rules":{"rule":{"draft":{"evidence":"const secret = 'hidden';\nread goods[id]","codePaths":["Reward.ts"]},"codeHashes":{"Reward.ts":"hash"}}},"history":[{"previous":{"draft":{"evidence":"old code","codePaths":["Old.ts"]}}}]}});
        let mut hidden = original.clone();
        sanitize_rule_value(&mut hidden,false);
        assert!(hidden["ruleBook"]["rules"]["rule"]["draft"]["codePaths"].is_null());
        assert!(hidden["ruleBook"]["rules"]["rule"]["codeHashes"].is_null());
        assert!(!hidden.to_string().contains("old code"));
        let mut allowed = original;
        sanitize_rule_value(&mut allowed,true);
        assert_eq!(allowed["ruleBook"]["rules"]["rule"]["draft"]["evidence"],"[敏感内容已隐藏]\nread goods[id]");
    }

    #[test]
    fn incoming_legacy_lists_keep_list_matching_and_constraints() {
        let view = RelationView { id:"r".into(),key:super::super::model::RelationKey { source_table:"rewards".into(),source_column:"items".into(),target_table:"goods".into(),target_column:"id".into(),kind:super::super::model::RelationKind::List },parser:None,source_constraints:vec![super::super::constraints::RowConstraint { column:"type".into(),values:vec!["1".into()] }],status:RelationStatus::Confirmed,reason:super::super::model::StatusReason::Manual,is_new:false,evidence:vec![],code_target:None,decided_at:None,disagreeing_code:Default::default() };
        let filter = relation_filter(&view,"1001");
        assert!(matches!(filter.kind,RelationMatchKind::ListContains));
        assert_eq!(filter.source_constraints,view.source_constraints);
        assert_eq!(filter.values,vec!["1001"]);
    }
}
