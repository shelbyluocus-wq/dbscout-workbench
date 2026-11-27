//! dbscout-server — central HTTP service for DB Scout Workbench.
//!
//! Hosts shared user accounts (username + opaque token, no passwords), tiered
//! shared change-log history (14d detailed / 180d daily summary / permanent
//! monthly summary), read-only 243 GM hourly backup browsing, and daily
//! per-table count-based backups (up to 60 changed versions per table).

mod audit_compaction;
mod auth;
mod db;
mod gm_backups;
mod handlers;
mod mcp;
mod mcp_mysql;
mod models;
mod table_backups;

use std::{
    env,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use chrono::{FixedOffset, NaiveTime, TimeZone, Utc};
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

fn parse_hhmm(env_var: &str, default_hour: u32, default_min: u32) -> (u32, u32) {
    if let Ok(raw) = env::var(env_var) {
        let trimmed = raw.trim();
        if let Some((h_str, m_str)) = trimmed.split_once(':') {
            if let (Ok(h), Ok(m)) = (h_str.trim().parse::<u32>(), m_str.trim().parse::<u32>()) {
                if h < 24 && m < 60 {
                    return (h, m);
                }
            }
        }
    }
    (default_hour, default_min)
}

fn duration_until_next_local_time(offset: FixedOffset, hour: u32, minute: u32) -> Duration {
    let now_local = Utc::now().with_timezone(&offset);
    let target_time = NaiveTime::from_hms_opt(hour, minute, 0).unwrap();
    let mut target_date = now_local.date_naive();
    if now_local.time() >= target_time {
        target_date = target_date.succ_opt().unwrap_or(target_date);
    }
    let target_naive = target_date.and_time(target_time);
    let target_dt = offset
        .from_local_datetime(&target_naive)
        .single()
        .unwrap_or(now_local);
    let secs = (target_dt - now_local).num_seconds().max(5) as u64;
    Duration::from_secs(secs)
}

fn spawn_daily_audit_compactor(
    pool: SqlitePool,
    policy: audit_compaction::AuditRetentionPolicy,
    hour: u32,
    minute: u32,
) {
    tokio::spawn(async move {
        let offset = policy.offset();
        loop {
            let wait = duration_until_next_local_time(offset, hour, minute);
            tokio::time::sleep(wait).await;
            match audit_compaction::compact_all_tables(&pool, policy, Utc::now()).await {
                Ok(report) => {
                    tracing::info!(
                        "每日审计归档完成: 每日总结 {} 个周期, 每月总结 {} 个周期, 精简 {} 条旧记录 -> 写入 {} 条总结 (外部变动合并 {} 条)",
                        report.daily_periods_compacted,
                        report.monthly_periods_compacted,
                        report.rows_removed,
                        report.summary_rows_written,
                        report.external_rows_removed
                    );
                }
                Err(error) => {
                    tracing::error!("每日审计归档失败: {error}");
                }
            }
        }
    });
}

fn spawn_daily_table_backup_scheduler(
    pool: SqlitePool,
    gm_backup_dir: Option<PathBuf>,
    config: table_backups::TableBackupConfig,
    lock: Arc<Mutex<()>>,
    hour: u32,
    minute: u32,
) {
    if gm_backup_dir.is_none() || config.backup_dir.is_none() {
        return;
    }
    tokio::spawn(async move {
        // Seed an initial baseline on first startup so the UI immediately has
        // per-table history without waiting until 01:15 the next morning.
        if !table_backups::has_any_completed_run(&pool).await {
            let _guard = lock.lock().await;
            match table_backups::run_per_table_backup_pass(
                &pool,
                gm_backup_dir.as_deref(),
                &config,
                Utc::now(),
            )
            .await
            {
                Ok(res) => {
                    tracing::info!(
                        "首次启动单表按次备份基线完成: 扫描 {} 个库 / {} 张表, 新增 {} 份变化版本",
                        res.databases_scanned,
                        res.tables_scanned,
                        res.tables_changed
                    );
                }
                Err(error) => {
                    tracing::warn!("首次启动单表按次备份基线失败: {error}");
                }
            }
        }

        let offset = FixedOffset::east_opt(config.tz_offset_hours * 3600)
            .unwrap_or_else(|| FixedOffset::east_opt(db::DEFAULT_TZ_OFFSET_HOURS * 3600).unwrap());
        loop {
            let wait = duration_until_next_local_time(offset, hour, minute);
            tokio::time::sleep(wait).await;
            let _guard = lock.lock().await;
            match table_backups::run_per_table_backup_pass(
                &pool,
                gm_backup_dir.as_deref(),
                &config,
                Utc::now(),
            )
            .await
            {
                Ok(res) => {
                    tracing::info!(
                        "每日单表按次备份完成: 扫描 {} 个库 / {} 张表, 变化 {} 张, 缺失标记 {} 张, 跳过已处理 {} 包",
                        res.databases_scanned,
                        res.tables_scanned,
                        res.tables_changed,
                        res.tables_missing,
                        res.skipped_archives
                    );
                }
                Err(error) => {
                    tracing::error!("每日单表按次备份失败: {error}");
                }
            }
        }
    });
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if let [mode, config_path, client] = args.as_slice() {
        if mode == "--mcp-headers" {
            println!("{}", mcp::client_headers(config_path, client).await?);
            return Ok(());
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "dbscout_server=info,tower_http=info".into()),
        )
        .init();

    let bind = env::var("DBSCOUT_SERVER_BIND").unwrap_or_else(|_| "0.0.0.0:8765".into());
    let db_path =
        env::var("DBSCOUT_SERVER_DB").unwrap_or_else(|_| "./dbscout-server.sqlite".into());
    // Default is 0 (disabled) so tiered 14d/180d/permanent retention governs history.
    let max_revisions_per_table = env::var("DBSCOUT_SERVER_MAX_REVISIONS_PER_TABLE")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(db::DEFAULT_MAX_REVISIONS_PER_TABLE);
    let retention_policy = audit_compaction::AuditRetentionPolicy::from_env();
    let table_backup_config = table_backups::TableBackupConfig::from_env(&db_path);
    let (backup_hour, backup_minute) = parse_hhmm("DBSCOUT_SERVER_TABLE_BACKUP_TIME", 1, 15);
    let (compact_hour, compact_minute) = parse_hhmm("DBSCOUT_SERVER_COMPACT_TIME", 2, 0);

    let pool = db::connect(&db_path).await?;
    if max_revisions_per_table > 0 {
        let pruned = db::prune_all_tables(&pool, max_revisions_per_table).await?;
        let pruned_ext = db::prune_all_external_changes(&pool, max_revisions_per_table).await?;
        tracing::info!(
            "中心服务数据库就绪: {db_path} (兼容计数模式: 每表保留最近 {max_revisions_per_table} 次, 启动清理 {pruned} 条旧审计 / {pruned_ext} 条旧外部变动)"
        );
    } else {
        let report =
            audit_compaction::compact_all_tables(&pool, retention_policy, Utc::now()).await?;
        tracing::info!(
            "中心服务数据库就绪: {db_path} (分级归档模式: {} 天内逐条 / {} 天内每日总结 / 超期每月永久总结; 启动归档日周期 {}、月周期 {}, 精简 {} 条 -> {} 条)",
            retention_policy.detailed_days,
            retention_policy.daily_days,
            report.daily_periods_compacted,
            report.monthly_periods_compacted,
            report.rows_removed,
            report.summary_rows_written
        );
        spawn_daily_audit_compactor(pool.clone(), retention_policy, compact_hour, compact_minute);
    }

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

    if let Some(dir) = table_backup_config.backup_dir.as_deref() {
        let tracked = table_backups::discover_tracked_databases(
            &table_backup_config,
            gm_backup_dir.as_deref(),
        );
        tracing::info!(
            "243 单表按次备份已就绪: 目录={} (每表最多 {} 次变化, 每日 {:02}:{:02} 执行, 匹配库: {:?})",
            dir.display(),
            table_backup_config.max_versions,
            backup_hour,
            backup_minute,
            tracked
        );
    } else {
        tracing::info!("未启用 243 单表按次备份目录");
    }

    let table_backup_lock = Arc::new(Mutex::new(()));
    spawn_daily_table_backup_scheduler(
        pool.clone(),
        gm_backup_dir.clone(),
        table_backup_config.clone(),
        table_backup_lock.clone(),
        backup_hour,
        backup_minute,
    );

    let state = handlers::ServerState {
        pool: pool.clone(),
        max_revisions_per_table,
        retention_policy,
        gm_backup_dir,
        gm_backup_table_cache: gm_backups::GmBackupTableCache::new(),
        table_backup_config,
        table_backup_lock,
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
        .route(
            "/backups/gm/table-history",
            get(handlers::list_gm_table_backups),
        )
        .route(
            "/backups/gm/table-history/versions",
            get(handlers::list_gm_table_backup_versions),
        )
        .route(
            "/backups/gm/table-history/extract",
            post(handlers::extract_gm_table_backup),
        )
        .route(
            "/backups/gm/table-history/run",
            post(handlers::run_gm_table_backups_now),
        )
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
    if let Some(config_path) = env::var_os("DBSCOUT_MCP_CONFIG") {
        let mcp_bind = match env::var("DBSCOUT_MCP_BIND") {
            Ok(bind) => bind.parse::<SocketAddr>()?,
            Err(env::VarError::NotPresent) => {
                let port = env::var("DBSCOUT_MCP_PORT")
                    .unwrap_or_else(|_| "8767".into())
                    .parse::<u16>()?;
                SocketAddr::from((Ipv4Addr::LOCALHOST, port))
            }
            Err(error) => return Err(error.into()),
        };
        let mcp_listener = tokio::net::TcpListener::bind(mcp_bind).await?;
        let mcp_addr = mcp_listener.local_addr()?;
        let mcp_app = mcp::router(config_path.into(), pool, max_revisions_per_table);
        tokio::spawn(async move {
            if let Err(error) = axum::serve(mcp_listener, mcp_app).await {
                tracing::error!("Blackcat MCP 监听退出: {error}");
            }
        });
        tracing::info!("Blackcat MCP 监听 http://{mcp_addr}/mcp");
    }
    tracing::info!("dbscout-server 监听 http://{bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
