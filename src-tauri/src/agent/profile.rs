use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::types::{ColumnMeta, TableMeta};

const PROFILE_VERSION: u32 = 1;
const MAX_SAMPLE_VALUES_PER_COLUMN: usize = 3;
const MAX_SEARCH_RESULTS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProfile {
    pub version: u32,
    pub status: String,
    pub connection_id: String,
    pub database: String,
    pub schema_signature: String,
    pub generated_at: u64,
    pub table_count: usize,
    pub column_count: usize,
    pub core_tables: Vec<String>,
    pub config_tables: Vec<String>,
    pub log_tables: Vec<String>,
    pub relationship_tables: Vec<String>,
    pub tables: Vec<ProfileTable>,
    pub relationships: Vec<ProfileRelationship>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTable {
    pub table_name: String,
    pub table_comment: String,
    pub role: String,
    pub confidence: f32,
    pub evidence: Vec<String>,
    pub row_count_estimate: Option<u64>,
    pub primary_keys: Vec<String>,
    pub indexes: Vec<ProfileIndex>,
    pub columns: Vec<ProfileColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileIndex {
    pub index_name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileColumn {
    pub column_name: String,
    pub column_type: String,
    pub data_type: String,
    pub column_comment: String,
    pub is_primary_key: bool,
    pub is_nullable: bool,
    pub sensitive: bool,
    pub sample_values: Vec<String>,
    pub semantic_hints: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRelationship {
    pub from_table: String,
    pub from_column: String,
    pub to_table: String,
    pub to_column: String,
    pub confidence: f32,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSearchResult {
    pub kind: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub label: String,
    pub preview: String,
    pub score: u32,
    pub reference: ProfileReference,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileReference {
    pub kind: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub row_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedTablesResult {
    pub table_name: String,
    pub relationships: Vec<ProfileRelationship>,
    pub related_tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCacheEntry {
    pub profile: DatabaseProfile,
}

static PROFILE_CACHE: OnceLock<Mutex<HashMap<String, ProfileCacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, ProfileCacheEntry>> {
    PROFILE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn profile_cache_key(connection_id: &str, database: &str) -> String {
    format!("{}\x1f{}", connection_id, database)
}

pub fn get_cached_profile(
    connection_id: &str,
    database: &str,
    schema_signature: &str,
) -> Option<DatabaseProfile> {
    let guard = cache().lock().ok()?;
    let entry = guard.get(&profile_cache_key(connection_id, database))?;
    let mut profile = entry.profile.clone();
    if profile.schema_signature != schema_signature {
        profile.status = "stale".into();
    }
    Some(profile)
}

pub fn store_profile(profile: DatabaseProfile) -> DatabaseProfile {
    if let Ok(mut guard) = cache().lock() {
        guard.insert(
            profile_cache_key(&profile.connection_id, &profile.database),
            ProfileCacheEntry {
                profile: profile.clone(),
            },
        );
    }
    profile
}

pub fn schema_signature(schema: &[TableMeta]) -> String {
    let mut parts = Vec::new();
    for table in schema {
        let mut column_parts = Vec::new();
        for column in &table.columns {
            column_parts.push(format!(
                "{}:{}:{}:{}:{}",
                column.column_name,
                column.column_type,
                column.column_comment,
                column.is_primary_key,
                column.is_nullable
            ));
        }
        parts.push(format!(
            "{}:{}:[{}]",
            table.table_name,
            table.table_comment,
            column_parts.join(",")
        ));
    }
    format!("v{PROFILE_VERSION}:{}", stable_hash(&parts.join("|")))
}

pub fn build_database_profile(
    connection_id: &str,
    database: &str,
    schema: &[TableMeta],
    sample_rows: &HashMap<String, Vec<HashMap<String, String>>>,
    row_counts: Option<&HashMap<String, u64>>,
    indexes: Option<&HashMap<String, Vec<ProfileIndex>>>,
) -> DatabaseProfile {
    let signature = schema_signature(schema);
    let relationships = infer_relationships(schema);
    let mut tables = Vec::new();
    let mut core_tables = Vec::new();
    let mut config_tables = Vec::new();
    let mut log_tables = Vec::new();
    let mut relationship_tables = Vec::new();

    for table in schema {
        let (role, confidence, evidence) = classify_table(table, &relationships);
        match role.as_str() {
            "core" => core_tables.push(table.table_name.clone()),
            "config" => config_tables.push(table.table_name.clone()),
            "log" => log_tables.push(table.table_name.clone()),
            "relationship" => relationship_tables.push(table.table_name.clone()),
            _ => {}
        }
        let rows = sample_rows
            .get(&table.table_name)
            .cloned()
            .unwrap_or_default();
        let primary_keys = table
            .columns
            .iter()
            .filter(|column| column.is_primary_key)
            .map(|column| column.column_name.clone())
            .collect::<Vec<_>>();
        let table_indexes = indexes
            .and_then(|items| items.get(&table.table_name).cloned())
            .unwrap_or_else(|| primary_index_from_columns(&primary_keys));
        let columns = table
            .columns
            .iter()
            .map(|column| profile_column(column, &rows))
            .collect::<Vec<_>>();
        tables.push(ProfileTable {
            table_name: table.table_name.clone(),
            table_comment: table.table_comment.clone(),
            role,
            confidence,
            evidence,
            row_count_estimate: row_counts
                .and_then(|counts| counts.get(&table.table_name).copied()),
            primary_keys,
            indexes: table_indexes,
            columns,
        });
    }

    let column_count = schema.iter().map(|table| table.columns.len()).sum();
    let mut warnings = Vec::new();
    if schema.len() > 300 {
        warnings.push("画像基于轻量结构扫描和抽样生成，大库分析会按需补充查询".into());
    }

    DatabaseProfile {
        version: PROFILE_VERSION,
        status: "ready".into(),
        connection_id: connection_id.into(),
        database: database.into(),
        schema_signature: signature,
        generated_at: now_ts(),
        table_count: schema.len(),
        column_count,
        core_tables,
        config_tables,
        log_tables,
        relationship_tables,
        tables,
        relationships,
        warnings,
    }
}

fn primary_index_from_columns(primary_keys: &[String]) -> Vec<ProfileIndex> {
    if primary_keys.is_empty() {
        return Vec::new();
    }
    vec![ProfileIndex {
        index_name: "PRIMARY".into(),
        columns: primary_keys.to_vec(),
        unique: true,
        primary: true,
    }]
}

pub fn search_profile(profile: &DatabaseProfile, query: &str) -> Vec<ProfileSearchResult> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let mut results = Vec::new();
    for table in &profile.tables {
        let table_score = score_text(&q, &[&table.table_name, &table.table_comment, &table.role]);
        if table_score > 0 {
            results.push(ProfileSearchResult {
                kind: "table".into(),
                table_name: table.table_name.clone(),
                column_name: None,
                label: table.table_name.clone(),
                preview: format!("{} · {}", table.role, table.table_comment),
                score: table_score,
                reference: ProfileReference {
                    kind: "table".into(),
                    table_name: table.table_name.clone(),
                    column_name: None,
                    row_key: None,
                },
            });
        }
        for column in &table.columns {
            let hints = column.semantic_hints.join(" ");
            let score = score_text(
                &q,
                &[
                    &column.column_name,
                    &column.column_comment,
                    &column.column_type,
                    &hints,
                ],
            );
            if score == 0 {
                continue;
            }
            results.push(ProfileSearchResult {
                kind: "column".into(),
                table_name: table.table_name.clone(),
                column_name: Some(column.column_name.clone()),
                label: format!("{}.{}", table.table_name, column.column_name),
                preview: format!("{} · {}", column.column_type, column.column_comment),
                score,
                reference: ProfileReference {
                    kind: "column".into(),
                    table_name: table.table_name.clone(),
                    column_name: Some(column.column_name.clone()),
                    row_key: None,
                },
            });
        }
    }
    results.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.label.cmp(&right.label))
    });
    results.truncate(MAX_SEARCH_RESULTS);
    results
}

pub fn related_tables(profile: &DatabaseProfile, table_name: &str) -> RelatedTablesResult {
    let target = table_name.trim();
    let relationships = profile
        .relationships
        .iter()
        .filter(|rel| {
            rel.from_table.eq_ignore_ascii_case(target) || rel.to_table.eq_ignore_ascii_case(target)
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut related = HashSet::new();
    for rel in &relationships {
        if !rel.from_table.eq_ignore_ascii_case(target) {
            related.insert(rel.from_table.clone());
        }
        if !rel.to_table.eq_ignore_ascii_case(target) {
            related.insert(rel.to_table.clone());
        }
    }
    let mut related_tables = related.into_iter().collect::<Vec<_>>();
    related_tables.sort();
    RelatedTablesResult {
        table_name: target.into(),
        relationships,
        related_tables,
    }
}

fn profile_column(column: &ColumnMeta, rows: &[HashMap<String, String>]) -> ProfileColumn {
    let sensitive = is_sensitive_column(column);
    let mut sample_values = Vec::new();
    if !sensitive {
        for row in rows {
            let value = row.get(&column.column_name).cloned().unwrap_or_default();
            let trimmed = value.trim();
            if trimmed.is_empty() || sample_values.iter().any(|existing| existing == trimmed) {
                continue;
            }
            sample_values.push(trimmed.chars().take(80).collect());
            if sample_values.len() >= MAX_SAMPLE_VALUES_PER_COLUMN {
                break;
            }
        }
    }
    ProfileColumn {
        column_name: column.column_name.clone(),
        column_type: column.column_type.clone(),
        data_type: column
            .data_type
            .clone()
            .unwrap_or_else(|| base_type(&column.column_type)),
        column_comment: column.column_comment.clone(),
        is_primary_key: column.is_primary_key,
        is_nullable: column.is_nullable,
        sensitive,
        sample_values,
        semantic_hints: semantic_hints(column),
    }
}

fn classify_table(
    table: &TableMeta,
    relationships: &[ProfileRelationship],
) -> (String, f32, Vec<String>) {
    let name = table.table_name.to_lowercase();
    let comment = table.table_comment.to_lowercase();
    let mut evidence = Vec::new();
    if contains_any(
        &name,
        &["log", "audit", "history", "event", "trace", "record"],
    ) || contains_any(&comment, &["日志", "记录", "流水", "历史"])
    {
        evidence.push("表名或备注呈现日志/历史数据特征".into());
        return ("log".into(), 0.88, evidence);
    }
    if contains_any(
        &name,
        &["config", "cfg", "setting", "dict", "dictionary", "enum"],
    ) || contains_any(&comment, &["配置", "字典", "枚举", "模板"])
    {
        evidence.push("表名或备注呈现配置/字典数据特征".into());
        return ("config".into(), 0.86, evidence);
    }
    let outgoing = relationships
        .iter()
        .filter(|rel| rel.from_table.eq_ignore_ascii_case(&table.table_name))
        .count();
    let incoming = relationships
        .iter()
        .filter(|rel| rel.to_table.eq_ignore_ascii_case(&table.table_name))
        .count();
    if outgoing >= 2 && incoming == 0 {
        evidence.push("表中存在多个指向其它表的疑似外键".into());
        return ("relationship".into(), 0.72, evidence);
    }
    if incoming > 0 {
        evidence.push("被其它表引用，可能是业务主表".into());
        return ("core".into(), 0.75, evidence);
    }
    let has_id = table
        .columns
        .iter()
        .any(|column| column.is_primary_key && column.column_name.eq_ignore_ascii_case("id"));
    if has_id {
        evidence.push("存在 id 主键，可能承载独立业务对象".into());
        return ("core".into(), 0.58, evidence);
    }
    (
        "reference".into(),
        0.45,
        vec!["未发现明显日志、配置或关系特征".into()],
    )
}

fn infer_relationships(schema: &[TableMeta]) -> Vec<ProfileRelationship> {
    let mut pk_targets = Vec::new();
    for table in schema {
        for column in table.columns.iter().filter(|column| column.is_primary_key) {
            pk_targets.push((table.table_name.clone(), column.column_name.clone()));
        }
    }
    let mut relationships = Vec::new();
    let mut seen = HashSet::new();
    for table in schema {
        for column in &table.columns {
            if column.is_primary_key {
                continue;
            }
            let Some(target_table_hint) = foreign_key_table_hint(&column.column_name) else {
                continue;
            };
            for (target_table, target_column) in &pk_targets {
                if table.table_name.eq_ignore_ascii_case(target_table) {
                    continue;
                }
                if !target_table.eq_ignore_ascii_case(&target_table_hint) {
                    continue;
                }
                if !(target_column.eq_ignore_ascii_case("id")
                    || column
                        .column_name
                        .eq_ignore_ascii_case(&format!("{target_table}_{}", target_column)))
                {
                    continue;
                }
                let key = format!(
                    "{}\x1f{}\x1f{}\x1f{}",
                    table.table_name.to_lowercase(),
                    column.column_name.to_lowercase(),
                    target_table.to_lowercase(),
                    target_column.to_lowercase()
                );
                if !seen.insert(key) {
                    continue;
                }
                relationships.push(ProfileRelationship {
                    from_table: table.table_name.clone(),
                    from_column: column.column_name.clone(),
                    to_table: target_table.clone(),
                    to_column: target_column.clone(),
                    confidence: 0.72,
                    evidence: vec![format!(
                        "字段 {}.{} 命名匹配 {}.{}",
                        table.table_name, column.column_name, target_table, target_column
                    )],
                });
            }
        }
    }
    relationships
}

fn foreign_key_table_hint(column_name: &str) -> Option<String> {
    let lower = column_name.trim().to_lowercase();
    lower
        .strip_suffix("_id")
        .filter(|value| !value.is_empty() && *value != "id")
        .map(str::to_string)
}

fn is_sensitive_column(column: &ColumnMeta) -> bool {
    let haystack = format!(
        "{} {} {}",
        column.column_name, column.column_type, column.column_comment
    )
    .to_lowercase();
    contains_any(
        &haystack,
        &[
            "password",
            "passwd",
            "pwd",
            "secret",
            "token",
            "api_key",
            "apikey",
            "private_key",
            "credential",
            "salt",
            "email",
            "mail_address",
            "phone",
            "mobile",
            "tel",
            "telephone",
            "contact",
            "id_card",
            "identity_card",
            "身份证",
            "手机号",
            "手机",
            "电话",
            "邮箱",
            "密码",
            "密钥",
            "令牌",
        ],
    )
}

fn semantic_hints(column: &ColumnMeta) -> Vec<String> {
    let mut hints = Vec::new();
    let name = column.column_name.to_lowercase();
    if column.is_primary_key {
        hints.push("primary_key".into());
    }
    if name == "id" || name.ends_with("_id") {
        hints.push("identifier".into());
    }
    if contains_any(&name, &["name", "title", "label"]) {
        hints.push("display_name".into());
    }
    if contains_any(&name, &["created", "updated", "time", "date", "ts"]) {
        hints.push("time".into());
    }
    if is_sensitive_column(column) {
        hints.push("sensitive".into());
    }
    hints
}

fn score_text(query: &str, fields: &[&str]) -> u32 {
    let mut score = 0;
    for field in fields {
        let value = field.to_lowercase();
        if value == query {
            score += 100;
        } else if value.contains(query) {
            score += 50;
        }
        for token in query.split_whitespace() {
            if !token.is_empty() && value.contains(token) {
                score += 10;
            }
        }
    }
    score
}

fn base_type(column_type: &str) -> String {
    column_type
        .trim()
        .to_lowercase()
        .split(|ch: char| ch == '(' || ch.is_whitespace())
        .find(|part| !part.is_empty())
        .unwrap_or("")
        .to_string()
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

fn stable_hash(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_profile_returns_clickable_column_reference() {
        let schema = vec![TableMeta {
            primary_key_order: Vec::new(),
            table_name: "player".into(),
            table_comment: "玩家账号表".into(),
            columns: vec![
                ColumnMeta::with_basic("id", "bigint", "玩家ID", true, false),
                ColumnMeta::with_basic("nickname", "varchar(64)", "昵称", false, true),
            ],
        }];
        let profile =
            build_database_profile("demo", "game_db", &schema, &HashMap::new(), None, None);

        let results = search_profile(&profile, "昵称");

        assert!(results.iter().any(|item| {
            item.kind == "column"
                && item.table_name == "player"
                && item.column_name.as_deref() == Some("nickname")
                && item.reference.kind == "column"
        }));
    }

    #[test]
    fn profile_redacts_contact_columns_from_sample_values() {
        let schema = vec![TableMeta {
            primary_key_order: Vec::new(),
            table_name: "player".into(),
            table_comment: "玩家账号表".into(),
            columns: vec![
                ColumnMeta::with_basic("id", "bigint", "玩家ID", true, false),
                ColumnMeta::with_basic("email", "varchar(128)", "邮箱", false, true),
                ColumnMeta::with_basic("mobile_phone", "varchar(32)", "手机号", false, true),
            ],
        }];
        let sample_rows = HashMap::from([(
            "player".to_string(),
            vec![HashMap::from([
                ("id".to_string(), "1".to_string()),
                ("email".to_string(), "alice@example.com".to_string()),
                ("mobile_phone".to_string(), "13800138000".to_string()),
            ])],
        )]);

        let profile = build_database_profile("demo", "game_db", &schema, &sample_rows, None, None);
        let player_table = profile
            .tables
            .iter()
            .find(|table| table.table_name == "player")
            .unwrap();
        let email_column = player_table
            .columns
            .iter()
            .find(|column| column.column_name == "email")
            .unwrap();
        let phone_column = player_table
            .columns
            .iter()
            .find(|column| column.column_name == "mobile_phone")
            .unwrap();

        assert!(email_column.sensitive);
        assert!(email_column.sample_values.is_empty());
        assert!(phone_column.sensitive);
        assert!(phone_column.sample_values.is_empty());
    }

    #[test]
    fn profile_includes_index_and_row_count_metadata() {
        let schema = vec![TableMeta {
            primary_key_order: Vec::new(),
            table_name: "player".into(),
            table_comment: "玩家账号表".into(),
            columns: vec![
                ColumnMeta::with_basic("id", "bigint", "玩家ID", true, false),
                ColumnMeta::with_basic("guild_id", "bigint", "公会ID", false, true),
            ],
        }];
        let row_counts = HashMap::from([("player".to_string(), 1234)]);
        let indexes = HashMap::from([(
            "player".to_string(),
            vec![
                ProfileIndex {
                    index_name: "PRIMARY".into(),
                    columns: vec!["id".into()],
                    unique: true,
                    primary: true,
                },
                ProfileIndex {
                    index_name: "idx_player_guild".into(),
                    columns: vec!["guild_id".into()],
                    unique: false,
                    primary: false,
                },
            ],
        )]);

        let profile = build_database_profile(
            "demo",
            "game_db",
            &schema,
            &HashMap::new(),
            Some(&row_counts),
            Some(&indexes),
        );
        let player_table = profile
            .tables
            .iter()
            .find(|table| table.table_name == "player")
            .unwrap();

        assert_eq!(player_table.row_count_estimate, Some(1234));
        assert!(player_table.indexes.iter().any(|index| {
            index.index_name == "PRIMARY" && index.primary && index.columns == vec!["id"]
        }));
        assert!(player_table.indexes.iter().any(|index| {
            index.index_name == "idx_player_guild"
                && !index.unique
                && index.columns == vec!["guild_id"]
        }));
    }
}
