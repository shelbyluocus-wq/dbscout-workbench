//! Capture database-applied defaults for INSERT history in bounded reads.
use crate::{
    db,
    types::{RowIdentity, TableMeta},
};
use sqlx::{MySql, Row, SqlitePool, Transaction};
use std::collections::HashMap;

pub async fn capture(
    audit_pool: &SqlitePool,
    tx: &mut Transaction<'_, MySql>,
    database: &str,
    table: &TableMeta,
    identities: &[(i64, HashMap<String, String>)],
) -> Result<(), String> {
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
    let valid = identities
        .iter()
        .filter(|(_, identity)| !identity.is_empty())
        .collect::<Vec<_>>();
    for chunk in valid.chunks(100) {
        let mut parts = Vec::new();
        let mut binds = Vec::new();
        for (id, identity) in chunk {
            let (where_sql, values) = db::build_where(identity)?;
            // id is a trusted SQLite integer, never user SQL.
            parts.push(format!(
                "(SELECT {id}, {projection} FROM {} WHERE {where_sql} LIMIT 1)",
                db::qualified_table(database, &table.table_name)
            ));
            binds.extend(values);
        }
        let sql = parts.join(" UNION ALL ");
        let mut query = sqlx::query(&sql);
        for bind in binds {
            query = query.bind(bind);
        }
        let rows = query
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| format!("读取新增行完整记录失败: {e}"))?;
        if rows.len() != chunk.len() {
            return Err("新增行无法完整定位，本次写入已取消".into());
        }
        let mut images = Vec::new();
        for row in rows {
            let id: i64 = row.try_get(0).map_err(|e| e.to_string())?;
            let mut values = RowIdentity::new();
            for (i, col) in columns.iter().enumerate() {
                values.insert(
                    col.clone(),
                    row.try_get::<Option<String>, _>(i + 1)
                        .map_err(|e| e.to_string())?,
                );
            }
            images.push((id, values));
        }
        persist(audit_pool, &images).await?;
    }
    Ok(())
}

/// Reuse already fetched rows on interactive inserts; no additional MySQL read.
pub async fn persist(pool: &SqlitePool, images: &[(i64, RowIdentity)]) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for (id, values) in images {
        let result = sqlx::query("UPDATE audit_log SET new_value=? WHERE id=?")
            .bind(serde_json::to_string(values).map_err(|e| e.to_string())?)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        if result.rows_affected() != 1 {
            return Err("新增行审计记录缺失".into());
        }
    }
    tx.commit().await.map_err(|e| e.to_string())
}
