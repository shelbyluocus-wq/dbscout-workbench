use std::{
    collections::HashMap,
    fmt,
    future::Future,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use tokio::{
    sync::{watch, OwnedSemaphorePermit, Semaphore},
    time::Instant,
};

use crate::runtime_resources::PoolKey;

const DEFAULT_POOL_CAPACITY: usize = 5;
const DEFAULT_FOREGROUND_RESERVED: usize = 2;
const DEFAULT_MAX_BACKGROUND: usize = 2;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkClass {
    Foreground,
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkScheduleError {
    Cancelled,
    TimedOut,
}

impl fmt::Display for WorkScheduleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("database work was cancelled"),
            Self::TimedOut => formatter.write_str("database work timed out"),
        }
    }
}

impl std::error::Error for WorkScheduleError {}

#[derive(Debug, PartialEq, Eq)]
pub enum ScheduledWorkError<E> {
    Cancelled,
    TimedOut,
    Work(E),
}

impl<E> From<WorkScheduleError> for ScheduledWorkError<E> {
    fn from(error: WorkScheduleError) -> Self {
        match error {
            WorkScheduleError::Cancelled => Self::Cancelled,
            WorkScheduleError::TimedOut => Self::TimedOut,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkSchedulerConfigError {
    EmptyPool,
    InvalidForegroundReservation,
    EmptyBackgroundBudget,
    EmptyTimeout,
}

impl fmt::Display for WorkSchedulerConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyPool => formatter.write_str("pool capacity must be greater than zero"),
            Self::InvalidForegroundReservation => {
                formatter.write_str("foreground reservation must leave background capacity")
            }
            Self::EmptyBackgroundBudget => {
                formatter.write_str("background concurrency must be greater than zero")
            }
            Self::EmptyTimeout => formatter.write_str("work timeout must be greater than zero"),
        }
    }
}

impl std::error::Error for WorkSchedulerConfigError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkSchedulerConfig {
    pool_capacity: usize,
    foreground_reserved: usize,
    max_background: usize,
    default_timeout: Duration,
}

impl WorkSchedulerConfig {
    pub fn new(
        pool_capacity: usize,
        foreground_reserved: usize,
        max_background: usize,
        default_timeout: Duration,
    ) -> Result<Self, WorkSchedulerConfigError> {
        if pool_capacity == 0 {
            return Err(WorkSchedulerConfigError::EmptyPool);
        }
        if foreground_reserved >= pool_capacity {
            return Err(WorkSchedulerConfigError::InvalidForegroundReservation);
        }
        if max_background == 0 {
            return Err(WorkSchedulerConfigError::EmptyBackgroundBudget);
        }
        if default_timeout.is_zero() {
            return Err(WorkSchedulerConfigError::EmptyTimeout);
        }
        Ok(Self {
            pool_capacity,
            foreground_reserved,
            max_background,
            default_timeout,
        })
    }

    pub fn pool_capacity(self) -> usize {
        self.pool_capacity
    }

    pub fn foreground_reserved(self) -> usize {
        self.foreground_reserved
    }

    pub fn max_background(self) -> usize {
        self.max_background
    }

    pub fn background_per_pool(self) -> usize {
        self.pool_capacity - self.foreground_reserved
    }

    pub fn default_timeout(self) -> Duration {
        self.default_timeout
    }
}

impl Default for WorkSchedulerConfig {
    fn default() -> Self {
        Self::new(
            DEFAULT_POOL_CAPACITY,
            DEFAULT_FOREGROUND_RESERVED,
            DEFAULT_MAX_BACKGROUND,
            DEFAULT_TIMEOUT,
        )
        .expect("default database work scheduler config must be valid")
    }
}

#[derive(Clone)]
pub struct WorkCancellation {
    sender: watch::Sender<bool>,
}

impl WorkCancellation {
    pub fn new() -> Self {
        let (sender, _) = watch::channel(false);
        Self { sender }
    }

    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }

    async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        if *receiver.borrow_and_update() {
            return;
        }
        while receiver.changed().await.is_ok() {
            if *receiver.borrow_and_update() {
                return;
            }
        }
    }
}

impl Default for WorkCancellation {
    fn default() -> Self {
        Self::new()
    }
}

struct PoolQuota {
    total: Arc<Semaphore>,
    background: Arc<Semaphore>,
}

impl PoolQuota {
    fn new(config: WorkSchedulerConfig) -> Self {
        Self {
            total: Arc::new(Semaphore::new(config.pool_capacity())),
            background: Arc::new(Semaphore::new(config.background_per_pool())),
        }
    }
}

pub struct WorkPermit {
    _pool_quota: Arc<PoolQuota>,
    _global_background: Option<OwnedSemaphorePermit>,
    _pool_background: Option<OwnedSemaphorePermit>,
    _pool_total: OwnedSemaphorePermit,
}

pub struct WorkScheduler {
    config: WorkSchedulerConfig,
    global_background: Arc<Semaphore>,
    pools: Mutex<HashMap<PoolKey, Weak<PoolQuota>>>,
}

impl WorkScheduler {
    pub fn new(config: WorkSchedulerConfig) -> Self {
        Self {
            global_background: Arc::new(Semaphore::new(config.max_background())),
            config,
            pools: Mutex::new(HashMap::new()),
        }
    }

    pub fn config(&self) -> WorkSchedulerConfig {
        self.config
    }

    pub async fn acquire(
        &self,
        pool_key: &PoolKey,
        class: WorkClass,
        cancellation: &WorkCancellation,
        timeout: Duration,
    ) -> Result<WorkPermit, WorkScheduleError> {
        self.acquire_until(pool_key, class, cancellation, Instant::now() + timeout)
            .await
    }

    pub async fn acquire_default(
        &self,
        pool_key: &PoolKey,
        class: WorkClass,
        cancellation: &WorkCancellation,
    ) -> Result<WorkPermit, WorkScheduleError> {
        self.acquire(pool_key, class, cancellation, self.config.default_timeout())
            .await
    }

    /// Runs one logical unit of work under the shared budget.
    ///
    /// Cancellation and timeout drop `work`. Database callers must not assume
    /// that dropping a driver future also cancels the server-side query. MySQL
    /// background work therefore needs a bounded independent pool and a
    /// database-side statement timeout in addition to this scheduler.
    pub async fn run<F, T, E>(
        &self,
        pool_key: &PoolKey,
        class: WorkClass,
        cancellation: &WorkCancellation,
        timeout: Duration,
        work: F,
    ) -> Result<T, ScheduledWorkError<E>>
    where
        F: Future<Output = Result<T, E>>,
    {
        let deadline = Instant::now() + timeout;
        let _permit = self
            .acquire_until(pool_key, class, cancellation, deadline)
            .await
            .map_err(ScheduledWorkError::from)?;

        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(ScheduledWorkError::Cancelled),
            result = tokio::time::timeout_at(deadline, work) => match result {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(error)) => Err(ScheduledWorkError::Work(error)),
                Err(_) => Err(ScheduledWorkError::TimedOut),
            },
        }
    }

    fn pool_quota(&self, pool_key: &PoolKey) -> Arc<PoolQuota> {
        let mut pools = self
            .pools
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        pools.retain(|_, quota| quota.strong_count() > 0);
        if let Some(quota) = pools.get(pool_key).and_then(Weak::upgrade) {
            return quota;
        }
        let quota = Arc::new(PoolQuota::new(self.config));
        pools.insert(pool_key.clone(), Arc::downgrade(&quota));
        quota
    }

    async fn acquire_until(
        &self,
        pool_key: &PoolKey,
        class: WorkClass,
        cancellation: &WorkCancellation,
        deadline: Instant,
    ) -> Result<WorkPermit, WorkScheduleError> {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(WorkScheduleError::Cancelled),
            result = tokio::time::timeout_at(deadline, self.acquire_unbounded(pool_key, class)) => {
                result.map_err(|_| WorkScheduleError::TimedOut)
            },
        }
    }

    async fn acquire_unbounded(&self, pool_key: &PoolKey, class: WorkClass) -> WorkPermit {
        let quota = self.pool_quota(pool_key);
        let (global_background, pool_background) = match class {
            WorkClass::Foreground => (None, None),
            WorkClass::Background => {
                let global = Arc::clone(&self.global_background)
                    .acquire_owned()
                    .await
                    .expect("work scheduler never closes its global semaphore");
                let pool = Arc::clone(&quota.background)
                    .acquire_owned()
                    .await
                    .expect("work scheduler never closes a pool semaphore");
                (Some(global), Some(pool))
            }
        };
        let pool_total = Arc::clone(&quota.total)
            .acquire_owned()
            .await
            .expect("work scheduler never closes a pool semaphore");

        WorkPermit {
            _pool_quota: quota,
            _global_background: global_background,
            _pool_background: pool_background,
            _pool_total: pool_total,
        }
    }
}

impl Default for WorkScheduler {
    fn default() -> Self {
        Self::new(WorkSchedulerConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        future::pending,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };

    use tokio::sync::{mpsc, oneshot};

    use crate::runtime_resources::PoolKey;

    use super::{
        ScheduledWorkError, WorkCancellation, WorkClass, WorkScheduleError, WorkScheduler,
        WorkSchedulerConfig,
    };

    const TEST_TIMEOUT: Duration = Duration::from_secs(30);

    fn key(database: &str) -> PoolKey {
        PoolKey::new("mysql-1", database)
    }

    fn scheduler_with(
        pool_capacity: usize,
        foreground_reserved: usize,
        max_background: usize,
    ) -> WorkScheduler {
        WorkScheduler::new(
            WorkSchedulerConfig::new(
                pool_capacity,
                foreground_reserved,
                max_background,
                TEST_TIMEOUT,
            )
            .expect("valid scheduler config"),
        )
    }

    async fn spawn_waiter(
        scheduler: Arc<WorkScheduler>,
        pool_key: PoolKey,
        class: WorkClass,
        id: usize,
        acquired_tx: mpsc::UnboundedSender<usize>,
    ) -> tokio::task::JoinHandle<()> {
        let (started_tx, started_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            started_tx.send(()).expect("signal waiter start");
            let cancellation = WorkCancellation::new();
            let _permit = scheduler
                .acquire(&pool_key, class, &cancellation, TEST_TIMEOUT)
                .await
                .expect("waiter acquires permit");
            acquired_tx.send(id).expect("record acquisition");
        });
        started_rx.await.expect("waiter started");
        tokio::task::yield_now().await;
        handle
    }

    #[test]
    fn defaults_reserve_foreground_capacity_and_bound_background_work() {
        let config = WorkSchedulerConfig::default();

        assert_eq!(config.pool_capacity(), 5);
        assert!(config.foreground_reserved() >= 2);
        assert_eq!(config.max_background(), 2);
        assert!(config.background_per_pool() <= 3);
    }

    #[tokio::test]
    async fn background_work_cannot_consume_reserved_per_pool_capacity() {
        let scheduler = scheduler_with(5, 2, 4);
        let pool_key = key("game");
        let cancellation = WorkCancellation::new();

        let _background_one = scheduler
            .acquire(
                &pool_key,
                WorkClass::Background,
                &cancellation,
                TEST_TIMEOUT,
            )
            .await
            .unwrap();
        let _background_two = scheduler
            .acquire(
                &pool_key,
                WorkClass::Background,
                &cancellation,
                TEST_TIMEOUT,
            )
            .await
            .unwrap();
        let _background_three = scheduler
            .acquire(
                &pool_key,
                WorkClass::Background,
                &cancellation,
                TEST_TIMEOUT,
            )
            .await
            .unwrap();

        let scheduler = Arc::new(scheduler);
        let blocked = tokio::spawn({
            let scheduler = Arc::clone(&scheduler);
            let pool_key = pool_key.clone();
            async move {
                let cancellation = WorkCancellation::new();
                scheduler
                    .acquire(
                        &pool_key,
                        WorkClass::Background,
                        &cancellation,
                        TEST_TIMEOUT,
                    )
                    .await
            }
        });
        tokio::task::yield_now().await;
        assert!(!blocked.is_finished(), "fourth background task must queue");

        let foreground_one = scheduler
            .acquire(
                &pool_key,
                WorkClass::Foreground,
                &cancellation,
                TEST_TIMEOUT,
            )
            .await;
        let foreground_two = scheduler
            .acquire(
                &pool_key,
                WorkClass::Foreground,
                &cancellation,
                TEST_TIMEOUT,
            )
            .await;
        assert!(foreground_one.is_ok());
        assert!(foreground_two.is_ok());

        blocked.abort();
    }

    #[tokio::test]
    async fn total_background_concurrency_is_bounded_across_pool_keys() {
        let scheduler = Arc::new(WorkScheduler::default());
        let cancellation = WorkCancellation::new();
        let first = scheduler
            .acquire(
                &key("a"),
                WorkClass::Background,
                &cancellation,
                TEST_TIMEOUT,
            )
            .await
            .unwrap();
        let _second = scheduler
            .acquire(
                &key("b"),
                WorkClass::Background,
                &cancellation,
                TEST_TIMEOUT,
            )
            .await
            .unwrap();

        let third = tokio::spawn({
            let scheduler = Arc::clone(&scheduler);
            async move {
                let cancellation = WorkCancellation::new();
                scheduler
                    .acquire(
                        &key("c"),
                        WorkClass::Background,
                        &cancellation,
                        TEST_TIMEOUT,
                    )
                    .await
            }
        });
        tokio::task::yield_now().await;
        assert!(
            !third.is_finished(),
            "third background task must queue globally"
        );

        drop(first);
        assert!(third.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn foreground_waiters_are_fifo_within_a_pool() {
        let scheduler = Arc::new(scheduler_with(3, 2, 1));
        let pool_key = key("fifo-foreground");
        let cancellation = WorkCancellation::new();
        let mut blockers = Vec::new();
        for _ in 0..3 {
            blockers.push(
                scheduler
                    .acquire(
                        &pool_key,
                        WorkClass::Foreground,
                        &cancellation,
                        TEST_TIMEOUT,
                    )
                    .await
                    .unwrap(),
            );
        }

        let (acquired_tx, mut acquired_rx) = mpsc::unbounded_channel();
        let mut waiters = Vec::new();
        for id in 1..=3 {
            waiters.push(
                spawn_waiter(
                    Arc::clone(&scheduler),
                    pool_key.clone(),
                    WorkClass::Foreground,
                    id,
                    acquired_tx.clone(),
                )
                .await,
            );
        }

        drop(blockers);
        let order = vec![
            acquired_rx.recv().await.unwrap(),
            acquired_rx.recv().await.unwrap(),
            acquired_rx.recv().await.unwrap(),
        ];
        assert_eq!(order, vec![1, 2, 3]);
        for waiter in waiters {
            waiter.await.unwrap();
        }
    }

    #[tokio::test]
    async fn background_waiters_are_fifo_across_pool_keys() {
        let scheduler = Arc::new(scheduler_with(5, 2, 1));
        let cancellation = WorkCancellation::new();
        let blocker = scheduler
            .acquire(
                &key("background-blocker"),
                WorkClass::Background,
                &cancellation,
                TEST_TIMEOUT,
            )
            .await
            .unwrap();
        let (acquired_tx, mut acquired_rx) = mpsc::unbounded_channel();
        let mut waiters = Vec::new();
        for id in 1..=3 {
            waiters.push(
                spawn_waiter(
                    Arc::clone(&scheduler),
                    key(&format!("background-{id}")),
                    WorkClass::Background,
                    id,
                    acquired_tx.clone(),
                )
                .await,
            );
        }

        drop(blocker);
        let order = vec![
            acquired_rx.recv().await.unwrap(),
            acquired_rx.recv().await.unwrap(),
            acquired_rx.recv().await.unwrap(),
        ];
        assert_eq!(order, vec![1, 2, 3]);
        for waiter in waiters {
            waiter.await.unwrap();
        }
    }

    #[tokio::test]
    async fn queued_background_work_does_not_block_foreground_admission() {
        let scheduler = Arc::new(scheduler_with(5, 2, 1));
        let cancellation = WorkCancellation::new();
        let background = scheduler
            .acquire(
                &key("other"),
                WorkClass::Background,
                &cancellation,
                TEST_TIMEOUT,
            )
            .await
            .unwrap();
        let queued_background = tokio::spawn({
            let scheduler = Arc::clone(&scheduler);
            async move {
                let cancellation = WorkCancellation::new();
                scheduler
                    .acquire(
                        &key("target"),
                        WorkClass::Background,
                        &cancellation,
                        TEST_TIMEOUT,
                    )
                    .await
            }
        });
        tokio::task::yield_now().await;
        assert!(!queued_background.is_finished());

        let foreground = scheduler
            .acquire(
                &key("target"),
                WorkClass::Foreground,
                &cancellation,
                Duration::from_millis(50),
            )
            .await;
        assert!(
            foreground.is_ok(),
            "foreground must bypass queued background work"
        );

        queued_background.abort();
        drop(background);
    }

    #[tokio::test]
    async fn cancelling_queued_work_removes_it_from_the_fifo_queue() {
        let scheduler = Arc::new(scheduler_with(5, 2, 1));
        let pool_key = key("cancel-queued");
        let blocker_cancellation = WorkCancellation::new();
        let blocker = scheduler
            .acquire(
                &pool_key,
                WorkClass::Background,
                &blocker_cancellation,
                TEST_TIMEOUT,
            )
            .await
            .unwrap();
        let cancelled = WorkCancellation::new();
        let queued = tokio::spawn({
            let scheduler = Arc::clone(&scheduler);
            let pool_key = pool_key.clone();
            let cancelled = cancelled.clone();
            async move {
                scheduler
                    .acquire(&pool_key, WorkClass::Background, &cancelled, TEST_TIMEOUT)
                    .await
            }
        });
        tokio::task::yield_now().await;
        cancelled.cancel();

        assert!(matches!(
            queued.await.unwrap(),
            Err(WorkScheduleError::Cancelled)
        ));
        drop(blocker);
        assert!(scheduler
            .acquire(
                &pool_key,
                WorkClass::Background,
                &WorkCancellation::new(),
                TEST_TIMEOUT,
            )
            .await
            .is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn queued_work_times_out_without_waiting_for_wall_clock_time() {
        let scheduler = Arc::new(scheduler_with(5, 2, 1));
        let pool_key = key("timeout-queued");
        let blocker = scheduler
            .acquire(
                &pool_key,
                WorkClass::Background,
                &WorkCancellation::new(),
                TEST_TIMEOUT,
            )
            .await
            .unwrap();
        let queued = tokio::spawn({
            let scheduler = Arc::clone(&scheduler);
            let pool_key = pool_key.clone();
            async move {
                scheduler
                    .acquire(
                        &pool_key,
                        WorkClass::Background,
                        &WorkCancellation::new(),
                        Duration::from_secs(10),
                    )
                    .await
            }
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(10)).await;

        assert!(matches!(
            queued.await.unwrap(),
            Err(WorkScheduleError::TimedOut)
        ));
        drop(blocker);
    }

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn cancelling_running_work_drops_its_future_and_releases_permits() {
        let scheduler = Arc::new(scheduler_with(1, 0, 1));
        let pool_key = key("cancel-running");
        let cancellation = WorkCancellation::new();
        let dropped = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = oneshot::channel();
        let running = tokio::spawn({
            let scheduler = Arc::clone(&scheduler);
            let pool_key = pool_key.clone();
            let cancellation = cancellation.clone();
            let dropped = Arc::clone(&dropped);
            async move {
                scheduler
                    .run(
                        &pool_key,
                        WorkClass::Background,
                        &cancellation,
                        TEST_TIMEOUT,
                        async move {
                            let _drop_flag = DropFlag(dropped);
                            started_tx.send(()).expect("signal work start");
                            pending::<Result<(), ()>>().await
                        },
                    )
                    .await
            }
        });
        started_rx.await.unwrap();
        cancellation.cancel();

        assert_eq!(running.await.unwrap(), Err(ScheduledWorkError::Cancelled));
        assert!(dropped.load(Ordering::SeqCst));
        assert!(scheduler
            .acquire(
                &pool_key,
                WorkClass::Background,
                &WorkCancellation::new(),
                TEST_TIMEOUT,
            )
            .await
            .is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn timing_out_running_work_drops_its_future_and_releases_permits() {
        let scheduler = Arc::new(scheduler_with(1, 0, 1));
        let pool_key = key("timeout-running");
        let dropped = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = oneshot::channel();
        let running = tokio::spawn({
            let scheduler = Arc::clone(&scheduler);
            let pool_key = pool_key.clone();
            let dropped = Arc::clone(&dropped);
            async move {
                scheduler
                    .run(
                        &pool_key,
                        WorkClass::Background,
                        &WorkCancellation::new(),
                        Duration::from_secs(10),
                        async move {
                            let _drop_flag = DropFlag(dropped);
                            started_tx.send(()).expect("signal work start");
                            pending::<Result<(), ()>>().await
                        },
                    )
                    .await
            }
        });
        started_rx.await.unwrap();
        tokio::time::advance(Duration::from_secs(10)).await;

        assert_eq!(running.await.unwrap(), Err(ScheduledWorkError::TimedOut));
        assert!(dropped.load(Ordering::SeqCst));
        assert!(scheduler
            .acquire(
                &pool_key,
                WorkClass::Background,
                &WorkCancellation::new(),
                TEST_TIMEOUT,
            )
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn work_error_and_panic_both_release_all_permits() {
        let scheduler = Arc::new(scheduler_with(1, 0, 1));
        let pool_key = key("release");
        let failed = scheduler
            .run(
                &pool_key,
                WorkClass::Background,
                &WorkCancellation::new(),
                TEST_TIMEOUT,
                async { Err::<(), _>("failed") },
            )
            .await;
        assert_eq!(failed, Err(ScheduledWorkError::Work("failed")));

        let panicked = tokio::spawn({
            let scheduler = Arc::clone(&scheduler);
            let pool_key = pool_key.clone();
            async move {
                scheduler
                    .run(
                        &pool_key,
                        WorkClass::Background,
                        &WorkCancellation::new(),
                        TEST_TIMEOUT,
                        async {
                            panic!("injected work panic");
                            #[allow(unreachable_code)]
                            Ok::<(), ()>(())
                        },
                    )
                    .await
            }
        })
        .await
        .expect_err("work task must panic");
        assert!(panicked.is_panic());

        assert!(scheduler
            .acquire(
                &pool_key,
                WorkClass::Background,
                &WorkCancellation::new(),
                TEST_TIMEOUT,
            )
            .await
            .is_ok());
    }
}
