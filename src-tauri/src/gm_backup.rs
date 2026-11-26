//! Client integration for reading and safely restoring GM's hourly MySQL
//! backups via the Blackcat central server (`dbscout-server` on 243:8766).
//!
//! Safety guarantees:
//! - Rejects system databases and read-only / non-MySQL connections.
//! - Always takes a local pre-restore protection snapshot (table-scoped for
//!   single/multi-table restore, full-DB for whole-database restore) before
//!   mutating the target database.
//! - Executes statements on one dedicated MySQL connection with
//!   `FOREIGN_KEY_CHECKS=0` and `UNIQUE_CHECKS=0`, skips `LOCK TABLES` /
//!   `UNLOCK TABLES` / `USE`, and guarantees re-enabling checks on exit.
//! - Records an audit trail entry (and triggers immediate central-server sync)
//!   so teammates can see who restored which table from which backup point.

use std::time::{Duration, Instant};

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::account::{audit_actor_and_id, current_session, ensure_loaded, server_url};
use crate::audit::{self, AuditContext, PendingAudit, SOURCE_ROLLBACK, STRATEGY_MANUAL};
use crate::audit_sync;
use crate::backup::{self, SNAPSHOT_PROGRESS_EVENT};
use crate::db::connect_database;
use crate::sync::set_session_lock_wait_limits;
use crate::types::{
    AppState, GmBackupItem, GmBackupListRequest, GmBackupListResponse, GmBackupTableInfo,
    GmBackupTablesRequest, GmBackupTablesResponse, RestoreGmBackupRequest,
    RestoreGmBackupResponse,
};

const LIST_TIMEOUT: Duration = Duration::from_secs(15);
const TABLES_TIMEOUT: Duration = Duration::from_secs(30);
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(120);
const RESTORE_PROGRESS_INTERVAL: Duration = Duration::from_millis(120);
const PER_TABLE_AUDIT_LIMIT: usize = 20;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerGmBackupListWire {
    enabled: bool,
    backup_dir_configured: bool,
    #[serde(default)]
    databases: Vec<String>,
    #[serde(default)]
    dates: Vec<String>,
    #[serde(default)]
    items: Vec<GmBackupItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerGmBackupTablesWire {
    database: String,
    ts: String,
    #[serde(default)]
    tables: Vec<GmBackupTableInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerGmBackupExtractRequest<'a> {
    date: &'a str,
    hour: &'a str,
    file_name: &'a str,
    tables: &'a [String],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerGmBackupExtractWire {
    database: String,
    ts: String,
    #[serde(default)]
    tables: Vec<String>,
    sql: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreProgressPayload {
    job_id: String,
    connection_id: String,
    database: String,
    done: u64,
    total: u64,
    current_table: Option<String>,
    status: String,
    message: String,
}

fn emit_restore_progress(
    app: &AppHandle,
    job_id: &str,
    connection_id: &str,
    database: &str,
    done: u64,
    total: u64,
    status: &str,
    message: impl Into<String>,
) {
    let _ = app.emit(
        SNAPSHOT_PROGRESS_EVENT,
        RestoreProgressPayload {
            job_id: job_id.to_string(),
            connection_id: connection_id.to_string(),
            database: database.to_string(),
            done,
            total,
            current_table: None,
            status: status.to_string(),
            message: message.into(),
        },
    );
}

fn empty_list_response(status: &str, error: Option<String>) -> GmBackupListResponse {
    GmBackupListResponse {
        status: status.to_string(),
        enabled: false,
        backup_dir_configured: false,
        databases: Vec::new(),
        dates: Vec::new(),
        items: Vec::new(),
        error,
    }
}

async fn fetch_gm_backup_list(
    http: &reqwest::Client,
    base_url: &str,
    token: &str,
    request: &GmBackupListRequest,
) -> GmBackupListResponse {
    let mut url = match reqwest::Url::parse(&format!("{base_url}/backups/gm")) {
        Ok(url) => url,
        Err(error) => {
            return empty_list_response("unreachable", Some(format!("中心服务地址无效: {error}")));
        }
    };
    {
        let mut pairs = url.query_pairs_mut();
        if let Some(db) = request
            .database
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            pairs.append_pair("database", db);
        }
        if let Some(date) = request
            .date
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            pairs.append_pair("date", date);
        }
        if let Some(limit) = request.limit {
            pairs.append_pair("limit", &limit.to_string());
        }
    }

    let resp = match http
        .get(url)
        .bearer_auth(token)
        .timeout(LIST_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(error) => {
            return empty_list_response(
                "unreachable",
                Some(format!("无法连接中心服务获取 243 备份列表: {error}")),
            );
        }
    };

    match resp.status() {
        StatusCode::OK => match resp.json::<ServerGmBackupListWire>().await {
            Ok(wire) => GmBackupListResponse {
                status: if wire.enabled {
                    "ok".to_string()
                } else {
                    "disabled".to_string()
                },
                enabled: wire.enabled,
                backup_dir_configured: wire.backup_dir_configured,
                databases: wire.databases,
                dates: wire.dates,
                items: wire.items,
                error: None,
            },
            Err(error) => empty_list_response(
                "unreachable",
                Some(format!("解析 243 备份列表失败: {error}")),
            ),
        },
        StatusCode::UNAUTHORIZED => empty_list_response(
            "unauthorized",
            Some("登录状态已失效，请在设置中重新登录黑猫账号".into()),
        ),
        StatusCode::NOT_FOUND => empty_list_response(
            "unsupported_server",
            Some("243 中心服务尚未升级到支持读取定时备份的版本".into()),
        ),
        status => {
            let body = resp.text().await.unwrap_or_default();
            let detail = body.trim();
            let msg = if detail.is_empty() {
                format!("读取 243 备份列表失败 ({status})")
            } else {
                format!("读取 243 备份列表失败 ({status}): {detail}")
            };
            empty_list_response("unreachable", Some(msg))
        }
    }
}

pub async fn list_gm_backups(
    app: &AppHandle,
    state: &AppState,
    request: &GmBackupListRequest,
) -> Result<GmBackupListResponse, String> {
    ensure_loaded(app, state).await?;
    let Some(base_url) = server_url(state).await else {
        return Ok(empty_list_response(
            "not_configured",
            Some("尚未配置中心服务地址".into()),
        ));
    };
    let Some(session) = current_session(state).await else {
        return Ok(empty_list_response(
            "logged_out",
            Some("请先在设置中登录黑猫账号，再读取 243 服务器定时备份".into()),
        ));
    };
    Ok(fetch_gm_backup_list(&state.account.http, &base_url, &session.token, request).await)
}

pub async fn list_gm_backup_tables(
    app: &AppHandle,
    state: &AppState,
    request: &GmBackupTablesRequest,
) -> Result<GmBackupTablesResponse, String> {
    ensure_loaded(app, state).await?;
    let base_url = server_url(state)
        .await
        .ok_or_else(|| "尚未配置中心服务地址".to_string())?;
    let session = current_session(state)
        .await
        .ok_or_else(|| "请先登录黑猫账号".to_string())?;

    let mut url = reqwest::Url::parse(&format!("{base_url}/backups/gm/tables"))
        .map_err(|error| format!("中心服务地址无效: {error}"))?;
    url.query_pairs_mut()
        .append_pair("date", request.date.trim())
        .append_pair("hour", request.hour.trim())
        .append_pair("fileName", request.file_name.trim());

    let resp = state
        .account
        .http
        .get(url)
        .bearer_auth(&session.token)
        .timeout(TABLES_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("读取备份表列表失败: {error}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(match status {
            StatusCode::UNAUTHORIZED => "登录状态已失效，请在设置中重新登录".into(),
            StatusCode::NOT_FOUND if body.trim().is_empty() => {
                "243 中心服务暂不支持查看备份表列表或备份文件已被清理".into()
            }
            _ => {
                let detail = body.trim();
                if detail.is_empty() {
                    format!("读取备份表列表失败 ({status})")
                } else {
                    format!("读取备份表列表失败: {detail}")
                }
            }
        });
    }

    let wire: ServerGmBackupTablesWire = resp
        .json()
        .await
        .map_err(|error| format!("解析备份表列表失败: {error}"))?;
    Ok(GmBackupTablesResponse {
        database: wire.database,
        ts: wire.ts,
        tables: wire.tables,
    })
}

/// Filter out non-executable or unsafe wrapper statements from a mysqldump
/// before running them against a target database.
pub(crate) fn filter_executable_dump_statements(sql: &str) -> Vec<String> {
    backup::split_statements(sql)
        .into_iter()
        .map(|stmt| stmt.trim().to_string())
        .filter(|stmt| !stmt.is_empty() && !should_skip_dump_statement(stmt))
        .collect()
}

fn should_skip_dump_statement(trimmed: &str) -> bool {
    if trimmed.starts_with("--") || trimmed.starts_with('#') {
        return true;
    }
    let upper = trimmed.to_ascii_uppercase();
    upper.starts_with("LOCK TABLES ")
        || upper == "UNLOCK TABLES"
        || upper.starts_with("UNLOCK TABLES ")
        || upper.starts_with("USE ")
        || upper.starts_with("CREATE DATABASE ")
}

async fn record_gm_restore_audit(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    database: &str,
    source_database: &str,
    backup_ts: &str,
    restored_tables: &[String],
    is_full_db: bool,
) {
    let Ok(audit_pool) = audit::ensure_audit_pool(app, state).await else {
        return;
    };
    let (actor, _) = audit_actor_and_id(app, state).await;
    let note = if is_full_db {
        format!(
            "从 243 定时备份还原整库（来源库: {source_database}，备份时间: {backup_ts}，共 {} 张表）",
            restored_tables.len()
        )
    } else {
        format!(
            "从 243 定时备份按表还原（来源库: {source_database}，备份时间: {backup_ts}，表: {}）",
            restored_tables.join(", ")
        )
    };

    let targets: Vec<String> = if !is_full_db
        && !restored_tables.is_empty()
        && restored_tables.len() <= PER_TABLE_AUDIT_LIMIT
    {
        restored_tables.to_vec()
    } else {
        vec!["(gm_backup_restore)".to_string()]
    };

    let mut committed_ids = Vec::with_capacity(targets.len());
    for table_name in targets {
        let ctx = AuditContext {
            connection_id: connection_id.to_string(),
            database: database.to_string(),
            table_name,
            session_id: None,
            source: SOURCE_ROLLBACK,
            actor: actor.clone(),
            client_id: uuid::Uuid::new_v4().to_string(),
        };
        let pending = PendingAudit {
            operation: "RESTORE",
            column_name: None,
            old_value: None,
            new_value: Some(format!("{source_database} @ {backup_ts}")),
            row_identity: None,
            forward_sql: format!("-- restore from 243 backup {source_database} @ {backup_ts}"),
            forward_binds: Vec::new(),
            inverse_sql: None,
            inverse_binds: Vec::new(),
            rollback_strategy: STRATEGY_MANUAL,
            notes: Some(note.clone()),
        };
        if let Ok(id) = audit::record_pending(&audit_pool, &ctx, &pending).await {
            committed_ids.push(id);
        }
    }
    if !committed_ids.is_empty() {
        let _ = audit::mark_committed(&audit_pool, &committed_ids).await;
        audit_sync::trigger_immediate_sync(app);
    }
}

pub async fn restore_gm_backup(
    app: &AppHandle,
    state: &AppState,
    mysql_url: &str,
    request: &RestoreGmBackupRequest,
) -> Result<RestoreGmBackupResponse, String> {
    let target_db = request.database.trim();
    if target_db.is_empty() {
        return Err("请选择要还原的目标数据库".into());
    }
    if backup::is_system_database(target_db) {
        return Err(format!("系统内置数据库 `{target_db}` 不支持还原"));
    }

    ensure_loaded(app, state).await?;
    let base_url = server_url(state)
        .await
        .ok_or_else(|| "尚未配置中心服务地址".to_string())?;
    let session = current_session(state)
        .await
        .ok_or_else(|| "请先登录黑猫账号".to_string())?;

    let job_id = format!("gm-restore-{}", chrono::Utc::now().format("%Y%m%d-%H%M%S"));
    let requested_tables: Vec<String> = request
        .tables
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let is_full_db = requested_tables.is_empty();

    emit_restore_progress(
        app,
        &job_id,
        &request.connection_id,
        target_db,
        0,
        100,
        "running",
        if is_full_db {
            "正在从 243 服务器提取整库备份 SQL..."
        } else {
            "正在从 243 服务器提取所选表的备份 SQL..."
        },
    );

    let extract_url = format!("{base_url}/backups/gm/extract");
    let extract_resp = state
        .account
        .http
        .post(&extract_url)
        .bearer_auth(&session.token)
        .timeout(EXTRACT_TIMEOUT)
        .json(&ServerGmBackupExtractRequest {
            date: request.date.trim(),
            hour: request.hour.trim(),
            file_name: request.file_name.trim(),
            tables: &requested_tables,
        })
        .send()
        .await
        .map_err(|error| {
            emit_restore_progress(
                app,
                &job_id,
                &request.connection_id,
                target_db,
                0,
                100,
                "failed",
                "从 243 服务器拉取备份失败",
            );
            format!("从 243 服务器提取备份失败: {error}")
        })?;

    if !extract_resp.status().is_success() {
        let status = extract_resp.status();
        let body = extract_resp.text().await.unwrap_or_default();
        emit_restore_progress(
            app,
            &job_id,
            &request.connection_id,
            target_db,
            0,
            100,
            "failed",
            "提取备份失败",
        );
        let detail = body.trim();
        return Err(if detail.is_empty() {
            format!("提取 243 备份失败 ({status})")
        } else {
            format!("提取 243 备份失败: {detail}")
        });
    }

    let extracted: ServerGmBackupExtractWire = extract_resp.json().await.map_err(|error| {
        emit_restore_progress(
            app,
            &job_id,
            &request.connection_id,
            target_db,
            0,
            100,
            "failed",
            "解析备份数据失败",
        );
        format!("解析 243 备份响应失败: {error}")
    })?;

    let statements = filter_executable_dump_statements(&extracted.sql);
    if statements.is_empty() {
        emit_restore_progress(
            app,
            &job_id,
            &request.connection_id,
            target_db,
            0,
            100,
            "failed",
            "备份中没有可执行 SQL",
        );
        return Err("备份文件中未解析到可执行的 SQL 语句".into());
    }

    // Always snapshot the current target state locally first so the restore is reversible.
    emit_restore_progress(
        app,
        &job_id,
        &request.connection_id,
        target_db,
        10,
        100,
        "running",
        if is_full_db {
            "正在为目标库创建还原前本地保护快照..."
        } else {
            "正在为所选表创建还原前本地保护快照..."
        },
    );
    let config = backup::load_config(app);
    let only_tables_ref = if is_full_db {
        None
    } else {
        Some(extracted.tables.as_slice())
    };
    let pre_restore_path = backup::create_gm_restore_protection_snapshot(
        app,
        mysql_url,
        &request.connection_id,
        target_db,
        &config,
        only_tables_ref,
    )
    .await
    .map_err(|error| {
        emit_restore_progress(
            app,
            &job_id,
            &request.connection_id,
            target_db,
            0,
            100,
            "failed",
            "创建还原前保护快照失败",
        );
        format!("创建还原前本地保护快照失败: {error}")
    })?;

    let total_stmts = statements.len() as u64;
    emit_restore_progress(
        app,
        &job_id,
        &request.connection_id,
        target_db,
        0,
        total_stmts,
        "running",
        format!("正在向 {target_db} 写入还原数据（共 {total_stmts} 条语句）..."),
    );

    let pool = connect_database(mysql_url, Some(target_db)).await?;
    let restore_result = async {
        let mut connection = pool
            .acquire()
            .await
            .map_err(|error| format!("获取目标数据库连接失败: {error}"))?;
        set_session_lock_wait_limits(&mut connection).await?;
        for preamble in [
            "SET NAMES utf8mb4",
            "SET FOREIGN_KEY_CHECKS=0",
            "SET UNIQUE_CHECKS=0",
            "SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO'",
        ] {
            sqlx::query(preamble)
                .execute(&mut *connection)
                .await
                .map_err(|error| format!("初始化还原会话失败 ({preamble}): {error}"))?;
        }

        let mut last_emit = Instant::now() - RESTORE_PROGRESS_INTERVAL;
        let exec_result = async {
            for (idx, stmt) in statements.iter().enumerate() {
                sqlx::query(stmt)
                    .execute(&mut *connection)
                    .await
                    .map_err(|error| {
                        let preview: String = stmt.chars().take(120).collect();
                        format!("还原第 {} 条 SQL 失败: {error}（语句片段: {preview}）", idx + 1)
                    })?;
                let done = (idx + 1) as u64;
                if done == total_stmts || last_emit.elapsed() >= RESTORE_PROGRESS_INTERVAL {
                    emit_restore_progress(
                        app,
                        &job_id,
                        &request.connection_id,
                        target_db,
                        done,
                        total_stmts,
                        "running",
                        format!("正在还原 {target_db}（{done} / {total_stmts}）"),
                    );
                    last_emit = Instant::now();
                }
            }
            Ok::<(), String>(())
        }
        .await;

        let reenable_fk = sqlx::query("SET FOREIGN_KEY_CHECKS=1")
            .execute(&mut *connection)
            .await;
        let reenable_uniq = sqlx::query("SET UNIQUE_CHECKS=1")
            .execute(&mut *connection)
            .await;

        match (exec_result, reenable_fk, reenable_uniq) {
            (Ok(()), Ok(_), Ok(_)) => Ok(()),
            (Err(err), _, _) => Err(err),
            (Ok(()), Err(err), _) => Err(format!("还原完成但恢复外键检查失败: {err}")),
            (Ok(()), Ok(_), Err(err)) => Err(format!("还原完成但恢复唯一性检查失败: {err}")),
        }
    }
    .await;
    pool.close().await;

    if let Err(error) = restore_result {
        emit_restore_progress(
            app,
            &job_id,
            &request.connection_id,
            target_db,
            0,
            total_stmts,
            "failed",
            "还原失败",
        );
        return Err(error);
    }

    emit_restore_progress(
        app,
        &job_id,
        &request.connection_id,
        target_db,
        total_stmts,
        total_stmts,
        "done",
        "243 服务器备份还原完成",
    );

    record_gm_restore_audit(
        app,
        state,
        &request.connection_id,
        target_db,
        &extracted.database,
        &extracted.ts,
        &extracted.tables,
        is_full_db,
    )
    .await;

    Ok(RestoreGmBackupResponse {
        database: target_db.to_string(),
        source_database: extracted.database,
        ts: extracted.ts,
        restored_tables: extracted.tables,
        statement_count: statements.len(),
        pre_restore_snapshot_path: pre_restore_path.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn spawn_mock_server(status_line: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0_u8; 2048];
                let _ = socket.read(&mut buf).await;
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        format!("http://{addr}")
    }

    #[test]
    fn filter_executable_dump_statements_drops_locks_and_preserves_escaped_backslashes() {
        let dump = r#"
-- MySQL dump 10.13  Distrib 8.4.10
USE `newsgcfg`;
DROP TABLE IF EXISTS `activentranceprop`;
CREATE TABLE `activentranceprop` (
  `Icon` text NOT NULL COMMENT '完整图标名common\\functionButton\\',
  PRIMARY KEY (`Icon`(10))
) ENGINE=InnoDB;
LOCK TABLES `activentranceprop` WRITE;
/*!40000 ALTER TABLE `activentranceprop` DISABLE KEYS */;
INSERT INTO `activentranceprop` VALUES ('common\\functionButton\\');
/*!40000 ALTER TABLE `activentranceprop` ENABLE KEYS */;
UNLOCK TABLES;
"#;
        let stmts = filter_executable_dump_statements(dump);
        assert_eq!(stmts.len(), 5);
        assert_eq!(stmts[0], "DROP TABLE IF EXISTS `activentranceprop`");
        assert!(stmts[1].contains("common\\\\functionButton\\\\"));
        assert!(stmts[2].contains("DISABLE KEYS"));
        assert_eq!(
            stmts[3],
            "INSERT INTO `activentranceprop` VALUES ('common\\\\functionButton\\\\')"
        );
        assert!(stmts[4].contains("ENABLE KEYS"));
    }

    #[tokio::test]
    async fn fetch_gm_backup_list_maps_server_statuses_cleanly() {
        let client = reqwest::Client::new();
        let req = GmBackupListRequest::default();

        let ok_url = spawn_mock_server(
            "200 OK",
            r#"{"enabled":true,"backupDirConfigured":true,"databases":["newsgcfg"],"dates":["2026-11-26"],"items":[{"date":"2026-11-26","hour":"0","fileName":"192.168.1.243_mysql_newsgcfg_2026-11-26-00_50_02.zip","host":"192.168.1.243","database":"newsgcfg","ts":"2026-11-26 00:50:02","sizeBytes":1234}]}"#,
        )
        .await;
        let ok = fetch_gm_backup_list(&client, &ok_url, "tok", &req).await;
        assert_eq!(ok.status, "ok");
        assert!(ok.enabled);
        assert_eq!(ok.items.len(), 1);
        assert_eq!(ok.items[0].database, "newsgcfg");

        let not_found_url = spawn_mock_server("404 Not Found", "").await;
        let unsupported = fetch_gm_backup_list(&client, &not_found_url, "tok", &req).await;
        assert_eq!(unsupported.status, "unsupported_server");

        let unauth_url = spawn_mock_server("401 Unauthorized", "").await;
        let unauth = fetch_gm_backup_list(&client, &unauth_url, "tok", &req).await;
        assert_eq!(unauth.status, "unauthorized");
    }
}
