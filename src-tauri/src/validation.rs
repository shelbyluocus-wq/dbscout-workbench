use std::collections::HashMap;

use crate::types::{ColumnMeta, TableMeta};

const PRIMARY_KEY_DUPLICATE_MESSAGE: &str = "主键重复，不能保存";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    pub code: String,
    pub column_name: String,
    pub message: String,
    pub short_message: String,
}

fn err(code: &str, column_name: &str, message: String, short: &str) -> ValidationError {
    ValidationError {
        code: code.into(),
        column_name: column_name.into(),
        message,
        short_message: short.into(),
    }
}

fn normalized_type(column: &ColumnMeta) -> String {
    let parsed = column
        .column_type
        .trim()
        .to_ascii_lowercase()
        .split(|ch: char| ch == '(' || ch.is_whitespace())
        .find(|part| !part.is_empty())
        .unwrap_or("")
        .to_string();
    let data_type = column
        .data_type
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(parsed)
        .trim()
        .to_ascii_lowercase();
    if data_type == "tinyint" && parse_type_numbers(&column.column_type).0 == Some(1) {
        "tinyint(1)".into()
    } else {
        data_type
    }
}

fn parse_type_numbers(column_type: &str) -> (Option<usize>, Option<usize>) {
    let Some(open) = column_type.find('(') else {
        return (None, None);
    };
    let Some(close) = column_type.rfind(')') else {
        return (None, None);
    };
    let mut parts = column_type[open + 1..close]
        .split(',')
        .map(|part| part.trim().parse::<usize>().ok());
    (parts.next().flatten(), parts.next().flatten())
}

fn primary_keys(table: &TableMeta) -> Vec<String> {
    table
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.clone())
        .collect()
}

fn row_value<'a>(row: &'a HashMap<String, String>, key: &str) -> &'a str {
    row.get(key).map(String::as_str).unwrap_or("")
}

fn pk_signature(row: &HashMap<String, String>, keys: &[String]) -> Option<Vec<String>> {
    if keys.is_empty() {
        return None;
    }
    let values = keys
        .iter()
        .map(|key| row_value(row, key).trim().to_string())
        .collect::<Vec<_>>();
    if values.iter().all(|value| !value.is_empty()) {
        Some(values)
    } else {
        None
    }
}

fn validation_value<'a>(value: Option<&'a String>) -> &'a str {
    value.map(String::as_str).unwrap_or("").trim()
}

fn omitted_value_can_use_backend_default(column: &ColumnMeta, value: Option<&String>) -> bool {
    if value.is_some() {
        return false;
    }
    column.is_auto_increment
        || column.is_generated
        || column
            .default_mode
            .as_deref()
            .map(|mode| !mode.trim().is_empty() && mode != "none")
            .unwrap_or(false)
}

fn validate_required(column: &ColumnMeta, value: Option<&String>) -> Result<(), ValidationError> {
    if omitted_value_can_use_backend_default(column, value) {
        return Ok(());
    }
    let missing_required = (column.is_primary_key || !column.is_nullable)
        && match value {
            None => true,
            Some(value) => value.trim().is_empty() && !accepts_explicit_empty_value(column),
        };
    if missing_required {
        return Err(err(
            "required",
            &column.column_name,
            format!("字段 {} 不能为空", column.column_name),
            "不能为空",
        ));
    }
    Ok(())
}

fn accepts_explicit_empty_value(column: &ColumnMeta) -> bool {
    if column.is_primary_key {
        return false;
    }
    matches!(
        normalized_type(column).as_str(),
        "char" | "varchar" | "binary" | "varbinary" | "enum" | "set"
    )
}

fn integer_range(typ: &str, unsigned: bool) -> Option<(i128, i128)> {
    let (signed_min, signed_max, unsigned_max) = match typ {
        "tinyint" => (-128, 127, 255),
        "smallint" => (-32768, 32767, 65535),
        "mediumint" => (-8388608, 8388607, 16777215),
        "int" | "integer" => (-2147483648, 2147483647, 4294967295),
        "bigint" => (
            -9223372036854775808_i128,
            9223372036854775807_i128,
            18446744073709551615_i128,
        ),
        _ => return None,
    };
    Some(if unsigned {
        (0, unsigned_max)
    } else {
        (signed_min, signed_max)
    })
}

fn decimal_parts(raw: &str) -> (&str, &str) {
    let normalized = raw.trim_start_matches('-');
    let (whole, fractional) = normalized.split_once('.').unwrap_or((normalized, ""));
    (whole.trim_start_matches('0'), fractional)
}

fn validate_integer(column: &ColumnMeta, typ: &str, raw: &str) -> Result<(), ValidationError> {
    if !raw
        .chars()
        .enumerate()
        .all(|(index, ch)| ch.is_ascii_digit() || (index == 0 && ch == '-'))
        || raw == "-"
    {
        return Err(err(
            "invalid-integer",
            &column.column_name,
            format!("字段 {} 需要整数", column.column_name),
            "整数格式错误",
        ));
    }
    let numeric = raw.parse::<i128>().map_err(|_| {
        err(
            "invalid-integer",
            &column.column_name,
            format!("字段 {} 需要整数", column.column_name),
            "整数格式错误",
        )
    })?;
    if let Some((min, max)) = integer_range(typ, column.is_unsigned) {
        if numeric < min || numeric > max {
            return Err(err(
                "integer-range",
                &column.column_name,
                format!("字段 {} 数值超出范围", column.column_name),
                "数值超范围",
            ));
        }
    }
    Ok(())
}

fn validate_decimal(column: &ColumnMeta, raw: &str) -> Result<(), ValidationError> {
    let valid = raw
        .chars()
        .enumerate()
        .all(|(index, ch)| ch.is_ascii_digit() || ch == '.' || (index == 0 && ch == '-'))
        && raw.matches('.').count() <= 1
        && raw.chars().any(|ch| ch.is_ascii_digit());
    if !valid {
        return Err(err(
            "invalid-decimal",
            &column.column_name,
            format!("字段 {} 需要数字", column.column_name),
            "数字格式错误",
        ));
    }
    let (parsed_precision, parsed_scale) = parse_type_numbers(&column.column_type);
    let precision = column
        .numeric_precision
        .map(|value| value as usize)
        .or(parsed_precision);
    let scale = column
        .numeric_scale
        .map(|value| value as usize)
        .or(parsed_scale);
    let (whole, fractional) = decimal_parts(raw);
    if let Some(scale) = scale {
        if fractional.len() > scale {
            return Err(err(
                "decimal-scale",
                &column.column_name,
                format!("字段 {} 小数位最多 {} 位", column.column_name, scale),
                "小数位超限",
            ));
        }
    }
    if let Some(precision) = precision {
        if whole.len() + fractional.len() > precision {
            return Err(err(
                "decimal-precision",
                &column.column_name,
                format!("字段 {} 精度最多 {} 位", column.column_name, precision),
                "精度超限",
            ));
        }
        if let Some(scale) = scale {
            if whole.len() > precision.saturating_sub(scale) {
                return Err(err(
                    "decimal-precision",
                    &column.column_name,
                    format!(
                        "字段 {} 整数位最多 {} 位",
                        column.column_name,
                        precision.saturating_sub(scale)
                    ),
                    "精度超限",
                ));
            }
        }
    }
    if column.is_unsigned && raw.starts_with('-') {
        return Err(err(
            "decimal-range",
            &column.column_name,
            format!("字段 {} 不能为负数", column.column_name),
            "数值超范围",
        ));
    }
    Ok(())
}

fn validate_float(column: &ColumnMeta, raw: &str) -> Result<(), ValidationError> {
    let numeric = raw.parse::<f64>().map_err(|_| {
        err(
            "invalid-float",
            &column.column_name,
            format!("字段 {} 需要数字", column.column_name),
            "数字格式错误",
        )
    })?;
    if column.is_unsigned && numeric < 0.0 {
        return Err(err(
            "float-range",
            &column.column_name,
            format!("字段 {} 不能为负数", column.column_name),
            "数值超范围",
        ));
    }
    Ok(())
}

fn validate_length(column: &ColumnMeta, raw: &str) -> Result<(), ValidationError> {
    let (parsed_len, _) = parse_type_numbers(&column.column_type);
    let max = column
        .character_maximum_length
        .map(|value| value as usize)
        .or(parsed_len);
    if let Some(max) = max {
        if raw.chars().count() > max {
            return Err(err(
                "length-overflow",
                &column.column_name,
                format!("字段 {} 最多 {} 个字符", column.column_name, max),
                "长度超限",
            ));
        }
    }
    Ok(())
}

fn validate_json(column: &ColumnMeta, raw: &str) -> Result<(), ValidationError> {
    serde_json::from_str::<serde_json::Value>(raw).map_err(|_| {
        err(
            "invalid-json",
            &column.column_name,
            format!("字段 {} 需要合法 JSON", column.column_name),
            "JSON 格式错误",
        )
    })?;
    Ok(())
}

fn validate_date_like(column: &ColumnMeta, typ: &str, raw: &str) -> Result<(), ValidationError> {
    let valid = match typ {
        "date" => is_date(raw),
        "datetime" | "timestamp" => is_datetime(raw),
        "time" => is_time(raw),
        "year" => raw.len() == 4 && raw.chars().all(|ch| ch.is_ascii_digit()),
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(err(
            &format!("invalid-{typ}"),
            &column.column_name,
            format!("字段 {} 需要 {} 格式", column.column_name, typ),
            "日期时间格式错误",
        ))
    }
}

fn validate_enum_set(column: &ColumnMeta, typ: &str, raw: &str) -> Result<(), ValidationError> {
    if typ == "enum"
        && !column.enum_values.is_empty()
        && !column.enum_values.iter().any(|item| item == raw)
    {
        return Err(err(
            "invalid-enum",
            &column.column_name,
            format!(
                "字段 {} 必须是：{}",
                column.column_name,
                column.enum_values.join("、")
            ),
            "枚举值错误",
        ));
    }
    if typ == "set"
        && !column.set_values.is_empty()
        && raw
            .split(',')
            .map(str::trim)
            .any(|item| !column.set_values.iter().any(|allowed| allowed == item))
    {
        return Err(err(
            "invalid-set",
            &column.column_name,
            format!(
                "字段 {} 只能包含：{}",
                column.column_name,
                column.set_values.join("、")
            ),
            "集合值错误",
        ));
    }
    Ok(())
}

fn validate_scalar(column: &ColumnMeta, value: Option<&String>) -> Result<(), ValidationError> {
    validate_required(column, value)?;
    let raw = validation_value(value);
    if raw.is_empty() {
        return Ok(());
    }
    let typ = normalized_type(column);
    match typ.as_str() {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" => {
            validate_integer(column, &typ, raw)
        }
        "decimal" | "numeric" | "dec" | "fixed" => validate_decimal(column, raw),
        "float" | "double" | "real" => validate_float(column, raw),
        "char" | "varchar" | "binary" | "varbinary" => validate_length(column, raw),
        "json" => validate_json(column, raw),
        "date" | "datetime" | "timestamp" | "time" | "year" => {
            validate_date_like(column, &typ, raw)
        }
        "bool" | "boolean" | "tinyint(1)" => {
            if matches!(
                raw.to_ascii_lowercase().as_str(),
                "0" | "1" | "true" | "false"
            ) {
                Ok(())
            } else {
                Err(err(
                    "invalid-boolean",
                    &column.column_name,
                    format!("字段 {} 需要布尔值 0/1/true/false", column.column_name),
                    "布尔格式错误",
                ))
            }
        }
        "enum" | "set" => validate_enum_set(column, &typ, raw),
        _ => Ok(()),
    }
}

fn is_date(value: &str) -> bool {
    let parts = value.split('-').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return false;
    }
    let Ok(year) = parts[0].parse::<i32>() else {
        return false;
    };
    let Ok(month) = parts[1].parse::<u32>() else {
        return false;
    };
    let Ok(day) = parts[2].parse::<u32>() else {
        return false;
    };
    if !(1..=12).contains(&month) {
        return false;
    }
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    };
    (1..=max_day).contains(&day)
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn is_datetime(value: &str) -> bool {
    let Some((date, time)) = value.split_once(' ').or_else(|| value.split_once('T')) else {
        return false;
    };
    is_date(date) && is_time(time)
}

fn is_time(value: &str) -> bool {
    let time = value.trim_start_matches('-');
    let time = time.split_once('.').map(|(base, _)| base).unwrap_or(time);
    let parts = time.split(':').collect::<Vec<_>>();
    if parts.len() != 3 {
        return false;
    }
    let Ok(hours) = parts[0].parse::<u32>() else {
        return false;
    };
    let Ok(minutes) = parts[1].parse::<u32>() else {
        return false;
    };
    let Ok(seconds) = parts[2].parse::<u32>() else {
        return false;
    };
    hours <= 838 && minutes <= 59 && seconds <= 59
}

pub fn validate_cell_value(
    table: &TableMeta,
    rows: &[HashMap<String, String>],
    row_index: usize,
    column_name: &str,
    value: &str,
) -> Result<(), ValidationError> {
    let Some(column) = table
        .columns
        .iter()
        .find(|column| column.column_name == column_name)
    else {
        return Ok(());
    };
    let value = value.to_string();
    validate_scalar(column, Some(&value))?;
    let keys = primary_keys(table);
    if keys.iter().any(|key| key == column_name) {
        let Some(row) = rows.get(row_index) else {
            return Ok(());
        };
        let mut next = row.clone();
        next.insert(column_name.into(), value);
        if let Some(signature) = pk_signature(&next, &keys) {
            let duplicate = rows.iter().enumerate().any(|(index, candidate)| {
                index != row_index
                    && pk_signature(candidate, &keys)
                        .map(|candidate_signature| candidate_signature == signature)
                        .unwrap_or(false)
            });
            if duplicate {
                return Err(err(
                    "duplicate-primary-key",
                    column_name,
                    PRIMARY_KEY_DUPLICATE_MESSAGE.into(),
                    "主键重复",
                ));
            }
        }
    }
    Ok(())
}

pub fn validate_column_value(
    table: &TableMeta,
    column_name: &str,
    value: &str,
) -> Result<(), ValidationError> {
    let Some(column) = table
        .columns
        .iter()
        .find(|column| column.column_name == column_name)
    else {
        return Ok(());
    };
    let value = value.to_string();
    validate_scalar(column, Some(&value))
}

pub fn validate_row_draft(
    table: &TableMeta,
    rows: &[HashMap<String, String>],
    draft: &HashMap<String, String>,
) -> Result<(), ValidationError> {
    for column in &table.columns {
        validate_scalar(column, draft.get(&column.column_name))?;
    }
    let keys = primary_keys(table);
    if let Some(signature) = pk_signature(draft, &keys) {
        let duplicate = rows.iter().any(|row| {
            pk_signature(row, &keys)
                .map(|candidate| candidate == signature)
                .unwrap_or(false)
        });
        if duplicate {
            return Err(err(
                "duplicate-primary-key",
                keys.first().map(String::as_str).unwrap_or(""),
                PRIMARY_KEY_DUPLICATE_MESSAGE.into(),
                "主键重复",
            ));
        }
    }
    Ok(())
}

pub fn mysql_error_code_message(code: &str) -> Option<String> {
    match code {
        "1062" => Some(PRIMARY_KEY_DUPLICATE_MESSAGE.into()),
        "1048" => Some("字段不能为空".into()),
        "1264" => Some("数值超出范围".into()),
        "1366" => Some("字段类型不匹配".into()),
        "1406" => Some("字段长度超限".into()),
        "1292" => Some("日期或时间格式错误".into()),
        _ => None,
    }
}

pub fn mysql_error_message(error: &sqlx::Error) -> Option<String> {
    match error {
        sqlx::Error::Database(db_error) => db_error
            .code()
            .as_deref()
            .and_then(mysql_error_code_message),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::types::{ColumnMeta, TableMeta};

    fn cm(name: &str, column_type: &str, nullable: bool, primary_key: bool) -> ColumnMeta {
        ColumnMeta::with_basic(name, column_type, "", primary_key, nullable)
    }

    fn table(columns: Vec<ColumnMeta>) -> TableMeta {
        TableMeta {
            table_name: "player".into(),
            table_comment: String::new(),
            columns,
        }
    }

    #[test]
    fn validate_cell_value_rejects_scalar_type_errors() {
        let meta = table(vec![
            cm("id", "int", false, true),
            cm("level", "int", false, false),
        ]);
        let rows = vec![HashMap::from([
            ("id".into(), "1".into()),
            ("level".into(), "10".into()),
        ])];

        let err = crate::validation::validate_cell_value(&meta, &rows, 0, "level", "abc")
            .expect_err("invalid integer should fail");

        assert_eq!(err.code, "invalid-integer");
        assert_eq!(err.column_name, "level");
    }

    #[test]
    fn validate_column_value_rejects_scalar_errors_without_loaded_rows() {
        let meta = table(vec![cm("level", "int", false, false)]);

        let err = crate::validation::validate_column_value(&meta, "level", "abc")
            .expect_err("invalid integer should fail");

        assert_eq!(err.code, "invalid-integer");
    }

    #[test]
    fn validate_row_draft_rejects_duplicate_primary_keys_and_required_values() {
        let meta = table(vec![
            cm("id", "int", false, true),
            cm("name", "varchar(4)", false, false),
        ]);
        let rows = vec![HashMap::from([
            ("id".into(), "1".into()),
            ("name".into(), "Ada".into()),
        ])];

        let duplicate = crate::validation::validate_row_draft(
            &meta,
            &rows,
            &HashMap::from([("id".into(), "1".into()), ("name".into(), "Bob".into())]),
        )
        .expect_err("duplicate primary key should fail");
        let missing = crate::validation::validate_row_draft(
            &meta,
            &rows,
            &HashMap::from([("id".into(), "2".into())]),
        )
        .expect_err("missing required field should fail");

        assert_eq!(duplicate.code, "duplicate-primary-key");
        assert_eq!(missing.code, "required");
    }

    #[test]
    fn validate_row_draft_accepts_explicit_empty_non_null_string_values() {
        let meta = table(vec![
            cm("id", "int", false, true),
            cm("title", "varchar(255)", false, false),
        ]);

        let result = crate::validation::validate_row_draft(
            &meta,
            &[],
            &HashMap::from([("id".into(), "1".into()), ("title".into(), "".into())]),
        );

        assert!(result.is_ok());
    }

    #[test]
    fn validate_row_draft_allows_omitted_auto_increment_and_defaulted_fields() {
        let mut id = cm("id", "int", false, true);
        id.is_auto_increment = true;
        let mut created_at = cm("created_at", "datetime", false, false);
        created_at.default_mode = Some("expression".into());
        let meta = table(vec![id, created_at, cm("name", "varchar(8)", false, false)]);

        let result = crate::validation::validate_row_draft(
            &meta,
            &[],
            &HashMap::from([("name".into(), "alice".into())]),
        );

        assert!(result.is_ok());
    }

    #[test]
    fn validate_row_draft_rejects_explicit_empty_defaulted_fields() {
        let mut id = cm("id", "int", false, true);
        id.is_auto_increment = true;
        let meta = table(vec![id, cm("name", "varchar(8)", false, false)]);

        let err = crate::validation::validate_row_draft(
            &meta,
            &[],
            &HashMap::from([("id".into(), "".into()), ("name".into(), "alice".into())]),
        )
        .expect_err("explicit empty auto increment should fail");

        assert_eq!(err.code, "required");
    }

    #[test]
    fn mysql_error_code_message_maps_common_write_failures() {
        assert!(crate::validation::mysql_error_code_message("1062")
            .unwrap()
            .contains("主键"));
        assert!(crate::validation::mysql_error_code_message("1048")
            .unwrap()
            .contains("不能为空"));
        assert!(crate::validation::mysql_error_code_message("1366")
            .unwrap()
            .contains("类型"));
    }
}
