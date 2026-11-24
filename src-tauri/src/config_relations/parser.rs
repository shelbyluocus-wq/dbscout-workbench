//! Explicit cell parsers shared by outgoing lookups and incoming filters.
//! A format never establishes a target table on its own.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ReferenceParser {
    Keys { delimiter: String },
    Token { delimiter: String, index: usize },
    Prefix { prefix: String },
    /// Extracts key values carrying a literal prefix (such as `npc_1041` inside
    /// `npc_1041,70,0,0,0` or `npc_1041|npc_1031`), stripping the prefix before
    /// matching the target column.
    Prefixed {
        prefix: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delimiter: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    /// A restricted JSON path grammar: object members, numeric indexes and
    /// array wildcards only. Never evaluate config functions or expressions.
    JsonPaths { paths: Vec<String>, #[serde(default)] exclude: Vec<String> },
    Json {
        member: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<JsonSelector>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        exclude: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        ranges: Vec<(u32, u32)>,
        #[serde(default, rename = "outsideRanges", skip_serializing_if = "std::ops::Not::not")]
        outside_ranges: bool,
    },
    Condition {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefix: Option<String>,
        #[serde(default, rename = "valuePrefix", skip_serializing_if = "Option::is_none")]
        value_prefix: Option<String>,
    },
    /// Expressions requiring execution or an unknown structured format.
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonSelector {
    pub member: String,
    pub value: String,
}

pub fn empty(value: &str) -> bool {
    matches!(value.trim(), "" | "0" | "-1" | "null" | "NULL" | "[]" | "{}")
}

fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.trim().into()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn member<'a>(object: &'a serde_json::Map<String, Value>, name: &str) -> Option<&'a Value> {
    object.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value)
}

pub(crate) fn key_atom(value: &str) -> bool {
    value.chars().all(|ch| ch.is_ascii_alphanumeric() || "_-.:".contains(ch))
}

fn strip_prefixed_token<'a>(token: &'a str, prefix: &str) -> Option<&'a str> {
    let trimmed = token.trim().trim_matches('"').trim();
    let rest = trimmed.strip_prefix(prefix)?;
    (!empty(rest) && key_atom(rest)).then_some(rest)
}

pub fn condition_parts(text: &str) -> Option<Vec<(String, String)>> {
    let mut parts = text.trim().split('|');
    if !matches!(parts.next()?.trim(), "and" | "or" | "not") {
        return None;
    }
    let mut result = Vec::new();
    for part in parts.map(str::trim).filter(|part| !part.is_empty()) {
        let letters = part.bytes().take_while(u8::is_ascii_alphabetic).count();
        if letters == 0 {
            return None;
        }
        let end = letters + usize::from(part.as_bytes().get(letters) == Some(&b'_'));
        result.push((part[..end].to_string(), part[end..].to_string()));
    }
    Some(result)
}

impl ReferenceParser {
    pub fn json(member: &str) -> Self {
        Self::Json { member: member.into(), selector: None, exclude: Vec::new(), ranges: Vec::new(), outside_ranges: false }
    }

    pub fn values(&self, text: &str) -> Option<Vec<String>> {
        let text = text.trim();
        if empty(text) {
            return Some(Vec::new());
        }
        let values = match self {
            Self::Prefix { prefix } => {
                if !key_atom(text) { return None; }
                if text.starts_with(prefix) { vec![text.into()] } else { Vec::new() }
            }
            Self::Prefixed { prefix, delimiter, index } => {
                if prefix.is_empty() || !key_atom(prefix) || text.starts_with("function") {
                    return None;
                }
                match (delimiter.as_deref(), *index) {
                    (Some(delim), Some(idx)) => {
                        if !matches!(delim, "," | "|") || idx > 1024 { return None; }
                        let tokens = text.split(delim).map(str::trim).collect::<Vec<_>>();
                        tokens.get(idx)
                            .and_then(|token| strip_prefixed_token(token, prefix))
                            .map(|value| vec![value.to_string()])
                            .unwrap_or_default()
                    }
                    (Some(delim), None) => {
                        if !matches!(delim, "," | "|") { return None; }
                        text.split(delim)
                            .filter_map(|token| strip_prefixed_token(token, prefix))
                            .map(str::to_string)
                            .collect()
                    }
                    (None, Some(_)) => return None,
                    (None, None) => {
                        if text.starts_with('{') {
                            return None;
                        }
                        if text.starts_with('[') {
                            let Value::Array(items) = serde_json::from_str::<Value>(text).ok()? else {
                                return None;
                            };
                            let mut out = Vec::new();
                            for item in items {
                                let text_item = scalar(&item)?;
                                if let Some(stripped) = strip_prefixed_token(&text_item, prefix) {
                                    out.push(stripped.to_string());
                                }
                            }
                            out
                        } else {
                            text.split(|ch: char| matches!(ch, ',' | '|' | ';') || ch.is_whitespace())
                                .filter_map(|token| strip_prefixed_token(token, prefix))
                                .map(str::to_string)
                                .collect()
                        }
                    }
                }
            }
            Self::Token { delimiter, index } => {
                if !matches!(delimiter.as_str(), "," | "|") || *index > 1024 { return None; }
                let tokens = text.split(delimiter).map(str::trim).collect::<Vec<_>>();
                if !tokens.iter().all(|token| key_atom(token)) { return None; }
                tokens.get(*index).map(|value| vec![(*value).into()]).unwrap_or_default()
            }
            Self::JsonPaths { paths, exclude } => {
                let value: Value = serde_json::from_str(text).ok()?;
                let mut values = Vec::new();
                for path in paths {
                    let steps = path_steps(path)?;
                    collect_path(&value, &steps, &mut values);
                }
                values.retain(|value| !exclude.contains(value));
                values
            }
            Self::Keys { delimiter } => {
                let values = if delimiter == "json" {
                    let Value::Array(items) = serde_json::from_str::<Value>(text).ok()? else {
                        return None;
                    };
                    items.iter().map(scalar).collect::<Option<Vec<_>>>()?
                } else if matches!(delimiter.as_str(), "," | "|") {
                    text.split(delimiter.as_str()).map(|part| part.trim().to_string()).collect()
                } else {
                    return None;
                };
                if !values.iter().all(|value| key_atom(value)) {
                    return None;
                }
                values
            }
            Self::Json { member: name, selector, exclude, ranges, outside_ranges } => {
                let Value::Array(items) = serde_json::from_str::<Value>(text).ok()? else {
                    return None;
                };
                let mut values = Vec::new();
                for item in items {
                    let Value::Object(object) = item else { return None };
                    // SQL matching is deliberately limited to flat objects.
                    if object.values().any(|value| value.is_array() || value.is_object()) {
                        return None;
                    }
                    if let Some(selector) = selector {
                        if member(&object, &selector.member).and_then(scalar).as_deref() != Some(&selector.value) {
                            continue;
                        }
                    }
                    if let Some(value) = member(&object, name).and_then(scalar) {
                        if !exclude.contains(&value) && range_matches(&value, ranges, *outside_ranges) {
                            values.push(value);
                        }
                    }
                }
                values
            }
            Self::Condition { prefix, value_prefix } => condition_parts(text)?
                .into_iter()
                .filter_map(|(kind, argument)| match prefix {
                    None => Some(kind),
                    Some(prefix) if *prefix == kind => {
                        let value = if prefix == "G" {
                            argument.split('_').next().unwrap_or("").to_string()
                        } else {
                            argument
                        };
                        value_prefix.as_ref().is_none_or(|start| value.starts_with(start)).then_some(value)
                    }
                    _ => None,
                })
                .collect(),
            Self::Unsupported => return None,
        };
        let mut unique = Vec::new();
        for value in values {
            if !empty(&value) && !unique.contains(&value) {
                unique.push(value);
            }
        }
        Some(unique)
    }

    /// The same complete-key match used for counts, expanded rows and tabs.
    /// All data-derived text is bound, never interpolated into SQL.
    pub fn predicate(&self, column: &str, value: &str) -> (String, Vec<String>) {
        if empty(value) {
            return ("1 = 0".into(), Vec::new());
        }
        let escaped = regex_literal(value);
        match self {
            Self::Prefix { prefix } => {
                if !value.starts_with(prefix) || !key_atom(value) { return ("1 = 0".into(), Vec::new()); }
                (format!("BINARY TRIM({column}) = BINARY ?"), vec![value.into()])
            }
            Self::Prefixed { prefix, delimiter, index } => {
                if prefix.is_empty() || !key_atom(prefix) || !key_atom(value) {
                    return ("1 = 0".into(), Vec::new());
                }
                let prefixed = format!("{}{}", regex_literal(prefix), escaped);
                match (delimiter.as_deref(), *index) {
                    (Some(delim), Some(idx)) => {
                        if !matches!(delim, "," | "|") || idx > 1024 {
                            return ("1 = 0".into(), Vec::new());
                        }
                        let separator = regex_literal(delim);
                        let token = if delim == "," { "[^,]*" } else { "[^|]*" };
                        let pattern = format!("^({token}{separator}){{{idx}}}[[:space:]]*{prefixed}[[:space:]]*({separator}{token})*$");
                        (format!("({column} NOT LIKE 'function%' AND {column} REGEXP ?)"), vec![pattern])
                    }
                    (Some(delim), None) => {
                        if !matches!(delim, "," | "|") {
                            return ("1 = 0".into(), Vec::new());
                        }
                        let separator = regex_literal(delim);
                        let pattern = format!("(^|{separator})[[:space:]]*{prefixed}[[:space:]]*({separator}|$)");
                        (format!("({column} NOT LIKE 'function%' AND {column} REGEXP ?)"), vec![pattern])
                    }
                    (None, Some(_)) => ("1 = 0".into(), Vec::new()),
                    (None, None) => {
                        let pattern = format!(
                            r#"(^|,|\||;|\[|"|[[:space:]])[[:space:]]*{prefixed}[[:space:]]*($|,|\||;|\]|"|[[:space:]])"#
                        );
                        (
                            format!(
                                "(TRIM({column}) NOT LIKE 'function%' AND TRIM({column}) NOT LIKE '{{%' AND (LEFT(TRIM({column}), 1) <> '[' OR JSON_VALID({column})) AND {column} REGEXP ?)"
                            ),
                            vec![pattern],
                        )
                    }
                }
            }
            Self::Token { delimiter, index } => {
                if !matches!(delimiter.as_str(), "," | "|") || *index > 1024 || !key_atom(value) {
                    return ("1 = 0".into(), Vec::new());
                }
                let separator = regex_literal(delimiter);
                let token = "[[:space:]]*[-A-Za-z0-9_.:]*[[:space:]]*";
                let pattern = format!("^({token}{separator}){{{index}}}[[:space:]]*{escaped}[[:space:]]*({separator}{token})*$");
                (format!("{column} REGEXP ?"), vec![pattern])
            }
            Self::JsonPaths { paths, exclude } => {
                if exclude.contains(&value.to_string()) || paths.iter().any(|path| path_steps(path).is_none()) {
                    return ("1 = 0".into(), Vec::new());
                }
                let mut predicates = Vec::new();
                let mut binds = Vec::new();
                for path in paths {
                    let steps = path_steps(path).unwrap();
                    let document = format!("IF(JSON_VALID({column}), {column}, 'null')");
                    predicates.push(path_predicate(&document, &steps, 0));
                    binds.push(value.into());
                }
                if predicates.is_empty() { return ("1 = 0".into(), Vec::new()); }
                (format!("({})", predicates.join(" OR ")), binds)
            }
            Self::Keys { delimiter } => {
                let (guard, pattern) = match delimiter.as_str() {
                    "," | "|" => {
                        let separator = regex_literal(delimiter);
                        (
                            format!("^[[:space:]]*[-A-Za-z0-9_.:]*([[:space:]]*{separator}[[:space:]]*[-A-Za-z0-9_.:]*)*[[:space:]]*$"),
                            format!("(^|{separator})[[:space:]]*{escaped}[[:space:]]*({separator}|$)"),
                        )
                    }
                    "json" => (
                        "^[[:space:]]*\\[[[:space:]]*(\"?[-A-Za-z0-9_.:]+\"?[[:space:]]*(,[[:space:]]*\"?[-A-Za-z0-9_.:]+\"?[[:space:]]*)*)?\\][[:space:]]*$".into(),
                        format!("(\\[|,)[[:space:]]*\"?{escaped}\"?[[:space:]]*(,|\\])"),
                    ),
                    _ => return ("1 = 0".into(), Vec::new()),
                };
                let valid = if delimiter == "json" { format!("JSON_VALID({column}) AND ") } else { String::new() };
                (format!("({valid}{column} REGEXP ? AND {column} REGEXP ?)"), vec![guard, pattern])
            }
            Self::Json { member, selector, exclude, ranges, outside_ranges } => {
                if exclude.iter().any(|excluded| excluded == value) || !range_matches(value, ranges, *outside_ranges) {
                    return ("1 = 0".into(), Vec::new());
                }
                let space = "[[:space:]]*";
                let string = r#""([^"\\]|\\.)*""#;
                let scalar = format!("({string}|-?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?|true|false|null)");
                let any_member = format!("{string}{space}:{space}{scalar}{space}");
                let object = format!("\\{{{space}({any_member}(,{space}{any_member})*)?\\}}{space}");
                let wanted = json_member_pattern(member, value);
                let before = format!("({any_member},{space})*");
                let after = format!("(,{space}{any_member})*");
                let members = if let Some(selector) = selector {
                    let selected = json_member_pattern(&selector.member, &selector.value);
                    format!("({wanted},{space}{before}{selected}|{selected},{space}{before}{wanted})")
                } else { wanted };
                let matched = format!("\\{{{space}{before}{members}{after}\\}}{space}");
                let pattern = format!("^{space}\\[{space}({object},{space})*{matched}(,{space}{object})*\\]{space}$");
                (format!("(JSON_VALID({column}) AND {column} REGEXP ?)"), vec![pattern])
            }
            Self::Condition { prefix, value_prefix } => {
                if value_prefix.as_ref().is_some_and(|start| !value.starts_with(start)) {
                    return ("1 = 0".into(), Vec::new());
                }
                let token = match prefix {
                    None if value.ends_with('_') => format!("{escaped}[^|]*"),
                    None => format!("{escaped}([0-9][^|]*)?"),
                    Some(prefix) if prefix == "G" => format!("{}{}(_[^|]*)?", regex_literal(prefix), escaped),
                    Some(prefix) => format!("{}{escaped}", regex_literal(prefix)),
                };
                (format!("({column} REGEXP ? AND {column} REGEXP ?)"), vec![
                    "^[[:space:]]*(and|or|not)[[:space:]]*(\\|[[:space:]]*([A-Za-z]+_?[^|]*)?)*$".into(),
                    format!("\\|[[:space:]]*{token}[[:space:]]*(\\||$)"),
                ])
            }
            Self::Unsupported => ("1 = 0".into(), Vec::new()),
        }
    }
}

enum PathStep { Member(String), Index(usize), Each }

pub fn valid_json_path(path: &str) -> bool { path_steps(path).is_some() }

fn path_steps(path: &str) -> Option<Vec<PathStep>> {
    let mut rest = path.strip_prefix('$')?;
    let mut steps = Vec::new();
    while !rest.is_empty() {
        if let Some(member) = rest.strip_prefix('.') {
            let len = member.bytes().take_while(|ch| ch.is_ascii_alphanumeric() || *ch == b'_').count();
            if len == 0 { return None; }
            steps.push(PathStep::Member(member[..len].into()));
            rest = &member[len..];
        } else if let Some(index) = rest.strip_prefix('[') {
            let end = index.find(']')?;
            let token = &index[..end];
            steps.push(if token == "*" { PathStep::Each } else {
                if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_digit()) { return None; }
                let index: usize = token.parse().ok()?;
                if index > u32::MAX as usize { return None; }
                PathStep::Index(index)
            });
            rest = &index[end + 1..];
        } else { return None; }
        if steps.len() > 16 { return None; }
    }
    Some(steps)
}

fn path_predicate(document: &str, steps: &[PathStep], depth: usize) -> String {
    let Some((step, tail)) = steps.split_first() else {
        return format!("(JSON_TYPE({document}) IN ('STRING','INTEGER','DOUBLE','DECIMAL') AND BINARY TRIM(JSON_UNQUOTE({document})) = BINARY ?)");
    };
    match step {
        PathStep::Member(name) => {
            let child = format!("JSON_EXTRACT({document}, '$.\"{name}\"')");
            format!("(JSON_TYPE({document}) = 'OBJECT' AND {})", path_predicate(&child, tail, depth + 1))
        }
        PathStep::Index(index) => {
            let child = format!("JSON_EXTRACT({document}, '$[{index}]')");
            format!("(JSON_TYPE({document}) = 'ARRAY' AND {})", path_predicate(&child, tail, depth + 1))
        }
        PathStep::Each => {
            // JSON_CONTAINS recursively searches leaf arrays and JSON paths
            // auto-wrap scalars. Walk typed nodes to match extraction exactly.
            let alias = format!("ref_path_{depth}");
            let child = format!("JSON_EXTRACT({document}, CONCAT('$[', {alias}.ordinal - 1, ']'))");
            format!("(JSON_TYPE({document}) = 'ARRAY' AND EXISTS (SELECT 1 FROM JSON_TABLE({document}, '$[*]' COLUMNS (ordinal FOR ORDINALITY)) AS {alias} WHERE {}))",
                path_predicate(&child, tail, depth + 1))
        }
    }
}

fn collect_path(value: &Value, steps: &[PathStep], result: &mut Vec<String>) {
    let Some((step, tail)) = steps.split_first() else {
        if let Some(value) = scalar(value) { result.push(value); }
        return;
    };
    match step {
        PathStep::Member(name) => { if let Some(child) = value.get(name) { collect_path(child, tail, result); } }
        PathStep::Index(index) => { if let Some(child) = value.as_array().and_then(|items| items.get(*index)) { collect_path(child, tail, result); } }
        PathStep::Each => { if let Some(items) = value.as_array() { for child in items { collect_path(child, tail, result); } } }
    }
}

fn json_member_pattern(member: &str, value: &str) -> String {
    let quoted = regex_literal(&serde_json::to_string(value).unwrap_or_default());
    let literal = if serde_json::from_str::<Value>(value).is_ok_and(|value| value.is_number()) {
        format!("({quoted}|{})", regex_literal(value))
    } else { quoted };
    format!("\"{}\"[[:space:]]*:[[:space:]]*{literal}[[:space:]]*", regex_literal(member))
}

fn range_matches(value: &str, ranges: &[(u32, u32)], outside: bool) -> bool {
    ranges.is_empty() || value.parse::<u32>().ok()
        .is_some_and(|value| ranges.iter().any(|(min, max)| (*min..=*max).contains(&value)) != outside)
}

fn regex_literal(value: &str) -> String {
    let mut escaped = String::new();
    for ch in value.chars() {
        if "\\^$.|?*+()[]{}".contains(ch) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_and_backend_share_format_cases() {
        let cases: Value = serde_json::from_str(include_str!("../../../tests/fixtures/config-reference-formats.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let parser: ReferenceParser = serde_json::from_value(case["parser"].clone()).unwrap();
            let expected: Option<Vec<String>> = serde_json::from_value(case["values"].clone()).unwrap();
            assert_eq!(parser.values(case["text"].as_str().unwrap()), expected, "{}", case["name"]);
        }
    }

    #[test]
    fn keys_preserve_order_and_do_not_treat_parameters_as_objects() {
        let comma = ReferenceParser::Keys { delimiter: ",".into() };
        assert_eq!(comma.values("103, 118101,101002,123501,103,0,-1"), Some(vec![
            "103".into(), "118101".into(), "101002".into(), "123501".into(),
        ]));
        assert_eq!(comma.values("function(a,b){return a+b;}"), None);
        assert_eq!(ReferenceParser::Keys { delimiter: "json".into() }.values("[1,\"2\",1,0]"),
            Some(vec!["1".into(), "2".into()]));
    }

    #[test]
    fn conditions_keep_prefixes_and_arguments_separate() {
        let types = ReferenceParser::Condition { prefix: None, value_prefix: None };
        assert_eq!(types.values("and|B232|CD10|CW20|N_com.pc|P_tap|SRL2"),
            Some(["B", "CD", "CW", "N_", "P_", "SRL"].map(str::to_string).to_vec()));
        let build = ReferenceParser::Condition { prefix: Some("B".into()), value_prefix: None };
        assert_eq!(build.values("and|B232|L60|B232"), Some(vec!["232".into()]));
        let goods = ReferenceParser::Condition { prefix: Some("G".into()), value_prefix: None };
        assert_eq!(goods.values("or||G21001_10|L12"), Some(vec!["21001".into()]));
        assert_eq!(types.values("function(x){return x;}"), None);
    }

    #[test]
    fn conditional_json_members_do_not_confuse_amounts_with_keys() {
        let text = r#"[{"ID":2,"Num":900},{"Num":10031,"ID":0},{"ID":999,"Num":81},{"ID":998,"Num":0}]"#;
        let goods = ReferenceParser::Json { member: "ID".into(), selector: None, exclude: vec!["0".into(), "998".into(), "999".into()], ranges: Vec::new(), outside_ranges: false };
        assert_eq!(goods.values(text), Some(vec!["2".into()]));
        let optional = ReferenceParser::Json { member: "Num".into(), selector: Some(JsonSelector { member: "ID".into(), value: "0".into() }), exclude: Vec::new(), ranges: Vec::new(), outside_ranges: false };
        assert_eq!(optional.values(text), Some(vec!["10031".into()]));
        let (_, binds) = optional.predicate("cell", "10031");
        assert!(binds[0].contains("|"), "either JSON member order must work");
        assert_eq!(optional.values("[{bad"), None);
    }

    #[test]
    fn prefixed_parser_extracts_and_builds_safe_predicates() {
        let slot = ReferenceParser::Prefixed {
            prefix: "npc_".into(),
            delimiter: Some(",".into()),
            index: Some(0),
        };
        assert_eq!(slot.values("npc_1041,70,0,0,0"), Some(vec!["1041".into()]));
        assert_eq!(slot.values("npc_1031,75,1,-20,0"), Some(vec!["1031".into()]));
        assert_eq!(slot.values("201,100,0,0,0"), Some(Vec::new()));
        assert_eq!(slot.values("0"), Some(Vec::new()));
        let (sql, binds) = slot.predicate("cell", "1041");
        assert!(sql.contains("REGEXP ?"));
        assert!(binds[0].contains("npc_1041"));

        let free = ReferenceParser::Prefixed {
            prefix: "npc_".into(),
            delimiter: None,
            index: None,
        };
        assert_eq!(free.values("npc_1041,70,0,0,0"), Some(vec!["1041".into()]));
        assert_eq!(free.values("npc_1041|npc_1031"), Some(vec!["1041".into(), "1031".into()]));
        assert_eq!(free.values("{\"id\":\"npc_1041\"}"), None);
        let (free_sql, free_binds) = free.predicate("cell", "1041");
        assert!(free_sql.contains("NOT LIKE 'function%'"));
        assert!(free_binds[0].contains("npc_1041"));
    }
}
