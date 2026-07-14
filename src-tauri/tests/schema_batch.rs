use std::str::FromStr;

use dbscout_workbench_lib::{integration_api::read_schemas_for_tables, types::TableOption};
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
fn batch_schema_query_preserves_table_comments_order_and_column_ownership() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build Tokio runtime")
        .block_on(async {
            let url = fixture_url();
            let database = format!("dbscout_schema_batch_{}", Uuid::new_v4().simple());
            let options = MySqlConnectOptions::from_str(&url).expect("parse fixture URL");
            let pool = MySqlPoolOptions::new()
                .max_connections(2)
                .connect_with(options)
                .await
                .expect("connect isolated MySQL fixture");

            let scenario = async {
                execute(&pool, &format!("CREATE DATABASE `{database}`")).await?;
                execute(
                    &pool,
                    &format!(
                        "CREATE TABLE `{database}`.`orders` (\
                         `order_id` BIGINT NOT NULL, `amount` DECIMAL(10,2) NULL, \
                         PRIMARY KEY (`order_id`)) COMMENT='Order ledger'"
                    ),
                )
                .await?;
                execute(
                    &pool,
                    &format!(
                        "CREATE TABLE `{database}`.`users` (\
                         `user_id` BIGINT NOT NULL, `display_name` VARCHAR(64) NOT NULL, \
                         PRIMARY KEY (`user_id`)) COMMENT='User directory'"
                    ),
                )
                .await?;

                read_schemas_for_tables(
                    &pool,
                    &database,
                    &[
                        TableOption {
                            table_name: "users".into(),
                            table_comment: String::new(),
                            column_count: None,
                            data_size_bytes: None,
                            modified_at: None,
                        },
                        TableOption {
                            table_name: "orders".into(),
                            table_comment: String::new(),
                            column_count: None,
                            data_size_bytes: None,
                            modified_at: None,
                        },
                    ],
                )
                .await
            }
            .await;

            let cleanup = execute(&pool, &format!("DROP DATABASE IF EXISTS `{database}`")).await;
            pool.close().await;
            cleanup.expect("drop schema batch fixture database");

            let schemas = scenario.expect("read both schemas in one batch");
            assert_eq!(
                schemas
                    .iter()
                    .map(|schema| schema.table_name.as_str())
                    .collect::<Vec<_>>(),
                ["users", "orders"]
            );
            assert_eq!(schemas[0].table_comment, "User directory");
            assert_eq!(schemas[1].table_comment, "Order ledger");
            assert_eq!(
                schemas[0]
                    .columns
                    .iter()
                    .map(|column| column.column_name.as_str())
                    .collect::<Vec<_>>(),
                ["user_id", "display_name"]
            );
            assert_eq!(
                schemas[1]
                    .columns
                    .iter()
                    .map(|column| column.column_name.as_str())
                    .collect::<Vec<_>>(),
                ["order_id", "amount"]
            );
        });
}
