use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// How the source column holds the target key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationKind {
    /// The cell value is the target key.
    Value,
    /// The cell is a JSON list of objects whose `ID` member is the target key.
    List,
}

/// Identity of one directed relation between two config columns.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationKey {
    /// Lowercase table name.
    pub source_table: String,
    /// Column name in database case.
    pub source_column: String,
    /// Lowercase table name.
    pub target_table: String,
    /// Column name in database case.
    pub target_column: String,
    pub kind: RelationKind,
}

impl RelationKey {
    pub fn id(&self) -> String {
        let suffix = match self.kind {
            RelationKind::Value => "",
            RelationKind::List => "[]",
        };
        format!(
            "{}.{}{}>{}.{}",
            self.source_table,
            self.source_column.to_lowercase(),
            suffix,
            self.target_table,
            self.target_column.to_lowercase()
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Evidence {
    /// A database column comment names the target table.
    Comment { text: String },
    /// Client code looks the target up with this column's value.
    Code {
        file: String,
        line: u32,
        snippet: String,
        fingerprint: String,
    },
    /// The column's data has the shape of a known list format.
    Format { sample: String },
    /// Versioned, schema-gated project mapping verified against its readers.
    Rule { text: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationStatus {
    Confirmed,
    Unconfirmed,
    /// Confirmed earlier, but the code it relied on changed or disappeared.
    Stale,
    /// The comment names one table while the code reads another.
    Conflict,
    Rejected,
}

impl RelationStatus {
    pub fn needs_review(self) -> bool {
        matches!(self, Self::Stale | Self::Conflict)
    }
}

/// Why a relation has its status; the frontend turns these into copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusReason {
    /// Comment and code agree, confirmed by the tool.
    MatchesCode,
    /// Confirmed by a person.
    Manual,
    /// Only code shows it.
    CodeOnly,
    /// Only a comment declares it and the bound client code does not show it.
    CommentOnly,
    /// Only a comment declares it and no client code is bound yet.
    CommentWithoutClient,
    /// Only the data format suggests it.
    FormatOnly,
    ProjectRule,
    /// Code backing the confirmation changed.
    CodeChanged,
    /// Code backing the confirmation is gone.
    CodeRemoved,
    /// Nothing supports a confirmed relation any more.
    EvidenceGone,
    /// The comment names a different table than the code reads.
    CommentConflict,
    /// Marked as not a relation.
    Rejected,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationView {
    pub id: String,
    #[serde(flatten)]
    pub key: RelationKey,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parser: Option<super::parser::ReferenceParser>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub source_constraints: Vec<super::constraints::RowConstraint>,
    pub status: RelationStatus,
    pub reason: StatusReason,
    /// Appeared after the client was bound and nobody has reviewed it yet.
    pub is_new: bool,
    pub evidence: Vec<Evidence>,
    /// For conflicts: the `table.column` the code actually reads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    /// Fingerprints of usages that read the same column from another table;
    /// a confirmation records them so only later ones reopen the conflict.
    #[serde(skip)]
    pub disagreeing_code: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "code")]
pub enum CoverageGap {
    /// No client folder is bound, so only comments were read.
    NoClient,
    /// The bound folder no longer exists.
    ClientMissing,
    /// Client code is still being read.
    Analyzing,
    /// Reading client code failed.
    ScanFailed { message: String },
    /// The client code never reads this table.
    NotUsedByClient,
    /// Config expressions cannot be safely interpreted without execution.
    UnsupportedFields { columns: Vec<String> },
    /// Some code reads this table with keys whose origin is unknown, so
    /// other tables may reference it without being listed.
    UntracedLookups {
        count: usize,
        samples: Vec<UntracedSample>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UntracedSample {
    pub file: String,
    pub line: u32,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCoverage {
    pub complete: bool,
    pub gaps: Vec<CoverageGap>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusTotals {
    pub total: usize,
    pub confirmed: usize,
    pub unconfirmed: usize,
    pub new_unconfirmed: usize,
    pub stale: usize,
    pub conflict: usize,
    pub rejected: usize,
}

impl StatusTotals {
    pub fn add(&mut self, view: &RelationView) {
        self.total += 1;
        match view.status {
            RelationStatus::Confirmed => self.confirmed += 1,
            RelationStatus::Unconfirmed => {
                self.unconfirmed += 1;
                if view.is_new {
                    self.new_unconfirmed += 1;
                }
            }
            RelationStatus::Stale => self.stale += 1,
            RelationStatus::Conflict => self.conflict += 1,
            RelationStatus::Rejected => self.rejected += 1,
        }
    }

    pub fn needs_review(&self) -> usize {
        self.stale + self.conflict
    }
}
