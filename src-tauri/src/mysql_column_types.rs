pub(crate) fn normalize_data_type(value: &str) -> String {
    let raw = value.trim().to_ascii_lowercase();
    raw.split(|ch: char| ch == '(' || ch.is_whitespace())
        .find(|part| !part.is_empty())
        .unwrap_or("")
        .to_string()
}

pub(crate) fn supports_table_design(value: &str) -> bool {
    matches!(
        normalize_data_type(value).as_str(),
        "char"
            | "varchar"
            | "binary"
            | "varbinary"
            | "bit"
            | "decimal"
            | "numeric"
            | "dec"
            | "fixed"
            | "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "float"
            | "double"
            | "real"
            | "tinytext"
            | "text"
            | "mediumtext"
            | "longtext"
            | "json"
            | "tinyblob"
            | "blob"
            | "mediumblob"
            | "longblob"
            | "date"
            | "datetime"
            | "timestamp"
            | "time"
            | "year"
            | "bool"
            | "boolean"
            | "enum"
            | "set"
    )
}

#[cfg(test)]
mod tests {
    use super::{normalize_data_type, supports_table_design};

    #[test]
    fn normalizes_mysql_type_declarations() {
        assert_eq!(normalize_data_type(" VARCHAR(255) "), "varchar");
        assert_eq!(normalize_data_type("BIGINT UNSIGNED"), "bigint");
        assert_eq!(normalize_data_type("enum('new','done')"), "enum");
    }

    #[test]
    fn table_design_support_includes_existing_enum_and_set_columns() {
        assert!(supports_table_design("enum('new','done')"));
        assert!(supports_table_design("SET('read','write')"));
        assert!(!supports_table_design("geometry"));
    }
}
