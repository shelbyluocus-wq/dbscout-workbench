//! Relations implied by a column's data format, such as reward lists
//! `[{"ID":1001,"Num":2}]` whose `ID` members are goods IDs.

use std::collections::{BTreeMap, BTreeSet};
use serde_json::Value;

use super::catalog::{DbColumn, DbSnapshot};
use super::model::RelationKind;
use super::parser::{condition_parts, empty, JsonSelector, ReferenceParser};

pub struct FormatRule {
    pub target_table: &'static str,
    pub target_column: &'static str,
    /// Every list item must carry these members.
    required: &'static [&'static str],
    /// List items may carry only these members.
    allowed: &'static [&'static str],
}

const RULES: &[FormatRule] = &[FormatRule {
    target_table: "goodsprop",
    target_column: "ID",
    required: &["ID", "Num"],
    allowed: &["ID", "Num", "Rate"],
}];

/// Share of sampled non-empty values that must match before a column counts.
const MIN_MATCH_RATIO: f64 = 0.9;
pub const ITEM_KEY: &str = "ID";
pub const CONDITION_PROBES: &[&str] = &["B", "G", "P_", "F1", "F2", "F3", "F4", "F5"];

pub fn condition_column(column: &DbColumn, snapshot: &DbSnapshot) -> bool {
    snapshot.column_name("conditionopencondprop", "Pre").is_some()
        && column.name.to_lowercase().trim_end_matches(|ch: char| ch.is_ascii_digit()).ends_with("opencond")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatFinding {
    pub column: String,
    /// Lowercase table name.
    pub target_table: String,
    pub target_column: String,
    pub sample: String,
    pub kind: RelationKind,
    pub parser: Option<ReferenceParser>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TableFormats {
    /// Parsers refine existing evidence; they do not infer foreign keys.
    pub columns: BTreeMap<String, ReferenceParser>,
    pub findings: Vec<FormatFinding>,
    /// Encoded formats replace literal interpretations of their documentation.
    pub replaced: BTreeSet<String>,
}

impl TableFormats {
    pub(super) fn target(&mut self, column: &DbColumn, snapshot: &DbSnapshot, table: &str, key: &str,
              kind: RelationKind, parser: ReferenceParser, sample: &str) {
        let Some(key) = snapshot.column_name(table, key) else { return };
        self.findings.push(FormatFinding {
            column: column.name.clone(), target_table: table.into(), target_column: key.into(),
            kind, parser: Some(parser), sample: sample.chars().take(160).collect(),
        });
    }

    pub fn inspect(&mut self, column: &DbColumn, values: &[String], snapshot: &DbSnapshot) {
        let filled = values.iter().map(|value| value.trim()).filter(|value| !empty(value)).collect::<Vec<_>>();
        let name = column.name.to_lowercase();
        if name.ends_with("func") || filled.iter().any(|value| value.starts_with("function")) {
            self.columns.insert(name, ReferenceParser::Unsupported);
            return;
        }
        let condition = snapshot.column_name("conditionopencondprop", "Pre").is_some()
            && (condition_column(column, snapshot) || (!filled.is_empty()
                && filled.iter().all(|value| condition_parts(value).is_some())));
        if condition {
            self.replaced.insert(name);
            let sample = filled.first().copied().unwrap_or("");
            let prefixes = filled.iter().filter_map(|value| condition_parts(value))
                .flatten().map(|(prefix, _)| prefix).collect::<BTreeSet<_>>();
            self.target(column, snapshot, "conditionopencondprop", "Pre", RelationKind::Value,
                ReferenceParser::Condition { prefix: None, value_prefix: None }, sample);
            if prefixes.contains("B") {
            self.target(column, snapshot, "buildopenprop", "BuildID", RelationKind::Value,
                ReferenceParser::Condition { prefix: Some("B".into()), value_prefix: None }, sample);
            }
            if prefixes.contains("G") {
            self.target(column, snapshot, "goodsprop", "ID", RelationKind::Value,
                ReferenceParser::Condition { prefix: Some("G".into()), value_prefix: None }, sample);
            }
            if prefixes.contains("P_") {
            self.target(column, snapshot, "conditionplatprop", "Plat", RelationKind::Value,
                ReferenceParser::Condition { prefix: Some("P_".into()), value_prefix: None }, sample);
            }
            for kind in 1..=5 {
                if !filled.iter().filter_map(|value| condition_parts(value)).flatten()
                    .any(|(prefix, value)| prefix == "F" && value.starts_with(&kind.to_string())) { continue; }
                self.target(column, snapshot, &format!("ins{kind}prop"), "ID", RelationKind::Value,
                    ReferenceParser::Condition { prefix: Some("F".into()), value_prefix: Some(kind.to_string()) }, sample);
            }
            return;
        }
        let enc_schema = snapshot.column_name("giftoptionalprop", "GiftOptionalID").is_some()
            && snapshot.column_name("vipbuyprop", "PID").is_some();
        let declared_enc = enc_schema && !name.contains("func") && name.ends_with("enc")
            && (column.data_type == "json" || column.comment.contains("ENC") || column.comment.contains("{ID,Num}"));
        let classified = classify(values, snapshot).or_else(|| {
            (declared_enc && snapshot.column_name("goodsprop", "ID").is_some()
                && filled.iter().all(|value| value.starts_with('[')))
                .then(|| (&RULES[0], filled.first().copied().unwrap_or("").to_string()))
        });
        if let Some((rule, sample)) = classified {
            // Only the game's ENC convention interprets special ID sentinels.
            let enc = enc_schema
                && (name.contains("enc") || column.comment.contains("ENC") || column.comment.contains("奖励")
                    || column.comment.contains("消耗"));
            let core_entities = enc && super::project_formats::matches_schema(snapshot)
                && snapshot.column_name("heroprop", "ID").is_some();
            let parser = ReferenceParser::Json {
                member: ITEM_KEY.into(), selector: None,
                exclude: if enc { ["0", "998", "999"].map(str::to_string).to_vec() } else { Vec::new() },
                ranges: if core_entities { super::project_formats::CORE_RANGES.to_vec() } else { Vec::new() },
                outside_ranges: core_entities,
            };
            self.columns.insert(name.clone(), parser.clone());
            self.target(column, snapshot, rule.target_table, rule.target_column, RelationKind::List, parser, &sample);
            if enc {
                self.replaced.insert(name);
                if core_entities {
                    self.target(column, snapshot, "heroprop", "ID", RelationKind::List, ReferenceParser::Json {
                        member: "ID".into(), selector: None, exclude: Vec::new(),
                        ranges: super::project_formats::CORE_RANGES.to_vec(), outside_ranges: false,
                    }, &sample);
                }
                for (id, table, key) in [("0", "giftoptionalprop", "GiftOptionalID"), ("999", "vipbuyprop", "PID")] {
                    self.target(column, snapshot, table, key, RelationKind::List, ReferenceParser::Json {
                        member: "Num".into(), selector: Some(JsonSelector { member: "ID".into(), value: id.into() }),
                        exclude: Vec::new(),
                        ranges: Vec::new(), outside_ranges: false,
                    }, &sample);
                }
            }
            return;
        }
        if let Some(parser) = infer_parser(&filled, &column.comment) {
            self.columns.insert(name, parser);
        }
    }
}

pub(super) fn infer_parser(values: &[&str], comment: &str) -> Option<ReferenceParser> {
    let sample = values.first().copied().unwrap_or("");
    if sample.starts_with('[') {
        if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(sample) {
            if items.iter().all(|item| item.is_string() || item.is_number()) {
                return Some(ReferenceParser::Keys { delimiter: "json".into() });
            }
            if items.iter().all(Value::is_object) {
                let object = items.first()?.as_object()?;
                let key = object.keys().find(|key| key.eq_ignore_ascii_case("ID"))
                    .or_else(|| {
                        let keys = object.keys().filter(|key| key.to_lowercase().ends_with("id")).collect::<Vec<_>>();
                        (keys.len() == 1).then(|| keys[0])
                    });
                if let Some(key) = key {
                    return Some(ReferenceParser::json(key));
                }
            }
        }
        return Some(ReferenceParser::Unsupported);
    }
    for delimiter in [",", "|"] {
        let parser = ReferenceParser::Keys { delimiter: delimiter.into() };
        let hinted = match delimiter {
            "," => comment.contains("逗号") || comment.contains("，隔开"),
            _ => comment.contains('|') && (comment.contains("隔开") || comment.contains("分割") || comment.contains("分开")),
        };
        if (hinted || values.iter().any(|value| value.contains(delimiter)))
            && values.iter().all(|value| parser.values(value).is_some()) {
            return Some(parser);
        }
    }
    if values.iter().any(|value| value.starts_with("function") || value.starts_with('{') || value.contains('|')) {
        return Some(ReferenceParser::Unsupported);
    }
    None
}

fn matches_rule(value: &str, rule: &FormatRule) -> bool {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(value) else {
        return false;
    };
    !items.is_empty()
        && items.iter().all(|item| {
            let Value::Object(object) = item else {
                return false;
            };
            let has = |key: &str| object.keys().any(|member| member.eq_ignore_ascii_case(key));
            rule.required.iter().all(|key| has(key))
                && object
                    .keys()
                    .all(|member| rule.allowed.iter().any(|key| key.eq_ignore_ascii_case(member)))
        })
}

fn is_blank(value: &str) -> bool {
    matches!(value, "" | "0" | "[]" | "null" | "NULL")
}

/// The rule every sampled value of one column follows, if any.
pub fn classify(values: &[String], snapshot: &DbSnapshot) -> Option<(&'static FormatRule, String)> {
    let filled = values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !is_blank(value))
        .collect::<Vec<_>>();
    if filled.is_empty() || !filled.iter().any(|value| value.starts_with('[')) {
        return None;
    }
    RULES
        .iter()
        .filter(|rule| {
            snapshot
                .column_name(rule.target_table, rule.target_column)
                .is_some()
        })
        .find_map(|rule| {
            let matched = filled.iter().filter(|value| matches_rule(value, rule)).count();
            let ratio = matched as f64 / filled.len() as f64;
            if ratio < MIN_MATCH_RATIO {
                return None;
            }
            let sample = filled
                .iter()
                .find(|value| matches_rule(value, rule))
                .map(|value| value.chars().take(120).collect::<String>())
                .unwrap_or_default();
            Some((rule, sample))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_relations::catalog::test_support::{snapshot, table};

    fn db() -> DbSnapshot {
        snapshot(vec![table("goodsprop", &[("ID", "int", "", true)])])
    }

    fn values(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn goods_lists_are_recognised() {
        let found = classify(
            &values(&[r#"[{"ID":1001,"Num":2}]"#, "", "0", r#"[{"ID":7,"Num":1,"Rate":5000},{"ID":8,"Num":1}]"#]),
            &db(),
        );
        let (rule, sample) = found.expect("goods list");
        assert_eq!(rule.target_table, "goodsprop");
        assert_eq!(sample, r#"[{"ID":1001,"Num":2}]"#);
    }

    #[test]
    fn attribute_lists_and_mixed_columns_are_not_goods() {
        assert!(classify(&values(&[r#"[{"ID":1,"Val":20}]"#]), &db()).is_none());
        assert!(classify(&values(&[r#"[{"ID":1,"Num":2}]"#, "abc", "def"]), &db()).is_none());
        assert!(classify(&values(&["", "0"]), &db()).is_none());
    }

    #[test]
    fn rules_need_their_target_table() {
        let empty = snapshot(vec![table("heroprop", &[("ID", "int", "", true)])]);
        assert!(classify(&values(&[r#"[{"ID":1001,"Num":2}]"#]), &empty).is_none());
    }

    #[test]
    fn formats_refine_references_without_inventing_targets_for_weights() {
        let mut profile = TableFormats::default();
        profile.inspect(&DbColumn { name: "Weight".into(), data_type: "json".into(), comment: "weights".into() },
            &values(&["[10,30,60]"]), &db());
        assert!(profile.findings.is_empty());
        assert_eq!(profile.columns["weight"], ReferenceParser::Keys { delimiter: "json".into() });
    }

    #[test]
    fn dynamic_function_columns_are_unchecked_even_before_sampling() {
        let mut profile = TableFormats::default();
        let column = DbColumn { name: "ExtaEncFunc".into(), data_type: "text".into(), comment: "goodsprop".into() };
        profile.inspect(&column, &[], &db());
        assert_eq!(profile.columns["extaencfunc"], ReferenceParser::Unsupported);
        assert!(profile.findings.is_empty());
    }

    #[test]
    fn descriptions_are_not_open_conditions_and_empty_conditions_need_no_speculative_targets() {
        let snapshot = snapshot(vec![
            table("conditionopencondprop", &[("Pre", "varchar", "", true)]),
            table("buildopenprop", &[("BuildID", "int", "", true)]),
        ]);
        let mut profile = TableFormats::default();
        profile.inspect(&DbColumn { name: "OpenCondDesc".into(), data_type: "text".into(), comment: String::new() },
            &values(&["Unlock after reaching level 10"]), &snapshot);
        assert!(profile.findings.is_empty());
        profile.inspect(&DbColumn { name: "OpenCond".into(), data_type: "text".into(), comment: String::new() }, &[], &snapshot);
        assert_eq!(profile.findings.len(), 1);
        assert_eq!(profile.findings[0].target_table, "conditionopencondprop");
        assert!(profile.findings[0].sample.is_empty());
    }

    #[test]
    fn enc_routes_special_values_and_entities_without_making_amounts_keys() {
        let snapshot = snapshot(vec![
            table("goodsprop", &[("ID", "int", "", true)]),
            table("heroprop", &[("ID", "int", "", true)]),
            table("giftoptionalprop", &[("GiftOptionalID", "int", "", true)]),
            table("vipbuyprop", &[("PID", "int", "", true)]),
            table("conditionopencondprop", &[("Pre", "varchar", "", true)]),
            table("growupfmtmodelprop", &[("ModelID", "int", "", true)]),
        ]);
        let mut profile = TableFormats::default();
        let text = r#"[{"ID":2,"Num":100},{"ID":1036,"Num":1},{"ID":0,"Num":10031},{"ID":999,"Num":81},{"ID":998,"Num":0}]"#;
        profile.inspect(&DbColumn { name: "NeedEnc".into(), data_type: "json".into(), comment: String::new() }, &values(&[text]), &snapshot);
        for (target, expected) in [("goodsprop", "2"), ("heroprop", "1036"), ("giftoptionalprop", "10031"), ("vipbuyprop", "81")] {
            let finding = profile.findings.iter().find(|finding| finding.target_table == target).unwrap();
            assert_eq!(finding.parser.as_ref().unwrap().values(text), Some(vec![expected.to_string()]));
        }
        let mut unrelated = snapshot.clone();
        unrelated.tables.remove("growupfmtmodelprop");
        let mut profile = TableFormats::default();
        profile.inspect(&DbColumn { name: "NeedEnc".into(), data_type: "json".into(), comment: String::new() }, &values(&[text]), &unrelated);
        assert!(profile.findings.iter().all(|finding| finding.target_table != "heroprop"));
        let goods = profile.findings.iter().find(|finding| finding.target_table == "goodsprop").unwrap();
        assert_eq!(goods.parser.as_ref().unwrap().values(text), Some(vec!["2".into(), "1036".into()]),
            "jswz entity ID ranges must not apply to unrelated schemas");
    }
}
