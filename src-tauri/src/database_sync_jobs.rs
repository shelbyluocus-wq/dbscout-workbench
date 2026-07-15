use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use crate::work_scheduler::WorkCancellation;

const COMPLETED_JOB_HISTORY_LIMIT: usize = 256;

#[derive(Default)]
pub struct DatabaseSyncJobs {
    state: Arc<Mutex<DatabaseSyncJobState>>,
}

#[derive(Default)]
struct DatabaseSyncJobState {
    active: HashMap<String, Arc<DatabaseSyncJob>>,
    completed: VecDeque<String>,
}

struct DatabaseSyncJob {
    cancellation: WorkCancellation,
    target_key: String,
}

pub struct DatabaseSyncJobGuard {
    job_id: String,
    job: Arc<DatabaseSyncJob>,
    state: Arc<Mutex<DatabaseSyncJobState>>,
}

impl DatabaseSyncJobs {
    pub fn register(
        &self,
        job_id: &str,
        connection_id: &str,
        target_database: &str,
    ) -> Result<DatabaseSyncJobGuard, String> {
        let job_id = job_id.trim();
        if job_id.is_empty() {
            return Err("覆盖同步任务 ID 不能为空".into());
        }

        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.active.contains_key(job_id) {
            return Err("该覆盖同步任务正在执行，请勿重复启动".into());
        }
        if state.completed.iter().any(|completed| completed == job_id) {
            return Err("该覆盖同步任务已执行过，请生成新任务后重试".into());
        }
        let target_key = format!(
            "{}\u{1f}{}",
            connection_id.trim().to_lowercase(),
            target_database.trim().to_lowercase()
        );
        if state
            .active
            .values()
            .any(|job| job.target_key == target_key)
        {
            return Err("该目标库已有覆盖同步任务正在执行，请等待完成或先停止当前任务".into());
        }
        let job = Arc::new(DatabaseSyncJob {
            cancellation: WorkCancellation::new(),
            target_key,
        });
        state.active.insert(job_id.to_string(), Arc::clone(&job));
        Ok(DatabaseSyncJobGuard {
            job_id: job_id.to_string(),
            job,
            state: Arc::clone(&self.state),
        })
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        let job = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active
            .get(job_id)
            .cloned();
        if let Some(job) = job {
            job.cancellation.cancel();
            true
        } else {
            false
        }
    }
}

impl DatabaseSyncJobGuard {
    pub fn cancellation(&self) -> WorkCancellation {
        self.job.cancellation.clone()
    }
}

impl Drop for DatabaseSyncJobGuard {
    fn drop(&mut self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state
            .active
            .get(&self.job_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.job))
        {
            state.active.remove(&self.job_id);
            if state.completed.len() >= COMPLETED_JOB_HISTORY_LIMIT {
                state.completed.pop_front();
            }
            state.completed.push_back(self.job_id.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::DatabaseSyncJobs;

    #[test]
    fn duplicate_job_ids_are_never_reused_after_the_first_job_finishes() {
        let jobs = DatabaseSyncJobs::default();
        let first = jobs.register("sync-1", "mysql-1", "target").unwrap();

        assert!(jobs.register("sync-1", "mysql-1", "target").is_err());
        drop(first);
        let error = jobs
            .register("sync-1", "mysql-1", "target")
            .err()
            .expect("completed job ids cannot be reused");
        assert!(error.contains("已执行过"));
        assert!(jobs.register("sync-2", "mysql-1", "target").is_ok());
    }

    #[test]
    fn different_job_ids_cannot_overwrite_the_same_target_concurrently() {
        let jobs = DatabaseSyncJobs::default();
        let _first = jobs.register("sync-1", "mysql-1", "Target_Db").unwrap();

        assert!(jobs.register("sync-2", "MYSQL-1", "target_db").is_err());
        assert!(jobs.register("sync-3", "mysql-1", "other_db").is_ok());
        assert!(jobs.register("sync-4", "mysql-2", "target_db").is_ok());
    }

    #[tokio::test]
    async fn cancelling_a_registered_job_wakes_its_waiter() {
        let jobs = DatabaseSyncJobs::default();
        let job = jobs.register("sync-1", "mysql-1", "target").unwrap();
        let cancellation = job.cancellation();

        assert!(jobs.cancel("sync-1"));
        tokio::time::timeout(Duration::from_millis(100), cancellation.cancelled())
            .await
            .expect("cancel must wake the running sync");
        assert!(cancellation.is_cancelled());
    }

    #[test]
    fn cancelling_an_unknown_or_finished_job_returns_false() {
        let jobs = DatabaseSyncJobs::default();
        assert!(!jobs.cancel("missing"));
        let job = jobs.register("sync-1", "mysql-1", "target").unwrap();
        drop(job);
        assert!(!jobs.cancel("sync-1"));
    }
}
