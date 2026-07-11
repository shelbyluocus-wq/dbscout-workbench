use std::{str::FromStr, sync::Arc, time::Duration};

use dbscout_workbench_lib::{
    integration_api::{read_db_search_scan_page_in_database, read_schema},
    runtime_resources::PoolKey,
    table_search::{TableSearchCursor, TableSearchJobSpec, TableSearchManager},
    work_scheduler::{ScheduledWorkError, WorkClass, WorkScheduler},
};
use sqlx::{mysql::MySqlConnectOptions, mysql::MySqlPoolOptions};
use uuid::Uuid;

const PHYSICAL_PAGE_SIZE: u32 = 128;

fn fixture_url() -> String {
    std::env::var("DBSCOUT_TEST_MYSQL_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .expect("DBSCOUT_TEST_MYSQL_URL must point to the isolated MySQL fixture")
}

async fn execute(pool: &sqlx::MySqlPool, sql: &str) -> Result<(), String> {
    sqlx::query(sql)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|error| format!("{sql}: {error}"))
}

async fn server_pool() -> sqlx::MySqlPool {
    let options = MySqlConnectOptions::from_str(&fixture_url()).expect("parse fixture URL");
    MySqlPoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .expect("connect isolated MySQL fixture")
}

#[test]
#[ignore = "requires scripts/perf/mysql-fixture.ps1"]
fn mysql_table_search_finds_a_typo_match_after_the_first_physical_page() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build Tokio runtime")
        .block_on(async {
            let pool = server_pool().await;
            let database = format!("dbscout_table_search_{}", Uuid::new_v4().simple());
            let scenario = async {
                execute(&pool, &format!("CREATE DATABASE `{database}`")).await?;
                execute(
                    &pool,
                    &format!(
                        "CREATE TABLE `{database}`.`search_rows` (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL)"
                    ),
                )
                .await?;
                let values = (1..=260)
                    .map(|id| {
                        let name = if id == 129 {
                            "database".to_string()
                        } else {
                            format!("ordinary-{id:03}")
                        };
                        format!("({id}, '{name}')")
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                execute(
                    &pool,
                    &format!(
                        "INSERT INTO `{database}`.`search_rows` (id, name) VALUES {values}"
                    ),
                )
                .await?;

                let table = read_schema(&pool, &database, "search_rows").await?;
                let mut cursor = TableSearchCursor::new(
                    "databxse",
                    "fuzzy",
                    vec!["id".into(), "name".into()],
                    vec!["id".into()],
                    100,
                    400,
                );
                let first_rows = read_db_search_scan_page_in_database(
                    &pool,
                    &database,
                    &table,
                    0,
                    PHYSICAL_PAGE_SIZE,
                    None,
                )
                .await?;
                let first = cursor.scan_batch(0, &first_rows, false);
                assert!(first.rows.is_empty());
                assert!(!first.complete);
                assert_eq!(cursor.next_source_index(), PHYSICAL_PAGE_SIZE as u64);

                let second_rows = read_db_search_scan_page_in_database(
                    &pool,
                    &database,
                    &table,
                    cursor.next_source_index(),
                    PHYSICAL_PAGE_SIZE,
                    None,
                )
                .await?;
                let second = cursor.scan_batch(
                    PHYSICAL_PAGE_SIZE as u64,
                    &second_rows,
                    second_rows.len() < PHYSICAL_PAGE_SIZE as usize,
                );
                assert_eq!(second.rows.len(), 1);
                assert_eq!(second.row_keys, ["id=129"]);
                assert_eq!(second.matches.len(), 1);
                assert_eq!(second.matches[0].source_row_index, 128);
                assert_eq!(second.matches[0].column_name, "name");
                assert_eq!(second.matches[0].kind, "similar");
                Ok::<_, String>(())
            }
            .await;

            let cleanup = execute(&pool, &format!("DROP DATABASE IF EXISTS `{database}`")).await;
            pool.close().await;
            cleanup.expect("drop table search fixture database");
            scenario.expect("run deep-page table search scenario");
        });
}

#[test]
#[ignore = "requires scripts/perf/mysql-fixture.ps1"]
fn mysql_table_search_cancellation_stops_running_work_and_releases_the_scheduler() {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("build Tokio runtime")
        .block_on(async {
            let pool = server_pool().await;
            let scheduler = Arc::new(WorkScheduler::default());
            let manager = Arc::new(TableSearchManager::default());
            let job = manager.begin(TableSearchJobSpec {
                session_id: "mysql-cancel-session".into(),
                query: "needle".into(),
                mode: "fuzzy".into(),
                sort: None,
                columns: vec!["value".into()],
                identity_columns: vec!["value".into()],
                result_row_limit: 100,
                result_match_limit: 400,
            });
            let job_id = job.id.clone();
            let cancellation = job.cancellation.clone();
            let worker_scheduler = Arc::clone(&scheduler);
            let worker_pool = pool.clone();
            let worker_key = PoolKey::new("mysql-integration", "cancel");
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let running = tokio::spawn(async move {
                worker_scheduler
                    .run(
                        &worker_key,
                        WorkClass::Background,
                        &cancellation,
                        Duration::from_secs(15),
                        async move {
                            let _ = started_tx.send(());
                            sqlx::query("SELECT SLEEP(10)")
                                .execute(&worker_pool)
                                .await
                                .map(|_| ())
                                .map_err(|error| error.to_string())
                        },
                    )
                    .await
            });
            tokio::time::timeout(Duration::from_secs(2), started_rx)
                .await
                .expect("background query did not start")
                .expect("background query start signal was dropped");

            assert!(manager.cancel(&job_id));
            assert!(job.cancellation.is_cancelled());
            assert!(manager.get(&job_id).is_none());
            let cancelled = tokio::time::timeout(Duration::from_secs(2), running)
                .await
                .expect("cancelled MySQL work did not stop promptly")
                .expect("cancelled worker panicked");
            assert!(matches!(cancelled, Err(ScheduledWorkError::Cancelled)));

            let follow_up = scheduler
                .run(
                    &PoolKey::new("mysql-integration", "cancel"),
                    WorkClass::Background,
                    &Default::default(),
                    Duration::from_secs(2),
                    async {
                        sqlx::query("SELECT 1")
                            .execute(&pool)
                            .await
                            .map(|_| ())
                            .map_err(|error| error.to_string())
                    },
                )
                .await;
            assert!(
                follow_up.is_ok(),
                "scheduler permit was not released: {follow_up:?}"
            );
            pool.close().await;
        });
}
