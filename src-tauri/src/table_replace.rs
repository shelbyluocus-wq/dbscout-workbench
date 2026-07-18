use std::collections::{HashMap, HashSet};

use crate::db::escape_ident;
use crate::types::TableMeta;

pub type ReplacementRow = HashMap<String, String>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdatePlan {
    pub forward_sql: String,
    pub forward_binds: Vec<String>,
    pub inverse_sql: String,
    pub inverse_binds: Vec<String>,
    pub identity: HashMap<String, String>,
    pub old_values: crate::batch_import::ExistingRow,
    pub new_values: HashMap<String, Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowPlan {
    Update(UpdatePlan),
    Unchanged,
}

pub fn primary_key_names(table: &TableMeta) -> Vec<String> {
    table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.clone())
        .collect()
}

pub fn row_identity(
    table: &TableMeta,
    row: &ReplacementRow,
) -> Result<HashMap<String, String>, String> {
    let keys = primary_key_names(table);
    if keys.is_empty() {
        return Err("目标表没有主键，无法安全执行整表覆盖".into());
    }
    let mut identity = HashMap::with_capacity(keys.len());
    for key in keys {
        let value = row
            .get(&key)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("字段 {key} 不能为空"))?;
        identity.insert(key, value.to_string());
    }
    Ok(identity)
}

pub fn identity_signature(table: &TableMeta, row: &ReplacementRow) -> Result<String, String> {
    let identity = row_identity(table, row)?;
    let values = primary_key_names(table)
        .into_iter()
        .map(|key| identity.get(&key).cloned().unwrap_or_default())
        .collect::<Vec<_>>();
    serde_json::to_string(&values).map_err(|error| format!("生成主键标识失败: {error}"))
}

pub fn prepare_replacement_rows(
    table: &TableMeta,
    rows: Vec<ReplacementRow>,
) -> Result<Vec<ReplacementRow>, String> {
    crate::batch_import::validate_import_table(table)
        .map_err(|_| "目标表没有主键，无法安全执行整表覆盖".to_string())?;
    let writable_columns = table
        .columns
        .iter()
        .filter(|column| !column.is_generated)
        .map(|column| column.column_name.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut prepared = Vec::with_capacity(rows.len());
    for (index, row) in rows.into_iter().enumerate() {
        let row = row
            .into_iter()
            .filter(|(column, _)| writable_columns.contains(column.as_str()))
            .collect::<ReplacementRow>();
        row_identity(table, &row).map_err(|error| format!("Excel 第 {} 行：{error}", index + 2))?;
        crate::validation::validate_row_draft(table, &prepared, &row)
            .map_err(|error| format!("Excel 第 {} 行：{}", index + 2, error.message))?;
        prepared.push(row);
    }
    Ok(prepared)
}

pub fn mapped_column_names(
    table: &TableMeta,
    requested: &[String],
    rows: &[ReplacementRow],
) -> HashSet<String> {
    let requested = if requested.is_empty() {
        rows.iter()
            .flat_map(|row| row.keys().cloned())
            .collect::<HashSet<_>>()
    } else {
        requested.iter().cloned().collect::<HashSet<_>>()
    };
    table
        .columns
        .iter()
        .filter(|column| !column.is_generated && requested.contains(&column.column_name))
        .map(|column| column.column_name.clone())
        .collect()
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

fn is_json_column(column: &crate::types::ColumnMeta) -> bool {
    column
        .data_type
        .as_deref()
        .unwrap_or(&column.column_type)
        .trim()
        .eq_ignore_ascii_case("json")
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

fn replacement_default_value(column: &crate::types::ColumnMeta) -> Result<Option<String>, String> {
    match column.default_mode.as_deref().unwrap_or("none") {
        "value" => column.default_value.clone().map(Some).ok_or_else(|| {
            format!(
                "字段 {} 的默认值信息不完整，无法保证整表覆盖",
                column.column_name
            )
        }),
        "null" => Ok(None),
        "expression" => Err(format!(
            "字段 {} 为空且使用动态默认值，请在 Excel 中填写明确值后重试",
            column.column_name
        )),
        _ if column.is_nullable => Ok(None),
        _ => Err(format!("字段 {} 不能为空", column.column_name)),
    }
}

fn desired_value(
    column: &crate::types::ColumnMeta,
    incoming: &ReplacementRow,
    mapped_columns: &HashSet<String>,
) -> Result<Option<Option<String>>, String> {
    if let Some(value) = incoming.get(&column.column_name) {
        return Ok(Some(Some(value.clone())));
    }
    if mapped_columns.contains(&column.column_name) {
        return replacement_default_value(column).map(Some);
    }
    Ok(None)
}

pub fn build_update_plan(
    table: &TableMeta,
    incoming: &ReplacementRow,
    mapped_columns: &HashSet<String>,
    existing: &crate::batch_import::ExistingRow,
) -> Result<RowPlan, String> {
    let identity = row_identity(table, incoming)?;
    let mut changed = Vec::new();
    for column in table
        .columns
        .iter()
        .filter(|column| !column.is_primary_key && !column.is_generated)
    {
        let Some(new_value) = desired_value(column, incoming, mapped_columns)? else {
            continue;
        };
        let old_value = existing.get(&column.column_name).cloned().flatten();
        if old_value != new_value {
            changed.push((
                column.column_name.clone(),
                old_value,
                new_value,
                uses_collated_text_equality(&column.column_type),
                is_json_column(column),
            ));
        }
    }
    if changed.is_empty() {
        return Ok(RowPlan::Unchanged);
    }

    let set_forward = changed
        .iter()
        .map(|(column, _, new_value, _, _)| match new_value {
            Some(_) => format!("`{}` = ?", escape_ident(column)),
            None => format!("`{}` = NULL", escape_ident(column)),
        })
        .collect::<Vec<_>>()
        .join(", ");
    let set_inverse = changed
        .iter()
        .map(|(column, old_value, _, _, _)| match old_value {
            Some(_) => format!("`{}` = ?", escape_ident(column)),
            None => format!("`{}` = NULL", escape_ident(column)),
        })
        .collect::<Vec<_>>()
        .join(", ");
    let (identity_sql, identity_binds) = identity_where(table, &identity);
    let forward_guards = changed
        .iter()
        .map(
            |(column, old_value, _, exact_text, json_column)| match old_value {
                Some(_) if *json_column => {
                    format!("`{}` <=> CAST(? AS JSON)", escape_ident(column))
                }
                Some(_) if *exact_text => format!("BINARY `{}` <=> BINARY ?", escape_ident(column)),
                Some(_) => format!("`{}` <=> ?", escape_ident(column)),
                None => format!("`{}` <=> NULL", escape_ident(column)),
            },
        )
        .collect::<Vec<_>>();
    let inverse_guards = changed
        .iter()
        .map(
            |(column, _, new_value, exact_text, json_column)| match new_value {
                Some(_) if *json_column => {
                    format!("`{}` <=> CAST(? AS JSON)", escape_ident(column))
                }
                Some(_) if *exact_text => format!("BINARY `{}` <=> BINARY ?", escape_ident(column)),
                Some(_) => format!("`{}` <=> ?", escape_ident(column)),
                None => format!("`{}` <=> NULL", escape_ident(column)),
            },
        )
        .collect::<Vec<_>>();
    let forward_where = std::iter::once(identity_sql.clone())
        .chain(forward_guards)
        .collect::<Vec<_>>()
        .join(" AND ");
    let inverse_where = std::iter::once(identity_sql)
        .chain(inverse_guards)
        .collect::<Vec<_>>()
        .join(" AND ");

    let mut forward_binds = changed
        .iter()
        .filter_map(|(_, _, new_value, _, _)| new_value.clone())
        .collect::<Vec<_>>();
    forward_binds.extend(identity_binds.iter().cloned());
    forward_binds.extend(
        changed
            .iter()
            .filter_map(|(_, old_value, _, _, _)| old_value.clone()),
    );
    let mut inverse_binds = changed
        .iter()
        .filter_map(|(_, old_value, _, _, _)| old_value.clone())
        .collect::<Vec<_>>();
    inverse_binds.extend(identity_binds);
    inverse_binds.extend(
        changed
            .iter()
            .filter_map(|(_, _, new_value, _, _)| new_value.clone()),
    );

    Ok(RowPlan::Update(UpdatePlan {
        forward_sql: format!(
            "UPDATE `{}` SET {} WHERE {} LIMIT 1",
            escape_ident(&table.table_name),
            set_forward,
            forward_where
        ),
        forward_binds,
        inverse_sql: format!(
            "UPDATE `{}` SET {} WHERE {} LIMIT 1",
            escape_ident(&table.table_name),
            set_inverse,
            inverse_where
        ),
        inverse_binds,
        identity,
        old_values: changed
            .iter()
            .map(|(column, old_value, _, _, _)| (column.clone(), old_value.clone()))
            .collect(),
        new_values: changed
            .into_iter()
            .map(|(column, _, new_value, _, _)| (column, new_value))
            .collect(),
    }))
}

pub fn merge_mapped_values(
    table: &TableMeta,
    incoming: ReplacementRow,
    mapped_columns: &HashSet<String>,
    mut current: ReplacementRow,
) -> Result<(ReplacementRow, bool), String> {
    let mut changed = false;
    for column in table
        .columns
        .iter()
        .filter(|column| !column.is_primary_key && !column.is_generated)
    {
        let Some(new_value) = desired_value(column, &incoming, mapped_columns)? else {
            continue;
        };
        let new_value = new_value.unwrap_or_default();
        if current.get(&column.column_name) != Some(&new_value) {
            current.insert(column.column_name.clone(), new_value);
            changed = true;
        }
    }
    Ok((current, changed))
}

pub fn materialize_insert_defaults(
    table: &TableMeta,
    mut incoming: ReplacementRow,
    mapped_columns: &HashSet<String>,
) -> Result<ReplacementRow, String> {
    for column in table.columns.iter().filter(|column| !column.is_generated) {
        if incoming.contains_key(&column.column_name)
            || !mapped_columns.contains(&column.column_name)
        {
            continue;
        }
        incoming.insert(
            column.column_name.clone(),
            replacement_default_value(column)?.unwrap_or_default(),
        );
    }
    Ok(incoming)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ColumnMeta, TableMeta};

    fn table() -> TableMeta {
        TableMeta {
            table_name: "player".into(),
            table_comment: String::new(),
            columns: vec![
                ColumnMeta::with_basic("id", "int", "", true, false),
                ColumnMeta::with_basic("name", "varchar(32)", "", false, false),
            ],
        }
    }

    #[test]
    fn replacement_rows_require_complete_unique_primary_keys() {
        let meta = table();
        let duplicate = vec![
            HashMap::from([("id".into(), "1".into()), ("name".into(), "A".into())]),
            HashMap::from([("id".into(), "1".into()), ("name".into(), "B".into())]),
        ];
        assert!(prepare_replacement_rows(&meta, duplicate)
            .unwrap_err()
            .contains("Excel 第 3 行"));
        assert!(prepare_replacement_rows(
            &meta,
            vec![HashMap::from([("name".into(), "missing key".into())])],
        )
        .unwrap_err()
        .contains("Excel 第 2 行"));
    }

    #[test]
    fn replacement_rows_drop_unknown_columns_before_validation() {
        let meta = table();
        let rows = prepare_replacement_rows(
            &meta,
            vec![HashMap::from([
                ("id".into(), "7".into()),
                ("name".into(), "Ada".into()),
                ("unknown".into(), "ignored".into()),
            ])],
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].contains_key("unknown"));
    }

    #[test]
    fn mapped_blank_values_reset_existing_rows_to_defaults_and_null() {
        let mut meta = table();
        let mut score = ColumnMeta::with_basic("score", "int", "", false, false);
        score.default_mode = Some("value".into());
        score.default_value = Some("7".into());
        meta.columns.push(score);
        meta.columns.push(ColumnMeta::with_basic(
            "last_seen",
            "datetime",
            "",
            false,
            true,
        ));
        let incoming = HashMap::from([("id".into(), "1".into()), ("name".into(), "Ada".into())]);
        let mapped = mapped_column_names(
            &meta,
            &[
                "id".into(),
                "name".into(),
                "score".into(),
                "last_seen".into(),
            ],
            std::slice::from_ref(&incoming),
        );
        let existing = HashMap::from([
            ("name".into(), Some("Ada".into())),
            ("score".into(), Some("99".into())),
            ("last_seen".into(), Some("2026-07-15 10:00:00".into())),
        ]);

        let RowPlan::Update(plan) =
            build_update_plan(&meta, &incoming, &mapped, &existing).unwrap()
        else {
            panic!("blank mapped values must update existing data");
        };

        assert!(plan.forward_sql.contains("`score` = ?"));
        assert!(plan.forward_sql.contains("`last_seen` = NULL"));
        assert_eq!(plan.new_values.get("score"), Some(&Some("7".into())));
        assert_eq!(plan.new_values.get("last_seen"), Some(&None));
    }

    #[test]
    fn update_plan_compares_json_guards_as_json() {
        let mut meta = table();
        let mut fmt = ColumnMeta::with_basic("Fmt", "json", "", false, true);
        fmt.data_type = Some("json".into());
        meta.columns.push(fmt);
        let old_fmt = r#"[{"ID":61095,"Num":1}]"#;
        let new_fmt = r#"[{"ID":61095,"Num":12}]"#;
        let incoming = HashMap::from([
            ("id".into(), "1".into()),
            ("name".into(), "Ada".into()),
            ("Fmt".into(), new_fmt.into()),
        ]);
        let mapped = mapped_column_names(&meta, &[], std::slice::from_ref(&incoming));
        let existing = HashMap::from([
            ("name".into(), Some("Ada".into())),
            ("Fmt".into(), Some(old_fmt.into())),
        ]);

        let RowPlan::Update(plan) =
            build_update_plan(&meta, &incoming, &mapped, &existing).unwrap()
        else {
            panic!("changed JSON must produce an update plan");
        };

        assert!(plan.forward_sql.contains("SET `Fmt` = ?"));
        assert!(plan.forward_sql.contains("`Fmt` <=> CAST(? AS JSON)"));
        assert!(plan.inverse_sql.contains("`Fmt` <=> CAST(? AS JSON)"));
        assert_eq!(plan.forward_binds, vec![new_fmt, "1", old_fmt]);
        assert_eq!(plan.inverse_binds, vec![old_fmt, "1", new_fmt]);
    }

    #[test]
    fn update_plan_keeps_binary_guards_for_collated_text() {
        let meta = table();
        let incoming = HashMap::from([("id".into(), "1".into()), ("name".into(), "ada".into())]);
        let mapped = mapped_column_names(&meta, &[], std::slice::from_ref(&incoming));
        let existing = HashMap::from([("name".into(), Some("Ada".into()))]);

        let RowPlan::Update(plan) =
            build_update_plan(&meta, &incoming, &mapped, &existing).unwrap()
        else {
            panic!("case-only text change must produce an update plan");
        };

        assert!(plan.forward_sql.contains("BINARY `name` <=> BINARY ?"));
        assert!(plan.inverse_sql.contains("BINARY `name` <=> BINARY ?"));
    }
}
