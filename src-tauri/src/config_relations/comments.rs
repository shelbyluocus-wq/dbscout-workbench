//! Relations declared in database column comments, e.g. `奖励物品ID，对应
//! goodsprop.ID`, `奖励模板ID actprayerencmodelprop`, or explicit directives
//! such as `[枚举: 1=N, 2=R]`, `[关联: goodsprop.ID]`, `[列表关联: goodsprop.ID @ ID]`,
//! and `[无关联]`.

use super::catalog::{DbSnapshot, DbTable};
use super::model::RelationKind;
use super::parser::{valid_json_path, ReferenceParser};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentMention {
    /// Lowercase table name.
    pub target_table: String,
    /// Column in database case when the comment names one explicitly.
    pub target_column: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplicitRelation {
    /// Lowercase table name.
    pub target_table: String,
    /// Column in database case.
    pub target_column: String,
    pub kind: RelationKind,
    pub parser: Option<ReferenceParser>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommentDirective {
    /// No explicit directive found; use legacy inference.
    None,
    /// Explicit `[无关联]` / `[none]`: suppress all foreign-key relations.
    NoRelation,
    /// Explicit `[枚举: k=v, ...]` / `[enum: ...]`: enum meaning, no foreign-key relations.
    Enum(Vec<(String, String)>),
    /// Explicit `[关联: ...]` / `[列表关联: ...]`: authoritative relation list.
    Relations(Vec<ExplicitRelation>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RawRelationSpec {
    target_table: String,
    target_column: Option<String>,
    kind: RelationKind,
    parser: Option<ReferenceParser>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ParsedTag {
    NoRelation,
    Enum(Vec<(String, String)>),
    Relations(Vec<RawRelationSpec>),
}

fn is_ident(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// Extract outermost `[...]` and `【...】` spans while respecting nested brackets
/// such as JSONPath `[列表关联: antiquesuitattrprop.SuitID @ $[*][0]]`.
fn extract_bracket_blocks(comment: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut depth: usize = 0;
    let mut content_start: Option<usize> = None;
    for (index, ch) in comment.char_indices() {
        match ch {
            '[' | '【' => {
                if depth == 0 {
                    content_start = Some(index + ch.len_utf8());
                }
                depth += 1;
            }
            ']' | '】' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    if let Some(start) = content_start.take() {
                        blocks.push(&comment[start..index]);
                    }
                }
            }
            _ => {}
        }
    }
    blocks
}

fn split_header(inner: &str) -> Option<(&str, &str)> {
    let pos = inner.find([':', '：'])?;
    let sep_len = inner[pos..].chars().next()?.len_utf8();
    Some((inner[..pos].trim(), inner[pos + sep_len..].trim()))
}

fn parse_enum_entries(body: &str) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    for raw_item in body.split([',', '，', ';', '；', '、', '\n', '\r']) {
        let item = raw_item.trim();
        if item.is_empty() {
            continue;
        }
        let parsed = if let Some((key, label)) = item.split_once("->") {
            Some((key.trim(), label.trim()))
        } else if let Some((key, label)) = item.split_once('→') {
            Some((key.trim(), label.trim()))
        } else if let Some(pos) = item.find(['=', ':', '：']) {
            let sep_len = item[pos..].chars().next().map(char::len_utf8).unwrap_or(1);
            Some((item[..pos].trim(), item[pos + sep_len..].trim()))
        } else {
            let bytes = item.as_bytes();
            let mut idx = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
            let digits_start = idx;
            while idx < bytes.len() && bytes[idx].is_ascii_digit() {
                idx += 1;
            }
            if idx > digits_start && idx < item.len() {
                Some((item[..idx].trim(), item[idx..].trim()))
            } else {
                None
            }
        };
        if let Some((key, label)) = parsed {
            if !key.is_empty() && !label.is_empty() {
                entries.push((key.to_string(), label.to_string()));
            }
        }
    }
    entries
}

fn parse_table_column(spec: &str) -> Option<(String, Option<String>)> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }
    if let Some((table, column)) = spec.split_once('.') {
        let table = table.trim();
        let column = column.trim();
        if is_ident(table) && is_ident(column) {
            return Some((table.to_string(), Some(column.to_string())));
        }
        return None;
    }
    is_ident(spec).then(|| (spec.to_string(), None))
}

fn parse_list_extractor(extractor: &str) -> Option<ReferenceParser> {
    let extractor = extractor.trim();
    if extractor.is_empty() {
        return None;
    }
    let lower = extractor.to_ascii_lowercase();
    if lower == "json" {
        return Some(ReferenceParser::Keys {
            delimiter: "json".into(),
        });
    }
    if matches!(extractor, "," | "，") || lower == "comma" {
        return Some(ReferenceParser::Keys {
            delimiter: ",".into(),
        });
    }
    if extractor == "|" || lower == "pipe" {
        return Some(ReferenceParser::Keys {
            delimiter: "|".into(),
        });
    }
    if extractor.starts_with('$') {
        return valid_json_path(extractor).then(|| ReferenceParser::JsonPaths {
            paths: vec![extractor.to_string()],
            exclude: Vec::new(),
        });
    }
    is_ident(extractor).then(|| ReferenceParser::json(extractor))
}

fn parse_ref_specs(body: &str) -> Vec<RawRelationSpec> {
    let mut specs = Vec::new();
    for item in body.split([',', '，', ';', '；']) {
        if let Some((target_table, target_column)) = parse_table_column(item) {
            specs.push(RawRelationSpec {
                target_table,
                target_column,
                kind: RelationKind::Value,
                parser: None,
            });
        }
    }
    specs
}

fn parse_list_specs(body: &str) -> Vec<RawRelationSpec> {
    let mut specs = Vec::new();
    for item in body.split([';', '；']) {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let (target_part, extractor_part) = match item.split_once('@') {
            Some((left, right)) => (left.trim(), Some(right.trim())),
            None => (item, None),
        };
        let Some((target_table, target_column)) = parse_table_column(target_part) else {
            continue;
        };
        let parser = match extractor_part {
            Some(extractor) if !extractor.is_empty() => {
                let Some(parsed) = parse_list_extractor(extractor) else {
                    continue;
                };
                Some(parsed)
            }
            _ => None,
        };
        specs.push(RawRelationSpec {
            target_table,
            target_column,
            kind: RelationKind::List,
            parser,
        });
    }
    specs
}

fn parse_tag(inner: &str) -> Option<ParsedTag> {
    let trimmed = inner.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "无关联" || trimmed.eq_ignore_ascii_case("none") {
        return Some(ParsedTag::NoRelation);
    }
    let (header, body) = split_header(trimmed)?;
    if (header == "无关联" || header.eq_ignore_ascii_case("none")) && body.is_empty() {
        return Some(ParsedTag::NoRelation);
    }
    if header == "枚举" || header.eq_ignore_ascii_case("enum") {
        let entries = parse_enum_entries(body);
        return (!entries.is_empty()).then_some(ParsedTag::Enum(entries));
    }
    if header == "关联" || header.eq_ignore_ascii_case("ref") {
        let specs = parse_ref_specs(body);
        return (!specs.is_empty()).then_some(ParsedTag::Relations(specs));
    }
    if header == "列表关联" || header.eq_ignore_ascii_case("list") {
        let specs = parse_list_specs(body);
        return (!specs.is_empty()).then_some(ParsedTag::Relations(specs));
    }
    None
}

fn parse_raw_tags(comment: &str) -> Vec<ParsedTag> {
    extract_bracket_blocks(comment)
        .into_iter()
        .filter_map(parse_tag)
        .collect()
}

pub fn has_explicit_directive(comment: &str) -> bool {
    !parse_raw_tags(comment).is_empty()
}

/// Parse an explicit structured directive in a column comment. When present,
/// it overrides fuzzy comment, client-code, format and project-rule inference
/// for this column.
pub fn parse_directive(comment: &str, snapshot: &DbSnapshot) -> CommentDirective {
    let tags = parse_raw_tags(comment);
    if tags.is_empty() {
        return CommentDirective::None;
    }
    if tags.iter().any(|tag| matches!(tag, ParsedTag::NoRelation)) {
        return CommentDirective::NoRelation;
    }
    let mut enum_entries = Vec::new();
    for tag in &tags {
        if let ParsedTag::Enum(entries) = tag {
            enum_entries.extend(entries.iter().cloned());
        }
    }
    if !enum_entries.is_empty() {
        return CommentDirective::Enum(enum_entries);
    }
    let mut relations = Vec::new();
    for tag in tags {
        if let ParsedTag::Relations(specs) = tag {
            for spec in specs {
                let Some(table) = snapshot.table(&spec.target_table) else {
                    continue;
                };
                let target_column = match &spec.target_column {
                    Some(column) => table.column(column).map(|col| col.name.clone()),
                    None => table.key_column().map(str::to_string),
                };
                let Some(target_column) = target_column else {
                    continue;
                };
                let rel = ExplicitRelation {
                    target_table: table.name.to_lowercase(),
                    target_column,
                    kind: spec.kind,
                    parser: spec.parser,
                };
                if !relations.contains(&rel) {
                    relations.push(rel);
                }
            }
        }
    }
    CommentDirective::Relations(relations)
}

/// Words that tell a table name in a comment refers to a lookup target.
const RELATION_CUES: [&str; 15] = [
    "对应", "引用", "关联", "来自", "取自", "读取", "索引", "参照", "参考", "见", "表", "id", "编号", "键", "key",
];
/// Comments that describe who references this column rather than what it references.
const REVERSE_MARKERS: [&str; 5] = ["引用本字段", "引用此字段", "被引用", "被关联", "引用方"];
const CUE_WINDOW_CHARS: usize = 12;
/// Shorter table names collide with ordinary words in comments.
const MIN_TABLE_NAME_LEN: usize = 4;

struct Word<'a> {
    text: &'a str,
    start: usize,
    end: usize,
}

fn words(text: &str) -> Vec<Word<'_>> {
    let mut words = Vec::new();
    let mut start = None;
    for (index, ch) in text.char_indices() {
        let is_word = ch.is_ascii_alphanumeric() || ch == '_';
        match (start, is_word) {
            (None, true) if !ch.is_ascii_digit() => start = Some(index),
            (Some(begin), false) => {
                words.push(Word {
                    text: &text[begin..index],
                    start: begin,
                    end: index,
                });
                start = None;
            }
            _ => {}
        }
    }
    if let Some(begin) = start {
        words.push(Word {
            text: &text[begin..],
            start: begin,
            end: text.len(),
        });
    }
    words
}

/// Column named right after the table, as in `goodsprop.ID`, `goodsprop 的 ID`
/// or `goodsprop表的ID`.
fn explicit_column<'a>(text: &str, word_end: usize, next: Option<&Word<'a>>, table: &DbTable) -> Option<String> {
    let next = next?;
    let between = text[word_end..next.start].trim();
    let joined = matches!(between, "." | "．" | "的" | "表的" | "表" | "->" | ":" | "：");
    if !joined {
        return None;
    }
    table.column(next.text).map(|column| column.name.clone())
}

fn window(text: &str, start: usize, end: usize) -> String {
    let before = text[..start]
        .chars()
        .rev()
        .take(CUE_WINDOW_CHARS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    let after = text[end..].chars().take(CUE_WINDOW_CHARS).collect::<String>();
    format!("{before} {after}").to_lowercase()
}

fn preceded_by_supply_marker(text: &str, start: usize) -> bool {
    text[..start].chars().rev().take(3).any(|ch| ch == '供')
}

pub fn parse(comment: &str, own_table: &str, own_column: &str, snapshot: &DbSnapshot) -> Vec<CommentMention> {
    let comment = comment.trim();
    if comment.is_empty()
        || has_explicit_directive(comment)
        || REVERSE_MARKERS.iter().any(|marker| comment.contains(marker))
        || (comment.contains('被') && comment.contains("引用"))
    {
        return Vec::new();
    }

    let words = words(comment);
    let own_table = own_table.to_lowercase();
    let mut mentions: Vec<CommentMention> = Vec::new();
    for (index, word) in words.iter().enumerate() {
        if word.text.len() < MIN_TABLE_NAME_LEN {
            continue;
        }
        let Some(table) = snapshot.table(word.text) else {
            continue;
        };
        if preceded_by_supply_marker(comment, word.start) {
            continue;
        }
        let target_table = word.text.to_lowercase();
        let column = explicit_column(comment, word.end, words.get(index + 1), table);
        // Mentioning where a label, unit or threshold is defined is not a
        // lookup with the value of this cell.
        if column.as_ref().is_some_and(|name| {
            table.column(name).is_some_and(|column| column.is_text())
                && !table.primary_keys.iter().any(|key| key.eq_ignore_ascii_case(name))
                && ["param", "desc", "des", "name", "text", "title"].iter()
                    .any(|prefix| name.to_lowercase().starts_with(prefix))
        }) {
            continue;
        }
        let bracketed = comment[..word.start].trim_end().ends_with(['(', '（'])
            && comment[word.end..].trim_start().starts_with([')', '）']);
        let cued = column.is_some() || bracketed || {
            let around = window(comment, word.start, word.end);
            RELATION_CUES.iter().any(|cue| around.contains(cue))
        };
        if !cued {
            continue;
        }
        if target_table == own_table
            && column
                .as_deref()
                .is_none_or(|column| column.eq_ignore_ascii_case(own_column))
        {
            continue;
        }
        let mention = CommentMention {
            target_table,
            target_column: column,
        };
        if !mentions.contains(&mention) {
            mentions.push(mention);
        }
    }
    mentions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_relations::catalog::test_support::{snapshot, table};

    fn db() -> DbSnapshot {
        snapshot(vec![
            table("goodsprop", &[("ID", "int", "", true), ("Name", "varchar", "", false)]),
            table("taskprop", &[("ID", "int", "", true), ("NextID", "int", "", false)]),
            table("actprayerencmodelprop", &[("ID", "int", "", true)]),
            table("map", &[("ID", "int", "", true)]),
        ])
    }

    fn mention(table: &str, column: Option<&str>) -> CommentMention {
        CommentMention {
            target_table: table.into(),
            target_column: column.map(str::to_string),
        }
    }

    #[test]
    fn explicit_table_column_mentions() {
        let db = db();
        assert_eq!(
            parse("奖励物品ID，对应goodsprop.ID", "rewardprop", "ItemID", &db),
            vec![mention("goodsprop", Some("ID"))]
        );
        assert_eq!(
            parse("引用 goodsprop 表的 id", "rewardprop", "ItemID", &db),
            vec![mention("goodsprop", Some("ID"))]
        );
        assert_eq!(
            parse("引用 goodsprop.ID；具体条件由Param1至Param3配置", "rewardprop", "ItemID", &db),
            vec![mention("goodsprop", Some("ID"))]
        );
    }

    #[test]
    fn table_only_mentions_need_a_relation_cue() {
        let db = db();
        assert_eq!(
            parse("奖励模板ID actprayerencmodelprop", "actprop", "ModelID", &db),
            vec![mention("actprayerencmodelprop", None)]
        );
        assert!(parse("说明 goodsprop", "rewardprop", "Desc", &db).is_empty());
        assert!(parse("对应 map", "rewardprop", "MapID", &db).is_empty(), "short names are ignored");
    }

    #[test]
    fn reverse_and_self_mentions_are_ignored() {
        let db = db();
        assert!(parse("供 taskprop 引用本字段", "goodsprop", "ID", &db).is_empty());
        assert!(parse("供taskprop表读取", "goodsprop", "ID", &db).is_empty());
        assert!(parse("任务ID，对应taskprop", "taskprop", "ID", &db).is_empty());
        assert_eq!(
            parse("下一个任务，对应taskprop.ID", "taskprop", "NextID", &db),
            vec![mention("taskprop", Some("ID"))]
        );
    }

    #[test]
    fn duplicate_mentions_collapse() {
        let db = db();
        assert_eq!(
            parse("goodsprop.ID（对应goodsprop.ID）", "rewardprop", "ItemID", &db),
            vec![mention("goodsprop", Some("ID"))]
        );
    }

    #[test]
    fn parenthesized_table_names_are_explicit_lookup_hints() {
        assert_eq!(parse("formation template (taskprop)", "rewardprop", "Template", &db()),
            vec![mention("taskprop", None)]);
        assert!(parse("description taskprop", "rewardprop", "Desc", &db()).is_empty());
    }

    #[test]
    fn explicit_directives_parse_all_phase_one_forms_and_silence_fuzzy_mentions() {
        let db = snapshot(vec![
            table("goodsprop", &[("ID", "int", "", true), ("GoodsKind", "int", "", false)]),
            table("heroprop", &[("ID", "int", "", true), ("Quality", "int", "", false)]),
            table("comgrowthunitopenprop", &[("ID", "int", "", true)]),
            table("antiquesuitattrprop", &[("SuitID", "int", "", true)]),
        ]);
        let enum_comment = "可选英雄魂石的最大单位稀有度，引用 heroprop.Quality；可选范围为 goodsprop.GoodsKind=10 且 comgrowthunitopenprop 已开放 [枚举: 1=N, 2=R, 3=SR, 4=SSR, 5=UR, 6=SUR]";
        assert!(has_explicit_directive(enum_comment));
        assert!(parse(enum_comment, "unionhelpqualityprop", "MaxUnitQuality", &db).is_empty());
        assert_eq!(
            parse_directive(enum_comment, &db),
            CommentDirective::Enum(vec![
                ("1".into(), "N".into()),
                ("2".into(), "R".into()),
                ("3".into(), "SR".into()),
                ("4".into(), "SSR".into()),
                ("5".into(), "UR".into()),
                ("6".into(), "SUR".into()),
            ])
        );

        let fullwidth_enum = "格位品质【枚举：1蓝、2紫、3橙】";
        assert_eq!(
            parse_directive(fullwidth_enum, &db),
            CommentDirective::Enum(vec![
                ("1".into(), "蓝".into()),
                ("2".into(), "紫".into()),
                ("3".into(), "橙".into()),
            ])
        );

        let no_rel = "对应 heroprop.ID 但仅作展示 [无关联]";
        assert_eq!(parse_directive(no_rel, &db), CommentDirective::NoRelation);
        assert!(parse(no_rel, "unionhelpqualityprop", "MaxUnitQuality", &db).is_empty());

        let single_ref = "备注提到 heroprop.ID，实际指向道具 [关联: goodsprop.ID]";
        assert_eq!(
            parse_directive(single_ref, &db),
            CommentDirective::Relations(vec![ExplicitRelation {
                target_table: "goodsprop".into(),
                target_column: "ID".into(),
                kind: RelationKind::Value,
                parser: None,
            }])
        );

        let list_json_path = "套装列表 [列表关联: antiquesuitattrprop.SuitID @ $[*][0]]";
        assert_eq!(
            parse_directive(list_json_path, &db),
            CommentDirective::Relations(vec![ExplicitRelation {
                target_table: "antiquesuitattrprop".into(),
                target_column: "SuitID".into(),
                kind: RelationKind::List,
                parser: Some(ReferenceParser::JsonPaths {
                    paths: vec!["$[*][0]".into()],
                    exclude: Vec::new(),
                }),
            }])
        );

        let list_comma = "逗号列表 [列表关联: goodsprop @ ,]";
        assert_eq!(
            parse_directive(list_comma, &db),
            CommentDirective::Relations(vec![ExplicitRelation {
                target_table: "goodsprop".into(),
                target_column: "ID".into(),
                kind: RelationKind::List,
                parser: Some(ReferenceParser::Keys { delimiter: ",".into() }),
            }])
        );

        let list_member = "奖励数组 [列表关联: goodsprop.ID @ ID]";
        assert_eq!(
            parse_directive(list_member, &db),
            CommentDirective::Relations(vec![ExplicitRelation {
                target_table: "goodsprop".into(),
                target_column: "ID".into(),
                kind: RelationKind::List,
                parser: Some(ReferenceParser::json("ID")),
            }])
        );

        let list_auto = "道具数组 [列表关联: goodsprop.ID]";
        assert_eq!(
            parse_directive(list_auto, &db),
            CommentDirective::Relations(vec![ExplicitRelation {
                target_table: "goodsprop".into(),
                target_column: "ID".into(),
                kind: RelationKind::List,
                parser: None,
            }])
        );

        // Ordinary brackets like JSON samples must not be treated as directives.
        assert_eq!(
            parse_directive("示例 [2, 4, 6, 8] 对应 goodsprop.ID", &db),
            CommentDirective::None
        );
    }
}
