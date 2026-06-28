use std::collections::{HashMap, HashSet};

use crate::db::escape_ident;
use crate::types::*;

fn design_source(current: &TableDesignMeta) -> &TableDesignSource {
    &current.source
}

fn source_matches(
    current: &TableDesignMeta,
    connection_id: &str,
    database: &str,
    table_name: &str,
) -> bool {
    current.source.connection_id == connection_id
        && current.source.database == database
        && current.source.table_name == table_name
}

fn validate_identifier(value: &str) -> Result<(), String> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err("identifier must not be empty".into());
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return Err(format!("invalid identifier: {value}"));
    }
    if chars.any(|ch| !(ch == '_' || ch.is_ascii_alphanumeric())) {
        return Err(format!("invalid identifier: {value}"));
    }
    Ok(())
}

fn validate_expression(value: &str) -> Result<(), String> {
    let normalized = value.trim().to_ascii_uppercase();
    if normalized.is_empty() {
        return Err("default expression must not be empty".into());
    }
    if !matches!(
        normalized.as_str(),
        "CURRENT_TIMESTAMP"
            | "CURRENT_TIMESTAMP()"
            | "CURRENT_DATE"
            | "CURRENT_DATE()"
            | "CURRENT_TIME"
            | "CURRENT_TIME()"
    ) {
        return Err("default expression is not allowed".into());
    }
    Ok(())
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

fn normalized_type(value: &str) -> String {
    let raw = value.trim().to_ascii_lowercase();
    raw.split(|ch: char| ch == '(' || ch.is_whitespace())
        .find(|part| !part.is_empty())
        .unwrap_or("")
        .to_string()
}

fn supports_type(data_type: &str) -> bool {
    matches!(
        normalized_type(data_type).as_str(),
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

fn needs_length(data_type: &str) -> bool {
    matches!(
        normalized_type(data_type).as_str(),
        "char" | "varchar" | "binary" | "varbinary" | "bit"
    )
}

fn supports_scale(data_type: &str) -> bool {
    matches!(
        normalized_type(data_type).as_str(),
        "decimal" | "numeric" | "dec" | "fixed"
    )
}

fn has_type_modifier(column_type: &str, modifier: &str) -> bool {
    column_type
        .to_ascii_lowercase()
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
        .any(|part| part == modifier)
}

fn supports_unsigned_modifier(data_type: &str) -> bool {
    matches!(
        normalized_type(data_type).as_str(),
        "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "decimal"
            | "numeric"
            | "dec"
            | "fixed"
            | "float"
            | "double"
            | "real"
    )
}

fn supports_auto_increment(data_type: &str) -> bool {
    matches!(
        normalized_type(data_type).as_str(),
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint"
    )
}

fn has_auto_increment_extra(extra: &str) -> bool {
    extra.replace(',', " ")
        .split_whitespace()
        .any(|part| part.eq_ignore_ascii_case("auto_increment"))
}

fn preserved_type_modifier_sql(draft: &ColumnDesignDraft, current: &ColumnDesignMeta) -> String {
    if has_type_modifier(&current.column_type, "unsigned")
        && supports_unsigned_modifier(&draft.data_type)
    {
        " unsigned".into()
    } else {
        String::new()
    }
}

pub fn column_type_sql(draft: &ColumnDesignDraft) -> Result<String, String> {
    validate_identifier(&draft.name)?;
    let data_type = normalized_type(&draft.data_type);
    if !supports_type(&data_type) {
        return Err(format!("unsupported type: {}", draft.data_type));
    }
    if needs_length(&data_type) {
        let length = draft
            .length
            .ok_or_else(|| format!("type {data_type} requires length"))?;
        if length == 0 {
            return Err(format!("type {data_type} requires positive length"));
        }
        return Ok(format!("{data_type}({length})"));
    }
    if supports_scale(&data_type) {
        if let Some(length) = draft.length {
            if length == 0 {
                return Err(format!("type {data_type} requires positive precision"));
            }
            if let Some(scale) = draft.scale {
                return Ok(format!("{data_type}({length},{scale})"));
            }
            return Ok(format!("{data_type}({length})"));
        }
    }
    Ok(data_type)
}

fn column_type_definition_sql(
    draft: &ColumnDesignDraft,
    current: &ColumnDesignMeta,
) -> Result<String, String> {
    let generated_type = column_type_sql(draft)?;
    let current_draft = current_as_draft(current);
    if !current.column_type.trim().is_empty() && column_type_sql(&current_draft)? == generated_type
    {
        return Ok(current.column_type.trim().to_string());
    }
    Ok(format!(
        "{}{}",
        generated_type,
        preserved_type_modifier_sql(draft, current)
    ))
}

fn default_sql(draft: &ColumnDesignDraft) -> Result<String, String> {
    match draft.default_mode.trim().to_ascii_lowercase().as_str() {
        "" | "none" => Ok(String::new()),
        "null" => {
            if draft.primary_key || !draft.nullable {
                Err("NULL default requires a nullable non-primary-key column".into())
            } else {
                Ok(" DEFAULT NULL".into())
            }
        }
        "value" => Ok(format!(
            " DEFAULT {}",
            sql_string(draft.default_value.as_deref().unwrap_or_default())
        )),
        "expression" => {
            let value = draft.default_value.as_deref().unwrap_or_default().trim();
            validate_expression(value)?;
            Ok(format!(" DEFAULT {value}"))
        }
        other => Err(format!("unsupported default mode: {other}")),
    }
}

fn safe_column_extra_sql(current: &ColumnDesignMeta) -> String {
    if has_auto_increment_extra(&current.extra) {
        " AUTO_INCREMENT".into()
    } else {
        String::new()
    }
}

pub fn column_definition_sql(
    draft: &ColumnDesignDraft,
    current: &ColumnDesignMeta,
) -> Result<String, String> {
    let column_type = column_type_definition_sql(draft, current)?;
    let nullable_sql = if draft.primary_key || !draft.nullable {
        "NOT NULL"
    } else {
        "NULL"
    };
    let default_sql = default_sql(draft)?;
    let extra_sql = safe_column_extra_sql(current);
    let comment_sql = if draft.comment.is_empty() {
        String::new()
    } else {
        format!(" COMMENT {}", sql_string(&draft.comment))
    };
    Ok(format!(
        "{column_type} {nullable_sql}{default_sql}{extra_sql}{comment_sql}"
    ))
}

fn canonical_source(source: &TableDesignSource) -> String {
    format!(
        "{}|{}|{}",
        source.connection_id, source.database, source.table_name
    )
}

fn canonical_meta(current: &TableDesignMeta) -> String {
    let columns = current
        .columns
        .iter()
        .map(|column| {
            format!(
                "{}:{}:{}:{:?}:{:?}:{}:{}:{}:{:?}:{}:{}:{}:{:?}",
                column.ordinal,
                column.column_name,
                column.column_type,
                column.length,
                column.scale,
                column.is_nullable,
                column.is_primary_key,
                column.default_mode,
                column.default_value,
                column.column_comment,
                column.extra,
                column.is_generated,
                column.generation_expression,
            )
        })
        .collect::<Vec<_>>()
        .join(";");
    format!(
        "source={}|comment={}|columns={columns}",
        canonical_source(design_source(current)),
        current.table_comment
    )
}

fn canonical_draft(draft: &TableDesignDraft) -> String {
    let columns = draft
        .columns
        .iter()
        .map(|column| {
            format!(
                "{}>{}:{}:{:?}:{:?}:{}:{}:{}:{:?}:{}",
                column.original_name,
                column.name,
                normalized_type(&column.data_type),
                column.length,
                column.scale,
                column.nullable,
                column.primary_key,
                column.default_mode,
                column.default_value,
                column.comment,
            )
        })
        .collect::<Vec<_>>()
        .join(";");
    format!("comment={}|columns={columns}", draft.table_comment)
}

pub fn schema_signature(current: &TableDesignMeta) -> String {
    format!("schema:{}", canonical_meta(current))
}

pub fn preview_signature(
    current: &TableDesignMeta,
    draft: &TableDesignDraft,
    statements: &[String],
) -> String {
    format!(
        "preview:{}|{}|sql={}",
        schema_signature(current),
        canonical_draft(draft),
        statements.join(";")
    )
}

fn parse_type_parts(column_type: &str) -> (String, Option<u64>, Option<u64>) {
    let raw = column_type.trim();
    if let Some(open) = raw.find('(') {
        if let Some(close) = raw[open + 1..].find(')').map(|offset| open + 1 + offset) {
            let data_type = raw[..open].trim().to_ascii_lowercase();
            let inner = &raw[open + 1..close];
            let mut parts = inner.split(',').map(|part| part.trim().parse::<u64>().ok());
            return (data_type, parts.next().flatten(), parts.next().flatten());
        }
    }
    (raw.to_ascii_lowercase(), None, None)
}

/* ---------- 冲突检测 ---------- */

/// 检查类型转换是否完全不兼容（目标类型无法表示源类型的数据）
fn type_conversion_conflict(old_type: &str, new_type: &str) -> Option<String> {
    let old = normalized_type(old_type);
    let new = normalized_type(new_type);

    if old == new {
        return None;
    }

    // 字符串类型转为整数类型：数据可能完全丢失
    if matches!(
        new.as_str(),
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint"
    ) {
        if matches!(
            old.as_str(),
            "char"
                | "varchar"
                | "binary"
                | "varbinary"
                | "tinytext"
                | "text"
                | "mediumtext"
                | "longtext"
                | "json"
        ) {
            let old_label = type_display_name(&old);
            let new_label = type_display_name(&new);
            return Some(format!(
                "字段当前类型为 {}（可能包含文本数据），改为 {} 会导致已有数据全部丢失或报错",
                old_label, new_label
            ));
        }
    }

    // TEXT/BLOB 转为非常小的类型
    if matches!(old.as_str(), "text" | "longtext" | "mediumtext") {
        if matches!(new.as_str(), "char" | "varchar" | "tinyint" | "smallint") {
            let old_label = type_display_name(&old);
            let new_label = type_display_name(&new);
            return Some(format!(
                "字段当前类型为 {}（可存储大量文本），改为 {} 会导致长文本被截断或数据丢失",
                old_label, new_label
            ));
        }
    }

    // JSON 转为非文本类型
    if old == "json" && new != "text" && new != "longtext" && new != "varchar" {
        return Some("JSON 类型字段改为非文本类型会导致 JSON 数据全部丢失".into());
    }

    None
}

fn type_display_name(t: &str) -> &'static str {
    match t {
        "char" => "定长字符串(CHAR)",
        "varchar" => "变长字符串(VARCHAR)",
        "binary" => "定长二进制(BINARY)",
        "varbinary" => "变长二进制(VARBINARY)",
        "tinyint" => "极小整数(TINYINT)",
        "smallint" => "小整数(SMALLINT)",
        "mediumint" => "中等整数(MEDIUMINT)",
        "int" | "integer" => "整数(INT)",
        "bigint" => "大整数(BIGINT)",
        "float" => "单精度浮点数(FLOAT)",
        "double" => "双精度浮点数(DOUBLE)",
        "decimal" | "numeric" | "dec" | "fixed" => "定点数(DECIMAL)",
        "tinytext" => "极短文本(TINYTEXT)",
        "text" => "文本(TEXT)",
        "mediumtext" => "中等文本(MEDIUMTEXT)",
        "longtext" => "长文本(LONGTEXT)",
        "tinyblob" => "极短二进制(TINYBLOB)",
        "blob" => "二进制(BLOB)",
        "mediumblob" => "中等二进制(MEDIUMBLOB)",
        "longblob" => "长二进制(LONGBLOB)",
        "date" => "日期(DATE)",
        "datetime" => "日期时间(DATETIME)",
        "timestamp" => "时间戳(TIMESTAMP)",
        "time" => "时间(TIME)",
        "year" => "年份(YEAR)",
        "json" => "JSON",
        "bool" | "boolean" => "布尔(BOOL)",
        "enum" => "枚举(ENUM)",
        "set" => "集合(SET)",
        "bit" => "位字段(BIT)",
        _ => "未知类型",
    }
}

/* ---------- 中文差异描述生成 ---------- */

fn column_type_display(data_type: &str, length: Option<u64>, scale: Option<u64>) -> String {
    let t = normalized_type(data_type);
    if length.is_some() && scale.is_some() {
        format!(
            "{}({}.{})",
            type_display_name(&t),
            length.unwrap(),
            scale.unwrap()
        )
    } else if let Some(len) = length {
        format!("{}({})", type_display_name(&t), len)
    } else {
        type_display_name(&t).into()
    }
}

fn build_human_descriptions(current: &TableDesignMeta, draft: &TableDesignDraft) -> Vec<String> {
    let mut descriptions = Vec::new();
    let draft_lookup: std::collections::HashMap<String, &ColumnDesignDraft> = draft
        .columns
        .iter()
        .map(|c| (c.original_name.to_ascii_lowercase(), c))
        .collect();
    let mut pk_changes = Vec::new();
    let mut pk_added = Vec::new();
    let mut pk_removed = Vec::new();

    // 1. 表备注
    if current.table_comment != draft.table_comment {
        if draft.table_comment.is_empty() {
            descriptions.push("✏️ 清除表备注".into());
        } else if current.table_comment.is_empty() {
            descriptions.push(format!("✏️ 设置表备注：{}", draft.table_comment));
        } else {
            descriptions.push(format!(
                "✏️ 修改表备注：{} → {}",
                current.table_comment, draft.table_comment
            ));
        }
    }

    // 2. 逐字段比较
    for (_idx, current_column) in current.columns.iter().enumerate() {
        let Some(draft_column) = draft_lookup.get(&current_column.column_name.to_ascii_lowercase())
        else {
            continue;
        };
        let col_name = &draft_column.name;
        let mut col_changes = Vec::new();

        // 字段名
        if current_column.column_name != draft_column.name {
            col_changes.push(format!(
                "字段名 {} → {}",
                current_column.column_name, draft_column.name
            ));
        }

        // 类型
        let (parsed_data_type, parsed_length, parsed_scale) =
            parse_type_parts(&current_column.column_type);
        let old_type_display = column_type_display(&parsed_data_type, parsed_length, parsed_scale);
        let effective_type = if draft_column.data_type.trim().is_empty() {
            parsed_data_type
        } else {
            normalized_type(&draft_column.data_type)
        };
        let effective_length = draft_column
            .length
            .or(current_column.length.or(parsed_length));
        let effective_scale = draft_column.scale.or(current_column.scale.or(parsed_scale));
        let new_type_display =
            column_type_display(&effective_type, effective_length, effective_scale);

        if old_type_display != new_type_display {
            col_changes.push(format!("类型 {} → {}", old_type_display, new_type_display));
        }

        // 允许 NULL
        if current_column.is_nullable != draft_column.nullable {
            if draft_column.nullable {
                col_changes.push("改为允许 NULL（空值）".into());
            } else {
                col_changes.push("改为不允许 NULL（必填）".into());
            }
        }

        // 主键
        if current_column.is_primary_key != draft_column.primary_key {
            if draft_column.primary_key {
                pk_added.push(col_name.as_str());
            } else {
                pk_removed.push(col_name.as_str());
            }
        }

        // 默认值
        let old_default = default_display(current_column);
        let new_default = draft_default_display(draft_column);
        if old_default != new_default {
            if new_default == "无默认值" {
                col_changes.push(format!("清除默认值（原：{}）", old_default));
            } else if old_default == "无默认值" {
                col_changes.push(format!("设置默认值：{}", new_default));
            } else {
                col_changes.push(format!("默认值 {} → {}", old_default, new_default));
            }
        }

        // 备注
        if current_column.column_comment != draft_column.comment {
            if draft_column.comment.is_empty() {
                col_changes.push("清除字段备注".into());
            } else if current_column.column_comment.is_empty() {
                col_changes.push(format!("设置字段备注：{}", draft_column.comment));
            } else {
                col_changes.push(format!("修改字段备注"));
            }
        }

        if !col_changes.is_empty() {
            let display_name = if current_column.column_name != draft_column.name {
                format!(
                    "{}（原名：{}）",
                    draft_column.name, current_column.column_name
                )
            } else {
                col_name.clone()
            };
            descriptions.push(format!(
                "🔧 修改字段「{}」：{}",
                display_name,
                col_changes.join("；")
            ));
        }
    }

    // Newly-added columns (empty original_name) → "新增字段" descriptions (#6).
    for draft_column in &draft.columns {
        if !draft_column.original_name.trim().is_empty() {
            continue;
        }
        let effective = effective_draft(&empty_column_meta(), draft_column);
        let type_display = column_type_display(
            &normalized_type(&effective.data_type),
            effective.length,
            effective.scale,
        );
        let mut parts = vec![format!("类型 {}", type_display)];
        if effective.nullable {
            parts.push("允许 NULL".into());
        } else {
            parts.push("NOT NULL".into());
        }
        if effective.primary_key {
            parts.push("主键".into());
        }
        descriptions.push(format!(
            "➕ 新增字段「{}」：{}",
            effective.name,
            parts.join("；")
        ));
    }

    // 3. 主键变更汇总
    if !pk_added.is_empty() {
        pk_changes.push(format!("新增主键：{}", pk_added.join("、")));
    }
    if !pk_removed.is_empty() {
        pk_changes.push(format!("取消主键：{}", pk_removed.join("、")));
    }
    if !pk_changes.is_empty() {
        descriptions.push(format!("🔑 {}", pk_changes.join("；")));
    }

    descriptions
}

fn default_display(column: &ColumnDesignMeta) -> String {
    match column.default_mode.to_ascii_lowercase().as_str() {
        "null" => "NULL".into(),
        "value" => column.default_value.as_deref().unwrap_or("(空)").into(),
        "expression" => column.default_value.as_deref().unwrap_or("(表达式)").into(),
        _ => "无默认值".into(),
    }
}

fn draft_default_display(column: &ColumnDesignDraft) -> String {
    match column.default_mode.to_ascii_lowercase().as_str() {
        "null" => "NULL".into(),
        "value" => column.default_value.as_deref().unwrap_or("(空)").into(),
        "expression" => column.default_value.as_deref().unwrap_or("(表达式)").into(),
        _ => "无默认值".into(),
    }
}

/* ---------- 原有辅助函数 ---------- */

fn effective_draft(current: &ColumnDesignMeta, draft: &ColumnDesignDraft) -> ColumnDesignDraft {
    let mut out = draft.clone();
    let (parsed_data_type, parsed_length, parsed_scale) = parse_type_parts(&current.column_type);
    if out.data_type.trim().is_empty() {
        out.data_type = if current.data_type.trim().is_empty() {
            parsed_data_type
        } else {
            current.data_type.clone()
        };
    }
    if out.length.is_none() {
        out.length = current.length.or(parsed_length);
    }
    if out.scale.is_none() {
        out.scale = current.scale.or(parsed_scale);
    }
    out
}

fn validate_draft_shape(current: &TableDesignMeta, draft: &TableDesignDraft) -> Result<(), String> {
    validate_identifier(&current.table_name)?;
    let mut seen_names = HashSet::new();
    let mut seen_originals = HashSet::new();
    let current_names = current
        .columns
        .iter()
        .map(|column| column.column_name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let current_lookup = current
        .columns
        .iter()
        .map(|column| (column.column_name.to_ascii_lowercase(), column))
        .collect::<HashMap<_, _>>();

    for column in &draft.columns {
        // An empty original_name marks a newly-added column (ADD COLUMN). The
        // name itself must still be a valid, non-empty identifier (#6).
        if column.original_name.trim().is_empty() {
            validate_identifier(&column.name)?;
        } else {
            validate_identifier(&column.original_name)?;
            validate_identifier(&column.name)?;
        }
        let name_key = column.name.to_ascii_lowercase();
        if !seen_names.insert(name_key) {
            return Err(format!("duplicate column name: {}", column.name));
        }
        let original_key = column.original_name.to_ascii_lowercase();
        // Only track non-empty original names for the drop-column check; new
        // columns share the empty-string key and must not collide with each
        // other, which the name-key check above already prevents.
        if !original_key.is_empty() && !seen_originals.insert(original_key.clone()) {
            return Err(format!(
                "duplicate original column name: {}",
                column.original_name
            ));
        }
        if !original_key.is_empty() && !current_names.contains(&original_key) {
            return Err(format!("unknown original column: {}", column.original_name));
        }
    }

    for current_column in &current.columns {
        if !seen_originals.contains(&current_column.column_name.to_ascii_lowercase()) {
            return Err(format!(
                "drop column is not supported in V1: {}",
                current_column.column_name
            ));
        }
        if current_column.is_generated || !current_column.is_supported {
            return Err(format!(
                "unsupported column cannot be edited: {}",
                current_column.column_name
            ));
        }
    }

    for column in &draft.columns {
        let effective = if column.original_name.trim().is_empty() {
            // New column: no current metadata to inherit from.
            effective_draft(&empty_column_meta(), column)
        } else {
            let current_column = current_lookup
                .get(&column.original_name.to_ascii_lowercase())
                .ok_or_else(|| format!("unknown original column: {}", column.name))?;
            effective_draft(current_column, column)
        };
        column_type_sql(&effective)?;
        if effective.primary_key && effective.nullable {
            return Err(format!(
                "primary key column must be NOT NULL: {}",
                effective.name
            ));
        }
        let current_column = if column.original_name.trim().is_empty() {
            None
        } else {
            current_lookup
                .get(&column.original_name.to_ascii_lowercase())
                .copied()
        };
        let effective_type = normalized_type(&effective.data_type);
        if matches!(effective_type.as_str(), "enum" | "set")
            && current_column
                .map(|current| normalized_type(&current.data_type) != effective_type)
                .unwrap_or(true)
        {
            return Err(format!(
                "{effective_type} columns require a value list and cannot be newly created in table design V1: {}",
                effective.name
            ));
        }
        if let Some(current_column) = current_column {
            if has_auto_increment_extra(&current_column.extra) {
                if !effective.primary_key {
                    return Err(format!(
                        "auto_increment column must remain a primary key: {}",
                        current_column.column_name
                    ));
                }
                if !supports_auto_increment(&effective.data_type) {
                    return Err(format!(
                        "auto_increment column must remain an integer type: {}",
                        current_column.column_name
                    ));
                }
            }
        }
        default_sql(&effective)?;
    }
    Ok(())
}

/// A blank `ColumnDesignMeta` used as the "current" state for newly-added
/// columns so the shared definition helpers have something to diff against.
fn empty_column_meta() -> ColumnDesignMeta {
    ColumnDesignMeta {
        ordinal: 0,
        column_name: String::new(),
        column_type: String::new(),
        data_type: String::new(),
        length: None,
        scale: None,
        is_nullable: true,
        is_primary_key: false,
        default_mode: String::new(),
        default_value: None,
        column_comment: String::new(),
        extra: String::new(),
        generation_expression: None,
        is_generated: false,
        is_supported: true,
        unsupported_reason: None,
    }
}

fn current_as_draft(column: &ColumnDesignMeta) -> ColumnDesignDraft {
    let (parsed_data_type, parsed_length, parsed_scale) = parse_type_parts(&column.column_type);
    ColumnDesignDraft {
        original_name: column.column_name.clone(),
        name: column.column_name.clone(),
        data_type: if column.data_type.trim().is_empty() {
            parsed_data_type
        } else {
            column.data_type.clone()
        },
        length: column.length.or(parsed_length),
        scale: column.scale.or(parsed_scale),
        nullable: column.is_nullable,
        primary_key: column.is_primary_key,
        default_mode: column.default_mode.clone(),
        default_value: column.default_value.clone(),
        comment: column.column_comment.clone(),
    }
}

fn column_changed(current: &ColumnDesignMeta, draft: &ColumnDesignDraft) -> Result<bool, String> {
    let current_draft = current_as_draft(current);
    let effective = effective_draft(current, draft);
    Ok(effective.name != current.column_name
        || column_type_sql(&current_draft)? != column_type_sql(&effective)?
        || current.is_nullable != effective.nullable
        || current.is_primary_key != effective.primary_key
        || current.default_mode.to_ascii_lowercase() != effective.default_mode.to_ascii_lowercase()
        || current.default_value != effective.default_value
        || current.column_comment != effective.comment)
}

fn primary_key_original_names_from_meta(current: &TableDesignMeta) -> Vec<String> {
    current
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.column_name.to_ascii_lowercase())
        .collect()
}

fn primary_key_original_names_from_draft(draft: &TableDesignDraft) -> Vec<String> {
    draft
        .columns
        .iter()
        .filter(|column| column.primary_key)
        .map(|column| column.original_name.to_ascii_lowercase())
        .collect()
}

fn primary_key_final_names_from_draft(draft: &TableDesignDraft) -> Vec<String> {
    draft
        .columns
        .iter()
        .filter(|column| column.primary_key)
        .map(|column| column.name.clone())
        .collect()
}

fn current_existing_order(current: &TableDesignMeta) -> Vec<String> {
    current
        .columns
        .iter()
        .map(|column| column.column_name.to_ascii_lowercase())
        .collect()
}

fn draft_existing_order(draft: &TableDesignDraft) -> Vec<String> {
    draft
        .columns
        .iter()
        .filter_map(|column| {
            let original = column.original_name.trim();
            if original.is_empty() {
                None
            } else {
                Some(original.to_ascii_lowercase())
            }
        })
        .collect()
}

fn predecessor_by_identity(order: &[String]) -> HashMap<String, Option<String>> {
    let mut previous: Option<String> = None;
    let mut out = HashMap::new();
    for name in order {
        out.insert(name.clone(), previous.clone());
        previous = Some(name.clone());
    }
    out
}

fn position_clause(previous_final_name: Option<&str>) -> String {
    match previous_final_name {
        Some(name) => format!(" AFTER `{}`", escape_ident(name)),
        None => " FIRST".into(),
    }
}

pub fn build_table_design_statements(
    current: &TableDesignMeta,
    draft: &TableDesignDraft,
) -> Result<Vec<String>, String> {
    validate_draft_shape(current, draft)?;
    validate_identifier(&current.source.database)?;
    let table_name = format!(
        "`{}`.`{}`",
        escape_ident(&current.source.database),
        escape_ident(&current.table_name),
    );
    let mut clauses = Vec::new();

    let old_pk_identity = primary_key_original_names_from_meta(current);
    let new_pk_identity = primary_key_original_names_from_draft(draft);
    let primary_key_changed = old_pk_identity != new_pk_identity;
    if primary_key_changed && !old_pk_identity.is_empty() {
        clauses.push("DROP PRIMARY KEY".to_string());
    }

    let current_lookup = current
        .columns
        .iter()
        .map(|column| (column.column_name.to_ascii_lowercase(), column))
        .collect::<HashMap<_, _>>();
    let current_order = current_existing_order(current);
    let draft_order = draft_existing_order(draft);
    let current_predecessors = predecessor_by_identity(&current_order);
    let draft_predecessors = predecessor_by_identity(&draft_order);
    let existing_order_changed = current_order != draft_order;

    let mut previous_final_name: Option<String> = None;
    for draft_column in &draft.columns {
        if draft_column.original_name.trim().is_empty() {
            let effective = effective_draft(&empty_column_meta(), draft_column);
            let definition = column_definition_sql(&effective, &empty_column_meta())?;
            clauses.push(format!(
                "ADD COLUMN `{}` {}{}",
                escape_ident(&effective.name),
                definition,
                position_clause(previous_final_name.as_deref()),
            ));
            previous_final_name = Some(effective.name);
            continue;
        }

        let original_key = draft_column.original_name.to_ascii_lowercase();
        let current_column = current_lookup
            .get(&original_key)
            .ok_or_else(|| format!("unknown original column: {}", draft_column.original_name))?;
        let effective = effective_draft(current_column, draft_column);
        let definition = column_definition_sql(&effective, current_column)?;
        let needs_position = existing_order_changed
            && current_predecessors.get(&original_key) != draft_predecessors.get(&original_key);
        let position_sql = if needs_position {
            position_clause(previous_final_name.as_deref())
        } else {
            String::new()
        };
        if column_changed(current_column, draft_column)? || needs_position {
            if effective.name != current_column.column_name {
                clauses.push(format!(
                    "CHANGE COLUMN `{}` `{}` {}{}",
                    escape_ident(&current_column.column_name),
                    escape_ident(&effective.name),
                    definition,
                    position_sql,
                ));
            } else {
                clauses.push(format!(
                    "MODIFY COLUMN `{}` {}{}",
                    escape_ident(&effective.name),
                    definition,
                    position_sql,
                ));
            }
        }
        previous_final_name = Some(effective.name);
    }

    let new_pk = primary_key_final_names_from_draft(draft);
    if primary_key_changed && !new_pk.is_empty() {
        clauses.push(format!(
            "ADD PRIMARY KEY ({})",
            new_pk
                .iter()
                .map(|name| format!("`{}`", escape_ident(name)))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    if current.table_comment != draft.table_comment {
        clauses.push(format!("COMMENT = {}", sql_string(&draft.table_comment)));
    }

    if clauses.is_empty() {
        Ok(Vec::new())
    } else {
        Ok(vec![format!(
            "ALTER TABLE {table_name} {}",
            clauses.join(", ")
        )])
    }
}

pub fn preview_table_design_change(
    current: &TableDesignMeta,
    draft: &TableDesignDraft,
) -> Result<TableDesignPreview, String> {
    // 冲突检测
    let mut conflicts = Vec::new();
    let draft_lookup: std::collections::HashMap<String, &ColumnDesignDraft> = draft
        .columns
        .iter()
        .map(|c| (c.original_name.to_ascii_lowercase(), c))
        .collect();

    for current_column in &current.columns {
        let Some(draft_column) = draft_lookup.get(&current_column.column_name.to_ascii_lowercase())
        else {
            continue;
        };
        // 检测类型转换冲突
        if let Some(msg) =
            type_conversion_conflict(&current_column.column_type, &draft_column.data_type)
        {
            conflicts.push(format!("字段「{}」：{}", current_column.column_name, msg));
        }
    }

    let statements = build_table_design_statements(current, draft)?;
    let schema_signature = schema_signature(current);
    let preview_signature = preview_signature(current, draft, &statements);
    let human_descriptions = build_human_descriptions(current, draft);

    Ok(TableDesignPreview {
        signature: preview_signature.clone(),
        preview_signature: preview_signature.clone(),
        source_signature: schema_signature.clone(),
        schema_signature,
        has_changes: !statements.is_empty() || !human_descriptions.is_empty(),
        statements,
        warnings: Vec::new(),
        conflicts,
        human_descriptions,
    })
}

pub fn verify_table_design_apply(
    current: &TableDesignMeta,
    request: &ApplyTableDesignRequest,
) -> Result<TableDesignPreview, String> {
    if !source_matches(
        current,
        &request.connection_id,
        &request.database,
        &request.table_name,
    ) {
        return Err("source mismatch for table design apply".into());
    }
    let Some(provided_preview_signature) = request
        .preview_signature
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Err("preview signature is required before applying table design".into());
    };
    let preview = preview_table_design_change(current, &request.draft)?;
    let provided_schema_signature = request
        .schema_signature
        .as_deref()
        .or(request.source_signature.as_deref());
    let Some(provided_schema_signature) =
        provided_schema_signature.filter(|value| !value.trim().is_empty())
    else {
        return Err("schema signature is required before applying table design".into());
    };
    if provided_schema_signature != preview.schema_signature {
        return Err("schema signature mismatch; refresh the table design preview".into());
    }
    if provided_preview_signature != preview.preview_signature {
        return Err("preview signature mismatch; refresh the table design preview".into());
    }
    if !preview.conflicts.is_empty() {
        return Err(format!(
            "表设计存在冲突，无法保存：{}",
            preview.conflicts.join("；")
        ));
    }
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> TableDesignSource {
        TableDesignSource {
            connection_id: "mysql-1".into(),
            database: "game_db".into(),
            table_name: "player".into(),
        }
    }

    fn col(
        name: &str,
        column_type: &str,
        nullable: bool,
        primary_key: bool,
        comment: &str,
    ) -> ColumnDesignMeta {
        ColumnDesignMeta {
            ordinal: 1,
            column_name: name.into(),
            column_type: column_type.into(),
            data_type: column_type.split('(').next().unwrap_or(column_type).into(),
            length: None,
            scale: None,
            is_nullable: nullable,
            is_primary_key: primary_key,
            default_mode: "none".into(),
            default_value: None,
            column_comment: comment.into(),
            extra: String::new(),
            generation_expression: None,
            is_generated: false,
            is_supported: true,
            unsupported_reason: None,
        }
    }

    fn meta() -> TableDesignMeta {
        TableDesignMeta {
            source: source(),
            table_name: "player".into(),
            table_comment: "玩家账号表".into(),
            schema_signature: None,
            columns: vec![
                col("id", "int", false, true, "玩家ID"),
                col("username", "varchar(32)", false, false, "用户名"),
                col("nickname", "varchar(64)", true, false, "昵称"),
            ],
        }
    }

    fn unsigned_tinyint_meta() -> TableDesignMeta {
        let mut current = meta();
        current.columns[1].column_type = "tinyint(3) unsigned".into();
        current.columns[1].data_type = "tinyint".into();
        current.columns[1].length = Some(3);
        current.columns[1].column_comment = "领取类型".into();
        current
    }

    fn draft_from(meta: &TableDesignMeta) -> TableDesignDraft {
        TableDesignDraft {
            table_comment: meta.table_comment.clone(),
            columns: meta
                .columns
                .iter()
                .map(|column| ColumnDesignDraft {
                    original_name: column.column_name.clone(),
                    name: column.column_name.clone(),
                    data_type: column.data_type.clone(),
                    length: column.length,
                    scale: column.scale,
                    nullable: column.is_nullable,
                    primary_key: column.is_primary_key,
                    default_mode: column.default_mode.clone(),
                    default_value: column.default_value.clone(),
                    comment: column.column_comment.clone(),
                })
                .collect(),
        }
    }

    fn preview(current: &TableDesignMeta, draft: &TableDesignDraft) -> TableDesignPreview {
        preview_table_design_change(current, draft).expect("preview should be generated")
    }

    #[test]
    fn comment_and_type_change_generates_modify_column() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.columns[1].data_type = "varchar".into();
        draft.columns[1].length = Some(48);
        draft.columns[1].nullable = true;
        draft.columns[1].default_mode = "value".into();
        draft.columns[1].default_value = Some("guest's name".into());
        draft.columns[1].comment = "登录名".into();

        let result = preview(&current, &draft);

        assert!(result.has_changes);
        assert!(result.statements.iter().any(|sql| sql.contains("MODIFY COLUMN `username` varchar(48) NULL DEFAULT 'guest''s name' COMMENT '登录名'")), "statements were {:?}", result.statements);
    }

    #[test]
    fn mysql_integer_type_with_unsigned_modifier_is_not_reported_as_changed() {
        let current = unsigned_tinyint_meta();
        let draft = draft_from(&current);

        let result = preview(&current, &draft);

        assert!(!result.has_changes);
        assert!(
            result.statements.is_empty(),
            "statements were {:?}",
            result.statements
        );
        assert!(
            result.human_descriptions.is_empty(),
            "descriptions were {:?}",
            result.human_descriptions
        );
    }

    #[test]
    fn modifying_unsigned_integer_column_preserves_unsigned_modifier() {
        let current = unsigned_tinyint_meta();
        let mut draft = draft_from(&current);
        draft.columns[1].comment = "条件领取类型".into();

        let result = preview(&current, &draft);
        let sql = result.statements.join("\n");

        assert!(
            sql.contains(
                "MODIFY COLUMN `username` tinyint(3) unsigned NOT NULL COMMENT '条件领取类型'"
            ),
            "statements were {:?}",
            result.statements
        );
    }

    #[test]
    fn rename_generates_change_column() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.columns[1].name = "login_name".into();

        let result = preview(&current, &draft);

        assert!(
            result.statements.iter().any(|sql| sql.contains(
                "CHANGE COLUMN `username` `login_name` varchar(32) NOT NULL COMMENT '用户名'"
            )),
            "statements were {:?}",
            result.statements
        );
    }

    #[test]
    fn reordering_existing_columns_emits_position_clauses() {
        let current = meta();
        let mut draft = draft_from(&current);
        let nickname = draft.columns.remove(2);
        draft.columns.insert(0, nickname);

        let result = preview(&current, &draft);
        let sql = result.statements.join("\n");

        assert!(
            sql.contains("MODIFY COLUMN `nickname` varchar(64) NULL COMMENT '昵称' FIRST"),
            "statements were {:?}",
            result.statements
        );
        assert!(
            sql.contains("MODIFY COLUMN `id` int NOT NULL COMMENT '玩家ID' AFTER `nickname`"),
            "statements were {:?}",
            result.statements
        );
    }

    #[test]
    fn added_columns_emit_position_clauses() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.columns.insert(
            1,
            ColumnDesignDraft {
                original_name: String::new(),
                name: "score".into(),
                data_type: "int".into(),
                length: None,
                scale: None,
                nullable: false,
                primary_key: false,
                default_mode: "none".into(),
                default_value: None,
                comment: "评分".into(),
            },
        );

        let result = preview(&current, &draft);
        let sql = result.statements.join("\n");

        assert!(
            sql.contains("ADD COLUMN `score` int NOT NULL COMMENT '评分' AFTER `id`"),
            "statements were {:?}",
            result.statements
        );
    }

    #[test]
    fn existing_enum_columns_preserve_value_lists_when_metadata_changes() {
        let current = TableDesignMeta {
            columns: vec![
                col("id", "int", false, true, "玩家ID"),
                col("status", "enum('new','done')", false, false, "状态"),
            ],
            ..meta()
        };
        let mut draft = draft_from(&current);
        draft.columns[1].comment = "状态备注".into();

        let result = preview(&current, &draft);
        let sql = result.statements.join("\n");

        assert!(
            sql.contains("MODIFY COLUMN `status` enum('new','done') NOT NULL COMMENT '状态备注'"),
            "statements were {:?}",
            result.statements
        );
    }

    #[test]
    fn new_enum_and_set_columns_are_rejected_until_value_lists_are_supported() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.columns.push(ColumnDesignDraft {
            original_name: String::new(),
            name: "status".into(),
            data_type: "enum".into(),
            length: None,
            scale: None,
            nullable: true,
            primary_key: false,
            default_mode: "none".into(),
            default_value: None,
            comment: "状态".into(),
        });

        let err = preview_table_design_change(&current, &draft)
            .expect_err("new enum columns should not generate bare enum SQL");

        assert!(
            err.to_lowercase().contains("enum") || err.to_lowercase().contains("value list"),
            "error was {err}"
        );
    }

    #[test]
    fn auto_increment_columns_must_remain_primary_integer_columns() {
        let mut current = meta();
        current.columns[0].extra = "auto_increment".into();

        let mut removed_pk = draft_from(&current);
        removed_pk.columns[0].primary_key = false;
        let err = preview_table_design_change(&current, &removed_pk)
            .expect_err("auto_increment column should not be removed from the primary key");
        assert!(
            err.to_lowercase().contains("auto_increment"),
            "error was {err}"
        );

        let mut non_integer = draft_from(&current);
        non_integer.columns[0].data_type = "varchar".into();
        non_integer.columns[0].length = Some(32);
        let err = preview_table_design_change(&current, &non_integer)
            .expect_err("auto_increment column should stay integer typed");
        assert!(
            err.to_lowercase().contains("auto_increment"),
            "error was {err}"
        );
    }

    #[test]
    fn table_comment_generates_database_qualified_comment_clause() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.table_comment = "玩家配置 'live'".into();

        let result = preview(&current, &draft);

        assert_eq!(
            result.statements,
            vec!["ALTER TABLE `game_db`.`player` COMMENT = '玩家配置 ''live'''"],
        );
    }

    #[test]
    fn auto_increment_extra_is_preserved_in_modify_and_change_definitions() {
        let mut current = meta();
        current.columns[0].column_type = "bigint".into();
        current.columns[0].data_type = "bigint".into();
        current.columns[0].extra = "auto_increment".into();

        let mut modify_draft = draft_from(&current);
        modify_draft.columns[0].comment = "玩家编号".into();
        let modify_result = preview(&current, &modify_draft);
        let modify_sql = modify_result.statements.join("\n");
        assert!(
            modify_sql
                .contains("MODIFY COLUMN `id` bigint NOT NULL AUTO_INCREMENT COMMENT '玩家编号'"),
            "statements were {:?}",
            modify_result.statements
        );

        let mut change_draft = draft_from(&current);
        change_draft.columns[0].name = "player_id".into();
        change_draft.columns[0].comment = "玩家编号".into();
        let change_result = preview(&current, &change_draft);
        let change_sql = change_result.statements.join("\n");
        assert!(
            change_sql.contains(
                "CHANGE COLUMN `id` `player_id` bigint NOT NULL AUTO_INCREMENT COMMENT '玩家编号'"
            ),
            "statements were {:?}",
            change_result.statements
        );
    }

    #[test]
    fn renaming_auto_increment_primary_key_does_not_rebuild_primary_key() {
        let mut current = meta();
        current.columns[0].column_name = "ID".into();
        current.columns[0].extra = "auto_increment".into();

        let mut draft = draft_from(&current);
        draft.columns[0].name = "ID2".into();

        let result = preview(&current, &draft);
        let sql = result.statements.join("\n");

        assert!(
            sql.contains("CHANGE COLUMN `ID` `ID2` int NOT NULL AUTO_INCREMENT COMMENT '玩家ID'"),
            "statements were {:?}",
            result.statements
        );
        assert!(
            !sql.contains("DROP PRIMARY KEY"),
            "statements were {:?}",
            result.statements
        );
        assert!(
            !sql.contains("ADD PRIMARY KEY"),
            "statements were {:?}",
            result.statements
        );
    }

    #[test]
    fn unrecognized_extra_is_not_emitted_in_column_definitions() {
        let mut current = meta();
        current.columns[0].extra = "auto_increment, made_up_extra".into();
        let mut draft = draft_from(&current);
        draft.columns[0].comment = "玩家编号".into();

        let result = preview(&current, &draft);
        let sql = result.statements.join("\n");

        assert!(
            sql.contains("AUTO_INCREMENT"),
            "statements were {:?}",
            result.statements
        );
        assert!(
            !sql.contains("made_up_extra"),
            "statements were {:?}",
            result.statements
        );
    }

    #[test]
    fn expression_default_allowlist_accepts_current_timestamp_and_rejects_on_update() {
        let current = TableDesignMeta {
            columns: vec![
                col("id", "int", false, true, "玩家ID"),
                col("created_at", "timestamp", false, false, "创建时间"),
            ],
            ..meta()
        };
        let mut accepted = draft_from(&current);
        accepted.columns[1].default_mode = "expression".into();
        accepted.columns[1].default_value = Some("CURRENT_TIMESTAMP".into());

        let result = preview(&current, &accepted);
        assert!(
            result
                .statements
                .join("\n")
                .contains("DEFAULT CURRENT_TIMESTAMP"),
            "statements were {:?}",
            result.statements
        );

        let mut rejected = draft_from(&current);
        rejected.columns[1].default_mode = "expression".into();
        rejected.columns[1].default_value =
            Some("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP".into());

        let err = preview_table_design_change(&current, &rejected)
            .expect_err("unsafe expression default should be rejected");
        assert!(
            err.to_lowercase().contains("default expression"),
            "error was {err}"
        );
    }

    #[test]
    fn removing_primary_key_before_making_column_nullable_orders_clauses_safely() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.columns[0].primary_key = false;
        draft.columns[0].nullable = true;

        let result = preview(&current, &draft);
        let joined = result.statements.join(";\n");
        let drop_index = joined
            .find("DROP PRIMARY KEY")
            .expect("drop primary key clause should be present");
        let modify_index = joined
            .find("MODIFY COLUMN `id`")
            .expect("id modification should be present");

        assert!(
            drop_index < modify_index,
            "statements were {:?}",
            result.statements
        );
    }

    #[test]
    fn table_comment_and_column_change_are_combined_into_one_statement() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.table_comment = "玩家配置 live".into();
        draft.columns[1].data_type = "varchar".into();
        draft.columns[1].length = Some(48);

        let result = preview(&current, &draft);

        assert_eq!(
            result.statements.len(),
            1,
            "statements were {:?}",
            result.statements
        );
        assert!(
            result.statements[0]
                .contains("MODIFY COLUMN `username` varchar(48) NOT NULL COMMENT '用户名'"),
            "statements were {:?}",
            result.statements
        );
        assert!(
            result.statements[0].contains("COMMENT = '玩家配置 live'"),
            "statements were {:?}",
            result.statements
        );
    }

    #[test]
    fn primary_key_change_generates_drop_column_modify_and_add_primary_key() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.columns[2].primary_key = true;
        draft.columns[2].nullable = false;

        let result = preview(&current, &draft);
        let joined = result.statements.join(";\n");
        let drop_index = joined
            .find("DROP PRIMARY KEY")
            .expect("drop primary key clause should be present");
        let modify_index = joined
            .find("MODIFY COLUMN `nickname`")
            .expect("nickname modification should be present");
        let add_index = joined
            .find("ADD PRIMARY KEY (`id`, `nickname`)")
            .expect("add primary key clause should be present");

        assert!(
            drop_index < modify_index,
            "statements were {:?}",
            result.statements
        );
        assert!(
            modify_index < add_index,
            "statements were {:?}",
            result.statements
        );
    }

    #[test]
    fn duplicate_invalid_names_and_unsupported_types_are_rejected() {
        let current = meta();
        let mut duplicate = draft_from(&current);
        duplicate.columns[1].name = "nickname".into();
        assert!(preview_table_design_change(&current, &duplicate)
            .unwrap_err()
            .to_lowercase()
            .contains("duplicate"));

        let mut invalid = draft_from(&current);
        invalid.columns[1].name = "bad-name".into();
        assert!(preview_table_design_change(&current, &invalid)
            .unwrap_err()
            .to_lowercase()
            .contains("identifier"));

        let mut unsupported = draft_from(&current);
        unsupported.columns[1].data_type = "geometry".into();
        assert!(preview_table_design_change(&current, &unsupported)
            .unwrap_err()
            .to_lowercase()
            .contains("unsupported"));
    }

    #[test]
    fn omitted_existing_column_is_rejected_and_new_column_is_supported() {
        let current = meta();
        let mut omitted = draft_from(&current);
        omitted.columns.remove(1);
        assert!(preview_table_design_change(&current, &omitted)
            .unwrap_err()
            .to_lowercase()
            .contains("drop"));

        // A draft column with a non-empty original_name that doesn't match any
        // current column is rejected as an unknown original column.
        let mut bogus = draft_from(&current);
        bogus.columns.push(ColumnDesignDraft {
            original_name: "new_column".into(),
            name: "new_column".into(),
            data_type: "int".into(),
            length: None,
            scale: None,
            nullable: true,
            primary_key: false,
            default_mode: "none".into(),
            default_value: None,
            comment: String::new(),
        });
        assert!(preview_table_design_change(&current, &bogus)
            .unwrap_err()
            .to_lowercase()
            .contains("unknown original column"));

        // A genuinely new column (empty original_name) is supported and emits
        // ADD COLUMN (#6).
        let mut added = draft_from(&current);
        added.columns.push(ColumnDesignDraft {
            original_name: String::new(),
            name: "score".into(),
            data_type: "int".into(),
            length: None,
            scale: None,
            nullable: false,
            primary_key: false,
            default_mode: "none".into(),
            default_value: None,
            comment: String::new(),
        });
        let result =
            preview_table_design_change(&current, &added).expect("add column is supported");
        assert!(result
            .statements
            .iter()
            .any(|stmt| stmt.to_ascii_uppercase().contains("ADD COLUMN `SCORE`")));
    }

    #[test]
    fn no_changes_returns_has_changes_false() {
        let current = meta();
        let draft = draft_from(&current);

        let result = preview(&current, &draft);

        assert!(!result.has_changes);
        assert!(result.statements.is_empty());
    }

    #[test]
    fn signatures_include_source_and_apply_rejects_mismatch() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.table_comment = "签名测试".into();
        let result = preview(&current, &draft);

        assert!(result.schema_signature.contains("mysql-1"));
        assert!(result.schema_signature.contains("game_db"));
        assert!(result.schema_signature.contains("player"));
        assert!(result.preview_signature.contains("mysql-1"));

        let mut stale_request = ApplyTableDesignRequest {
            connection_id: "mysql-1".into(),
            database: "game_db".into(),
            table_name: "player".into(),
            draft,
            schema_signature: Some(result.schema_signature),
            source_signature: None,
            preview_signature: Some("wrong-preview".into()),
        };
        assert!(verify_table_design_apply(&current, &stale_request)
            .unwrap_err()
            .to_lowercase()
            .contains("signature"));

        stale_request.preview_signature = None;
        assert!(verify_table_design_apply(&current, &stale_request)
            .unwrap_err()
            .to_lowercase()
            .contains("preview"));
    }

    #[test]
    fn apply_verification_rejects_conflicting_type_conversions() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.columns[1].data_type = "int".into();
        draft.columns[1].length = Some(11);
        let result = preview(&current, &draft);
        assert!(
            !result.conflicts.is_empty(),
            "preview should report conflicts"
        );

        let request = ApplyTableDesignRequest {
            connection_id: "mysql-1".into(),
            database: "game_db".into(),
            table_name: "player".into(),
            draft,
            schema_signature: Some(result.schema_signature),
            source_signature: None,
            preview_signature: Some(result.preview_signature),
        };

        let err = verify_table_design_apply(&current, &request)
            .expect_err("conflicting apply should be rejected");
        assert!(
            err.contains("冲突") || err.to_lowercase().contains("conflict"),
            "error was {err}"
        );
    }

    #[test]
    fn expression_defaults_are_unquoted_and_literal_defaults_are_quoted() {
        let current = TableDesignMeta {
            columns: vec![
                col("id", "int", false, true, "玩家ID"),
                col("created_at", "datetime", false, false, "创建时间"),
                col("nickname", "varchar(64)", true, false, "昵称"),
            ],
            ..meta()
        };
        let mut draft = draft_from(&current);
        draft.columns[1].default_mode = "expression".into();
        draft.columns[1].default_value = Some("CURRENT_TIMESTAMP".into());
        draft.columns[2].default_mode = "value".into();
        draft.columns[2].default_value = Some("guest's alias".into());

        let result = preview(&current, &draft);
        let joined = result.statements.join("\n");

        assert!(
            joined.contains(
                "`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'"
            ),
            "statements were {:?}",
            result.statements
        );
        assert!(!joined.contains("DEFAULT 'CURRENT_TIMESTAMP'"));
        assert!(
            joined.contains("`nickname` varchar(64) NULL DEFAULT 'guest''s alias' COMMENT '昵称'"),
            "statements were {:?}",
            result.statements
        );
    }
}
