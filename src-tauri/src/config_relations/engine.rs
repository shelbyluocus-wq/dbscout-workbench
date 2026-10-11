//! Per-database relation state. The first request builds an index from
//! column comments; reading the bound client's code and sampling data formats
//! happen in the background, and every finished step republishes the index
//! through the `config-relations-updated` event.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use sqlx::MySqlPool;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as AsyncMutex;

use crate::db::{escape_ident, qualified_table};
use crate::mysql_text;
use crate::perf::PerfContext;
use crate::runtime_resources::PoolKey;
use crate::types::{AppState, DatabaseKind};
use crate::work_scheduler::WorkClass;

use super::assembly::{self, CodeState, Inputs, RelationIndex};
use super::catalog::{DbSnapshot, DbTable};
use super::code_scan::{self, ClientDialect, ScanCache};
use super::discovery::{self, ClientCandidate};
use super::formats::{self, FormatFinding};
use super::model::{Evidence, StatusTotals};
use super::store::{ClientBinding, Decision, ServerRecord, Store, Verdict, FILE_NAME};

pub const UPDATED_EVENT: &str = "config-relations-updated";
/// Comment and structure changes show up within this delay.
const SNAPSHOT_TTL: Duration = Duration::from_secs(30);
const CODE_TTL: Duration = Duration::from_secs(30);
/// Re-sample tables whose modification time MySQL does not report.
const UNDATED_FORMAT_TTL: Duration = Duration::from_secs(600);
const FOREGROUND_TIMEOUT: Duration = Duration::from_secs(20);
const BACKGROUND_TIMEOUT: Duration = Duration::from_secs(60);
const FORMAT_SAMPLE_ROWS: u32 = 200;

#[derive(Default)]
pub struct ConfigRelationsState {
    store: AsyncMutex<Option<Store>>,
    contexts: std::sync::Mutex<HashMap<(String, String), Arc<Context>>>,
    scan_caches: std::sync::Mutex<HashMap<String, Arc<std::sync::Mutex<ScanCache>>>>,
}

pub struct Context {
    pub connection_id: String,
    pub database: String,
    pub server_key: String,
    data: AsyncMutex<ContextData>,
    running: AtomicBool,
    rerun: AtomicBool,
    force: AtomicBool,
    revision: AtomicU64,
    row_channels: std::sync::Mutex<HashMap<String, Arc<AtomicU64>>>,
}

/// Lets a newer row lookup on the same channel stop an older one early, so
/// moving through rows quickly does not queue up work for rows already left.
pub struct RowTicket {
    counter: Arc<AtomicU64>,
    value: u64,
}

impl RowTicket {
    pub fn is_current(&self) -> bool {
        self.counter.load(Ordering::SeqCst) == self.value
    }
}

pub fn row_ticket(context: &Context, channel: &str) -> RowTicket {
    let counter = {
        let mut channels = context
            .row_channels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Arc::clone(channels.entry(channel.to_string()).or_default())
    };
    let value = counter.fetch_add(1, Ordering::SeqCst) + 1;
    RowTicket { counter, value }
}

struct SampledFormats {
    modified_at: Option<String>,
    sampled_at: Instant,
    findings: Vec<FormatFinding>,
}

struct ContextData {
    snapshot: Option<Arc<DbSnapshot>>,
    snapshot_signature: u64,
    snapshot_at: Option<Instant>,
    code: CodeState,
    code_root: Option<String>,
    code_at: Option<Instant>,
    code_scanned_at: Option<String>,
    code_files: usize,
    formats: BTreeMap<String, SampledFormats>,
    formats_sampled: bool,
    index: Option<Arc<RelationIndex>>,
    error: Option<String>,
}

impl Default for ContextData {
    fn default() -> Self {
        Self {
            snapshot: None,
            snapshot_signature: 0,
            snapshot_at: None,
            code: CodeState::Pending,
            code_root: None,
            code_at: None,
            code_scanned_at: None,
            code_files: 0,
            formats: BTreeMap::new(),
            formats_sampled: false,
            index: None,
            error: None,
        }
    }
}

fn now_text() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

fn stale(at: Option<Instant>, ttl: Duration) -> bool {
    at.is_none_or(|at| at.elapsed() >= ttl)
}

fn snapshot_signature(snapshot: &DbSnapshot) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for (name, table) in &snapshot.tables {
        name.hash(&mut hasher);
        table.primary_keys.hash(&mut hasher);
        for column in &table.columns {
            (&column.name, &column.data_type, &column.comment).hash(&mut hasher);
        }
    }
    hasher.finish()
}

// ── context lookup ─────────────────────────────────────────────

/// Relations need a real MySQL config database; other connections get this
/// explanation instead.
pub async fn resolve(app: &AppHandle, connection_id: &str, database: &str) -> Result<Arc<Context>, String> {
    let database = database.trim();
    if database.is_empty() {
        return Err("请先选择数据库".into());
    }
    let state = app.state::<AppState>();
    let server_key = {
        let runtime = state.runtime.lock().await;
        let connection = runtime
            .connections
            .get(connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        if connection.kind != DatabaseKind::MySql || connection.mysql_url.is_none() {
            return Err("配置关联只支持 MySQL 配置库".into());
        }
        format!("{}:{}", connection.host.trim().to_lowercase(), connection.port)
    };
    let mut contexts = state
        .config_relations
        .contexts
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let key = (connection_id.to_string(), database.to_lowercase());
    let context = contexts.entry(key).or_insert_with(|| {
        Arc::new(Context {
            connection_id: connection_id.to_string(),
            database: database.to_string(),
            server_key: server_key.clone(),
            data: AsyncMutex::new(ContextData::default()),
            running: AtomicBool::new(false),
            rerun: AtomicBool::new(false),
            force: AtomicBool::new(false),
            revision: AtomicU64::new(0),
            row_channels: std::sync::Mutex::new(HashMap::new()),
        })
    });
    Ok(Arc::clone(context))
}

fn contexts_for_server(app: &AppHandle, server_key: &str) -> Vec<Arc<Context>> {
    let state = app.state::<AppState>();
    let contexts = state
        .config_relations
        .contexts
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    contexts
        .values()
        .filter(|context| context.server_key == server_key)
        .cloned()
        .collect()
}

// ── store ──────────────────────────────────────────────────────

async fn with_store<R>(app: &AppHandle, action: impl FnOnce(&mut Store) -> R) -> Result<R, String> {
    let state = app.state::<AppState>();
    let mut guard = state.config_relations.store.lock().await;
    if guard.is_none() {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
        *guard = Some(Store::load(directory.join(FILE_NAME)));
    }
    Ok(action(guard.as_mut().expect("store loaded above")))
}

async fn server_record(app: &AppHandle, server_key: &str) -> Result<Option<ServerRecord>, String> {
    with_store(app, |store| store.server(server_key).cloned()).await
}

pub async fn binding(app: &AppHandle, server_key: &str) -> Result<Option<ClientBinding>, String> {
    Ok(server_record(app, server_key)
        .await?
        .and_then(|record| record.client))
}

// ── database access ────────────────────────────────────────────

pub async fn pool(app: &AppHandle, context: &Context) -> Result<MySqlPool, String> {
    let state = app.state::<AppState>();
    crate::commands::real_database_pool(
        &context.connection_id,
        &context.database,
        &state,
        &PerfContext::default(),
    )
    .await
}

/// Runs database work through the shared scheduler so relation reads never
/// starve grid paging.
pub async fn run_db<T, F>(app: &AppHandle, context: &Context, class: WorkClass, work: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let state = app.state::<AppState>();
    let timeout = match class {
        WorkClass::Foreground => FOREGROUND_TIMEOUT,
        WorkClass::Background => BACKGROUND_TIMEOUT,
    };
    crate::commands::run_pool_work(
        &state.work_scheduler,
        &PoolKey::new(&context.connection_id, &context.database),
        class,
        timeout,
        work,
    )
    .await
}

async fn load_snapshot(app: &AppHandle, context: &Context, class: WorkClass) -> Result<DbSnapshot, String> {
    let pool = pool(app, context).await?;
    let database = context.database.clone();
    run_db(app, context, class, async move {
        let tables = crate::db::list_tables_from_db(&pool, &database).await?;
        let metas = crate::db::read_schemas_for_tables(&pool, &database, &tables).await?;
        Ok(DbSnapshot::from_metas(metas, &tables))
    })
    .await
}

async fn sample_formats(
    pool: &MySqlPool,
    database: &str,
    table: &DbTable,
    snapshot: &DbSnapshot,
) -> Result<Vec<FormatFinding>, String> {
    let columns = table.columns.iter().filter(|column| column.is_text()).collect::<Vec<_>>();
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let selects = columns
        .iter()
        .enumerate()
        .map(|(index, column)| format!("CAST(`{}` AS CHAR) AS c{index}", escape_ident(&column.name)))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT /*+ MAX_EXECUTION_TIME(10000) */ {selects} FROM {} LIMIT {FORMAT_SAMPLE_ROWS}",
        qualified_table(database, &table.name)
    );
    let rows = sqlx::query(&sql)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取数据样本失败: {error}"))?;
    let mut values = vec![Vec::new(); columns.len()];
    for row in &rows {
        for (index, bucket) in values.iter_mut().enumerate() {
            if let Ok(Some(value)) = mysql_text::optional_string(row, format!("c{index}").as_str()) {
                bucket.push(value);
            }
        }
    }
    Ok(columns
        .iter()
        .zip(values)
        .filter_map(|(column, values)| {
            let (rule, sample) = formats::classify(&values, snapshot)?;
            Some(FormatFinding {
                column: column.name.clone(),
                target_table: rule.target_table.to_lowercase(),
                target_column: snapshot
                    .column_name(rule.target_table, rule.target_column)
                    .unwrap_or(rule.target_column)
                    .to_string(),
                sample,
            })
        })
        .collect())
}

// ── index ──────────────────────────────────────────────────────

fn scan_cache(app: &AppHandle, root: &str) -> Arc<std::sync::Mutex<ScanCache>> {
    let state = app.state::<AppState>();
    let mut caches = state
        .config_relations
        .scan_caches
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Arc::clone(caches.entry(root.to_lowercase()).or_default())
}

fn emit_updated(app: &AppHandle, context: &Context, index: &RelationIndex, revision: u64) {
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        connection_id: &'a str,
        database: &'a str,
        revision: u64,
        review_count: usize,
    }
    let _ = app.emit(
        UPDATED_EVENT,
        Payload {
            connection_id: &context.connection_id,
            database: &context.database,
            revision,
            review_count: index.totals.needs_review(),
        },
    );
}

/// Re-runs the assembly from the inputs already loaded and publishes it.
async fn rebuild(app: &AppHandle, context: &Context) -> Result<Arc<RelationIndex>, String> {
    let record = server_record(app, &context.server_key).await?;
    let now = now_text();
    let (index, code_ready) = {
        let data = context.data.lock().await;
        let snapshot = data
            .snapshot
            .clone()
            .ok_or_else(|| "数据库结构尚未读取".to_string())?;
        let formats = data
            .formats
            .iter()
            .filter(|(_, sampled)| !sampled.findings.is_empty())
            .map(|(table, sampled)| (table.clone(), sampled.findings.clone()))
            .collect::<BTreeMap<_, _>>();
        let index = assembly::assemble(&Inputs {
            snapshot: &snapshot,
            code: &data.code,
            formats: &formats,
            formats_pending: !data.formats_sampled,
            record: record.as_ref(),
            now: &now,
        });
        (index, matches!(data.code, CodeState::Ready(_)))
    };
    let set_baseline = code_ready
        && record
            .as_ref()
            .is_some_and(|record| record.client.is_some() && record.baseline.is_none());
    if !index.decision_updates.is_empty() || set_baseline {
        let updates = index.decision_updates.clone();
        let ids = index.relation_ids.clone();
        let server_key = context.server_key.clone();
        with_store(app, move |store| {
            let record = store.server_mut(&server_key);
            record.decisions.extend(updates);
            if set_baseline {
                record.baseline = Some(ids);
            }
            store.save()
        })
        .await??;
    }
    let index = Arc::new(index);
    context.data.lock().await.index = Some(Arc::clone(&index));
    let revision = context.revision.fetch_add(1, Ordering::SeqCst) + 1;
    emit_updated(app, context, &index, revision);
    Ok(index)
}

/// Current index, building a comment-only one first if nothing is loaded.
/// Stale inputs are refreshed in the background, never on this path.
pub async fn index(app: &AppHandle, context: &Arc<Context>) -> Result<(Arc<DbSnapshot>, Arc<RelationIndex>), String> {
    let existing = {
        let data = context.data.lock().await;
        data.snapshot.clone().zip(data.index.clone())
    };
    if let Some(existing) = existing {
        if needs_refresh(app, context).await {
            schedule_refresh(app, context, false);
        }
        return Ok(existing);
    }
    let snapshot = Arc::new(load_snapshot(app, context, WorkClass::Foreground).await?);
    {
        let mut data = context.data.lock().await;
        if data.snapshot.is_none() {
            data.snapshot_signature = snapshot_signature(&snapshot);
            data.snapshot = Some(Arc::clone(&snapshot));
            data.snapshot_at = Some(Instant::now());
        }
        data.code = match binding(app, &context.server_key).await? {
            None => CodeState::NoClient,
            Some(_) => CodeState::Pending,
        };
    }
    let index = rebuild(app, context).await?;
    schedule_refresh(app, context, false);
    let snapshot = context.data.lock().await.snapshot.clone().unwrap_or(snapshot);
    Ok((snapshot, index))
}

async fn needs_refresh(app: &AppHandle, context: &Context) -> bool {
    let bound = binding(app, &context.server_key).await.ok().flatten().is_some();
    let data = context.data.lock().await;
    stale(data.snapshot_at, SNAPSHOT_TTL)
        || !data.formats_sampled
        || (bound && stale(data.code_at, CODE_TTL))
}

pub fn schedule_refresh(app: &AppHandle, context: &Arc<Context>, force: bool) {
    if force {
        context.force.store(true, Ordering::SeqCst);
    }
    if context.running.swap(true, Ordering::SeqCst) {
        context.rerun.store(true, Ordering::SeqCst);
        return;
    }
    let app = app.clone();
    let context = Arc::clone(context);
    tauri::async_runtime::spawn(async move {
        loop {
            let force = context.force.swap(false, Ordering::SeqCst);
            let result = refresh(&app, &context, force).await;
            context.data.lock().await.error = result.err();
            if !context.rerun.swap(false, Ordering::SeqCst) {
                break;
            }
        }
        context.running.store(false, Ordering::SeqCst);
        if context.rerun.swap(false, Ordering::SeqCst) {
            schedule_refresh(&app, &context, false);
        } else {
            emit_settled(&app, &context).await;
        }
    });
}

/// A finished run may change nothing, or only its error; the frontend still
/// needs to hear about it so its "refreshing" state and error clear.
async fn emit_settled(app: &AppHandle, context: &Context) {
    let index = context.data.lock().await.index.clone();
    if let Some(index) = index {
        emit_updated(app, context, &index, revision(context));
    }
}

async fn refresh(app: &AppHandle, context: &Arc<Context>, force: bool) -> Result<(), String> {
    let mut changed = refresh_snapshot(app, context, force).await?;
    changed |= refresh_code(app, context, force).await?;
    if changed {
        rebuild(app, context).await?;
    }
    if refresh_formats(app, context, force).await? {
        rebuild(app, context).await?;
    }
    Ok(())
}

async fn refresh_snapshot(app: &AppHandle, context: &Context, force: bool) -> Result<bool, String> {
    let due = force || stale(context.data.lock().await.snapshot_at, SNAPSHOT_TTL);
    if !due {
        return Ok(false);
    }
    let snapshot = load_snapshot(app, context, WorkClass::Background).await?;
    let signature = snapshot_signature(&snapshot);
    let mut data = context.data.lock().await;
    let changed = data.snapshot.is_none() || data.snapshot_signature != signature;
    data.snapshot_signature = signature;
    data.snapshot = Some(Arc::new(snapshot));
    data.snapshot_at = Some(Instant::now());
    Ok(changed)
}

fn binding_dialect(binding: &ClientBinding, root: &Path) -> Option<ClientDialect> {
    code_scan::detect_dialect(root).or(match binding.dialect.as_str() {
        "jswz" => Some(ClientDialect::Jswz),
        "nzg" => Some(ClientDialect::Nzg),
        _ => None,
    })
}

async fn refresh_code(app: &AppHandle, context: &Context, force: bool) -> Result<bool, String> {
    let binding = binding(app, &context.server_key).await?;
    let Some(binding) = binding else {
        let mut data = context.data.lock().await;
        let changed = !matches!(data.code, CodeState::NoClient);
        data.code = CodeState::NoClient;
        data.code_root = None;
        return Ok(changed);
    };
    let root = PathBuf::from(&binding.path);
    let dialect = binding_dialect(&binding, &root).filter(|_| root.is_dir());
    let Some(dialect) = dialect else {
        let mut data = context.data.lock().await;
        let changed = !matches!(data.code, CodeState::ClientMissing);
        data.code = CodeState::ClientMissing;
        return Ok(changed);
    };
    let (due, columns, previous_ready) = {
        let data = context.data.lock().await;
        let same_root = data.code_root.as_deref() == Some(binding.path.as_str());
        let settled = matches!(data.code, CodeState::Ready(_) | CodeState::Failed(_));
        let due = force || !same_root || !settled || stale(data.code_at, CODE_TTL);
        let columns = data.snapshot.as_ref().map(|snapshot| snapshot.table_columns());
        (due, columns, same_root && matches!(data.code, CodeState::Ready(_)))
    };
    let Some(columns) = columns.filter(|_| due) else {
        return Ok(false);
    };
    let cache = scan_cache(app, &binding.path);
    let scan_root = root.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let cancel = AtomicBool::new(false);
        let mut cache = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        code_scan::scan(&scan_root, dialect, &columns, &mut cache, &cancel)
    })
    .await
    .map_err(|error| format!("读取客户端代码失败: {error}"))?;
    let mut data = context.data.lock().await;
    data.code_root = Some(binding.path.clone());
    data.code_at = Some(Instant::now());
    let changed = match outcome {
        Ok(report) => {
            // files_reparsed misses content changes that reuse cached parses
            // (a deleted file, different columns), so compare what matters.
            let changed = !previous_ready
                || match &data.code {
                    CodeState::Ready(previous) => {
                        previous.used_tables != report.used_tables
                            || previous.relations != report.relations
                            || previous.untraced != report.untraced
                    }
                    _ => true,
                };
            data.code_files = report.files_scanned;
            data.code_scanned_at = Some(now_text());
            if changed {
                data.code = CodeState::Ready(Arc::new(report));
            }
            changed
        }
        Err(message) => {
            data.code = CodeState::Failed(message);
            true
        }
    };
    Ok(changed)
}

fn format_due(sampled: Option<&SampledFormats>, table: &DbTable, force: bool) -> bool {
    match sampled {
        None => true,
        Some(_) if force => true,
        Some(sampled) => match &table.modified_at {
            Some(modified) => sampled.modified_at.as_ref() != Some(modified),
            None => sampled.sampled_at.elapsed() >= UNDATED_FORMAT_TTL,
        },
    }
}

async fn refresh_formats(app: &AppHandle, context: &Context, force: bool) -> Result<bool, String> {
    let (snapshot, due) = {
        let data = context.data.lock().await;
        let Some(snapshot) = data.snapshot.clone() else {
            return Ok(false);
        };
        let due = snapshot
            .tables
            .iter()
            .filter(|(name, table)| format_due(data.formats.get(*name), table, force))
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        (snapshot, due)
    };
    let was_sampled = context.data.lock().await.formats_sampled;
    if due.is_empty() {
        context.data.lock().await.formats_sampled = true;
        return Ok(!was_sampled);
    }
    let pool = pool(app, context).await?;
    let mut changed = !was_sampled;
    for name in due {
        let Some(table) = snapshot.tables.get(&name) else {
            continue;
        };
        let findings = run_db(
            app,
            context,
            WorkClass::Background,
            sample_formats(&pool, &context.database, table, &snapshot),
        )
        .await
        .unwrap_or_default();
        let mut data = context.data.lock().await;
        let previous = data.formats.insert(
            name.clone(),
            SampledFormats {
                modified_at: table.modified_at.clone(),
                sampled_at: Instant::now(),
                findings: findings.clone(),
            },
        );
        changed |= previous.is_none_or(|previous| previous.findings != findings);
    }
    context.data.lock().await.formats_sampled = true;
    Ok(changed)
}

// ── actions ────────────────────────────────────────────────────

pub async fn bind_client(app: &AppHandle, context: &Arc<Context>, path: &str) -> Result<(), String> {
    let (snapshot, _) = index(app, context).await?;
    let path = PathBuf::from(path.trim());
    let (candidate, _) = discovery::inspect(&path, &snapshot)?;
    if candidate.matched_tables == 0 {
        return Err("这个客户端里没有当前数据库的任何配置表，可能是另一款游戏".into());
    }
    let server_key = context.server_key.clone();
    with_store(app, move |store| {
        let record = store.server_mut(&server_key);
        let changed = record.client.as_ref().is_none_or(|client| client.path != candidate.path);
        record.client = Some(ClientBinding {
            path: candidate.path,
            dialect: candidate.dialect,
            confirmed_at: now_text(),
        });
        if changed {
            record.baseline = None;
        }
        store.save()
    })
    .await??;
    restart_code_analysis(app, &context.server_key).await;
    Ok(())
}

pub async fn unbind_client(app: &AppHandle, context: &Arc<Context>) -> Result<(), String> {
    let server_key = context.server_key.clone();
    with_store(app, move |store| {
        let record = store.server_mut(&server_key);
        record.client = None;
        record.baseline = None;
        store.save()
    })
    .await??;
    restart_code_analysis(app, &context.server_key).await;
    Ok(())
}

/// Every open database of the server reads the newly bound client.
async fn restart_code_analysis(app: &AppHandle, server_key: &str) {
    for context in contexts_for_server(app, server_key) {
        {
            let mut data = context.data.lock().await;
            data.code = CodeState::Pending;
            data.code_root = None;
            data.code_at = None;
        }
        if context.data.lock().await.snapshot.is_some() {
            let _ = rebuild(app, &context).await;
        }
        schedule_refresh(app, &context, false);
    }
}

pub async fn review(
    app: &AppHandle,
    context: &Arc<Context>,
    relation_ids: &[String],
    verdict: Option<Verdict>,
) -> Result<(), String> {
    let (_, current) = index(app, context).await?;
    let now = now_text();
    let decisions = relation_ids
        .iter()
        .filter_map(|id| {
            let view = current.find(id)?;
            let code_fingerprints = view
                .evidence
                .iter()
                .filter_map(|evidence| match evidence {
                    Evidence::Code { fingerprint, .. } => Some(fingerprint.clone()),
                    _ => None,
                })
                .collect::<BTreeSet<_>>();
            Some((
                id.clone(),
                verdict.map(|verdict| Decision {
                    verdict,
                    auto: false,
                    code_fingerprints,
                    overridden_code: if verdict == Verdict::Confirmed {
                        view.disagreeing_code.clone()
                    } else {
                        BTreeSet::new()
                    },
                    relation: view.key.clone(),
                    decided_at: now.clone(),
                }),
            ))
        })
        .collect::<Vec<_>>();
    let server_key = context.server_key.clone();
    with_store(app, move |store| {
        let record = store.server_mut(&server_key);
        for (id, decision) in decisions {
            match decision {
                Some(decision) => {
                    record.decisions.insert(id, decision);
                }
                None => {
                    record.decisions.remove(&id);
                }
            }
        }
        store.save()
    })
    .await??;
    for context in contexts_for_server(app, &context.server_key) {
        if context.data.lock().await.snapshot.is_some() {
            rebuild(app, &context).await?;
        }
    }
    Ok(())
}

pub async fn discover_clients(app: &AppHandle, context: &Arc<Context>) -> Result<Vec<ClientCandidate>, String> {
    let (snapshot, _) = index(app, context).await?;
    let bound = binding(app, &context.server_key)
        .await?
        .map(|binding| PathBuf::from(binding.path))
        .into_iter()
        .collect::<Vec<_>>();
    tauri::async_runtime::spawn_blocking(move || discovery::discover(&snapshot, bound))
        .await
        .map_err(|error| format!("查找客户端目录失败: {error}"))
}

pub async fn inspect_client(app: &AppHandle, context: &Arc<Context>, path: &str) -> Result<ClientCandidate, String> {
    let (snapshot, _) = index(app, context).await?;
    let path = PathBuf::from(path.trim());
    tauri::async_runtime::spawn_blocking(move || discovery::inspect(&path, &snapshot).map(|(candidate, _)| candidate))
        .await
        .map_err(|error| format!("检查客户端目录失败: {error}"))?
}

// ── overview ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientView {
    pub path: String,
    pub dialect: String,
    pub confirmed_at: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeStatus {
    NoClient,
    ClientMissing,
    Pending,
    Failed,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub client: Option<ClientView>,
    pub code_status: CodeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_message: Option<String>,
    pub code_files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_scanned_at: Option<String>,
    /// The first full analysis has not finished yet.
    pub analyzing: bool,
    /// Some refresh is running, including routine background checks.
    pub refreshing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub totals: StatusTotals,
    pub review_count: usize,
    pub revision: u64,
}

pub async fn overview(app: &AppHandle, context: &Arc<Context>) -> Result<Overview, String> {
    let (_, current) = index(app, context).await?;
    let client = binding(app, &context.server_key).await?.map(|binding| ClientView {
        exists: Path::new(&binding.path).is_dir(),
        path: binding.path,
        dialect: binding.dialect,
        confirmed_at: binding.confirmed_at,
    });
    let data = context.data.lock().await;
    let (code_status, code_message) = match &data.code {
        CodeState::NoClient => (CodeStatus::NoClient, None),
        CodeState::ClientMissing => (CodeStatus::ClientMissing, None),
        CodeState::Pending => (CodeStatus::Pending, None),
        CodeState::Failed(message) => (CodeStatus::Failed, Some(message.clone())),
        CodeState::Ready(_) => (CodeStatus::Ready, None),
    };
    Ok(Overview {
        client,
        code_status,
        code_message,
        code_files: data.code_files,
        code_scanned_at: data.code_scanned_at.clone(),
        analyzing: matches!(code_status, CodeStatus::Pending) || !data.formats_sampled,
        refreshing: context.running.load(Ordering::SeqCst),
        error: data.error.clone(),
        totals: current.totals.clone(),
        review_count: current.totals.needs_review(),
        revision: context.revision.load(Ordering::SeqCst),
    })
}

pub fn revision(context: &Context) -> u64 {
    context.revision.load(Ordering::SeqCst)
}
