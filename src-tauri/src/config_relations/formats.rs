//! Relations implied by a column's data format, such as reward lists
//! `[{"ID":1001,"Num":2}]` whose `ID` members are goods IDs.

use serde_json::Value;

use super::catalog::DbSnapshot;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatFinding {
    pub column: String,
    /// Lowercase table name.
    pub target_table: String,
    pub target_column: String,
    pub sample: String,
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
}
