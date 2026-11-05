//! Config relations: which config tables a row references and which tables
//! reference it, built from database column comments, the bound game client's
//! source code, and recognisable data formats.

mod assembly;
mod assisted_rules;
pub mod assistant;
mod project_access;
mod reference_scan;
mod catalog;
pub mod code_scan;
pub mod commands;
mod comments;
pub mod constraints;
mod discovery;
pub mod engine;
pub mod filter;
mod formats;
mod model;
pub mod parser;
mod project_formats;
mod project_relations;
mod rows;
mod store;
#[cfg(test)]
mod audit_tests;
