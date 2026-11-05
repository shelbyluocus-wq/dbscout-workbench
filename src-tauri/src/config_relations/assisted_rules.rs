use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::catalog::DbSnapshot;
use super::constraints::RowConstraint;
use super::model::{Evidence, RelationKey, RelationKind, RelationStatus, RelationView, StatusReason};
use super::parser::ReferenceParser;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleDraft {
    pub source_table: String,
    pub source_column: String,
    pub target_table: String,
    pub target_column: String,
    pub parser: Option<ReferenceParser>,
    #[serde(default)]
    pub source_constraints: Vec<RowConstraint>,
    pub evidence: String,
    #[serde(default)]
    pub code_paths: Vec<String>,
    #[serde(default = "enabled")]
    pub enabled: bool,
}

fn enabled() -> bool { true }

pub fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

pub fn value_signature(value: impl Serialize) -> Result<String, String> {
    let mut value = serde_json::to_value(value).map_err(|error| error.to_string())?;
    value.sort_all_objects();
    Ok(digest(&serde_json::to_vec(&value).map_err(|error| error.to_string())?))
}

pub fn same_endpoints(left: &RelationKey, right: &RelationKey) -> bool {
    left.source_table.eq_ignore_ascii_case(&right.source_table)
        && left.source_column.eq_ignore_ascii_case(&right.source_column)
        && left.target_table.eq_ignore_ascii_case(&right.target_table)
        && left.target_column.eq_ignore_ascii_case(&right.target_column)
}

pub fn extract_keys(draft: &RuleDraft, raw: &str) -> Option<Vec<String>> {
    let raw = raw.trim();
    if raw.starts_with("function") || raw.contains("=>") { return None; }
    if let Some(parser) = &draft.parser { return parser.values(raw); }
    if super::parser::empty(raw) { return Some(vec![]); }
    if raw.starts_with(['[', '{']) || raw.contains(['|', ',', ';', '\n']) { return None; }
    Some(vec![raw.into()])
}

impl RuleDraft {
    pub fn key(&self) -> RelationKey {
        RelationKey {
            source_table: self.source_table.to_lowercase(), source_column: self.source_column.clone(),
            target_table: self.target_table.to_lowercase(), target_column: self.target_column.clone(),
            kind: if self.parser.is_some() { RelationKind::List } else { RelationKind::Value },
        }
    }

    pub fn validate(&mut self, snapshot: &DbSnapshot) -> Result<String, String> {
        let source = snapshot.table(&self.source_table).ok_or("来源表不存在")?;
        let target = snapshot.table(&self.target_table).ok_or("目标表不存在")?;
        self.source_column = source.column(&self.source_column).ok_or("来源字段不存在")?.name.clone();
        self.target_column = target.column(&self.target_column).ok_or("目标字段不存在")?.name.clone();
        self.source_table = source.name.clone();
        self.target_table = target.name.clone();
        if self.enabled && (target.primary_keys.len() != 1 || !target.primary_keys[0].eq_ignore_ascii_case(&self.target_column)) {
            return Err("当前规则只支持指向单列主键；复合主键或非唯一字段需要上下文，不能当成唯一记录引用".into());
        }
        if self.evidence.trim().is_empty() || self.evidence.len() > 4000 { return Err("请提供不超过 4000 字节的关联依据".into()); }
        if self.source_constraints.len() > 8 || self.code_paths.len() > 8 { return Err("条件或代码依据过多，最多各 8 项".into()); }
        if self.code_paths.iter().any(|path| path.is_empty() || path.len()>2048) { return Err("代码依据路径为空或过长".into()); }
        for guard in &mut self.source_constraints {
            guard.column = source.column(&guard.column).ok_or("条件字段不存在")?.name.clone();
            if guard.values.is_empty() || guard.values.len() > 50 || guard.values.iter().any(|value| value.is_empty() || value.len() > 256) {
                return Err("条件取值必须为 1-50 个非空短文本".into());
            }
        }
        if let Some(parser) = &self.parser { validate_parser(parser)?; }
        Ok(schema_signature(snapshot, self))
    }
}

pub fn validate_parser(parser: &ReferenceParser) -> Result<(), String> {
    match parser {
        ReferenceParser::Unsupported => return Err("不能保存无法解析的规则；动态函数只报告待确认".into()),
        ReferenceParser::Keys { delimiter } if ![",", "|", "json"].contains(&delimiter.as_str()) => return Err("列表仅支持逗号、竖线或 JSON 标量数组".into()),
        ReferenceParser::Token { delimiter, .. } if ![",", "|"].contains(&delimiter.as_str()) => return Err("指定项分隔符仅支持逗号或竖线".into()),
        ReferenceParser::Token { index, .. } if *index > 64 => return Err("指定项索引必须在 0-64 内".into()),
        ReferenceParser::JsonPaths { paths, .. } if paths.is_empty() || paths.len() > 8 || paths.iter().any(|path| path.len() > 256) => return Err("JSON 路径数量或长度超限".into()),
        ReferenceParser::JsonPaths { paths, .. } if paths.iter().any(|path| !super::parser::valid_json_path(path)) => return Err("JSON 路径仅支持命名成员、数组索引和 [*]".into()),
        ReferenceParser::Prefix { prefix } if prefix.is_empty() || prefix.len() > 64 => return Err("前缀为空或过长".into()),
        ReferenceParser::Json { member, selector, .. } if member.is_empty() || member.len()>128 || selector.as_ref().is_some_and(|selector| selector.member.is_empty() || selector.member.len()>128 || selector.value.len()>256) => return Err("JSON 字段或选择条件无效".into()),
        ReferenceParser::Condition { prefix, value_prefix } if prefix.as_ref().is_some_and(|value| value.is_empty() || value.len()>64) || value_prefix.as_ref().is_some_and(|value| value.is_empty() || value.len()>64) => return Err("条件前缀为空或过长".into()),
        _ => {}
    }
    let encoded = serde_json::to_vec(parser).map_err(|error| error.to_string())?;
    if encoded.len() > 4096 { return Err("解析器过大".into()); }
    Ok(())
}

pub fn schema_signature(snapshot: &DbSnapshot, draft: &RuleDraft) -> String {
    let mut parts = Vec::new();
    for name in [&draft.source_table, &draft.target_table] {
        if let Some(table) = snapshot.table(name) {
            parts.push(serde_json::json!({"name":table.name,"keys":table.primary_keys,
                "columns":table.columns.iter().map(|column| (&column.name, &column.data_type, &column.comment)).collect::<Vec<_>>() }));
        }
    }
    digest(&serde_json::to_vec(&parts).unwrap_or_default())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRule {
    pub draft: RuleDraft,
    pub schema_signature: String,
    pub code_hashes: BTreeMap<String, String>,
    pub binding_signature: String,
    pub saved_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleChange {
    pub revision: u64,
    pub id: String,
    pub previous: Option<SavedRule>,
    pub current: SavedRule,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleBook {
    pub revision: u64,
    pub rules: BTreeMap<String, SavedRule>,
    pub history: Vec<RuleChange>,
}

impl RuleBook {
    pub fn apply(&mut self, rule: SavedRule, expected_revision: u64) -> Result<(), String> {
        if self.revision != expected_revision { return Err("关联规则已被修改，请重新预览".into()); }
        let id = rule.draft.key().id();
        let previous_id = self.rules.iter().find(|(_, existing)| same_endpoints(&existing.draft.key(), &rule.draft.key())).map(|(id,_)| id.clone());
        if self.rules.len() >= 500 && previous_id.is_none() { return Err("本库规则已达 500 条，请先整理".into()); }
        let previous = previous_id.and_then(|id| self.rules.remove(&id));
        self.rules.insert(id.clone(), rule.clone());
        self.revision += 1;
        self.history.push(RuleChange { revision: self.revision, id, previous, current: rule });
        if self.history.len() > 100 { self.history.remove(0); }
        Ok(())
    }

    pub fn views(&self, snapshot: &DbSnapshot, verified: &BTreeMap<String, String>) -> Vec<RelationView> {
        self.rules.iter().filter(|(_, rule)| rule.draft.enabled).map(|(id, rule)| {
            let current = schema_signature(snapshot, &rule.draft) == rule.schema_signature && verified.get(id).is_some_and(|signature| value_signature(rule).ok().as_ref() == Some(signature));
            RelationView {
                id: id.clone(), key: rule.draft.key(),
                parser: if current { rule.draft.parser.clone() } else { Some(ReferenceParser::Unsupported) },
                source_constraints: rule.draft.source_constraints.clone(),
                status: if current { RelationStatus::Confirmed } else { RelationStatus::Stale },
                reason: if current { StatusReason::Manual } else { StatusReason::EvidenceGone },
                is_new: false, evidence: vec![Evidence::Rule { text: format!("AI 辅助规则（用户确认）：{}", rule.draft.evidence) }],
                code_target: None, decided_at: Some(rule.saved_at.clone()), disagreeing_code: Default::default(),
            }
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule() -> SavedRule {
        SavedRule { draft: RuleDraft { source_table:"rewards".into(),source_column:"items".into(),target_table:"goods".into(),target_column:"id".into(),parser:None,source_constraints:vec![],evidence:"字段文档与样本一致".into(),code_paths:vec![],enabled:true },schema_signature:"schema".into(),code_hashes:BTreeMap::new(),binding_signature:String::new(),saved_at:"now".into() }
    }

    #[test]
    fn rule_history_and_revision_guard_preserve_previous_state() {
        let mut book = RuleBook::default();
        book.apply(rule(), 0).unwrap();
        let previous = book.clone();
        assert!(book.apply(rule(), 0).is_err());
        assert_eq!(book, previous);
        let mut disabled = rule();
        disabled.draft.enabled = false;
        book.apply(disabled, 1).unwrap();
        assert_eq!(book.history[1].previous, Some(rule()));
        assert!(book.views(&DbSnapshot::default(), &BTreeMap::new()).is_empty());
    }

    #[test]
    fn stale_rules_are_non_executable_and_unknown_parsers_rejected() {
        let mut book = RuleBook::default();
        book.apply(rule(), 0).unwrap();
        let view = book.views(&DbSnapshot::default(), &BTreeMap::new()).remove(0);
        assert_eq!(view.status, RelationStatus::Stale);
        assert_eq!(view.parser, Some(ReferenceParser::Unsupported));
        assert!(validate_parser(&ReferenceParser::Unsupported).is_err());
        assert!(validate_parser(&ReferenceParser::Token { delimiter:"|".into(),index:999 }).is_err());
        assert!(validate_parser(&ReferenceParser::JsonPaths { paths:vec!["$..ID".into()],exclude:vec![] }).is_err());
    }

    #[test]
    fn sample_signatures_do_not_depend_on_hashmap_iteration_order() {
        let first = std::collections::HashMap::from([("ID", "1"), ("Name", "test")]);
        let second = std::collections::HashMap::from([("Name", "test"), ("ID", "1")]);
        assert_eq!(value_signature(first).unwrap(), value_signature(second).unwrap());
    }

    #[test]
    fn scalar_rule_does_not_claim_structures_or_functions_are_keys() {
        let draft = rule().draft;
        assert_eq!(extract_keys(&draft,"1001"),Some(vec!["1001".into()]));
        for value in ["[1001,1002]", "function(){return 1001;}", "x => 1001", "1001|2"] {
            assert!(extract_keys(&draft,value).is_none());
        }
    }

    #[test]
    fn parser_replacement_preserves_one_edge_and_previous_rule() {
        let mut book = RuleBook::default();
        book.apply(rule(),0).unwrap();
        let mut replacement = rule();
        replacement.draft.parser = Some(ReferenceParser::json("ID"));
        book.apply(replacement.clone(),1).unwrap();
        assert_eq!(book.rules.len(),1);
        assert_eq!(book.history[1].previous,Some(rule()));
        assert_eq!(book.rules.values().next(),Some(&replacement));
    }

    #[test]
    fn validation_rejects_ambiguous_targets_and_hashes_track_rule_and_schema() {
        use super::super::catalog::test_support::{snapshot, table};
        let schema = snapshot(vec![table("rewards", &[("id","int","",true),("items","text","",false)]),table("goods", &[("id","int","",true)])]);
        let mut saved = rule();
        saved.schema_signature = saved.draft.validate(&schema).unwrap();
        let mut book = RuleBook::default();
        book.apply(saved.clone(),0).unwrap();
        let verified = BTreeMap::from([(saved.draft.key().id(),value_signature(&saved).unwrap())]);
        assert_eq!(book.views(&schema,&verified)[0].status,RelationStatus::Confirmed);
        let mut changed = saved.clone();
        changed.draft.evidence = "different evidence".into();
        book.apply(changed,1).unwrap();
        assert_eq!(book.views(&schema,&verified)[0].status,RelationStatus::Stale);
        let mut composite = schema.clone();
        composite.tables.get_mut("goods").unwrap().primary_keys.push("level".into());
        assert!(saved.draft.validate(&composite).is_err());
        assert_eq!(book.views(&composite,&verified)[0].parser,Some(ReferenceParser::Unsupported));
        assert_eq!(extract_keys(&RuleDraft { parser:Some(ReferenceParser::json("ID")),..saved.draft },r#"[{"ID":1001,"Num":1002}]"#),Some(vec!["1001".into()]));
        assert!(validate_parser(&ReferenceParser::Keys { delimiter:";".into() }).is_err());
        assert!(validate_parser(&ReferenceParser::Keys { delimiter:"json".into() }).is_ok());
    }
}
