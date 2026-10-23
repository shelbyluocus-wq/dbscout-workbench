//! Opt-in verification against an explicitly exported, read-only database
//! snapshot. No database credentials or project-specific paths are embedded.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc};

use serde_json::{json, Value};

use super::assembly::{assemble, CodeState, Inputs};
use super::catalog::{DbColumn, DbSnapshot, DbTable};
use super::code_scan::{detect_dialect, scan, ScanCache};
use super::formats::TableFormats;
use super::model::RelationKind;
use super::rows::reference_values;

#[test]
#[ignore = "requires DBSCOUT_RELATION_AUDIT_DIR and DBSCOUT_RELATION_CLIENT"]
fn exported_config_database() {
    let directory = PathBuf::from(std::env::var("DBSCOUT_RELATION_AUDIT_DIR").expect("snapshot directory"));
    let client = PathBuf::from(std::env::var("DBSCOUT_RELATION_CLIENT").expect("client directory"));
    let audit: Value = serde_json::from_slice(&std::fs::read(directory.join("audit.json")).unwrap()).unwrap();
    let mut snapshot = DbSnapshot::default();
    let mut all_rows = BTreeMap::new();
    for entry in audit["tables"].as_array().unwrap() {
        let name = entry["tableName"].as_str().unwrap();
        let exported: Value = serde_json::from_slice(&std::fs::read(directory.join(format!("{name}.json"))).unwrap()).unwrap();
        let columns = exported["schema"]["columns"].as_array().unwrap();
        snapshot.tables.insert(name.into(), DbTable {
            name: name.into(), comment: entry["tableComment"].as_str().unwrap_or("").into(),
            columns: columns.iter().map(|column| DbColumn {
                name: column["columnName"].as_str().unwrap().into(),
                data_type: column["dataType"].as_str().unwrap_or("text").into(),
                comment: column["columnComment"].as_str().unwrap_or("").into(),
            }).collect(),
            primary_keys: columns.iter().filter(|column| column["isPrimaryKey"] == true)
                .map(|column| column["columnName"].as_str().unwrap().into()).collect(),
            modified_at: None,
        });
        let rows: Vec<HashMap<String, String>> = serde_json::from_value(exported["rows"].clone()).unwrap();
        all_rows.insert(name.to_string(), rows);
    }
    let mut formats = BTreeMap::new();
    let mut sampled = BTreeMap::new();
    for (name, table) in &snapshot.tables {
        let mut profile = TableFormats::default();
        let mut sample_profile = TableFormats::default();
        for column in table.columns.iter().filter(|column| column.is_text()) {
            let values: Vec<_> = all_rows[name].iter().filter_map(|row| row.get(&column.name).cloned()).collect();
            profile.inspect(column, &values, &snapshot);
            super::project_formats::inspect(name, column, &values, &snapshot, &mut profile);
            let mut sampled_values = values.iter().take(200).cloned().collect::<Vec<_>>();
            if super::formats::condition_column(column, &snapshot) {
                for prefix in super::formats::CONDITION_PROBES {
                    if let Some(value) = values.iter().filter(|value| value.split('|').any(|token| token.trim().starts_with(prefix))).max() {
                        sampled_values.push(value.clone());
                    }
                }
            }
            sample_profile.inspect(column, &sampled_values, &snapshot);
            let values = sampled_values;
            super::project_formats::inspect(name, column, &values, &snapshot, &mut sample_profile);
        }
        formats.insert(name.clone(), profile);
        sampled.insert(name.clone(), sample_profile);
    }
    let mut cache = ScanCache::default();
    let report = scan(&client, detect_dialect(&client).unwrap(), &snapshot.table_columns(),
        &mut cache, &AtomicBool::new(false)).unwrap();
    let scan_details = json!({"files": report.files_scanned, "usedTables": report.used_tables,
        "untraced": report.untraced.iter().map(|lookup| json!({"table":lookup.target_table,
            "column":lookup.target_column,"file":lookup.location.file,"line":lookup.location.line,
            "snippet":lookup.location.snippet})).collect::<Vec<_>>()});
    let warm_report = scan(&client, detect_dialect(&client).unwrap(), &snapshot.table_columns(),
        &mut cache, &AtomicBool::new(false)).unwrap();
    assert_eq!(warm_report.files_reparsed, 0);
    assert_eq!(report.relations, warm_report.relations);
    let code = CodeState::Ready(Arc::new(report));
    let inputs = |profiles| Inputs {
        snapshot: &snapshot, code: &code, formats: profiles,
        formats_pending: false, record: None, now: "audit",
    };
    let full = assemble(&inputs(&formats));
    let warm = assemble(&inputs(&sampled));
    let empty = BTreeMap::new();
    let cold = assemble(&inputs(&empty));
    let mut entries = Vec::new();
    let mut sql_checks = Vec::new();
    let mut row_examples = Vec::new();
    let mut keys: HashMap<(String, String), HashSet<String>> = HashMap::new();
    for (name, table) in &snapshot.tables {
        for view in full.outgoing(name) {
            let target = (view.key.target_table.clone(), view.key.target_column.clone());
            let target_keys = keys.entry(target.clone()).or_insert_with(|| {
                all_rows[&target.0].iter().filter_map(|row| row.get(&target.1)).map(|value| value.trim().to_lowercase()).collect()
            });
            let mut values_seen = HashSet::new();
            let mut missing = BTreeMap::<String, usize>::new();
            let mut unresolved = 0usize;
            let mut populated = 0usize;
            let mut samples = Vec::new();
            let mut parsed_values = Some(Vec::<Option<Vec<String>>>::new());
            for row in &all_rows[name] {
                let text = row.get(&view.key.source_column).map(String::as_str).unwrap_or("");
                let applies = super::constraints::matches(&view.source_constraints, row);
                let unparsed = applies && view.parser.as_ref().is_some_and(|parser| parser.values(text).is_none());
                if unparsed {
                    unresolved += 1;
                    if samples.len() < 2 { samples.push(text.chars().take(160).collect::<String>()); }
                }
                let values = reference_values(&view, row);
                parsed_values.as_mut().unwrap().push((!unparsed).then(|| values.clone()));
                if !values.is_empty() { populated += 1; }
                for value in &values {
                    values_seen.insert(value.clone());
                    if !target_keys.contains(&value.to_lowercase()) {
                        *missing.entry(value.clone()).or_default() += 1;
                    }
                }
                if name == "goodsprop" && matches!(row.get("ID").map(String::as_str), Some("15" | "204")) {
                    row_examples.push(json!({"row": row.get("ID"), "relation": view, "values": values}));
                }
            }
            {
                let mut sorted = values_seen.into_iter().collect::<Vec<_>>();
                sorted.sort();
                for value in sorted.iter().take(2) {
                    let expected = all_rows[name].iter().filter(|row| reference_values(&view, row).contains(value)).count();
                    let (mut predicate, mut binds) = super::filter::reference_predicate(&format!("CAST(`{}` AS CHAR)", view.key.source_column),
                        view.key.kind == RelationKind::List, view.parser.as_ref(), "ID", value);
                    let (guard, guard_binds) = super::constraints::predicate(&view.source_constraints);
                    if !guard.is_empty() { predicate = format!("({predicate}) AND ({guard})"); }
                    binds.extend(guard_binds);
                    sql_checks.push(json!({"table": name, "relation": view.id, "predicate": predicate, "binds": binds,
                        "value": value, "expected": expected}));
                }
            }
            let sampled_parser = warm.find(&view.id).and_then(|view| view.parser.as_ref());
            entries.push(json!({
                "relation": view, "rows": all_rows[name].len(), "populated": populated,
                "unparsed": unresolved, "unparsedSamples": samples, "missing": missing,
                "parsedValues": parsed_values,
                "sampleAgrees": sampled_parser == view.parser.as_ref(),
                "coldParser": cold.find(&view.id).and_then(|view| view.parser.as_ref()),
            }));
        }
        assert_eq!(table.name, *name);
    }
    // The two user-visible regressions must resolve in the actual production
    // sample path, not just with a full offline scan.
    for index in [&cold, &warm, &full] {
        let box_relation = index.find("boxprop.boxid>goodsprop.id").unwrap();
        assert!(index.incoming("goodsprop").iter().any(|view| view.id == box_relation.id));
        assert!(index.incoming("goodsprop").iter().any(|view| view.key.source_table == "boxprop" && view.key.source_column == "ItemCfg"));
        let provenance = index.find("goodsprop.provenance>goodssourceprop.sourceid").unwrap();
        let row = all_rows["goodsprop"].iter().find(|row| row["ID"] == "204").unwrap();
        assert_eq!(reference_values(provenance, row), ["103", "118101", "101002", "123501"]);
        let condition = index.find("goodsprop.opencond>conditionopencondprop.pre").unwrap();
        let row = all_rows["goodsprop"].iter().find(|row| row["ID"] == "15").unwrap();
        assert_eq!(reference_values(condition, row), ["B"]);
        assert_eq!(provenance.key.kind, RelationKind::Value);
    }
    for view in full.outgoing("goodsprop") {
        if view.key.source_column.eq_ignore_ascii_case("OpenCond") || view.key.source_column.eq_ignore_ascii_case("Provenance") {
            assert!(warm.find(&view.id).is_some(), "missing sampled relation {}", view.id);
        }
    }
    for entry in &entries {
        assert_eq!(entry["sampleAgrees"], true, "sampling drift: {}", entry["relation"]["id"]);
    }
    let fixture_cases: Value = serde_json::from_str(include_str!("../../../tests/fixtures/config-reference-formats.json")).unwrap();
    let mut fixture_checks = Vec::new();
    for case in fixture_cases.as_array().unwrap() {
        let parser: super::parser::ReferenceParser = serde_json::from_value(case["parser"].clone()).unwrap();
        let values = parser.values(case["text"].as_str().unwrap()).unwrap_or_default();
        let probes = values.iter().map(String::as_str).chain(["7", "10", "81", "900", "10031", "999", "B", "C", "232", "123201"]);
        for value in probes {
            let (predicate, binds) = parser.predicate("cell", value);
            fixture_checks.push(json!({"name": case["name"], "text": case["text"], "predicate": predicate,
                "binds": binds, "value": value, "expected": usize::from(values.contains(&value.to_string()))}));
        }
    }
    let table_checks = snapshot.tables.iter().map(|(name, table)| json!({
        "table": name, "columns":table.columns.len(), "rows":all_rows[name].len(),
        "outgoing":full.outgoing(name).len(), "incoming":full.incoming(name).len(),
        "coverage":full.coverage(name),
    })).collect::<Vec<_>>();
    let result = json!({"tables": snapshot.tables.len(), "tableChecks": table_checks, "scan":scan_details,
        "relations": entries, "sqlChecks": sql_checks, "examples": row_examples, "fixtureChecks": fixture_checks});
    std::fs::write(directory.join("relations-audit.json"), serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    println!("Audited {} tables, {} relations, {} SQL cases", snapshot.tables.len(),
        entries.len(), sql_checks.len());
}
