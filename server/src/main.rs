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

    let pool = db::connect(&db_path).await?;
    tracing::info!("中心服务数据库就绪: {db_path}");

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Public routes (no auth).
    let public = Router::new()
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
        .layer(middleware::from_fn_with_state(
            pool.clone(),
            auth::require_auth,
        ));

    let app = Router::new()
        .merge(public)
        .merge(protected)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(pool.clone());

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("dbscout-server 监听 http://{bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
