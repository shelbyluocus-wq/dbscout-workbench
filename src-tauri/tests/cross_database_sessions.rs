use std::str::FromStr;

use dbscout_workbench_lib::runtime_resources::{PoolKey, RuntimeResources};
use dbscout_workbench_lib::{
    integration_api::{read_db_page_in_database, read_schema},
    types::TablePageRequest,
};
use sqlx::{mysql::MySqlConnectOptions, mysql::MySqlPoolOptions, Row};
use uuid::Uuid;

fn fixture_url() -> String {
    std::env::var("DBSCOUT_TEST_MYSQL_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .expect("DBSCOUT_TEST_MYSQL_URL must point to the isolated MySQL fixture")
}

fn database_name(label: &str) -> String {
    format!("dbscout_perf_{label}_{}", Uuid::new_v4().simple())
}

async fn execute(pool: &sqlx::MySqlPool, sql: &str) -> Result<(), String> {
    sqlx::query(sql)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|error| format!("{sql}: {error}"))
}

async fn drop_database(pool: &sqlx::MySqlPool, database: &str) -> Result<(), String> {
    execute(pool, &format!("DROP DATABASE IF EXISTS `{database}`")).await
}

#[test]
#[ignore = "requires scripts/perf/mysql-fixture.ps1"]
fn cross_database_session_uses_requested_database() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build Tokio runtime")
        .block_on(async {
            let url = fixture_url();
            let database_a = database_name("a");
            let database_b = database_name("b");
            let options = MySqlConnectOptions::from_str(&url).expect("parse fixture URL");
            let server_pool = MySqlPoolOptions::new()
                .max_connections(2)
                .connect_with(options)
                .await
                .expect("connect isolated MySQL fixture");

            let scenario = async {
                execute(&server_pool, &format!("CREATE DATABASE `{database_a}`")).await?;
                execute(&server_pool, &format!("CREATE DATABASE `{database_b}`")).await?;
                for (database, sentinel) in [(&database_a, "sentinel-a"), (&database_b, "sentinel-b")] {
                    execute(
                        &server_pool,
                        &format!(
                            "CREATE TABLE `{database}`.`shared_table` (id INT PRIMARY KEY, sentinel VARCHAR(64) NOT NULL)"
                        ),
                    )
                    .await?;
                    execute(
                        &server_pool,
                        &format!(
                            "INSERT INTO `{database}`.`shared_table` (id, sentinel) VALUES (1, '{sentinel}')"
                        ),
                    )
                    .await?;
                }

                let resources = RuntimeResources::default();
                let url_for_b = url.clone();
                let database_for_b = database_b.clone();
                let pool_b = resources
                    .get_or_connect_database(PoolKey::new("mysql-1", &database_b), move || async move {
                        let mut options = MySqlConnectOptions::from_str(&url_for_b)
                            .map_err(|error| error.to_string())?;
                        options = options.database(&database_for_b);
                        MySqlPoolOptions::new()
                            .max_connections(2)
                            .connect_with(options)
                            .await
                            .map_err(|error| error.to_string())
                    })
                    .await?;
                let b_sentinel: String = sqlx::query("SELECT sentinel FROM `shared_table` WHERE id = 1")
                    .fetch_one(&pool_b)
                    .await
                    .map_err(|error| error.to_string())?
                    .try_get("sentinel")
                    .map_err(|error| error.to_string())?;

                let table_a = read_schema(&pool_b, &database_a, "shared_table").await?;
                let page_a = read_db_page_in_database(
                    &pool_b,
                    &database_a,
                    &table_a,
                    "cross-database-page",
                    &TablePageRequest {
                        page: Some(1),
                        page_size: Some(10),
                        include_total: Some(true),
                        filter: None,
                        sort: None,
                    },
                )
                .await?;
                let qualified_page_sentinel = page_a
                    .rows
                    .first()
                    .and_then(|row| row.get("sentinel"))
                    .cloned()
                    .ok_or_else(|| "qualified page did not return the A sentinel".to_string())?;

                let url_for_a = url.clone();
                let database_for_a = database_a.clone();
                let pool_a = resources
                    .get_or_connect_database(PoolKey::new("mysql-1", &database_a), move || async move {
                        let mut options = MySqlConnectOptions::from_str(&url_for_a)
                            .map_err(|error| error.to_string())?;
                        options = options.database(&database_for_a);
                        MySqlPoolOptions::new()
                            .max_connections(2)
                            .connect_with(options)
                            .await
                            .map_err(|error| error.to_string())
                    })
                    .await?;
                let row = sqlx::query(
                    "SELECT DATABASE() AS active_database, sentinel FROM `shared_table` WHERE id = 1",
                )
                .fetch_one(&pool_a)
                .await
                .map_err(|error| error.to_string())?;

                let simultaneous_a_pool = pool_a.clone();
                let simultaneous_a = tokio::spawn(async move {
                    sqlx::query("SELECT DATABASE() AS active_database")
                        .fetch_one(&simultaneous_a_pool)
                        .await
                        .map_err(|error| error.to_string())?
                        .try_get::<String, _>("active_database")
                        .map_err(|error| error.to_string())
                });
                let simultaneous_b_pool = pool_b.clone();
                let simultaneous_b = tokio::spawn(async move {
                    sqlx::query("SELECT DATABASE() AS active_database")
                        .fetch_one(&simultaneous_b_pool)
                        .await
                        .map_err(|error| error.to_string())?
                        .try_get::<String, _>("active_database")
                        .map_err(|error| error.to_string())
                });
                let simultaneous_databases = (
                    simultaneous_a.await.map_err(|error| error.to_string())??,
                    simultaneous_b.await.map_err(|error| error.to_string())??,
                );

                sqlx::query("UPDATE `shared_table` SET sentinel = 'session-a' WHERE id = 1")
                    .execute(&pool_a)
                    .await
                    .map_err(|error| error.to_string())?;
                let b_after_a_update: String =
                    sqlx::query("SELECT sentinel FROM `shared_table` WHERE id = 1")
                        .fetch_one(&pool_b)
                        .await
                        .map_err(|error| error.to_string())?
                        .try_get("sentinel")
                        .map_err(|error| error.to_string())?;

                sqlx::query("INSERT INTO `shared_table` (id, sentinel) VALUES (2, 'insert-a')")
                    .execute(&pool_a)
                    .await
                    .map_err(|error| error.to_string())?;
                let b_insert_count: i64 =
                    sqlx::query("SELECT COUNT(*) AS count FROM `shared_table` WHERE id = 2")
                        .fetch_one(&pool_b)
                        .await
                        .map_err(|error| error.to_string())?
                        .try_get("count")
                        .map_err(|error| error.to_string())?;
                sqlx::query("DELETE FROM `shared_table` WHERE id = 2")
                    .execute(&pool_a)
                    .await
                    .map_err(|error| error.to_string())?;

                // Agent SQL is intentionally user-authored and may be unqualified. Its
                // database-bound pool must still keep both reads and writes inside A.
                sqlx::query("UPDATE `shared_table` SET sentinel = 'agent-a' WHERE id = 1")
                    .execute(&pool_a)
                    .await
                    .map_err(|error| error.to_string())?;
                let agent_read: String =
                    sqlx::query("SELECT sentinel FROM `shared_table` WHERE id = 1")
                        .fetch_one(&pool_a)
                        .await
                        .map_err(|error| error.to_string())?
                        .try_get("sentinel")
                        .map_err(|error| error.to_string())?;

                // Historical audit rows can contain legacy unqualified inverse SQL.
                // Resolving rollback through A's database pool must make that safe.
                sqlx::query("UPDATE `shared_table` SET sentinel = 'session-a' WHERE id = 1")
                    .execute(&pool_a)
                    .await
                    .map_err(|error| error.to_string())?;
                let row_exists_in_a: i64 = sqlx::query(
                    "SELECT COUNT(*) AS count FROM `shared_table` WHERE id = 1 AND sentinel = 'session-a'",
                )
                .fetch_one(&pool_a)
                .await
                .map_err(|error| error.to_string())?
                .try_get("count")
                .map_err(|error| error.to_string())?;
                let b_after_agent_and_rollback: String =
                    sqlx::query("SELECT sentinel FROM `shared_table` WHERE id = 1")
                        .fetch_one(&pool_b)
                        .await
                        .map_err(|error| error.to_string())?
                        .try_get("sentinel")
                        .map_err(|error| error.to_string())?;

                Ok::<_, String>((
                    b_sentinel,
                    qualified_page_sentinel,
                    row.try_get::<String, _>("active_database")
                        .map_err(|error| error.to_string())?,
                    row.try_get::<String, _>("sentinel")
                        .map_err(|error| error.to_string())?,
                    simultaneous_databases,
                    b_after_a_update,
                    b_insert_count,
                    agent_read,
                    row_exists_in_a,
                    b_after_agent_and_rollback,
                ))
            }
            .await;

            let cleanup_a = drop_database(&server_pool, &database_a).await;
            let cleanup_b = drop_database(&server_pool, &database_b).await;
            server_pool.close().await;
            cleanup_a.expect("drop fixture database A");
            cleanup_b.expect("drop fixture database B");

            let (
                b_sentinel,
                qualified_page_sentinel,
                active_database,
                a_sentinel,
                simultaneous_databases,
                b_after_a_update,
                b_insert_count,
                agent_read,
                row_exists_in_a,
                b_after_agent_and_rollback,
            ) = scenario.expect("run cross-database scenario");
            assert_eq!(b_sentinel, "sentinel-b");
            assert_eq!(qualified_page_sentinel, "sentinel-a");
            assert_eq!(active_database, database_a);
            assert_eq!(a_sentinel, "sentinel-a");
            assert_eq!(simultaneous_databases, (database_a.clone(), database_b));
            assert_eq!(b_after_a_update, "sentinel-b");
            assert_eq!(b_insert_count, 0);
            assert_eq!(agent_read, "agent-a");
            assert_eq!(row_exists_in_a, 1);
            assert_eq!(b_after_agent_and_rollback, "sentinel-b");
        });
}
