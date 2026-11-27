use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::commands;
use crate::perf::PerfContext;
use crate::types::*;

pub const READ_TOOLS: &[&str] = &[
    "get_table_design", "preview_table_design_change", "preview_create_table",
];
pub const WRITE_TOOLS: &[&str] = &[
    "run_write_query",
    "apply_table_design_change",
    "create_table",
    "copy_tables",
    "rename_table",
    "drop_tables",
];

pub fn validate_request(func: &str, args: &Value) -> Result<(), String> {
    if !READ_TOOLS.contains(&func) && !WRITE_TOOLS.contains(&func) {
        return Err(format!("unsupported table tool: {func}"));
    }
    if WRITE_TOOLS.contains(&func) && args.get("confirmed").and_then(Value::as_bool) != Some(true) {
        return Err("必须先取得用户对本次操作的确认，并传入 confirmed=true".into());
    }
    let context_fields: &[&str] = if func == "copy_tables" {
        &["sourceConnectionId", "sourceDatabase", "targetConnectionId", "targetDatabase"]
    } else {
        &["connectionId", "database"]
    };
    for field in context_fields {
        required_string(args, field)?;
    }
    match func {
        "get_table_design" | "preview_table_design_change" | "apply_table_design_change" | "rename_table" | "preview_create_table" | "create_table" => {
            required_string(args, "table")?;
        }
        "run_write_query" => {
            required_string(args, "sql")?;
        }
        "copy_tables" | "drop_tables" => {
            let tables = args.get("tables").and_then(Value::as_array)
                .filter(|tables| !tables.is_empty())
                .ok_or("tables 必须是非空表名列表")?;
            for table in tables {
                if table.as_str().is_none_or(|name| name.trim().is_empty() || name.contains('`')) {
                    return Err("表名不能为空或包含反引号".into());
                }
            }
        }
        _ => {}
    }
    if func == "rename_table" {
        required_string(args, "newName")?;
    }
    if func == "apply_table_design_change" {
        for field in ["schemaSignature", "sourceSignature", "previewSignature"] {
            required_string(args, field)?;
        }
    }
    if func == "create_table" {
        required_string(args, "previewSignature")?;
    }
    if func == "copy_tables" {
        match args.get("mode").and_then(Value::as_str) {
            None | Some("copy" | "overwrite") => {}
            _ => return Err("mode 必须是 copy 或 overwrite".into()),
        }
    }
    Ok(())
}

fn required_string(args: &Value, field: &str) -> Result<String, String> {
    let value = args.get(field).and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("必须明确提供 {field}"))?;
    if matches!(field, "database" | "sourceDatabase" | "targetDatabase" | "table" | "newName")
        && value.contains('`')
    {
        return Err(format!("{field} 不能包含反引号"));
    }
    Ok(value.to_string())
}

fn serialize(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

pub async fn run(app: &AppHandle, func: &str, args: Value) -> Result<Value, String> {
    validate_request(func, &args)?;
    let state = app.state::<AppState>();
    if matches!(func, "preview_create_table" | "create_table") {
        let definition = crate::table_create::CreateTableRequest {
            connection_id: required_string(&args, "connectionId")?,
            database: required_string(&args, "database")?,
            table_name: required_string(&args, "table")?,
            draft: serde_json::from_value(args["draft"].clone())
                .map_err(|error| format!("无效的建表草稿：{error}"))?,
        };
        return if func == "preview_create_table" {
            serialize(crate::table_create::preview_create_table(definition, state).await?)
        } else {
            serialize(crate::table_create::create_table(
                crate::table_create::ApplyCreateTableRequest {
                    definition,
                    preview_signature: required_string(&args, "previewSignature")?,
                    confirmed: true,
                }, app.clone(), state,
            ).await?)
        };
    }
    if func == "copy_tables" {
        let request = CopyTablesRequest {
            source_connection_id: required_string(&args, "sourceConnectionId")?,
            source_database: required_string(&args, "sourceDatabase")?,
            table_names: serde_json::from_value(args["tables"].clone()).map_err(|error| error.to_string())?,
            target_connection_id: required_string(&args, "targetConnectionId")?,
            target_database: required_string(&args, "targetDatabase")?,
            mode: args.get("mode").and_then(Value::as_str).unwrap_or("copy").into(),
            structure_only: args.get("structureOnly").and_then(Value::as_bool).unwrap_or(false),
            operation_id: None,
        };
        return serialize(commands::copy_tables(request, PerfContext::default(), app.clone(), state).await?);
    }
    let connection_id = required_string(&args, "connectionId")?;
    let database = required_string(&args, "database")?;
    let table = args.get("table").and_then(Value::as_str).unwrap_or_default().to_string();
    match func {
        "get_table_design" => serialize(commands::get_table_design(
            Some(connection_id), Some(database), table, state,
        ).await?),
        "preview_table_design_change" => {
            let draft: TableDesignDraft = serde_json::from_value(args["draft"].clone())
                .map_err(|error| format!("无效的表设计草稿: {error}"))?;
            serialize(commands::preview_table_design_change(
                Some(TableDesignPreviewRequest { connection_id, database, table_name: table, draft, validation_id: None }),
                None, None, None, None, None, state,
            ).await?)
        }
        "apply_table_design_change" => {
            let draft: TableDesignDraft = serde_json::from_value(args["draft"].clone())
                .map_err(|error| format!("无效的表设计草稿: {error}"))?;
            serialize(commands::apply_table_design_change(
                Some(ApplyTableDesignRequest {
                    connection_id, database, table_name: table, draft,
                    schema_signature: Some(required_string(&args, "schemaSignature")?),
                    source_signature: Some(required_string(&args, "sourceSignature")?),
                    preview_signature: Some(required_string(&args, "previewSignature")?),
                }),
                None, None, None, None, None, None, None, PerfContext::default(), app.clone(), state,
            ).await?)
        }
        "rename_table" => serialize(commands::rename_table(
            connection_id, database, table, required_string(&args, "newName")?,
            PerfContext::default(), app.clone(), state,
        ).await?),
        "drop_tables" => serialize(commands::drop_tables(
            DropTablesRequest {
                connection_id, database,
                tables: serde_json::from_value(args["tables"].clone()).map_err(|error| error.to_string())?,
            }, PerfContext::default(), app.clone(), state,
        ).await?),
        _ => Err(format!("unsupported table tool: {func}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_require_explicit_confirmation_and_target() {
        for func in WRITE_TOOLS {
            assert!(validate_request(func, &json!({})).is_err());
            assert!(validate_request(func, &json!({"confirmed": true})).is_err());
        }
        let mut args = json!({"connectionId": "mysql-1", "database": "test", "sql": "UPDATE t SET x=1", "confirmed": true});
        assert!(validate_request("run_write_query", &args).is_ok());
        for confirmation in [json!(false), json!("true"), Value::Null] {
            args["confirmed"] = confirmation;
            assert!(validate_request("run_write_query", &args).is_err());
        }
    }

    #[test]
    fn table_design_apply_requires_all_preview_signatures() {
        let mut args = json!({"connectionId": "mysql-1", "database": "test", "table": "items", "confirmed": true});
        for field in ["schemaSignature", "sourceSignature", "previewSignature"] {
            assert!(validate_request("apply_table_design_change", &args).is_err());
            args[field] = json!("signature");
        }
        assert!(validate_request("apply_table_design_change", &args).is_ok());
    }

    #[test]
    fn table_operations_reject_empty_lists_and_unsafe_identifiers() {
        let mut args = json!({"connectionId": "mysql-1", "database": "test", "tables": [], "confirmed": true});
        assert!(validate_request("drop_tables", &args).is_err());
        args["tables"] = json!(["items"]);
        assert!(validate_request("drop_tables", &args).is_ok());
        args["tables"] = json!(["items`"]);
        assert!(validate_request("drop_tables", &args).is_err());
        assert!(validate_request("unknown", &args).is_err());
    }

    #[test]
    fn create_requires_preview_confirmation_and_explicit_scope() {
        let mut args = json!({"connectionId":"c","database":"game","table":"items"});
        assert!(validate_request("preview_create_table", &args).is_ok());
        assert!(validate_request("create_table", &args).is_err());
        args["confirmed"] = json!(true);
        assert!(validate_request("create_table", &args).is_err());
        args["previewSignature"] = json!("signature");
        assert!(validate_request("create_table", &args).is_ok());
        args["database"] = json!("");
        assert!(validate_request("preview_create_table", &args).is_err());
        assert!(validate_request("create_table", &args).is_err());
    }
}
