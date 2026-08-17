use crate::types::ColumnMeta;

pub fn compare_sort_values(left: &str, right: &str) -> std::cmp::Ordering {
    match (left.parse::<f64>(), right.parse::<f64>()) {
        (Ok(num_a), Ok(num_b)) if num_a.is_finite() && num_b.is_finite() => {
            match num_a.partial_cmp(&num_b) {
                Some(std::cmp::Ordering::Equal) | None => compare_natural(left, right),
                Some(order) => order,
            }
        }
        _ => compare_natural(left, right),
    }
}

fn compare_natural(left: &str, right: &str) -> std::cmp::Ordering {
    let a = left.chars().collect::<Vec<_>>();
    let b = right.chars().collect::<Vec<_>>();
    let mut i = 0;
    let mut j = 0;
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let (value_a, next_i) = read_unsigned(&a, i);
            let (value_b, next_j) = read_unsigned(&b, j);
            match value_a.cmp(&value_b) {
                std::cmp::Ordering::Equal => {
                    i = next_i;
                    j = next_j;
                }
                order => return order,
            }
            continue;
        }
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Equal => {
                i += 1;
                j += 1;
            }
            order => return order,
        }
    }
    match (i == a.len(), j == b.len()) {
        (true, true) => left.cmp(right),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => std::cmp::Ordering::Equal,
    }
}

fn read_unsigned(chars: &[char], start: usize) -> (u128, usize) {
    let mut index = start;
    while index < chars.len() && chars[index] == '0' {
        index += 1;
    }
    let digits_start = index;
    while index < chars.len() && chars[index].is_ascii_digit() {
        index += 1;
    }
    let value = chars[digits_start..index]
        .iter()
        .collect::<String>()
        .parse::<u128>()
        .unwrap_or(0);
    (value, index)
}

pub fn is_textual_sort_column(column: &ColumnMeta) -> bool {
    is_textual_sort_type(
        column
            .data_type
            .as_deref()
            .unwrap_or(column.column_type.as_str()),
    )
}

pub fn is_textual_sort_type(column_type: &str) -> bool {
    matches!(
        unwrap_type_name(column_type).as_str(),
        "char"
            | "varchar"
            | "nchar"
            | "nvarchar"
            | "tinytext"
            | "text"
            | "mediumtext"
            | "longtext"
            | "enum"
            | "set"
            | "json"
            | "string"
            | "fixedstring"
            | "enum8"
            | "enum16"
    )
}

fn unwrap_type_name(column_type: &str) -> String {
    let mut current = column_type.trim().to_ascii_lowercase();
    loop {
        let stripped = unwrap_wrapper(&current);
        if stripped == current {
            break;
        }
        current = stripped;
    }
    current
        .split(|ch: char| ch == '(' || ch.is_whitespace())
        .find(|part| !part.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn unwrap_wrapper(value: &str) -> String {
    for wrapper in ["nullable", "lowcardinality"] {
        let prefix = format!("{wrapper}(");
        if value.starts_with(&prefix) && value.ends_with(')') {
            return value[prefix.len()..value.len() - 1].trim().to_string();
        }
    }
    value.to_string()
}

pub fn mysql_order_by_terms(qualified_column: &str, descending: bool, textual: bool) -> String {
    let direction = if descending { "DESC" } else { "ASC" };
    if !textual {
        return format!("{qualified_column} {direction}");
    }
    let src = format!("IFNULL(CAST({qualified_column} AS CHAR),'')");
    let pos = first_digit_pos_sql(&src);
    format!(
        "IF(({pos})>=65535,{src},LEFT({src},({pos})-1)) {direction}, CAST(IF(({pos})>=65535,'0',SUBSTRING({src},({pos}))) AS DECIMAL(40,0)) {direction}, {qualified_column} {direction}"
    )
}

pub fn clickhouse_order_by_terms(quoted_column: &str, descending: bool, textual: bool) -> String {
    let direction = if descending { "DESC" } else { "ASC" };
    if !textual {
        return format!("{quoted_column} {direction}");
    }
    let src = format!("ifNull(toString({quoted_column}), '')");
    format!(
        "extract({src}, '^([^0-9]*)') {direction}, toUInt64OrZero(extract({src}, '([0-9]+)')) {direction}, {quoted_column} {direction}"
    )
}

fn first_digit_pos_sql(expr: &str) -> String {
    let locates = (b'0'..=b'9')
        .map(|digit| {
            let ch = char::from(digit);
            format!("IF(LOCATE('{ch}',{expr})=0,65535,LOCATE('{ch}',{expr}))")
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("LEAST({locates})")
}

#[cfg(test)]
mod tests {
    use super::{
        clickhouse_order_by_terms, compare_sort_values, is_textual_sort_type, mysql_order_by_terms,
    };
    use crate::types::ColumnMeta;

    #[test]
    fn compare_sort_values_keeps_whole_numbers_in_numeric_order() {
        assert_eq!(compare_sort_values("9", "10"), std::cmp::Ordering::Less);
        assert_eq!(compare_sort_values("10", "9"), std::cmp::Ordering::Greater);
        assert_eq!(compare_sort_values("2", "2"), std::cmp::Ordering::Equal);
    }

    #[test]
    fn compare_sort_values_orders_letter_plus_number_ids_naturally() {
        let mut values = vec!["C20028", "C111", "C10", "C12", "C11"];
        values.sort_by(|left, right| compare_sort_values(left, right));
        assert_eq!(values, vec!["C10", "C11", "C12", "C111", "C20028"]);
    }

    #[test]
    fn textual_type_detection_covers_mysql_and_clickhouse_strings() {
        assert!(is_textual_sort_type("varchar(32)"));
        assert!(is_textual_sort_type("String"));
        assert!(is_textual_sort_type("LowCardinality(Nullable(String))"));
        assert!(is_textual_sort_type("enum('a','b')"));
        assert!(!is_textual_sort_type("int"));
        assert!(!is_textual_sort_type("UInt64"));
        assert!(!is_textual_sort_type("datetime"));
        assert!(!is_textual_sort_type("decimal(10,2)"));
    }

    #[test]
    fn mysql_text_sort_uses_prefix_and_first_number() {
        let sql = mysql_order_by_terms("`activecondprop`.`CondID`", false, true);
        assert!(sql.contains("LEFT("));
        assert!(sql.contains("DECIMAL(40,0)"));
        assert!(sql.contains("LOCATE('0'"));
        assert!(sql.contains("`activecondprop`.`CondID` ASC"));
        assert!(!sql.contains("DESC"));
    }

    #[test]
    fn mysql_numeric_sort_stays_on_the_real_column() {
        assert_eq!(
            mysql_order_by_terms("`hero`.`id`", true, false),
            "`hero`.`id` DESC"
        );
    }

    #[test]
    fn clickhouse_text_sort_extracts_the_first_number() {
        let sql = clickhouse_order_by_terms("\"user_name\"", true, true);
        assert!(sql.contains("extract(ifNull(toString(\"user_name\"), ''), '^([^0-9]*)') DESC"));
        assert!(sql.contains("toUInt64OrZero(extract("));
        assert!(sql.ends_with("\"user_name\" DESC"));
    }

    #[test]
    fn clickhouse_numeric_sort_stays_on_the_real_column() {
        assert_eq!(
            clickhouse_order_by_terms("\"event_id\"", true, false),
            "\"event_id\" DESC"
        );
    }

    #[test]
    fn varchar_primary_key_is_textual() {
        let column = ColumnMeta::with_basic("CondID", "varchar(32)", "", true, false);
        assert!(super::is_textual_sort_column(&column));
    }
}
