//! Tiered retention & net-delta compaction for central-server audit history.
//!
//! Retention policy (evaluated on server local calendar dates, default UTC+8):
//! - Detailed (`<= 14` calendar days): every audit entry is preserved verbatim.
//! - Daily summary (`15 ..= 180` calendar days): completed days are compacted per
//!   `(server_scope, database, table_name)` into minimal net-delta rows capturing
//!   the period's initial-to-final state plus all participating actors.
//! - Monthly summary (`> 180` calendar days, permanent): completed calendar months
//!   whose end date is older than 180 days are compacted into permanent net-delta
//!   monthly summary rows.
//! - Zero net change: if all edits within a day/month cancel back to the initial
//!   state, a single lightweight `NOOP` summary row is preserved listing who
//!   touched the table during that period.
//! - Barriers (`DDL`, `RESTORE`, primary-key renames, or rows lacking primary-key
//!   identity) split a period into safe segments and are preserved intact so
//!   downstream full-table comparison and restore never cross schema changes.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, Utc};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::db::{
    parse_audit_ts_ms, DEFAULT_AUDIT_DAILY_DAYS,
    DEFAULT_AUDIT_DETAILED_DAYS, DEFAULT_TZ_OFFSET_HOURS,
};
use crate::models::{AuditSummaryActor, AuditSummaryMeta};

const REVISION_GROUP_WINDOW_MS: i64 = 2500;
const DELETE_CHUNK_SIZE: usize = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuditRetentionPolicy {
    pub detailed_days: i64,
    pub daily_days: i64,
    pub tz_offset_hours: i32,
}

impl Default for AuditRetentionPolicy {
    fn default() -> Self {
        Self {
            detailed_days: DEFAULT_AUDIT_DETAILED_DAYS,
            daily_days: DEFAULT_AUDIT_DAILY_DAYS,
            tz_offset_hours: DEFAULT_TZ_OFFSET_HOURS,
        }
    }
}

impl AuditRetentionPolicy {
    pub fn from_env() -> Self {
        let detailed_days = std::env::var("DBSCOUT_SERVER_AUDIT_DETAILED_DAYS")
            .ok()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .filter(|&v| v >= 1)
            .unwrap_or(DEFAULT_AUDIT_DETAILED_DAYS);
        let daily_days = std::env::var("DBSCOUT_SERVER_AUDIT_DAILY_DAYS")
            .ok()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .filter(|&v| v >= detailed_days)
            .unwrap_or(DEFAULT_AUDIT_DAILY_DAYS.max(detailed_days));
        let tz_offset_hours = std::env::var("DBSCOUT_SERVER_TZ_OFFSET_HOURS")
            .ok()
            .and_then(|v| v.trim().parse::<i32>().ok())
            .filter(|&v| (-12..=14).contains(&v))
            .unwrap_or(DEFAULT_TZ_OFFSET_HOURS);
        Self {
            detailed_days,
            daily_days,
            tz_offset_hours,
        }
    }

    pub fn offset(&self) -> FixedOffset {
        FixedOffset::east_opt(self.tz_offset_hours * 3600)
            .unwrap_or_else(|| FixedOffset::east_opt(DEFAULT_TZ_OFFSET_HOURS * 3600).unwrap())
    }

    /// Inclusive cutoff date: any completed calendar day `<= daily_cutoff_date`
    /// is eligible for daily compaction.
    pub fn daily_cutoff_date(&self, now_utc: DateTime<Utc>) -> NaiveDate {
        let today = now_utc.with_timezone(&self.offset()).date_naive();
        today - Duration::days(self.detailed_days)
    }

    /// Inclusive cutoff date: any completed calendar month whose last day is
    /// `<= monthly_cutoff_date` is eligible for permanent monthly compaction.
    pub fn monthly_cutoff_date(&self, now_utc: DateTime<Utc>) -> NaiveDate {
        let today = now_utc.with_timezone(&self.offset()).date_naive();
        today - Duration::days(self.daily_days)
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CompactionReport {
    pub daily_periods_compacted: usize,
    pub monthly_periods_compacted: usize,
    pub rows_removed: u64,
    pub summary_rows_written: u64,
    pub external_rows_removed: u64,
}

#[derive(Debug, Clone)]
struct RawAuditRow {
    rowid: i64,
    client_id: String,
    ts: String,
    ts_ms: i64,
    user_id: String,
    username: String,
    display_name: String,
    svn_username: Option<String>,
    connection_id: String,
    database: String,
    table_name: String,
    operation: String,
    row_identity: Option<String>,
    column_name: Option<String>,
    old_value: Option<String>,
    new_value: Option<String>,
    source: String,
    status: String,
    is_rollback: i64,
    rollback_of_client_id: Option<String>,
    host: Option<String>,
    server_key: Option<String>,
    operation_id: Option<String>,
    operation_size: Option<i64>,
    summary_kind: Option<String>,
    summary_period: Option<String>,
    summary_meta: Option<String>,
}

#[derive(Debug, Clone)]
struct CompactOutputRow {
    client_id: String,
    ts: String,
    user_id: String,
    username: String,
    svn_username: Option<String>,
    connection_id: String,
    database: String,
    table_name: String,
    operation: String,
    row_identity: Option<String>,
    column_name: Option<String>,
    old_value: Option<String>,
    new_value: Option<String>,
    source: String,
    status: String,
    is_rollback: i64,
    rollback_of_client_id: Option<String>,
    host: Option<String>,
    server_key: Option<String>,
    operation_id: Option<String>,
    operation_size: Option<i64>,
    summary_kind: String,
    summary_period: String,
    summary_meta: Option<String>,
}

fn month_last_day(year: i32, month: u32) -> NaiveDate {
    let (next_y, next_m) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(next_y, next_m, 1)
        .unwrap()
        .pred_opt()
        .unwrap()
}

fn local_date_for_ts(ts_ms: i64, offset: FixedOffset) -> Option<NaiveDate> {
    DateTime::from_timestamp_millis(ts_ms).map(|dt| dt.with_timezone(&offset).date_naive())
}

fn json_value_to_opt_string(v: &JsonValue) -> Option<String> {
    match v {
        JsonValue::Null => None,
        JsonValue::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn opt_string_to_json(v: &Option<String>) -> JsonValue {
    match v {
        None => JsonValue::Null,
        Some(s) => JsonValue::String(s.clone()),
    }
}

fn parse_json_object_map(raw: Option<&str>) -> Option<BTreeMap<String, Option<String>>> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    let val: JsonValue = serde_json::from_str(text).ok()?;
    let obj = val.as_object()?;
    let mut map = BTreeMap::new();
    for (k, v) in obj {
        map.insert(k.clone(), json_value_to_opt_string(v));
    }
    Some(map)
}

fn canonical_identity(raw: Option<&str>) -> Option<(String, BTreeMap<String, Option<String>>)> {
    let map = parse_json_object_map(raw)?;
    if map.is_empty() {
        return None;
    }
    let mut obj = JsonMap::new();
    for (k, v) in &map {
        obj.insert(k.clone(), opt_string_to_json(v));
    }
    let key = serde_json::to_string(&JsonValue::Object(obj)).ok()?;
    Some((key, map))
}

fn encode_field_map(map: &BTreeMap<String, Option<String>>) -> String {
    let mut obj = JsonMap::new();
    for (k, v) in map {
        obj.insert(k.clone(), opt_string_to_json(v));
    }
    serde_json::to_string(&JsonValue::Object(obj)).unwrap_or_else(|_| "{}".into())
}

#[derive(Debug, Clone)]
enum InitialRowState {
    Absent,
    ExistsFull(BTreeMap<String, Option<String>>),
    ExistsPartial(BTreeMap<String, Option<String>>),
}

#[derive(Debug, Clone)]
enum CurrentRowState {
    Absent,
    ExistsFull(BTreeMap<String, Option<String>>),
    ExistsPartial(BTreeMap<String, Option<String>>),
}

#[derive(Debug, Clone)]
struct TrackedRow {
    identity_json: String,
    identity_map: BTreeMap<String, Option<String>>,
    initial: InitialRowState,
    current: CurrentRowState,
}

#[derive(Debug, Default)]
struct ActorAccumulator {
    user_id: String,
    username: String,
    display_name: String,
    operation_count: u64,
    entry_count: u64,
    sources: BTreeSet<String>,
}

fn parse_update_changes(row: &RawAuditRow) -> Option<BTreeMap<String, (Option<String>, Option<String>)>> {
    if let Some(col) = row.column_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let mut map = BTreeMap::new();
        map.insert(col.to_string(), (row.old_value.clone(), row.new_value.clone()));
        return Some(map);
    }
    let old_map = parse_json_object_map(row.old_value.as_deref())?;
    let new_map = parse_json_object_map(row.new_value.as_deref())?;
    let mut keys: BTreeSet<&String> = BTreeSet::new();
    keys.extend(old_map.keys());
    keys.extend(new_map.keys());
    if keys.is_empty() {
        return None;
    }
    let mut out = BTreeMap::new();
    for k in keys {
        let old_v = old_map.get(k).cloned().flatten();
        let new_v = new_map.get(k).cloned().flatten();
        out.insert(k.clone(), (old_v, new_v));
    }
    Some(out)
}

fn update_mutates_pk(
    identity_map: &BTreeMap<String, Option<String>>,
    changes: &BTreeMap<String, (Option<String>, Option<String>)>,
) -> bool {
    let pk_lower: BTreeSet<String> = identity_map.keys().map(|k| k.to_ascii_lowercase()).collect();
    changes.iter().any(|(col, (old_v, new_v))| {
        pk_lower.contains(&col.to_ascii_lowercase()) && old_v != new_v
    })
}

fn is_barrier_row(row: &RawAuditRow) -> bool {
    let op = row.operation.trim().to_ascii_uppercase();
    if op == "NOOP" {
        return false;
    }
    if op != "INSERT" && op != "UPDATE" && op != "DELETE" {
        return true;
    }
    let Some((_, id_map)) = canonical_identity(row.row_identity.as_deref()) else {
        return true;
    };
    match op.as_str() {
        "INSERT" => parse_json_object_map(row.new_value.as_deref()).is_none(),
        "DELETE" => parse_json_object_map(row.old_value.as_deref()).is_none(),
        "UPDATE" => match parse_update_changes(row) {
            Some(changes) => update_mutates_pk(&id_map, &changes),
            None => true,
        },
        _ => true,
    }
}

fn accumulate_actors(rows: &[&RawAuditRow]) -> AuditSummaryMeta {
    let mut actors: HashMap<String, ActorAccumulator> = HashMap::new();
    let mut total_operations: u64 = 0;
    let mut total_entries: u64 = 0;
    let mut seen_summary_ops: BTreeSet<String> = BTreeSet::new();

    // Track previous raw entry to group raw burst edits without operation_id.
    let mut prev_raw: Option<(i64, String, String, i64, Option<String>)> = None;

    for row in rows {
        if let Some(meta_raw) = row.summary_meta.as_deref() {
            if let Ok(meta) = serde_json::from_str::<AuditSummaryMeta>(meta_raw) {
                let op_dedup = row
                    .operation_id
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| row.client_id.clone());
                if seen_summary_ops.insert(op_dedup) {
                    total_operations += meta.operation_count;
                    total_entries += meta.entry_count;
                    for a in meta.actors {
                        let key = if !a.username.trim().is_empty() {
                            a.username.trim().to_ascii_lowercase()
                        } else {
                            a.user_id.clone()
                        };
                        let entry = actors.entry(key).or_insert_with(|| ActorAccumulator {
                            user_id: a.user_id.clone(),
                            username: a.username.clone(),
                            display_name: if a.display_name.trim().is_empty() {
                                a.username.clone()
                            } else {
                                a.display_name.clone()
                            },
                            ..Default::default()
                        });
                        if entry.user_id.is_empty() && !a.user_id.is_empty() {
                            entry.user_id = a.user_id;
                        }
                        if entry.display_name.is_empty() && !a.display_name.is_empty() {
                            entry.display_name = a.display_name;
                        }
                        entry.operation_count += a.operation_count;
                        entry.entry_count += a.entry_count;
                        for src in a.sources {
                            if !src.trim().is_empty() && src != "summary" {
                                entry.sources.insert(src);
                            }
                        }
                    }
                }
                prev_raw = None;
                continue;
            }
        }

        let op_id = row
            .operation_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let joins_prev = match &prev_raw {
            Some((_, _, _, _, Some(prev_op))) => op_id.as_deref() == Some(prev_op.as_str()),
            Some((_, _, _, _, None)) if op_id.is_some() => false,
            Some((prev_ms, prev_user, prev_src, prev_rb, None)) => {
                *prev_user == row.user_id
                    && *prev_src == row.source
                    && *prev_rb == row.is_rollback
                    && (row.ts_ms - *prev_ms).abs() <= REVISION_GROUP_WINDOW_MS
            }
            None => false,
        };
        let is_new_op = !joins_prev;
        prev_raw = Some((
            row.ts_ms,
            row.user_id.clone(),
            row.source.clone(),
            row.is_rollback,
            op_id,
        ));

        let key = if !row.username.trim().is_empty() {
            row.username.trim().to_ascii_lowercase()
        } else {
            row.user_id.clone()
        };
        let display_name = if row.display_name.trim().is_empty() {
            row.username.clone()
        } else {
            row.display_name.clone()
        };
        let acc = actors.entry(key).or_insert_with(|| ActorAccumulator {
            user_id: row.user_id.clone(),
            username: row.username.clone(),
            display_name,
            ..Default::default()
        });
        acc.entry_count += 1;
        total_entries += 1;
        if is_new_op {
            acc.operation_count += 1;
            total_operations += 1;
        }
        let src = if row.is_rollback != 0 {
            "rollback".to_string()
        } else {
            row.source.trim().to_string()
        };
        if !src.is_empty() && src != "summary" {
            acc.sources.insert(src);
        }
    }

    let mut actor_list: Vec<AuditSummaryActor> = actors
        .into_values()
        .map(|a| AuditSummaryActor {
            user_id: a.user_id,
            username: a.username,
            display_name: a.display_name,
            operation_count: a.operation_count.max(1),
            entry_count: a.entry_count.max(1),
            sources: a.sources.into_iter().collect(),
        })
        .collect();
    actor_list.sort_by(|a, b| {
        b.operation_count
            .cmp(&a.operation_count)
            .then_with(|| b.entry_count.cmp(&a.entry_count))
            .then_with(|| a.display_name.cmp(&b.display_name))
    });

    AuditSummaryMeta {
        actors: actor_list,
        operation_count: total_operations.max(1),
        entry_count: total_entries.max(1),
        no_net_change: false,
    }
}

fn compact_dml_segment(
    segment: &[&RawAuditRow],
    summary_kind: &str,
    summary_period: &str,
    seg_index: usize,
    emit_noop_if_empty: bool,
) -> Vec<CompactOutputRow> {
    if segment.is_empty() {
        return Vec::new();
    }
    let anchor = *segment.last().unwrap();
    let mut meta = accumulate_actors(segment);

    let mut order: Vec<String> = Vec::new();
    let mut tracked: HashMap<String, TrackedRow> = HashMap::new();

    for row in segment {
        let op = row.operation.trim().to_ascii_uppercase();
        if op == "NOOP" {
            continue;
        }
        let Some((id_key, id_map)) = canonical_identity(row.row_identity.as_deref()) else {
            continue;
        };
        match op.as_str() {
            "INSERT" => {
                let Some(mut full_row) = parse_json_object_map(row.new_value.as_deref()) else {
                    continue;
                };
                for (k, v) in &id_map {
                    full_row.entry(k.clone()).or_insert_with(|| v.clone());
                }
                if let Some(existing) = tracked.get_mut(&id_key) {
                    existing.current = CurrentRowState::ExistsFull(full_row);
                } else {
                    order.push(id_key.clone());
                    tracked.insert(
                        id_key.clone(),
                        TrackedRow {
                            identity_json: id_key,
                            identity_map: id_map,
                            initial: InitialRowState::Absent,
                            current: CurrentRowState::ExistsFull(full_row),
                        },
                    );
                }
            }
            "DELETE" => {
                let Some(mut old_full) = parse_json_object_map(row.old_value.as_deref()) else {
                    continue;
                };
                for (k, v) in &id_map {
                    old_full.entry(k.clone()).or_insert_with(|| v.clone());
                }
                if let Some(existing) = tracked.get_mut(&id_key) {
                    // If this row started as ExistsPartial (earlier UPDATEs in the
                    // same period), reconstruct its true full initial row by
                    // overlaying the first before-values onto `old_full`.
                    if let InitialRowState::ExistsPartial(first_before) = &existing.initial {
                        let mut reconstructed = old_full;
                        for (col, val) in first_before {
                            reconstructed.insert(col.clone(), val.clone());
                        }
                        existing.initial = InitialRowState::ExistsFull(reconstructed);
                    }
                    existing.current = CurrentRowState::Absent;
                } else {
                    order.push(id_key.clone());
                    tracked.insert(
                        id_key.clone(),
                        TrackedRow {
                            identity_json: id_key,
                            identity_map: id_map,
                            initial: InitialRowState::ExistsFull(old_full),
                            current: CurrentRowState::Absent,
                        },
                    );
                }
            }
            "UPDATE" => {
                let Some(changes) = parse_update_changes(row) else {
                    continue;
                };
                if let Some(existing) = tracked.get_mut(&id_key) {
                    match &mut existing.current {
                        CurrentRowState::ExistsFull(cur) => {
                            for (col, (old_v, new_v)) in changes {
                                if let InitialRowState::ExistsPartial(init) = &mut existing.initial {
                                    init.entry(col.clone()).or_insert(old_v);
                                }
                                cur.insert(col, new_v);
                            }
                        }
                        CurrentRowState::ExistsPartial(cur) => {
                            for (col, (old_v, new_v)) in changes {
                                if let InitialRowState::ExistsPartial(init) = &mut existing.initial {
                                    init.entry(col.clone()).or_insert(old_v);
                                }
                                cur.insert(col, new_v);
                            }
                        }
                        CurrentRowState::Absent => {
                            let mut cur = existing.identity_map.clone();
                            for (col, (_, new_v)) in changes {
                                cur.insert(col, new_v);
                            }
                            existing.current = CurrentRowState::ExistsPartial(cur);
                        }
                    }
                } else {
                    let mut init_map = BTreeMap::new();
                    let mut cur_map = BTreeMap::new();
                    for (col, (old_v, new_v)) in changes {
                        init_map.insert(col.clone(), old_v);
                        cur_map.insert(col, new_v);
                    }
                    order.push(id_key.clone());
                    tracked.insert(
                        id_key.clone(),
                        TrackedRow {
                            identity_json: id_key,
                            identity_map: id_map,
                            initial: InitialRowState::ExistsPartial(init_map),
                            current: CurrentRowState::ExistsPartial(cur_map),
                        },
                    );
                }
            }
            _ => {}
        }
    }

    let op_id = format!(
        "summary:{}:{}:{}:{}",
        summary_kind,
        summary_period,
        seg_index,
        Uuid::new_v4().simple()
    );

    let mut deltas: Vec<(String, Option<String>, Option<String>, Option<String>, Option<String>)> =
        Vec::new();

    for id_key in order {
        let Some(row) = tracked.remove(&id_key) else {
            continue;
        };
        match (row.initial, row.current) {
            (InitialRowState::Absent, CurrentRowState::Absent) => {
                // Inserted and deleted in the same period -> net zero.
            }
            (InitialRowState::Absent, CurrentRowState::ExistsFull(after)) => {
                deltas.push((
                    "INSERT".into(),
                    Some(row.identity_json),
                    None,
                    None,
                    Some(encode_field_map(&after)),
                ));
            }
            (InitialRowState::Absent, CurrentRowState::ExistsPartial(after)) => {
                deltas.push((
                    "INSERT".into(),
                    Some(row.identity_json),
                    None,
                    None,
                    Some(encode_field_map(&after)),
                ));
            }
            (InitialRowState::ExistsFull(before), CurrentRowState::Absent) => {
                deltas.push((
                    "DELETE".into(),
                    Some(row.identity_json),
                    None,
                    Some(encode_field_map(&before)),
                    None,
                ));
            }
            (InitialRowState::ExistsPartial(before), CurrentRowState::Absent) => {
                deltas.push((
                    "DELETE".into(),
                    Some(row.identity_json),
                    None,
                    Some(encode_field_map(&before)),
                    None,
                ));
            }
            (
                InitialRowState::ExistsFull(before) | InitialRowState::ExistsPartial(before),
                CurrentRowState::ExistsFull(after) | CurrentRowState::ExistsPartial(after),
            ) => {
                let mut diff_before = BTreeMap::new();
                let mut diff_after = BTreeMap::new();
                let mut keys: BTreeSet<&String> = BTreeSet::new();
                keys.extend(before.keys());
                keys.extend(after.keys());
                for k in keys {
                    if !before.contains_key(k) || !after.contains_key(k) {
                        continue;
                    }
                    let b_val = before.get(k).cloned().flatten();
                    let a_val = after.get(k).cloned().flatten();
                    if b_val != a_val {
                        diff_before.insert(k.clone(), b_val);
                        diff_after.insert(k.clone(), a_val);
                    }
                }
                if diff_before.len() == 1 {
                    let (col, b_val) = diff_before.into_iter().next().unwrap();
                    let a_val = diff_after.remove(&col).flatten();
                    deltas.push((
                        "UPDATE".into(),
                        Some(row.identity_json),
                        Some(col),
                        b_val,
                        a_val,
                    ));
                } else if diff_before.len() > 1 {
                    deltas.push((
                        "UPDATE".into(),
                        Some(row.identity_json),
                        None,
                        Some(encode_field_map(&diff_before)),
                        Some(encode_field_map(&diff_after)),
                    ));
                }
            }
        }
    }

    if deltas.is_empty() {
        if !emit_noop_if_empty {
            return Vec::new();
        }
        meta.no_net_change = true;
        let meta_json = serde_json::to_string(&meta).ok();
        return vec![CompactOutputRow {
            client_id: format!(
                "summary:{}:{}:noop:{}",
                summary_kind,
                summary_period,
                Uuid::new_v4().simple()
            ),
            ts: anchor.ts.clone(),
            user_id: anchor.user_id.clone(),
            username: anchor.username.clone(),
            svn_username: anchor.svn_username.clone(),
            connection_id: anchor.connection_id.clone(),
            database: anchor.database.clone(),
            table_name: anchor.table_name.clone(),
            operation: "NOOP".into(),
            row_identity: None,
            column_name: None,
            old_value: None,
            new_value: None,
            source: "summary".into(),
            status: "committed".into(),
            is_rollback: 0,
            rollback_of_client_id: None,
            host: anchor.host.clone(),
            server_key: anchor.server_key.clone(),
            operation_id: Some(op_id),
            operation_size: Some(1),
            summary_kind: summary_kind.to_string(),
            summary_period: summary_period.to_string(),
            summary_meta: meta_json,
        }];
    }

    meta.no_net_change = false;
    let meta_json = serde_json::to_string(&meta).ok();
    let total = deltas.len() as i64;
    deltas
        .into_iter()
        .map(|(operation, row_identity, column_name, old_value, new_value)| CompactOutputRow {
            client_id: format!(
                "summary:{}:{}:{}",
                summary_kind,
                summary_period,
                Uuid::new_v4().simple()
            ),
            ts: anchor.ts.clone(),
            user_id: anchor.user_id.clone(),
            username: anchor.username.clone(),
            svn_username: anchor.svn_username.clone(),
            connection_id: anchor.connection_id.clone(),
            database: anchor.database.clone(),
            table_name: anchor.table_name.clone(),
            operation,
            row_identity,
            column_name,
            old_value,
            new_value,
            source: "summary".into(),
            status: "committed".into(),
            is_rollback: 0,
            rollback_of_client_id: None,
            host: anchor.host.clone(),
            server_key: anchor.server_key.clone(),
            operation_id: Some(op_id.clone()),
            operation_size: Some(total),
            summary_kind: summary_kind.to_string(),
            summary_period: summary_period.to_string(),
            summary_meta: meta_json.clone(),
        })
        .collect()
}

fn compact_period_rows(
    period_rows: &[RawAuditRow],
    summary_kind: &str,
    summary_period: &str,
) -> Vec<CompactOutputRow> {
    let committed: Vec<&RawAuditRow> = period_rows
        .iter()
        .filter(|r| matches!(r.status.as_str(), "committed" | "rolled_back"))
        .collect();
    if committed.is_empty() {
        return Vec::new();
    }

    let has_barrier = committed.iter().any(|r| is_barrier_row(r));
    let mut outputs: Vec<CompactOutputRow> = Vec::new();
    let mut current_dml: Vec<&RawAuditRow> = Vec::new();
    let mut seg_index: usize = 0;

    for row in &committed {
        if is_barrier_row(row) {
            if !current_dml.is_empty() {
                outputs.extend(compact_dml_segment(
                    &current_dml,
                    summary_kind,
                    summary_period,
                    seg_index,
                    false,
                ));
                current_dml.clear();
                seg_index += 1;
            }
            // Preserve the barrier row (DDL / RESTORE / PK-rename / missing-identity) intact
            // while tagging it with the target summary tier so compaction stays idempotent.
            let barrier_meta = accumulate_actors(&[*row]);
            let meta_json = row
                .summary_meta
                .clone()
                .or_else(|| serde_json::to_string(&barrier_meta).ok());
            outputs.push(CompactOutputRow {
                client_id: row.client_id.clone(),
                ts: row.ts.clone(),
                user_id: row.user_id.clone(),
                username: row.username.clone(),
                svn_username: row.svn_username.clone(),
                connection_id: row.connection_id.clone(),
                database: row.database.clone(),
                table_name: row.table_name.clone(),
                operation: row.operation.clone(),
                row_identity: row.row_identity.clone(),
                column_name: row.column_name.clone(),
                old_value: row.old_value.clone(),
                new_value: row.new_value.clone(),
                source: row.source.clone(),
                status: row.status.clone(),
                is_rollback: row.is_rollback,
                rollback_of_client_id: row.rollback_of_client_id.clone(),
                host: row.host.clone(),
                server_key: row.server_key.clone(),
                operation_id: row.operation_id.clone(),
                operation_size: row.operation_size,
                summary_kind: summary_kind.to_string(),
                summary_period: summary_period.to_string(),
                summary_meta: meta_json,
            });
        } else {
            current_dml.push(*row);
        }
    }

    if !current_dml.is_empty() {
        // Emit lightweight NOOP only when the entire period had no barriers and
        // zero net DML changes survived.
        let emit_noop = !has_barrier && outputs.is_empty();
        outputs.extend(compact_dml_segment(
            &current_dml,
            summary_kind,
            summary_period,
            seg_index,
            emit_noop,
        ));
    }

    // If barriers existed AND there were DML rows that all cancelled out, no NOOP
    // is needed because the barrier row already represents the period.
    outputs
}

async fn load_table_audit_rows(
    pool: &SqlitePool,
    server_scope: &str,
    db_lower: &str,
    table_lower: &str,
) -> Result<Vec<RawAuditRow>, String> {
    let rows = if server_scope.is_empty() {
        sqlx::query(
            "SELECT a.rowid, a.client_id, a.ts, a.user_id, a.username, \
                    COALESCE(u.display_name, a.username) AS display_name, \
                    a.svn_username, a.connection_id, a.database, a.table_name, \
                    a.operation, a.row_identity, a.column_name, a.old_value, a.new_value, \
                    a.source, a.status, a.is_rollback, a.rollback_of_client_id, a.host, \
                    a.server_key, a.operation_id, a.operation_size, \
                    a.summary_kind, a.summary_period, a.summary_meta \
             FROM audit_log a \
             LEFT JOIN users u ON u.id = a.user_id \
             WHERE LOWER(TRIM(a.database)) = ? \
               AND LOWER(TRIM(a.table_name)) = ? \
               AND a.status != 'mcp_pending' \
               AND a.status != 'pending' \
               AND ( \
                   a.server_key IS NULL \
                   OR TRIM(a.server_key) = '' \
                   OR LOWER(TRIM(a.server_key)) = 'mysql://configured:3306' \
               ) \
             ORDER BY a.ts ASC, a.rowid ASC",
        )
        .bind(db_lower)
        .bind(table_lower)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query(
            "SELECT a.rowid, a.client_id, a.ts, a.user_id, a.username, \
                    COALESCE(u.display_name, a.username) AS display_name, \
                    a.svn_username, a.connection_id, a.database, a.table_name, \
                    a.operation, a.row_identity, a.column_name, a.old_value, a.new_value, \
                    a.source, a.status, a.is_rollback, a.rollback_of_client_id, a.host, \
                    a.server_key, a.operation_id, a.operation_size, \
                    a.summary_kind, a.summary_period, a.summary_meta \
             FROM audit_log a \
             LEFT JOIN users u ON u.id = a.user_id \
             WHERE LOWER(TRIM(a.database)) = ? \
               AND LOWER(TRIM(a.table_name)) = ? \
               AND a.status != 'mcp_pending' \
               AND a.status != 'pending' \
               AND LOWER(TRIM(a.server_key)) = ? \
             ORDER BY a.ts ASC, a.rowid ASC",
        )
        .bind(db_lower)
        .bind(table_lower)
        .bind(server_scope)
        .fetch_all(pool)
        .await
    }
    .map_err(|e| format!("读取待归档审计记录失败: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let ts: String = r.try_get("ts").unwrap_or_default();
        let Some(ts_ms) = parse_audit_ts_ms(&ts) else {
            continue;
        };
        out.push(RawAuditRow {
            rowid: r.try_get("rowid").unwrap_or(0),
            client_id: r.try_get("client_id").unwrap_or_default(),
            ts,
            ts_ms,
            user_id: r.try_get("user_id").unwrap_or_default(),
            username: r.try_get("username").unwrap_or_default(),
            display_name: r.try_get("display_name").unwrap_or_default(),
            svn_username: r.try_get("svn_username").ok().flatten(),
            connection_id: r.try_get("connection_id").unwrap_or_default(),
            database: r.try_get("database").unwrap_or_default(),
            table_name: r.try_get("table_name").unwrap_or_default(),
            operation: r.try_get("operation").unwrap_or_default(),
            row_identity: r.try_get("row_identity").ok().flatten(),
            column_name: r.try_get("column_name").ok().flatten(),
            old_value: r.try_get("old_value").ok().flatten(),
            new_value: r.try_get("new_value").ok().flatten(),
            source: r.try_get("source").unwrap_or_default(),
            status: r.try_get("status").unwrap_or_default(),
            is_rollback: r.try_get("is_rollback").unwrap_or(0),
            rollback_of_client_id: r.try_get("rollback_of_client_id").ok().flatten(),
            host: r.try_get("host").ok().flatten(),
            server_key: r.try_get("server_key").ok().flatten(),
            operation_id: r.try_get("operation_id").ok().flatten(),
            operation_size: r.try_get("operation_size").ok().flatten(),
            summary_kind: r.try_get("summary_kind").ok().flatten(),
            summary_period: r.try_get("summary_period").ok().flatten(),
            summary_meta: r.try_get("summary_meta").ok().flatten(),
        });
    }
    Ok(out)
}

async fn replace_period_rows(
    pool: &SqlitePool,
    old_rowids: &[i64],
    new_rows: &[CompactOutputRow],
) -> Result<(u64, u64), String> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启归档事务失败: {e}"))?;

    let mut deleted: u64 = 0;
    for chunk in old_rowids.chunks(DELETE_CHUNK_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!("DELETE FROM audit_log WHERE rowid IN ({placeholders})");
        let mut q = sqlx::query(&sql);
        for rowid in chunk {
            q = q.bind(rowid);
        }
        let res = q
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("删除已归档原审计记录失败: {e}"))?;
        deleted += res.rows_affected();
    }

    let mut inserted: u64 = 0;
    for item in new_rows {
        let res = sqlx::query(
            "INSERT INTO audit_log \
             (client_id, ts, user_id, username, svn_username, connection_id, database, table_name, \
              operation, row_identity, column_name, old_value, new_value, source, status, \
              is_rollback, rollback_of_client_id, host, synced_at, server_key, operation_id, \
              operation_size, summary_kind, summary_period, summary_meta) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&item.client_id)
        .bind(&item.ts)
        .bind(&item.user_id)
        .bind(&item.username)
        .bind(&item.svn_username)
        .bind(&item.connection_id)
        .bind(&item.database)
        .bind(&item.table_name)
        .bind(&item.operation)
        .bind(&item.row_identity)
        .bind(&item.column_name)
        .bind(&item.old_value)
        .bind(&item.new_value)
        .bind(&item.source)
        .bind(&item.status)
        .bind(item.is_rollback)
        .bind(&item.rollback_of_client_id)
        .bind(&item.host)
        .bind(&now)
        .bind(&item.server_key)
        .bind(&item.operation_id)
        .bind(item.operation_size)
        .bind(&item.summary_kind)
        .bind(&item.summary_period)
        .bind(&item.summary_meta)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("写入归档总结记录失败: {e}"))?;
        inserted += res.rows_affected();
    }

    tx.commit()
        .await
        .map_err(|e| format!("提交归档事务失败: {e}"))?;
    Ok((deleted, inserted))
}

/// Compact one `(server_scope, database, table_name)` bucket according to `policy`
/// evaluated at `now_utc`.
pub async fn compact_table_audit(
    pool: &SqlitePool,
    server_scope: &str,
    db_lower: &str,
    table_lower: &str,
    policy: AuditRetentionPolicy,
    now_utc: DateTime<Utc>,
) -> Result<CompactionReport, String> {
    let mut report = CompactionReport::default();
    let offset = policy.offset();
    let daily_cutoff = policy.daily_cutoff_date(now_utc);
    let monthly_cutoff = policy.monthly_cutoff_date(now_utc);

    let rows = load_table_audit_rows(pool, server_scope, db_lower, table_lower).await?;
    if rows.is_empty() {
        return Ok(report);
    }

    // Group rows into target compaction buckets:
    // - Completed months with month_end <= monthly_cutoff => monthly summary ("YYYY-MM")
    // - Completed days with day <= daily_cutoff (and not in an eligible month) => daily summary ("YYYY-MM-DD")
    // - Everything newer => untouched detailed rows.
    let mut monthly_buckets: BTreeMap<String, Vec<RawAuditRow>> = BTreeMap::new();
    let mut daily_buckets: BTreeMap<String, Vec<RawAuditRow>> = BTreeMap::new();

    for row in rows {
        let Some(local_date) = local_date_for_ts(row.ts_ms, offset) else {
            continue;
        };
        let m_end = month_last_day(local_date.year(), local_date.month());
        if m_end <= monthly_cutoff {
            let key = format!("{:04}-{:02}", local_date.year(), local_date.month());
            monthly_buckets.entry(key).or_default().push(row);
        } else if local_date <= daily_cutoff {
            let key = local_date.format("%Y-%m-%d").to_string();
            daily_buckets.entry(key).or_default().push(row);
        }
    }

    for (day, bucket) in daily_buckets {
        let already_compacted = bucket
            .iter()
            .all(|r| r.summary_kind.as_deref() == Some("daily") && r.summary_period.as_deref() == Some(day.as_str()));
        if already_compacted {
            continue;
        }
        let old_rowids: Vec<i64> = bucket.iter().map(|r| r.rowid).collect();
        let compacted = compact_period_rows(&bucket, "daily", &day);
        let (deleted, inserted) = replace_period_rows(pool, &old_rowids, &compacted).await?;
        report.daily_periods_compacted += 1;
        report.rows_removed += deleted;
        report.summary_rows_written += inserted;
    }

    for (month, bucket) in monthly_buckets {
        let already_compacted = bucket
            .iter()
            .all(|r| r.summary_kind.as_deref() == Some("monthly") && r.summary_period.as_deref() == Some(month.as_str()));
        if already_compacted {
            continue;
        }
        let old_rowids: Vec<i64> = bucket.iter().map(|r| r.rowid).collect();
        let compacted = compact_period_rows(&bucket, "monthly", &month);
        let (deleted, inserted) = replace_period_rows(pool, &old_rowids, &compacted).await?;
        report.monthly_periods_compacted += 1;
        report.rows_removed += deleted;
        report.summary_rows_written += inserted;
    }

    Ok(report)
}

#[derive(Debug, Clone)]
struct RawExternalRow {
    rowid: i64,
    server_key: Option<String>,
    database: String,
    table_name: String,
    ts: String,
    ts_ms: i64,
    time_kind: String,
    signal: String,
    reported_by_user_id: String,
    reported_by_username: String,
    host: Option<String>,
    summary_kind: Option<String>,
    summary_period: Option<String>,
    occurrence_count: i64,
}

async fn compact_table_external_changes(
    pool: &SqlitePool,
    server_scope: &str,
    db_lower: &str,
    table_lower: &str,
    policy: AuditRetentionPolicy,
    now_utc: DateTime<Utc>,
) -> Result<u64, String> {
    let offset = policy.offset();
    let daily_cutoff = policy.daily_cutoff_date(now_utc);
    let monthly_cutoff = policy.monthly_cutoff_date(now_utc);

    let rows = if server_scope.is_empty() {
        sqlx::query(
            "SELECT rowid, event_id, server_key, database, table_name, ts, ts_ms, time_kind, \
                    signal, reported_by_user_id, reported_by_username, host, \
                    summary_kind, summary_period, occurrence_count \
             FROM table_external_changes \
             WHERE LOWER(TRIM(database)) = ? \
               AND LOWER(TRIM(table_name)) = ? \
               AND ( \
                   server_key IS NULL \
                   OR TRIM(server_key) = '' \
                   OR LOWER(TRIM(server_key)) = 'mysql://configured:3306' \
               ) \
             ORDER BY ts_ms ASC, rowid ASC",
        )
        .bind(db_lower)
        .bind(table_lower)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query(
            "SELECT rowid, event_id, server_key, database, table_name, ts, ts_ms, time_kind, \
                    signal, reported_by_user_id, reported_by_username, host, \
                    summary_kind, summary_period, occurrence_count \
             FROM table_external_changes \
             WHERE LOWER(TRIM(database)) = ? \
               AND LOWER(TRIM(table_name)) = ? \
               AND LOWER(TRIM(server_key)) = ? \
             ORDER BY ts_ms ASC, rowid ASC",
        )
        .bind(db_lower)
        .bind(table_lower)
        .bind(server_scope)
        .fetch_all(pool)
        .await
    }
    .map_err(|e| format!("读取待归档外部变动记录失败: {e}"))?;

    let mut daily_buckets: BTreeMap<String, Vec<RawExternalRow>> = BTreeMap::new();
    let mut monthly_buckets: BTreeMap<String, Vec<RawExternalRow>> = BTreeMap::new();

    for r in rows {
        let ts_ms: i64 = r.try_get("ts_ms").unwrap_or(0);
        let Some(local_date) = local_date_for_ts(ts_ms, offset) else {
            continue;
        };
        let item = RawExternalRow {
            rowid: r.try_get("rowid").unwrap_or(0),
            server_key: r.try_get("server_key").ok().flatten(),
            database: r.try_get("database").unwrap_or_default(),
            table_name: r.try_get("table_name").unwrap_or_default(),
            ts: r.try_get("ts").unwrap_or_default(),
            ts_ms,
            time_kind: r.try_get("time_kind").unwrap_or_default(),
            signal: r.try_get("signal").unwrap_or_default(),
            reported_by_user_id: r.try_get("reported_by_user_id").unwrap_or_default(),
            reported_by_username: r.try_get("reported_by_username").unwrap_or_default(),
            host: r.try_get("host").ok().flatten(),
            summary_kind: r.try_get("summary_kind").ok().flatten(),
            summary_period: r.try_get("summary_period").ok().flatten(),
            occurrence_count: r.try_get::<i64, _>("occurrence_count").unwrap_or(1).max(1),
        };
        let m_end = month_last_day(local_date.year(), local_date.month());
        if m_end <= monthly_cutoff {
            let key = format!("{:04}-{:02}", local_date.year(), local_date.month());
            monthly_buckets.entry(key).or_default().push(item);
        } else if local_date <= daily_cutoff {
            let key = local_date.format("%Y-%m-%d").to_string();
            daily_buckets.entry(key).or_default().push(item);
        }
    }

    let mut total_removed: u64 = 0;
    let now = Utc::now().to_rfc3339();

    for (kind, buckets) in [("daily", daily_buckets), ("monthly", monthly_buckets)] {
        for (period, bucket) in buckets {
            if bucket.len() == 1
                && bucket[0].summary_kind.as_deref() == Some(kind)
                && bucket[0].summary_period.as_deref() == Some(period.as_str())
            {
                continue;
            }
            let total_occ: i64 = bucket.iter().map(|r| r.occurrence_count.max(1)).sum();
            let latest = bucket.last().unwrap();
            let preferred_time_kind = if bucket.iter().any(|r| r.time_kind == "exact") {
                "exact"
            } else {
                latest.time_kind.as_str()
            };
            let old_rowids: Vec<i64> = bucket.iter().map(|r| r.rowid).collect();

            let mut tx = pool
                .begin()
                .await
                .map_err(|e| format!("开启外部变动归档事务失败: {e}"))?;
            for chunk in old_rowids.chunks(DELETE_CHUNK_SIZE) {
                let placeholders = vec!["?"; chunk.len()].join(", ");
                let sql = format!("DELETE FROM table_external_changes WHERE rowid IN ({placeholders})");
                let mut q = sqlx::query(&sql);
                for rowid in chunk {
                    q = q.bind(rowid);
                }
                q.execute(&mut *tx)
                    .await
                    .map_err(|e| format!("清理已归档外部变动失败: {e}"))?;
            }
            let new_event_id = format!(
                "ext-summary:{}:{}:{}",
                kind,
                period,
                Uuid::new_v4().simple()
            );
            sqlx::query(
                "INSERT INTO table_external_changes \
                 (event_id, server_key, database, table_name, ts, ts_ms, time_kind, signal, \
                  reported_by_user_id, reported_by_username, host, synced_at, \
                  summary_kind, summary_period, occurrence_count) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&new_event_id)
            .bind(&latest.server_key)
            .bind(&latest.database)
            .bind(&latest.table_name)
            .bind(&latest.ts)
            .bind(latest.ts_ms)
            .bind(preferred_time_kind)
            .bind(&latest.signal)
            .bind(&latest.reported_by_user_id)
            .bind(&latest.reported_by_username)
            .bind(&latest.host)
            .bind(&now)
            .bind(kind)
            .bind(&period)
            .bind(total_occ)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("写入外部变动归档失败: {e}"))?;
            tx.commit()
                .await
                .map_err(|e| format!("提交外部变动归档失败: {e}"))?;
            total_removed += (old_rowids.len().saturating_sub(1)) as u64;
        }
    }

    Ok(total_removed)
}

/// Run tiered compaction across every `(server_scope, database, table_name)` in
/// both `audit_log` and `table_external_changes`.
pub async fn compact_all_tables(
    pool: &SqlitePool,
    policy: AuditRetentionPolicy,
    now_utc: DateTime<Utc>,
) -> Result<CompactionReport, String> {
    let mut total = CompactionReport::default();

    let audit_scopes = sqlx::query(
        "SELECT DISTINCT \
             CASE \
                 WHEN server_key IS NULL OR TRIM(server_key) = '' \
                      OR LOWER(TRIM(server_key)) = 'mysql://configured:3306' \
                     THEN '' \
                 ELSE LOWER(TRIM(server_key)) \
             END AS server_scope, \
             LOWER(TRIM(database)) AS db_lower, \
             LOWER(TRIM(table_name)) AS table_lower \
         FROM audit_log",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("枚举待归档审计表失败: {e}"))?;

    for row in audit_scopes {
        let scope: String = row.try_get("server_scope").unwrap_or_default();
        let db_lower: String = row.try_get("db_lower").unwrap_or_default();
        let table_lower: String = row.try_get("table_lower").unwrap_or_default();
        let sub = compact_table_audit(pool, &scope, &db_lower, &table_lower, policy, now_utc).await?;
        total.daily_periods_compacted += sub.daily_periods_compacted;
        total.monthly_periods_compacted += sub.monthly_periods_compacted;
        total.rows_removed += sub.rows_removed;
        total.summary_rows_written += sub.summary_rows_written;
    }

    let ext_scopes = sqlx::query(
        "SELECT DISTINCT \
             CASE \
                 WHEN server_key IS NULL OR TRIM(server_key) = '' \
                      OR LOWER(TRIM(server_key)) = 'mysql://configured:3306' \
                     THEN '' \
                 ELSE LOWER(TRIM(server_key)) \
             END AS server_scope, \
             LOWER(TRIM(database)) AS db_lower, \
             LOWER(TRIM(table_name)) AS table_lower \
         FROM table_external_changes",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("枚举待归档外部变动表失败: {e}"))?;

    for row in ext_scopes {
        let scope: String = row.try_get("server_scope").unwrap_or_default();
        let db_lower: String = row.try_get("db_lower").unwrap_or_default();
        let table_lower: String = row.try_get("table_lower").unwrap_or_default();
        total.external_rows_removed += compact_table_external_changes(
            pool,
            &scope,
            &db_lower,
            &table_lower,
            policy,
            now_utc,
        )
        .await?;
    }

    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{connect, insert_user};

    async fn seed_row(
        pool: &SqlitePool,
        client_id: &str,
        ts: &str,
        user_id: &str,
        username: &str,
        op: &str,
        row_identity: Option<&str>,
        column_name: Option<&str>,
        old_value: Option<&str>,
        new_value: Option<&str>,
        source: &str,
        operation_id: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO audit_log \
             (client_id, ts, user_id, username, connection_id, database, table_name, \
              operation, row_identity, column_name, old_value, new_value, source, status, \
              is_rollback, synced_at, server_key, operation_id, operation_size) \
             VALUES (?, ?, ?, ?, 'mysql-1', 'newsg_4cfg', 'heroprop', ?, ?, ?, ?, ?, ?, 'committed', 0, ?, 'mysql://192.168.1.243:8306', ?, 1)",
        )
        .bind(client_id)
        .bind(ts)
        .bind(user_id)
        .bind(username)
        .bind(op)
        .bind(row_identity)
        .bind(column_name)
        .bind(old_value)
        .bind(new_value)
        .bind(source)
        .bind(ts)
        .bind(operation_id)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn tiered_compaction_keeps_14d_detailed_folds_daily_net_delta_and_monthly_permanently() {
        let pool = connect("sqlite::memory:").await.unwrap();
        insert_user(&pool, "u1", "zhangsan", "张三", "t1", "2026-01-01T00:00:00Z")
            .await
            .unwrap();
        insert_user(&pool, "u2", "lisi", "李四", "t2", "2026-01-01T00:00:00Z")
            .await
            .unwrap();

        // Today (UTC+8): 2026-11-27
        let now_utc = DateTime::parse_from_rfc3339("2026-11-27T02:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let policy = AuditRetentionPolicy::default();

        // 1) Recent (within 14d: 2026-11-20) -> must remain detailed verbatim.
        seed_row(
            &pool,
            "recent-1",
            "2026-11-20T02:00:00Z",
            "u1",
            "zhangsan",
            "UPDATE",
            Some(r#"{"ID":"1001"}"#),
            Some("Atk"),
            Some("100"),
            Some("110"),
            "grid",
            Some("op-r1"),
        )
        .await;
        seed_row(
            &pool,
            "recent-2",
            "2026-11-20T03:00:00Z",
            "u2",
            "lisi",
            "UPDATE",
            Some(r#"{"ID":"1001"}"#),
            Some("Atk"),
            Some("110"),
            Some("120"),
            "grid",
            Some("op-r2"),
        )
        .await;

        // 2) Daily window (2026-11-01, 26 days ago):
        //    - Row 1001 Atk: 100 -> 120 (张三) -> 150 (李四) => net 100 -> 150
        //    - Row 1002 inserted then updated => net INSERT with final value
        //    - Row 1003 inserted then deleted => net cancelled!
        //    - Row 1004 updated then deleted => net DELETE with initial pre-update value!
        seed_row(
            &pool,
            "d1",
            "2026-11-01T02:00:00Z",
            "u1",
            "zhangsan",
            "UPDATE",
            Some(r#"{"ID":"1001"}"#),
            Some("Atk"),
            Some("100"),
            Some("120"),
            "grid",
            Some("op-d1"),
        )
        .await;
        seed_row(
            &pool,
            "d2",
            "2026-11-01T05:00:00Z",
            "u2",
            "lisi",
            "UPDATE",
            Some(r#"{"ID":"1001"}"#),
            Some("Atk"),
            Some("120"),
            Some("150"),
            "import",
            Some("op-d2"),
        )
        .await;
        seed_row(
            &pool,
            "d3",
            "2026-11-01T03:00:00Z",
            "u1",
            "zhangsan",
            "INSERT",
            Some(r#"{"ID":"1002"}"#),
            None,
            None,
            Some(r#"{"ID":"1002","Atk":"50"}"#),
            "grid",
            Some("op-d3"),
        )
        .await;
        seed_row(
            &pool,
            "d4",
            "2026-11-01T04:00:00Z",
            "u1",
            "zhangsan",
            "UPDATE",
            Some(r#"{"ID":"1002"}"#),
            Some("Atk"),
            Some("50"),
            Some("80"),
            "grid",
            Some("op-d4"),
        )
        .await;
        seed_row(
            &pool,
            "d5",
            "2026-11-01T04:10:00Z",
            "u2",
            "lisi",
            "INSERT",
            Some(r#"{"ID":"1003"}"#),
            None,
            None,
            Some(r#"{"ID":"1003","Atk":"10"}"#),
            "grid",
            Some("op-d5"),
        )
        .await;
        seed_row(
            &pool,
            "d6",
            "2026-11-01T04:20:00Z",
            "u2",
            "lisi",
            "DELETE",
            Some(r#"{"ID":"1003"}"#),
            None,
            Some(r#"{"ID":"1003","Atk":"10"}"#),
            None,
            "grid",
            Some("op-d6"),
        )
        .await;
        seed_row(
            &pool,
            "d7",
            "2026-11-01T04:30:00Z",
            "u1",
            "zhangsan",
            "UPDATE",
            Some(r#"{"ID":"1004"}"#),
            Some("Atk"),
            Some("200"),
            Some("250"),
            "grid",
            Some("op-d7"),
        )
        .await;
        seed_row(
            &pool,
            "d8",
            "2026-11-01T04:40:00Z",
            "u2",
            "lisi",
            "DELETE",
            Some(r#"{"ID":"1004"}"#),
            None,
            Some(r#"{"ID":"1004","Atk":"250","Name":"Old"}"#),
            None,
            "grid",
            Some("op-d8"),
        )
        .await;

        // 3) Daily window zero-net-change day (2026-10-20): 100 -> 200 -> 100 => lightweight NOOP!
        seed_row(
            &pool,
            "z1",
            "2026-10-20T02:00:00Z",
            "u1",
            "zhangsan",
            "UPDATE",
            Some(r#"{"ID":"1001"}"#),
            Some("Atk"),
            Some("100"),
            Some("200"),
            "grid",
            Some("op-z1"),
        )
        .await;
        seed_row(
            &pool,
            "z2",
            "2026-10-20T03:00:00Z",
            "u2",
            "lisi",
            "UPDATE",
            Some(r#"{"ID":"1001"}"#),
            Some("Atk"),
            Some("200"),
            Some("100"),
            "grid",
            Some("op-z2"),
        )
        .await;

        // 4) Monthly window (>180 days ago: 2026-04-05 and 2026-04-18) -> permanent monthly summary!
        seed_row(
            &pool,
            "m1",
            "2026-04-05T02:00:00Z",
            "u1",
            "zhangsan",
            "UPDATE",
            Some(r#"{"ID":"1001"}"#),
            Some("Atk"),
            Some("10"),
            Some("40"),
            "grid",
            Some("op-m1"),
        )
        .await;
        seed_row(
            &pool,
            "m2",
            "2026-04-18T06:00:00Z",
            "u2",
            "lisi",
            "UPDATE",
            Some(r#"{"ID":"1001"}"#),
            Some("Atk"),
            Some("40"),
            Some("99"),
            "grid",
            Some("op-m2"),
        )
        .await;

        let report = compact_all_tables(&pool, policy, now_utc).await.unwrap();
        assert_eq!(report.daily_periods_compacted, 2);
        assert_eq!(report.monthly_periods_compacted, 1);

        // Verify idempotency on second run
        let second = compact_all_tables(&pool, policy, now_utc).await.unwrap();
        assert_eq!(second.daily_periods_compacted, 0);
        assert_eq!(second.monthly_periods_compacted, 0);

        let all = load_table_audit_rows(&pool, "mysql://192.168.1.243:8306", "newsg_4cfg", "heroprop")
            .await
            .unwrap();

        // Recent 2 rows untouched
        let recent: Vec<_> = all.iter().filter(|r| r.summary_kind.is_none()).collect();
        assert_eq!(recent.len(), 2);

        // Daily 2026-11-01: 3 net rows (1001 UPDATE 100->150, 1002 INSERT Atk=80, 1004 DELETE Atk=200)
        let nov1: Vec<_> = all
            .iter()
            .filter(|r| r.summary_period.as_deref() == Some("2026-11-01"))
            .collect();
        assert_eq!(nov1.len(), 3);
        let r1001 = nov1
            .iter()
            .find(|r| r.row_identity.as_deref() == Some(r#"{"ID":"1001"}"#))
            .unwrap();
        assert_eq!(r1001.operation, "UPDATE");
        assert_eq!(r1001.column_name.as_deref(), Some("Atk"));
        assert_eq!(r1001.old_value.as_deref(), Some("100"));
        assert_eq!(r1001.new_value.as_deref(), Some("150"));
        let meta: AuditSummaryMeta =
            serde_json::from_str(r1001.summary_meta.as_deref().unwrap()).unwrap();
        assert!(!meta.no_net_change);
        assert_eq!(meta.actors.len(), 2);

        let r1002 = nov1
            .iter()
            .find(|r| r.row_identity.as_deref() == Some(r#"{"ID":"1002"}"#))
            .unwrap();
        assert_eq!(r1002.operation, "INSERT");
        assert!(r1002.new_value.as_deref().unwrap().contains("\"Atk\":\"80\""));

        let r1004 = nov1
            .iter()
            .find(|r| r.row_identity.as_deref() == Some(r#"{"ID":"1004"}"#))
            .unwrap();
        assert_eq!(r1004.operation, "DELETE");
        assert!(r1004.old_value.as_deref().unwrap().contains("\"Atk\":\"200\""));
        assert!(r1004.old_value.as_deref().unwrap().contains("\"Name\":\"Old\""));

        // Daily 2026-10-20: 1 lightweight NOOP with both actors
        let oct20: Vec<_> = all
            .iter()
            .filter(|r| r.summary_period.as_deref() == Some("2026-10-20"))
            .collect();
        assert_eq!(oct20.len(), 1);
        assert_eq!(oct20[0].operation, "NOOP");
        let noop_meta: AuditSummaryMeta =
            serde_json::from_str(oct20[0].summary_meta.as_deref().unwrap()).unwrap();
        assert!(noop_meta.no_net_change);
        assert_eq!(noop_meta.actors.len(), 2);

        // Monthly 2026-04: 1 net row 10 -> 99
        let apr: Vec<_> = all
            .iter()
            .filter(|r| r.summary_period.as_deref() == Some("2026-04"))
            .collect();
        assert_eq!(apr.len(), 1);
        assert_eq!(apr[0].summary_kind.as_deref(), Some("monthly"));
        assert_eq!(apr[0].old_value.as_deref(), Some("10"));
        assert_eq!(apr[0].new_value.as_deref(), Some("99"));
    }

    #[tokio::test]
    async fn ddl_barrier_splits_period_without_corrupting_dml_segments() {
        let pool = connect("sqlite::memory:").await.unwrap();
        insert_user(&pool, "u1", "zhangsan", "张三", "t1", "2026-01-01T00:00:00Z")
            .await
            .unwrap();
        let now_utc = DateTime::parse_from_rfc3339("2026-11-27T02:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        seed_row(
            &pool,
            "b1",
            "2026-11-01T01:00:00Z",
            "u1",
            "zhangsan",
            "UPDATE",
            Some(r#"{"ID":"1"}"#),
            Some("Atk"),
            Some("10"),
            Some("20"),
            "grid",
            Some("op-1"),
        )
        .await;
        seed_row(
            &pool,
            "b2",
            "2026-11-01T02:00:00Z",
            "u1",
            "zhangsan",
            "DDL",
            None,
            None,
            None,
            Some("ALTER TABLE heroprop ADD COLUMN Crit INT"),
            "ddl",
            Some("op-ddl"),
        )
        .await;
        seed_row(
            &pool,
            "b3",
            "2026-11-01T03:00:00Z",
            "u1",
            "zhangsan",
            "UPDATE",
            Some(r#"{"ID":"1"}"#),
            Some("Atk"),
            Some("20"),
            Some("30"),
            "grid",
            Some("op-3"),
        )
        .await;

        let report = compact_all_tables(&pool, AuditRetentionPolicy::default(), now_utc)
            .await
            .unwrap();
        assert_eq!(report.daily_periods_compacted, 1);

        let all = load_table_audit_rows(&pool, "mysql://192.168.1.243:8306", "newsg_4cfg", "heroprop")
            .await
            .unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].operation, "UPDATE");
        assert_eq!(all[0].old_value.as_deref(), Some("10"));
        assert_eq!(all[0].new_value.as_deref(), Some("20"));
        assert_eq!(all[1].operation, "DDL");
        assert_eq!(all[1].summary_kind.as_deref(), Some("daily"));
        assert_eq!(all[2].operation, "UPDATE");
        assert_eq!(all[2].old_value.as_deref(), Some("20"));
        assert_eq!(all[2].new_value.as_deref(), Some("30"));
    }
}
