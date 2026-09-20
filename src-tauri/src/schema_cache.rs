use std::{
    collections::{HashMap, HashSet},
    fmt,
    future::Future,
    hash::{Hash, Hasher},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use tokio::{sync::watch, time::Instant};

use crate::types::TableMeta;

// Foreground table opens reuse an expired snapshot instead of waiting on a
// refresh. Coalesced/background loads still reload after this TTL so external
// DDL is picked up without blocking the first grid frame.
const DEFAULT_SCHEMA_TTL: Duration = Duration::from_secs(10 * 60);
const DEFAULT_SCHEMA_CAPACITY: usize = 512;
const DEFAULT_READ_RETRIES: usize = 1;

fn normalize_component(value: &str) -> String {
    value.trim().to_lowercase()
}

#[derive(Clone, Debug)]
pub struct SchemaCacheKey {
    connection_id: String,
    database: String,
    table_name: String,
    normalized_connection_id: String,
    normalized_database: String,
    normalized_table_name: String,
}

impl SchemaCacheKey {
    pub fn new(connection_id: &str, database: &str, table_name: &str) -> Self {
        Self {
            connection_id: connection_id.trim().into(),
            database: database.trim().into(),
            table_name: table_name.trim().into(),
            normalized_connection_id: normalize_component(connection_id),
            normalized_database: normalize_component(database),
            normalized_table_name: normalize_component(table_name),
        }
    }

    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub fn database(&self) -> &str {
        &self.database
    }

    pub fn table_name(&self) -> &str {
        &self.table_name
    }
}

impl PartialEq for SchemaCacheKey {
    fn eq(&self, other: &Self) -> bool {
        self.normalized_connection_id == other.normalized_connection_id
            && self.normalized_database == other.normalized_database
            && self.normalized_table_name == other.normalized_table_name
    }
}

impl Eq for SchemaCacheKey {}

impl Hash for SchemaCacheKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.normalized_connection_id.hash(state);
        self.normalized_database.hash(state);
        self.normalized_table_name.hash(state);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SchemaGeneration {
    connection: u64,
    database: u64,
    table: u64,
}

#[derive(Clone, Debug)]
pub struct SchemaSnapshot {
    schema: Arc<TableMeta>,
    generation: SchemaGeneration,
    loaded_at: Instant,
}

impl SchemaSnapshot {
    pub fn schema(&self) -> &Arc<TableMeta> {
        &self.schema
    }

    pub fn generation(&self) -> SchemaGeneration {
        self.generation
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaCacheConfigError {
    EmptyTtl,
    EmptyCapacity,
}

impl fmt::Display for SchemaCacheConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyTtl => formatter.write_str("schema cache TTL must be greater than zero"),
            Self::EmptyCapacity => {
                formatter.write_str("schema cache capacity must be greater than zero")
            }
        }
    }
}

impl std::error::Error for SchemaCacheConfigError {}

#[derive(Debug, Clone, Copy)]
pub struct SchemaCacheConfig {
    ttl: Duration,
    capacity: usize,
    read_retries: usize,
}

impl SchemaCacheConfig {
    pub fn new(
        ttl: Duration,
        capacity: usize,
        read_retries: usize,
    ) -> Result<Self, SchemaCacheConfigError> {
        if ttl.is_zero() {
            return Err(SchemaCacheConfigError::EmptyTtl);
        }
        if capacity == 0 {
            return Err(SchemaCacheConfigError::EmptyCapacity);
        }
        Ok(Self {
            ttl,
            capacity,
            read_retries,
        })
    }
}

impl Default for SchemaCacheConfig {
    fn default() -> Self {
        Self::new(
            DEFAULT_SCHEMA_TTL,
            DEFAULT_SCHEMA_CAPACITY,
            DEFAULT_READ_RETRIES,
        )
        .expect("default schema cache config must be valid")
    }
}

#[derive(Clone)]
enum LoadOutcome {
    Loaded(SchemaSnapshot),
    Stale,
    Failed(String),
}

struct InFlightLoad {
    sender: watch::Sender<Option<LoadOutcome>>,
}

impl InFlightLoad {
    fn new() -> Self {
        let (sender, _) = watch::channel(None);
        Self { sender }
    }

    fn publish(&self, outcome: LoadOutcome) {
        self.sender.send_replace(Some(outcome));
    }

    async fn wait(&self) -> LoadOutcome {
        let mut receiver = self.sender.subscribe();
        if let Some(outcome) = receiver.borrow_and_update().clone() {
            return outcome;
        }
        loop {
            if receiver.changed().await.is_err() {
                return LoadOutcome::Failed("schema loader ended without a result".into());
            }
            if let Some(outcome) = receiver.borrow_and_update().clone() {
                return outcome;
            }
        }
    }
}

struct CacheEntry {
    snapshot: SchemaSnapshot,
    last_used: u64,
}

#[derive(Default)]
struct SchemaCacheState {
    entries: HashMap<SchemaCacheKey, CacheEntry>,
    inflight: HashMap<(SchemaCacheKey, SchemaGeneration), Weak<InFlightLoad>>,
    connection_generations: HashMap<String, u64>,
    database_generations: HashMap<(String, String), u64>,
    table_generations: HashMap<SchemaCacheKey, u64>,
    access_clock: u64,
}

struct SchemaCacheInner {
    config: SchemaCacheConfig,
    state: Mutex<SchemaCacheState>,
}

#[derive(Clone)]
pub struct SchemaCache {
    inner: Arc<SchemaCacheInner>,
}

enum LoadPlan {
    Hit(SchemaSnapshot),
    Pending(Arc<InFlightLoad>),
    Leader(LoadLeader),
}

enum ForegroundLoadPlan {
    Hit(SchemaSnapshot),
    Stale(SchemaSnapshot),
    Load(SchemaGeneration),
}

#[derive(Clone)]
struct LoadLeader {
    key: SchemaCacheKey,
    generation: SchemaGeneration,
    inflight: Arc<InFlightLoad>,
}

struct LeaderCancellationGuard {
    cache: Weak<SchemaCacheInner>,
    leaders: Vec<LoadLeader>,
}

impl LeaderCancellationGuard {
    fn new(cache: &Arc<SchemaCacheInner>, leaders: Vec<LoadLeader>) -> Self {
        Self {
            cache: Arc::downgrade(cache),
            leaders,
        }
    }

    fn complete(&mut self, completed: &LoadLeader) {
        self.leaders
            .retain(|leader| !Arc::ptr_eq(&leader.inflight, &completed.inflight));
    }
}

impl Drop for LeaderCancellationGuard {
    fn drop(&mut self) {
        if self.leaders.is_empty() {
            return;
        }
        if let Some(cache) = self.cache.upgrade() {
            let mut state = cache
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for leader in &self.leaders {
                remove_matching_inflight(&mut state, leader);
            }
        }
        for leader in &self.leaders {
            leader.inflight.publish(LoadOutcome::Failed(
                "schema load was cancelled before completion".into(),
            ));
        }
    }
}

impl SchemaCache {
    pub fn new(config: SchemaCacheConfig) -> Self {
        Self {
            inner: Arc::new(SchemaCacheInner {
                config,
                state: Mutex::new(SchemaCacheState::default()),
            }),
        }
    }

    pub async fn get_or_load<F, Fut>(
        &self,
        key: &SchemaCacheKey,
        force: bool,
        loader: F,
    ) -> Result<SchemaSnapshot, String>
    where
        F: Fn(Vec<SchemaCacheKey>) -> Fut,
        Fut: Future<Output = Result<Vec<TableMeta>, String>>,
    {
        self.get_or_load_many(std::slice::from_ref(key), force, loader)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| "schema loader returned no result".into())
    }

    pub async fn get_or_load_many<F, Fut>(
        &self,
        keys: &[SchemaCacheKey],
        force: bool,
        loader: F,
    ) -> Result<Vec<SchemaSnapshot>, String>
    where
        F: Fn(Vec<SchemaCacheKey>) -> Fut,
        Fut: Future<Output = Result<Vec<TableMeta>, String>>,
    {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let unique_keys = keys
            .iter()
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let mut resolved = HashMap::<SchemaCacheKey, SchemaSnapshot>::new();
        let mut pending_keys = unique_keys;

        for attempt in 0..=self.inner.config.read_retries {
            let plans = self.plan_loads(&pending_keys, force && attempt == 0);
            let mut leader_tickets = Vec::new();
            for plan in &plans {
                if let LoadPlan::Leader(leader) = plan {
                    leader_tickets.push(leader.clone());
                }
            }
            let leaders = leader_tickets
                .iter()
                .map(|leader| leader.key.clone())
                .collect::<Vec<_>>();
            let mut leader_guard = LeaderCancellationGuard::new(&self.inner, leader_tickets);

            let loaded = if leaders.is_empty() {
                Ok(HashMap::new())
            } else {
                loader(leaders.clone()).await.map(|schemas| {
                    schemas
                        .into_iter()
                        .map(|schema| (normalize_component(&schema.table_name), schema))
                        .collect::<HashMap<_, _>>()
                })
            };

            for plan in &plans {
                let LoadPlan::Leader(leader) = plan else {
                    continue;
                };
                let result = match &loaded {
                    Ok(schemas) => schemas
                        .get(&leader.key.normalized_table_name)
                        .cloned()
                        .ok_or_else(|| {
                            format!(
                                "schema loader omitted requested table: {}",
                                leader.key.table_name()
                            )
                        }),
                    Err(error) => Err(error.clone()),
                };
                self.finish_leader(leader, result);
                leader_guard.complete(leader);
            }

            let mut stale = Vec::new();
            for (key, plan) in pending_keys.iter().zip(plans.iter()) {
                let outcome = match plan {
                    LoadPlan::Hit(snapshot) => LoadOutcome::Loaded(snapshot.clone()),
                    LoadPlan::Pending(inflight) => inflight.wait().await,
                    LoadPlan::Leader(leader) => leader.inflight.wait().await,
                };
                match outcome {
                    LoadOutcome::Loaded(snapshot) if self.is_fresh(key, &snapshot) => {
                        resolved.insert(key.clone(), snapshot);
                    }
                    LoadOutcome::Loaded(_) | LoadOutcome::Stale => stale.push(key.clone()),
                    LoadOutcome::Failed(error) => return Err(error),
                }
            }

            if stale.is_empty() {
                return keys
                    .iter()
                    .map(|key| {
                        resolved
                            .get(key)
                            .cloned()
                            .ok_or_else(|| format!("missing resolved schema: {}", key.table_name()))
                    })
                    .collect();
            }
            pending_keys = stale;
        }

        Err("schema changed repeatedly while it was loading; retry the operation".into())
    }

    pub async fn get_or_load_foreground<F, Fut>(
        &self,
        key: &SchemaCacheKey,
        loader: F,
    ) -> Result<SchemaSnapshot, String>
    where
        F: Fn(Vec<SchemaCacheKey>) -> Fut,
        Fut: Future<Output = Result<Vec<TableMeta>, String>>,
    {
        for _ in 0..=self.inner.config.read_retries {
            let generation = match self.plan_foreground_load(key) {
                ForegroundLoadPlan::Hit(snapshot) | ForegroundLoadPlan::Stale(snapshot) => {
                    return Ok(snapshot);
                }
                ForegroundLoadPlan::Load(generation) => generation,
            };
            let schemas = loader(vec![key.clone()]).await?;
            let schema = schemas
                .into_iter()
                .find(|schema| normalize_component(&schema.table_name) == key.normalized_table_name)
                .ok_or_else(|| {
                    format!(
                        "schema loader omitted requested table: {}",
                        key.table_name()
                    )
                })?;
            match self.finish_foreground_load(key, generation, schema) {
                LoadOutcome::Loaded(snapshot) => return Ok(snapshot),
                LoadOutcome::Stale => continue,
                LoadOutcome::Failed(error) => return Err(error),
            }
        }

        Err("schema changed repeatedly while it was loading; retry the operation".into())
    }

    pub fn invalidate_table(&self, key: &SchemaCacheKey) {
        let mut state = self.lock_state();
        increment(&mut state.table_generations, key.clone());
        state.entries.remove(key);
    }

    pub fn invalidate_database(&self, connection_id: &str, database: &str) {
        let connection_id = normalize_component(connection_id);
        let database = normalize_component(database);
        let mut state = self.lock_state();
        increment(
            &mut state.database_generations,
            (connection_id.clone(), database.clone()),
        );
        state.entries.retain(|key, _| {
            key.normalized_connection_id != connection_id || key.normalized_database != database
        });
    }

    pub fn invalidate_connection(&self, connection_id: &str) {
        let connection_id = normalize_component(connection_id);
        let mut state = self.lock_state();
        increment(&mut state.connection_generations, connection_id.clone());
        state
            .entries
            .retain(|key, _| key.normalized_connection_id != connection_id);
    }

    pub fn invalidate_rename(&self, old_key: &SchemaCacheKey, new_key: &SchemaCacheKey) {
        let mut state = self.lock_state();
        increment(&mut state.table_generations, old_key.clone());
        state.entries.remove(old_key);
        if old_key != new_key {
            increment(&mut state.table_generations, new_key.clone());
            state.entries.remove(new_key);
        }
    }

    pub fn generation_matches(&self, key: &SchemaCacheKey, snapshot: &SchemaSnapshot) -> bool {
        let state = self.lock_state();
        current_generation(&state, key) == snapshot.generation
    }

    pub fn is_fresh(&self, key: &SchemaCacheKey, snapshot: &SchemaSnapshot) -> bool {
        self.generation_matches(key, snapshot)
            && Instant::now().saturating_duration_since(snapshot.loaded_at) < self.inner.config.ttl
    }

    pub fn entry_count(&self) -> usize {
        self.lock_state().entries.len()
    }

    fn plan_loads(&self, keys: &[SchemaCacheKey], force: bool) -> Vec<LoadPlan> {
        let now = Instant::now();
        let mut state = self.lock_state();
        keys.iter()
            .map(|key| {
                let mut generation = current_generation(&state, key);
                if force {
                    if let Some(inflight) = current_inflight(&mut state, key, generation) {
                        return LoadPlan::Pending(inflight);
                    }
                    increment(&mut state.table_generations, key.clone());
                    state.entries.remove(key);
                    generation = current_generation(&state, key);
                } else {
                    let hit = state
                        .entries
                        .get(key)
                        .filter(|entry| {
                            entry.snapshot.generation == generation
                                && now.saturating_duration_since(entry.snapshot.loaded_at)
                                    < self.inner.config.ttl
                        })
                        .map(|entry| entry.snapshot.clone());
                    if let Some(snapshot) = hit {
                        state.access_clock = state.access_clock.saturating_add(1);
                        let access_clock = state.access_clock;
                        if let Some(entry) = state.entries.get_mut(key) {
                            entry.last_used = access_clock;
                        }
                        return LoadPlan::Hit(snapshot);
                    }
                    if let Some(inflight) = current_inflight(&mut state, key, generation) {
                        return LoadPlan::Pending(inflight);
                    }
                }

                let inflight = Arc::new(InFlightLoad::new());
                state
                    .inflight
                    .insert((key.clone(), generation), Arc::downgrade(&inflight));
                LoadPlan::Leader(LoadLeader {
                    key: key.clone(),
                    generation,
                    inflight,
                })
            })
            .collect()
    }

    fn plan_foreground_load(&self, key: &SchemaCacheKey) -> ForegroundLoadPlan {
        let now = Instant::now();
        let mut state = self.lock_state();
        let generation = current_generation(&state, key);
        let usable = state
            .entries
            .get(key)
            .filter(|entry| entry.snapshot.generation == generation)
            .map(|entry| {
                let fresh = now.saturating_duration_since(entry.snapshot.loaded_at)
                    < self.inner.config.ttl;
                (entry.snapshot.clone(), fresh)
            });
        if let Some((snapshot, fresh)) = usable {
            state.access_clock = state.access_clock.saturating_add(1);
            let access_clock = state.access_clock;
            if let Some(entry) = state.entries.get_mut(key) {
                entry.last_used = access_clock;
            }
            if fresh {
                ForegroundLoadPlan::Hit(snapshot)
            } else {
                ForegroundLoadPlan::Stale(snapshot)
            }
        } else {
            ForegroundLoadPlan::Load(generation)
        }
    }

    fn finish_foreground_load(
        &self,
        key: &SchemaCacheKey,
        generation: SchemaGeneration,
        schema: TableMeta,
    ) -> LoadOutcome {
        let now = Instant::now();
        let (outcome, superseded_inflight) = {
            let mut state = self.lock_state();
            if current_generation(&state, key) != generation {
                return LoadOutcome::Stale;
            }
            let superseded_inflight = current_inflight(&mut state, key, generation);
            if superseded_inflight.is_some() {
                state.inflight.remove(&(key.clone(), generation));
            }
            state.access_clock = state.access_clock.saturating_add(1);
            let last_used = state.access_clock;
            let snapshot = SchemaSnapshot {
                schema: Arc::new(schema),
                generation,
                loaded_at: now,
            };
            state.entries.insert(
                key.clone(),
                CacheEntry {
                    snapshot: snapshot.clone(),
                    last_used,
                },
            );
            evict_to_capacity(&mut state, self.inner.config.capacity);
            (LoadOutcome::Loaded(snapshot), superseded_inflight)
        };
        if let Some(inflight) = superseded_inflight {
            inflight.publish(outcome.clone());
        }
        outcome
    }

    fn finish_leader(&self, leader: &LoadLeader, result: Result<TableMeta, String>) {
        let now = Instant::now();
        let outcome = {
            let mut state = self.lock_state();
            if !matching_inflight(&state, leader) {
                return;
            }
            remove_matching_inflight(&mut state, leader);
            if current_generation(&state, &leader.key) != leader.generation {
                LoadOutcome::Stale
            } else {
                match result {
                    Ok(schema) => {
                        state.access_clock = state.access_clock.saturating_add(1);
                        let last_used = state.access_clock;
                        let snapshot = SchemaSnapshot {
                            schema: Arc::new(schema),
                            generation: leader.generation,
                            loaded_at: now,
                        };
                        state.entries.insert(
                            leader.key.clone(),
                            CacheEntry {
                                snapshot: snapshot.clone(),
                                last_used,
                            },
                        );
                        evict_to_capacity(&mut state, self.inner.config.capacity);
                        LoadOutcome::Loaded(snapshot)
                    }
                    Err(error) => LoadOutcome::Failed(error),
                }
            }
        };
        leader.inflight.publish(outcome);
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, SchemaCacheState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Default for SchemaCache {
    fn default() -> Self {
        Self::new(SchemaCacheConfig::default())
    }
}

fn increment<K>(generations: &mut HashMap<K, u64>, key: K)
where
    K: Eq + Hash,
{
    let generation = generations.entry(key).or_default();
    *generation = generation.saturating_add(1);
}

fn current_generation(state: &SchemaCacheState, key: &SchemaCacheKey) -> SchemaGeneration {
    SchemaGeneration {
        connection: state
            .connection_generations
            .get(&key.normalized_connection_id)
            .copied()
            .unwrap_or_default(),
        database: state
            .database_generations
            .get(&(
                key.normalized_connection_id.clone(),
                key.normalized_database.clone(),
            ))
            .copied()
            .unwrap_or_default(),
        table: state
            .table_generations
            .get(key)
            .copied()
            .unwrap_or_default(),
    }
}

fn current_inflight(
    state: &mut SchemaCacheState,
    key: &SchemaCacheKey,
    generation: SchemaGeneration,
) -> Option<Arc<InFlightLoad>> {
    let inflight_key = (key.clone(), generation);
    let inflight = state.inflight.get(&inflight_key).and_then(Weak::upgrade);
    if inflight.is_none() {
        state.inflight.remove(&inflight_key);
    }
    inflight
}

fn remove_matching_inflight(state: &mut SchemaCacheState, leader: &LoadLeader) {
    if matching_inflight(state, leader) {
        state
            .inflight
            .remove(&(leader.key.clone(), leader.generation));
    }
}

fn matching_inflight(state: &SchemaCacheState, leader: &LoadLeader) -> bool {
    let inflight_key = (leader.key.clone(), leader.generation);
    state
        .inflight
        .get(&inflight_key)
        .and_then(Weak::upgrade)
        .is_some_and(|inflight| Arc::ptr_eq(&inflight, &leader.inflight))
}

fn evict_to_capacity(state: &mut SchemaCacheState, capacity: usize) {
    while state.entries.len() > capacity {
        let eviction_key = state
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| key.clone());
        let Some(eviction_key) = eviction_key else {
            break;
        };
        state.entries.remove(&eviction_key);
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };

    use tokio::sync::Semaphore;

    use crate::types::{ColumnMeta, TableMeta};

    use super::{SchemaCache, SchemaCacheConfig, SchemaCacheKey};

    fn key(connection: &str, database: &str, table: &str) -> SchemaCacheKey {
        SchemaCacheKey::new(connection, database, table)
    }

    fn schema(table: &str, marker: &str) -> TableMeta {
        TableMeta {
            primary_key_order: Vec::new(),
            table_name: table.into(),
            table_comment: marker.into(),
            columns: vec![ColumnMeta::with_basic(
                marker,
                "varchar(32)",
                "",
                false,
                true,
            )],
        }
    }

    fn cache(ttl: Duration, capacity: usize) -> SchemaCache {
        SchemaCache::new(
            SchemaCacheConfig::new(ttl, capacity, 1).expect("valid schema cache config"),
        )
    }

    #[tokio::test]
    async fn concurrent_reads_share_one_loader_and_one_arc() {
        let cache = Arc::new(cache(Duration::from_secs(60), 16));
        let cache_key = key("mysql-1", "game", "hero");
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));

        let spawn_read = || {
            let cache = Arc::clone(&cache);
            let cache_key = cache_key.clone();
            let calls = Arc::clone(&calls);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            tokio::spawn(async move {
                cache
                    .get_or_load(&cache_key, false, move |_| {
                        let calls = Arc::clone(&calls);
                        let started = Arc::clone(&started);
                        let release = Arc::clone(&release);
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            started.add_permits(1);
                            let permit = release.acquire().await.unwrap();
                            permit.forget();
                            Ok(vec![schema("hero", "shared")])
                        }
                    })
                    .await
                    .unwrap()
            })
        };

        let first = spawn_read();
        started.acquire().await.unwrap().forget();
        let second = spawn_read();
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        release.add_permits(1);
        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert!(Arc::ptr_eq(first.schema(), second.schema()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn foreground_read_does_not_wait_for_a_background_batch() {
        let cache = Arc::new(cache(Duration::from_secs(60), 16));
        let hero = key("mysql-1", "game", "hero");
        let item = key("mysql-1", "game", "item");
        let background_started = Arc::new(Semaphore::new(0));
        let release_background = Arc::new(Semaphore::new(0));

        let background = tokio::spawn({
            let cache = Arc::clone(&cache);
            let hero = hero.clone();
            let item = item.clone();
            let background_started = Arc::clone(&background_started);
            let release_background = Arc::clone(&release_background);
            async move {
                cache
                    .get_or_load_many(&[hero, item], false, move |keys| {
                        let background_started = Arc::clone(&background_started);
                        let release_background = Arc::clone(&release_background);
                        async move {
                            background_started.add_permits(1);
                            release_background.acquire().await.unwrap().forget();
                            Ok(keys
                                .into_iter()
                                .map(|key| schema(key.table_name(), "background"))
                                .collect())
                        }
                    })
                    .await
                    .unwrap()
            }
        });
        background_started.acquire().await.unwrap().forget();

        let foreground_keys = Arc::new(std::sync::Mutex::new(Vec::new()));
        let foreground = tokio::time::timeout(
            Duration::from_millis(100),
            cache.get_or_load_foreground(&hero, {
                let foreground_keys = Arc::clone(&foreground_keys);
                move |keys| {
                    foreground_keys
                        .lock()
                        .unwrap()
                        .extend(keys.iter().map(|key| key.table_name().to_string()));
                    async move { Ok(vec![schema(keys[0].table_name(), "foreground")]) }
                }
            }),
        )
        .await
        .expect("foreground schema must not wait for the background batch")
        .unwrap();

        assert_eq!(foreground.schema().table_comment, "foreground");
        assert_eq!(*foreground_keys.lock().unwrap(), vec!["hero"]);

        release_background.add_permits(1);
        background.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn foreground_open_reuses_an_expired_snapshot_without_calling_the_loader() {
        let cache = cache(Duration::from_secs(10), 16);
        let cache_key = key("mysql-1", "game", "hero");
        let calls = Arc::new(AtomicUsize::new(0));
        let load = |_: Vec<SchemaCacheKey>| {
            let calls = Arc::clone(&calls);
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(vec![schema("hero", "cached")])
            }
        };

        let first = cache.get_or_load(&cache_key, false, load).await.unwrap();
        tokio::time::advance(Duration::from_secs(10)).await;
        let stale = cache
            .get_or_load_foreground(&cache_key, load)
            .await
            .unwrap();

        assert_eq!(first.schema().table_comment, "cached");
        assert!(Arc::ptr_eq(first.schema(), stale.schema()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(cache.generation_matches(&cache_key, &stale));
        assert!(!cache.is_fresh(&cache_key, &stale));
    }

    #[tokio::test(start_paused = true)]
    async fn foreground_stale_hit_does_not_wait_for_a_background_batch() {
        let cache = Arc::new(cache(Duration::from_secs(10), 16));
        let hero = key("mysql-1", "game", "hero");
        let item = key("mysql-1", "game", "item");
        cache
            .get_or_load(&hero, false, |_| async { Ok(vec![schema("hero", "cached")]) })
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(10)).await;

        let background_started = Arc::new(Semaphore::new(0));
        let release_background = Arc::new(Semaphore::new(0));
        let background = tokio::spawn({
            let cache = Arc::clone(&cache);
            let hero = hero.clone();
            let item = item.clone();
            let background_started = Arc::clone(&background_started);
            let release_background = Arc::clone(&release_background);
            async move {
                cache
                    .get_or_load_many(&[hero, item], false, move |keys| {
                        let background_started = Arc::clone(&background_started);
                        let release_background = Arc::clone(&release_background);
                        async move {
                            background_started.add_permits(1);
                            release_background.acquire().await.unwrap().forget();
                            Ok(keys
                                .into_iter()
                                .map(|key| schema(key.table_name(), "background"))
                                .collect())
                        }
                    })
                    .await
                    .unwrap()
            }
        });
        background_started.acquire().await.unwrap().forget();

        let foreground = tokio::time::timeout(
            Duration::from_millis(100),
            cache.get_or_load_foreground(&hero, |_| async {
                panic!("foreground stale hit must not load");
                #[allow(unreachable_code)]
                Ok(Vec::new())
            }),
        )
        .await
        .expect("foreground schema must not wait for the background batch")
        .unwrap();

        assert_eq!(foreground.schema().table_comment, "cached");

        release_background.add_permits(1);
        background.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn ttl_refreshes_external_ddl_without_manual_invalidation() {
        let cache = cache(Duration::from_secs(10), 16);
        let cache_key = key("mysql-1", "game", "hero");
        let calls = Arc::new(AtomicUsize::new(0));
        let load = |_: Vec<SchemaCacheKey>| {
            let calls = Arc::clone(&calls);
            async move {
                let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(vec![schema("hero", &format!("version-{call}"))])
            }
        };

        let first = cache.get_or_load(&cache_key, false, load).await.unwrap();
        tokio::time::advance(Duration::from_secs(9)).await;
        let cached = cache.get_or_load(&cache_key, false, load).await.unwrap();
        tokio::time::advance(Duration::from_secs(1)).await;
        let refreshed = cache.get_or_load(&cache_key, false, load).await.unwrap();

        assert_eq!(first.schema().table_comment, "version-1");
        assert!(Arc::ptr_eq(first.schema(), cached.schema()));
        assert_eq!(refreshed.schema().table_comment, "version-2");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn force_refresh_bypasses_a_fresh_entry_and_coalesces() {
        let cache = cache(Duration::from_secs(60), 16);
        let cache_key = key("mysql-1", "game", "hero");
        let calls = Arc::new(AtomicUsize::new(0));
        let load = |_: Vec<SchemaCacheKey>| {
            let calls = Arc::clone(&calls);
            async move {
                let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(vec![schema("hero", &format!("version-{call}"))])
            }
        };

        let first = cache.get_or_load(&cache_key, false, load).await.unwrap();
        let forced = cache.get_or_load(&cache_key, true, load).await.unwrap();

        assert_eq!(first.schema().table_comment, "version-1");
        assert_eq!(forced.schema().table_comment, "version-2");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn targeted_ddl_invalidation_preserves_unaffected_tables() {
        let cache = cache(Duration::from_secs(60), 16);
        let hero = key("mysql-1", "game", "hero");
        let item = key("mysql-1", "game", "item");
        let calls = Arc::new(AtomicUsize::new(0));
        let load = |keys: Vec<SchemaCacheKey>| {
            let calls = Arc::clone(&calls);
            async move {
                calls.fetch_add(keys.len(), Ordering::SeqCst);
                Ok(keys
                    .into_iter()
                    .map(|key| schema(key.table_name(), key.table_name()))
                    .collect())
            }
        };

        let hero_before = cache.get_or_load(&hero, false, load).await.unwrap();
        let item_before = cache.get_or_load(&item, false, load).await.unwrap();
        cache.invalidate_table(&hero);
        let hero_after = cache.get_or_load(&hero, false, load).await.unwrap();
        let item_after = cache.get_or_load(&item, false, load).await.unwrap();

        assert!(!Arc::ptr_eq(hero_before.schema(), hero_after.schema()));
        assert!(Arc::ptr_eq(item_before.schema(), item_after.schema()));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn database_restore_invalidates_only_that_database() {
        let cache = cache(Duration::from_secs(60), 16);
        let game = key("mysql-1", "game", "hero");
        let config = key("mysql-1", "config", "hero");
        let calls = Arc::new(AtomicUsize::new(0));
        let load = |keys: Vec<SchemaCacheKey>| {
            let calls = Arc::clone(&calls);
            async move {
                calls.fetch_add(keys.len(), Ordering::SeqCst);
                Ok(keys
                    .into_iter()
                    .map(|key| schema(key.table_name(), key.database()))
                    .collect())
            }
        };

        let game_before = cache.get_or_load(&game, false, load).await.unwrap();
        let config_before = cache.get_or_load(&config, false, load).await.unwrap();
        cache.invalidate_database("mysql-1", "GAME");
        let game_after = cache.get_or_load(&game, false, load).await.unwrap();
        let config_after = cache.get_or_load(&config, false, load).await.unwrap();

        assert!(!Arc::ptr_eq(game_before.schema(), game_after.schema()));
        assert!(Arc::ptr_eq(config_before.schema(), config_after.schema()));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn connection_reconfiguration_or_removal_invalidates_all_databases() {
        let cache = cache(Duration::from_secs(60), 16);
        let first = key("mysql-1", "game", "hero");
        let second = key("mysql-1", "config", "item");
        let other = key("mysql-2", "game", "hero");
        let calls = Arc::new(AtomicUsize::new(0));
        let load = |keys: Vec<SchemaCacheKey>| {
            let calls = Arc::clone(&calls);
            async move {
                calls.fetch_add(keys.len(), Ordering::SeqCst);
                Ok(keys
                    .into_iter()
                    .map(|key| schema(key.table_name(), key.connection_id()))
                    .collect())
            }
        };

        let first_before = cache.get_or_load(&first, false, load).await.unwrap();
        let second_before = cache.get_or_load(&second, false, load).await.unwrap();
        let other_before = cache.get_or_load(&other, false, load).await.unwrap();
        cache.invalidate_connection("MYSQL-1");
        let first_after = cache.get_or_load(&first, false, load).await.unwrap();
        let second_after = cache.get_or_load(&second, false, load).await.unwrap();
        let other_after = cache.get_or_load(&other, false, load).await.unwrap();

        assert!(!Arc::ptr_eq(first_before.schema(), first_after.schema()));
        assert!(!Arc::ptr_eq(second_before.schema(), second_after.schema()));
        assert!(Arc::ptr_eq(other_before.schema(), other_after.schema()));
        assert_eq!(calls.load(Ordering::SeqCst), 5);
    }

    #[tokio::test]
    async fn rename_invalidates_both_old_and_new_table_keys() {
        let cache = cache(Duration::from_secs(60), 16);
        let old = key("mysql-1", "game", "hero_old");
        let new = key("mysql-1", "game", "hero_new");
        let calls = Arc::new(AtomicUsize::new(0));
        let load = |keys: Vec<SchemaCacheKey>| {
            let calls = Arc::clone(&calls);
            async move {
                calls.fetch_add(keys.len(), Ordering::SeqCst);
                Ok(keys
                    .into_iter()
                    .map(|key| schema(key.table_name(), key.table_name()))
                    .collect())
            }
        };

        let old_before = cache.get_or_load(&old, false, load).await.unwrap();
        let new_before = cache.get_or_load(&new, false, load).await.unwrap();
        cache.invalidate_rename(&old, &new);
        let old_after = cache.get_or_load(&old, false, load).await.unwrap();
        let new_after = cache.get_or_load(&new, false, load).await.unwrap();

        assert!(!Arc::ptr_eq(old_before.schema(), old_after.schema()));
        assert!(!Arc::ptr_eq(new_before.schema(), new_after.schema()));
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn cache_keys_normalize_connection_database_and_table_case_and_whitespace() {
        let cache = cache(Duration::from_secs(60), 16);
        let calls = Arc::new(AtomicUsize::new(0));
        let load = |keys: Vec<SchemaCacheKey>| {
            let calls = Arc::clone(&calls);
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(vec![schema(keys[0].table_name(), "canonical")])
            }
        };

        let first = cache
            .get_or_load(&key(" MySQL-1 ", " Game ", " Hero "), false, load)
            .await
            .unwrap();
        let second = cache
            .get_or_load(&key("mysql-1", "game", "hero"), false, load)
            .await
            .unwrap();

        assert!(Arc::ptr_eq(first.schema(), second.schema()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn late_inflight_completion_cannot_repopulate_an_invalidated_generation() {
        let cache = Arc::new(cache(Duration::from_secs(60), 16));
        let cache_key = key("mysql-1", "game", "hero");
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let load = {
            let calls = Arc::clone(&calls);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            move |_: Vec<SchemaCacheKey>| {
                let calls = Arc::clone(&calls);
                let started = Arc::clone(&started);
                let release = Arc::clone(&release);
                async move {
                    let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
                    if call == 1 {
                        started.add_permits(1);
                        release.acquire().await.unwrap().forget();
                    }
                    Ok(vec![schema(
                        "hero",
                        if call == 1 { "stale" } else { "fresh" },
                    )])
                }
            }
        };

        let first = tokio::spawn({
            let cache = Arc::clone(&cache);
            let cache_key = cache_key.clone();
            let load = load.clone();
            async move { cache.get_or_load(&cache_key, false, load).await.unwrap() }
        });
        started.acquire().await.unwrap().forget();
        cache.invalidate_table(&cache_key);
        let second = tokio::spawn({
            let cache = Arc::clone(&cache);
            let cache_key = cache_key.clone();
            let load = load.clone();
            async move { cache.get_or_load(&cache_key, false, load).await.unwrap() }
        });
        release.add_permits(1);

        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert_eq!(first.schema().table_comment, "fresh");
        assert_eq!(second.schema().table_comment, "fresh");
        assert!(Arc::ptr_eq(first.schema(), second.schema()));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn capacity_evicts_the_least_recently_used_entry() {
        let cache = cache(Duration::from_secs(60), 2);
        let a = key("mysql-1", "game", "a");
        let b = key("mysql-1", "game", "b");
        let c = key("mysql-1", "game", "c");
        let calls = Arc::new(AtomicUsize::new(0));
        let load = |keys: Vec<SchemaCacheKey>| {
            let calls = Arc::clone(&calls);
            async move {
                calls.fetch_add(keys.len(), Ordering::SeqCst);
                Ok(keys
                    .into_iter()
                    .map(|key| schema(key.table_name(), key.table_name()))
                    .collect())
            }
        };

        cache.get_or_load(&a, false, load).await.unwrap();
        cache.get_or_load(&b, false, load).await.unwrap();
        cache.get_or_load(&a, false, load).await.unwrap();
        cache.get_or_load(&c, false, load).await.unwrap();
        cache.get_or_load(&b, false, load).await.unwrap();

        assert_eq!(cache.entry_count(), 2);
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn loader_failures_are_not_cached() {
        let cache = cache(Duration::from_secs(60), 16);
        let cache_key = key("mysql-1", "game", "hero");
        let calls = Arc::new(AtomicUsize::new(0));
        let load = |_: Vec<SchemaCacheKey>| {
            let calls = Arc::clone(&calls);
            async move {
                let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
                if call == 1 {
                    Err("injected schema failure".into())
                } else {
                    Ok(vec![schema("hero", "recovered")])
                }
            }
        };

        assert!(cache.get_or_load(&cache_key, false, load).await.is_err());
        let recovered = cache.get_or_load(&cache_key, false, load).await.unwrap();

        assert_eq!(recovered.schema().table_comment, "recovered");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn cancelling_the_single_flight_leader_wakes_followers_and_allows_recovery() {
        let cache = Arc::new(cache(Duration::from_secs(60), 16));
        let cache_key = key("mysql-1", "game", "hero");
        let started = Arc::new(Semaphore::new(0));
        let leader = tokio::spawn({
            let cache = Arc::clone(&cache);
            let cache_key = cache_key.clone();
            let started = Arc::clone(&started);
            async move {
                cache
                    .get_or_load(&cache_key, false, move |_| {
                        let started = Arc::clone(&started);
                        async move {
                            started.add_permits(1);
                            std::future::pending::<Result<Vec<TableMeta>, String>>().await
                        }
                    })
                    .await
            }
        });
        started.acquire().await.unwrap().forget();
        let follower = tokio::spawn({
            let cache = Arc::clone(&cache);
            let cache_key = cache_key.clone();
            async move {
                cache
                    .get_or_load(&cache_key, false, |_| async {
                        panic!("follower must join the existing single-flight load");
                        #[allow(unreachable_code)]
                        Ok(Vec::new())
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;

        leader.abort();
        assert!(tokio::time::timeout(Duration::from_millis(100), follower)
            .await
            .expect("follower must be woken after leader cancellation")
            .unwrap()
            .is_err());

        let recovered = cache
            .get_or_load(&cache_key, false, |_| async {
                Ok(vec![schema("hero", "recovered")])
            })
            .await
            .unwrap();
        assert_eq!(recovered.schema().table_comment, "recovered");
    }

    #[tokio::test]
    async fn generation_change_retries_one_idempotent_read() {
        let cache = Arc::new(cache(Duration::from_secs(60), 16));
        let cache_key = key("mysql-1", "game", "hero");
        let calls = Arc::new(AtomicUsize::new(0));
        let load = {
            let cache = Arc::clone(&cache);
            let cache_key = cache_key.clone();
            let calls = Arc::clone(&calls);
            move |_: Vec<SchemaCacheKey>| {
                let cache = Arc::clone(&cache);
                let cache_key = cache_key.clone();
                let calls = Arc::clone(&calls);
                async move {
                    let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
                    if call == 1 {
                        cache.invalidate_table(&cache_key);
                    }
                    Ok(vec![schema(
                        "hero",
                        if call == 1 { "stale" } else { "fresh" },
                    )])
                }
            }
        };

        let result = cache.get_or_load(&cache_key, false, load).await.unwrap();

        assert_eq!(result.schema().table_comment, "fresh");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_freshness_tracks_generation_and_ttl_for_long_lived_sessions() {
        let cache = cache(Duration::from_secs(10), 16);
        let cache_key = key("mysql-1", "game", "hero");
        let snapshot = cache
            .get_or_load(&cache_key, false, |_| async {
                Ok(vec![schema("hero", "session")])
            })
            .await
            .unwrap();

        assert!(cache.is_fresh(&cache_key, &snapshot));
        tokio::time::advance(Duration::from_secs(10)).await;
        assert!(!cache.is_fresh(&cache_key, &snapshot));

        let refreshed = cache
            .get_or_load(&cache_key, false, |_| async {
                Ok(vec![schema("hero", "refreshed")])
            })
            .await
            .unwrap();
        assert!(cache.is_fresh(&cache_key, &refreshed));
        cache.invalidate_table(&cache_key);
        assert!(!cache.is_fresh(&cache_key, &refreshed));
    }
}
