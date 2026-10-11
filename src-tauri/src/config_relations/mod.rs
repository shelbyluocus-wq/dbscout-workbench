//! Config relations: which config tables a row references and which tables
//! reference it, built from database column comments, the bound game client's
//! source code, and recognisable data formats.

mod assembly;
mod catalog;
pub mod code_scan;
pub mod commands;
mod comments;
mod discovery;
pub mod engine;
pub mod filter;
mod formats;
mod model;
mod rows;
mod store;
