use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::MySqlPool;
use tauri::{AppHandle, Emitter, State};

use crate::perf::PerfContext;
use crate::types::*;
use crate::{audit, commands, ddl};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTableRequest {
    pub connection_id: String,
    pub database: String,
    pub table_name: String,
    pub draft: TableDesignDraft,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyCreateTableRequest {
    #[serde(flatten)]
    pub definition: CreateTableRequest,
    pub preview_signature: String,
    pub confirmed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableResult {
    pub applied: bool,
    pub schema: TableDesignMeta,
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
}

fn empty_design(request: &CreateTableRequest) -> TableDesignMeta {
    TableDesignMeta {
        source: TableDesignSource {
            connection_id: request.connection_id.clone(),
            database: request.database.clone(),
            table_name: request.table_name.clone(),
        },
        table_name: request.table_name.clone(),
        table_comment: String::new(),
        engine: String::new(),
        charset: String::new(),
        collation: String::new(),
        schema_signature: None,
        columns: vec![],
        indexes: vec![],
    }
}

pub fn preview(request: &CreateTableRequest) -> Result<TableDesignPreview, String> {
    if request.connection_id.trim().is_empty()
        || request.database.trim().is_empty()
        || request.database.chars().count() > 64
        || request.database.contains('\0')
    {
        return Err("必须明确指定有效的连接和数据库".into());
    }
    if request.table_name.chars().count() > 64
        || request.draft.columns.len() > 256
        || request.draft.table_comment.chars().count() > 2048
    {
        return Err("表名最多 64 字符、字段最多 256 个、表备注最多 2048 字符".into());
    }
    let current = empty_design(request);
    ddl::validate_draft_shape(&current, &request.draft)?;
    let mut definitions = Vec::new();
    for column in &request.draft.columns {
        if !column.original_name.is_empty()
            || column.name.chars().count() > 64
            || column.comment.chars().count() > 1024
            || column.default_value.as_ref().is_some_and(|value| value.len() > 16384)
        {
            return Err("新字段 originalName 必须为空；字段名最多 64 字符、备注最多 1024 字符，默认值不得超长".into());
        }
        if column.primary_key && column.nullable {
            return Err(format!("主键字段 {} 不能允许 NULL", column.name));
        }
        definitions.push(format!(
            "`{}` {}",
            crate::db::escape_ident(&column.name),
            ddl::column_definition_sql(column, &ddl::empty_column_meta())?
        ));
    }
    let keys = ddl::primary_key_final_names_from_draft(&request.draft);
    if !keys.is_empty() {
        let key_names = keys.iter()
            .map(|key| format!("`{}`", crate::db::escape_ident(key)))
            .collect::<Vec<_>>()
            .join(", ");
        definitions.push(format!("PRIMARY KEY ({key_names})"));
    }
    if let Some(indexes) = &request.draft.indexes {
        for index in indexes {
            definitions.push(ddl::create_index_definition_sql(index, &request.draft)?);
        }
    }
    let engine = match request.draft.engine.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(value) => ddl::validate_engine(value)?,
        None => "InnoDB".to_string(),
    };
    let mut table_options = vec![format!("ENGINE={engine}")];
    if let Some(charset) = request.draft.charset.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let cs = ddl::validate_charset_token(charset, "字符集")?;
        table_options.push(format!("DEFAULT CHARSET={cs}"));
    }
    if let Some(collation) = request.draft.collation.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let col = ddl::validate_charset_token(collation, "排序规则")?;
        table_options.push(format!("COLLATE={col}"));
    }
    let comment = request.draft.table_comment.replace('\\', "\\\\").replace('\'', "''");
    table_options.push(format!("COMMENT='{comment}'"));
    let sql = format!(
        "CREATE TABLE {} (\n  {}\n) {}",
        crate::db::qualified_table(&request.database, &request.table_name),
        definitions.join(",\n  "),
        table_options.join(" "),
    );
    let encoded = serde_json::to_vec(&("create-table-v1", request, &sql))
        .map_err(|error| error.to_string())?;
    let signature = format!("create:{:x}", Sha256::digest(encoded));
    let mut warnings = vec!["仅创建空表，不覆盖已有表；DDL 不支持事务撤销，也不会自动删除已创建的表".into()];
    if keys.is_empty() {
        warnings.push("没有主键，后续编辑和准确定位记录可能受限".into());
    }
    Ok(TableDesignPreview {
        signature: signature.clone(),
        preview_signature: signature.clone(),
        source_signature: signature.clone(),
        schema_signature: signature,
        statements: vec![sql],
        warnings,
        has_changes: true,
        conflicts: vec![],
        human_descriptions: vec![format!(
            "创建空表 {}.{}，共 {} 个字段",
            request.database, request.table_name, request.draft.columns.len()
        )],
    })
}

fn verify(request: &ApplyCreateTableRequest) -> Result<TableDesignPreview, String> {
    if !request.confirmed {
        return Err("创建表前必须确认本次目标和字段设计".into());
    }
    let preview = preview(&request.definition)?;
    if preview.preview_signature != request.preview_signature {
        return Err("创建表预览已变化，请重新预览后确认".into());
    }
    Ok(preview)
}

async fn target_pool(
    state: &State<'_, AppState>,
    request: &CreateTableRequest,
) -> Result<Option<MySqlPool>, String> {
    let live = {
        let runtime = state.runtime.lock().await;
        let connection = runtime.connections.get(&request.connection_id).ok_or("连接不存在")?;
        if connection.kind != DatabaseKind::MySql {
            return Err("创建表仅支持可写 MySQL 连接".into());
        }
        connection.mysql_url.is_some()
    };
    if live {
        commands::real_database_pool(
            &request.connection_id, &request.database, state, &PerfContext::default(),
        ).await.map(Some)
    } else {
        Ok(None)
    }
}

async fn ensure_absent(pool: &MySqlPool, request: &CreateTableRequest) -> Result<(), String> {
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?")
        .bind(&request.database)
        .bind(&request.table_name)
        .fetch_one(pool).await.map_err(|error| error.to_string())?;
    if exists > 0 {
        return Err("同名表或视图已存在，不能覆盖；请更换表名".into());
    }
    Ok(())
}

fn demo_schema(runtime: &RuntimeState, database: &str) -> Vec<TableMeta> {
    commands::demo_schema_for_runtime(
        &runtime.demo_schema_overrides, runtime.demo_profile, database,
        &runtime.selected_database, &runtime.schema,
    )
}

fn ensure_demo_absent(schema: &[TableMeta], name: &str) -> Result<(), String> {
    if schema.iter().any(|table| table.table_name.eq_ignore_ascii_case(name)) {
        return Err("同名表已存在，不能覆盖；请更换表名".into());
    }
    Ok(())
}

async fn execute_create(pool: &MySqlPool, statements: &[String]) -> Result<(), String> {
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    connection.close_on_drop();
    crate::table_design_validation::configure_strict_session(&mut connection).await?;
    let row = sqlx::query("SELECT @@SESSION.sql_mode AS sql_mode")
        .fetch_one(&mut *connection).await.map_err(|error| error.to_string())?;
    let mode = crate::mysql_text::string(&row, "sql_mode").map_err(|error| error.to_string())?;
    let mode = mode.split(',')
        .filter(|mode| !mode.eq_ignore_ascii_case("NO_BACKSLASH_ESCAPES"))
        .collect::<Vec<_>>().join(",");
    sqlx::query("SET SESSION sql_mode = ?").bind(mode)
        .execute(&mut *connection).await.map_err(|error| error.to_string())?;
    for statement in statements {
        sqlx::query(statement).execute(&mut *connection).await.map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn designed_table(request: &CreateTableRequest) -> Result<(TableDesignMeta, TableMeta), String> {
    let mut design = empty_design(request);
    design.table_comment = request.draft.table_comment.clone();
    design.engine = request.draft.engine.clone().unwrap_or_else(|| "InnoDB".into());
    design.charset = request.draft.charset.clone().unwrap_or_default();
    design.collation = request.draft.collation.clone().unwrap_or_default();
    if let Some(indexes) = &request.draft.indexes {
        design.indexes = indexes
            .iter()
            .map(|idx| TableIndexMeta {
                name: idx.name.trim().to_string(),
                index_type: ddl::normalize_index_type(&idx.index_type).unwrap_or("INDEX").to_string(),
                columns: idx.columns.clone(),
                comment: idx.comment.clone(),
            })
            .collect();
    }
    let keys = ddl::primary_key_final_names_from_draft(&request.draft);
    let mut columns = Vec::new();
    for (index, column) in request.draft.columns.iter().enumerate() {
        let column_type = ddl::column_type_sql(column)?;
        let mut meta = ColumnMeta::with_basic(
            &column.name, &column_type, &column.comment, column.primary_key, column.nullable,
        );
        meta.default_mode = Some(column.default_mode.clone());
        meta.default_value = column.default_value.clone();
        meta.is_auto_increment = column.auto_increment.unwrap_or(false);
        columns.push(meta);
        design.columns.push(ColumnDesignMeta {
            ordinal: index as u32 + 1,
            column_name: column.name.clone(),
            column_type,
            data_type: crate::mysql_column_types::normalize_data_type(&column.data_type),
            length: column.length,
            scale: column.scale,
            is_nullable: column.nullable,
            is_primary_key: column.primary_key,
            primary_key_ordinal: keys.iter().position(|key| key == &column.name).map(|index| index as u32 + 1),
            default_mode: column.default_mode.clone(),
            default_value: column.default_value.clone(),
            column_comment: column.comment.clone(),
            extra: if column.auto_increment.unwrap_or(false) { "auto_increment".into() } else { String::new() },
            ..ddl::empty_column_meta()
        });
    }
    design.schema_signature = Some(ddl::schema_signature(&design));
    Ok((design, TableMeta {
        table_name: request.table_name.clone(),
        table_comment: request.draft.table_comment.clone(),
        columns,
        primary_key_order: keys,
    }))
}

#[tauri::command]
pub async fn preview_create_table(
    request: CreateTableRequest,
    state: State<'_, AppState>,
) -> Result<TableDesignPreview, String> {
    let preview = preview(&request)?;
    match target_pool(&state, &request).await? {
        Some(pool) => ensure_absent(&pool, &request).await?,
        None => ensure_demo_absent(
            &demo_schema(&*state.runtime.lock().await, &request.database), &request.table_name,
        )?,
    }
    Ok(preview)
}

#[tauri::command]
pub async fn create_table(
    request: ApplyCreateTableRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CreateTableResult, String> {
    let preview = verify(&request)?;
    let definition = &request.definition;
    let (mut design, table) = designed_table(definition)?;
    let mut warnings = Vec::new();
    if let Some(pool) = target_pool(&state, definition).await? {
        ensure_absent(&pool, definition).await?;
        let audit_pool = audit::ensure_audit_pool(&app, &state).await?;
        let (actor, client_id) = crate::account::audit_actor_and_id(&app, &state).await;
        let audit_id = audit::record_pending(
            &audit_pool,
            &audit::AuditContext {
                connection_id: definition.connection_id.clone(),
                database: definition.database.clone(),
                table_name: definition.table_name.clone(),
                session_id: None,
                source: audit::SOURCE_DDL,
                actor,
                client_id,
            },
            &audit::PendingAudit {
                operation: "DDL",
                column_name: None,
                old_value: None,
                new_value: Some(serde_json::to_string(&definition.draft).map_err(|error| error.to_string())?),
                row_identity: None,
                forward_sql: preview.statements.join(";\n"),
                forward_binds: vec![],
                inverse_sql: None,
                inverse_binds: vec![],
                rollback_strategy: audit::STRATEGY_DDL,
                notes: Some("创建空表；不自动回滚或删除表".into()),
            },
        ).await?;
        if let Err(error) = execute_create(&pool, &preview.statements).await {
            return Err(format!("创建表未确认成功：{error}。请刷新表列表核实后再操作；审计记录保留为待核实，不能假定已回滚（记录 {audit_id}）"));
        }
        if let Err(error) = audit::mark_committed_required(&audit_pool, audit_id).await {
            warnings.push(format!("表已创建，但审计状态保存失败：{error}；请勿重复创建，审计记录 {audit_id}"));
        }
        crate::audit_sync::trigger_immediate_sync(&app);
        crate::table_modified::record_local_change(
            &app,
            &state,
            &definition.connection_id,
            &definition.database,
            &[definition.table_name.as_str()],
        )
        .await;
        match crate::db::read_table_design(
            &pool, &definition.database, &definition.table_name, &definition.connection_id,
        ).await {
            Ok(actual) => design = actual,
            Err(error) => warnings.push(format!("表已创建，但结构回读失败，请刷新后核实：{error}")),
        }
    } else {
        let mut runtime = state.runtime.lock().await;
        let mut schema = demo_schema(&runtime, &definition.database);
        ensure_demo_absent(&schema, &definition.table_name)?;
        schema.push(table);
        runtime.demo_rows.insert(commands::demo_row_key(&definition.database, &definition.table_name), vec![]);
        runtime.demo_schema_overrides.insert(definition.database.clone(), schema.clone());
        if runtime.selected_database == definition.database {
            runtime.schema = schema;
        }
    }
    commands::invalidate_table_schema(&state, &definition.connection_id, &definition.database, &definition.table_name);
    let _ = app.emit("table-created", serde_json::json!({
        "connectionId": definition.connection_id,
        "database": definition.database,
        "tableName": definition.table_name,
        "warnings": warnings,
    }));
    Ok(CreateTableResult { applied: true, schema: design, statements: preview.statements, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> CreateTableRequest {
        serde_json::from_value(serde_json::json!({"connectionId":"c","database":"game","tableName":"new_table","draft":{"tableComment":"test's table","columns":[{"originalName":"","name":"ID","type":"int","unsigned":true,"nullable":false,"primaryKey":true,"primaryKeyOrdinal":1,"defaultMode":"none","comment":"identifier"},{"originalName":"","name":"Name","type":"varchar","length":100,"nullable":true,"primaryKey":false,"defaultMode":"value","defaultValue":"a'b\\c","comment":"name"}]}})).unwrap()
    }

    #[test]
    fn create_is_qualified_empty_and_never_overwrites() {
        let preview = preview(&request()).unwrap();
        let sql = &preview.statements[0];
        assert!(sql.starts_with("CREATE TABLE `game`.`new_table`"));
        assert!(sql.contains("`ID` int unsigned NOT NULL"));
        assert!(sql.contains("PRIMARY KEY (`ID`)"));
        assert!(sql.contains("a''b\\\\c"));
        for forbidden in ["IF NOT EXISTS","DROP TABLE","INSERT","ALTER TABLE"] { assert!(!sql.contains(forbidden)); }
    }

    #[test]
    fn confirmation_and_target_draft_drift_are_rejected() {
        let definition=request();
        let mut apply=ApplyCreateTableRequest { preview_signature:preview(&definition).unwrap().preview_signature,definition,confirmed:false };
        assert!(verify(&apply).is_err());
        apply.confirmed=true;
        assert!(verify(&apply).is_ok());
        apply.definition.database="other".into();
        assert!(verify(&apply).is_err());
        let mut definition=request();
        definition.draft.columns[1].name="ID".into();
        assert!(preview(&definition).is_err());
        definition=request();
        definition.table_name="bad; DROP TABLE x".into();
        assert!(preview(&definition).is_err());
        definition=request();
        definition.draft.columns[0].original_name="ID".into();
        assert!(preview(&definition).is_err());
    }

    #[test]
    fn demo_metadata_preserves_defaults_and_primary_key_order() {
        let definition=request();
        let (design,table)=designed_table(&definition).unwrap();
        assert_eq!(design.columns[1].default_value,Some("a'b\\c".into()));
        assert!(table.columns[0].is_unsigned);
        assert_eq!(table.primary_key_order,vec!["ID"]);
        assert!(ensure_demo_absent(&[table],"NEW_TABLE").is_err());
    }

    #[test]
    fn desktop_apply_payload_deserializes_and_requires_confirmation() {
        let definition = request();
        let mut payload = serde_json::to_value(&definition).unwrap();
        payload["previewSignature"] = preview(&definition).unwrap().preview_signature.into();
        payload["confirmed"] = true.into();
        let apply: ApplyCreateTableRequest = serde_json::from_value(payload.clone()).unwrap();
        assert!(verify(&apply).is_ok());
        payload.as_object_mut().unwrap().remove("confirmed");
        assert!(serde_json::from_value::<ApplyCreateTableRequest>(payload).is_err());
    }

    #[test]
    fn draft_changes_and_invalid_defaults_require_a_new_preview() {
        let definition = request();
        let signature = preview(&definition).unwrap().preview_signature;
        let mut changed = definition.clone();
        changed.draft.columns[1].comment = "new comment".into();
        assert!(verify(&ApplyCreateTableRequest {
            definition: changed, preview_signature: signature, confirmed: true,
        }).is_err());
        let mut invalid = definition.clone();
        invalid.draft.columns[0].nullable = true;
        assert!(preview(&invalid).is_err());
        invalid = definition.clone();
        invalid.draft.columns[1].default_mode = "expression".into();
        invalid.draft.columns[1].default_value = Some("1); DROP TABLE items".into());
        assert!(preview(&invalid).is_err());
        invalid = definition;
        invalid.draft.columns[1].name = "a".repeat(65);
        assert!(preview(&invalid).is_err());
    }

    #[test]
    fn ordered_primary_keys_and_missing_key_warning_are_preserved() {
        let mut definition = request();
        definition.draft.columns[0].primary_key_ordinal = Some(2);
        definition.draft.columns[1].primary_key = true;
        definition.draft.columns[1].primary_key_ordinal = Some(1);
        definition.draft.columns[1].nullable = false;
        assert!(preview(&definition).unwrap().statements[0].contains("PRIMARY KEY (`Name`, `ID`)"));
        assert_eq!(designed_table(&definition).unwrap().1.primary_key_order, vec!["Name", "ID"]);
        for column in &mut definition.draft.columns {
            column.primary_key = false;
            column.primary_key_ordinal = None;
        }
        let result = preview(&definition).unwrap();
        assert!(!result.statements[0].contains("PRIMARY KEY"));
        assert_eq!(result.warnings.len(), 2);
    }

    #[test]
    fn create_table_supports_auto_increment_indexes_and_table_options() {
        let mut definition = request();
        definition.draft.engine = Some("MyISAM".into());
        definition.draft.charset = Some("utf8mb4".into());
        definition.draft.collation = Some("utf8mb4_unicode_ci".into());
        definition.draft.columns[0].auto_increment = Some(true);
        definition.draft.indexes = Some(vec![TableIndexDraft {
            original_name: String::new(),
            name: "idx_name".into(),
            index_type: "UNIQUE".into(),
            columns: vec!["Name".into()],
            comment: "unique name".into(),
        }]);
        let result = preview(&definition).unwrap();
        let sql = &result.statements[0];
        assert!(sql.contains("`ID` int unsigned NOT NULL AUTO_INCREMENT"));
        assert!(sql.contains("UNIQUE KEY `idx_name` (`Name`) COMMENT 'unique name'"));
        assert!(sql.contains("ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"));
    }
}
