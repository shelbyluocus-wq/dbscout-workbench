use std::collections::HashMap;

use crate::audit;
use crate::db::escape_ident;
use crate::types::TableMeta;

pub const MAX_BATCH_IMPORT_ROWS: usize = 1000;
pub type ExistingRow = HashMap<String, Option<String>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InsertPlan {
    pub forward_sql: String,
    pub forward_binds: Vec<String>,
    pub inverse_sql: Option<String>,
    pub inverse_binds: Vec<String>,
    pub identity: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdatePlan {
    pub forward_sql: String,
    pub forward_binds: Vec<String>,
    pub inverse_sql: String,
    pub inverse_binds: Vec<String>,
    pub identity: HashMap<String, String>,
    pub old_values: ExistingRow,
    pub new_values: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowPlan {
    Update(UpdatePlan),
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExistingLookupPlan {
    pub sql: String,
    pub binds: Vec<String>,
    pub columns: Vec<String>,
}

pub fn validate_batch_size(row_count: usize) -> Result<(), String> {
    if row_count > MAX_BATCH_IMPORT_ROWS {
        return Err(format!("单批导入不能超过 {MAX_BATCH_IMPORT_ROWS} 行"));
    }
    Ok(())
}

pub fn validate_import_table(table: &TableMeta) -> Result<(), String> {
    if table.columns.iter().any(|column| column.is_primary_key) {
        return Ok(());
    }
    Err("目标表没有主键，无法安全批量导入和回滚".into())
}

pub fn resolved_insert_identity(
    table: &TableMeta,
    draft: &HashMap<String, String>,
    last_insert_id: u64,
) -> Option<HashMap<String, String>> {
    let keys = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return None;
    }
    let mut identity = HashMap::with_capacity(keys.len());
    for column in keys {
        let value = draft
            .get(&column.column_name)
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .or_else(|| {
                (column.is_auto_increment && last_insert_id > 0).then(|| last_insert_id.to_string())
            })?;
        identity.insert(column.column_name.clone(), value);
    }
    Some(identity)
}

fn primary_identity(
    table: &TableMeta,
    draft: &HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let keys = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    let mut identity = HashMap::with_capacity(keys.len());
    for column in keys {
        let value = draft
            .get(&column.column_name)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("字段 {} 不能为空", column.column_name))?;
        identity.insert(column.column_name.clone(), value.clone());
    }
    Ok(identity)
}

fn identity_where(table: &TableMeta, identity: &HashMap<String, String>) -> (String, Vec<String>) {
    let mut clauses = Vec::new();
    let mut binds = Vec::new();
    for column in table.columns.iter().filter(|column| column.is_primary_key) {
        if let Some(value) = identity.get(&column.column_name) {
            clauses.push(format!("`{}` = ?", escape_ident(&column.column_name)));
            binds.push(value.clone());
        }
    }
    (clauses.join(" AND "), binds)
}

fn uses_collated_text_equality(column_type: &str) -> bool {
    let base_type = column_type
        .trim()
        .split(|character: char| character == '(' || character.is_ascii_whitespace())
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        base_type.as_str(),
        "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "enum" | "set"
    )
}

pub fn build_existing_lookup_plan(
    table: &TableMeta,
    draft: &HashMap<String, String>,
) -> Result<ExistingLookupPlan, String> {
    let identity = primary_identity(table, draft)?;
    if identity.is_empty() {
        return Err("目标表没有主键，无法匹配已有行".into());
    }
    let columns = table
        .columns
        .iter()
        .filter(|column| {
            !column.is_primary_key
                && !column.is_generated
                && draft.contains_key(&column.column_name)
        })
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    let projection = if columns.is_empty() {
        "1".to_string()
    } else {
        columns
            .iter()
            .map(|column| {
                format!(
                    "CAST(`{}` AS CHAR) AS `{}`",
                    escape_ident(column),
                    escape_ident(column)
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let (where_sql, binds) = identity_where(table, &identity);
    Ok(ExistingLookupPlan {
        sql: format!(
            "SELECT {} FROM `{}` WHERE {} LIMIT 1",
            projection,
            escape_ident(&table.table_name),
            where_sql
        ),
        binds,
        columns,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchExistingLookupPlan {
    pub sql: String,
    pub binds: Vec<String>,
    /// Indexes into the caller's draft slice, in the same order the IN values were bound.
    pub draft_indexes: Vec<usize>,
    /// Primary-key column names, in table column order (projection order).
    pub pk_columns: Vec<String>,
    /// Non-PK value column names in projection order (same semantics as ExistingLookupPlan.columns:
    /// non-primary, non-generated columns present in the drafts).
    pub value_columns: Vec<String>,
}

/// Canonical map key from PK values (None = NULL). Used for both drafts and fetched rows.
///
/// The values are serialized as a JSON array of nullable strings (e.g.
/// `["7",null,"x"]`), the same serde_json-based encoding style as
/// `table_replace::identity_signature`; JSON quoting keeps the key unambiguous
/// even when values themselves contain separator characters.
pub fn lookup_key(values: &[Option<String>]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".into())
}

/// Batch variant of `build_existing_lookup_plan`: fetches the existing rows for
/// many drafts in ONE query. Drafts without a complete primary identity are
/// skipped (the caller falls back to per-row lookup for those); returns `None`
/// when no draft qualifies.
pub fn build_batch_existing_lookup_plan(
    table: &TableMeta,
    drafts: &[HashMap<String, String>],
) -> Option<BatchExistingLookupPlan> {
    let pk_columns = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    if pk_columns.is_empty() {
        return None;
    }
    let mut draft_indexes = Vec::new();
    let mut identities = Vec::new();
    for (index, draft) in drafts.iter().enumerate() {
        match primary_identity(table, draft) {
            Ok(identity) if identity.len() == pk_columns.len() => {
                draft_indexes.push(index);
                identities.push(identity);
            }
            _ => {}
        }
    }
    if draft_indexes.is_empty() {
        return None;
    }
    let value_columns = table
        .columns
        .iter()
        .filter(|column| {
            !column.is_primary_key
                && !column.is_generated
                && draft_indexes
                    .iter()
                    .any(|index| drafts[*index].contains_key(&column.column_name))
        })
        .map(|column| column.column_name.clone())
        .collect::<Vec<_>>();
    let projection = pk_columns
        .iter()
        .chain(value_columns.iter())
        .map(|column| {
            format!(
                "CAST(`{}` AS CHAR) AS `{}`",
                escape_ident(column),
                escape_ident(column)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let (where_sql, binds) = if pk_columns.len() == 1 {
        let placeholders = identities
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ");
        let binds = identities
            .iter()
            .map(|identity| identity[pk_columns[0].as_str()].clone())
            .collect::<Vec<_>>();
        (
            format!("`{}` IN ({placeholders})", escape_ident(&pk_columns[0])),
            binds,
        )
    } else {
        let key_list = pk_columns
            .iter()
            .map(|column| format!("`{}`", escape_ident(column)))
            .collect::<Vec<_>>()
            .join(", ");
        let row_placeholder = format!(
            "({})",
            pk_columns
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(", ")
        );
        let tuple_list = identities
            .iter()
            .map(|_| row_placeholder.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let mut binds = Vec::with_capacity(identities.len() * pk_columns.len());
        for identity in &identities {
            for column in &pk_columns {
                binds.push(identity[column.as_str()].clone());
            }
        }
        (format!("({key_list}) IN ({tuple_list})"), binds)
    };
    Some(BatchExistingLookupPlan {
        sql: format!(
            "SELECT {projection} FROM `{}` WHERE {where_sql}",
            escape_ident(&table.table_name)
        ),
        binds,
        draft_indexes,
        pk_columns,
        value_columns,
    })
}

pub fn build_expected_values_lookup_plan(
    table: &TableMeta,
    identity: &HashMap<String, String>,
    values: &HashMap<String, String>,
) -> Result<ExistingLookupPlan, String> {
    let (identity_sql, mut binds) = identity_where(table, identity);
    let key_count = table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .count();
    if key_count == 0 || binds.len() != key_count {
        return Err("缺少完整主键，无法确认导入结果".into());
    }
    let mut clauses = vec![identity_sql];
    for column in table
        .columns
        .iter()
        .filter(|column| !column.is_primary_key && values.contains_key(&column.column_name))
    {
        let column_name = escape_ident(&column.column_name);
        clauses.push(if uses_collated_text_equality(&column.column_type) {
            format!("BINARY `{column_name}` <=> BINARY ?")
        } else {
            format!("`{column_name}` <=> ?")
        });
        binds.push(values.get(&column.column_name).cloned().unwrap_or_default());
    }
    Ok(ExistingLookupPlan {
        sql: format!(
            "SELECT 1 FROM `{}` WHERE {} LIMIT 1",
            escape_ident(&table.table_name),
            clauses.join(" AND ")
        ),
        binds,
        columns: Vec::new(),
    })
}

pub fn build_insert_plan(
    database: &str,
    table: &TableMeta,
    draft: &HashMap<String, String>,
) -> Result<InsertPlan, String> {
    let columns = table
        .columns
        .iter()
        .filter(|column| !column.is_generated && draft.contains_key(&column.column_name))
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Err("没有可导入的字段".into());
    }
    let forward_sql = format!(
        "INSERT INTO `{}` ({}) VALUES ({})",
        escape_ident(&table.table_name),
        columns
            .iter()
            .map(|column| format!("`{}`", escape_ident(&column.column_name)))
            .collect::<Vec<_>>()
            .join(", "),
        columns.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
    );
    let forward_binds = columns
        .iter()
        .map(|column| draft.get(&column.column_name).cloned().unwrap_or_default())
        .collect();
    let identity = resolved_insert_identity(table, draft, 0).unwrap_or_default();
    let (inverse_sql, inverse_binds, _) =
        audit::build_insert_inverse(database, &table.table_name, &identity)?;
    Ok(InsertPlan {
        forward_sql,
        forward_binds,
        inverse_sql,
        inverse_binds,
        identity,
    })
}

pub const INSERT_GROUP_SIZE: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InsertStatementGroup {
    pub sql: String,
    pub binds: Vec<String>,
    /// Indexes into the caller's draft slice, in VALUES order.
    pub draft_indexes: Vec<usize>,
    /// Column names of the INSERT, in bind order.
    pub columns: Vec<String>,
}

/// Groups drafts by identical insert column list (same rule as `build_insert_plan`:
/// non-generated columns present in the draft, table column order), then splits each
/// group into chunks of at most INSERT_GROUP_SIZE rows, emitting one multi-row
/// `INSERT INTO `t` (cols) VALUES (...),(...),...` per chunk.
pub fn build_grouped_insert_statements(
    table: &TableMeta,
    drafts: &[HashMap<String, String>],
    draft_indexes: &[usize],
) -> Vec<InsertStatementGroup> {
    // Group the selected drafts by their insert column list, keeping first-seen
    // group order and draft order within each group.
    let mut group_order: Vec<Vec<String>> = Vec::new();
    let mut members_by_columns: HashMap<Vec<String>, Vec<usize>> = HashMap::new();
    for &index in draft_indexes {
        let columns = table
            .columns
            .iter()
            .filter(|column| {
                !column.is_generated && drafts[index].contains_key(&column.column_name)
            })
            .map(|column| column.column_name.clone())
            .collect::<Vec<_>>();
        // No insertable columns: skip here; the caller reports the same
        // "没有可导入的字段" error `build_insert_plan` would raise.
        if columns.is_empty() {
            continue;
        }
        if !members_by_columns.contains_key(&columns) {
            group_order.push(columns.clone());
        }
        members_by_columns.entry(columns).or_default().push(index);
    }
    let mut groups = Vec::new();
    for columns in group_order {
        let members = &members_by_columns[&columns];
        for chunk in members.chunks(INSERT_GROUP_SIZE) {
            let row_placeholders = format!(
                "({})",
                columns.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
            );
            let sql = format!(
                "INSERT INTO `{}` ({}) VALUES {}",
                escape_ident(&table.table_name),
                columns
                    .iter()
                    .map(|column| format!("`{}`", escape_ident(column)))
                    .collect::<Vec<_>>()
                    .join(", "),
                chunk
                    .iter()
                    .map(|_| row_placeholders.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            let mut binds = Vec::with_capacity(chunk.len() * columns.len());
            for &index in chunk {
                for column in &columns {
                    binds.push(drafts[index].get(column).cloned().unwrap_or_default());
                }
            }
            groups.push(InsertStatementGroup {
                sql,
                binds,
                draft_indexes: chunk.to_vec(),
                columns: columns.clone(),
            });
        }
    }
    groups
}

pub fn build_update_plan(
    table: &TableMeta,
    draft: &HashMap<String, String>,
    existing: &ExistingRow,
) -> Result<RowPlan, String> {
    let identity = primary_identity(table, draft)?;
    if identity.is_empty() {
        return Err("目标表没有主键，无法更新已有行".into());
    }

    let mut changed = Vec::new();
    for column in table
        .columns
        .iter()
        .filter(|column| !column.is_primary_key && !column.is_generated)
    {
        let Some(new_value) = draft.get(&column.column_name) else {
            continue;
        };
        let old_value = existing.get(&column.column_name).cloned().flatten();
        if old_value.as_ref() != Some(new_value) {
            changed.push((
                column.column_name.clone(),
                old_value,
                new_value.clone(),
                uses_collated_text_equality(&column.column_type),
            ));
        }
    }
    if changed.is_empty() {
        return Ok(RowPlan::Unchanged);
    }

    let set_forward = changed
        .iter()
        .map(|(column, _, _, _)| format!("`{}` = ?", escape_ident(column)))
        .collect::<Vec<_>>()
        .join(", ");
    let set_inverse = changed
        .iter()
        .map(|(column, old_value, _, _)| match old_value {
            Some(_) => format!("`{}` = ?", escape_ident(column)),
            None => format!("`{}` = NULL", escape_ident(column)),
        })
        .collect::<Vec<_>>()
        .join(", ");
    let (identity_sql, identity_binds) = identity_where(table, &identity);
    // The old values came from a CAST(col AS CHAR) projection, so the forward
    // guard compares the CASTed column against the bound string: this
    // round-trips exactly for every type (FLOAT, BIT, ...) and avoids false
    // "row was modified" conflicts. The inverse guard keeps the legacy form so
    // the rollback path stays byte-identical.
    let forward_guards = changed
        .iter()
        .map(|(column, old_value, _, exact_text)| match old_value {
            Some(_) if *exact_text => format!(
                "BINARY CAST(`{}` AS CHAR) <=> BINARY ?",
                escape_ident(column)
            ),
            Some(_) => format!("CAST(`{}` AS CHAR) <=> ?", escape_ident(column)),
            None => format!("CAST(`{}` AS CHAR) <=> NULL", escape_ident(column)),
        })
        .collect::<Vec<_>>();
    let inverse_guards = changed
        .iter()
        .map(|(column, _, _, exact_text)| {
            if *exact_text {
                format!("BINARY `{}` <=> BINARY ?", escape_ident(column))
            } else {
                format!("`{}` <=> ?", escape_ident(column))
            }
        })
        .collect::<Vec<_>>();

    let forward_where = std::iter::once(identity_sql.clone())
        .chain(forward_guards)
        .collect::<Vec<_>>()
        .join(" AND ");
    let inverse_where = std::iter::once(identity_sql)
        .chain(inverse_guards)
        .collect::<Vec<_>>()
        .join(" AND ");
    let forward_sql = format!(
        "UPDATE `{}` SET {} WHERE {} LIMIT 1",
        escape_ident(&table.table_name),
        set_forward,
        forward_where
    );
    let inverse_sql = format!(
        "UPDATE `{}` SET {} WHERE {} LIMIT 1",
        escape_ident(&table.table_name),
        set_inverse,
        inverse_where
    );

    let mut forward_binds = changed
        .iter()
        .map(|(_, _, new_value, _)| new_value.clone())
        .collect::<Vec<_>>();
    forward_binds.extend(identity_binds.iter().cloned());
    forward_binds.extend(
        changed
            .iter()
            .filter_map(|(_, old_value, _, _)| old_value.clone()),
    );
    let mut inverse_binds = changed
        .iter()
        .filter_map(|(_, old_value, _, _)| old_value.clone())
        .collect::<Vec<_>>();
    inverse_binds.extend(identity_binds);
    inverse_binds.extend(changed.iter().map(|(_, _, new_value, _)| new_value.clone()));

    let old_values = changed
        .iter()
        .map(|(column, old_value, _, _)| (column.clone(), old_value.clone()))
        .collect();
    let new_values = changed
        .iter()
        .map(|(column, _, new_value, _)| (column.clone(), new_value.clone()))
        .collect();

    Ok(RowPlan::Update(UpdatePlan {
        forward_sql,
        forward_binds,
        inverse_sql,
        inverse_binds,
        identity,
        old_values,
        new_values,
    }))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::types::{ColumnMeta, TableMeta};

    fn column(name: &str, primary_key: bool) -> ColumnMeta {
        ColumnMeta::with_basic(name, "varchar(64)", "", primary_key, !primary_key)
    }

    fn auto_increment_column(name: &str) -> ColumnMeta {
        let mut column = ColumnMeta::with_basic(name, "bigint", "", true, false);
        column.is_auto_increment = true;
        column
    }

    fn typed_column(name: &str, column_type: &str) -> ColumnMeta {
        ColumnMeta::with_basic(name, column_type, "", false, true)
    }

    fn table(columns: Vec<ColumnMeta>) -> TableMeta {
        TableMeta {
            primary_key_order: Vec::new(),
            table_name: "translations".into(),
            table_comment: String::new(),
            columns,
        }
    }

    fn draft(values: &[(&str, &str)]) -> HashMap<String, String> {
        values
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn existing(values: &[(&str, Option<&str>)]) -> ExistingRow {
        values
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.map(str::to_string)))
            .collect()
    }

    #[test]
    fn insert_plan_has_auditable_inverse_delete() {
        let table = table(vec![column("id", true), column("text", false)]);
        let plan = build_insert_plan("game-db", &table, &draft(&[("id", "7"), ("text", "Hello")]))
            .expect("insert plan");

        assert_eq!(
            plan.forward_sql,
            "INSERT INTO `translations` (`id`, `text`) VALUES (?, ?)"
        );
        assert_eq!(plan.forward_binds, vec!["7", "Hello"]);
        assert_eq!(
            plan.inverse_sql.as_deref(),
            Some("DELETE FROM `game-db`.`translations` WHERE `id` <=> ? LIMIT 1")
        );
        assert_eq!(plan.inverse_binds, vec!["7"]);
        assert_eq!(plan.identity, draft(&[("id", "7")]));
    }

    #[test]
    fn update_plan_changes_only_mapped_non_primary_columns_and_restores_old_values() {
        let table = table(vec![
            column("id", true),
            column("text", false),
            column("comment", false),
        ]);
        let incoming = draft(&[("id", "7"), ("text", "New")]);
        let current = existing(&[
            ("id", Some("7")),
            ("text", Some("Old")),
            ("comment", Some("Keep")),
        ]);

        let RowPlan::Update(plan) =
            build_update_plan(&table, &incoming, &current).expect("update plan")
        else {
            panic!("expected update plan");
        };

        assert_eq!(
            plan.forward_sql,
            "UPDATE `translations` SET `text` = ? WHERE `id` = ? AND BINARY CAST(`text` AS CHAR) <=> BINARY ? LIMIT 1"
        );
        assert_eq!(plan.forward_binds, vec!["New", "7", "Old"]);
        assert_eq!(
            plan.inverse_sql,
            "UPDATE `translations` SET `text` = ? WHERE `id` = ? AND BINARY `text` <=> BINARY ? LIMIT 1"
        );
        assert_eq!(plan.inverse_binds, vec!["Old", "7", "New"]);
        assert_eq!(plan.old_values, existing(&[("text", Some("Old"))]));
        assert_eq!(plan.new_values, draft(&[("text", "New")]));
        assert!(!plan.forward_sql.contains("comment"));
    }

    #[test]
    fn update_plan_returns_unchanged_when_mapped_values_match() {
        let table = table(vec![column("id", true), column("text", false)]);
        let incoming = draft(&[("id", "7"), ("text", "Same")]);
        let current = existing(&[("id", Some("7")), ("text", Some("Same"))]);

        assert_eq!(
            build_update_plan(&table, &incoming, &current).expect("unchanged plan"),
            RowPlan::Unchanged
        );
    }

    #[test]
    fn update_plan_uses_every_composite_primary_key_column() {
        let table = table(vec![
            column("group_id", true),
            column("locale", true),
            column("text", false),
        ]);
        let incoming = draft(&[("group_id", "12"), ("locale", "zh-CN"), ("text", "New")]);
        let current = existing(&[("text", Some("Old"))]);

        let RowPlan::Update(plan) =
            build_update_plan(&table, &incoming, &current).expect("composite update")
        else {
            panic!("expected update plan");
        };

        assert!(plan
            .forward_sql
            .contains("WHERE `group_id` = ? AND `locale` = ?"));
        assert!(plan
            .forward_sql
            .contains("BINARY CAST(`text` AS CHAR) <=> BINARY ?"));
        assert_eq!(plan.forward_binds, vec!["New", "12", "zh-CN", "Old"]);
        assert_eq!(
            plan.identity,
            draft(&[("group_id", "12"), ("locale", "zh-CN")])
        );
    }

    #[test]
    fn existing_lookup_reads_only_mapped_fields_by_complete_composite_key() {
        let table = table(vec![
            column("group_id", true),
            column("locale", true),
            column("text", false),
            column("comment", false),
        ]);
        let incoming = draft(&[("group_id", "12"), ("locale", "zh-CN"), ("text", "New")]);

        let plan = build_existing_lookup_plan(&table, &incoming).expect("lookup plan");

        assert_eq!(
            plan.sql,
            "SELECT CAST(`text` AS CHAR) AS `text` FROM `translations` WHERE `group_id` = ? AND `locale` = ? LIMIT 1"
        );
        assert_eq!(plan.binds, vec!["12", "zh-CN"]);
        assert_eq!(plan.columns, vec!["text"]);
    }

    #[test]
    fn expected_value_lookup_uses_mysql_type_comparison_for_normalized_values() {
        let table = table(vec![
            column("id", true),
            typed_column("amount", "decimal(10,2)"),
        ]);
        let identity = draft(&[("id", "7")]);
        let values = draft(&[("amount", "1")]);

        let plan = build_expected_values_lookup_plan(&table, &identity, &values)
            .expect("expected-value lookup");

        assert_eq!(
            plan.sql,
            "SELECT 1 FROM `translations` WHERE `id` = ? AND `amount` <=> ? LIMIT 1"
        );
        assert_eq!(plan.binds, vec!["7", "1"]);
    }

    #[test]
    fn expected_value_lookup_compares_text_values_exactly() {
        let table = table(vec![column("id", true), column("text", false)]);
        let identity = draft(&[("id", "7")]);
        let values = draft(&[("text", "foo")]);

        let plan = build_expected_values_lookup_plan(&table, &identity, &values)
            .expect("expected-value lookup");

        assert_eq!(
            plan.sql,
            "SELECT 1 FROM `translations` WHERE `id` = ? AND BINARY `text` <=> BINARY ? LIMIT 1"
        );
        assert_eq!(plan.binds, vec!["7", "foo"]);
    }

    #[test]
    fn resolved_insert_identity_combines_generated_and_supplied_composite_keys() {
        let table = table(vec![
            auto_increment_column("id"),
            column("locale", true),
            column("text", false),
        ]);

        let identity = resolved_insert_identity(
            &table,
            &draft(&[("locale", "zh-CN"), ("text", "Hello")]),
            42,
        )
        .expect("complete identity");

        assert_eq!(identity, draft(&[("id", "42"), ("locale", "zh-CN")]));
    }

    #[test]
    fn import_table_validation_rejects_tables_without_primary_keys() {
        let table = table(vec![column("text", false)]);

        assert!(validate_import_table(&table)
            .expect_err("table should be rejected")
            .contains("主键"));
    }

    #[test]
    fn batch_size_rejects_more_than_one_thousand_rows() {
        assert!(validate_batch_size(1000).is_ok());
        assert!(validate_batch_size(1001)
            .expect_err("batch should be rejected")
            .contains("1000"));
    }

    #[test]
    fn batch_existing_lookup_uses_in_list_for_single_primary_key() {
        let table = table(vec![column("id", true), column("text", false)]);
        let drafts = vec![draft(&[("id", "7"), ("text", "a")]), draft(&[("id", "8")])];

        let plan = build_batch_existing_lookup_plan(&table, &drafts).expect("batch lookup");

        assert_eq!(
            plan.sql,
            "SELECT CAST(`id` AS CHAR) AS `id`, CAST(`text` AS CHAR) AS `text` FROM `translations` WHERE `id` IN (?, ?)"
        );
        assert_eq!(plan.binds, vec!["7", "8"]);
        assert_eq!(plan.draft_indexes, vec![0, 1]);
        assert_eq!(plan.pk_columns, vec!["id"]);
        // A value column present in ANY included draft is projected for all.
        assert_eq!(plan.value_columns, vec!["text"]);
    }

    #[test]
    fn batch_existing_lookup_uses_row_constructors_for_composite_primary_key() {
        let table = table(vec![
            column("group_id", true),
            column("locale", true),
            column("text", false),
            column("comment", false),
        ]);
        let drafts = vec![
            draft(&[("group_id", "12"), ("locale", "zh-CN"), ("text", "a")]),
            draft(&[("group_id", "13"), ("locale", "en-US"), ("comment", "b")]),
        ];

        let plan = build_batch_existing_lookup_plan(&table, &drafts).expect("batch lookup");

        assert_eq!(
            plan.sql,
            "SELECT CAST(`group_id` AS CHAR) AS `group_id`, CAST(`locale` AS CHAR) AS `locale`, CAST(`text` AS CHAR) AS `text`, CAST(`comment` AS CHAR) AS `comment` FROM `translations` WHERE (`group_id`, `locale`) IN ((?, ?), (?, ?))"
        );
        // Bind order follows draft_indexes, PK columns in table order.
        assert_eq!(plan.binds, vec!["12", "zh-CN", "13", "en-US"]);
        assert_eq!(plan.draft_indexes, vec![0, 1]);
        assert_eq!(plan.pk_columns, vec!["group_id", "locale"]);
        assert_eq!(plan.value_columns, vec!["text", "comment"]);
    }

    #[test]
    fn batch_existing_lookup_skips_drafts_with_incomplete_primary_key() {
        let table = table(vec![
            column("group_id", true),
            column("locale", true),
            column("text", false),
            column("comment", false),
        ]);
        let drafts = vec![
            // Missing `locale` -> skipped; its `comment` must not leak into the projection.
            draft(&[("group_id", "12"), ("comment", "skip me")]),
            draft(&[("group_id", "13"), ("locale", "en-US"), ("text", "b")]),
            // Blank PK value -> skipped.
            draft(&[("group_id", "  "), ("locale", "fr-FR")]),
            draft(&[("group_id", "14"), ("locale", "de-DE")]),
        ];

        let plan = build_batch_existing_lookup_plan(&table, &drafts).expect("batch lookup");

        assert_eq!(plan.draft_indexes, vec![1, 3]);
        assert_eq!(plan.binds, vec!["13", "en-US", "14", "de-DE"]);
        assert!(plan
            .sql
            .contains("WHERE (`group_id`, `locale`) IN ((?, ?), (?, ?))"));
        assert_eq!(plan.value_columns, vec!["text"]);
    }

    #[test]
    fn batch_existing_lookup_projects_only_primary_keys_without_value_columns() {
        let table = table(vec![column("id", true), column("text", false)]);
        let drafts = vec![draft(&[("id", "7")]), draft(&[("id", "8")])];

        let plan = build_batch_existing_lookup_plan(&table, &drafts).expect("batch lookup");

        assert_eq!(
            plan.sql,
            "SELECT CAST(`id` AS CHAR) AS `id` FROM `translations` WHERE `id` IN (?, ?)"
        );
        assert!(plan.value_columns.is_empty());
    }

    #[test]
    fn batch_existing_lookup_returns_none_when_no_draft_has_a_complete_key() {
        let keyed = table(vec![
            column("group_id", true),
            column("locale", true),
            column("text", false),
        ]);
        let drafts = vec![
            draft(&[("group_id", "12")]),
            draft(&[("locale", "en-US"), ("text", "b")]),
        ];
        assert_eq!(build_batch_existing_lookup_plan(&keyed, &drafts), None);

        // A table without a primary key never qualifies either.
        let keyless = table(vec![column("text", false)]);
        assert_eq!(
            build_batch_existing_lookup_plan(&keyless, &[draft(&[("text", "a")])]),
            None
        );
    }

    #[test]
    fn lookup_key_is_a_stable_unambiguous_encoding() {
        // Same values -> same key.
        assert_eq!(
            lookup_key(&[Some("7".into()), None, Some("x".into())]),
            lookup_key(&[Some("7".into()), None, Some("x".into())])
        );
        // NULL and empty string stay distinct.
        assert_ne!(
            lookup_key(&[Some("7".into()), None]),
            lookup_key(&[Some("7".into()), Some(String::new())])
        );
        // Value order matters.
        assert_ne!(
            lookup_key(&[Some("a".into()), Some("b".into())]),
            lookup_key(&[Some("b".into()), Some("a".into())])
        );
        // JSON quoting keeps separator-looking content unambiguous.
        assert_ne!(
            lookup_key(&[Some("a\",\"b".into())]),
            lookup_key(&[Some("a".into()), Some("b".into())])
        );
        // Exact encoding (self-consistency contract for callers).
        assert_eq!(lookup_key(&[Some("7".into()), None]), r#"["7",null]"#);
    }

    #[test]
    fn grouped_insert_statements_group_by_identical_column_lists() {
        let table = table(vec![
            column("id", true),
            column("text", false),
            column("comment", false),
        ]);
        let drafts = vec![
            draft(&[("id", "1"), ("text", "a")]),
            draft(&[("id", "2"), ("text", "b"), ("comment", "c2")]),
            draft(&[("id", "3"), ("text", "c")]),
        ];

        let groups = build_grouped_insert_statements(&table, &drafts, &[0, 1, 2]);

        assert_eq!(groups.len(), 2);
        // First-seen group: (id, text) with drafts 0 and 2.
        assert_eq!(groups[0].columns, vec!["id", "text"]);
        assert_eq!(
            groups[0].sql,
            "INSERT INTO `translations` (`id`, `text`) VALUES (?, ?), (?, ?)"
        );
        assert_eq!(groups[0].binds, vec!["1", "a", "3", "c"]);
        assert_eq!(groups[0].draft_indexes, vec![0, 2]);
        // Second group: (id, text, comment) with draft 1.
        assert_eq!(groups[1].columns, vec!["id", "text", "comment"]);
        assert_eq!(
            groups[1].sql,
            "INSERT INTO `translations` (`id`, `text`, `comment`) VALUES (?, ?, ?)"
        );
        assert_eq!(groups[1].binds, vec!["2", "b", "c2"]);
        assert_eq!(groups[1].draft_indexes, vec![1]);
    }

    #[test]
    fn grouped_insert_statements_split_at_insert_group_size() {
        let table = table(vec![column("id", true), column("text", false)]);
        let drafts = (0..=INSERT_GROUP_SIZE)
            .map(|index| {
                let id = index.to_string();
                draft(&[("id", id.as_str()), ("text", "v")])
            })
            .collect::<Vec<_>>();
        let indexes = (0..drafts.len()).collect::<Vec<_>>();

        let groups = build_grouped_insert_statements(&table, &drafts, &indexes);

        // INSERT_GROUP_SIZE + 1 drafts -> one full chunk plus a remainder chunk.
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].columns, vec!["id", "text"]);
        assert_eq!(groups[0].draft_indexes.len(), INSERT_GROUP_SIZE);
        assert_eq!(groups[0].binds.len(), INSERT_GROUP_SIZE * 2);
        assert_eq!(groups[0].binds[0], "0");
        assert_eq!(groups[0].binds[1], "v");
        assert_eq!(groups[0].binds[2], "1");
        assert_eq!(groups[1].draft_indexes, vec![INSERT_GROUP_SIZE]);
        assert_eq!(
            groups[1].binds,
            vec![INSERT_GROUP_SIZE.to_string(), "v".to_string()]
        );
        assert_eq!(
            groups[1].sql,
            "INSERT INTO `translations` (`id`, `text`) VALUES (?, ?)"
        );
    }

    #[test]
    fn grouped_insert_statements_only_insert_selected_indexes_and_skip_empty_drafts() {
        let table = table(vec![column("id", true), column("text", false)]);
        let drafts = vec![
            draft(&[("id", "1"), ("text", "a")]),
            // No insertable columns -> skipped (caller reports "没有可导入的字段").
            draft(&[("unknown_column", "x")]),
            // Not selected by draft_indexes -> not inserted.
            draft(&[("id", "3"), ("text", "c")]),
        ];

        let groups = build_grouped_insert_statements(&table, &drafts, &[0, 1]);

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].draft_indexes, vec![0]);
        assert_eq!(groups[0].binds, vec!["1", "a"]);
    }

    #[test]
    fn update_plan_forward_guards_use_cast_form_while_inverse_stays_legacy() {
        let table = table(vec![
            column("id", true),
            typed_column("amount", "decimal(10,2)"),
            column("text", false),
            column("note", false),
        ]);
        let incoming = draft(&[
            ("id", "7"),
            ("amount", "1.50"),
            ("text", "New"),
            ("note", "n"),
        ]);
        let current = existing(&[
            ("amount", Some("1.00")),
            ("text", Some("Old")),
            ("note", None),
        ]);

        let RowPlan::Update(plan) =
            build_update_plan(&table, &incoming, &current).expect("update plan")
        else {
            panic!("expected update plan");
        };

        // Forward guards compare the CASTed column: non-text columns use
        // CAST(col AS CHAR), collated text keeps BINARY around the CAST, and
        // NULL old values use the same CAST form for symmetry.
        assert_eq!(
            plan.forward_sql,
            "UPDATE `translations` SET `amount` = ?, `text` = ?, `note` = ? WHERE `id` = ? AND CAST(`amount` AS CHAR) <=> ? AND BINARY CAST(`text` AS CHAR) <=> BINARY ? AND CAST(`note` AS CHAR) <=> NULL LIMIT 1"
        );
        // Inverse guards stay byte-identical to the legacy non-CAST form.
        assert_eq!(
            plan.inverse_sql,
            "UPDATE `translations` SET `amount` = ?, `text` = ?, `note` = NULL WHERE `id` = ? AND `amount` <=> ? AND BINARY `text` <=> BINARY ? AND BINARY `note` <=> BINARY ? LIMIT 1"
        );
        assert!(!plan.inverse_sql.contains("CAST("));
        assert_eq!(
            plan.forward_binds,
            vec!["1.50", "New", "n", "7", "1.00", "Old"]
        );
    }
}
