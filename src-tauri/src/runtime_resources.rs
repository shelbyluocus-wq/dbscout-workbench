use std::{collections::HashMap, future::Future, hash::Hash, sync::Arc};

use sqlx::MySqlPool;
use tokio::sync::{Mutex, OnceCell};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PoolKey {
    connection_id: String,
    database: String,
}

impl PoolKey {
    pub fn new(connection_id: impl Into<String>, database: impl AsRef<str>) -> Self {
        Self {
            connection_id: connection_id.into(),
            database: database.as_ref().trim().to_string(),
        }
    }

    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub fn database(&self) -> &str {
        &self.database
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ServerPoolKey(String);

impl ServerPoolKey {
    pub fn new(connection_id: impl Into<String>) -> Self {
        Self(connection_id.into())
    }

    pub fn connection_id(&self) -> &str {
        &self.0
    }
}

struct SingleFlightPoolRegistry<K> {
    entries: Mutex<HashMap<K, Arc<OnceCell<MySqlPool>>>>,
}

impl<K> Default for SingleFlightPoolRegistry<K> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl<K> SingleFlightPoolRegistry<K>
where
    K: Clone + Eq + Hash,
{
    async fn get_or_connect<F, Fut>(&self, key: K, connect: F) -> Result<MySqlPool, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<MySqlPool, String>>,
    {
        let cell = {
            let mut entries = self.entries.lock().await;
            entries
                .entry(key)
                .or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };
        cell.get_or_try_init(connect).await.cloned()
    }

    async fn contains(&self, key: &K) -> bool {
        let cell = self.entries.lock().await.get(key).cloned();
        cell.is_some_and(|value| value.get().is_some())
    }

    async fn get(&self, key: &K) -> Option<MySqlPool> {
        let cell = self.entries.lock().await.get(key).cloned()?;
        cell.get().cloned()
    }
}

#[derive(Default)]
pub struct RuntimeResources {
    server_pools: SingleFlightPoolRegistry<ServerPoolKey>,
    database_pools: SingleFlightPoolRegistry<PoolKey>,
}

impl RuntimeResources {
    pub async fn get_or_connect_server<F, Fut>(
        &self,
        key: ServerPoolKey,
        connect: F,
    ) -> Result<MySqlPool, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<MySqlPool, String>>,
    {
        self.server_pools.get_or_connect(key, connect).await
    }

    pub async fn get_or_connect_database<F, Fut>(
        &self,
        key: PoolKey,
        connect: F,
    ) -> Result<MySqlPool, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<MySqlPool, String>>,
    {
        self.database_pools.get_or_connect(key, connect).await
    }

    pub async fn contains_server(&self, key: &ServerPoolKey) -> bool {
        self.server_pools.contains(key).await
    }

    pub async fn contains_database(&self, key: &PoolKey) -> bool {
        self.database_pools.contains(key).await
    }

    pub async fn server_pool(&self, key: &ServerPoolKey) -> Option<MySqlPool> {
        self.server_pools.get(key).await
    }

    pub async fn database_pool(&self, key: &PoolKey) -> Option<MySqlPool> {
        self.database_pools.get(key).await
    }

    pub async fn has_connection_pool(&self, connection_id: &str) -> bool {
        if self
            .contains_server(&ServerPoolKey::new(connection_id))
            .await
        {
            return true;
        }
        self.database_pools
            .entries
            .lock()
            .await
            .iter()
            .any(|(key, cell)| key.connection_id() == connection_id && cell.get().is_some())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        str::FromStr,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };

    use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};

    use super::{PoolKey, RuntimeResources};

    fn lazy_pool(database: &str) -> sqlx::MySqlPool {
        let mut options =
            MySqlConnectOptions::from_str("mysql://root@127.0.0.1:9").expect("parse lazy test URL");
        options = options.database(database);
        MySqlPoolOptions::new().connect_lazy_with(options)
    }

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test runtime")
    }

    #[test]
    fn pool_key_distinguishes_databases_on_one_connection() {
        assert_ne!(
            PoolKey::new("mysql-1", "game_a"),
            PoolKey::new("mysql-1", "game_b"),
        );
    }

    #[test]
    fn pool_key_normalizes_only_outer_database_whitespace() {
        assert_eq!(
            PoolKey::new("mysql-1", " game_a "),
            PoolKey::new("mysql-1", "game_a"),
        );
        assert_ne!(
            PoolKey::new("mysql-1", "game_a"),
            PoolKey::new("MYSQL-1", "game_a"),
        );
    }

    #[test]
    fn database_pool_creation_is_single_flight() {
        test_runtime().block_on(async {
            let resources = Arc::new(RuntimeResources::default());
            let calls = Arc::new(AtomicUsize::new(0));
            let key = PoolKey::new("mysql-1", "game_a");

            let first_resources = resources.clone();
            let first_calls = calls.clone();
            let first_key = key.clone();
            let first = tokio::spawn(async move {
                first_resources
                    .get_or_connect_database(first_key, move || async move {
                        first_calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Ok(lazy_pool("game_a"))
                    })
                    .await
            });

            let second_resources = resources.clone();
            let second_calls = calls.clone();
            let second = tokio::spawn(async move {
                second_resources
                    .get_or_connect_database(key, move || async move {
                        second_calls.fetch_add(1, Ordering::SeqCst);
                        Ok(lazy_pool("wrong_database"))
                    })
                    .await
            });

            first.await.expect("first task").expect("first pool");
            second.await.expect("second task").expect("second pool");
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn database_pool_registry_never_returns_database_b_for_database_a() {
        test_runtime().block_on(async {
            let resources = RuntimeResources::default();
            let b_calls = AtomicUsize::new(0);
            let a_calls = AtomicUsize::new(0);

            resources
                .get_or_connect_database(PoolKey::new("mysql-1", "game_b"), || async {
                    b_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(lazy_pool("game_b"))
                })
                .await
                .expect("database B pool");
            resources
                .get_or_connect_database(PoolKey::new("mysql-1", "game_a"), || async {
                    a_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(lazy_pool("game_a"))
                })
                .await
                .expect("database A pool");

            assert_eq!(b_calls.load(Ordering::SeqCst), 1);
            assert_eq!(a_calls.load(Ordering::SeqCst), 1);
        });
    }
}
