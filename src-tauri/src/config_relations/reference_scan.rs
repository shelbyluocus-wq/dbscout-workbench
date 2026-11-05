use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use crate::types::AppState;
use super::assistant::{self, integer, text};
use super::engine::{self, Context};

const MAX_RESULTS: usize = 5000;
const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const PAGE_SIZE: u32 = 100;

pub struct ScanJob {
    connection: String,
    database: String,
    tables: Vec<String>,
    table_index: usize,
    offset: u64,
    target: String,
    target_table: String,
    target_column: String,
    status: String,
    worker: bool,
    results: Vec<Value>,
    result_bytes: usize,
    result_base: u64,
    scanned_rows: u64,
    checked: Vec<String>,
    errors: Vec<Value>,
    started_at: String,
    no_primary_key: Vec<String>,
}

fn has_literal(text: &str, wanted: &str) -> bool {
    text.match_indices(wanted).any(|(start, _)| {
        let end = start + wanted.len();
        let atom = |value: char| value.is_alphanumeric() || value == '_';
        !text[..start].chars().next_back().is_some_and(atom) && !text[end..].chars().next().is_some_and(atom)
    })
}

fn match_kind(text: &str, wanted: &str) -> Option<&'static str> {
    if has_literal(text,wanted) { return Some("literal"); }
    if !wanted.is_empty() && wanted.bytes().all(|byte| byte.is_ascii_digit()) && text.match_indices(wanted).any(|(start, _)| {
        let end = start + wanted.len();
        !text[..start].chars().next_back().is_some_and(|value| value.is_ascii_digit()) && !text[end..].chars().next().is_some_and(|value| value.is_ascii_digit())
    }) { return Some("encodedNumericCandidate"); }
    None
}

impl ScanJob {
    fn full(&self) -> bool { self.results.len() >= MAX_RESULTS || self.result_bytes >= MAX_RESULT_BYTES }

    fn next_request(&mut self, allowed: bool) -> Option<(String, u64)> {
        if self.status == "running" {
            if !allowed { self.status = "pausedPermission".into(); }
            else if self.table_index >= self.tables.len() { self.status = "completed".into(); }
            else if self.full() { self.status = "pausedResultLimit".into(); }
        }
        if self.status != "running" { self.worker = false; return None; }
        Some((self.tables[self.table_index].clone(),self.offset))
    }

    fn resume(&mut self, discard_through: Option<u64>) -> Result<(), String> {
        if !self.status.starts_with("paused") { return Err("只有暂停的任务可以继续".into()); }
        if self.worker { return Err("正在停止当前读取，请稍后继续".into()); }
        if let Some(cursor) = discard_through { self.discard(cursor)?; }
        if self.full() { return Err("请先读取结果，再用 discardThrough 清理已取走的部分".into()); }
        self.status = "running".into();
        self.worker = true;
        Ok(())
    }

    fn discard(&mut self, cursor: u64) -> Result<(), String> {
        if cursor < self.result_base || cursor > self.result_base + self.results.len() as u64 { return Err("丢弃游标超出已保存结果".into()); }
        let amount = (cursor - self.result_base) as usize;
        self.results.drain(..amount);
        self.result_base = cursor;
        self.result_bytes = self.results.iter().map(|value| value.to_string().len()).sum();
        Ok(())
    }

    fn accept_page(&mut self, table: &str, offset: u64, page: crate::types::TableSessionPage) {
        if page.primary_keys.is_empty() && !self.no_primary_key.iter().any(|name| name == table) { self.no_primary_key.push(table.into()); }
        let mut consumed = 0;
        for (position, row) in page.rows.iter().enumerate() {
            let mut cells = Vec::new();
            let mut matched_columns = 0;
            let mut columns = row.iter().collect::<Vec<_>>();
            columns.sort_by_key(|(column,_)| *column);
            for (column, value) in columns {
                if self.target_table.eq_ignore_ascii_case(table) && self.target_column.eq_ignore_ascii_case(column) { continue; }
                if page.null_cells.get(position).is_some_and(|columns| columns.contains(column)) { continue; }
                if let Some(kind) = match_kind(value, &self.target) {
                    matched_columns += 1;
                    if cells.len() < 64 {
                        cells.push(json!({"column":column,"preview":value.chars().take(800).collect::<String>(),"truncated":value.chars().count()>800,
                            "classification":"candidateOnly","matchKind":kind,"reason":"包含字面值或编码数字；尚未证明是 ID，可能是数量、权重或函数文本"}));
                    }
                }
            }
            if !cells.is_empty() {
                let identity = assistant::row_identity(&page,row).filter(|identity| identity.values().all(|value| value.len() <= 512));
                let result = json!({"table":table,"rowIdentity":identity,"rowOffset":offset+position as u64,"cells":cells,"matchedColumns":matched_columns,"cellsTruncated":matched_columns>cells.len()});
                let size = result.to_string().len();
                if self.results.len() >= MAX_RESULTS || self.result_bytes + size > MAX_RESULT_BYTES {
                    self.status = "pausedResultLimit".into();
                    break;
                }
                self.result_bytes += size;
                self.results.push(result);
            }
            consumed += 1;
        }
        self.scanned_rows += consumed as u64;
        self.offset += consumed as u64;
        if consumed == page.rows.len() && page.rows.len() < PAGE_SIZE as usize {
            self.checked.push(table.into());
            self.table_index += 1;
            self.offset = 0;
        }
    }
}

async fn work(app: AppHandle, context: Arc<Context>, job: Arc<Mutex<ScanJob>>) {
    let mut cached_meta = None;
    loop {
        let allowed = crate::control_server::relation_permission(&app,"scan").await;
        let Some(request) = job.lock().await.next_request(allowed) else { return; };
        let result = match tokio::time::timeout(std::time::Duration::from_secs(30),assistant::cached_page(&app, &context, &request.0, request.1, PAGE_SIZE, None, &mut cached_meta)).await {
            Ok(result) => result,
            Err(_) => Err("本页读取超时，未完成的表不会计为已查全".into()),
        };
        let mut job = job.lock().await;
        if job.status != "running" { job.worker = false; return; }
        match result {
            Err(error) => {
                job.errors.push(json!({"table":request.0,"offset":request.1,"error":error}));
                job.table_index += 1;
                job.offset = 0;
            }
            Ok(page) => job.accept_page(&request.0,request.1,page),
        }
        drop(job);
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

fn snapshot(job: &ScanJob, id: &str, after: u64, limit: usize) -> Result<Value, String> {
    if after < job.result_base || after > job.result_base + job.results.len() as u64 { return Err("结果游标已失效或超出范围".into()); }
    let start = (after - job.result_base) as usize;
    let mut response_bytes = 0;
    let results = job.results.iter().skip(start).take(limit).take_while(|value| {
        let size = value.to_string().len();
        if response_bytes > 0 && response_bytes + size > 512 * 1024 { return false; }
        response_bytes += size;
        true
    }).collect::<Vec<_>>();
    let next = after + results.len() as u64;
    Ok(json!({"scanId":id,"status":job.status,"startedAt":job.started_at,"scannedRows":job.scanned_rows,
        "tablesTotal":job.tables.len(),"tablesFinished":job.checked.len(),"checkedTables":job.checked,
        "currentTable":job.tables.get(job.table_index),"currentOffset":job.offset,"remainingTables":job.tables.get(job.table_index..).unwrap_or_default(),
        "errors":job.errors,"noPrimaryKeyTables":job.no_primary_key,"results":results,"nextCursor":next,"hasMoreResults":next<job.result_base+job.results.len() as u64,"bufferBytes":job.result_bytes,"bufferLimitBytes":MAX_RESULT_BYTES,
        "dataTraversalComplete":job.status=="completed"&&job.errors.is_empty(),"semanticCoverageComplete":false,
        "warning":"候选扫描包含编码数字，不执行函数，也不识别计算生成的 ID；完整遍历不等于所有引用已证明。单行最多返回 64 个命中单元格，每格预览 800 字；截断需按行重读。扫描沿用开始时的表范围和每表首次读取的结构；期间增改表/数据需重查。实时分页可能遗漏或重复，无主键表不能可靠定位。结果仅保存在本次进程内。"}))
}

pub async fn run(app: &AppHandle, context: &Arc<Context>, name: &str, args: &Value) -> Result<Value, String> {
    let state = app.state::<AppState>();
    if name == "start_reference_scan" {
        let table = text(args, "table")?;
        let column = text(args, "column")?;
        let target = assistant::record(app,context,table,&args["rowIdentity"]).await?;
        let value = target.get(column).ok_or("目标字段不存在")?.clone();
        if value.is_empty() || value.len()>256 { return Err("扫描目标值为空或过长".into()); }
        let snapshot = engine::fresh_snapshot(app,context).await?;
        let tables = if let Some(tables) = args.get("tables") {
            let tables = tables.as_array().filter(|tables| !tables.is_empty() && tables.len() <= 2000).ok_or("tables 必须是 1-2000 张表")?;
            let mut chosen = Vec::new();
            for table in tables {
                let meta = snapshot.table(table.as_str().ok_or("表名必须为字符串")?).ok_or("扫描表不存在")?;
                if !chosen.contains(&meta.name) { chosen.push(meta.name.clone()); }
            }
            chosen
        } else { snapshot.tables.values().map(|table| table.name.clone()).collect() };
        let mut scans = state.config_relations.assistant.scans.lock().await;
        if scans.len() >= 8 { return Err("最多保留 8 个扫描任务，请先取消并删除旧任务".into()); }
        for scan in scans.values() {
            let scan = scan.lock().await;
            if scan.connection==context.connection_id && scan.database==context.database && scan.status=="running" { return Err("本库已有扫描运行，请先暂停或取消".into()); }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let job = Arc::new(Mutex::new(ScanJob {
            connection:context.connection_id.clone(),database:context.database.clone(),tables,table_index:0,offset:0,target:value,
            target_table:table.into(),target_column:column.into(),status:"running".into(),worker:true,results:vec![],result_base:0,
            scanned_rows:0,checked:vec![],errors:vec![],started_at:chrono::Utc::now().to_rfc3339(),no_primary_key:vec![],result_bytes:0,
        }));
        scans.insert(id.clone(),Arc::clone(&job));
        tauri::async_runtime::spawn(work(app.clone(),Arc::clone(context),job));
        return Ok(json!({"scanId":id,"status":"running","next":"get_reference_scan","databaseChanged":false}));
    }
    let id = text(args,"scanId")?;
    let job = state.config_relations.assistant.scans.lock().await.get(id).cloned().ok_or("扫描任务不存在或黑猫已重启")?;
    let mut data = job.lock().await;
    if data.connection!=context.connection_id || data.database!=context.database { return Err("扫描任务不属于指定连接和库".into()); }
    if name=="get_reference_scan" {
        return snapshot(&data,id,integer(args,"after",data.result_base,u64::MAX)?,integer(args,"limit",100,200)?.max(1) as usize);
    }
    match text(args,"action")? {
        "pause" => { if data.status=="running" { data.status="paused".into(); } }
        "cancel" => data.status="cancelled".into(),
        "forget" => {
            data.status="cancelled".into();
            drop(data);
            state.config_relations.assistant.scans.lock().await.remove(id);
            return Ok(json!({"forgotten":true}));
        }
        "resume" => {
            let mut scans = state.config_relations.assistant.scans.try_lock().map_err(|_| "扫描任务正在变更，请稍后重试")?;
            for (other_id, other) in scans.iter_mut() {
                if other_id == id { continue; }
                let other = other.try_lock().map_err(|_| "另一扫描正在操作，请稍后重试")?;
                if other.connection==context.connection_id && other.database==context.database && other.status=="running" { return Err("本库已有扫描运行，请先暂停或取消".into()); }
            }
            drop(scans);
            let discard = args.get("discardThrough").map(|_| integer(args,"discardThrough",0,9_007_199_254_740_991)).transpose()?;
            data.resume(discard)?;
            tauri::async_runtime::spawn(work(app.clone(),Arc::clone(context),Arc::clone(&job)));
        }
        _ => return Err("action 仅支持 pause/resume/cancel/forget".into()),
    }
    Ok(json!({"scanId":id,"status":data.status}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn candidates_use_complete_literals_not_substring_matches() {
        assert!(has_literal(r#"[{"ID":1001,"Num":3}]"#,"1001"));
        assert!(has_literal("1|1001|3","1001"));
        assert!(!has_literal("11001","1001"));
        assert!(!has_literal("id1001","1001"));
        assert!(has_literal("function(){return 1001;}","1001"));
        assert_eq!(match_kind("and|G1001_5","1001"),Some("encodedNumericCandidate"));
        assert_eq!(match_kind("G11001_5","1001"),None);
    }

    fn fixture() -> ScanJob {
        ScanJob { connection:"c".into(),database:"db".into(),tables:vec!["rewards".into()],table_index:0,offset:0,target:"1001".into(),target_table:"goods".into(),target_column:"id".into(),status:"running".into(),worker:false,results:vec![],result_bytes:0,result_base:0,scanned_rows:0,checked:vec![],errors:vec![],started_at:String::new(),no_primary_key:vec![] }
    }

    fn page(count: usize) -> crate::types::TableSessionPage {
        crate::types::TableSessionPage { session_id:String::new(),table_name:"rewards".into(),table_comment:String::new(),columns:vec![],primary_keys:vec!["id".into()],rows:(0..count).map(|index| std::collections::HashMap::from([("id".into(),index.to_string()),("items".into(),"[{\"ID\":1001,\"Num\":3}]".into())])).collect(),null_cells:vec![],total_rows:0,total_rows_exact:false,has_more:false,page:1,page_size:100 }
    }

    #[test]
    fn buffer_pauses_before_unconsumed_row_and_resume_does_not_skip_it() {
        let mut job = fixture();
        job.results = vec![json!({});MAX_RESULTS-1];
        job.accept_page("rewards",0,page(3));
        assert_eq!(job.status,"pausedResultLimit");
        assert_eq!(job.offset,1);
        assert!(job.checked.is_empty());
        let result = snapshot(&job,"job",(MAX_RESULTS-1) as u64,10).unwrap();
        assert_eq!(result["results"][0]["rowOffset"],0);
        assert_eq!(result["dataTraversalComplete"],false);
        job.discard(MAX_RESULTS as u64).unwrap();
        assert!(snapshot(&job,"job",0,10).is_err());
        assert_eq!(job.result_bytes,0);
        job.status="running".into();
        job.accept_page("rewards",1,page(2));
        assert_eq!(job.results[0]["rowOffset"],1);
        assert_eq!(job.scanned_rows,3);
        assert_eq!(job.checked,vec!["rewards"]);
        job.status="completed".into();
        assert_eq!(snapshot(&job,"job",MAX_RESULTS as u64,10).unwrap()["dataTraversalComplete"],true);
        job.errors.push(json!({"error":"failed"}));
        assert_eq!(snapshot(&job,"job",MAX_RESULTS as u64,10).unwrap()["dataTraversalComplete"],false);
    }

    #[test]
    fn byte_limit_nulls_empty_tables_and_truncation_are_explicit() {
        let mut job = fixture();
        job.result_bytes=MAX_RESULT_BYTES-1;
        job.accept_page("rewards",0,page(1));
        assert_eq!(job.offset,0);
        assert!(job.results.is_empty());
        job.result_bytes=0;
        job.status="running".into();
        let mut null_page=page(1);
        null_page.null_cells=vec![vec!["items".into()]];
        job.accept_page("rewards",0,null_page);
        assert!(job.results.is_empty());
        let mut wide=page(1);
        for index in 0..70 { wide.rows[0].insert(format!("extra{index}"),"1001 ".repeat(900)); }
        let mut job=fixture();
        job.accept_page("rewards",0,wide);
        assert_eq!(job.results[0]["cellsTruncated"],true);
        assert_eq!(job.results[0]["cells"].as_array().unwrap().len(),64);
        assert_eq!(job.results[0]["cells"][0]["truncated"],true);
        let mut empty=fixture();
        empty.accept_page("rewards",0,page(0));
        assert_eq!(empty.checked,vec!["rewards"]);
        assert_eq!(empty.scanned_rows,0);
    }

    #[test]
    fn lifecycle_stops_on_revocation_and_never_resumes_terminal_jobs() {
        let mut job=fixture();
        job.worker=true;
        assert_eq!(job.next_request(true),Some(("rewards".into(),0)));
        assert!(job.next_request(false).is_none());
        assert_eq!(job.status,"pausedPermission");
        assert!(!job.worker);
        job.resume(None).unwrap();
        job.status="paused".into();
        assert!(job.resume(None).is_err());
        assert!(job.next_request(true).is_none());
        job.resume(None).unwrap();
        job.status="cancelled".into();
        assert!(job.next_request(false).is_none());
        assert_eq!(job.status,"cancelled");
        assert!(job.resume(None).is_err());
        let mut finished=fixture();
        finished.table_index=finished.tables.len();
        assert!(finished.next_request(true).is_none());
        assert_eq!(finished.status,"completed");
        assert!(finished.resume(None).is_err());
    }
}
