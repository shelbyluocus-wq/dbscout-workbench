use std::str::FromStr;

use dbscout_workbench_lib::{
    integration_api::{
        connect_table_count_database, read_db_page_in_database, read_db_table_count_in_database,
        read_schema,
    },
    types::{TablePageFilter, TablePageRequest},
};
use sqlx::{mysql::MySqlConnectOptions, mysql::MySqlPoolOptions};
use uuid::Uuid;

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

#[test]
#[ignore = "requires scripts/perf/mysql-fixture.ps1"]
fn dedicated_count_uses_no_page_row_and_matches_filtered_mysql_rows() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build Tokio runtime")
        .block_on(async {
            let url = fixture_url();
            let database = format!("dbscout_table_count_{}", Uuid::new_v4().simple());
            let options = MySqlConnectOptions::from_str(&url).expect("parse fixture URL");
            let server_pool = MySqlPoolOptions::new()
                .max_connections(2)
                .connect_with(options)
                .await
                .expect("connect isolated MySQL fixture");

            let scenario = async {
                execute(&server_pool, &format!("CREATE DATABASE `{database}`")).await?;
                execute(
                    &server_pool,
                    &format!(
                        "CREATE TABLE `{database}`.`people` (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL)"
                    ),
                )
                .await?;
                execute(
                    &server_pool,
                    &format!(
                        "INSERT INTO `{database}`.`people` (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'ALICIA')"
                    ),
                )
                .await?;

                let count_pool = connect_table_count_database(&url, &database).await?;
                assert_eq!(count_pool.options().get_max_connections(), 1);
                let table = read_schema(&count_pool, &database, "people").await?;
                let request = TablePageRequest {
                    page: Some(1),
                    page_size: Some(1),
                    offset: None,
                    include_total: Some(true),
                    filter: Some(TablePageFilter {
                        query: "ali".into(),
                        columns: vec!["name".into()],
                        mode: Some("fuzzy".into()),
                    }),
                    sort: None,
                };
                let page = read_db_page_in_database(
                    &count_pool,
                    &database,
                    &table,
                    "count-integration-page",
                    &request,
                )
                .await?;
                let count = read_db_table_count_in_database(
                    &count_pool,
                    &database,
                    &table,
                    &request,
                )
                .await?;
                count_pool.close().await;
                Ok::<_, String>((page, count))
            }
            .await;

            let cleanup = execute(&server_pool, &format!("DROP DATABASE IF EXISTS `{database}`")).await;
            server_pool.close().await;
            cleanup.expect("drop table count fixture database");

            let (page, count) = scenario.expect("run dedicated table count scenario");
            assert_eq!(page.rows.len(), 1);
            assert_eq!(page.total_rows, 1);
            assert!(!page.total_rows_exact);
            assert_eq!(count.total_rows, 2);
            assert!(count.exact);
            assert!(!count.estimated);
        });
}
