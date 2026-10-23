//! Row discriminators for overloaded config fields (for example activity
//! Param1). The same guards apply to extraction, counts and filtered tabs.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use crate::db::escape_ident;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowConstraint {
    pub column: String,
    pub values: Vec<String>,
}

pub fn matches(constraints: &[RowConstraint], row: &HashMap<String, String>) -> bool {
    constraints.iter().all(|constraint| row.iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(&constraint.column))
        .is_some_and(|(_, value)| constraint.values.iter().any(|wanted| wanted == value.trim())))
}

pub fn predicate(constraints: &[RowConstraint]) -> (String, Vec<String>) {
    let mut clauses = Vec::new();
    let mut binds = Vec::new();
    for constraint in constraints {
        if constraint.values.is_empty() {
            clauses.push("1 = 0".into());
            continue;
        }
        clauses.push(format!("BINARY TRIM(CAST(`{}` AS CHAR)) IN ({})", escape_ident(&constraint.column),
            vec!["?"; constraint.values.len()].join(", ")));
        binds.extend(constraint.values.clone());
    }
    (clauses.join(" AND "), binds)
}
