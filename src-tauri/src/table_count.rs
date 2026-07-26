use std::{
    collections::{HashMap, HashSet},
    fmt,
    future::Future,
    hash::Hash,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use sqlx::MySqlPool;
use tokio::{
    sync::{watch, Mutex as AsyncMutex, OnceCell},
    time::Instant,
};

use crate::{
    runtime_resources::PoolKey,
    types::{TableCountResult, TablePageFilter},
    work_scheduler::WorkCancellation,
};

const DEFAULT_COUNT_TTL: Duration = Duration::from_secs(30);
const DEFAULT_COUNT_CAPACITY: usize = 256;

fn normalize_component(value: &str) -> String {
    value.trim().to_lowercase()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TableCountConfigError {
    EmptyTtl,
    EmptyCapacity,
}

impl fmt::Display for TableCountConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyTtl => formatter.write_str("table count TTL must be greater than zero"),
            Self::EmptyCapacity => {
                formatter.write_str("table count cache capacity must be greater than zero")
            }
        }
    }
}

impl std::error::Error for TableCountConfigError {}

#[derive(Debug, Clone, Copy)]
pub struct TableCountConfig {
    ttl: Duration,
    capacity: usize,
}

impl TableCountConfig {
    pub fn new(ttl: Duration, capacity: usize) -> Result<Self, TableCountConfigError> {
        if ttl.is_zero() {
            return Err(TableCountConfigError::EmptyTtl);
        }
        if capacity == 0 {
            return Err(TableCountConfigError::EmptyCapacity);
        }
        Ok(Self { ttl, capacity })
    }
}

impl Default for TableCountConfig {
    fn default() -> Self {
        Self::new(DEFAULT_COUNT_TTL, DEFAULT_COUNT_CAPACITY)
            .expect("default table count config must be valid")
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub(crate) struct CountFilterSignature {
    query: String,
    columns: Vec<String>,
    mode: String,
}

impl CountFilterSignature {
    pub(crate) fn from_filter(filter: Option<&TablePageFilter>) -> Self {
        let Some(filter) = filter else {
            return Self::default();
        };
        let query = filter.query.trim().to_string();
        if query.is_empty() {
            return Self::default();
        }
        let mut columns = filter
            .columns
            .iter()
            .map(|column| normalize_component(column))
            .filter(|column| !column.is_empty())
            .collect::<Vec<_>>();
        columns.sort_unstable();
        columns.dedup();
        let mode = match filter.mode.as_deref().map(str::trim) {
            Some(mode) if mode.eq_ignore_ascii_case("exact") => "exact",
            Some(mode) if mode.eq_ignore_ascii_case("continuous") => "continuous",
            _ => "fuzzy",
        };
        Self {
            query,
            columns,
            mode: mode.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CountTableKey {
    pool_key: PoolKey,
    table_name: String,
}

impl CountTableKey {
    fn new(pool_key: &PoolKey, table_name: &str) -> Self {
        Self {
            pool_key: pool_key.clone(),
            table_name: normalize_component(table_name),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CountBaseKey {
    table: CountTableKey,
    filter: CountFilterSignature,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct CountGeneration {
    database: u64,
    table: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CountKey {
    base: CountBaseKey,
    generation: CountGeneration,
}

#[derive(Clone)]
enum CountOutcome {
    Loaded(TableCountResult),
    Stale,
    Failed(String),
}

impl CountOutcome {
    fn into_result(self) -> Result<TableCountResult, String> {
        match self {
            Self::Loaded(result) => Ok(result),
            Self::Stale => Err("table count result is stale".into()),
            Self::Failed(error) => Err(error),
        }
    }
}

struct InFlightCount {
    id: u64,
    cancellation: WorkCancellation,
    sender: watch::Sender<Option<CountOutcome>>,
}

impl InFlightCount {
    fn new(id: u64) -> Self {
        let (sender, _) = watch::channel(None);
        Self {
            id,
            cancellation: WorkCancellation::new(),
            sender,
        }
    }

    fn publish(&self, outcome: CountOutcome) {
        self.sender.send_replace(Some(outcome));
    }

    async fn wait(&self, cancellation: &WorkCancellation) -> Result<TableCountResult, String> {
        let mut receiver = self.sender.subscribe();
        if let Some(outcome) = receiver.borrow_and_update().clone() {
            return outcome.into_result();
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err("table count request was cancelled".into()),
            outcome = async {
                loop {
                    if receiver.changed().await.is_err() {
                        return CountOutcome::Failed("table count worker ended without a result".into());
                    }
                    if let Some(outcome) = receiver.borrow_and_update().clone() {
                        return outcome;
                    }
                }
            } => outcome.into_result(),
        }
    }
}

struct InFlightEntry {
    flight: Arc<InFlightCount>,
    waiter_ids: HashSet<String>,
}

struct RequestRegistration {
    key: CountKey,
    flight_id: u64,
    cancellation: WorkCancellation,
}

struct CacheEntry {
    value: TableCountResult,
    loaded_at: Instant,
    last_used: u64,
}

#[derive(Default)]
struct TableCountState {
    entries: HashMap<CountKey, CacheEntry>,
    inflight: HashMap<CountKey, InFlightEntry>,
    requests: HashMap<String, RequestRegistration>,
    database_generations: HashMap<PoolKey, u64>,
    table_generations: HashMap<CountTableKey, u64>,
    access_clock: u64,
    next_flight_id: u64,
}

struct TableCountInner {
    config: TableCountConfig,
    state: Mutex<TableCountState>,
    count_pools: AsyncMutex<HashMap<PoolKey, Arc<OnceCell<MySqlPool>>>>,
}

#[derive(Clone)]
pub struct TableCountManager {
    inner: Arc<TableCountInner>,
}

enum LoadPlan {
    Hit(TableCountResult),
    Wait {
        flight: Arc<InFlightCount>,
        request: RequestGuard,
    },
    Lead {
        key: CountKey,
        flight: Arc<InFlightCount>,
        request: RequestGuard,
    },
}

struct RequestGuard {
    manager: Weak<TableCountInner>,
    request_id: String,
    flight_id: u64,
    cancellation: WorkCancellation,
}

struct LeaderGuard {
    manager: Weak<TableCountInner>,
    key: CountKey,
    flight: Arc<InFlightCount>,
    completed: bool,
}

impl LeaderGuard {
    fn new(manager: &Arc<TableCountInner>, key: CountKey, flight: Arc<InFlightCount>) -> Self {
        Self {
            manager: Arc::downgrade(manager),
            key,
            flight,
            completed: false,
        }
    }

    fn complete(&mut self) {
        self.completed = true;
    }
}

impl Drop for LeaderGuard {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let Some(manager) = self.manager.upgrade() else {
            return;
        };
        abort_flight_inner(&manager, &self.key, &self.flight);
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        let Some(manager) = self.manager.upgrade() else {
            return;
        };
        cancel_request_inner(&manager, &self.request_id, Some(self.flight_id));
    }
}

impl TableCountManager {
    pub fn new(config: TableCountConfig) -> Self {
        Self {
            inner: Arc::new(TableCountInner {
                config,
                state: Mutex::new(TableCountState::default()),
                count_pools: AsyncMutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn get_or_load<F, Fut>(
        &self,
        request_id: &str,
        pool_key: &PoolKey,
        table_name: &str,
        filter: Option<&TablePageFilter>,
        loader: F,
    ) -> Result<TableCountResult, String>
    where
        F: FnOnce(WorkCancellation) -> Fut,
        Fut: Future<Output = Result<TableCountResult, String>>,
    {
        let plan = self.plan_load(request_id, pool_key, table_name, filter);
        match plan {
            LoadPlan::Hit(value) => Ok(value),
            LoadPlan::Wait { flight, request } => flight.wait(&request.cancellation).await,
            LoadPlan::Lead {
                key,
                flight,
                request,
            } => {
                let mut leader_guard =
                    LeaderGuard::new(&self.inner, key.clone(), Arc::clone(&flight));
                let loaded = loader(flight.cancellation.clone()).await;
                let requested_outcome = loaded
                    .map(CountOutcome::Loaded)
                    .unwrap_or_else(CountOutcome::Failed);
                let outcome = self.complete_flight(&key, &flight, requested_outcome);
                leader_guard.complete();
                flight.publish(outcome.clone());
                if request.cancellation.is_cancelled() {
                    Err("table count request was cancelled".into())
                } else {
                    outcome.into_result()
                }
            }
        }
    }

    pub fn cancel_request(&self, request_id: &str) -> bool {
        cancel_request_inner(&self.inner, request_id, None)
    }

    pub async fn get_or_connect_count_pool<F, Fut>(
        &self,
        key: PoolKey,
        connect: F,
    ) -> Result<MySqlPool, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<MySqlPool, String>>,
    {
        let lookup_key = key.clone();
        let cell = {
            let mut pools = self.inner.count_pools.lock().await;
            pools
                .entry(key)
                .or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };
        let pool = cell.get_or_try_init(connect).await?.clone();
        let retained = self
            .inner
            .count_pools
            .lock()
            .await
            .get(&lookup_key)
            .is_some_and(|registered| Arc::ptr_eq(registered, &cell));
        if !retained {
            pool.close().await;
            return Err("table count connection was closed".into());
        }
        Ok(pool)
    }

    pub async fn close_connection_pools(&self, connection_id: &str) -> usize {
        let pools = {
            let mut entries = self.inner.count_pools.lock().await;
            let keys = entries
                .keys()
                .filter(|key| key.connection_id() == connection_id)
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| entries.remove(&key))
                .filter_map(|cell| cell.get().cloned())
                .collect::<Vec<_>>()
        };
        let count = pools.len();
        for pool in pools {
            pool.close().await;
        }
        count
    }

    pub fn invalidate_table(&self, pool_key: &PoolKey, table_name: &str) {
        let table_key = CountTableKey::new(pool_key, table_name);
        let match_key = table_key.clone();
        self.invalidate_matching(
            |base| base.table == match_key,
            |state| {
                *state.table_generations.entry(table_key).or_default() += 1;
            },
        );
    }

    pub fn invalidate_database(&self, pool_key: &PoolKey) {
        let pool_key = pool_key.clone();
        let match_key = pool_key.clone();
        self.invalidate_matching(
            |base| base.table.pool_key == match_key,
            |state| {
                *state.database_generations.entry(pool_key).or_default() += 1;
            },
        );
    }

    pub fn invalidate_connection(&self, connection_id: &str) {
        let connection_id = connection_id.to_string();
        self.invalidate_matching(
            |base| base.table.pool_key.connection_id() == connection_id,
            |state| {
                let keys = state
                    .database_generations
                    .keys()
                    .filter(|key| key.connection_id() == connection_id)
                    .cloned()
                    .collect::<Vec<_>>();
                for key in keys {
                    *state.database_generations.entry(key).or_default() += 1;
                }
            },
        );
    }

    #[cfg(test)]
    fn cached_entry_count(&self) -> usize {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entries
            .len()
    }

    fn plan_load(
        &self,
        request_id: &str,
        pool_key: &PoolKey,
        table_name: &str,
        filter: Option<&TablePageFilter>,
    ) -> LoadPlan {
        cancel_request_inner(&self.inner, request_id, None);
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Instant::now();
        state.entries.retain(|_, entry| {
            now.saturating_duration_since(entry.loaded_at) < self.inner.config.ttl
        });
        let table = CountTableKey::new(pool_key, table_name);
        let generation = CountGeneration {
            database: state
                .database_generations
                .get(pool_key)
                .copied()
                .unwrap_or(0),
            table: state.table_generations.get(&table).copied().unwrap_or(0),
        };
        let key = CountKey {
            base: CountBaseKey {
                table,
                filter: CountFilterSignature::from_filter(filter),
            },
            generation,
        };
        state.access_clock = state.access_clock.wrapping_add(1);
        let access_clock = state.access_clock;
        if let Some(entry) = state.entries.get_mut(&key) {
            entry.last_used = access_clock;
            return LoadPlan::Hit(entry.value.clone());
        }

        let waiter_cancellation = WorkCancellation::new();
        if let Some(entry) = state.inflight.get_mut(&key) {
            let flight = Arc::clone(&entry.flight);
            entry.waiter_ids.insert(request_id.into());
            state.requests.insert(
                request_id.into(),
                RequestRegistration {
                    key: key.clone(),
                    flight_id: flight.id,
                    cancellation: waiter_cancellation.clone(),
                },
            );
            return LoadPlan::Wait {
                request: RequestGuard {
                    manager: Arc::downgrade(&self.inner),
                    request_id: request_id.into(),
                    flight_id: flight.id,
                    cancellation: waiter_cancellation,
                },
                flight,
            };
        }

        state.next_flight_id = state.next_flight_id.wrapping_add(1).max(1);
        let flight = Arc::new(InFlightCount::new(state.next_flight_id));
        state.inflight.insert(
            key.clone(),
            InFlightEntry {
                flight: Arc::clone(&flight),
                waiter_ids: HashSet::from([request_id.into()]),
            },
        );
        state.requests.insert(
            request_id.into(),
            RequestRegistration {
                key: key.clone(),
                flight_id: flight.id,
                cancellation: waiter_cancellation.clone(),
            },
        );
        LoadPlan::Lead {
            key,
            request: RequestGuard {
                manager: Arc::downgrade(&self.inner),
                request_id: request_id.into(),
                flight_id: flight.id,
                cancellation: waiter_cancellation,
            },
            flight,
        }
    }

    fn complete_flight(
        &self,
        key: &CountKey,
        flight: &Arc<InFlightCount>,
        outcome: CountOutcome,
    ) -> CountOutcome {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let matching = state
            .inflight
            .get(key)
            .is_some_and(|entry| entry.flight.id == flight.id);
        if !matching {
            return CountOutcome::Stale;
        }
        let entry = state.inflight.remove(key).expect("matching flight exists");
        for request_id in entry.waiter_ids {
            if state
                .requests
                .get(&request_id)
                .is_some_and(|request| request.flight_id == flight.id)
            {
                state.requests.remove(&request_id);
            }
        }
        let current_generation = CountGeneration {
            database: state
                .database_generations
                .get(&key.base.table.pool_key)
                .copied()
                .unwrap_or(0),
            table: state
                .table_generations
                .get(&key.base.table)
                .copied()
                .unwrap_or(0),
        };
        if current_generation != key.generation {
            return CountOutcome::Stale;
        }
        if let CountOutcome::Loaded(value) = &outcome {
            state.access_clock = state.access_clock.wrapping_add(1);
            let access_clock = state.access_clock;
            state.entries.insert(
                key.clone(),
                CacheEntry {
                    value: value.clone(),
                    loaded_at: Instant::now(),
                    last_used: access_clock,
                },
            );
            while state.entries.len() > self.inner.config.capacity {
                let Some(lru_key) = state
                    .entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(key, _)| key.clone())
                else {
                    break;
                };
                state.entries.remove(&lru_key);
            }
        }
        outcome
    }

    fn invalidate_matching<M, B>(&self, mut matches: M, bump_generation: B)
    where
        M: FnMut(&CountBaseKey) -> bool,
        B: FnOnce(&mut TableCountState),
    {
        let flights = {
            let mut state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            bump_generation(&mut state);
            state.entries.retain(|key, _| !matches(&key.base));
            let keys = state
                .inflight
                .keys()
                .filter(|key| matches(&key.base))
                .cloned()
                .collect::<Vec<_>>();
            let mut flights = Vec::with_capacity(keys.len());
            for key in keys {
                let Some(entry) = state.inflight.remove(&key) else {
                    continue;
                };
                for request_id in entry.waiter_ids {
                    if state
                        .requests
                        .get(&request_id)
                        .is_some_and(|request| request.flight_id == entry.flight.id)
                    {
                        state.requests.remove(&request_id);
                    }
                }
                entry.flight.cancellation.cancel();
                flights.push(entry.flight);
            }
            flights
        };
        for flight in flights {
            flight.publish(CountOutcome::Stale);
        }
    }
}

impl Default for TableCountManager {
    fn default() -> Self {
        Self::new(TableCountConfig::default())
    }
}

fn cancel_request_inner(
    manager: &Arc<TableCountInner>,
    request_id: &str,
    expected_flight_id: Option<u64>,
) -> bool {
    let mut state = manager
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(request) = state.requests.get(request_id) else {
        return false;
    };
    if expected_flight_id.is_some_and(|flight_id| flight_id != request.flight_id) {
        return false;
    }
    let request = state
        .requests
        .remove(request_id)
        .expect("request was checked above");
    request.cancellation.cancel();
    let mut cancel_shared = None;
    if let Some(entry) = state.inflight.get_mut(&request.key) {
        if entry.flight.id == request.flight_id {
            entry.waiter_ids.remove(request_id);
            if entry.waiter_ids.is_empty() {
                cancel_shared = Some(Arc::clone(&entry.flight));
            }
        }
    }
    if let Some(flight) = cancel_shared {
        state.inflight.remove(&request.key);
        flight.cancellation.cancel();
    }
    true
}

fn abort_flight_inner(manager: &Arc<TableCountInner>, key: &CountKey, flight: &Arc<InFlightCount>) {
    let removed = {
        let mut state = manager
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let matching = state
            .inflight
            .get(key)
            .is_some_and(|entry| entry.flight.id == flight.id);
        if !matching {
            return;
        }
        let entry = state.inflight.remove(key).expect("matching flight exists");
        for request_id in entry.waiter_ids {
            if state
                .requests
                .get(&request_id)
                .is_some_and(|request| request.flight_id == flight.id)
            {
                state.requests.remove(&request_id);
            }
        }
        true
    };
    if removed {
        flight.cancellation.cancel();
        flight.publish(CountOutcome::Failed(
            "table count leader ended before completion".into(),
        ));
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

    use sqlx::mysql::MySqlPoolOptions;
    use tokio::sync::oneshot;

    use crate::{
        runtime_resources::PoolKey,
        types::{TableCountResult, TablePageFilter},
    };

    use super::{CountFilterSignature, TableCountConfig, TableCountManager};

    fn manager(capacity: usize) -> TableCountManager {
        TableCountManager::new(
            TableCountConfig::new(Duration::from_secs(60), capacity).expect("valid count config"),
        )
    }

    fn key() -> PoolKey {
        PoolKey::new("mysql-1", "game")
    }

    fn exact(total_rows: u64) -> TableCountResult {
        TableCountResult {
            total_rows,
            exact: true,
            estimated: false,
        }
    }

    #[test]
    fn filter_signature_keeps_continuous_distinct_from_fuzzy() {
        let filter = |mode: &str| TablePageFilter {
            query: "hrp".into(),
            columns: vec!["name".into()],
            mode: Some(mode.into()),
        };

        let continuous = CountFilterSignature::from_filter(Some(&filter("continuous")));
        let fuzzy = CountFilterSignature::from_filter(Some(&filter("fuzzy")));

        assert_eq!(continuous.mode, "continuous");
        assert_eq!(fuzzy.mode, "fuzzy");
        assert_ne!(continuous, fuzzy);
    }

    #[tokio::test]
    async fn identical_requests_share_one_inflight_count() {
        let manager = manager(8);
        let loads = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = oneshot::channel();
        let leader = tokio::spawn({
            let manager = manager.clone();
            let loads = Arc::clone(&loads);
            async move {
                manager
                    .get_or_load("request-1", &key(), "hero", None, move |_| async move {
                        loads.fetch_add(1, Ordering::SeqCst);
                        release_rx.await.expect("release leader");
                        Ok(exact(42))
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;
        let follower = tokio::spawn({
            let manager = manager.clone();
            let loads = Arc::clone(&loads);
            async move {
                manager
                    .get_or_load("request-2", &key(), "hero", None, move |_| async move {
                        loads.fetch_add(1, Ordering::SeqCst);
                        Ok(exact(99))
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;
        release_tx.send(()).expect("release count");

        assert_eq!(leader.await.unwrap().unwrap(), exact(42));
        assert_eq!(follower.await.unwrap().unwrap(), exact(42));
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancelling_one_waiter_keeps_shared_work_for_other_waiters() {
        let manager = manager(8);
        let (release_tx, release_rx) = oneshot::channel();
        let leader = tokio::spawn({
            let manager = manager.clone();
            async move {
                manager
                    .get_or_load("leader", &key(), "hero", None, move |_| async move {
                        release_rx.await.expect("release leader");
                        Ok(exact(7))
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;
        let follower = tokio::spawn({
            let manager = manager.clone();
            async move {
                manager
                    .get_or_load("follower", &key(), "hero", None, |_| async {
                        Ok(exact(99))
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;

        assert!(manager.cancel_request("follower"));
        assert!(follower.await.unwrap().unwrap_err().contains("cancel"));
        release_tx.send(()).expect("release count");
        assert_eq!(leader.await.unwrap().unwrap(), exact(7));
    }

    #[tokio::test]
    async fn cancelling_the_last_waiter_cancels_shared_work() {
        let manager = manager(8);
        let shared_cancelled = Arc::new(AtomicUsize::new(0));
        let request = tokio::spawn({
            let manager = manager.clone();
            let shared_cancelled = Arc::clone(&shared_cancelled);
            async move {
                manager
                    .get_or_load(
                        "only",
                        &key(),
                        "hero",
                        None,
                        move |cancellation| async move {
                            while !cancellation.is_cancelled() {
                                tokio::task::yield_now().await;
                            }
                            shared_cancelled.fetch_add(1, Ordering::SeqCst);
                            Err("cancelled by shared token".into())
                        },
                    )
                    .await
            }
        });
        tokio::task::yield_now().await;

        assert!(manager.cancel_request("only"));
        assert!(request.await.unwrap().unwrap_err().contains("cancel"));
        assert_eq!(shared_cancelled.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn aborted_leader_releases_followers_and_allows_retry() {
        let manager = manager(8);
        let leader = tokio::spawn({
            let manager = manager.clone();
            async move {
                manager
                    .get_or_load("leader", &key(), "hero", None, |_| async {
                        std::future::pending::<Result<TableCountResult, String>>().await
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;
        let follower = tokio::spawn({
            let manager = manager.clone();
            async move {
                manager
                    .get_or_load("follower", &key(), "hero", None, |_| async {
                        Ok(exact(99))
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;
        leader.abort();
        let _ = leader.await;

        let follower_result = tokio::time::timeout(Duration::from_millis(100), follower)
            .await
            .expect("follower must be released when its leader aborts")
            .unwrap();
        assert!(follower_result.unwrap_err().contains("ended"));
        assert_eq!(
            manager
                .get_or_load("retry", &key(), "hero", None, |_| async { Ok(exact(5)) })
                .await
                .unwrap(),
            exact(5),
        );
    }

    #[tokio::test]
    async fn mutation_generation_rejects_late_completion() {
        let manager = manager(8);
        let (release_tx, release_rx) = oneshot::channel();
        let stale = tokio::spawn({
            let manager = manager.clone();
            async move {
                manager
                    .get_or_load("stale", &key(), "hero", None, move |_| async move {
                        release_rx.await.expect("release stale count");
                        Ok(exact(10))
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;
        manager.invalidate_table(&key(), "hero");
        release_tx.send(()).expect("release stale work");
        assert!(stale.await.unwrap().unwrap_err().contains("stale"));

        let fresh = manager
            .get_or_load("fresh", &key(), "hero", None, |_| async { Ok(exact(11)) })
            .await
            .unwrap();
        assert_eq!(fresh, exact(11));
    }

    #[tokio::test]
    async fn failures_are_not_cached() {
        let manager = manager(8);
        let loads = AtomicUsize::new(0);
        let first = manager
            .get_or_load("failed", &key(), "hero", None, |_| async {
                loads.fetch_add(1, Ordering::SeqCst);
                Err("count failed".into())
            })
            .await;
        assert!(first.is_err());
        let second = manager
            .get_or_load("retry", &key(), "hero", None, |_| async {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(exact(5))
            })
            .await
            .unwrap();

        assert_eq!(second, exact(5));
        assert_eq!(loads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn table_mutation_invalidates_every_filter_shared_by_sibling_sessions() {
        let manager = manager(8);
        let loads = AtomicUsize::new(0);
        let exact_filter = TablePageFilter {
            query: "Alice".into(),
            columns: vec!["name".into()],
            mode: Some("exact".into()),
        };
        let fuzzy_filter = TablePageFilter {
            query: "ali".into(),
            columns: vec!["name".into()],
            mode: Some("fuzzy".into()),
        };
        for (request_id, filter) in [("session-a", &exact_filter), ("session-b", &fuzzy_filter)] {
            manager
                .get_or_load(request_id, &key(), "hero", Some(filter), |_| async {
                    loads.fetch_add(1, Ordering::SeqCst);
                    Ok(exact(1))
                })
                .await
                .unwrap();
        }
        manager.invalidate_table(&key(), "hero");
        for (request_id, filter) in [
            ("session-a-refresh", &exact_filter),
            ("session-b-refresh", &fuzzy_filter),
        ] {
            manager
                .get_or_load(request_id, &key(), "hero", Some(filter), |_| async {
                    loads.fetch_add(1, Ordering::SeqCst);
                    Ok(exact(2))
                })
                .await
                .unwrap();
        }

        assert_eq!(loads.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn cache_evicts_the_least_recently_used_entry_at_capacity() {
        let manager = manager(2);
        let loads = AtomicUsize::new(0);
        for table in ["first", "second", "third", "first"] {
            manager
                .get_or_load(
                    &format!("request-{table}"),
                    &key(),
                    table,
                    None,
                    |_| async {
                        loads.fetch_add(1, Ordering::SeqCst);
                        Ok(exact(1))
                    },
                )
                .await
                .unwrap();
        }
        assert_eq!(loads.load(Ordering::SeqCst), 4);
        assert_eq!(manager.cached_entry_count(), 2);
    }

    #[tokio::test]
    async fn count_pools_connect_once_per_database_and_close_with_the_connection() {
        let manager = manager(8);
        let connects = Arc::new(AtomicUsize::new(0));
        let connect = || {
            let connects = Arc::clone(&connects);
            async move {
                connects.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                MySqlPoolOptions::new()
                    .max_connections(1)
                    .connect_lazy("mysql://root@127.0.0.1:9/game")
                    .map_err(|error| error.to_string())
            }
        };
        let (first, second) = tokio::join!(
            manager.get_or_connect_count_pool(key(), connect),
            manager.get_or_connect_count_pool(key(), connect),
        );
        let first = first.unwrap();
        let second = second.unwrap();

        assert_eq!(connects.load(Ordering::SeqCst), 1);
        assert_eq!(first.options().get_max_connections(), 1);
        assert_eq!(second.options().get_max_connections(), 1);
        assert_eq!(manager.close_connection_pools("mysql-1").await, 1);
        assert!(first.is_closed());
        assert!(second.is_closed());
    }

    #[test]
    fn filter_signatures_normalize_equivalent_column_sets_and_modes() {
        let left = TablePageFilter {
            query: "  Hero  ".into(),
            columns: vec![" Name ".into(), "ID".into(), "name".into()],
            mode: Some(" EXACT ".into()),
        };
        let right = TablePageFilter {
            query: "Hero".into(),
            columns: vec!["id".into(), "NAME".into()],
            mode: Some("exact".into()),
        };

        assert_eq!(
            CountFilterSignature::from_filter(Some(&left)),
            CountFilterSignature::from_filter(Some(&right)),
        );
        assert_ne!(
            CountFilterSignature::from_filter(Some(&right)),
            CountFilterSignature::from_filter(Some(&TablePageFilter {
                query: "hero".into(),
                ..right
            })),
            "exact query values remain case-sensitive",
        );
    }

    #[test]
    fn page_readers_do_not_contain_count_queries() {
        let mysql = include_str!("db.rs");
        let mysql_page = mysql
            .split("async fn read_db_page_inner")
            .nth(1)
            .and_then(|tail| tail.split("#[cfg(test)]").next())
            .expect("MySQL page reader section");
        assert!(!mysql_page.to_ascii_lowercase().contains("count(*)"));

        let clickhouse = include_str!("clickhouse.rs");
        let clickhouse_page = clickhouse
            .split("async fn read_page_inner")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn search_value_matches").next())
            .expect("ClickHouse page reader section");
        assert!(!clickhouse_page
            .to_ascii_lowercase()
            .contains("build_count_sql"));
    }
}
