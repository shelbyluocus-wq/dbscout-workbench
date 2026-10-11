//! Snapshot of one config database's tables, columns, keys and comments.

use std::collections::BTreeMap;

use crate::types::{ColumnMeta, TableMeta, TableOption};

use super::code_scan::TableColumns;

#[derive(Debug, Clone)]
pub struct DbColumn {
    pub name: String,
    pub data_type: String,
    pub comment: String,
}

impl DbColumn {
    pub fn is_text(&self) -> bool {
        matches!(
            self.data_type.as_str(),
            "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "json"
        )
    }
}

#[derive(Debug, Clone)]
pub struct DbTable {
    /// Table name in database case.
    pub name: String,
    pub comment: String,
    pub columns: Vec<DbColumn>,
    /// Primary-key columns in index order.
    pub primary_keys: Vec<String>,
    pub modified_at: Option<String>,
}

impl DbTable {
    pub fn column(&self, name: &str) -> Option<&DbColumn> {
        self.columns
            .iter()
            .find(|column| column.name.eq_ignore_ascii_case(name))
    }

    /// The column other tables most likely use to reference a row.
    pub fn key_column(&self) -> Option<&str> {
        let by_name = |name: &str| self.column(name).map(|column| column.name.as_str());
        match self.primary_keys.as_slice() {
            [single] => Some(single.as_str()),
            [] => by_name("ID"),
            keys => keys
                .iter()
                .find(|key| key.eq_ignore_ascii_case("ID"))
                .or_else(|| keys.first())
                .map(String::as_str),
        }
    }

    /// A human-readable column to show next to a referenced key.
    pub fn label_column(&self) -> Option<&str> {
        const PREFERRED: [&str; 6] = ["Name", "Title", "Desc", "Des", "Describe", "Remark"];
        let text_columns = || {
            self.columns
                .iter()
                .filter(|column| column.is_text() && !self.is_primary_key(&column.name))
        };
        PREFERRED
            .iter()
            .find_map(|preferred| text_columns().find(|column| column.name.eq_ignore_ascii_case(preferred)))
            .or_else(|| text_columns().find(|column| column.name.to_lowercase().contains("name")))
            .or_else(|| {
                text_columns().find(|column| {
                    column.comment.contains("名称") || column.comment.contains("名字")
                })
            })
            .map(|column| column.name.as_str())
    }

    fn is_primary_key(&self, column: &str) -> bool {
        self.primary_keys
            .iter()
            .any(|key| key.eq_ignore_ascii_case(column))
    }
}

#[derive(Debug, Clone, Default)]
pub struct DbSnapshot {
    /// Lowercase table name -> table.
    pub tables: BTreeMap<String, DbTable>,
}

impl DbSnapshot {
    pub fn from_metas(metas: Vec<TableMeta>, options: &[TableOption]) -> Self {
        let modified = options
            .iter()
            .map(|option| (option.table_name.to_lowercase(), option.modified_at.clone()))
            .collect::<BTreeMap<_, _>>();
        let tables = metas
            .into_iter()
            .map(|meta| {
                let lower = meta.table_name.to_lowercase();
                let primary_keys = if meta.primary_key_order.is_empty() {
                    meta.columns
                        .iter()
                        .filter(|column| column.is_primary_key)
                        .map(|column| column.column_name.clone())
                        .collect()
                } else {
                    meta.primary_key_order.clone()
                };
                let table = DbTable {
                    columns: meta.columns.iter().map(db_column).collect(),
                    modified_at: modified.get(&lower).cloned().flatten(),
                    name: meta.table_name,
                    comment: meta.table_comment,
                    primary_keys,
                };
                (lower, table)
            })
            .collect();
        Self { tables }
    }

    pub fn table(&self, name: &str) -> Option<&DbTable> {
        self.tables.get(&name.to_lowercase())
    }

    pub fn column_name(&self, table: &str, column: &str) -> Option<&str> {
        self.table(table)?
            .column(column)
            .map(|column| column.name.as_str())
    }

    pub fn table_columns(&self) -> TableColumns {
        self.tables
            .iter()
            .map(|(lower, table)| {
                (
                    lower.clone(),
                    table.columns.iter().map(|column| column.name.clone()).collect(),
                )
            })
            .collect()
    }
}

fn db_column(column: &ColumnMeta) -> DbColumn {
    DbColumn {
        name: column.column_name.clone(),
        data_type: column
            .data_type
            .clone()
            .unwrap_or_else(|| column.column_type.to_ascii_lowercase()),
        comment: column.column_comment.clone(),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// `columns`: (name, data type, comment, is primary key).
    pub fn table(name: &str, columns: &[(&str, &str, &str, bool)]) -> DbTable {
        DbTable {
            name: name.into(),
            comment: String::new(),
            columns: columns
                .iter()
                .map(|(column, data_type, comment, _)| DbColumn {
                    name: (*column).into(),
                    data_type: (*data_type).into(),
                    comment: (*comment).into(),
                })
                .collect(),
            primary_keys: columns
                .iter()
                .filter(|(_, _, _, key)| *key)
                .map(|(column, ..)| (*column).to_string())
                .collect(),
            modified_at: None,
        }
    }

    pub fn snapshot(tables: Vec<DbTable>) -> DbSnapshot {
        DbSnapshot {
            tables: tables
                .into_iter()
                .map(|table| (table.name.to_lowercase(), table))
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;

    #[test]
    fn key_column_prefers_single_or_id_primary_key() {
        let single = table("goodsprop", &[("ID", "int", "", true), ("Name", "varchar", "", false)]);
        assert_eq!(single.key_column(), Some("ID"));
        let composite = table("skillprop", &[("HeroID", "int", "", true), ("ID", "int", "", true)]);
        assert_eq!(composite.key_column(), Some("ID"));
        let keyless = table("misc", &[("id", "int", "", false)]);
        assert_eq!(keyless.key_column(), Some("id"));
    }

    #[test]
    fn label_column_prefers_name_like_text_columns() {
        let goods = table(
            "goodsprop",
            &[("ID", "int", "", true), ("Icon", "varchar", "", false), ("ItemName", "varchar", "", false)],
        );
        assert_eq!(goods.label_column(), Some("ItemName"));
        let titled = table("taskprop", &[("ID", "int", "", true), ("Title", "varchar", "", false)]);
        assert_eq!(titled.label_column(), Some("Title"));
        let commented = table("buffprop", &[("ID", "int", "", true), ("Txt", "varchar", "名称", false)]);
        assert_eq!(commented.label_column(), Some("Txt"));
        let bare = table("numbers", &[("ID", "int", "", true), ("Val", "int", "", false)]);
        assert_eq!(bare.label_column(), None);
    }
}
