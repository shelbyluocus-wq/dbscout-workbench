//! Schema-gated jswz conventions verified against client readers and column
//! documentation. Keep exceptional mappings here rather than guessing that
//! any numeric array is a foreign key (weights, coordinates and levels are not).

use super::catalog::{DbColumn, DbSnapshot};
use super::formats::TableFormats;
use super::model::RelationKind;
use super::parser::ReferenceParser;

// attrCommDef: isHeroID / isPet / isSacSpiritID / isMount. These core
// entities share heroprop, whereas inventory resources live in goodsprop.
pub const CORE_RANGES: &[(u32, u32)] = &[(1001, 1999), (2101, 2998), (5100, 5998), (6101, 6998)];

pub fn matches_schema(snapshot: &DbSnapshot) -> bool {
    snapshot.column_name("conditionopencondprop", "Pre").is_some()
        && snapshot.column_name("growupfmtmodelprop", "ModelID").is_some()
}

pub fn inspect(table: &str, column: &DbColumn, values: &[String], snapshot: &DbSnapshot, formats: &mut TableFormats) {
    if !matches_schema(snapshot) {
        return;
    }
    let name = column.name.to_ascii_lowercase();
    if table == "boxprop" && name == "itemcfg" {
        let sample = values.iter().find(|value| !super::parser::empty(value)).map(String::as_str).unwrap_or("");
        formats.replaced.insert(name);
        for (target, outside) in [("goodsprop", true), ("heroprop", false)] {
            formats.target(column, snapshot, target, "ID", RelationKind::Value, ReferenceParser::Json {
                member: "ID".into(), selector: None, exclude: Vec::new(),
                ranges: CORE_RANGES.to_vec(), outside_ranges: outside,
            }, sample);
        }
        return;
    }
    let json = || ReferenceParser::Keys { delimiter: "json".into() };
    let comma = || ReferenceParser::Keys { delimiter: ",".into() };
    let pipe = || ReferenceParser::Keys { delimiter: "|".into() };
    let mapping = match (table, name.as_str()) {
        ("altarfmtencprop", "herolst")
        | ("heroprop", "mountidlst")
        | ("worldbossbaseprop", "bossid" | "crossbossid")
        | ("act309surqiyue1prop", "p1lst" | "lastp1lst") => Some(("heroprop", "ID", json())),
        ("playerdefaultcfgprop", "fheroid" | "fsacid" | "fmountid" | "fpetid")
        | ("commonprop", "guidesortfmtlst") => Some(("heroprop", "ID", pipe())),
        ("ins1prop" | "ins2prop" | "ins3prop" | "ins4prop" | "ins5prop", "fmtmodel") => Some(("growupfmtmodelprop", "ModelID", comma())),
        ("ins1prop" | "ins2prop" | "ins3prop" | "ins4prop" | "ins5prop", "sacidlst" | "petidlst") => Some(("heroprop", "ID", comma())),
        ("dungeonexploreroadprop", "node") => Some(("dungeonexplorenodeprop", "NodeID", pipe())),
        ("relicroadprop", "node") => Some(("relicnodeprop", "NodeID", pipe())),
        ("relicdifficultyprop", "randroadcfg") => Some(("relicroadprop", "RoadID", ReferenceParser::json("RoadID"))),
        ("dungeonexploredifficultyprop", "randroadcfg") => Some(("dungeonexploreroadprop", "RoadID", ReferenceParser::json("ID"))),
        ("insonhookspecialrewardprop", "goodsid") => Some(("goodsprop", "ID", json())),
        ("magicstoneescortguardprop", "npcguardlvllist") => Some(("magicstoneescortguardprop", "GuardLvl", json())),
        _ => None,
    };
    if let Some((target, key, parser)) = mapping {
        if snapshot.column_name(target, key).is_none() { return; }
        formats.columns.insert(name, parser.clone());
        let sample = values.iter().find(|value| !super::parser::empty(value)).map(String::as_str).unwrap_or("");
        if !formats.findings.iter().any(|finding| finding.column == column.name && finding.target_table == target && finding.target_column == key) {
            formats.target(column, snapshot, target, key, RelationKind::Value, parser, sample);
        }
    }
}
