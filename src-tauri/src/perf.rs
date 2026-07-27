use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::ipc::{CommandArg, CommandItem, InvokeError, InvokeResponseBody, IpcResponse};
use tauri::Runtime;

const DEFAULT_CAPACITY: usize = 4_096;
const PERF_RUN_HEADER: &str = "x-dbscout-perf-run-id";
const PERF_SPAN_HEADER: &str = "x-dbscout-perf-span-id";

fn monotonic_nanos() -> u64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    ORIGIN
        .get_or_init(Instant::now)
        .elapsed()
        .as_nanos()
        .min(u64::MAX as u128) as u64
}

fn safe_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return None;
    }
    Some(value.to_string())
}

fn safe_metadata_token(value: Option<String>) -> Option<String> {
    value.and_then(|value| safe_id(&value))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PerfPhase {
    Command,
    Pool,
    Schema,
    Database,
    Conversion,
    Audit,
    Ipc,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PerfOutcome {
    Success,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PerfStage {
    Audit,
    Convert,
    Enqueue,
    Pool,
    Query,
    Request,
    Response,
    Schema,
    Serialize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfEventDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<PerfStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_bytes: Option<u64>,
}

impl PerfEventDetails {
    pub fn stage(stage: PerfStage) -> Self {
        Self {
            stage: Some(stage),
            ..Self::default()
        }
    }

    fn merge(mut self, extra: Self) -> Self {
        if extra.stage.is_some() {
            self.stage = extra.stage;
        }
        if extra.row_count.is_some() {
            self.row_count = extra.row_count;
        }
        if extra.column_count.is_some() {
            self.column_count = extra.column_count;
        }
        if extra.batch_size.is_some() {
            self.batch_size = extra.batch_size;
        }
        if extra.payload_bytes.is_some() {
            self.payload_bytes = extra.payload_bytes;
        }
        self
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfRunMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warmup_count: Option<u64>,
}

impl PerfRunMetadata {
    fn sanitized(mut self) -> Self {
        self.scenario = safe_metadata_token(self.scenario);
        self.environment_id = safe_metadata_token(self.environment_id);
        self.profile = safe_metadata_token(self.profile);
        self.engine = safe_metadata_token(self.engine);
        self
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfRunSnapshot {
    pub run_id: String,
    pub active: bool,
    pub started_at_ms: f64,
    pub ended_at_ms: Option<f64>,
    pub metadata: PerfRunMetadata,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfEvent {
    pub run_id: String,
    pub span_id: Option<String>,
    pub parent_span_id: Option<String>,
    pub label: &'static str,
    pub phase: PerfPhase,
    pub duration_ms: f64,
    pub outcome: PerfOutcome,
    pub details: PerfEventDetails,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfSummary {
    pub count: usize,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfSnapshot {
    pub run: Option<PerfRunSnapshot>,
    pub events: Vec<PerfEvent>,
    pub dropped_events: u64,
    pub summaries: BTreeMap<&'static str, PerfSummary>,
}

#[derive(Default)]
struct RecorderState {
    generation: u64,
    run: Option<PerfRunSnapshot>,
    events: VecDeque<PerfEvent>,
    dropped_events: u64,
}

struct RecorderInner {
    enabled: AtomicBool,
    capacity: usize,
    next_span_id: AtomicU64,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    state: Mutex<RecorderState>,
}

#[derive(Clone)]
pub struct PerformanceRecorder {
    inner: Arc<RecorderInner>,
}

impl Default for PerformanceRecorder {
    fn default() -> Self {
        Self::new_disabled(DEFAULT_CAPACITY)
    }
}

impl PerformanceRecorder {
    pub fn new_disabled(capacity: usize) -> Self {
        Self::with_clock_inner(false, capacity, Arc::new(monotonic_nanos))
    }

    #[cfg(test)]
    fn with_clock(
        enabled: bool,
        capacity: usize,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self::with_clock_inner(enabled, capacity, clock)
    }

    fn with_clock_inner(
        enabled: bool,
        capacity: usize,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            inner: Arc::new(RecorderInner {
                enabled: AtomicBool::new(enabled),
                capacity,
                next_span_id: AtomicU64::new(0),
                clock,
                state: Mutex::new(RecorderState::default()),
            }),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.inner.enabled.load(Ordering::Relaxed)
    }

    pub fn enable(&self) {
        self.inner.enabled.store(true, Ordering::Release);
    }

    pub fn disable(&self) {
        self.inner.enabled.store(false, Ordering::Release);
        self.reset();
    }

    fn now(&self) -> u64 {
        (self.inner.clock)()
    }

    pub fn begin_run(
        &self,
        preferred_run_id: Option<String>,
        metadata: PerfRunMetadata,
    ) -> Option<PerfRunSnapshot> {
        if !self.is_enabled() {
            return None;
        }
        let started_at = self.now();
        let run_id = preferred_run_id
            .as_deref()
            .and_then(safe_id)
            .unwrap_or_else(|| format!("backend-run-{}", uuid::Uuid::new_v4()));
        let run = PerfRunSnapshot {
            run_id,
            active: true,
            started_at_ms: nanos_to_ms(started_at),
            ended_at_ms: None,
            metadata: metadata.sanitized(),
        };
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.run = Some(run.clone());
        state.events.clear();
        state.dropped_events = 0;
        Some(run)
    }

    pub fn begin_span<F>(
        &self,
        label: &'static str,
        phase: PerfPhase,
        context: Option<&PerfContext>,
        details: F,
    ) -> Option<PerfSpan>
    where
        F: FnOnce() -> PerfEventDetails,
    {
        if !self.is_enabled() {
            return None;
        }
        let (generation, run_id, parent_span_id) = {
            let state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let run = state.run.as_ref().filter(|run| run.active)?;
            let parent_span_id = match context {
                None => None,
                Some(context) if context.run_id.as_deref() == Some(run.run_id.as_str()) => {
                    context.parent_span_id.clone()
                }
                Some(_) => return None,
            };
            (state.generation, run.run_id.clone(), parent_span_id)
        };
        let started_at = self.now();
        let details = details();
        let sequence = self.inner.next_span_id.fetch_add(1, Ordering::Relaxed) + 1;
        Some(PerfSpan {
            recorder: self.clone(),
            generation,
            run_id: run_id.clone(),
            span_id: format!("{run_id}-backend-span-{sequence}"),
            parent_span_id,
            label,
            phase,
            started_at,
            details,
        })
    }

    pub fn record_duration<F>(
        &self,
        label: &'static str,
        phase: PerfPhase,
        duration_ms: f64,
        context: Option<&PerfContext>,
        details: F,
    ) -> bool
    where
        F: FnOnce() -> PerfEventDetails,
    {
        if !self.is_enabled() || !duration_ms.is_finite() {
            return false;
        }
        let (generation, run_id, parent_span_id) = {
            let state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(run) = state.run.as_ref().filter(|run| run.active) else {
                return false;
            };
            let parent_span_id = match context {
                None => None,
                Some(context) if context.run_id.as_deref() == Some(run.run_id.as_str()) => {
                    context.parent_span_id.clone()
                }
                Some(_) => return false,
            };
            (state.generation, run.run_id.clone(), parent_span_id)
        };
        let event = PerfEvent {
            run_id,
            span_id: None,
            parent_span_id,
            label,
            phase,
            duration_ms: duration_ms.max(0.0),
            outcome: PerfOutcome::Success,
            details: details(),
        };
        self.append_event(event, generation)
    }

    fn finish_span<F>(&self, span: PerfSpan, outcome: PerfOutcome, details: F)
    where
        F: FnOnce() -> PerfEventDetails,
    {
        if !self.is_enabled() || !self.span_is_current(span.generation, &span.run_id) {
            return;
        }
        let ended_at = self.now();
        let details = span.details.merge(details());
        if !self.span_is_current(span.generation, &span.run_id) {
            return;
        }
        self.append_event(
            PerfEvent {
                run_id: span.run_id,
                span_id: Some(span.span_id),
                parent_span_id: span.parent_span_id,
                label: span.label,
                phase: span.phase,
                duration_ms: nanos_to_ms(ended_at.saturating_sub(span.started_at)),
                outcome,
                details,
            },
            span.generation,
        );
    }

    fn span_is_current(&self, generation: u64, run_id: &str) -> bool {
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.generation == generation
            && state
                .run
                .as_ref()
                .is_some_and(|run| run.active && run.run_id == run_id)
    }

    fn append_event(&self, event: PerfEvent, expected_generation: u64) -> bool {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.generation != expected_generation
            || !state
                .run
                .as_ref()
                .is_some_and(|run| run.active && run.run_id == event.run_id)
        {
            return false;
        }
        if self.inner.capacity == 0 {
            state.dropped_events = state.dropped_events.saturating_add(1);
            return true;
        }
        if state.events.len() == self.inner.capacity {
            state.events.pop_front();
            state.dropped_events = state.dropped_events.saturating_add(1);
        }
        state.events.push_back(event);
        true
    }

    pub fn end_run(&self) -> PerfSnapshot {
        if self.is_enabled() {
            let mut state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if state.run.as_ref().is_some_and(|run| run.active) {
                let ended_at = self.now();
                if let Some(run) = state.run.as_mut() {
                    run.active = false;
                    run.ended_at_ms = Some(nanos_to_ms(ended_at));
                }
                state.generation = state.generation.wrapping_add(1);
            }
        }
        self.snapshot()
    }

    pub fn reset(&self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.run = None;
        state.events.clear();
        state.dropped_events = 0;
    }

    pub fn snapshot(&self) -> PerfSnapshot {
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let events = state.events.iter().cloned().collect::<Vec<_>>();
        PerfSnapshot {
            run: state.run.clone(),
            summaries: summarize_events(&events),
            events,
            dropped_events: state.dropped_events,
        }
    }
}

fn nanos_to_ms(nanos: u64) -> f64 {
    nanos as f64 / 1_000_000.0
}

fn summarize_events(events: &[PerfEvent]) -> BTreeMap<&'static str, PerfSummary> {
    let mut grouped = BTreeMap::<&'static str, Vec<f64>>::new();
    for event in events {
        grouped
            .entry(event.label)
            .or_default()
            .push(event.duration_ms);
    }
    grouped
        .into_iter()
        .map(|(label, mut values)| {
            values.sort_by(f64::total_cmp);
            let count = values.len();
            let summary = if count == 0 {
                PerfSummary {
                    count: 0,
                    min: None,
                    max: None,
                    mean: None,
                    p50: None,
                    p95: None,
                }
            } else {
                let percentile = |value: f64| {
                    let rank = ((count as f64 * value).ceil() as usize).max(1);
                    values.get(rank - 1).copied()
                };
                PerfSummary {
                    count,
                    min: values.first().copied(),
                    max: values.last().copied(),
                    mean: Some(values.iter().sum::<f64>() / count as f64),
                    p50: percentile(0.5),
                    p95: percentile(0.95),
                }
            };
            (label, summary)
        })
        .collect()
}

pub struct PerfSpan {
    recorder: PerformanceRecorder,
    generation: u64,
    run_id: String,
    span_id: String,
    parent_span_id: Option<String>,
    label: &'static str,
    phase: PerfPhase,
    started_at: u64,
    details: PerfEventDetails,
}

impl PerfSpan {
    pub fn finish<F>(self, outcome: PerfOutcome, details: F)
    where
        F: FnOnce() -> PerfEventDetails,
    {
        let recorder = self.recorder.clone();
        recorder.finish_span(self, outcome, details);
    }
}

#[derive(Clone, Debug, Default)]
pub struct PerfContext {
    pub run_id: Option<String>,
    pub parent_span_id: Option<String>,
}

impl PerfContext {
    pub fn new(run_id: Option<String>, parent_span_id: Option<String>) -> Self {
        Self {
            run_id: run_id.as_deref().and_then(safe_id),
            parent_span_id: parent_span_id.as_deref().and_then(safe_id),
        }
    }

    pub fn from_headers(headers: &tauri::http::HeaderMap) -> Self {
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .and_then(safe_id)
        };
        Self {
            run_id: header(PERF_RUN_HEADER),
            parent_span_id: header(PERF_SPAN_HEADER),
        }
    }
}

impl<'de, R: Runtime> CommandArg<'de, R> for PerfContext {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        Ok(Self::from_headers(command.message.headers()))
    }
}

pub fn perf_controls_allowed(debug_assertions: bool, environment_value: Option<&str>) -> bool {
    debug_assertions || environment_value == Some("1")
}

pub fn current_build_perf_controls_allowed() -> bool {
    perf_controls_allowed(
        cfg!(debug_assertions),
        std::env::var("DBSCOUT_PERF_ENABLED").ok().as_deref(),
    )
}

pub fn begin_controlled_run(
    recorder: &PerformanceRecorder,
    preferred_run_id: Option<String>,
    metadata: PerfRunMetadata,
    debug_assertions: bool,
    environment_value: Option<&str>,
) -> Result<PerfSnapshot, String> {
    if !perf_controls_allowed(debug_assertions, environment_value) {
        return Err("性能记录器在当前构建中未启用".into());
    }
    recorder.enable();
    recorder
        .begin_run(preferred_run_id, metadata)
        .ok_or_else(|| "无法启动性能记录".to_string())?;
    Ok(recorder.snapshot())
}

pub struct PerfResponse<T> {
    value: T,
    recorder: PerformanceRecorder,
    context: PerfContext,
}

impl<T> PerfResponse<T> {
    pub fn new(value: T, recorder: PerformanceRecorder, context: PerfContext) -> Self {
        Self {
            value,
            recorder,
            context,
        }
    }

    pub(crate) fn into_inner(self) -> T {
        self.value
    }
}

impl<T: Serialize> IpcResponse for PerfResponse<T> {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        let span = self.recorder.begin_span(
            "ipc.success_serialize",
            PerfPhase::Ipc,
            Some(&self.context),
            || PerfEventDetails::stage(PerfStage::Serialize),
        );
        let serialized = serde_json::to_string(&self.value).map_err(Into::<tauri::Error>::into)?;
        if let Some(span) = span {
            let payload_bytes = serialized.len() as u64;
            span.finish(PerfOutcome::Success, || PerfEventDetails {
                payload_bytes: Some(payload_bytes),
                ..PerfEventDetails::default()
            });
        }
        Ok(serialized.into())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    use serde::Serialize;
    use tauri::http::{HeaderMap, HeaderValue};
    use tauri::ipc::{InvokeResponseBody, IpcResponse};

    use super::{
        begin_controlled_run, PerfContext, PerfEventDetails, PerfOutcome, PerfPhase, PerfResponse,
        PerfRunMetadata, PerformanceRecorder,
    };

    fn incrementing_clock(calls: Arc<AtomicUsize>) -> Arc<dyn Fn() -> u64 + Send + Sync> {
        Arc::new(move || calls.fetch_add(1, Ordering::SeqCst) as u64)
    }

    #[test]
    fn bounded_capacity_keeps_newest_events_and_exact_dropped_count() {
        let recorder = PerformanceRecorder::with_clock(true, 3, Arc::new(|| 0));
        recorder.begin_run(Some("run-bounded".into()), PerfRunMetadata::default());
        for duration in [10.0, 20.0, 30.0, 40.0] {
            recorder.record_duration(
                "mysql.sql_wait",
                PerfPhase::Database,
                duration,
                None,
                PerfEventDetails::default,
            );
        }

        let snapshot = recorder.snapshot();
        assert_eq!(
            snapshot
                .events
                .iter()
                .map(|event| event.duration_ms)
                .collect::<Vec<_>>(),
            vec![20.0, 30.0, 40.0]
        );
        assert_eq!(snapshot.dropped_events, 1);
    }

    #[test]
    fn concurrent_spans_keep_explicit_parents_and_unique_ids() {
        let recorder = PerformanceRecorder::with_clock(true, 16, Arc::new(|| 10));
        let run = recorder
            .begin_run(Some("frontend-run".into()), PerfRunMetadata::default())
            .expect("enabled recorder should begin a run");
        let barrier = Arc::new(Barrier::new(3));
        let mut joins = Vec::new();

        for parent in ["frontend-span-a", "frontend-span-b"] {
            let recorder = recorder.clone();
            let barrier = barrier.clone();
            let context = PerfContext::new(Some(run.run_id.clone()), Some(parent.into()));
            joins.push(std::thread::spawn(move || {
                let span = recorder
                    .begin_span(
                        "mysql.sql_wait",
                        PerfPhase::Database,
                        Some(&context),
                        PerfEventDetails::default,
                    )
                    .expect("active run should create a span");
                barrier.wait();
                span.finish(PerfOutcome::Success, PerfEventDetails::default);
            }));
        }
        barrier.wait();
        for join in joins {
            join.join().unwrap();
        }

        let snapshot = recorder.snapshot();
        let span_ids = snapshot
            .events
            .iter()
            .map(|event| event.span_id.clone().unwrap())
            .collect::<BTreeSet<_>>();
        let parents = snapshot
            .events
            .iter()
            .map(|event| event.parent_span_id.clone().unwrap())
            .collect::<BTreeSet<_>>();
        assert_eq!(span_ids.len(), 2);
        assert_eq!(
            parents,
            BTreeSet::from(["frontend-span-a".into(), "frontend-span-b".into()])
        );
    }

    #[test]
    fn context_bound_spans_require_a_matching_run_id() {
        let clock_calls = Arc::new(AtomicUsize::new(0));
        let detail_calls = Arc::new(AtomicUsize::new(0));
        let recorder =
            PerformanceRecorder::with_clock(true, 8, incrementing_clock(clock_calls.clone()));
        recorder.begin_run(Some("active-run".into()), PerfRunMetadata::default());

        for context in [
            PerfContext::default(),
            PerfContext::new(Some("other-run".into()), Some("foreign-span".into())),
        ] {
            let detail_calls = detail_calls.clone();
            assert!(recorder
                .begin_span(
                    "uncorrelated.command",
                    PerfPhase::Command,
                    Some(&context),
                    move || {
                        detail_calls.fetch_add(1, Ordering::SeqCst);
                        PerfEventDetails::default()
                    },
                )
                .is_none());
        }

        let matching = PerfContext::new(Some("active-run".into()), Some("frontend-parent".into()));
        recorder
            .begin_span(
                "correlated.command",
                PerfPhase::Command,
                Some(&matching),
                PerfEventDetails::default,
            )
            .unwrap()
            .finish(PerfOutcome::Success, PerfEventDetails::default);

        let snapshot = recorder.snapshot();
        assert_eq!(detail_calls.load(Ordering::SeqCst), 0);
        assert_eq!(clock_calls.load(Ordering::SeqCst), 3);
        assert_eq!(snapshot.events.len(), 1);
        assert_eq!(snapshot.events[0].label, "correlated.command");
        assert_eq!(
            snapshot.events[0].parent_span_id.as_deref(),
            Some("frontend-parent")
        );
    }

    #[test]
    fn disabled_mode_never_calls_clock_or_lazy_details_and_records_nothing() {
        let clock_calls = Arc::new(AtomicUsize::new(0));
        let detail_calls = Arc::new(AtomicUsize::new(0));
        let recorder =
            PerformanceRecorder::with_clock(false, 4, incrementing_clock(clock_calls.clone()));
        assert!(recorder
            .begin_run(Some("disabled".into()), PerfRunMetadata::default())
            .is_none());
        let detail_calls_for_span = detail_calls.clone();
        assert!(recorder
            .begin_span("disabled", PerfPhase::Database, None, move || {
                detail_calls_for_span.fetch_add(1, Ordering::SeqCst);
                PerfEventDetails::default()
            })
            .is_none());
        let detail_calls_for_duration = detail_calls.clone();
        recorder.record_duration("disabled", PerfPhase::Database, 1.0, None, move || {
            detail_calls_for_duration.fetch_add(1, Ordering::SeqCst);
            PerfEventDetails::default()
        });

        assert_eq!(clock_calls.load(Ordering::SeqCst), 0);
        assert_eq!(detail_calls.load(Ordering::SeqCst), 0);
        assert!(recorder.snapshot().events.is_empty());
    }

    #[test]
    fn stale_span_after_reset_cannot_contaminate_replacement_run() {
        let recorder = PerformanceRecorder::with_clock(true, 8, Arc::new(|| 1));
        recorder.begin_run(Some("old-run".into()), PerfRunMetadata::default());
        let stale = recorder
            .begin_span("old", PerfPhase::Database, None, PerfEventDetails::default)
            .unwrap();
        recorder.reset();
        recorder.begin_run(Some("new-run".into()), PerfRunMetadata::default());
        stale.finish(PerfOutcome::Success, PerfEventDetails::default);

        let snapshot = recorder.snapshot();
        assert_eq!(snapshot.run.unwrap().run_id, "new-run");
        assert!(snapshot.events.is_empty());
    }

    #[test]
    fn owned_header_context_correlates_frontend_run_and_parent_span() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-dbscout-perf-run-id",
            HeaderValue::from_static("frontend-run-42"),
        );
        headers.insert(
            "x-dbscout-perf-span-id",
            HeaderValue::from_static("frontend-span-9"),
        );
        let context = PerfContext::from_headers(&headers);
        headers.clear();
        assert_eq!(context.run_id.as_deref(), Some("frontend-run-42"));
        assert_eq!(context.parent_span_id.as_deref(), Some("frontend-span-9"));

        let recorder = PerformanceRecorder::with_clock(true, 8, Arc::new(|| 1));
        recorder.begin_run(context.run_id.clone(), PerfRunMetadata::default());
        recorder
            .begin_span(
                "backend.child",
                PerfPhase::Command,
                Some(&context),
                PerfEventDetails::default,
            )
            .unwrap()
            .finish(PerfOutcome::Success, PerfEventDetails::default);
        let event = recorder.snapshot().events.pop().unwrap();
        assert_eq!(event.run_id, "frontend-run-42");
        assert_eq!(event.parent_span_id.as_deref(), Some("frontend-span-9"));
    }

    #[test]
    fn control_gate_requires_debug_or_exact_release_opt_in_and_does_not_self_record() {
        let recorder = PerformanceRecorder::with_clock(false, 8, Arc::new(|| 1));
        let metadata = PerfRunMetadata::default();

        assert!(begin_controlled_run(
            &recorder,
            Some("denied".into()),
            metadata.clone(),
            false,
            None,
        )
        .is_err());
        assert!(begin_controlled_run(
            &recorder,
            Some("also-denied".into()),
            metadata.clone(),
            false,
            Some("true"),
        )
        .is_err());
        assert!(begin_controlled_run(
            &recorder,
            Some("release-opt-in".into()),
            metadata.clone(),
            false,
            Some("1"),
        )
        .is_ok());
        assert!(recorder.snapshot().events.is_empty());
        recorder.disable();
        assert!(
            begin_controlled_run(&recorder, Some("debug".into()), metadata, true, None,).is_ok()
        );
        assert!(recorder.snapshot().events.is_empty());
    }

    #[derive(Clone, Debug, Serialize)]
    struct LargeResponse {
        rows: Vec<String>,
        total_rows: u64,
    }

    #[test]
    fn perf_response_preserves_json_and_records_actual_success_serialization() {
        let clock_calls = Arc::new(AtomicUsize::new(10));
        let recorder =
            PerformanceRecorder::with_clock(true, 8, incrementing_clock(clock_calls.clone()));
        recorder.begin_run(Some("serialize-run".into()), PerfRunMetadata::default());
        let context = PerfContext::new(
            Some("serialize-run".into()),
            Some("frontend-ipc-span".into()),
        );
        let value = LargeResponse {
            rows: vec!["alpha".into(), "beta".into()],
            total_rows: 2,
        };
        let expected = serde_json::to_string(&value).unwrap();

        let body = PerfResponse::new(value, recorder.clone(), context)
            .body()
            .unwrap();
        let actual = match body {
            InvokeResponseBody::Json(json) => json,
            InvokeResponseBody::Raw(_) => panic!("serialized response must remain JSON"),
        };
        assert_eq!(actual, expected);
        let snapshot = recorder.snapshot();
        assert_eq!(snapshot.events.len(), 1);
        assert_eq!(snapshot.events[0].label, "ipc.success_serialize");
        assert_eq!(
            snapshot.events[0].parent_span_id.as_deref(),
            Some("frontend-ipc-span")
        );
        assert_eq!(snapshot.events[0].outcome, PerfOutcome::Success);
        assert_eq!(
            snapshot.events[0].details.payload_bytes,
            Some(actual.len() as u64)
        );
        assert_eq!(clock_calls.load(Ordering::SeqCst), 13);
    }
}
