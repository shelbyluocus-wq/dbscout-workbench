//! Atomic, table-scoped inverse replay with a durable reconciliation journal.
use crate::{
    audit::{self, AuditEntry, PendingAudit},
    audit_history::{HistoryRequest, GROUP_KEY},
    db, mysql_text,
    perf::PerfContext,
    types::{AppState, CellUpdateChange, RowIdentity, TableMeta},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{MySql, MySqlPool, Row, SqlitePool, Transaction};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub token: String,
    pub target_ts: String,
    pub operations: usize,
    pub inserted: usize,
    pub updated: usize,
    pub deleted: usize,
    pub entries: usize,
}
fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

async fn history(
    pool: &SqlitePool,
    r: &HistoryRequest,
) -> Result<(Vec<AuditEntry>, String, usize), String> {
    let (c, d, t) = r.target()?;
    let id = r.audit_id.ok_or("请选择历史节点")?;
    let anchor = sqlx::query(
        "SELECT * FROM audit_log WHERE id=? AND connection_id=? AND database=? AND table_name=?",
    )
    .bind(id)
    .bind(c)
    .bind(d)
    .bind(t)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or("记录已清理，请刷新列表")?;
    let key: Option<String> = anchor.get("operation_id");
    let ts: String = anchor.get("ts");
    let boundary: i64 = sqlx::query_scalar(&format!("SELECT MIN(id) FROM audit_log WHERE connection_id=? AND database=? AND table_name=? AND {GROUP_KEY}=?"))
        .bind(c).bind(d).bind(t).bind(key.unwrap_or_else(||format!("legacy:{ts}"))).fetch_one(pool).await.map_err(|e|e.to_string())?;
    // Unscoped SQL/agent writes and DDL can affect this table without identifying
    // it. Never silently skip these gaps in the local history.
    let unsafe_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE connection_id=? AND database=? AND id>=? AND status!='aborted' AND (source='ddl' OR table_name='' OR table_name LIKE '(%' OR table_name='*')")
        .bind(c).bind(d).bind(boundary).fetch_one(pool).await.map_err(|e|e.to_string())?;
    if unsafe_count > 0 {
        return Err(
            "这段历史包含结构变更或无法定位到表的操作，不能整体恢复；请查看快照或具体记录".into(),
        );
    }
    let rows = sqlx::query("SELECT * FROM audit_log WHERE connection_id=? AND database=? AND table_name=? AND id>=? ORDER BY id DESC")
        .bind(c).bind(d).bind(t).bind(boundary).fetch_all(pool).await.map_err(|e|e.to_string())?;
    let mut groups = HashMap::<String, (i64, i64)>::new();
    let mut entries = Vec::new();
    for row in rows {
        let op: Option<String> = row.get("operation_id");
        let size: Option<i64> = row.get("operation_size");
        let group = op
            .clone()
            .unwrap_or_else(|| format!("legacy:{}", row.get::<String, _>("ts")));
        let item = groups.entry(group).or_insert((0, size.unwrap_or(0)));
        item.0 += 1;
        if size.unwrap_or(0) != item.1 {
            return Err("操作批次记录不一致，不能恢复".into());
        }
        let mut entry = audit::audit_entry(&row);
        if entry.status == audit::STATUS_ABORTED {
            continue;
        }
        if !matches!(entry.status.as_str(), "committed" | "rolled_back") {
            return Err("这段历史存在未确认完成的操作，请先核对结果后重试".into());
        }
        if entry.rollback_strategy != audit::STRATEGY_AUTO || entry.inverse_sql.is_none() {
            return Err(format!(
                "记录 {} 缺少可靠的恢复数据，不能跨过此记录",
                entry.id
            ));
        }
        // Old single-entry rollback stored the original before/after values.
        if entry.is_rollback && op.is_none() {
            std::mem::swap(&mut entry.old_value, &mut entry.new_value);
        }
        entries.push(entry);
    }
    if groups
        .values()
        .any(|(count, size)| *size > 0 && count != size)
    {
        return Err("操作批次有记录缺失，不能恢复".into());
    }
    if entries.is_empty() {
        return Err("此节点之后没有需要恢复的修改".into());
    }
    Ok((entries, ts, groups.len()))
}

fn values(entry: &AuditEntry, raw: &Option<String>) -> Result<RowIdentity, String> {
    if let Some(column) = &entry.column_name {
        return Ok(HashMap::from([(column.clone(), raw.clone())]));
    }
    let value: serde_json::Value =
        serde_json::from_str(raw.as_deref().ok_or("历史记录缺少行数据")?)
            .map_err(|_| "历史记录的行数据无法解析")?;
    let obj = value.as_object().ok_or("历史记录的行数据不是字段映射")?;
    Ok(obj
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                if v.is_null() {
                    None
                } else {
                    Some(
                        v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string()),
                    )
                },
            )
        })
        .collect())
}
fn identity(entry: &AuditEntry) -> Result<RowIdentity, String> {
    let result: RowIdentity =
        serde_json::from_value(entry.row_identity.clone().ok_or("历史记录缺少行标识")?)
            .map_err(|_| "历史行标识无法解析")?;
    if result.is_empty() {
        return Err("历史记录缺少可验证的行标识".into());
    }
    Ok(result)
}
fn exact_text_guards(sql: String, table: &TableMeta) -> String {
    let Some((prefix, predicates)) = sql.split_once(" WHERE ") else {
        return sql;
    };
    let mut predicates = predicates.to_owned();
    for column in &table.columns {
        let kind = column.column_type.to_ascii_lowercase();
        if ["char", "text", "enum", "set", "binary", "blob"]
            .iter()
            .any(|part| kind.contains(part))
        {
            let name = db::escape_ident(&column.column_name);
            for operator in ["=", "<=>"] {
                predicates = predicates.replace(
                    &format!("`{name}` {operator} ?"),
                    &format!("BINARY `{name}` {operator} BINARY ?"),
                );
            }
        }
    }
    format!("{prefix} WHERE {predicates}")
}

fn reverse_plan(entry: &AuditEntry, table: &TableMeta) -> Result<PendingAudit, String> {
    let mut row_identity = identity(entry)?;
    let known: HashSet<_> = table
        .columns
        .iter()
        .map(|c| c.column_name.as_str())
        .collect();
    let check = |values: &RowIdentity| -> Result<(), String> {
        if values.is_empty() || values.keys().any(|k| !known.contains(k.as_str())) {
            return Err("表结构与历史记录不一致，不能恢复".into());
        }
        Ok(())
    };
    check(&row_identity)?;
    let (operation, forward_sql, forward_binds, inverse_sql, inverse_binds) = match entry
        .operation
        .as_str()
    {
        "UPDATE" => {
            let old = values(entry, &entry.old_value)?;
            let new = values(entry, &entry.new_value)?;
            check(&old)?;
            check(&new)?;
            if old.len() != new.len() || old.keys().any(|k| !new.contains_key(k)) {
                return Err("字段前后值记录不完整".into());
            }
            for (key, v) in &new {
                if row_identity.contains_key(key) {
                    row_identity.insert(key.clone(), v.clone());
                }
            }
            let mut keys = old.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let changes = keys
                .iter()
                .map(|k| CellUpdateChange {
                    column_name: k.clone(),
                    old_value: new[k].clone(),
                    new_value: old[k].clone(),
                })
                .collect::<Vec<_>>();
            let json_columns = table
                .columns
                .iter()
                .filter(|c| c.column_type.to_lowercase().contains("json"))
                .map(|c| c.column_name.clone())
                .collect();
            let (f, fb, i, ib) = audit::build_row_update_inverse(
                &entry.database,
                &entry.table_name,
                &row_identity,
                &changes,
                &json_columns,
            )?;
            ("UPDATE", f, fb, i, ib)
        }
        "INSERT" | "DELETE" => {
            let data = values(
                entry,
                if entry.operation == "INSERT" {
                    &entry.new_value
                } else {
                    &entry.old_value
                },
            )?;
            check(&data)?;
            if table
                .columns
                .iter()
                .filter(|c| !c.is_generated)
                .any(|c| !data.contains_key(&c.column_name))
            {
                return Err("历史增删行未保存完整字段值，无法安全恢复；请查看快照".into());
            }
            let mut guard = data.clone();
            guard.extend(row_identity.clone());
            let (del, dbinds) =
                audit::build_delete_forward_nullable(&entry.database, &entry.table_name, &guard)?;
            let mut columns = table
                .columns
                .iter()
                .filter(|c| !c.is_generated)
                .map(|c| c.column_name.clone())
                .collect::<Vec<_>>();
            columns.sort();
            let (ins, ibinds) = audit::build_delete_inverse(
                &entry.database,
                &entry.table_name,
                &columns,
                &audit::preimage_vector(&columns, &data),
            );
            if entry.operation == "INSERT" {
                ("DELETE", del, dbinds, ins, ibinds)
            } else {
                ("INSERT", ins, ibinds, del, dbinds)
            }
        }
        _ => return Err("此操作不支持数据恢复".into()),
    };
    Ok(PendingAudit {
        operation,
        column_name: entry.column_name.clone(),
        old_value: entry.new_value.clone(),
        new_value: entry.old_value.clone(),
        row_identity: Some(serde_json::to_value(row_identity).map_err(|e| e.to_string())?),
        forward_sql: exact_text_guards(forward_sql, table),
        forward_binds,
        inverse_sql: Some(exact_text_guards(inverse_sql, table)),
        inverse_binds,
        rollback_strategy: audit::STRATEGY_AUTO,
        notes: Some(format!("恢复历史节点；逆向记录 {}", entry.id)),
    })
}

async fn validate_features(
    connection: &mut sqlx::MySqlConnection,
    d: &str,
    t: &str,
) -> Result<(), String> {
    let engine_row = sqlx::query(
        "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",
    )
    .bind(d)
    .bind(t)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|e| e.to_string())?;
    let engine = match engine_row {
        Some(row) => mysql_text::optional_string(&row, 0)
            .map_err(|e| format!("读取表存储引擎失败: {e}"))?,
        None => None,
    };
    if engine.as_deref() != Some("InnoDB") {
        return Err("仅支持 InnoDB 表的事务恢复".into());
    }
    let triggers:i64=sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=?").bind(d).bind(t).fetch_one(&mut *connection).await.map_err(|e|e.to_string())?;
    let refs:i64=sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE (TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL) OR (REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=?)").bind(d).bind(t).bind(d).bind(t).fetch_one(&mut *connection).await.map_err(|e|e.to_string())?;
    if triggers > 0 || refs > 0 {
        return Err(
            "此表存在触发器或外键关联，不能保证只修改本表；请使用经过核对的恢复方式".into(),
        );
    }
    let automatic: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND lower(EXTRA) LIKE '%on update%'")
        .bind(d).bind(t).fetch_one(&mut *connection).await.map_err(|e| e.to_string())?;
    if automatic > 0 {
        return Err("此表含自动更新字段，现有历史无法完整还原这些字段；请使用快照".into());
    }
    Ok(())
}
async fn validate_table(pool: &MySqlPool, d: &str, t: &str) -> Result<TableMeta, String> {
    let mut connection = pool.acquire().await.map_err(|e| e.to_string())?;
    validate_features(&mut connection, d, t).await?;
    drop(connection);
    db::read_schema(pool, d, t).await
}
// The full-table SELECT holds a metadata lock now. Recheck on this same
// connection so a DDL/trigger change between discovery and locking cannot leak
// side effects into another table, or hide newly added columns from guards.
async fn validate_locked_schema(
    tx: &mut Transaction<'_, MySql>,
    d: &str,
    t: &str,
    table: &TableMeta,
) -> Result<(), String> {
    validate_features(&mut **tx, d, t).await?;
    let columns = sqlx::query(
        "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, GENERATION_EXPRESSION \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",
    )
    .bind(d)
    .bind(t)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if columns.len() != table.columns.len() {
        return Err("读取期间表结构已变化，请重新预览；本次未修改数据".into());
    }
    for (actual, expected) in columns.iter().zip(&table.columns) {
        let column_name = mysql_text::string(actual, "COLUMN_NAME")
            .map_err(|e| format!("读取锁定表结构失败: {e}"))?;
        let column_type = mysql_text::string(actual, "COLUMN_TYPE")
            .map_err(|e| format!("读取锁定表结构失败: {e}"))?;
        let is_nullable = mysql_text::string(actual, "IS_NULLABLE")
            .map_err(|e| format!("读取锁定表结构失败: {e}"))?
            == "YES";
        let is_primary_key = mysql_text::string(actual, "COLUMN_KEY")
            .map_err(|e| format!("读取锁定表结构失败: {e}"))?
            == "PRI";
        let is_generated = mysql_text::optional_string(actual, "GENERATION_EXPRESSION")
            .map_err(|e| format!("读取锁定表结构失败: {e}"))?
            .is_some_and(|value| !value.trim().is_empty());
        if column_name != expected.column_name
            || column_type != expected.column_type
            || is_nullable != expected.is_nullable
            || is_primary_key != expected.is_primary_key
            || is_generated != expected.is_generated
        {
            return Err("读取期间表结构已变化，请重新预览；本次未修改数据".into());
        }
    }
    Ok(())
}
async fn fingerprint(
    tx: &mut Transaction<'_, MySql>,
    d: &str,
    t: &str,
    table: &TableMeta,
) -> Result<String, String> {
    let projection = table
        .columns
        .iter()
        .map(|c| {
            format!(
                "HEX(CAST(`{}` AS BINARY))",
                db::escape_ident(&c.column_name)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let rows = sqlx::query(&format!(
        "SELECT {projection} FROM {} FOR UPDATE",
        db::qualified_table(d, t)
    ))
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| format!("读取并锁定表失败: {e}"))?;
    let mut hashes = Vec::with_capacity(rows.len());
    for row in rows {
        let mut values = Vec::<Option<String>>::new();
        for i in 0..table.columns.len() {
            values.push(
                mysql_text::optional_string(&row, i).map_err(|e| format!("读取字段失败: {e}"))?,
            );
        }
        hashes.push(digest(
            &serde_json::to_vec(&values).map_err(|e| e.to_string())?,
        ));
    }
    hashes.sort();
    let ddl_row = sqlx::query(&format!("SHOW CREATE TABLE {}", db::qualified_table(d, t)))
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    let ddl = mysql_text::string(&ddl_row, "Create Table")
        .or_else(|_| mysql_text::string(&ddl_row, 1))
        .map_err(|e| format!("读取表结构 DDL 失败: {e}"))?;
    // AUTO_INCREMENT is an allocation counter, not table data, and MySQL does
    // not roll it back. Exclude only that table option from the schema hash.
    let ddl = ddl
        .split_whitespace()
        .filter(|s| !s.starts_with("AUTO_INCREMENT="))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(digest(
        &serde_json::to_vec(&(ddl, hashes)).map_err(|e| e.to_string())?,
    ))
}
async fn locked_transaction(pool: &MySqlPool) -> Result<Transaction<'static, MySql>, String> {
    let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
    // Session overrides must never leak back to ordinary editing connections.
    conn.close_on_drop();
    crate::table_design_validation::configure_strict_session(&mut conn).await?;
    sqlx::query("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_AUTO_VALUE_ON_ZERO')")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Transaction::begin(conn, None)
        .await
        .map_err(|e| e.to_string())
}
async fn settle_job(
    pool: &SqlitePool,
    id: &str,
    ids: &[i64],
    committed: bool,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for audit_id in ids {
        let result = sqlx::query("UPDATE audit_log SET status=? WHERE id=?")
            .bind(if committed { "committed" } else { "aborted" })
            .bind(audit_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        if result.rows_affected() != 1 {
            return Err("恢复审计记录缺失，提交结果仍待核对".into());
        }
    }
    sqlx::query("UPDATE audit_restore_jobs SET status=? WHERE id=?")
        .bind(if committed { "committed" } else { "aborted" })
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())
}
async fn reconcile(pool: &SqlitePool, r: &HistoryRequest, current: &str) -> Result<(), String> {
    let (c, d, t) = r.target()?;
    sqlx::query("UPDATE audit_log SET status='aborted' WHERE connection_id=? AND database=? AND table_name=? AND source='rollback' AND status='pending' AND operation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM audit_restore_jobs, json_each(audit_restore_jobs.audit_ids) WHERE json_each.value=audit_log.id)")
        .bind(c).bind(d).bind(t).execute(pool).await.map_err(|e|e.to_string())?;
    let rows=sqlx::query("SELECT * FROM audit_restore_jobs WHERE connection_id=? AND database=? AND table_name=? AND status='prepared'").bind(c).bind(d).bind(t).fetch_all(pool).await.map_err(|e|e.to_string())?;
    for row in rows {
        let before: String = row.get("before_hash");
        let after: String = row.get("after_hash");
        let ids: Vec<i64> =
            serde_json::from_str(&row.get::<String, _>("audit_ids")).map_err(|e| e.to_string())?;
        if current != before && current != after {
            return Err(format!(
                "恢复任务 {} 的提交结果仍待核对，已阻止再次恢复",
                row.get::<String, _>("id")
            ));
        }
        settle_job(pool, &row.get::<String, _>("id"), &ids, current == after).await?;
    }
    Ok(())
}
fn preview(
    entries: &[AuditEntry],
    ts: String,
    operations: usize,
    current: &str,
) -> Result<RestorePreview, String> {
    Ok(RestorePreview {
        token: digest(&serde_json::to_vec(&(current, entries)).map_err(|e| e.to_string())?),
        target_ts: ts,
        operations,
        inserted: entries.iter().filter(|e| e.operation == "DELETE").count(),
        updated: entries.iter().filter(|e| e.operation == "UPDATE").count(),
        deleted: entries.iter().filter(|e| e.operation == "INSERT").count(),
        entries: entries.len(),
    })
}
#[tauri::command]
pub async fn preview_audit_table_restore(
    request: HistoryRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RestorePreview, String> {
    let (c, d, t) = request.target()?;
    let pool = crate::commands::real_database_pool(c, d, &state, &perf_context).await?;
    let audit_pool = audit::ensure_audit_pool(&app, &state).await?;
    let table = validate_table(&pool, d, t).await?;
    let mut tx = locked_transaction(&pool).await?;
    let current = fingerprint(&mut tx, d, t, &table).await?;
    validate_locked_schema(&mut tx, d, t, &table).await?;
    reconcile(&audit_pool, &request, &current).await?;
    let (entries, ts, count) = history(&audit_pool, &request).await?;
    for e in &entries {
        reverse_plan(e, &table)?;
    }
    let result = preview(&entries, ts, count, &current)?;
    tx.rollback().await.map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn restore_audit_table(
    request: HistoryRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (c, d, t) = request.target()?;
    let pool = crate::commands::real_database_pool(c, d, &state, &perf_context).await?;
    let audit_pool = audit::ensure_audit_pool(&app, &state).await?;
    let table = validate_table(&pool, d, t).await?;
    let mut tx = locked_transaction(&pool).await?;
    let before = fingerprint(&mut tx, d, t, &table).await?;
    validate_locked_schema(&mut tx, d, t, &table).await?;
    reconcile(&audit_pool, &request, &before).await?;
    let (entries, ts, count) = history(&audit_pool, &request).await?;
    let expected = preview(&entries, ts, count, &before)?;
    if request.token.as_deref() != Some(&expected.token) {
        return Err("预览后数据或历史已变化，请重新预览；本次未修改数据".into());
    }
    let mut plans = Vec::new();
    for entry in &entries {
        let mut plan = reverse_plan(entry, &table)?;
        // Capture complete before-image for undoing INSERT, including defaults
        // absent from the original draft. Generated columns are not writable.
        if plan.operation == "DELETE" {
            let columns = table
                .columns
                .iter()
                .filter(|c| !c.is_generated)
                .map(|c| c.column_name.clone())
                .collect::<Vec<_>>();
            let projection = columns
                .iter()
                .map(|c| format!("CAST(`{}` AS CHAR)", db::escape_ident(c)))
                .collect::<Vec<_>>()
                .join(",");
            let where_part = plan
                .forward_sql
                .split_once(" WHERE ")
                .ok_or("删除恢复语句无有效行条件")?
                .1;
            let select_sql = format!(
                "SELECT {projection} FROM {} WHERE {where_part}",
                db::qualified_table(d, t)
            );
            let mut q = sqlx::query(&select_sql);
            for b in &plan.forward_binds {
                q = q.bind(b);
            }
            let row = q
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?
                .ok_or("目标行与历史不一致，整次恢复已取消")?;
            let mut full = RowIdentity::new();
            for (i, col) in columns.iter().enumerate() {
                full.insert(
                    col.clone(),
                    mysql_text::optional_string(&row, i)
                        .map_err(|e| format!("读取删除行字段失败: {e}"))?,
                );
            }
            let (sql, binds) = audit::build_delete_inverse(
                d,
                t,
                &columns,
                &audit::preimage_vector(&columns, &full),
            );
            plan.inverse_sql = Some(sql);
            plan.inverse_binds = binds;
            plan.old_value = Some(serde_json::to_string(&full).map_err(|e| e.to_string())?);
        }
        let mut query = sqlx::query(&plan.forward_sql);
        for bind in &plan.forward_binds {
            query = query.bind(bind);
        }
        let result = query
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("历史数据冲突，整次恢复已取消: {e}"))?;
        if result.rows_affected() != 1 {
            return Err("目标行与历史不一致，整次恢复已取消".into());
        }
        plans.push(plan);
    }
    // Audit history must also be unchanged while replaying, e.g. a queued edit
    // can add pending records even while MySQL is locked by this transaction.
    let (check, ts, count) = history(&audit_pool, &request).await?;
    if preview(&check, ts, count, &before)?.token != expected.token {
        return Err("恢复期间出现新操作，请重新预览；本次未修改数据".into());
    }
    let after = fingerprint(&mut tx, d, t, &table).await?;
    let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
    let ctx = audit::AuditContext {
        connection_id: c.into(),
        database: d.into(),
        table_name: t.into(),
        session_id: None,
        source: audit::SOURCE_ROLLBACK,
        actor,
        client_id,
    };
    let ids = audit::record_pending_batch(&audit_pool, &ctx, &plans).await?;
    let job_id = uuid::Uuid::new_v4().to_string();
    let journal=sqlx::query("INSERT INTO audit_restore_jobs(id,connection_id,database,table_name,before_hash,after_hash,audit_ids,status) VALUES(?,?,?,?,?,?,?,'prepared')")
        .bind(&job_id).bind(c).bind(d).bind(t).bind(&before).bind(&after).bind(serde_json::to_string(&ids).map_err(|e|e.to_string())?).execute(&audit_pool).await;
    if let Err(e) = journal {
        let _ = audit::mark_aborted_required_batch(&audit_pool, &ids).await;
        return Err(format!("保存恢复核对记录失败，本次已取消: {e}"));
    }
    if let Err(e) = tx.commit().await {
        return Err(format!(
            "恢复任务 {job_id} 提交结果待核对，请重新预览以核对，不能视为成功: {e}"
        ));
    }
    crate::commands::invalidate_table_count(&state, c, d, t);
    crate::table_modified::record_local_change(&app, &state, c, d, &[t]).await;
    let _ = app.emit(
        audit::BACKUP_JOB_EVENT,
        serde_json::json!({"kind":"restore","connectionId":c,"database":d,"table":t}),
    );
    settle_job(&audit_pool, &job_id, &ids, true)
        .await
        .map_err(|e| {
            format!("数据已恢复，但审计状态待核对（任务 {job_id}）；请重新预览核对: {e}")
        })?;
    crate::audit_sync::trigger_immediate_sync(&app);
    Ok("已恢复到所选操作之前".into())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRestoreOp {
    pub kind: String,
    pub row_identity: RowIdentity,
    #[serde(default)]
    pub expected_current: RowIdentity,
    #[serde(default)]
    pub target_values: RowIdentity,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStateRestoreRequest {
    pub connection_id: String,
    pub database: String,
    pub table_name: String,
    #[serde(default)]
    pub target_label: Option<String>,
    pub operations: Vec<HistoryRestoreOp>,
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStateRestorePreview {
    pub token: String,
    pub inserted: usize,
    pub updated: usize,
    pub deleted: usize,
    pub total: usize,
}

fn validate_history_restore_target(
    request: &HistoryStateRestoreRequest,
) -> Result<(&str, &str, &str), String> {
    let c = request.connection_id.trim();
    let d = request.database.trim();
    let t = request.table_name.trim();
    if c.is_empty() || d.is_empty() || t.is_empty() {
        return Err("请选择连接、数据库和表".into());
    }
    if request.operations.is_empty() {
        return Err("没有需要还原的数据变更".into());
    }
    Ok((c, d, t))
}

fn build_history_restore_plan(
    op: &HistoryRestoreOp,
    database: &str,
    table_name: &str,
    table: &TableMeta,
    target_label: Option<&str>,
) -> Result<(PendingAudit, usize), String> {
    let known: HashSet<&str> = table
        .columns
        .iter()
        .map(|c| c.column_name.as_str())
        .collect();
    let generated: HashSet<&str> = table
        .columns
        .iter()
        .filter(|c| c.is_generated)
        .map(|c| c.column_name.as_str())
        .collect();
    let pk_columns: Vec<&str> = table
        .columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| c.column_name.as_str())
        .collect();
    if pk_columns.is_empty() {
        return Err("该表未设置主键，无法按行精准还原".into());
    }
    if op.row_identity.is_empty()
        || op.row_identity.keys().any(|k| !known.contains(k.as_str()))
        || pk_columns
            .iter()
            .any(|pk| !op.row_identity.contains_key(*pk))
    {
        return Err("还原操作缺少完整主键标识，不能还原".into());
    }

    let json_columns: HashSet<String> = table
        .columns
        .iter()
        .filter(|c| c.column_type.to_lowercase().contains("json"))
        .map(|c| c.column_name.clone())
        .collect();
    let note = target_label
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|label| format!("从修改记录还原到 {label}"))
        .unwrap_or_else(|| "从修改记录还原".into());

    match op.kind.as_str() {
        "update" => {
            if op.target_values.is_empty()
                || op.target_values.len() != op.expected_current.len()
                || op
                    .target_values
                    .keys()
                    .any(|k| !op.expected_current.contains_key(k))
            {
                return Err("还原字段的前后值不完整，不能还原".into());
            }
            if op
                .target_values
                .keys()
                .any(|k| !known.contains(k.as_str()) || generated.contains(k.as_str()))
            {
                return Err("表结构与历史记录不一致，不能还原".into());
            }
            let mut keys: Vec<String> = op.target_values.keys().cloned().collect();
            keys.sort();
            let changes: Vec<CellUpdateChange> = keys
                .iter()
                .map(|k| CellUpdateChange {
                    column_name: k.clone(),
                    old_value: op.expected_current[k].clone(),
                    new_value: op.target_values[k].clone(),
                })
                .collect();
            let set_bind_count = changes
                .iter()
                .filter(|c| c.old_value != c.new_value && c.new_value.is_some())
                .count();
            let (forward_sql, forward_binds, inverse_sql, inverse_binds) =
                audit::build_row_update_inverse(
                    database,
                    table_name,
                    &op.row_identity,
                    &changes,
                    &json_columns,
                )?;
            let (column_name, old_value, new_value) = if changes.len() == 1 {
                (
                    Some(changes[0].column_name.clone()),
                    changes[0].old_value.clone(),
                    changes[0].new_value.clone(),
                )
            } else {
                let old_map: serde_json::Map<String, serde_json::Value> = keys
                    .iter()
                    .map(|k| {
                        let v = op.expected_current[k]
                            .as_ref()
                            .map(|s| serde_json::Value::String(s.clone()))
                            .unwrap_or(serde_json::Value::Null);
                        (k.clone(), v)
                    })
                    .collect();
                let new_map: serde_json::Map<String, serde_json::Value> = keys
                    .iter()
                    .map(|k| {
                        let v = op.target_values[k]
                            .as_ref()
                            .map(|s| serde_json::Value::String(s.clone()))
                            .unwrap_or(serde_json::Value::Null);
                        (k.clone(), v)
                    })
                    .collect();
                (
                    None,
                    Some(serde_json::Value::Object(old_map).to_string()),
                    Some(serde_json::Value::Object(new_map).to_string()),
                )
            };
            Ok((
                PendingAudit {
                    operation: "UPDATE",
                    column_name,
                    old_value,
                    new_value,
                    row_identity: Some(
                        serde_json::to_value(&op.row_identity).map_err(|e| e.to_string())?,
                    ),
                    forward_sql: exact_text_guards(forward_sql, table),
                    forward_binds,
                    inverse_sql: Some(exact_text_guards(inverse_sql, table)),
                    inverse_binds,
                    rollback_strategy: audit::STRATEGY_AUTO,
                    notes: Some(note),
                },
                set_bind_count,
            ))
        }
        "delete" => {
            let mut guard = RowIdentity::new();
            for (k, v) in &op.expected_current {
                if known.contains(k.as_str())
                    && !generated.contains(k.as_str())
                    && !json_columns.contains(k)
                {
                    guard.insert(k.clone(), v.clone());
                }
            }
            for (k, v) in &op.row_identity {
                guard.insert(k.clone(), v.clone());
            }
            let (del_sql, del_binds) =
                audit::build_delete_forward_nullable(database, table_name, &guard)?;
            let mut columns: Vec<String> = table
                .columns
                .iter()
                .filter(|c| !c.is_generated)
                .map(|c| c.column_name.clone())
                .collect();
            columns.sort();
            let (ins_sql, ins_binds) = audit::build_delete_inverse(
                database,
                table_name,
                &columns,
                &audit::preimage_vector(&columns, &guard),
            );
            Ok((
                PendingAudit {
                    operation: "DELETE",
                    column_name: None,
                    old_value: Some(serde_json::to_string(&guard).map_err(|e| e.to_string())?),
                    new_value: None,
                    row_identity: Some(
                        serde_json::to_value(&op.row_identity).map_err(|e| e.to_string())?,
                    ),
                    forward_sql: exact_text_guards(del_sql, table),
                    forward_binds: del_binds,
                    inverse_sql: Some(ins_sql),
                    inverse_binds: ins_binds,
                    rollback_strategy: audit::STRATEGY_AUTO,
                    notes: Some(note),
                },
                0,
            ))
        }
        "insert" => {
            let mut columns: Vec<String> = table
                .columns
                .iter()
                .filter(|c| !c.is_generated)
                .map(|c| c.column_name.clone())
                .collect();
            columns.sort();
            if columns
                .iter()
                .any(|c| !op.target_values.contains_key(c.as_str()))
            {
                return Err("历史删除记录未保存完整字段值，无法安全还原；请查看快照".into());
            }
            if op
                .target_values
                .keys()
                .any(|k| !known.contains(k.as_str()) || generated.contains(k.as_str()))
            {
                return Err("表结构与历史记录不一致，不能还原".into());
            }
            let mut full_row = RowIdentity::new();
            for col in &columns {
                full_row.insert(
                    col.clone(),
                    op.target_values.get(col).cloned().unwrap_or(None),
                );
            }
            let (ins_sql, ins_binds) = audit::build_delete_inverse(
                database,
                table_name,
                &columns,
                &audit::preimage_vector(&columns, &full_row),
            );
            let (del_sql, del_binds) =
                audit::build_delete_forward_nullable(database, table_name, &op.row_identity)?;
            Ok((
                PendingAudit {
                    operation: "INSERT",
                    column_name: None,
                    old_value: None,
                    new_value: Some(serde_json::to_string(&full_row).map_err(|e| e.to_string())?),
                    row_identity: Some(
                        serde_json::to_value(&op.row_identity).map_err(|e| e.to_string())?,
                    ),
                    forward_sql: ins_sql,
                    forward_binds: ins_binds,
                    inverse_sql: Some(exact_text_guards(del_sql, table)),
                    inverse_binds: del_binds,
                    rollback_strategy: audit::STRATEGY_AUTO,
                    notes: Some(note),
                },
                0,
            ))
        }
        _ => Err("不支持的还原操作类型".into()),
    }
}

async fn verify_history_restore_op_in_tx(
    tx: &mut Transaction<'_, MySql>,
    database: &str,
    table_name: &str,
    table: &TableMeta,
    op: &HistoryRestoreOp,
    plan: &PendingAudit,
    set_bind_count: usize,
) -> Result<(), String> {
    match op.kind.as_str() {
        "update" | "delete" => {
            let where_part = plan
                .forward_sql
                .split_once(" WHERE ")
                .ok_or("还原语句缺少行条件")?
                .1;
            let where_clean = where_part
                .strip_suffix(" LIMIT 1")
                .unwrap_or(where_part);
            let sql = format!(
                "SELECT COUNT(*) FROM {} WHERE {where_clean}",
                db::qualified_table(database, table_name)
            );
            let mut query = sqlx::query_scalar::<_, i64>(&sql);
            for bind in plan.forward_binds.iter().skip(set_bind_count) {
                query = query.bind(bind);
            }
            let matched = query
                .fetch_one(&mut **tx)
                .await
                .map_err(|e| format!("校验还原目标行失败: {e}"))?;
            if matched != 1 {
                return Err(
                    "目标行当前值与历史记录不一致（可能已被其他工具或成员修改），无法直接还原"
                        .into(),
                );
            }
        }
        "insert" => {
            let (del_sql, del_binds) =
                audit::build_delete_forward_nullable(database, table_name, &op.row_identity)?;
            let guarded = exact_text_guards(del_sql, table);
            let where_part = guarded
                .split_once(" WHERE ")
                .ok_or("主键校验条件无效")?
                .1;
            let where_clean = where_part
                .strip_suffix(" LIMIT 1")
                .unwrap_or(where_part);
            let sql = format!(
                "SELECT COUNT(*) FROM {} WHERE {where_clean}",
                db::qualified_table(database, table_name)
            );
            let mut query = sqlx::query_scalar::<_, i64>(&sql);
            for bind in &del_binds {
                query = query.bind(bind);
            }
            let existing = query
                .fetch_one(&mut **tx)
                .await
                .map_err(|e| format!("校验还原主键失败: {e}"))?;
            if existing != 0 {
                return Err("目标主键行当前已存在，无法重新插入；请刷新后再试".into());
            }
        }
        _ => return Err("不支持的还原操作类型".into()),
    }
    Ok(())
}

fn summarize_history_restore(
    operations: &[HistoryRestoreOp],
    current_fingerprint: &str,
) -> Result<HistoryStateRestorePreview, String> {
    let token = digest(
        &serde_json::to_vec(&(current_fingerprint, operations)).map_err(|e| e.to_string())?,
    );
    let inserted = operations.iter().filter(|op| op.kind == "insert").count();
    let updated = operations.iter().filter(|op| op.kind == "update").count();
    let deleted = operations.iter().filter(|op| op.kind == "delete").count();
    Ok(HistoryStateRestorePreview {
        token,
        inserted,
        updated,
        deleted,
        total: operations.len(),
    })
}

#[tauri::command]
pub async fn preview_history_state_restore(
    request: HistoryStateRestoreRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<HistoryStateRestorePreview, String> {
    let (c, d, t) = validate_history_restore_target(&request)?;
    let pool = crate::commands::real_database_pool(c, d, &state, &perf_context).await?;
    let audit_pool = audit::ensure_audit_pool(&app, &state).await?;
    let table = validate_table(&pool, d, t).await?;
    let mut tx = locked_transaction(&pool).await?;
    let current = fingerprint(&mut tx, d, t, &table).await?;
    validate_locked_schema(&mut tx, d, t, &table).await?;
    let scope_req = HistoryRequest {
        connection_id: Some(c.into()),
        database: Some(d.into()),
        table_name: Some(t.into()),
        search: None,
        offset: None,
        audit_id: None,
        token: None,
    };
    reconcile(&audit_pool, &scope_req, &current).await?;
    for op in &request.operations {
        let (plan, set_bind_count) =
            build_history_restore_plan(op, d, t, &table, request.target_label.as_deref())?;
        verify_history_restore_op_in_tx(&mut tx, d, t, &table, op, &plan, set_bind_count).await?;
    }
    let result = summarize_history_restore(&request.operations, &current)?;
    tx.rollback().await.map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn apply_history_state_restore(
    request: HistoryStateRestoreRequest,
    perf_context: PerfContext,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (c, d, t) = validate_history_restore_target(&request)?;
    let pool = crate::commands::real_database_pool(c, d, &state, &perf_context).await?;
    let audit_pool = audit::ensure_audit_pool(&app, &state).await?;
    let table = validate_table(&pool, d, t).await?;
    let mut tx = locked_transaction(&pool).await?;
    let before = fingerprint(&mut tx, d, t, &table).await?;
    validate_locked_schema(&mut tx, d, t, &table).await?;
    let scope_req = HistoryRequest {
        connection_id: Some(c.into()),
        database: Some(d.into()),
        table_name: Some(t.into()),
        search: None,
        offset: None,
        audit_id: None,
        token: None,
    };
    reconcile(&audit_pool, &scope_req, &before).await?;
    let expected = summarize_history_restore(&request.operations, &before)?;
    if request.token.as_deref() != Some(&expected.token) {
        return Err("预览后表数据已变化，请重新预览；本次未修改数据".into());
    }

    let mut plans = Vec::with_capacity(request.operations.len());
    for op in &request.operations {
        let (mut plan, _) =
            build_history_restore_plan(op, d, t, &table, request.target_label.as_deref())?;
        if plan.operation == "DELETE" {
            let columns: Vec<String> = table
                .columns
                .iter()
                .filter(|col| !col.is_generated)
                .map(|col| col.column_name.clone())
                .collect();
            let projection = columns
                .iter()
                .map(|col| format!("CAST(`{}` AS CHAR)", db::escape_ident(col)))
                .collect::<Vec<_>>()
                .join(",");
            let where_part = plan
                .forward_sql
                .split_once(" WHERE ")
                .ok_or("删除还原语句无有效行条件")?
                .1;
            let select_sql = format!(
                "SELECT {projection} FROM {} WHERE {where_part}",
                db::qualified_table(d, t)
            );
            let mut q = sqlx::query(&select_sql);
            for b in &plan.forward_binds {
                q = q.bind(b);
            }
            let row = q
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?
                .ok_or("目标行当前值与历史不一致，整次还原已取消")?;
            let mut full = RowIdentity::new();
            for (i, col) in columns.iter().enumerate() {
                full.insert(
                    col.clone(),
                    mysql_text::optional_string(&row, i)
                        .map_err(|e| format!("读取删除行字段失败: {e}"))?,
                );
            }
            let (sql, binds) = audit::build_delete_inverse(
                d,
                t,
                &columns,
                &audit::preimage_vector(&columns, &full),
            );
            plan.inverse_sql = Some(sql);
            plan.inverse_binds = binds;
            plan.old_value = Some(serde_json::to_string(&full).map_err(|e| e.to_string())?);
        }
        let mut query = sqlx::query(&plan.forward_sql);
        for bind in &plan.forward_binds {
            query = query.bind(bind);
        }
        let result = query
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("还原数据冲突，整次还原已取消: {e}"))?;
        if result.rows_affected() != 1 {
            return Err("目标行当前值与历史不一致，整次还原已取消".into());
        }
        plans.push(plan);
    }

    let after = fingerprint(&mut tx, d, t, &table).await?;
    let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
    let ctx = audit::AuditContext {
        connection_id: c.into(),
        database: d.into(),
        table_name: t.into(),
        session_id: None,
        source: audit::SOURCE_ROLLBACK,
        actor,
        client_id,
    };
    let ids = audit::record_pending_batch(&audit_pool, &ctx, &plans).await?;
    let job_id = uuid::Uuid::new_v4().to_string();
    let journal = sqlx::query(
        "INSERT INTO audit_restore_jobs(id,connection_id,database,table_name,before_hash,after_hash,audit_ids,status) VALUES(?,?,?,?,?,?,?,'prepared')",
    )
    .bind(&job_id)
    .bind(c)
    .bind(d)
    .bind(t)
    .bind(&before)
    .bind(&after)
    .bind(serde_json::to_string(&ids).map_err(|e| e.to_string())?)
    .execute(&audit_pool)
    .await;
    if let Err(e) = journal {
        let _ = audit::mark_aborted_required_batch(&audit_pool, &ids).await;
        return Err(format!("保存还原核对记录失败，本次已取消: {e}"));
    }
    if let Err(e) = tx.commit().await {
        return Err(format!(
            "还原任务 {job_id} 提交结果待核对，请重新预览核对，不能视为成功: {e}"
        ));
    }
    crate::commands::invalidate_table_count(&state, c, d, t);
    crate::table_modified::record_local_change(&app, &state, c, d, &[t]).await;
    let _ = app.emit(
        audit::BACKUP_JOB_EVENT,
        serde_json::json!({"kind":"restore","connectionId":c,"database":d,"table":t}),
    );
    settle_job(&audit_pool, &job_id, &ids, true)
        .await
        .map_err(|e| {
            format!("数据已还原，但审计状态待核对（任务 {job_id}）；请重新预览核对: {e}")
        })?;
    crate::audit_sync::trigger_immediate_sync(&app);
    Ok(match request.target_label.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(label) => format!("已还原到 {label}"),
        None => "已还原到所选历史状态".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{audit_history, types::ColumnMeta};
    async fn fixture() -> (SqlitePool, HistoryRequest, Vec<i64>) {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        audit::ensure_schema(&pool).await.unwrap();
        let context = audit::AuditContext {
            connection_id: "one".into(),
            database: "db".into(),
            table_name: "items".into(),
            session_id: None,
            source: audit::SOURCE_IMPORT,
            actor: None,
            client_id: "sync-id".into(),
        };
        let pending = PendingAudit {
            operation: "UPDATE",
            column_name: Some("value".into()),
            old_value: Some("old".into()),
            new_value: Some("new".into()),
            row_identity: Some(serde_json::json!({"id":"1"})),
            forward_sql: "forward".into(),
            forward_binds: vec![],
            inverse_sql: Some("inverse".into()),
            inverse_binds: vec![],
            rollback_strategy: "auto",
            notes: None,
        };
        let ids = audit::record_pending_batch(&pool, &context, &vec![pending; 1001])
            .await
            .unwrap();
        audit::mark_committed_required_batch(&pool, &ids)
            .await
            .unwrap();
        let request = HistoryRequest {
            connection_id: Some("one".into()),
            database: Some("db".into()),
            table_name: Some("items".into()),
            search: None,
            offset: None,
            audit_id: Some(ids[0]),
            token: None,
        };
        (pool, request, ids)
    }
    fn schema() -> TableMeta {
        TableMeta {
            table_name: "items".into(),
            table_comment: "".into(),
            primary_key_order: vec!["id".into()],
            columns: vec![
                ColumnMeta::with_basic("id", "varchar(32)", "", true, false),
                ColumnMeta::with_basic("value", "text", "", false, true),
            ],
        }
    }
    #[tokio::test]
    async fn complete_history_and_pages_are_not_limited_to_200() {
        let (pool, r, ids) = fixture().await;
        let result = audit_history::tables(&pool, &r).await.unwrap();
        assert_eq!(result.items[0].entry_count, 1001);
        let ops = audit_history::operations(&pool, &r).await.unwrap();
        assert_eq!(ops.items.len(), 1);
        assert_eq!(ops.items[0].entry_count, 1001);
        let details = audit_history::details(&pool, &r).await.unwrap();
        assert_eq!(details.items.len(), 50);
        assert!(details.has_more);
        let (entries, _, count) = history(&pool, &r).await.unwrap();
        assert_eq!(entries.len(), 1001);
        assert_eq!(count, 1);
        assert_eq!(entries[0].id, *ids.last().unwrap());
        sqlx::query("DELETE FROM audit_log WHERE id=?")
            .bind(ids[500])
            .execute(&pool)
            .await
            .unwrap();
        assert!(history(&pool, &r).await.unwrap_err().contains("缺失"));
    }
    #[tokio::test]
    async fn same_timestamp_different_operations_and_legacy_boundaries() {
        let (pool, r, ids) = fixture().await;
        sqlx::query("UPDATE audit_log SET operation_id=NULL,operation_size=NULL,ts='same'")
            .execute(&pool)
            .await
            .unwrap();
        let mut middle = r.clone();
        middle.audit_id = Some(ids[500]);
        assert_eq!(history(&pool, &middle).await.unwrap().0.len(), 1001);
        let legacy = audit_history::operations(&pool, &r).await.unwrap();
        assert!(legacy.items[0].legacy);
        sqlx::query("UPDATE audit_log SET operation_id=CASE WHEN id<501 THEN 'a' ELSE 'b' END,operation_size=CASE WHEN id<501 THEN 500 ELSE 501 END").execute(&pool).await.unwrap();
        assert_eq!(
            audit_history::operations(&pool, &r)
                .await
                .unwrap()
                .items
                .len(),
            2
        );
        assert_eq!(history(&pool, &middle).await.unwrap().0.len(), 501);
    }
    #[tokio::test]
    async fn incomplete_pending_ddl_and_manual_entries_block_restoration() {
        for (column, value) in [
            ("status", "pending"),
            ("rollback_strategy", "manual"),
            ("source", "ddl"),
        ] {
            let (pool, r, ids) = fixture().await;
            sqlx::query(&format!("UPDATE audit_log SET {column}=? WHERE id=?"))
                .bind(value)
                .bind(ids[500])
                .execute(&pool)
                .await
                .unwrap();
            assert!(history(&pool, &r).await.is_err());
        }
    }
    #[tokio::test]
    async fn rolled_back_original_and_inverse_both_participate() {
        let (pool, r, ids) = fixture().await;
        sqlx::query("UPDATE audit_log SET status='rolled_back' WHERE id=?")
            .bind(ids[0])
            .execute(&pool)
            .await
            .unwrap();
        let original = audit::fetch_audit_entry(&pool, ids[0]).await.unwrap();
        let ctx = audit::AuditContext {
            connection_id: "one".into(),
            database: "db".into(),
            table_name: "items".into(),
            session_id: None,
            source: audit::SOURCE_ROLLBACK,
            actor: None,
            client_id: "rollback-sync".into(),
        };
        let rollback = audit::record_rollback(&pool, &ctx, &original, "inverse", &[]).await;
        // record_rollback has no side effects outside SQLite.
        assert!(rollback.is_ok());
        let (entries, _, _) = history(&pool, &r).await.unwrap();
        assert_eq!(entries.len(), 1002);
        assert_eq!(entries[0].old_value.as_deref(), Some("new"));
        assert_eq!(entries[0].new_value.as_deref(), Some("old"));
    }
    #[tokio::test]
    async fn reconciliation_never_guesses_an_unknown_commit_outcome() {
        let (pool, r, ids) = fixture().await;
        audit::mark_aborted_required_batch(&pool, &ids)
            .await
            .unwrap();
        sqlx::query("UPDATE audit_log SET status='pending' WHERE id=?")
            .bind(ids[0])
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO audit_restore_jobs VALUES('job','one','db','items','before','after',?,'prepared')").bind(serde_json::to_string(&vec![ids[0]]).unwrap()).execute(&pool).await.unwrap();
        assert!(reconcile(&pool, &r, "unknown").await.is_err());
        assert_eq!(
            audit::fetch_audit_entry(&pool, ids[0])
                .await
                .unwrap()
                .status,
            "pending"
        );
        reconcile(&pool, &r, "after").await.unwrap();
        assert_eq!(
            audit::fetch_audit_entry(&pool, ids[0])
                .await
                .unwrap()
                .status,
            "committed"
        );
    }
    #[tokio::test]
    async fn inverse_plans_preserve_null_empty_and_primary_key_changes() {
        let (pool, _, ids) = fixture().await;
        let mut e = audit::fetch_audit_entry(&pool, ids[0]).await.unwrap();
        e.column_name = None;
        e.old_value = Some(r#"{"id":"1","value":null}"#.into());
        e.new_value = Some(r#"{"id":"2","value":""}"#.into());
        let plan = reverse_plan(&e, &schema()).unwrap();
        assert_eq!(plan.row_identity.unwrap()["id"], "2");
        assert!(plan.forward_sql.contains("`value` = NULL"));
        assert!(plan.forward_binds.contains(&String::new()));
        e.operation = "INSERT".into();
        e.new_value = Some(r#"{"id":"1"}"#.into());
        assert!(reverse_plan(&e, &schema())
            .unwrap_err()
            .contains("完整字段"));
    }
    #[tokio::test]
    async fn settlement_failure_preserves_pending_status_and_journal() {
        let (pool, r, ids) = fixture().await;
        sqlx::query("UPDATE audit_log SET status='pending' WHERE id IN (?,?)")
            .bind(ids[0])
            .bind(ids[1])
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO audit_restore_jobs VALUES('job','one','db','items','before','after',?,'prepared')")
            .bind(serde_json::to_string(&vec![ids[0],ids[1]]).unwrap()).execute(&pool).await.unwrap();
        sqlx::query("CREATE TRIGGER reject_settle BEFORE UPDATE OF status ON audit_log WHEN NEW.id=2 BEGIN SELECT RAISE(ABORT,'disk failure'); END").execute(&pool).await.unwrap();
        assert!(reconcile(&pool, &r, "after").await.is_err());
        assert_eq!(
            audit::fetch_audit_entry(&pool, ids[0])
                .await
                .unwrap()
                .status,
            "pending"
        );
        let status: String =
            sqlx::query_scalar("SELECT status FROM audit_restore_jobs WHERE id='job'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "prepared");
        sqlx::query("DROP TRIGGER reject_settle")
            .execute(&pool)
            .await
            .unwrap();
        reconcile(&pool, &r, "before").await.unwrap();
        assert_eq!(
            audit::fetch_audit_entry(&pool, ids[0])
                .await
                .unwrap()
                .status,
            "aborted"
        );
    }
    #[tokio::test]
    async fn orphan_restore_audit_is_aborted_before_loading_history() {
        let (pool, r, ids) = fixture().await;
        sqlx::query("UPDATE audit_log SET source='rollback',status='pending' WHERE id=?")
            .bind(ids[0])
            .execute(&pool)
            .await
            .unwrap();
        reconcile(&pool, &r, "current").await.unwrap();
        assert_eq!(
            audit::fetch_audit_entry(&pool, ids[0])
                .await
                .unwrap()
                .status,
            "aborted"
        );
    }
    #[test]
    fn text_guards_are_case_and_whitespace_sensitive_without_changing_set_clause() {
        let sql = "UPDATE `db`.`items` SET `value` = ? WHERE `id` <=> ? AND `value` = ? LIMIT 1"
            .to_string();
        assert_eq!(exact_text_guards(sql,&schema()),"UPDATE `db`.`items` SET `value` = ? WHERE BINARY `id` <=> BINARY ? AND BINARY `value` = BINARY ? LIMIT 1");
    }

    #[test]
    fn history_restore_plan_builds_guarded_update_insert_delete_and_rejects_unsafe_ops() {
        let table = schema();
        let update_op = HistoryRestoreOp {
            kind: "update".into(),
            row_identity: HashMap::from([("id".into(), Some("1".into()))]),
            expected_current: HashMap::from([("value".into(), Some("new".into()))]),
            target_values: HashMap::from([("value".into(), Some("old".into()))]),
        };
        let (plan, set_binds) =
            build_history_restore_plan(&update_op, "db", "items", &table, Some("11-13 修改前"))
                .unwrap();
        assert_eq!(plan.operation, "UPDATE");
        assert_eq!(plan.column_name.as_deref(), Some("value"));
        assert_eq!(plan.old_value.as_deref(), Some("new"));
        assert_eq!(plan.new_value.as_deref(), Some("old"));
        assert_eq!(set_binds, 1);
        assert!(plan.forward_sql.contains("WHERE BINARY `id` <=> BINARY ?"));
        assert!(plan.forward_sql.contains("BINARY `value` = BINARY ?"));

        let insert_op = HistoryRestoreOp {
            kind: "insert".into(),
            row_identity: HashMap::from([("id".into(), Some("2".into()))]),
            expected_current: HashMap::new(),
            target_values: HashMap::from([
                ("id".into(), Some("2".into())),
                ("value".into(), None),
            ]),
        };
        let (ins_plan, _) =
            build_history_restore_plan(&insert_op, "db", "items", &table, None).unwrap();
        assert_eq!(ins_plan.operation, "INSERT");
        assert!(ins_plan.forward_sql.contains("VALUES (?, NULL)"));

        let incomplete_insert = HistoryRestoreOp {
            kind: "insert".into(),
            row_identity: HashMap::from([("id".into(), Some("2".into()))]),
            expected_current: HashMap::new(),
            target_values: HashMap::from([("id".into(), Some("2".into()))]),
        };
        assert!(
            build_history_restore_plan(&incomplete_insert, "db", "items", &table, None)
                .unwrap_err()
                .contains("完整字段")
        );

        let missing_pk_op = HistoryRestoreOp {
            kind: "delete".into(),
            row_identity: HashMap::new(),
            expected_current: HashMap::new(),
            target_values: HashMap::new(),
        };
        assert!(
            build_history_restore_plan(&missing_pk_op, "db", "items", &table, None)
                .unwrap_err()
                .contains("主键")
        );
    }

    #[test]
    fn mysql_metadata_and_text_reads_use_mysql_text_without_panicking_get() {
        let source = include_str!("audit_restore.rs");
        let prod = source
            .split("#[cfg(test)]")
            .next()
            .expect("audit_restore.rs should contain #[cfg(test)]");
        let validate_locked = prod
            .split("async fn validate_locked_schema(")
            .nth(1)
            .and_then(|rest| rest.split("async fn fingerprint(").next())
            .expect("validate_locked_schema should exist");
        assert!(
            !validate_locked.contains(".get::<"),
            "validate_locked_schema must not call panicking Row::get on MySQL 8.4 metadata"
        );
        for column in [
            "COLUMN_NAME",
            "COLUMN_TYPE",
            "IS_NULLABLE",
            "COLUMN_KEY",
            "GENERATION_EXPRESSION",
        ] {
            assert!(
                validate_locked.contains(&format!("mysql_text::string(actual, \"{column}\")"))
                    || validate_locked
                        .contains(&format!("mysql_text::optional_string(actual, \"{column}\")")),
                "validate_locked_schema must decode {column} via mysql_text"
            );
        }

        let validate_features = prod
            .split("async fn validate_features(")
            .nth(1)
            .and_then(|rest| rest.split("async fn validate_table(").next())
            .expect("validate_features should exist");
        assert!(
            validate_features.contains("mysql_text::optional_string"),
            "validate_features must decode ENGINE via mysql_text"
        );

        let fingerprint_fn = prod
            .split("async fn fingerprint(")
            .nth(1)
            .and_then(|rest| rest.split("async fn locked_transaction(").next())
            .expect("fingerprint should exist");
        assert!(
            !fingerprint_fn.contains(".try_get"),
            "fingerprint must decode MySQL 8.4 HEX/DDL text via mysql_text instead of raw try_get"
        );
        assert!(fingerprint_fn.contains("mysql_text::optional_string(&row, i)"));
        assert!(fingerprint_fn.contains("mysql_text::string(&ddl_row, \"Create Table\")"));
    }
}
