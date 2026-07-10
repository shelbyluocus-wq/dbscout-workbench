use std::collections::HashMap;

use crate::audit;
use crate::db::escape_ident;
use crate::types::TableMeta;

pub const MAX_BATCH_IMPORT_ROWS: usize = 100;
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
        audit::build_insert_inverse(&table.table_name, &identity)?;
    Ok(InsertPlan {
        forward_sql,
        forward_binds,
        inverse_sql,
        inverse_binds,
        identity,
    })
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
    let forward_guards = changed
        .iter()
        .map(|(column, old_value, _, exact_text)| match old_value {
            Some(_) if *exact_text => {
                format!("BINARY `{}` <=> BINARY ?", escape_ident(column))
            }
            Some(_) => format!("`{}` <=> ?", escape_ident(column)),
            None => format!("`{}` <=> NULL", escape_ident(column)),
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
        let plan = build_insert_plan(&table, &draft(&[("id", "7"), ("text", "Hello")]))
            .expect("insert plan");

        assert_eq!(
            plan.forward_sql,
            "INSERT INTO `translations` (`id`, `text`) VALUES (?, ?)"
        );
        assert_eq!(plan.forward_binds, vec!["7", "Hello"]);
        assert_eq!(
            plan.inverse_sql.as_deref(),
            Some("DELETE FROM `translations` WHERE `id` <=> ? LIMIT 1")
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
            "UPDATE `translations` SET `text` = ? WHERE `id` = ? AND BINARY `text` <=> BINARY ? LIMIT 1"
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
    fn batch_size_rejects_more_than_one_hundred_rows() {
        assert!(validate_batch_size(100).is_ok());
        assert!(validate_batch_size(101)
            .expect_err("batch should be rejected")
            .contains("100"));
    }
}
