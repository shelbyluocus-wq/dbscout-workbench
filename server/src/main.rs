//! dbscout-server — central HTTP service for DB Scout Workbench.
//!
//! Hosts shared user accounts (username + opaque token, no passwords) and a
//! shared change-log so every client on the LAN can see who changed what.
//! Data is kept in a single SQLite file. Run with:
//!
//! ```sh
//! DBSCOUT_SERVER_BIND=0.0.0.0:8765 DBSCOUT_SERVER_DB=./dbscout-server.sqlite \
//!   cargo run -p dbscout-server
//! ```

mod auth;
mod db;
mod gm_backups;
mod handlers;
mod models;

use std::env;

use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "dbscout_server=info,tower_http=info".into()),
        )
        .init();

    let bind = env::var("DBSCOUT_SERVER_BIND").unwrap_or_else(|_| "0.0.0.0:8765".into());
    let db_path =
        env::var("DBSCOUT_SERVER_DB").unwrap_or_else(|_| "./dbscout-server.sqlite".into());
    let max_revisions_per_table = env::var("DBSCOUT_SERVER_MAX_REVISIONS_PER_TABLE")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(db::DEFAULT_MAX_REVISIONS_PER_TABLE);

    let pool = db::connect(&db_path).await?;
    let pruned = db::prune_all_tables(&pool, max_revisions_per_table).await?;
    let pruned_ext = db::prune_all_external_changes(&pool, max_revisions_per_table).await?;
    tracing::info!(
        "中心服务数据库就绪: {db_path} (每表保留最近 {max_revisions_per_table} 次改动, 启动清理 {pruned} 条旧审计 / {pruned_ext} 条旧外部变动)"
    );

    let gm_backup_dir = gm_backups::resolve_gm_backup_dir();
    match gm_backup_dir.as_deref() {
        Some(dir) if dir.is_dir() => {
            tracing::info!("GM 定时备份只读目录已就绪: {}", dir.display());
        }
        Some(dir) => {
            tracing::warn!(
                "GM 定时备份目录不存在，相关只读接口将返回未启用: {}",
                dir.display()
            );
        }
        None => {
            tracing::info!("未启用 GM 定时备份只读目录");
        }
    }

    let state = handlers::ServerState {
        pool: pool.clone(),
        max_revisions_per_table,
        gm_backup_dir,
        gm_backup_table_cache: gm_backups::GmBackupTableCache::new(),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Public routes (no auth).
    let public = Router::new()
        .route("/health", get(handlers::health))
        .route("/register", post(handlers::register))
        .route("/login", post(handlers::login));

    // Authenticated routes (bearer token required).
    let protected = Router::new()
        .route("/me", get(handlers::me))
        .route(
            "/audit",
            get(handlers::list_audit).post(handlers::push_audit),
        )
        .route("/audit/since", get(handlers::list_audit))
        .route("/audit/table-latest", get(handlers::table_latest))
        .route(
            "/external-changes",
            get(handlers::list_external_changes).post(handlers::push_external_changes),
        )
        .route("/backups/gm", get(handlers::list_gm_backups))
        .route("/backups/gm/tables", get(handlers::list_gm_backup_tables))
        .route("/backups/gm/extract", post(handlers::extract_gm_backup))
        .layer(middleware::from_fn_with_state(
            pool.clone(),
            auth::require_auth,
        ));

    let app = Router::new()
        .merge(public)
        .merge(protected)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("dbscout-server 监听 http://{bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
