//! Merges comment, code and format evidence into relations and decides each
//! relation's review status.
//!
//! Review rules: a relation found in a comment, in client code, or in the data
//! is confirmed immediately. Agreement between a comment and the code is
//! recorded so later edits can be compared; disagreement still asks for
//! review. A confirmed relation asks for review again only when the code
//! usages it relied on change or disappear, so unrelated code edits never
//! disturb anyone.
//! Confirming a comment over disagreeing code settles the conflict until code
//! starts reading the column from another table in a new place.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use super::catalog::DbSnapshot;
use super::code_scan::CodeScanReport;
use super::comments;
use super::formats::TableFormats;
use super::parser::ReferenceParser;
use super::model::{
    CoverageGap, Evidence, RelationKey, RelationKind, RelationStatus, RelationView, StatusReason,
    StatusTotals, TableCoverage, UntracedSample,
};
use super::store::{Decision, ServerRecord, Verdict};

const UNTRACED_SAMPLE_LIMIT: usize = 5;

#[derive(Debug, Clone)]
pub enum CodeState {
    NoClient,
    ClientMissing,
    Pending,
    Failed(String),
    Ready(Arc<CodeScanReport>),
}

impl CodeState {
    fn report(&self) -> Option<&CodeScanReport> {
        match self {
            Self::Ready(report) => Some(report),
            _ => None,
        }
    }
}

pub struct Inputs<'a> {
    pub snapshot: &'a DbSnapshot,
    pub code: &'a CodeState,
    /// Lowercase table name -> list-format columns found in its data.
    pub formats: &'a BTreeMap<String, TableFormats>,
    pub formats_pending: bool,
    pub record: Option<&'a ServerRecord>,
    pub now: &'a str,
}

#[derive(Debug, Default)]
struct Candidate {
    comments: Vec<String>,
    code: Vec<Evidence>,
    fingerprints: BTreeSet<String>,
    format: Option<String>,
    parser: Option<ReferenceParser>,
    encoded: bool,
    rule: Option<String>,
    source_constraints: Vec<super::constraints::RowConstraint>,
}

impl Candidate {
    fn evidence(&self) -> Vec<Evidence> {
        let mut evidence = self
            .comments
            .iter()
            .map(|text| Evidence::Comment { text: text.clone() })
            .collect::<Vec<_>>();
        evidence.extend(self.code.iter().cloned());
        if let Some(text) = &self.rule { evidence.push(Evidence::Rule { text: text.clone() }); }
        if let Some(sample) = &self.format {
            evidence.push(Evidence::Format {
                sample: sample.clone(),
            });
        }
        evidence
    }
}

fn same_source(left: &RelationKey, right: &RelationKey) -> bool {
    left.source_table == right.source_table
        && left.source_column.eq_ignore_ascii_case(&right.source_column)
}

fn push_unique(list: &mut Vec<String>, text: &str) {
    if !list.iter().any(|existing| existing == text) {
        list.push(text.to_string());
    }
}

type DirectiveMap = BTreeMap<(String, String), (String, String, comments::CommentDirective)>;

fn collect_comment_directives(snapshot: &DbSnapshot) -> DirectiveMap {
    let mut directives = DirectiveMap::new();
    for (table_name, table) in &snapshot.tables {
        for column in &table.columns {
            let directive = comments::parse_directive(&column.comment, snapshot);
            if directive != comments::CommentDirective::None {
                directives.insert(
                    (table_name.clone(), column.name.to_lowercase()),
                    (column.name.clone(), column.comment.trim().to_string(), directive),
                );
            }
        }
    }
    directives
}

fn gather(inputs: &Inputs<'_>, directives: &DirectiveMap) -> BTreeMap<RelationKey, Candidate> {
    let mut candidates: BTreeMap<RelationKey, Candidate> = BTreeMap::new();
    let mut profiles = inputs.formats.clone();
    // Metadata-declared formats work on first paint, before background sampling.
    for (name, table) in &inputs.snapshot.tables {
        profiles.entry(name.clone()).or_insert_with(|| {
            let mut profile = TableFormats::default();
            for column in table.columns.iter().filter(|column| column.is_text()) {
                if !table.primary_keys.contains(&column.name) {
                    profile.inspect(column, &[], inputs.snapshot);
                    super::project_formats::inspect(name, column, &[], inputs.snapshot, &mut profile);
                }
            }
            profile
        });
    }
    let mut list_columns = HashSet::new();
    for (table, profile) in &profiles {
        for finding in &profile.findings {
            if finding.kind == RelationKind::List {
                list_columns.insert((table.clone(), finding.column.to_lowercase()));
            }
            let key = RelationKey {
                source_table: table.clone(),
                source_column: finding.column.clone(),
                target_table: finding.target_table.clone(),
                target_column: finding.target_column.clone(),
                kind: finding.kind,
            };
            let candidate = candidates.entry(key).or_default();
            candidate.format = (!finding.sample.is_empty()).then(|| finding.sample.clone());
            candidate.parser = finding.parser.clone();
            candidate.encoded = profile.replaced.contains(&finding.column.to_lowercase());
            if profile.replaced.contains(&finding.column.to_lowercase()) || finding.sample.is_empty() {
                if let Some(column) = inputs.snapshot.table(table).and_then(|table| table.column(&finding.column)) {
                    push_unique(&mut candidate.comments, &column.comment);
                }
            }
        }
    }
    if let Some(report) = inputs.code.report() {
        for relation in &report.relations {
            let (Some(source_column), Some(target_column)) = (
                inputs
                    .snapshot
                    .column_name(&relation.source_table, &relation.source_column),
                inputs
                    .snapshot
                    .column_name(&relation.target_table, &relation.target_column),
            ) else {
                continue;
            };
            let profile = profiles.get(&relation.source_table.to_lowercase());
            let replacement = profile.is_some_and(|profile| profile.replaced.contains(&source_column.to_lowercase()));
            let found = candidates.keys().find(|key| {
                key.source_table.eq_ignore_ascii_case(&relation.source_table)
                    && key.source_column.eq_ignore_ascii_case(source_column)
                    && key.target_table.eq_ignore_ascii_case(&relation.target_table)
                    && key.target_column.eq_ignore_ascii_case(target_column)
            }).cloned();
            if replacement && found.is_none() {
                continue;
            }
            let key = found.unwrap_or_else(|| RelationKey {
                source_table: relation.source_table.to_lowercase(),
                source_column: source_column.to_string(),
                target_table: relation.target_table.to_lowercase(),
                target_column: target_column.to_string(),
                kind: if list_columns.contains(&(relation.source_table.to_lowercase(), source_column.to_lowercase())) {
                    RelationKind::List
                } else { RelationKind::Value },
            });
            let candidate = candidates.entry(key).or_default();
            if candidate.fingerprints.insert(relation.fingerprint.clone()) {
                candidate.code.push(Evidence::Code {
                    file: relation.location.file.clone(),
                    line: relation.location.line,
                    snippet: relation.location.snippet.clone(),
                    fingerprint: relation.fingerprint.clone(),
                });
            }
        }
    }
    let mut commented_sources = HashSet::new();
    for (table_name, table) in &inputs.snapshot.tables {
        for column in &table.columns {
            let text = column.comment.trim();
            if profiles.get(table_name).is_some_and(|profile| profile.replaced.contains(&column.name.to_lowercase())) {
                continue;
            }
            let kind = if list_columns.contains(&(table_name.clone(), column.name.to_lowercase())) {
                RelationKind::List
            } else {
                RelationKind::Value
            };
            for mention in comments::parse(text, table_name, &column.name, inputs.snapshot) {
                let Some(target) = inputs.snapshot.table(&mention.target_table) else {
                    continue;
                };
                commented_sources.insert((table_name.clone(), column.name.to_lowercase()));
                if mention.target_column.is_none() && kind == RelationKind::Value {
                    // A bare table name agrees with whichever key the code uses.
                    let matching = candidates
                        .iter()
                        .filter(|(key, candidate)| {
                            key.source_table == *table_name
                                && key.source_column.eq_ignore_ascii_case(&column.name)
                                && key.target_table == mention.target_table
                                && key.kind == RelationKind::Value
                                && !candidate.code.is_empty()
                        })
                        .map(|(key, _)| key.clone())
                        .collect::<Vec<_>>();
                    if !matching.is_empty() {
                        for key in matching {
                            if let Some(candidate) = candidates.get_mut(&key) {
                                push_unique(&mut candidate.comments, text);
                            }
                        }
                        continue;
                    }
                }
                let Some(target_column) = mention
                    .target_column
                    .clone()
                    .or_else(|| target.key_column().map(str::to_string))
                else {
                    continue;
                };
                let key = RelationKey {
                    source_table: table_name.clone(),
                    source_column: column.name.clone(),
                    target_table: mention.target_table.clone(),
                    target_column,
                    kind,
                };
                push_unique(&mut candidates.entry(key).or_default().comments, text);
            }
        }
    }
    // A comment naming another target overrides the generic list convention.
    candidates.retain(|key, candidate| {
        let format_only = candidate.format.is_some() && candidate.comments.is_empty() && candidate.code.is_empty();
        !(format_only
            && commented_sources.contains(&(key.source_table.clone(), key.source_column.to_lowercase())))
    });
    for (key, candidate) in &mut candidates {
        if candidate.parser.is_none() {
            candidate.parser = profiles.get(&key.source_table)
                .and_then(|profile| profile.columns.get(&key.source_column.to_lowercase())).cloned();
        }
    }
    if super::project_formats::matches_schema(inputs.snapshot) {
        candidates.retain(|key, _| !super::project_relations::suppressed(key));
        for rule in super::project_relations::rules(inputs.snapshot) {
            let comment = inputs.snapshot.table(&rule.key.source_table)
                .and_then(|table| table.column(&rule.key.source_column)).map(|column| column.comment.as_str());
            let candidate = candidates.entry(rule.key).or_default();
            if let Some(comment) = comment.filter(|comment| !comment.is_empty()) {
                push_unique(&mut candidate.comments, comment);
            }
            candidate.rule = Some(rule.note);
            if rule.parser.is_some() {
                candidate.parser = rule.parser;
            }
            candidate.source_constraints = rule.constraints;
            candidate.encoded = true;
        }
    }
    if !directives.is_empty() {
        let mut preserved_code: HashMap<(String, String, String, String), (Vec<Evidence>, BTreeSet<String>)> = HashMap::new();
        for (key, candidate) in &candidates {
            let source_id = (key.source_table.clone(), key.source_column.to_lowercase());
            if directives.contains_key(&source_id) && !candidate.code.is_empty() {
                let endpoint = (
                    source_id.0,
                    source_id.1,
                    key.target_table.clone(),
                    key.target_column.to_lowercase(),
                );
                let entry = preserved_code.entry(endpoint).or_default();
                for item in &candidate.code {
                    if !entry.0.contains(item) {
                        entry.0.push(item.clone());
                    }
                }
                entry.1.extend(candidate.fingerprints.iter().cloned());
            }
        }
        candidates.retain(|key, _| {
            !directives.contains_key(&(key.source_table.clone(), key.source_column.to_lowercase()))
        });
        for ((source_table, source_col_lower), (source_column, comment_text, directive)) in directives {
            let comments::CommentDirective::Relations(relations) = directive else {
                continue;
            };
            for rel in relations {
                let key = RelationKey {
                    source_table: source_table.clone(),
                    source_column: source_column.clone(),
                    target_table: rel.target_table.clone(),
                    target_column: rel.target_column.clone(),
                    kind: rel.kind,
                };
                let mut candidate = Candidate {
                    comments: vec![comment_text.clone()],
                    encoded: true,
                    parser: rel.parser.clone().or_else(|| {
                        (rel.kind == RelationKind::List)
                            .then(|| {
                                profiles
                                    .get(source_table)
                                    .and_then(|profile| profile.columns.get(source_col_lower))
                                    .filter(|parser| !matches!(parser, ReferenceParser::Unsupported))
                                    .cloned()
                            })
                            .flatten()
                    }),
                    ..Candidate::default()
                };
                let endpoint = (
                    source_table.clone(),
                    source_col_lower.clone(),
                    rel.target_table.clone(),
                    rel.target_column.to_lowercase(),
                );
                if let Some((code, fingerprints)) = preserved_code.get(&endpoint) {
                    candidate.code = code.clone();
                    candidate.fingerprints = fingerprints.clone();
                }
                candidates.insert(key, candidate);
            }
        }
    }
    candidates
}

/// Code that reads the source column of a comment relation from another
/// table while nothing in the code supports the comment's own target.
struct Disagreement {
    /// The first `table.column` the code reads instead.
    target: String,
    fingerprints: BTreeSet<String>,
}

fn disagreement(
    key: &RelationKey,
    candidate: &Candidate,
    candidates: &BTreeMap<RelationKey, Candidate>,
) -> Option<Disagreement> {
    if candidate.comments.is_empty() || !candidate.code.is_empty() || candidate.encoded {
        return None;
    }
    let mut found: Option<Disagreement> = None;
    for (other, other_candidate) in candidates {
        if other == key || !same_source(other, key) || other_candidate.code.is_empty() {
            continue;
        }
        found
            .get_or_insert_with(|| Disagreement {
                target: format!("{}.{}", other.target_table, other.target_column),
                fingerprints: BTreeSet::new(),
            })
            .fingerprints
            .extend(other_candidate.fingerprints.iter().cloned());
    }
    found
}

struct Verdicts<'a> {
    code_ready: bool,
    baseline: Option<&'a BTreeSet<String>>,
    now: &'a str,
    updates: Vec<(String, Decision)>,
}

impl Verdicts<'_> {
    fn view(
        &mut self,
        key: &RelationKey,
        candidate: &Candidate,
        decision: Option<&Decision>,
        disagreement: Option<Disagreement>,
    ) -> RelationView {
        let id = key.id();
        let has_comment = !candidate.comments.is_empty();
        let has_code = !candidate.code.is_empty();
        let agrees = has_comment && has_code;
        let decision = decision.filter(|decision| {
            // New code usages reopen a rejected relation.
            !(decision.verdict == Verdict::Rejected
                && self.code_ready
                && !candidate.fingerprints.is_subset(&decision.code_fingerprints))
        });
        let (status, reason) = match decision {
            Some(decision) if decision.verdict == Verdict::Rejected => {
                (RelationStatus::Rejected, StatusReason::Rejected)
            }
            Some(decision) => {
                let lost = !decision.code_fingerprints.is_subset(&candidate.fingerprints);
                let unseen_disagreement = disagreement
                    .as_ref()
                    .is_some_and(|found| !found.fingerprints.is_subset(&decision.overridden_code));
                if agrees {
                    if decision.code_fingerprints != candidate.fingerprints {
                        self.record(&id, key, candidate, decision.auto);
                    }
                    (RelationStatus::Confirmed, StatusReason::MatchesCode)
                } else if self.code_ready && lost {
                    let reason = if has_code {
                        StatusReason::CodeChanged
                    } else {
                        StatusReason::CodeRemoved
                    };
                    (RelationStatus::Stale, reason)
                } else if self.code_ready && unseen_disagreement {
                    (RelationStatus::Conflict, StatusReason::CommentConflict)
                } else if decision.auto {
                    (RelationStatus::Confirmed, StatusReason::MatchesCode)
                } else {
                    (RelationStatus::Confirmed, StatusReason::Manual)
                }
            }
            None if candidate.rule.is_some() => (RelationStatus::Confirmed, StatusReason::ProjectRule),
            None if disagreement.is_some() => (RelationStatus::Conflict, StatusReason::CommentConflict),
            None if agrees => {
                self.record(&id, key, candidate, true);
                (RelationStatus::Confirmed, StatusReason::MatchesCode)
            }
            None if has_code => (RelationStatus::Confirmed, StatusReason::CodeOnly),
            None if has_comment && self.code_ready => (RelationStatus::Confirmed, StatusReason::CommentOnly),
            None if has_comment => (RelationStatus::Confirmed, StatusReason::CommentWithoutClient),
            None => (RelationStatus::Confirmed, StatusReason::FormatOnly),
        };
        let is_new = status == RelationStatus::Unconfirmed
            && self.baseline.is_some_and(|baseline| !baseline.contains(&id));
        let (code_target, disagreeing_code) = match disagreement {
            Some(found) => (
                (status == RelationStatus::Conflict).then_some(found.target),
                found.fingerprints,
            ),
            None => (None, BTreeSet::new()),
        };
        RelationView {
            id,
            key: key.clone(),
            parser: candidate.parser.clone(),
            source_constraints: candidate.source_constraints.clone(),
            status,
            reason,
            is_new,
            evidence: candidate.evidence(),
            code_target,
            decided_at: decision.map(|decision| decision.decided_at.clone()),
            disagreeing_code,
        }
    }

    fn record(&mut self, id: &str, key: &RelationKey, candidate: &Candidate, auto: bool) {
        self.updates.push((
            id.to_string(),
            Decision {
                verdict: Verdict::Confirmed,
                auto,
                code_fingerprints: candidate.fingerprints.clone(),
                overridden_code: BTreeSet::new(),
                relation: key.clone(),
                decided_at: self.now.to_string(),
            },
        ));
    }

    /// A confirmed relation that no current evidence supports. It stays
    /// visible; it only needs review once the code it relied on is known to be
    /// gone or its columns no longer exist.
    fn orphan(&self, id: &str, decision: &Decision, snapshot: &DbSnapshot) -> Option<RelationView> {
        if decision.verdict != Verdict::Confirmed {
            return None;
        }
        let key = &decision.relation;
        // Decisions are shared by every database on the server; skip other games' tables.
        snapshot.table(&key.source_table)?;
        snapshot.table(&key.target_table)?;
        let columns_gone = snapshot.column_name(&key.source_table, &key.source_column).is_none()
            || snapshot.column_name(&key.target_table, &key.target_column).is_none();
        let (status, reason) = if columns_gone {
            (RelationStatus::Stale, StatusReason::EvidenceGone)
        } else if self.code_ready && !decision.code_fingerprints.is_empty() {
            (RelationStatus::Stale, StatusReason::CodeRemoved)
        } else if decision.auto {
            (RelationStatus::Confirmed, StatusReason::MatchesCode)
        } else {
            (RelationStatus::Confirmed, StatusReason::Manual)
        };
        Some(RelationView {
            id: id.to_string(),
            key: key.clone(),
            parser: None,
            source_constraints: Vec::new(),
            status,
            reason,
            is_new: false,
            evidence: Vec::new(),
            code_target: None,
            decided_at: Some(decision.decided_at.clone()),
            disagreeing_code: BTreeSet::new(),
        })
    }
}

#[derive(Debug)]
pub struct RelationIndex {
    relations: Vec<RelationView>,
    by_source: HashMap<String, Vec<usize>>,
    by_target: HashMap<String, Vec<usize>>,
    untraced: HashMap<String, (usize, Vec<UntracedSample>)>,
    unsupported_fields: HashMap<String, Vec<String>>,
    used_tables: Option<BTreeSet<String>>,
    code_gap: Option<CoverageGap>,
    formats_pending: bool,
    pub totals: StatusTotals,
    /// Decisions the tool made or refreshed; the caller persists them.
    pub decision_updates: Vec<(String, Decision)>,
    /// Every relation id currently supported by evidence.
    pub relation_ids: BTreeSet<String>,
}

pub fn assemble(inputs: &Inputs<'_>) -> RelationIndex {
    let directives = collect_comment_directives(inputs.snapshot);
    let candidates = gather(inputs, &directives);
    let empty = BTreeMap::new();
    let decisions = inputs.record.map(|record| &record.decisions).unwrap_or(&empty);
    let mut verdicts = Verdicts {
        code_ready: inputs.code.report().is_some(),
        baseline: inputs.record.and_then(|record| record.baseline.as_ref()),
        now: inputs.now,
        updates: Vec::new(),
    };
    let mut relations = Vec::with_capacity(candidates.len());
    let mut relation_ids = BTreeSet::new();
    for (key, candidate) in &candidates {
        let id = key.id();
        let found = disagreement(key, candidate, &candidates);
        let decision = decisions.get(&id).or_else(|| decisions.values().find(|decision| {
            let old = &decision.relation;
            same_source(key, old) && key.target_table == old.target_table
                && key.target_column.eq_ignore_ascii_case(&old.target_column)
        }));
        relations.push(verdicts.view(key, candidate, decision, found));
        relation_ids.insert(id);
    }
    for (id, decision) in decisions {
        if relation_ids.contains(id) {
            continue;
        }
        let source = &decision.relation;
        if directives.contains_key(&(source.source_table.clone(), source.source_column.to_lowercase())) {
            continue;
        }
        if super::project_formats::matches_schema(inputs.snapshot) && super::project_relations::suppressed(source) {
            if decision.auto { continue; }
            if let Some(mut view) = verdicts.orphan(id, decision, inputs.snapshot) {
                view.parser = Some(ReferenceParser::Unsupported);
                view.status = RelationStatus::Stale;
                view.reason = StatusReason::EvidenceGone;
                relations.push(view);
            }
            continue;
        }
        let replaced = inputs.formats.get(&source.source_table)
            .is_some_and(|profile| profile.replaced.contains(&source.source_column.to_lowercase()))
            || inputs.snapshot.table(&source.source_table)
                .and_then(|table| table.column(&source.source_column))
                .is_some_and(|column| super::formats::condition_column(column, inputs.snapshot));
        let same_target = candidates.keys().any(|key| same_source(key, source)
            && key.target_table == source.target_table && key.target_column.eq_ignore_ascii_case(&source.target_column));
        if same_target || (decision.auto && replaced) {
            continue;
        }
        if let Some(mut view) = verdicts.orphan(id, decision, inputs.snapshot) {
            view.parser = if replaced {
                // Preserve manual history without continuing an obsolete
                // literal lookup of a newly understood encoded expression.
                Some(ReferenceParser::Unsupported)
            } else {
                inputs.formats.get(&source.source_table)
                    .and_then(|profile| profile.columns.get(&source.source_column.to_lowercase())).cloned()
            };
            relations.push(view);
        }
    }

    let mut index = RelationIndex {
        by_source: HashMap::new(),
        by_target: HashMap::new(),
        untraced: HashMap::new(),
        unsupported_fields: HashMap::new(),
        used_tables: inputs.code.report().map(|report| report.used_tables.clone()),
        code_gap: match inputs.code {
            CodeState::NoClient => Some(CoverageGap::NoClient),
            CodeState::ClientMissing => Some(CoverageGap::ClientMissing),
            CodeState::Pending => Some(CoverageGap::Analyzing),
            CodeState::Failed(message) => Some(CoverageGap::ScanFailed {
                message: message.clone(),
            }),
            CodeState::Ready(_) => None,
        },
        formats_pending: inputs.formats_pending,
        totals: StatusTotals::default(),
        decision_updates: verdicts.updates,
        relation_ids,
        relations,
    };
    for (position, view) in index.relations.iter().enumerate() {
        index.totals.add(view);
        index
            .by_source
            .entry(view.key.source_table.clone())
            .or_default()
            .push(position);
        index
            .by_target
            .entry(view.key.target_table.clone())
            .or_default()
            .push(position);
    }
    for (name, table) in &inputs.snapshot.tables {
        let mut columns = Vec::new();
        let unsupported_relations = index.outgoing(name).into_iter()
            .filter(|view| view.parser == Some(ReferenceParser::Unsupported))
            .map(|view| view.key.source_column.to_lowercase()).collect::<HashSet<_>>();
        for column in &table.columns {
            let col_lower = column.name.to_lowercase();
            let has_directive = directives.contains_key(&(name.clone(), col_lower.clone()));
            let unsupported = (!has_directive
                && (column.name.to_ascii_lowercase().ends_with("func")
                    || inputs.formats.get(name).and_then(|profile| profile.columns.get(&col_lower))
                        == Some(&ReferenceParser::Unsupported)))
                || unsupported_relations.contains(&col_lower);
            if unsupported { columns.push(column.name.clone()); }
        }
        if !columns.is_empty() { index.unsupported_fields.insert(name.clone(), columns); }
    }
    if let Some(report) = inputs.code.report() {
        for lookup in &report.untraced {
            let entry = index
                .untraced
                .entry(lookup.target_table.to_lowercase())
                .or_insert_with(|| (0, Vec::new()));
            entry.0 += 1;
            if entry.1.len() < UNTRACED_SAMPLE_LIMIT {
                entry.1.push(UntracedSample {
                    file: lookup.location.file.clone(),
                    line: lookup.location.line,
                    snippet: lookup.location.snippet.clone(),
                });
            }
        }
    }
    index
}

impl RelationIndex {
    pub fn overlay(&mut self, views: Vec<RelationView>) {
        for view in views {
            if view.parser == Some(ReferenceParser::Unsupported) {
                let columns = self.unsupported_fields.entry(view.key.source_table.clone()).or_default();
                if !columns.contains(&view.key.source_column) { columns.push(view.key.source_column.clone()); }
            }
            self.relations.retain(|existing| !super::assisted_rules::same_endpoints(&existing.key, &view.key));
            self.relations.push(view);
        }
        self.relation_ids = self.relations.iter().map(|view| view.id.clone()).collect();
        self.by_source.clear();
        self.by_target.clear();
        self.totals = StatusTotals::default();
        for (position, view) in self.relations.iter().enumerate() {
            self.by_source.entry(view.key.source_table.clone()).or_default().push(position);
            self.by_target.entry(view.key.target_table.clone()).or_default().push(position);
            self.totals.add(view);
        }
    }

    fn collect(&self, positions: Option<&Vec<usize>>) -> Vec<RelationView> {
        positions
            .map(|positions| positions.iter().map(|position| self.relations[*position].clone()).collect())
            .unwrap_or_default()
    }

    pub fn outgoing(&self, table: &str) -> Vec<RelationView> {
        self.collect(self.by_source.get(&table.to_lowercase()))
    }

    pub fn incoming(&self, table: &str) -> Vec<RelationView> {
        self.collect(self.by_target.get(&table.to_lowercase()))
    }

    pub fn all(&self) -> &[RelationView] {
        &self.relations
    }

    pub fn find(&self, id: &str) -> Option<&RelationView> {
        self.relations.iter().find(|view| view.id == id)
    }

    /// Relations a person still has to look at: stale and conflicting ones.
    /// Newly found relations are already confirmed.
    pub fn open_items(&self) -> Vec<RelationView> {
        self.relations
            .iter()
            .filter(|view| view.status.needs_review())
            .cloned()
            .collect()
    }

    pub fn coverage(&self, table: &str) -> TableCoverage {
        let table = table.to_lowercase();
        let mut gaps = Vec::new();
        if let Some(gap) = &self.code_gap {
            gaps.push(gap.clone());
        }
        if let Some(used) = &self.used_tables {
            if !used.contains(&table) {
                gaps.push(CoverageGap::NotUsedByClient);
            }
        }
        if let Some((count, samples)) = self.untraced.get(&table) {
            gaps.push(CoverageGap::UntracedLookups {
                count: *count,
                samples: samples.clone(),
            });
        }
        if self.formats_pending && !gaps.iter().any(|gap| matches!(gap, CoverageGap::Analyzing)) {
            gaps.push(CoverageGap::Analyzing);
        }
        if let Some(columns) = self.unsupported_fields.get(&table) {
            gaps.push(CoverageGap::UnsupportedFields { columns: columns.clone() });
        }
        TableCoverage {
            complete: gaps.is_empty(),
            gaps,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_relations::catalog::test_support::{snapshot, table};
    use crate::config_relations::code_scan::{CodeLocation, CodeRelation, UntracedLookup};

    fn db() -> DbSnapshot {
        snapshot(vec![
            table("goodsprop", &[("ID", "int", "", true), ("Name", "varchar", "", false)]),
            table("heroprop", &[("ID", "int", "", true)]),
            table(
                "rewardprop",
                &[
                    ("ID", "int", "", true),
                    ("ItemID", "int", "物品ID，对应goodsprop", false),
                    ("HeroID", "int", "", false),
                    ("Items", "text", "", false),
                    ("Target", "int", "对应 heroprop 表", false),
                ],
            ),
        ])
    }

    #[test]
    fn function_only_tables_do_not_claim_complete_relation_coverage() {
        let snapshot = snapshot(vec![table("dynamicprop", &[("RewardFunc", "text", "", false)])]);
        let code = CodeState::Ready(Arc::new(CodeScanReport {
            used_tables: BTreeSet::from(["dynamicprop".into()]), ..CodeScanReport::default()
        }));
        let index = assemble(&Inputs { snapshot: &snapshot, code: &code, formats: &BTreeMap::new(),
            formats_pending: false, record: None, now: "test" });
        let coverage = index.coverage("dynamicprop");
        assert!(!coverage.complete);
        assert!(matches!(&coverage.gaps[0], CoverageGap::UnsupportedFields { columns } if columns == &["RewardFunc"]));
    }

    fn code(source: (&str, &str), target: (&str, &str), fingerprint: &str) -> CodeRelation {
        CodeRelation {
            source_table: source.0.into(),
            source_column: source.1.into(),
            target_table: target.0.into(),
            target_column: target.1.into(),
            location: CodeLocation {
                file: "src/a.ts".into(),
                line: 3,
                snippet: "lookup()".into(),
            },
            fingerprint: fingerprint.into(),
        }
    }

    fn report(relations: Vec<CodeRelation>) -> CodeState {
        CodeState::Ready(Arc::new(CodeScanReport {
            used_tables: ["goodsprop", "rewardprop"].iter().map(|t| t.to_string()).collect(),
            relations,
            untraced: vec![UntracedLookup {
                target_table: "goodsprop".into(),
                target_column: "ID".into(),
                location: CodeLocation {
                    file: "src/b.ts".into(),
                    line: 9,
                    snippet: "lookup(id)".into(),
                },
            }],
            files_scanned: 2,
            files_reparsed: 2,
        }))
    }

    fn goods_formats() -> BTreeMap<String, TableFormats> {
        BTreeMap::from([(
            "rewardprop".to_string(),
            TableFormats { findings: vec![super::super::formats::FormatFinding {
                column: "Items".into(),
                target_table: "goodsprop".into(),
                target_column: "ID".into(),
                sample: r#"[{"ID":1,"Num":2}]"#.into(),
                kind: RelationKind::List,
                parser: None,
            }], ..TableFormats::default() },
        )])
    }

    fn assemble_with(code: &CodeState, record: Option<&ServerRecord>) -> RelationIndex {
        let snapshot = db();
        let formats = goods_formats();
        assemble(&Inputs {
            snapshot: &snapshot,
            code,
            formats: &formats,
            formats_pending: false,
            record,
            now: "2024-05-01 10:00",
        })
    }

    fn status_of(index: &RelationIndex, id: &str) -> (RelationStatus, StatusReason) {
        let view = index.find(id).unwrap_or_else(|| panic!("missing {id}"));
        (view.status, view.reason)
    }

    #[test]
    fn without_client_comments_and_formats_are_confirmed() {
        let index = assemble_with(&CodeState::NoClient, None);
        assert_eq!(
            status_of(&index, "rewardprop.itemid>goodsprop.id"),
            (RelationStatus::Confirmed, StatusReason::CommentWithoutClient)
        );
        assert_eq!(
            status_of(&index, "rewardprop.items[]>goodsprop.id"),
            (RelationStatus::Confirmed, StatusReason::FormatOnly)
        );
        let coverage = index.coverage("goodsprop");
        assert!(!coverage.complete);
        assert!(matches!(coverage.gaps[0], CoverageGap::NoClient));
        assert_eq!(index.incoming("goodsprop").len(), 2);
        assert_eq!(index.outgoing("rewardprop").len(), 3);
    }

    #[test]
    fn assisted_overlay_replaces_matching_endpoints_and_keeps_unrelated_edges() {
        let mut index = assemble_with(&CodeState::NoClient,None);
        let mut view = index.find("rewardprop.itemid>goodsprop.id").unwrap().clone();
        view.parser = Some(ReferenceParser::Unsupported);
        view.status = RelationStatus::Stale;
        view.key.kind = RelationKind::List;
        view.id = view.key.id();
        index.overlay(vec![view]);
        assert!(index.find("rewardprop.itemid>goodsprop.id").is_none());
        assert!(index.find("rewardprop.itemid[]>goodsprop.id").is_some());
        assert_eq!(index.incoming("goodsprop").len(),2);
        assert!(index.coverage("rewardprop").gaps.iter().any(|gap| matches!(gap,CoverageGap::UnsupportedFields { .. })));
    }

    #[test]
    fn comment_and_code_agreement_confirms_automatically() {
        let code = report(vec![code(("rewardprop", "itemid"), ("goodsprop", "id"), "f1")]);
        let index = assemble_with(&code, None);
        assert_eq!(
            status_of(&index, "rewardprop.itemid>goodsprop.id"),
            (RelationStatus::Confirmed, StatusReason::MatchesCode)
        );
        let (id, decision) = &index.decision_updates[0];
        assert_eq!(id, "rewardprop.itemid>goodsprop.id");
        assert!(decision.auto);
        assert_eq!(decision.code_fingerprints, BTreeSet::from(["f1".to_string()]));
        assert_eq!(
            status_of(&index, "rewardprop.target>heroprop.id"),
            (RelationStatus::Confirmed, StatusReason::CommentOnly)
        );
        let view = index.find("rewardprop.itemid>goodsprop.id").unwrap();
        assert_eq!(view.evidence.len(), 2, "comment + code evidence");
    }

    #[test]
    fn comment_that_disagrees_with_code_needs_review() {
        let code = report(vec![code(("rewardprop", "Target"), ("goodsprop", "ID"), "f2")]);
        let index = assemble_with(&code, None);
        let view = index.find("rewardprop.target>heroprop.id").unwrap();
        assert_eq!(view.status, RelationStatus::Conflict);
        assert_eq!(view.code_target.as_deref(), Some("goodsprop.ID"));
        assert_eq!(
            status_of(&index, "rewardprop.target>goodsprop.id"),
            (RelationStatus::Confirmed, StatusReason::CodeOnly)
        );
        assert_eq!(index.totals.needs_review(), 1);
    }

    fn confirmed(id_key: RelationKey, fingerprints: &[&str], auto: bool) -> ServerRecord {
        let mut record = ServerRecord::default();
        record.decisions.insert(
            id_key.id(),
            Decision {
                verdict: Verdict::Confirmed,
                auto,
                code_fingerprints: fingerprints.iter().map(|value| value.to_string()).collect(),
                overridden_code: BTreeSet::new(),
                relation: id_key,
                decided_at: "2024-04-01 09:00".into(),
            },
        );
        record
    }

    fn hero_key() -> RelationKey {
        RelationKey {
            source_table: "rewardprop".into(),
            source_column: "HeroID".into(),
            target_table: "heroprop".into(),
            target_column: "ID".into(),
            kind: RelationKind::Value,
        }
    }

    #[test]
    fn changing_a_scalar_to_a_list_preserves_manual_verdict_without_duplicate_orphans() {
        let old = RelationKey {
            source_table: "rewardprop".into(), source_column: "Items".into(),
            target_table: "goodsprop".into(), target_column: "ID".into(), kind: RelationKind::Value,
        };
        let mut record = confirmed(old.clone(), &[], false);
        for verdict in [Verdict::Confirmed, Verdict::Rejected] {
            record.decisions.get_mut(&old.id()).unwrap().verdict = verdict;
            let index = assemble_with(&report(Vec::new()), Some(&record));
            assert!(index.find(&old.id()).is_none());
            let current = index.find("rewardprop.items[]>goodsprop.id").unwrap();
            assert_eq!(current.decided_at.as_deref(), Some("2024-04-01 09:00"));
            assert_eq!(current.status, if verdict == Verdict::Rejected {
                RelationStatus::Rejected
            } else { RelationStatus::Confirmed });
        }
    }

    #[test]
    fn obsolete_manual_encoded_target_stays_visible_but_is_not_looked_up_literally() {
        let mut formats = goods_formats();
        formats.get_mut("rewardprop").unwrap().replaced.insert("items".into());
        let old = RelationKey {
            source_table: "rewardprop".into(), source_column: "Items".into(),
            target_table: "heroprop".into(), target_column: "ID".into(), kind: RelationKind::Value,
        };
        let snapshot = db();
        let record = confirmed(old.clone(), &[], false);
        let index = assemble(&Inputs {
            snapshot: &snapshot, code: &CodeState::NoClient, formats: &formats,
            formats_pending: false, record: Some(&record), now: "test",
        });
        let view = index.find(&old.id()).unwrap();
        assert_eq!(view.parser, Some(ReferenceParser::Unsupported));
        assert_eq!(view.decided_at.as_deref(), Some("2024-04-01 09:00"));
    }

    #[test]
    fn confirmed_code_relations_go_stale_only_when_their_code_changes() {
        let record = confirmed(hero_key(), &["h1"], false);
        let same = report(vec![code(("rewardprop", "HeroID"), ("heroprop", "ID"), "h1")]);
        assert_eq!(
            status_of(&assemble_with(&same, Some(&record)), "rewardprop.heroid>heroprop.id"),
            (RelationStatus::Confirmed, StatusReason::Manual)
        );
        let extra = report(vec![
            code(("rewardprop", "HeroID"), ("heroprop", "ID"), "h1"),
            code(("rewardprop", "HeroID"), ("heroprop", "ID"), "h3"),
        ]);
        assert_eq!(
            status_of(&assemble_with(&extra, Some(&record)), "rewardprop.heroid>heroprop.id").0,
            RelationStatus::Confirmed,
            "an additional usage is not a reason to bother anyone"
        );
        let changed = report(vec![code(("rewardprop", "HeroID"), ("heroprop", "ID"), "h2")]);
        assert_eq!(
            status_of(&assemble_with(&changed, Some(&record)), "rewardprop.heroid>heroprop.id"),
            (RelationStatus::Stale, StatusReason::CodeChanged)
        );
        let removed = report(Vec::new());
        assert_eq!(
            status_of(&assemble_with(&removed, Some(&record)), "rewardprop.heroid>heroprop.id"),
            (RelationStatus::Stale, StatusReason::CodeRemoved)
        );
        assert_eq!(
            status_of(&assemble_with(&CodeState::Pending, Some(&record)), "rewardprop.heroid>heroprop.id").0,
            RelationStatus::Confirmed,
            "staleness is only judged after the code has been read"
        );
    }

    #[test]
    fn confirming_a_comment_over_disagreeing_code_holds_until_new_disagreeing_code() {
        let key = RelationKey {
            source_table: "rewardprop".into(),
            source_column: "Target".into(),
            target_table: "heroprop".into(),
            target_column: "ID".into(),
            kind: RelationKind::Value,
        };
        let disagreeing = report(vec![code(("rewardprop", "Target"), ("goodsprop", "ID"), "f2")]);
        let seen = assemble_with(&disagreeing, None)
            .find(&key.id())
            .map(|view| view.disagreeing_code.clone())
            .unwrap();
        assert_eq!(seen, BTreeSet::from(["f2".to_string()]));

        let mut record = confirmed(key.clone(), &[], false);
        record.decisions.get_mut(&key.id()).unwrap().overridden_code = seen;
        let settled = assemble_with(&disagreeing, Some(&record));
        assert_eq!(status_of(&settled, &key.id()), (RelationStatus::Confirmed, StatusReason::Manual));
        assert!(settled.find(&key.id()).unwrap().code_target.is_none());
        assert_eq!(settled.totals.needs_review(), 0, "the confirmation clears the reminder");

        let more = report(vec![
            code(("rewardprop", "Target"), ("goodsprop", "ID"), "f2"),
            code(("rewardprop", "Target"), ("goodsprop", "ID"), "f3"),
        ]);
        let reopened = assemble_with(&more, Some(&record));
        assert_eq!(status_of(&reopened, &key.id()), (RelationStatus::Conflict, StatusReason::CommentConflict));
        assert_eq!(reopened.find(&key.id()).unwrap().code_target.as_deref(), Some("goodsprop.ID"));
    }

    #[test]
    fn rejected_relations_stay_hidden_until_new_code_appears() {
        let mut record = confirmed(hero_key(), &["h1"], false);
        record.decisions.values_mut().for_each(|decision| decision.verdict = Verdict::Rejected);
        record.baseline = Some(BTreeSet::new());
        let same = report(vec![code(("rewardprop", "HeroID"), ("heroprop", "ID"), "h1")]);
        assert_eq!(
            status_of(&assemble_with(&same, Some(&record)), "rewardprop.heroid>heroprop.id").0,
            RelationStatus::Rejected
        );
        let more = report(vec![code(("rewardprop", "HeroID"), ("heroprop", "ID"), "h9")]);
        let index = assemble_with(&more, Some(&record));
        let view = index.find("rewardprop.heroid>heroprop.id").unwrap();
        assert_eq!(view.status, RelationStatus::Confirmed);
        assert_eq!(view.reason, StatusReason::CodeOnly);
        assert!(!view.is_new);
    }

    #[test]
    fn relations_after_the_baseline_are_new() {
        let mut record = ServerRecord::default();
        record.baseline = Some(BTreeSet::from(["rewardprop.items[]>goodsprop.id".to_string()]));
        let code = report(vec![code(("rewardprop", "HeroID"), ("heroprop", "ID"), "h1")]);
        let index = assemble_with(&code, Some(&record));
        let hero = index.find("rewardprop.heroid>heroprop.id").unwrap();
        assert_eq!(hero.status, RelationStatus::Confirmed);
        assert!(!hero.is_new, "a newly found relation is confirmed, not queued for review");
        assert!(!index.find("rewardprop.items[]>goodsprop.id").unwrap().is_new);
        assert_eq!(index.totals.new_unconfirmed, 0);
        assert_eq!(index.totals.needs_review(), 0, "new relations never raise the review badge");
    }

    #[test]
    fn coverage_lists_untraced_lookups_and_unused_tables() {
        let index = assemble_with(&report(Vec::new()), None);
        let goods = index.coverage("goodsprop");
        assert!(matches!(goods.gaps.as_slice(), [CoverageGap::UntracedLookups { count: 1, .. }]));
        let heroes = index.coverage("heroprop");
        assert!(matches!(heroes.gaps.as_slice(), [CoverageGap::NotUsedByClient]));
        assert!(index.coverage("rewardprop").complete);
    }

    #[test]
    fn explicit_comment_directives_override_fuzzy_code_formats_and_orphans() {
        let db = snapshot(vec![
            table("goodsprop", &[("ID", "int", "", true), ("Name", "varchar", "", false)]),
            table("heroprop", &[("ID", "int", "", true), ("Quality", "int", "", false)]),
            table(
                "unionhelpqualityprop",
                &[
                    ("Lvl", "int", "", true),
                    (
                        "MaxUnitQuality",
                        "tinyint",
                        "引用 heroprop.Quality；可选范围为 goodsprop.ID [枚举: 1=N, 2=R, 5=UR]",
                        false,
                    ),
                    (
                        "NeedHelpNums",
                        "json",
                        "下标对应 heroprop.Quality-1 [数组位: N魂石数量, R魂石数量, SR魂石数量]",
                        false,
                    ),
                    ("PlainNum", "int", "对应 heroprop.ID [无关联]", false),
                    ("ForceGoods", "int", "原本写了 heroprop.ID [关联: goodsprop.ID]", false),
                    ("ForceList", "json", "道具列表 [列表关联: goodsprop.ID @ ID]", false),
                ],
            ),
        ]);
        let code_report = report(vec![
            code(("unionhelpqualityprop", "MaxUnitQuality"), ("heroprop", "Quality"), "c1"),
            code(("unionhelpqualityprop", "PlainNum"), ("heroprop", "ID"), "c2"),
            code(("unionhelpqualityprop", "ForceGoods"), ("heroprop", "ID"), "c3"),
            code(("unionhelpqualityprop", "ForceGoods"), ("goodsprop", "ID"), "c4"),
        ]);
        let mut record = ServerRecord::default();
        let old_key = RelationKey {
            source_table: "unionhelpqualityprop".into(),
            source_column: "MaxUnitQuality".into(),
            target_table: "heroprop".into(),
            target_column: "Quality".into(),
            kind: RelationKind::Value,
        };
        record.decisions.insert(
            old_key.id(),
            Decision {
                verdict: Verdict::Confirmed,
                auto: false,
                code_fingerprints: BTreeSet::from(["c1".to_string()]),
                overridden_code: BTreeSet::new(),
                relation: old_key,
                decided_at: "2026-01-01 10:00".into(),
            },
        );
        let formats = BTreeMap::new();
        let index = assemble(&Inputs {
            snapshot: &db,
            code: &code_report,
            formats: &formats,
            formats_pending: false,
            record: Some(&record),
            now: "2026-11-23 14:50",
        });

        let outgoing = index.outgoing("unionhelpqualityprop");
        assert!(
            outgoing.iter().all(|view| view.key.source_column != "MaxUnitQuality"),
            "enum directive must suppress all fuzzy, code and orphan relations"
        );
        assert!(
            outgoing.iter().all(|view| view.key.source_column != "NeedHelpNums"),
            "slots directive must suppress fuzzy comment relations"
        );
        assert!(
            outgoing.iter().all(|view| view.key.source_column != "PlainNum"),
            "no-relation directive must suppress all relations including client code"
        );
        let force_goods = outgoing
            .iter()
            .filter(|view| view.key.source_column == "ForceGoods")
            .collect::<Vec<_>>();
        assert_eq!(force_goods.len(), 1);
        assert_eq!(force_goods[0].key.target_table, "goodsprop");
        assert_eq!(force_goods[0].status, RelationStatus::Confirmed);
        assert_eq!(force_goods[0].reason, StatusReason::MatchesCode, "matching code evidence stays attached");

        let force_list = outgoing
            .iter()
            .filter(|view| view.key.source_column == "ForceList")
            .collect::<Vec<_>>();
        assert_eq!(force_list.len(), 1);
        assert_eq!(force_list[0].key.kind, RelationKind::List);
        assert_eq!(force_list[0].parser, Some(ReferenceParser::json("ID")));
    }
}
