//! Relations declared in database column comments, e.g. `奖励物品ID，对应
//! goodsprop.ID` or `奖励模板ID actprayerencmodelprop`.

use super::catalog::{DbSnapshot, DbTable};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentMention {
    /// Lowercase table name.
    pub target_table: String,
    /// Column in database case when the comment names one explicitly.
    pub target_column: Option<String>,
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
    if comment.is_empty() || REVERSE_MARKERS.iter().any(|marker| comment.contains(marker))
        || (comment.contains('被') && comment.contains("引用")) {
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
}
