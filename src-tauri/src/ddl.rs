use std::collections::{HashMap, HashSet};

use crate::db::escape_ident;
use crate::types::*;

fn design_source(current: &TableDesignMeta) -> &TableDesignSource {
    &current.source
}

fn source_matches(current: &TableDesignMeta, connection_id: &str, database: &str, table_name: &str) -> bool {
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
    value.trim().to_ascii_lowercase()
}

fn supports_type(data_type: &str) -> bool {
    matches!(normalized_type(data_type).as_str(),
        "char" | "varchar" | "binary" | "varbinary" | "bit" |
        "decimal" | "numeric" | "dec" | "fixed" |
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" |
        "float" | "double" | "real" |
        "tinytext" | "text" | "mediumtext" | "longtext" | "json" |
        "tinyblob" | "blob" | "mediumblob" | "longblob" |
        "date" | "datetime" | "timestamp" | "time" | "year" |
        "bool" | "boolean"
    )
}

fn needs_length(data_type: &str) -> bool {
    matches!(normalized_type(data_type).as_str(), "char" | "varchar" | "binary" | "varbinary" | "bit")
}

fn supports_scale(data_type: &str) -> bool {
    matches!(normalized_type(data_type).as_str(), "decimal" | "numeric" | "dec" | "fixed")
}

pub fn column_type_sql(draft: &ColumnDesignDraft) -> Result<String, String> {
    validate_identifier(&draft.name)?;
    let data_type = normalized_type(&draft.data_type);
    if !supports_type(&data_type) {
        return Err(format!("unsupported type: {}", draft.data_type));
    }
    if needs_length(&data_type) {
        let length = draft.length.ok_or_else(|| format!("type {data_type} requires length"))?;
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
        "value" => Ok(format!(" DEFAULT {}", sql_string(draft.default_value.as_deref().unwrap_or_default()))),
        "expression" => {
            let value = draft.default_value.as_deref().unwrap_or_default().trim();
            validate_expression(value)?;
            Ok(format!(" DEFAULT {value}"))
        }
        other => Err(format!("unsupported default mode: {other}")),
    }
}

fn safe_column_extra_sql(current: &ColumnDesignMeta) -> String {
    let has_auto_increment = current
        .extra
        .replace(',', " ")
        .split_whitespace()
        .any(|part| part.eq_ignore_ascii_case("auto_increment"));
    if has_auto_increment {
        " AUTO_INCREMENT".into()
    } else {
        String::new()
    }
}

pub fn column_definition_sql(draft: &ColumnDesignDraft, current: &ColumnDesignMeta) -> Result<String, String> {
    let column_type = column_type_sql(draft)?;
    let nullable_sql = if draft.primary_key || !draft.nullable { "NOT NULL" } else { "NULL" };
    let default_sql = default_sql(draft)?;
    let extra_sql = safe_column_extra_sql(current);
    let comment_sql = if draft.comment.is_empty() {
        String::new()
    } else {
        format!(" COMMENT {}", sql_string(&draft.comment))
    };
    Ok(format!("{column_type} {nullable_sql}{default_sql}{extra_sql}{comment_sql}"))
}

fn canonical_source(source: &TableDesignSource) -> String {
    format!("{}|{}|{}", source.connection_id, source.database, source.table_name)
}

fn canonical_meta(current: &TableDesignMeta) -> String {
    let columns = current.columns.iter().map(|column| {
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
    }).collect::<Vec<_>>().join(";");
    format!("source={}|comment={}|columns={columns}", canonical_source(design_source(current)), current.table_comment)
}

fn canonical_draft(draft: &TableDesignDraft) -> String {
    let columns = draft.columns.iter().map(|column| {
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
    }).collect::<Vec<_>>().join(";");
    format!("comment={}|columns={columns}", draft.table_comment)
}

pub fn schema_signature(current: &TableDesignMeta) -> String {
    format!("schema:{}", canonical_meta(current))
}

pub fn preview_signature(current: &TableDesignMeta, draft: &TableDesignDraft, statements: &[String]) -> String {
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
        if raw.ends_with(')') {
            let data_type = raw[..open].trim().to_ascii_lowercase();
            let inner = &raw[open + 1..raw.len() - 1];
            let mut parts = inner.split(',').map(|part| part.trim().parse::<u64>().ok());
            return (data_type, parts.next().flatten(), parts.next().flatten());
        }
    }
    (raw.to_ascii_lowercase(), None, None)
}

fn effective_draft(current: &ColumnDesignMeta, draft: &ColumnDesignDraft) -> ColumnDesignDraft {
    let mut out = draft.clone();
    let (parsed_data_type, parsed_length, parsed_scale) = parse_type_parts(&current.column_type);
    if out.data_type.trim().is_empty() {
        out.data_type = if current.data_type.trim().is_empty() { parsed_data_type } else { current.data_type.clone() };
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
    let current_names = current.columns.iter().map(|column| column.column_name.to_ascii_lowercase()).collect::<HashSet<_>>();
    let current_lookup = current.columns.iter().map(|column| (column.column_name.to_ascii_lowercase(), column)).collect::<HashMap<_, _>>();

    for column in &draft.columns {
        validate_identifier(&column.original_name)?;
        validate_identifier(&column.name)?;
        let name_key = column.name.to_ascii_lowercase();
        if !seen_names.insert(name_key) {
            return Err(format!("duplicate column name: {}", column.name));
        }
        let original_key = column.original_name.to_ascii_lowercase();
        if !seen_originals.insert(original_key.clone()) {
            return Err(format!("duplicate original column name: {}", column.original_name));
        }
        if !current_names.contains(&original_key) {
            return Err(format!("add column is not supported in V1: {}", column.name));
        }
    }

    for current_column in &current.columns {
        if !seen_originals.contains(&current_column.column_name.to_ascii_lowercase()) {
            return Err(format!("drop column is not supported in V1: {}", current_column.column_name));
        }
        if current_column.is_generated || !current_column.is_supported {
            return Err(format!("unsupported column cannot be edited: {}", current_column.column_name));
        }
    }

    for column in &draft.columns {
        let current_column = current_lookup
            .get(&column.original_name.to_ascii_lowercase())
            .ok_or_else(|| format!("add column is not supported in V1: {}", column.name))?;
        let effective = effective_draft(current_column, column);
        column_type_sql(&effective)?;
        if effective.primary_key && effective.nullable {
            return Err(format!("primary key column must be NOT NULL: {}", effective.name));
        }
        default_sql(&effective)?;
    }
    Ok(())
}

fn draft_by_original<'a>(draft: &'a TableDesignDraft) -> HashMap<String, &'a ColumnDesignDraft> {
    draft.columns.iter().map(|column| (column.original_name.to_ascii_lowercase(), column)).collect()
}

fn current_as_draft(column: &ColumnDesignMeta) -> ColumnDesignDraft {
    let (parsed_data_type, parsed_length, parsed_scale) = parse_type_parts(&column.column_type);
    ColumnDesignDraft {
        original_name: column.column_name.clone(),
        name: column.column_name.clone(),
        data_type: if column.data_type.trim().is_empty() { parsed_data_type } else { column.data_type.clone() },
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

fn primary_key_names_from_meta(current: &TableDesignMeta) -> Vec<String> {
    current.columns.iter().filter(|column| column.is_primary_key).map(|column| column.column_name.clone()).collect()
}

fn primary_key_names_from_draft(draft: &TableDesignDraft) -> Vec<String> {
    draft.columns.iter().filter(|column| column.primary_key).map(|column| column.name.clone()).collect()
}

pub fn build_table_design_statements(current: &TableDesignMeta, draft: &TableDesignDraft) -> Result<Vec<String>, String> {
    validate_draft_shape(current, draft)?;
    validate_identifier(&current.source.database)?;
    let table_name = format!(
        "`{}`.`{}`",
        escape_ident(&current.source.database),
        escape_ident(&current.table_name),
    );
    let mut clauses = Vec::new();

    let old_pk = primary_key_names_from_meta(current);
    let new_pk = primary_key_names_from_draft(draft);
    if old_pk != new_pk && !old_pk.is_empty() {
        clauses.push("DROP PRIMARY KEY".to_string());
    }

    let draft_lookup = draft_by_original(draft);
    for current_column in &current.columns {
        let draft_column = draft_lookup
            .get(&current_column.column_name.to_ascii_lowercase())
            .ok_or_else(|| format!("drop column is not supported in V1: {}", current_column.column_name))?;
        if column_changed(current_column, draft_column)? {
            let effective = effective_draft(current_column, draft_column);
            let definition = column_definition_sql(&effective, current_column)?;
            if effective.name != current_column.column_name {
                clauses.push(format!(
                    "CHANGE COLUMN `{}` `{}` {}",
                    escape_ident(&current_column.column_name),
                    escape_ident(&effective.name),
                    definition,
                ));
            } else {
                clauses.push(format!(
                    "MODIFY COLUMN `{}` {}",
                    escape_ident(&effective.name),
                    definition,
                ));
            }
        }
    }

    if old_pk != new_pk && !new_pk.is_empty() {
        clauses.push(format!(
            "ADD PRIMARY KEY ({})",
            new_pk.iter().map(|name| format!("`{}`", escape_ident(name))).collect::<Vec<_>>().join(", ")
        ));
    }

    if current.table_comment != draft.table_comment {
        clauses.push(format!("COMMENT = {}", sql_string(&draft.table_comment)));
    }

    if clauses.is_empty() {
        Ok(Vec::new())
    } else {
        Ok(vec![format!("ALTER TABLE {table_name} {}", clauses.join(", "))])
    }
}

pub fn preview_table_design_change(current: &TableDesignMeta, draft: &TableDesignDraft) -> Result<TableDesignPreview, String> {
    let statements = build_table_design_statements(current, draft)?;
    let schema_signature = schema_signature(current);
    let preview_signature = preview_signature(current, draft, &statements);
    Ok(TableDesignPreview {
        signature: preview_signature.clone(),
        preview_signature: preview_signature.clone(),
        source_signature: schema_signature.clone(),
        schema_signature,
        has_changes: !statements.is_empty(),
        statements,
        warnings: Vec::new(),
    })
}

pub fn verify_table_design_apply(current: &TableDesignMeta, request: &ApplyTableDesignRequest) -> Result<TableDesignPreview, String> {
    if !source_matches(current, &request.connection_id, &request.database, &request.table_name) {
        return Err("source mismatch for table design apply".into());
    }
    let Some(provided_preview_signature) = request.preview_signature.as_deref().filter(|value| !value.trim().is_empty()) else {
        return Err("preview signature is required before applying table design".into());
    };
    let preview = preview_table_design_change(current, &request.draft)?;
    let provided_schema_signature = request.schema_signature.as_deref().or(request.source_signature.as_deref());
    let Some(provided_schema_signature) = provided_schema_signature.filter(|value| !value.trim().is_empty()) else {
        return Err("schema signature is required before applying table design".into());
    };
    if provided_schema_signature != preview.schema_signature {
        return Err("schema signature mismatch; refresh the table design preview".into());
    }
    if provided_preview_signature != preview.preview_signature {
        return Err("preview signature mismatch; refresh the table design preview".into());
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

    fn col(name: &str, column_type: &str, nullable: bool, primary_key: bool, comment: &str) -> ColumnDesignMeta {
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

    fn draft_from(meta: &TableDesignMeta) -> TableDesignDraft {
        TableDesignDraft {
            table_comment: meta.table_comment.clone(),
            columns: meta.columns.iter().map(|column| ColumnDesignDraft {
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
            }).collect(),
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
    fn rename_generates_change_column() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.columns[1].name = "login_name".into();

        let result = preview(&current, &draft);

        assert!(result.statements.iter().any(|sql| sql.contains("CHANGE COLUMN `username` `login_name` varchar(32) NOT NULL COMMENT '用户名'")), "statements were {:?}", result.statements);
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
        assert!(modify_sql.contains("MODIFY COLUMN `id` bigint NOT NULL AUTO_INCREMENT COMMENT '玩家编号'"), "statements were {:?}", modify_result.statements);

        let mut change_draft = draft_from(&current);
        change_draft.columns[0].name = "player_id".into();
        change_draft.columns[0].comment = "玩家编号".into();
        let change_result = preview(&current, &change_draft);
        let change_sql = change_result.statements.join("\n");
        assert!(change_sql.contains("CHANGE COLUMN `id` `player_id` bigint NOT NULL AUTO_INCREMENT COMMENT '玩家编号'"), "statements were {:?}", change_result.statements);
    }

    #[test]
    fn unrecognized_extra_is_not_emitted_in_column_definitions() {
        let mut current = meta();
        current.columns[0].extra = "auto_increment, made_up_extra".into();
        let mut draft = draft_from(&current);
        draft.columns[0].comment = "玩家编号".into();

        let result = preview(&current, &draft);
        let sql = result.statements.join("\n");

        assert!(sql.contains("AUTO_INCREMENT"), "statements were {:?}", result.statements);
        assert!(!sql.contains("made_up_extra"), "statements were {:?}", result.statements);
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
        assert!(result.statements.join("\n").contains("DEFAULT CURRENT_TIMESTAMP"), "statements were {:?}", result.statements);

        let mut rejected = draft_from(&current);
        rejected.columns[1].default_mode = "expression".into();
        rejected.columns[1].default_value = Some("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP".into());

        let err = preview_table_design_change(&current, &rejected).expect_err("unsafe expression default should be rejected");
        assert!(err.to_lowercase().contains("default expression"), "error was {err}");
    }

    #[test]
    fn removing_primary_key_before_making_column_nullable_orders_clauses_safely() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.columns[0].primary_key = false;
        draft.columns[0].nullable = true;

        let result = preview(&current, &draft);
        let joined = result.statements.join(";\n");
        let drop_index = joined.find("DROP PRIMARY KEY").expect("drop primary key clause should be present");
        let modify_index = joined.find("MODIFY COLUMN `id`").expect("id modification should be present");

        assert!(drop_index < modify_index, "statements were {:?}", result.statements);
    }

    #[test]
    fn table_comment_and_column_change_are_combined_into_one_statement() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.table_comment = "玩家配置 live".into();
        draft.columns[1].data_type = "varchar".into();
        draft.columns[1].length = Some(48);

        let result = preview(&current, &draft);

        assert_eq!(result.statements.len(), 1, "statements were {:?}", result.statements);
        assert!(result.statements[0].contains("MODIFY COLUMN `username` varchar(48) NOT NULL COMMENT '用户名'"), "statements were {:?}", result.statements);
        assert!(result.statements[0].contains("COMMENT = '玩家配置 live'"), "statements were {:?}", result.statements);
    }

    #[test]
    fn primary_key_change_generates_drop_column_modify_and_add_primary_key() {
        let current = meta();
        let mut draft = draft_from(&current);
        draft.columns[2].primary_key = true;
        draft.columns[2].nullable = false;

        let result = preview(&current, &draft);
        let joined = result.statements.join(";\n");
        let drop_index = joined.find("DROP PRIMARY KEY").expect("drop primary key clause should be present");
        let modify_index = joined.find("MODIFY COLUMN `nickname`").expect("nickname modification should be present");
        let add_index = joined.find("ADD PRIMARY KEY (`id`, `nickname`)").expect("add primary key clause should be present");

        assert!(drop_index < modify_index, "statements were {:?}", result.statements);
        assert!(modify_index < add_index, "statements were {:?}", result.statements);
    }

    #[test]
    fn duplicate_invalid_names_and_unsupported_types_are_rejected() {
        let current = meta();
        let mut duplicate = draft_from(&current);
        duplicate.columns[1].name = "nickname".into();
        assert!(preview_table_design_change(&current, &duplicate).unwrap_err().to_lowercase().contains("duplicate"));

        let mut invalid = draft_from(&current);
        invalid.columns[1].name = "bad-name".into();
        assert!(preview_table_design_change(&current, &invalid).unwrap_err().to_lowercase().contains("identifier"));

        let mut unsupported = draft_from(&current);
        unsupported.columns[1].data_type = "geometry".into();
        assert!(preview_table_design_change(&current, &unsupported).unwrap_err().to_lowercase().contains("unsupported"));
    }

    #[test]
    fn omitted_existing_column_and_extra_new_column_are_rejected() {
        let current = meta();
        let mut omitted = draft_from(&current);
        omitted.columns.remove(1);
        assert!(preview_table_design_change(&current, &omitted).unwrap_err().to_lowercase().contains("drop"));

        let mut extra = draft_from(&current);
        extra.columns.push(ColumnDesignDraft {
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
        assert!(preview_table_design_change(&current, &extra).unwrap_err().to_lowercase().contains("add"));
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
        assert!(verify_table_design_apply(&current, &stale_request).unwrap_err().to_lowercase().contains("signature"));

        stale_request.preview_signature = None;
        assert!(verify_table_design_apply(&current, &stale_request).unwrap_err().to_lowercase().contains("preview"));
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

        assert!(joined.contains("`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'"), "statements were {:?}", result.statements);
        assert!(!joined.contains("DEFAULT 'CURRENT_TIMESTAMP'"));
        assert!(joined.contains("`nickname` varchar(64) NULL DEFAULT 'guest''s alias' COMMENT '昵称'"), "statements were {:?}", result.statements);
    }
}
