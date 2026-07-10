use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::db::normalize_page_request;
use crate::types::{
    ColumnMeta, PerfFixtureMetadata, TableMeta, TablePageRequest, TableSessionPage,
};

const PROFILE_JSON: &str = include_str!("../../scripts/perf/fixture-profile.v1.json");
const DEFAULT_SCENARIO: PerfFixtureScenario = PerfFixtureScenario::Smoke;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PerfFixtureScenario {
    Smoke,
    Rows1k12Pk,
    Rows10k40Pk,
    Rows10k60NoPk,
    Rows50k200Pk,
    Rows100k40NoPk,
    Rows100k500Pk,
    Insert100x20,
    Insert500x20,
    Import10k,
    Schema800x60,
}

impl PerfFixtureScenario {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Smoke => "smoke",
            Self::Rows1k12Pk => "rows-1k-12-pk",
            Self::Rows10k40Pk => "rows-10k-40-pk",
            Self::Rows10k60NoPk => "rows-10k-60-no-pk",
            Self::Rows50k200Pk => "rows-50k-200-pk",
            Self::Rows100k40NoPk => "rows-100k-40-no-pk",
            Self::Rows100k500Pk => "rows-100k-500-pk",
            Self::Insert100x20 => "insert-100x20",
            Self::Insert500x20 => "insert-500x20",
            Self::Import10k => "import-10k",
            Self::Schema800x60 => "schema-800x60",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        Some(match value {
            "smoke" => Self::Smoke,
            "rows-1k-12-pk" => Self::Rows1k12Pk,
            "rows-10k-40-pk" => Self::Rows10k40Pk,
            "rows-10k-60-no-pk" => Self::Rows10k60NoPk,
            "rows-50k-200-pk" => Self::Rows50k200Pk,
            "rows-100k-40-no-pk" => Self::Rows100k40NoPk,
            "rows-100k-500-pk" => Self::Rows100k500Pk,
            "insert-100x20" => Self::Insert100x20,
            "insert-500x20" => Self::Insert500x20,
            "import-10k" => Self::Import10k,
            "schema-800x60" => Self::Schema800x60,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PerfFixtureSelection {
    pub profile: &'static str,
    pub scenario: PerfFixtureScenario,
}

impl PerfFixtureSelection {
    pub fn for_scenario(scenario: PerfFixtureScenario) -> Self {
        Self {
            profile: profile().profile.as_str(),
            scenario,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureProfile {
    profile: String,
    version: String,
    connection_id: String,
    database: String,
    scenarios: BTreeMap<String, FixtureScenarioSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureScenarioSpec {
    kind: String,
    row_count: usize,
    column_count: usize,
    #[serde(default)]
    table_count: Option<usize>,
    primary_key: bool,
}

fn profile() -> &'static FixtureProfile {
    static PROFILE: OnceLock<FixtureProfile> = OnceLock::new();
    PROFILE.get_or_init(|| {
        serde_json::from_str(PROFILE_JSON)
            .expect("canonical performance fixture profile must parse")
    })
}

fn scenario_spec(selection: &PerfFixtureSelection) -> &'static FixtureScenarioSpec {
    profile()
        .scenarios
        .get(selection.scenario.as_str())
        .expect("whitelisted fixture scenario must exist in canonical profile")
}

pub fn parse_fixture_selection(value: Option<&str>) -> Option<PerfFixtureSelection> {
    let value = value?;
    if value.is_empty() || value.trim() != value {
        return None;
    }
    let (profile_name, scenario_name) = value.split_once(':').map_or(
        (value, DEFAULT_SCENARIO.as_str()),
        |(profile_name, scenario)| (profile_name, scenario),
    );
    if profile_name != profile().profile {
        return None;
    }
    let scenario = PerfFixtureScenario::from_str(scenario_name)?;
    Some(PerfFixtureSelection {
        profile: profile().profile.as_str(),
        scenario,
    })
}

fn canonical_json(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => output.push_str(
            &serde_json::to_string(value).expect("serializing a JSON string cannot fail"),
        ),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical_json(value, output);
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key).expect("serializing a JSON key cannot fail"),
                );
                output.push(':');
                canonical_json(&values[key], output);
            }
            output.push('}');
        }
    }
}

pub fn fixture_hash() -> String {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| {
        let value: Value = serde_json::from_str(PROFILE_JSON)
            .expect("canonical performance fixture profile must parse as JSON");
        let mut canonical = String::new();
        canonical_json(&value, &mut canonical);
        format!("{:x}", Sha256::digest(canonical.as_bytes()))
    })
    .clone()
}

pub fn fixture_connection_id() -> &'static str {
    profile().connection_id.as_str()
}

pub fn fixture_database() -> &'static str {
    profile().database.as_str()
}

fn padded(value: usize, width: usize) -> String {
    format!("{value:0width$}")
}

fn table_name(selection: &PerfFixtureSelection, table_index: usize) -> String {
    if selection.scenario == PerfFixtureScenario::Schema800x60 {
        format!("perf_schema_table_{}", padded(table_index, 4))
    } else {
        format!(
            "perf_{}",
            selection
                .scenario
                .as_str()
                .replace(|ch: char| !ch.is_ascii_alphanumeric(), "_")
        )
    }
}

fn fixture_columns(selection: &PerfFixtureSelection) -> Vec<ColumnMeta> {
    let spec = scenario_spec(selection);
    (0..spec.column_count)
        .map(|index| {
            let primary = spec.primary_key && index == 0;
            let name = if primary {
                "id".to_string()
            } else {
                format!("field_{}", padded(index, 3))
            };
            ColumnMeta::with_basic(
                &name,
                if primary { "bigint" } else { "varchar(96)" },
                if primary {
                    "Deterministic fixture primary key"
                } else {
                    "Deterministic fixture field"
                },
                primary,
                !primary,
            )
        })
        .collect()
}

pub fn fixture_schema(selection: &PerfFixtureSelection) -> Vec<TableMeta> {
    let spec = scenario_spec(selection);
    let table_count = if spec.kind == "schema" {
        spec.table_count.unwrap_or(1)
    } else {
        1
    };
    (1..=table_count)
        .map(|table_index| TableMeta {
            table_name: table_name(selection, table_index),
            table_comment: format!(
                "Deterministic {} fixture{}",
                selection.scenario.as_str(),
                if spec.kind == "schema" {
                    format!(" table {table_index}")
                } else {
                    String::new()
                }
            ),
            columns: fixture_columns(selection),
        })
        .collect()
}

fn fixture_row(
    selection: &PerfFixtureSelection,
    columns: &[ColumnMeta],
    row_number: usize,
) -> HashMap<String, String> {
    let spec = scenario_spec(selection);
    columns
        .iter()
        .enumerate()
        .map(|(column_index, column)| {
            let value = if spec.primary_key && column_index == 0 {
                row_number.to_string()
            } else {
                format!(
                    "{}|r{}|c{}",
                    selection.scenario.as_str(),
                    padded(row_number, 6),
                    padded(column_index, 3)
                )
            };
            (column.column_name.clone(), value)
        })
        .collect()
}

pub fn read_fixture_page(
    selection: &PerfFixtureSelection,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> TableSessionPage {
    let spec = scenario_spec(selection);
    let (page, page_size) = normalize_page_request(request);
    let start = ((page - 1) as usize).saturating_mul(page_size as usize);
    let end = start.saturating_add(page_size as usize).min(spec.row_count);
    let rows = if start < spec.row_count {
        (start + 1..=end)
            .map(|row_number| fixture_row(selection, &table.columns, row_number))
            .collect()
    } else {
        Vec::new()
    };
    TableSessionPage {
        session_id: session_id.into(),
        table_name: table.table_name.clone(),
        table_comment: table.table_comment.clone(),
        columns: table.columns.clone(),
        primary_keys: table
            .columns
            .iter()
            .filter(|column| column.is_primary_key)
            .map(|column| column.column_name.clone())
            .collect(),
        rows,
        total_rows: end as u64,
        total_rows_exact: false,
        has_more: end < spec.row_count,
        page,
        page_size,
    }
}

pub fn count_fixture_rows(
    selection: &PerfFixtureSelection,
    table: &TableMeta,
    filter: Option<&crate::types::TablePageFilter>,
) -> u64 {
    let spec = scenario_spec(selection);
    if filter.is_none_or(|filter| filter.query.trim().is_empty()) {
        return spec.row_count as u64;
    }
    (1..=spec.row_count)
        .filter(|row_number| {
            let row = fixture_row(selection, &table.columns, *row_number);
            crate::demo::row_matches_filter(&row, &table.columns, filter)
        })
        .count() as u64
}

pub fn fixture_metadata(
    selection: &PerfFixtureSelection,
    debug_assertions: bool,
    frontend_source: &str,
    uses_external_database: bool,
) -> PerfFixtureMetadata {
    PerfFixtureMetadata {
        profile: selection.profile.into(),
        version: profile().version.clone(),
        hash: fixture_hash(),
        scenario: selection.scenario.as_str().into(),
        debug_assertions,
        frontend_source: frontend_source.into(),
        uses_external_database,
    }
}

#[cfg(test)]
mod tests {
    use crate::types::TablePageRequest;

    use super::{
        count_fixture_rows, fixture_hash, fixture_metadata, fixture_schema,
        parse_fixture_selection, read_fixture_page,
    };

    #[test]
    fn release_profile_parser_accepts_only_whitelisted_profile_and_scenarios() {
        let default = parse_fixture_selection(Some("deterministic-v1"))
            .expect("default deterministic profile");
        assert_eq!(default.profile, "deterministic-v1");
        assert_eq!(default.scenario.as_str(), "smoke");

        let selected = parse_fixture_selection(Some("deterministic-v1:rows-100k-500-pk"))
            .expect("named deterministic scenario");
        assert_eq!(selected.scenario.as_str(), "rows-100k-500-pk");

        let import = parse_fixture_selection(Some("deterministic-v1:import-10k"))
            .expect("import performance scenario");
        assert_eq!(import.scenario.as_str(), "import-10k");

        for value in [
            None,
            Some(""),
            Some("  "),
            Some(" deterministic-v1"),
            Some("deterministic-v1 "),
            Some("unknown"),
            Some("deterministic-v1:unknown"),
        ] {
            assert!(
                parse_fixture_selection(value).is_none(),
                "accepted {value:?}"
            );
        }
    }

    #[test]
    fn rust_fixture_hash_matches_the_browser_canonical_profile() {
        assert_eq!(
            fixture_hash(),
            "cd30bdc95811941cd2f880ac75f6b30322bae6682e9357202dae424b6571f7d5"
        );
    }

    #[test]
    fn rust_fixture_covers_wide_large_and_no_primary_key_shapes() {
        let wide = parse_fixture_selection(Some("deterministic-v1:rows-100k-500-pk")).unwrap();
        let wide_schema = fixture_schema(&wide);
        assert_eq!(wide_schema.len(), 1);
        assert_eq!(wide_schema[0].columns.len(), 500);
        assert!(wide_schema[0].columns[0].is_primary_key);

        let no_key = parse_fixture_selection(Some("deterministic-v1:rows-100k-40-no-pk")).unwrap();
        assert!(fixture_schema(&no_key)[0]
            .columns
            .iter()
            .all(|column| !column.is_primary_key));

        let schema_selection =
            parse_fixture_selection(Some("deterministic-v1:schema-800x60")).unwrap();
        let schema = fixture_schema(&schema_selection);
        assert_eq!(schema.len(), 800);
        assert!(schema.iter().all(|table| table.columns.len() == 60));
        assert_eq!(schema[799].table_name, "perf_schema_table_0800");
    }

    #[test]
    fn rust_fixture_page_generation_is_lazy_and_matches_browser_sentinels() {
        let selection = parse_fixture_selection(Some("deterministic-v1:rows-100k-500-pk")).unwrap();
        let table = fixture_schema(&selection).remove(0);
        let page = read_fixture_page(
            &selection,
            &table,
            "fixture-session",
            &TablePageRequest {
                page: Some(2),
                page_size: Some(3),
                include_total: Some(true),
                filter: None,
                sort: None,
            },
        );

        assert_eq!(page.rows.len(), 3);
        assert_eq!(page.total_rows, 6);
        assert!(!page.total_rows_exact);
        assert_eq!(count_fixture_rows(&selection, &table, None), 100_000);
        assert_eq!(page.rows[0].get("id").map(String::as_str), Some("4"));
        assert_eq!(
            page.rows[0].get("field_001").map(String::as_str),
            Some("rows-100k-500-pk|r000004|c001")
        );
    }

    #[test]
    fn fixture_metadata_proves_release_and_external_database_boundaries() {
        let selection = parse_fixture_selection(Some("deterministic-v1:smoke")).unwrap();
        let metadata = fixture_metadata(&selection, false, "embeddedDist", false);

        assert_eq!(metadata.profile, "deterministic-v1");
        assert_eq!(metadata.version, "1.1.0");
        assert_eq!(metadata.scenario, "smoke");
        assert!(!metadata.debug_assertions);
        assert_eq!(metadata.frontend_source, "embeddedDist");
        assert!(!metadata.uses_external_database);
        assert_eq!(metadata.hash, fixture_hash());
    }
}
