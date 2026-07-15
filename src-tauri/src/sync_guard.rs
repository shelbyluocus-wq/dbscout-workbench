use std::future::Future;
use std::time::{Duration, Instant};

use crate::work_scheduler::WorkCancellation;

#[derive(Debug, PartialEq, Eq)]
pub enum GuardError<E> {
    Failed(E),
    Cancelled,
    TimedOut { elapsed: Duration },
}

pub async fn run_with_heartbeat<T, E, Fut, Heartbeat>(
    operation: Fut,
    heartbeat_interval: Duration,
    timeout: Duration,
    cancellation: &WorkCancellation,
    mut heartbeat: Heartbeat,
) -> Result<T, GuardError<E>>
where
    Fut: Future<Output = Result<T, E>>,
    Heartbeat: FnMut(Duration),
{
    let started = Instant::now();
    let heartbeat_interval = heartbeat_interval.max(Duration::from_millis(1));
    let timeout = timeout.max(heartbeat_interval);
    let mut ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + heartbeat_interval,
        heartbeat_interval,
    );
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    tokio::pin!(operation);

    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(GuardError::Cancelled),
            result = &mut operation => return result.map_err(GuardError::Failed),
            _ = ticker.tick() => heartbeat(started.elapsed()),
            _ = &mut deadline => return Err(GuardError::TimedOut { elapsed: started.elapsed() }),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::pending;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use crate::work_scheduler::WorkCancellation;

    use super::{run_with_heartbeat, GuardError};

    #[tokio::test(start_paused = true)]
    async fn long_operation_emits_heartbeats_before_finishing() {
        let beats = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&beats);
        let cancellation = WorkCancellation::new();

        let task = tokio::spawn(async move {
            run_with_heartbeat(
                async {
                    tokio::time::sleep(Duration::from_millis(55)).await;
                    Ok::<_, String>(42)
                },
                Duration::from_millis(10),
                Duration::from_millis(200),
                &cancellation,
                move |elapsed| captured.lock().unwrap().push(elapsed),
            )
            .await
        });
        for _ in 0..6 {
            tokio::time::advance(Duration::from_millis(10)).await;
            tokio::task::yield_now().await;
        }
        let value = task.await.unwrap().expect("operation succeeds");

        assert_eq!(value, 42);
        assert!(beats.lock().unwrap().len() >= 3);
    }

    #[tokio::test]
    async fn stalled_operation_returns_a_deterministic_timeout() {
        let cancellation = WorkCancellation::new();
        let error = run_with_heartbeat(
            pending::<Result<(), String>>(),
            Duration::from_millis(10),
            Duration::from_millis(35),
            &cancellation,
            |_| {},
        )
        .await
        .expect_err("stalled operation times out");

        assert!(matches!(error, GuardError::TimedOut { .. }));
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_operation_immediately() {
        let cancellation = WorkCancellation::new();
        let worker_cancellation = cancellation.clone();
        let task = tokio::spawn(async move {
            run_with_heartbeat(
                pending::<Result<(), String>>(),
                Duration::from_secs(10),
                Duration::from_secs(60),
                &worker_cancellation,
                |_| {},
            )
            .await
        });

        tokio::task::yield_now().await;
        cancellation.cancel();
        let result = tokio::time::timeout(Duration::from_millis(100), task)
            .await
            .expect("cancellation must wake the stalled operation")
            .unwrap();

        assert!(matches!(result, Err(GuardError::Cancelled)));
    }
}
