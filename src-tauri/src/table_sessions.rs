use std::{
    collections::HashMap,
    ops::Deref,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use crate::{schema_cache::SchemaSnapshot, types::TableSession};

pub const MAX_TABLE_SESSIONS: usize = 128;
pub const TABLE_SESSION_IDLE_TTL: Duration = Duration::from_secs(30 * 60);

struct ManagedTableSession {
    session: TableSession,
    schema: Option<SchemaSnapshot>,
    created_at: Instant,
    last_accessed: Instant,
    active_leases: Arc<AtomicUsize>,
}

pub struct TableSessionLease {
    session: TableSession,
    schema: Option<SchemaSnapshot>,
    active_leases: Arc<AtomicUsize>,
}

impl TableSessionLease {
    pub fn session(&self) -> &TableSession {
        &self.session
    }

    pub fn schema_snapshot(&self) -> &SchemaSnapshot {
        self.schema
            .as_ref()
            .expect("production table sessions must retain a schema snapshot")
    }
}

impl Deref for TableSessionLease {
    type Target = TableSession;

    fn deref(&self) -> &Self::Target {
        &self.session
    }
}

impl Drop for TableSessionLease {
    fn drop(&mut self) {
        let previous = self.active_leases.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "table-session lease count underflow");
    }
}

pub struct TableSessionStore {
    entries: HashMap<String, ManagedTableSession>,
    next_session_id: u64,
    capacity: usize,
    idle_ttl: Duration,
}

impl Default for TableSessionStore {
    fn default() -> Self {
        Self::new(MAX_TABLE_SESSIONS, TABLE_SESSION_IDLE_TTL)
    }
}

impl TableSessionStore {
    pub fn new(capacity: usize, idle_ttl: Duration) -> Self {
        Self {
            entries: HashMap::new(),
            next_session_id: 0,
            capacity: capacity.max(1),
            idle_ttl,
        }
    }

    pub fn open(&mut self, session: TableSession) -> Result<String, String> {
        self.open_at(session, Instant::now())
    }

    pub fn open_leased(
        &mut self,
        session: TableSession,
    ) -> Result<(String, TableSessionLease), String> {
        self.open_leased_at(session, None, Instant::now())
    }

    pub fn open_leased_with_schema(
        &mut self,
        session: TableSession,
        schema: SchemaSnapshot,
    ) -> Result<(String, TableSessionLease), String> {
        self.open_leased_at(session, Some(schema), Instant::now())
    }

    pub fn open_at(&mut self, session: TableSession, now: Instant) -> Result<String, String> {
        let (session_id, lease) = self.open_leased_at(session, None, now)?;
        drop(lease);
        Ok(session_id)
    }

    fn open_leased_at(
        &mut self,
        session: TableSession,
        schema: Option<SchemaSnapshot>,
        now: Instant,
    ) -> Result<(String, TableSessionLease), String> {
        self.prune_expired_at(now);
        while self.entries.len() >= self.capacity {
            let eviction_id = self
                .entries
                .iter()
                .filter(|(_, entry)| entry.active_leases.load(Ordering::Acquire) == 0)
                .min_by_key(|(_, entry)| (entry.last_accessed, entry.created_at))
                .map(|(session_id, _)| session_id.clone());
            let Some(eviction_id) = eviction_id else {
                return Err(format!(
                    "表会话已达到上限（{}），请等待当前操作完成或关闭不用的标签页",
                    self.capacity
                ));
            };
            self.entries.remove(&eviction_id);
        }

        self.next_session_id = self
            .next_session_id
            .checked_add(1)
            .ok_or_else(|| "表会话编号已耗尽，请重启应用".to_string())?;
        let session_id = format!("table-session-{}", self.next_session_id);
        let active_leases = Arc::new(AtomicUsize::new(1));
        self.entries.insert(
            session_id.clone(),
            ManagedTableSession {
                session: session.clone(),
                schema: schema.clone(),
                created_at: now,
                last_accessed: now,
                active_leases: active_leases.clone(),
            },
        );
        Ok((
            session_id,
            TableSessionLease {
                session,
                schema,
                active_leases,
            },
        ))
    }

    pub fn acquire(&mut self, session_id: &str) -> Option<TableSessionLease> {
        self.acquire_at(session_id, Instant::now())
    }

    pub fn acquire_at(&mut self, session_id: &str, now: Instant) -> Option<TableSessionLease> {
        self.prune_expired_at(now);
        let entry = self.entries.get_mut(session_id)?;
        entry.last_accessed = now.max(entry.last_accessed);
        entry.active_leases.fetch_add(1, Ordering::AcqRel);
        Some(TableSessionLease {
            session: entry.session.clone(),
            schema: entry.schema.clone(),
            active_leases: entry.active_leases.clone(),
        })
    }

    pub fn update_schema(&mut self, session_id: &str, schema: SchemaSnapshot) -> bool {
        let Some(entry) = self.entries.get_mut(session_id) else {
            return false;
        };
        entry.schema = Some(schema);
        true
    }

    pub fn close(&mut self, session_id: &str) -> bool {
        self.entries.remove(session_id).is_some()
    }

    pub fn invalidate_connection(&mut self, connection_id: &str) -> usize {
        let before = self.entries.len();
        self.entries
            .retain(|_, entry| entry.session.connection_id != connection_id);
        before.saturating_sub(self.entries.len())
    }

    pub fn prune_expired(&mut self) -> Vec<(String, String)> {
        self.prune_expired_at(Instant::now())
    }

    /// Drops idle-expired sessions and returns the pruned
    /// `(session_id, connection_id)` pairs so callers can notify the frontend.
    pub fn prune_expired_at(&mut self, now: Instant) -> Vec<(String, String)> {
        let idle_ttl = self.idle_ttl;
        let mut pruned = Vec::new();
        self.entries.retain(|session_id, entry| {
            let keep = entry.active_leases.load(Ordering::Acquire) > 0
                || now.saturating_duration_since(entry.last_accessed) < idle_ttl;
            if !keep {
                pruned.push((session_id.clone(), entry.session.connection_id.clone()));
            }
            keep
        });
        pruned
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.next_session_id = 0;
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    use crate::runtime_resources::PoolKey;
    use crate::schema_cache::{SchemaCache, SchemaCacheKey};
    use crate::types::{ColumnMeta, DatabaseKind, TableMeta, TableSession};

    use super::TableSessionStore;

    fn session(connection_id: &str, database: &str, table_name: &str) -> TableSession {
        TableSession {
            connection_id: connection_id.into(),
            kind: DatabaseKind::MySql,
            database: database.into(),
            table_name: table_name.into(),
            clickhouse_url: None,
            mongodb_url: None,
            pool_key: Some(PoolKey::new(connection_id, database)),
        }
    }

    #[test]
    fn explicit_close_is_idempotent() {
        let now = Instant::now();
        let mut store = TableSessionStore::new(4, Duration::from_secs(60));
        let id = store
            .open_at(session("mysql-1", "game", "hero"), now)
            .unwrap();

        assert!(store.close(&id));
        assert!(!store.close(&id));
        assert!(store.acquire_at(&id, now).is_none());
    }

    #[test]
    fn connection_invalidation_removes_only_owned_sessions() {
        let now = Instant::now();
        let mut store = TableSessionStore::new(8, Duration::from_secs(60));
        let first = store
            .open_at(session("mysql-1", "game", "hero"), now)
            .unwrap();
        let second = store
            .open_at(session("mysql-1", "config", "item"), now)
            .unwrap();
        let other = store
            .open_at(session("mysql-2", "game", "hero"), now)
            .unwrap();

        assert_eq!(store.invalidate_connection("mysql-1"), 2);
        assert!(store.acquire_at(&first, now).is_none());
        assert!(store.acquire_at(&second, now).is_none());
        assert!(store.acquire_at(&other, now).is_some());
    }

    #[test]
    fn idle_expiration_uses_last_access_and_never_prunes_an_active_lease() {
        let base = Instant::now();
        let mut store = TableSessionStore::new(4, Duration::from_secs(10));
        let id = store
            .open_at(session("mysql-1", "game", "hero"), base)
            .unwrap();
        let lease = store
            .acquire_at(&id, base + Duration::from_secs(5))
            .expect("session lease");

        assert!(store
            .prune_expired_at(base + Duration::from_secs(30))
            .is_empty());
        drop(lease);
        let pruned = store.prune_expired_at(base + Duration::from_secs(30));
        assert_eq!(pruned, vec![(id.clone(), "mysql-1".to_string())]);
        assert!(store
            .acquire_at(&id, base + Duration::from_secs(30))
            .is_none());
    }

    #[test]
    fn capacity_evicts_lru_idle_session_but_refuses_to_evict_active_sessions() {
        let base = Instant::now();
        let mut store = TableSessionStore::new(2, Duration::from_secs(60));
        let active = store
            .open_at(session("mysql-1", "game", "active"), base)
            .unwrap();
        let idle = store
            .open_at(
                session("mysql-1", "game", "idle"),
                base + Duration::from_secs(1),
            )
            .unwrap();
        let lease = store
            .acquire_at(&active, base + Duration::from_secs(2))
            .expect("active lease");

        let replacement = store
            .open_at(
                session("mysql-1", "game", "replacement"),
                base + Duration::from_secs(3),
            )
            .unwrap();
        assert!(store.acquire_at(&active, base).is_some());
        assert!(store.acquire_at(&idle, base).is_none());
        assert!(store.acquire_at(&replacement, base).is_some());

        let replacement_lease = store
            .acquire_at(&replacement, base + Duration::from_secs(4))
            .expect("replacement lease");
        assert!(store
            .open_at(
                session("mysql-1", "game", "blocked"),
                base + Duration::from_secs(5),
            )
            .is_err());
        drop(replacement_lease);
        drop(lease);
    }

    #[tokio::test]
    async fn live_session_retains_and_refreshes_one_shared_schema_snapshot() {
        let cache = SchemaCache::default();
        let cache_key = SchemaCacheKey::new("mysql-1", "game", "hero");
        let first = cache
            .get_or_load(&cache_key, false, |_| async {
                Ok(vec![TableMeta {
                    table_name: "hero".into(),
                    table_comment: "first".into(),
                    columns: vec![ColumnMeta::with_basic("id", "bigint", "", true, false)],
                }])
            })
            .await
            .unwrap();
        let mut store = TableSessionStore::new(4, Duration::from_secs(60));
        let (id, lease) = store
            .open_leased_with_schema(session("mysql-1", "game", "hero"), first.clone())
            .unwrap();

        assert!(Arc::ptr_eq(
            lease.schema_snapshot().schema(),
            first.schema()
        ));
        drop(lease);

        let refreshed = cache
            .get_or_load(&cache_key, true, |_| async {
                Ok(vec![TableMeta {
                    table_name: "hero".into(),
                    table_comment: "refreshed".into(),
                    columns: vec![ColumnMeta::with_basic("id", "bigint", "", true, false)],
                }])
            })
            .await
            .unwrap();
        assert!(store.update_schema(&id, refreshed.clone()));
        let lease = store.acquire(&id).unwrap();

        assert!(Arc::ptr_eq(
            lease.schema_snapshot().schema(),
            refreshed.schema()
        ));
        assert_eq!(lease.schema_snapshot().schema().table_comment, "refreshed");
    }
}
