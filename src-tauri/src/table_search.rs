use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};

use crate::work_scheduler::WorkCancellation;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatchRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchTextMatch {
    pub matched: bool,
    pub kind: &'static str,
    pub rank: u8,
    pub score: u64,
    pub ranges: Vec<SearchMatchRange>,
}

fn empty_match() -> SearchTextMatch {
    SearchTextMatch {
        matched: false,
        kind: "none",
        rank: u8::MAX,
        score: u64::MAX,
        ranges: Vec::new(),
    }
}

fn range_match(kind: &'static str, rank: u8, start: usize, length: usize) -> SearchTextMatch {
    SearchTextMatch {
        matched: true,
        kind,
        rank,
        score: 0,
        ranges: vec![SearchMatchRange {
            start,
            end: start + length,
        }],
    }
}

fn levenshtein_distance(left: &str, right: &str) -> usize {
    let left = left.chars().collect::<Vec<_>>();
    let right = right.chars().collect::<Vec<_>>();
    if left.is_empty() {
        return right.len();
    }
    if right.is_empty() {
        return left.len();
    }
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    for (left_index, left_char) in left.iter().enumerate() {
        let mut current = Vec::with_capacity(right.len() + 1);
        current.push(left_index + 1);
        for (right_index, right_char) in right.iter().enumerate() {
            let cost = usize::from(left_char != right_char);
            current.push(
                (current[right_index] + 1)
                    .min(previous[right_index + 1] + 1)
                    .min(previous[right_index] + cost),
            );
        }
        previous = current;
    }
    previous[right.len()]
}

fn similar_match(text: &str, query: &str, raw_text_length: usize) -> Option<SearchTextMatch> {
    let distance = levenshtein_distance(text, query);
    let text_length = text.encode_utf16().count();
    let query_length = query.encode_utf16().count();
    let max_length = text_length.max(query_length);
    if max_length == 0 {
        return None;
    }
    let allowed_distance = if max_length <= 8 {
        1
    } else if max_length <= 16 {
        2
    } else {
        3
    };
    if distance > allowed_distance || distance as f64 / max_length as f64 > 0.34 {
        return None;
    }
    Some(SearchTextMatch {
        matched: true,
        kind: "similar",
        rank: 3,
        score: (distance * 100 + text_length.abs_diff(query_length)) as u64,
        ranges: vec![SearchMatchRange {
            start: 0,
            end: raw_text_length,
        }],
    })
}

fn subsequence_ranges(text: &str, query: &str) -> Vec<SearchMatchRange> {
    let haystack = text.to_lowercase().chars().collect::<Vec<_>>();
    let needle = query.to_lowercase().chars().collect::<Vec<_>>();
    let mut ranges = Vec::with_capacity(needle.len());
    let mut cursor = 0;
    for needle_char in needle {
        let Some(relative_index) = haystack[cursor..]
            .iter()
            .position(|haystack_char| *haystack_char == needle_char)
        else {
            return Vec::new();
        };
        let char_index = cursor + relative_index;
        let start = haystack[..char_index]
            .iter()
            .map(|value| value.len_utf16())
            .sum::<usize>();
        ranges.push(SearchMatchRange {
            start,
            end: start + haystack[char_index].len_utf16(),
        });
        cursor = char_index + 1;
    }
    ranges
}

pub fn match_search_text(value: &str, query: &str, mode: &str) -> SearchTextMatch {
    let raw_query = query.trim();
    if raw_query.is_empty() {
        return empty_match();
    }
    let raw_text_length = value.encode_utf16().count();
    let raw_query_length = raw_query.encode_utf16().count();
    if mode.eq_ignore_ascii_case("exact") {
        return if value == raw_query {
            range_match("exact", 0, 0, raw_text_length)
        } else {
            empty_match()
        };
    }

    let text = value.to_lowercase();
    let needle = raw_query.to_lowercase();
    if text == needle {
        return range_match("exact", 0, 0, raw_text_length);
    }
    if text.starts_with(&needle) {
        return range_match("prefix", 1, 0, raw_query_length);
    }
    if let Some(byte_index) = text.find(&needle) {
        let start = text[..byte_index].encode_utf16().count();
        return range_match("contains", 2, start, raw_query_length);
    }
    if mode.eq_ignore_ascii_case("continuous") || mode.eq_ignore_ascii_case("contains") {
        return empty_match();
    }
    if let Some(similar) = similar_match(&text, &needle, raw_text_length) {
        return similar;
    }
    let ranges = subsequence_ranges(value, raw_query);
    if ranges.is_empty() {
        return empty_match();
    }
    let first = ranges[0].start;
    let last = ranges.last().map(|range| range.end).unwrap_or(first);
    let span = last.saturating_sub(first);
    let gap = span.saturating_sub(raw_query_length);
    SearchTextMatch {
        matched: true,
        kind: "subsequence",
        rank: 4,
        score: (gap * 100 + raw_text_length.saturating_sub(raw_query_length) + first * 2) as u64,
        ranges,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScannedCellMatch {
    pub row_index: usize,
    pub source_row_index: u64,
    pub column_index: usize,
    pub column_name: String,
    pub kind: String,
    pub rank: u8,
    pub score: u64,
    pub ranges: Vec<SearchMatchRange>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchScanBatch {
    pub rows: Vec<HashMap<String, String>>,
    pub row_keys: Vec<String>,
    pub matches: Vec<ScannedCellMatch>,
    pub consumed_rows: usize,
    pub complete: bool,
}

pub struct TableSearchCursor {
    query: String,
    mode: String,
    columns: Vec<String>,
    identity_columns: Vec<String>,
    result_row_limit: usize,
    result_match_limit: usize,
    next_source_index: u64,
    complete: bool,
}

#[derive(Debug, Clone)]
pub struct TableSearchJobSpec {
    pub session_id: String,
    pub query: String,
    pub mode: String,
    pub sort: Option<crate::types::TablePageSort>,
    pub columns: Vec<String>,
    pub identity_columns: Vec<String>,
    pub result_row_limit: usize,
    pub result_match_limit: usize,
}

pub struct TableSearchJob {
    pub id: String,
    pub spec: TableSearchJobSpec,
    pub cancellation: WorkCancellation,
    pub cursor: tokio::sync::Mutex<TableSearchCursor>,
    pub run_gate: tokio::sync::Mutex<()>,
}

struct TableSearchManagerState {
    jobs: HashMap<String, Arc<TableSearchJob>>,
    job_by_session: HashMap<String, String>,
    oldest_first: VecDeque<String>,
}

pub struct TableSearchManager {
    capacity: usize,
    state: Mutex<TableSearchManagerState>,
}

impl Default for TableSearchManager {
    fn default() -> Self {
        Self::new(128)
    }
}

impl TableSearchManager {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            state: Mutex::new(TableSearchManagerState {
                jobs: HashMap::new(),
                job_by_session: HashMap::new(),
                oldest_first: VecDeque::new(),
            }),
        }
    }

    pub fn begin(&self, spec: TableSearchJobSpec) -> Arc<TableSearchJob> {
        let job = Arc::new(TableSearchJob {
            id: format!("table-search-{}", uuid::Uuid::new_v4()),
            cursor: tokio::sync::Mutex::new(TableSearchCursor::new(
                &spec.query,
                &spec.mode,
                spec.columns.clone(),
                spec.identity_columns.clone(),
                spec.result_row_limit,
                spec.result_match_limit,
            )),
            run_gate: tokio::sync::Mutex::new(()),
            cancellation: WorkCancellation::new(),
            spec,
        });
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(old_job_id) = state.job_by_session.remove(&job.spec.session_id) {
            if let Some(old_job) = state.jobs.remove(&old_job_id) {
                old_job.cancellation.cancel();
            }
            state.oldest_first.retain(|job_id| job_id != &old_job_id);
        }
        while state.jobs.len() >= self.capacity {
            let Some(oldest_id) = state.oldest_first.pop_front() else {
                break;
            };
            if let Some(oldest) = state.jobs.remove(&oldest_id) {
                state.job_by_session.remove(&oldest.spec.session_id);
                oldest.cancellation.cancel();
            }
        }
        state
            .job_by_session
            .insert(job.spec.session_id.clone(), job.id.clone());
        state.oldest_first.push_back(job.id.clone());
        state.jobs.insert(job.id.clone(), Arc::clone(&job));
        job
    }

    pub fn get(&self, job_id: &str) -> Option<Arc<TableSearchJob>> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .jobs
            .get(job_id)
            .cloned()
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(job) = state.jobs.remove(job_id) else {
            return false;
        };
        if state
            .job_by_session
            .get(&job.spec.session_id)
            .is_some_and(|current_id| current_id == job_id)
        {
            state.job_by_session.remove(&job.spec.session_id);
        }
        state.oldest_first.retain(|current_id| current_id != job_id);
        job.cancellation.cancel();
        true
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .jobs
            .len()
    }
}

impl TableSearchCursor {
    pub fn new(
        query: impl Into<String>,
        mode: impl Into<String>,
        columns: Vec<String>,
        identity_columns: Vec<String>,
        result_row_limit: usize,
        result_match_limit: usize,
    ) -> Self {
        Self {
            query: query.into(),
            mode: mode.into(),
            columns,
            identity_columns,
            result_row_limit: result_row_limit.max(1),
            result_match_limit: result_match_limit.max(1),
            next_source_index: 0,
            complete: false,
        }
    }

    pub fn scan_batch(
        &mut self,
        source_start: u64,
        rows: &[HashMap<String, String>],
        source_complete: bool,
    ) -> SearchScanBatch {
        if self.complete {
            return SearchScanBatch {
                rows: Vec::new(),
                row_keys: Vec::new(),
                matches: Vec::new(),
                consumed_rows: 0,
                complete: true,
            };
        }
        debug_assert_eq!(source_start, self.next_source_index);
        let mut result_rows = Vec::new();
        let mut row_keys = Vec::new();
        let mut matches = Vec::new();
        let mut consumed_rows = 0;
        for (source_row_offset, row) in rows.iter().enumerate() {
            let mut row_matches = Vec::new();
            let result_row_index = result_rows.len();
            for (column_index, column_name) in self.columns.iter().enumerate() {
                let matched = match_search_text(
                    row.get(column_name).map(String::as_str).unwrap_or_default(),
                    &self.query,
                    &self.mode,
                );
                if !matched.matched {
                    continue;
                }
                row_matches.push(ScannedCellMatch {
                    row_index: result_row_index,
                    source_row_index: source_start + source_row_offset as u64,
                    column_index,
                    column_name: column_name.clone(),
                    kind: matched.kind.into(),
                    rank: matched.rank,
                    score: matched.score,
                    ranges: matched.ranges,
                });
            }
            consumed_rows += 1;
            if row_matches.is_empty() {
                continue;
            }
            let row_key = self
                .identity_columns
                .iter()
                .map(|column| {
                    format!(
                        "{}={}",
                        column,
                        row.get(column).map(String::as_str).unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join("&");
            result_rows.push(row.clone());
            row_keys.push(row_key);
            matches.extend(row_matches);
            if result_rows.len() >= self.result_row_limit
                || matches.len() >= self.result_match_limit
            {
                break;
            }
        }
        self.next_source_index = source_start + consumed_rows as u64;
        self.complete = source_complete && consumed_rows == rows.len();
        SearchScanBatch {
            rows: result_rows,
            row_keys,
            matches,
            consumed_rows,
            complete: self.complete,
        }
    }

    pub fn next_source_index(&self) -> u64 {
        self.next_source_index
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde::Deserialize;

    use super::*;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        cases: Vec<FixtureCase>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureCase {
        name: String,
        query: String,
        mode: String,
        physical_page_size: usize,
        columns: Vec<String>,
        rows: Vec<HashMap<String, String>>,
        expected: Vec<FixtureMatch>,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct FixtureMatch {
        source_row_index: usize,
        column_index: usize,
        column_name: String,
        kind: String,
        rank: u8,
        score: u64,
        ranges: Vec<SearchMatchRange>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!(
            "../../src/workbench/utils/searchSemantics.fixture.json"
        ))
        .expect("search semantics fixture must be valid")
    }

    fn job_spec(session_id: &str, query: &str) -> TableSearchJobSpec {
        TableSearchJobSpec {
            session_id: session_id.into(),
            query: query.into(),
            mode: "fuzzy".into(),
            sort: None,
            columns: vec!["id".into(), "name".into()],
            identity_columns: vec!["id".into()],
            result_row_limit: 100,
            result_match_limit: 500,
        }
    }

    #[test]
    fn rust_matcher_matches_the_javascript_golden_fixture_in_table_order() {
        for case in fixture().cases {
            let mut actual = Vec::new();
            for (source_row_index, row) in case.rows.iter().enumerate() {
                for (column_index, column_name) in case.columns.iter().enumerate() {
                    let matched = match_search_text(
                        row.get(column_name).map(String::as_str).unwrap_or_default(),
                        &case.query,
                        &case.mode,
                    );
                    if !matched.matched {
                        continue;
                    }
                    actual.push(FixtureMatch {
                        source_row_index,
                        column_index,
                        column_name: column_name.clone(),
                        kind: matched.kind.into(),
                        rank: matched.rank,
                        score: matched.score,
                        ranges: matched.ranges,
                    });
                }
            }
            assert_eq!(actual, case.expected, "{}", case.name);
        }
    }

    #[test]
    fn cursor_continues_after_a_no_match_physical_page() {
        let case = fixture().cases.remove(0);
        let mut cursor = TableSearchCursor::new(
            &case.query,
            &case.mode,
            case.columns.clone(),
            vec!["id".into()],
            2,
            8,
        );
        let first = cursor.scan_batch(0, &case.rows[..case.physical_page_size], false);
        assert!(first.rows.is_empty());
        assert_eq!(first.consumed_rows, case.physical_page_size);
        assert!(!first.complete);

        let second = cursor.scan_batch(
            case.physical_page_size as u64,
            &case.rows[case.physical_page_size..],
            true,
        );
        assert_eq!(second.rows.len(), 2);
        assert_eq!(second.row_keys, ["id=3", "id=4"]);
        assert_eq!(second.matches.len(), 3);
        assert!(second.complete);
    }

    #[test]
    fn cursor_bounds_each_result_batch_without_splitting_a_source_row() {
        let rows = (0..10)
            .map(|index| {
                HashMap::from([
                    ("id".into(), index.to_string()),
                    ("left".into(), "needle".into()),
                    ("right".into(), "needle".into()),
                ])
            })
            .collect::<Vec<_>>();
        let mut cursor = TableSearchCursor::new(
            "needle",
            "fuzzy",
            vec!["id".into(), "left".into(), "right".into()],
            vec!["id".into()],
            2,
            3,
        );

        let page = cursor.scan_batch(0, &rows, false);

        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.matches.len(), 4);
        assert_eq!(page.consumed_rows, 2);
        assert!(!page.complete);
    }

    #[test]
    fn beginning_a_new_search_for_the_same_session_cancels_the_old_job() {
        let manager = TableSearchManager::new(8);
        let old = manager.begin(job_spec("session-1", "old"));

        let new = manager.begin(job_spec("session-1", "new"));

        assert!(old.cancellation.is_cancelled());
        assert!(manager.get(&old.id).is_none());
        assert!(Arc::ptr_eq(
            manager.get(&new.id).as_ref().expect("new job retained"),
            &new
        ));
        assert_eq!(manager.len(), 1);
    }

    #[tokio::test]
    async fn cancelling_a_job_wakes_inflight_work_and_removes_the_job() {
        let manager = TableSearchManager::new(8);
        let job = manager.begin(job_spec("session-1", "needle"));
        let cancellation = job.cancellation.clone();
        let waiter = tokio::spawn(async move {
            cancellation.cancelled().await;
        });

        assert!(manager.cancel(&job.id));

        tokio::time::timeout(Duration::from_millis(100), waiter)
            .await
            .expect("cancellation must wake inflight work")
            .expect("waiter must not panic");
        assert!(manager.get(&job.id).is_none());
        assert!(!manager.cancel(&job.id));
    }

    #[test]
    fn manager_evicts_and_cancels_the_oldest_job_at_capacity() {
        let manager = TableSearchManager::new(2);
        let first = manager.begin(job_spec("session-1", "one"));
        let second = manager.begin(job_spec("session-2", "two"));

        let third = manager.begin(job_spec("session-3", "three"));

        assert!(first.cancellation.is_cancelled());
        assert!(manager.get(&first.id).is_none());
        assert!(manager.get(&second.id).is_some());
        assert!(manager.get(&third.id).is_some());
        assert_eq!(manager.len(), 2);
    }
}
