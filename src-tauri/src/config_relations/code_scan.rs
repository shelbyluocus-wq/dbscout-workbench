//! Static scan of a Cocos Creator client project for config-table lookups.
//!
//! Finds code that reads one config table with a key value taken from another
//! table's row (for example a lookup into `goodsprop` keyed by
//! `reward.ItemID`, where `reward` is a `rewardprop` row) and reports it as
//! `rewardprop.ItemID -> goodsprop.ID`. Lookups whose key value cannot be
//! traced back to a table field are reported separately so callers can mark
//! relation coverage as incomplete.
//!
//! The scanner is deliberately heuristic. It tokenizes TypeScript, runs a
//! tolerant recursive-descent pass that keeps only the facts relevant to config
//! lookups (declarations, assignments, returns, lookup sites, call sites), and
//! caches those facts per file. Value tracing then runs over the cached facts
//! on every scan, so cross-file knowledge (wrapper methods, return types)
//! stays current without re-reading unchanged files. When tracing is unsure
//! it reports the lookup as untraced rather than guessing a relation.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::SystemTime;

use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClientDialect {
    /// Cocos Creator 3.x client that reads configs through `g_PropMgr` / `__Prop__`.
    Jswz,
    /// Cocos Creator 2.4 client that reads configs through `PropM` / `Prop`.
    Nzg,
}

/// Lowercase table name -> column names in database case.
pub type TableColumns = HashMap<String, Vec<String>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeLocation {
    /// Path relative to the client root, `/` separated.
    pub file: String,
    /// 1-based line number.
    pub line: u32,
    /// Trimmed single source line, at most 160 characters.
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeRelation {
    /// Lowercase table name.
    pub source_table: String,
    /// Column name in database case.
    pub source_column: String,
    /// Lowercase table name.
    pub target_table: String,
    /// Column name in database case.
    pub target_column: String,
    pub location: CodeLocation,
    /// Stable identity of this usage. Unchanged by line shifts or edits
    /// elsewhere in the file; changes when the lookup itself or the traced
    /// source of its key changes.
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UntracedLookup {
    /// Lowercase table name.
    pub target_table: String,
    /// Column name in database case.
    pub target_column: String,
    pub location: CodeLocation,
}

#[derive(Debug, Clone, Default)]
pub struct ClientCatalog {
    /// Lowercase table name -> columns declared by the client definitions.
    pub tables: BTreeMap<String, Vec<String>>,
    /// Files the catalog was read from.
    pub source_files: Vec<PathBuf>,
}

#[derive(Debug, Clone, Default)]
pub struct CodeScanReport {
    /// Lowercase names of tables read anywhere in client code.
    pub used_tables: BTreeSet<String>,
    pub relations: Vec<CodeRelation>,
    pub untraced: Vec<UntracedLookup>,
    pub files_scanned: usize,
    pub files_reparsed: usize,
}

/// Per-file parse results reused by later scans of the same root.
#[derive(Default)]
pub struct ScanCache {
    root: Option<PathBuf>,
    files: HashMap<String, CachedFile>,
    catalog: Option<CatalogStamp>,
    last: Option<LastReport>,
}

/// Result of the previous scan, reused verbatim when no input changed.
struct LastReport {
    columns_hash: u64,
    catalog: Option<FileStamp>,
    report: CodeScanReport,
}

impl std::fmt::Debug for ScanCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScanCache")
            .field("root", &self.root)
            .field("files", &self.files.len())
            .field("catalog_tables", &self.catalog.as_ref().map(|c| c.tables.len()))
            .finish()
    }
}

struct CachedFile {
    stamp: FileStamp,
    facts: FileFacts,
}

struct CatalogStamp {
    stamp: FileStamp,
    /// Lowercase table name -> client-declared shape.
    tables: HashMap<String, ClientTable>,
}

#[derive(Default)]
struct ClientTable {
    /// First declared field: the key `getTableByName` indexes by.
    first: Option<String>,
    /// Lowercase names of fields declared as `string`.
    string_fields: HashSet<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    modified: Option<SystemTime>,
    len: u64,
}

impl FileStamp {
    fn of(meta: &fs::Metadata) -> Self {
        FileStamp { modified: meta.modified().ok(), len: meta.len() }
    }
}

const SNIPPET_MAX_CHARS: usize = 160;
const GENERATED_PROP_FILES: &[&str] = &["propDataDefine.ts", "propKeyFile.ts", "propLstFile.ts"];
const SKIPPED_DIRS: &[&str] = &["node_modules", "library", "temp", "build", "extensions", "libs"];
const MAX_EVAL_DEPTH: u32 = 40;
const MAX_ALT_DEPTH: u32 = 6;
const MAX_PARAM_TRACE_DEPTH: u32 = 2;
const MAX_NAME_DEFS: usize = 16;

// ---------------------------------------------------------------------------
// Dialect detection and catalog
// ---------------------------------------------------------------------------

pub fn detect_dialect(root: &Path) -> Option<ClientDialect> {
    if !root.join("assets").is_dir() {
        return None;
    }
    if manifest_name(&root.join("package.json")).as_deref() == Some("jswz") {
        return Some(ClientDialect::Jswz);
    }
    if manifest_name(&root.join("project.json")).as_deref() == Some("nzg") {
        return Some(ClientDialect::Nzg);
    }
    None
}

fn manifest_name(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    value.get("name")?.as_str().map(str::to_owned)
}

fn catalog_path(root: &Path, dialect: ClientDialect) -> PathBuf {
    match dialect {
        // Both clients share the generated config layout.
        ClientDialect::Jswz | ClientDialect::Nzg => root.join("assets").join("src").join("props").join("propDataDefine.ts"),
    }
}

pub fn read_catalog(root: &Path, dialect: ClientDialect) -> ClientCatalog {
    let path = catalog_path(root, dialect);
    let Some(tables) = read_catalog_fields(&path) else {
        return ClientCatalog::default();
    };
    let tables = tables.into_iter().map(|(table, fields)| (table, fields.into_iter().map(|f| f.name).collect())).collect();
    ClientCatalog { tables, source_files: vec![path] }
}

struct CatalogField {
    name: String,
    is_string: bool,
}

fn read_catalog_fields(path: &Path) -> Option<BTreeMap<String, Vec<CatalogField>>> {
    let bytes = fs::read(path).ok()?;
    Some(parse_catalog(&String::from_utf8_lossy(&bytes)))
}

/// Reads `export type <table>Data = { Field: type, ... }` declarations.
fn parse_catalog(text: &str) -> BTreeMap<String, Vec<CatalogField>> {
    let src = text.trim_start_matches('\u{feff}');
    let toks = tokenize(src);
    let tx = |i: usize| -> &str { toks.get(i).map_or("", |t| &src[t.start as usize..t.end as usize]) };
    let mut tables = BTreeMap::new();
    let mut i = 0;
    while i < toks.len() {
        let is_type = tx(i) == "type" && toks.get(i + 1).is_some_and(|t| t.kind == TokKind::Ident) && tx(i + 2) == "=" && tx(i + 3) == "{";
        let is_interface = tx(i) == "interface" && toks.get(i + 1).is_some_and(|t| t.kind == TokKind::Ident) && tx(i + 2) == "{";
        if !(is_type || is_interface) {
            i += 1;
            continue;
        }
        let type_name = tx(i + 1);
        let open = if is_type { i + 3 } else { i + 2 };
        let mut depth = 0usize;
        let mut fields = Vec::new();
        let mut j = open;
        while j < toks.len() {
            let t = tx(j);
            if toks[j].kind == TokKind::Punct {
                match t {
                    "{" | "(" | "[" => depth += 1,
                    "}" | ")" | "]" => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
            } else if depth == 1 && toks[j].kind == TokKind::Ident && matches!(tx(j - 1), "{" | "," | ";") && (tx(j + 1) == ":" || (tx(j + 1) == "?" && tx(j + 2) == ":")) {
                let ty = if tx(j + 1) == ":" { tx(j + 2) } else { tx(j + 3) };
                fields.push(CatalogField { name: t.to_owned(), is_string: ty == "string" });
            }
            j += 1;
        }
        let lower = type_name.to_ascii_lowercase();
        if let Some(table) = lower.strip_suffix("data") {
            if !table.is_empty() && !fields.is_empty() {
                tables.insert(table.to_owned(), fields);
            }
        }
        i = j + 1;
    }
    tables
}

// ---------------------------------------------------------------------------
// Scan entry point and file walking
// ---------------------------------------------------------------------------

pub fn scan(
    root: &Path,
    dialect: ClientDialect,
    columns: &TableColumns,
    cache: &mut ScanCache,
    cancel: &AtomicBool,
) -> Result<CodeScanReport, String> {
    if cache.root.as_deref() != Some(root) {
        *cache = ScanCache { root: Some(root.to_path_buf()), ..ScanCache::default() };
    }
    refresh_catalog(root, dialect, cache);

    let mut entries = Vec::new();
    walk_sources(&root.join("assets"), "assets", &mut entries, cancel)?;
    entries.sort_by(|a, b| a.rel.cmp(&b.rel));

    let live: HashSet<&str> = entries.iter().map(|e| e.rel.as_str()).collect();
    let cached_before = cache.files.len();
    cache.files.retain(|rel, _| live.contains(rel.as_str()));
    let files_removed = cache.files.len() != cached_before;
    let stale: Vec<&SourceEntry> = entries
        .iter()
        .filter(|e| cache.files.get(&e.rel).is_none_or(|c| c.stamp != e.stamp))
        .collect();
    let parsed = parse_files_parallel(&stale, cancel)?;
    let files_reparsed = parsed.len();
    for (entry, facts) in stale.iter().zip(parsed) {
        cache.files.insert(entry.rel.clone(), CachedFile { stamp: entry.stamp, facts });
    }

    let columns_hash = hash_columns(columns);
    let catalog_stamp = cache.catalog.as_ref().map(|c| c.stamp);
    if files_reparsed == 0 && !files_removed {
        if let Some(last) = cache.last.as_ref().filter(|l| l.columns_hash == columns_hash && l.catalog == catalog_stamp) {
            let mut report = last.report.clone();
            report.files_scanned = entries.len();
            report.files_reparsed = 0;
            return Ok(report);
        }
    }
    cache.last = None;

    let no_client_tables = HashMap::new();
    let client_tables = cache.catalog.as_ref().map_or(&no_client_tables, |c| &c.tables);
    let tables = Tables::new(columns, client_tables);
    let facts: Vec<&FileFacts> = entries.iter().filter_map(|e| cache.files.get(&e.rel).map(|c| &c.facts)).collect();
    let mut report = Resolver::new(&facts, &tables).report(cancel)?;
    report.files_scanned = entries.len();
    report.files_reparsed = files_reparsed;
    cache.last = Some(LastReport { columns_hash, catalog: catalog_stamp, report: report.clone() });
    Ok(report)
}

fn hash_columns(columns: &TableColumns) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut entries: Vec<(&String, &Vec<String>)> = columns.iter().collect();
    entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    entries.hash(&mut hasher);
    hasher.finish()
}

fn refresh_catalog(root: &Path, dialect: ClientDialect, cache: &mut ScanCache) {
    let path = catalog_path(root, dialect);
    let stamp = fs::metadata(&path).ok().map(|m| FileStamp::of(&m));
    let Some(stamp) = stamp else {
        cache.catalog = None;
        return;
    };
    if cache.catalog.as_ref().is_some_and(|c| c.stamp == stamp) {
        return;
    }
    let tables = read_catalog_fields(&path)
        .unwrap_or_default()
        .into_iter()
        .map(|(table, fields)| {
            let info = ClientTable {
                first: fields.first().map(|f| f.name.clone()),
                string_fields: fields.iter().filter(|f| f.is_string).map(|f| f.name.to_ascii_lowercase()).collect(),
            };
            (table, info)
        })
        .collect();
    cache.catalog = Some(CatalogStamp { stamp, tables });
}

struct SourceEntry {
    rel: String,
    path: PathBuf,
    stamp: FileStamp,
}

fn walk_sources(dir: &Path, rel: &str, out: &mut Vec<SourceEntry>, cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    let Ok(read) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in read.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(file_type) = entry.file_type() else { continue };
        let child_rel = format!("{rel}/{name}");
        if file_type.is_dir() {
            if name.starts_with('.') || SKIPPED_DIRS.contains(&name) {
                continue;
            }
            walk_sources(&entry.path(), &child_rel, out, cancel)?;
        } else if file_type.is_file()
            && name.ends_with(".ts")
            && !name.ends_with(".d.ts")
            && !GENERATED_PROP_FILES.contains(&name)
        {
            let Ok(meta) = entry.metadata() else { continue };
            out.push(SourceEntry { rel: child_rel, path: entry.path(), stamp: FileStamp::of(&meta) });
        }
    }
    Ok(())
}

fn parse_files_parallel(entries: &[&SourceEntry], cancel: &AtomicBool) -> Result<Vec<FileFacts>, String> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8).min(entries.len());
    let next = AtomicUsize::new(0);
    let mut slots: Vec<Option<FileFacts>> = Vec::new();
    slots.resize_with(entries.len(), || None);
    let chunks: Vec<Vec<(usize, FileFacts)>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                s.spawn(|| {
                    let mut done = Vec::new();
                    loop {
                        if cancel.load(Ordering::Relaxed) {
                            break;
                        }
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(entry) = entries.get(i) else { break };
                        let text = fs::read(&entry.path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
                        done.push((i, parse_file(&entry.rel, &text)));
                    }
                    done
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    });
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    for (i, facts) in chunks.into_iter().flatten() {
        slots[i] = Some(facts);
    }
    Ok(slots
        .into_iter()
        .zip(entries)
        .map(|(slot, entry)| slot.unwrap_or_else(|| FileFacts { rel: entry.rel.clone(), ..FileFacts::default() }))
        .collect())
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TokKind {
    Ident,
    Num,
    Str,
    Template,
    Regex,
    Punct,
}

#[derive(Clone, Copy, Debug)]
struct Tok {
    kind: TokKind,
    start: u32,
    end: u32,
    line: u32,
}

const PUNCT3: &[&str] = &["===", "!==", "...", "**=", "&&=", "||=", "??=", "<<="];
const PUNCT2: &[&str] = &[
    "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<",
];
const REGEX_PREFIX_KEYWORDS: &[&str] = &[
    "return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await",
];

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

fn tokenize(src: &str) -> Vec<Tok> {
    let b = src.as_bytes();
    let mut toks: Vec<Tok> = Vec::with_capacity(b.len() / 5);
    let mut i = 0usize;
    let mut line = 1u32;
    while i < b.len() {
        let c = b[i];
        if c == b'\n' {
            line += 1;
            i += 1;
            continue;
        }
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if c == b'/' && i + 1 < b.len() {
            if b[i + 1] == b'/' {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            if b[i + 1] == b'*' {
                i += 2;
                while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                    if b[i] == b'\n' {
                        line += 1;
                    }
                    i += 1;
                }
                i = (i + 2).min(b.len());
                continue;
            }
        }
        let start = i;
        let start_line = line;
        let kind = if is_ident_byte(c) && !c.is_ascii_digit() {
            while i < b.len() && is_ident_byte(b[i]) {
                i += 1;
            }
            TokKind::Ident
        } else if c.is_ascii_digit() || (c == b'.' && b.get(i + 1).is_some_and(u8::is_ascii_digit)) {
            i += 1;
            while i < b.len() && (is_ident_byte(b[i]) || b[i] == b'.') {
                i += 1;
            }
            TokKind::Num
        } else if c == b'"' || c == b'\'' {
            i = skip_string(b, i, &mut line);
            TokKind::Str
        } else if c == b'`' {
            i = skip_template(b, i, &mut line);
            TokKind::Template
        } else if c == b'/' && regex_allowed(src, &toks) {
            i = skip_regex(b, i);
            TokKind::Regex
        } else {
            let rest = &src[i..];
            let len = if PUNCT3.iter().any(|p| rest.starts_with(p)) {
                3
            } else if PUNCT2.iter().any(|p| rest.starts_with(p)) && !(rest.starts_with("?.") && rest.as_bytes().get(2).is_some_and(u8::is_ascii_digit)) {
                2
            } else {
                1
            };
            i += len;
            TokKind::Punct
        };
        toks.push(Tok { kind, start: start as u32, end: i as u32, line: start_line });
    }
    toks
}

fn skip_string(b: &[u8], mut i: usize, line: &mut u32) -> usize {
    let quote = b[i];
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' => {
                if b.get(i + 1) == Some(&b'\n') {
                    *line += 1;
                }
                i += 2;
            }
            b'\n' => return i,
            c if c == quote => return i + 1,
            _ => i += 1,
        }
    }
    b.len()
}

fn skip_template(b: &[u8], mut i: usize, line: &mut u32) -> usize {
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'`' => return i + 1,
            b'\n' => {
                *line += 1;
                i += 1;
            }
            b'$' if b.get(i + 1) == Some(&b'{') => {
                i += 2;
                let mut depth = 1usize;
                while i < b.len() && depth > 0 {
                    match b[i] {
                        b'{' => {
                            depth += 1;
                            i += 1;
                        }
                        b'}' => {
                            depth -= 1;
                            i += 1;
                        }
                        b'"' | b'\'' => i = skip_string(b, i, line),
                        b'`' => i = skip_template(b, i, line),
                        b'\n' => {
                            *line += 1;
                            i += 1;
                        }
                        _ => i += 1,
                    }
                }
            }
            _ => i += 1,
        }
    }
    b.len().min(i)
}

fn skip_regex(b: &[u8], mut i: usize) -> usize {
    i += 1;
    let mut in_class = false;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'[' => {
                in_class = true;
                i += 1;
            }
            b']' => {
                in_class = false;
                i += 1;
            }
            b'/' if !in_class => {
                i += 1;
                break;
            }
            b'\n' => return i,
            _ => i += 1,
        }
    }
    while i < b.len() && is_ident_byte(b[i]) {
        i += 1;
    }
    i.min(b.len())
}

fn regex_allowed(src: &str, toks: &[Tok]) -> bool {
    let Some(prev) = toks.last() else { return true };
    let text = &src[prev.start as usize..prev.end as usize];
    match prev.kind {
        TokKind::Ident => REGEX_PREFIX_KEYWORDS.contains(&text),
        TokKind::Num | TokKind::Str | TokKind::Template | TokKind::Regex => false,
        TokKind::Punct => !matches!(text, ")" | "]" | "}"),
    }
}

fn match_brackets(src: &str, toks: &[Tok]) -> Vec<u32> {
    let mut matched = vec![u32::MAX; toks.len()];
    let mut stack: Vec<usize> = Vec::new();
    for (i, t) in toks.iter().enumerate() {
        if t.kind != TokKind::Punct || t.end - t.start != 1 {
            continue;
        }
        let c = src.as_bytes()[t.start as usize];
        let opener = match c {
            b'(' | b'[' | b'{' => {
                stack.push(i);
                continue;
            }
            b')' => b'(',
            b']' => b'[',
            b'}' => b'{',
            _ => continue,
        };
        if let Some(p) = stack.iter().rposition(|&j| src.as_bytes()[toks[j].start as usize] == opener) {
            let j = stack[p];
            stack.truncate(p);
            matched[j] = i as u32;
            matched[i] = j as u32;
        }
    }
    matched
}

// ---------------------------------------------------------------------------
// Per-file facts
// ---------------------------------------------------------------------------

/// Index into `FileFacts::syms`.
type Sym = u32;

/// Shape of a type annotation that names a generated row type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ty {
    Row(Sym),
    Rows(Sym),
    Map(Sym),
}

/// Expression IR that keeps only what value tracing needs.
#[derive(Clone, Debug)]
enum Expr {
    /// Literals, `null`, `undefined`, empty containers, iteration keys.
    Neutral,
    Str(Sym),
    StrList(Vec<Sym>),
    Ident(Sym),
    This,
    /// `__Prop__.x` / `Prop.x`.
    TableRef(Sym),
    Member(Box<Expr>, Sym),
    Index(Box<Expr>, Box<Expr>),
    Call(Box<CallExpr>),
    Typed(Box<Expr>, Ty),
    Union(Vec<Expr>),
    ElemOf(Box<Expr>),
    Obj(Vec<ObjEntry>),
    Eq(Box<Expr>, Box<Expr>),
    And(Vec<Expr>),
    Func(u32),
    /// Return value of a getter declared in the same file.
    FuncResult(u32),
    Other,
}

#[derive(Clone, Debug)]
struct CallExpr {
    callee: Expr,
    args: Vec<Expr>,
    type_arg: Option<Ty>,
}

#[derive(Clone, Debug)]
struct ObjEntry {
    key: Sym,
    value: Expr,
    line: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Recv {
    None,
    This,
    Ident(Sym),
    Other,
}

#[derive(Debug, Default)]
struct FuncInfo {
    name: Option<Sym>,
    class: Option<Sym>,
    params: Vec<Sym>,
    param_sources: Vec<u32>,
    ret_ty: Option<Ty>,
    returns: Vec<Expr>,
    body_scope: u32,
}

/// One way a binding gets its value.
#[derive(Debug)]
struct Source {
    /// Scope the value expression is evaluated in.
    scope: u32,
    ty: Option<Ty>,
    value: Option<Expr>,
    param: Option<(u32, u32)>,
}

#[derive(Debug)]
enum SiteKind {
    /// `getPropLine(T, {key, value}, ...)` / `getPropsByKeys(...)`.
    Direct { table: Sym, pairs: Vec<(Sym, Expr, u32)> },
    /// `map[key]` where `map` may be a keyed table.
    Index { base: Expr, index: Expr },
    /// A call that may target a wrapper method.
    Call { name: Sym, recv: Recv, args: Vec<(Expr, u32)> },
    /// `rows.find(r => r.Col === value)`.
    Pred { recv: Expr, func: u32 },
}

#[derive(Debug)]
struct Site {
    order: u32,
    scope: u32,
    line: u32,
    text_hash: u64,
    funcs: Box<[u32]>,
    kind: SiteKind,
}

#[derive(Debug, Default)]
struct FileFacts {
    rel: String,
    syms: Vec<Box<str>>,
    scope_parent: Vec<u32>,
    funcs: Vec<FuncInfo>,
    sources: Vec<Source>,
    bindings: HashMap<(u32, Sym), Vec<u32>>,
    members: HashMap<Sym, Vec<u32>>,
    sites: Vec<Site>,
    sites_by_func: HashMap<u32, Vec<u32>>,
    funcs_by_name: HashMap<Sym, Vec<u32>>,
    snippets: HashMap<u32, Box<str>>,
    table_refs: Vec<String>,
    enums: Vec<Box<str>>,
}

impl FileFacts {
    fn sym(&self, s: Sym) -> &str {
        &self.syms[s as usize]
    }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const TABLE_REF_OBJECTS: &[&str] = &["__Prop__", "Prop"];
const KEYED_LOOKUP_FUNCS: &[&str] = &["getPropLine", "getPropsByKeys"];
const TABLE_FUNCS: &[&str] = &["getPropLine", "getPropsByKeys", "getProp", "getTable", "requireProp", "getTableByName", "getPropByKeys"];
const CALLBACK_METHODS: &[&str] = &["forEach", "map", "filter", "find", "findIndex", "findLast", "some", "every", "flatMap"];
const PREDICATE_METHODS: &[&str] = &["filter", "find", "findIndex", "findLast", "some"];
const CONVERSION_FUNCS: &[&str] = &["Number", "parseInt", "parseFloat", "String"];
const CLASS_MODIFIERS: &[&str] = &[
    "public", "private", "protected", "static", "readonly", "abstract", "override", "declare", "async", "accessor", "get", "set",
];
const PARAM_MODIFIERS: &[&str] = &["public", "private", "protected", "readonly", "override"];
const RESERVED: &[&str] = &[
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
    "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return", "super", "switch", "this",
    "throw", "true", "try", "typeof", "var", "void", "while", "with", "let", "yield", "await",
];

/// Builtin or framework method names that never act as config wrappers.
/// Platform objects whose methods must never resolve to same-named game methods.
const BUILTIN_RECEIVERS: &[&str] = &[
    "localStorage", "sessionStorage", "JSON", "Math", "Object", "Array", "console", "cc", "Date", "Promise", "Reflect", "window",
    "document", "sys", "director", "game", "tween", "Tween", "Number", "String", "fgui", "jsb", "wx", "tt", "navigator",
];

fn is_blacklisted_call(name: &str) -> bool {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "push", "pop", "shift", "unshift", "splice", "slice", "concat", "join", "split", "indexOf", "lastIndexOf", "includes", "find",
            "findIndex", "findLast", "filter", "map", "forEach", "some", "every", "reduce", "sort", "reverse", "keys", "values", "entries",
            "log", "warn", "error", "info", "debug", "toString", "toFixed", "parseInt", "parseFloat", "Number", "String", "Boolean", "floor",
            "ceil", "round", "abs", "max", "min", "pow", "sqrt", "random", "emit", "on", "off", "once", "replace", "substring", "substr",
            "startsWith", "endsWith", "trim", "charAt", "charCodeAt", "apply", "call", "bind", "then", "catch", "resolve", "reject",
            "require", "stringify", "parse", "assign", "freeze", "isArray", "from", "now", "set", "get", "has", "add", "delete", "clear",
            "setTimeout", "clearTimeout", "setInterval", "clearInterval", "getComponent", "addComponent", "getChildByName", "scheduleOnce",
            "schedule", "unschedule", "format", "padStart", "padEnd", "toLowerCase", "toUpperCase", "test", "exec", "match", "fill", "flat",
            "flatMap", "isNaN", "isFinite", "fromCharCode", "hasOwnProperty", "dispatchEvent", "addEventListener", "removeEventListener",
        ]
        .into_iter()
        .collect()
    })
    .contains(name)
}

struct IndexCandidate {
    order: u32,
    scope: u32,
    line: u32,
    text_hash: u64,
    funcs: Box<[u32]>,
    base: Expr,
    index: Expr,
}

struct Parser<'s> {
    src: &'s str,
    toks: Vec<Tok>,
    mat: Vec<u32>,
    pos: usize,
    f: FileFacts,
    intern: HashMap<Box<str>, Sym>,
    scope: u32,
    func_stack: Vec<u32>,
    class: Option<Sym>,
    declared: HashSet<(u32, Sym)>,
    pending_assigns: Vec<(u32, Sym, Expr)>,
    pending_index: Vec<IndexCandidate>,
    table_refs: BTreeSet<String>,
}

fn parse_file(rel: &str, text: &str) -> FileFacts {
    let src = text.trim_start_matches('\u{feff}');
    let toks = tokenize(src);
    let mat = match_brackets(src, &toks);
    let mut p = Parser {
        src,
        toks,
        mat,
        pos: 0,
        f: FileFacts { rel: rel.to_owned(), scope_parent: vec![0], ..FileFacts::default() },
        intern: HashMap::new(),
        scope: 0,
        func_stack: Vec::new(),
        class: None,
        declared: HashSet::new(),
        pending_assigns: Vec::new(),
        pending_index: Vec::new(),
        table_refs: BTreeSet::new(),
    };
    let end = p.toks.len();
    p.parse_stmts(end);
    p.finish()
}

fn prune(e: Expr) -> Expr {
    match e {
        Expr::Obj(_) => Expr::Other,
        Expr::Union(v) => Expr::Union(v.into_iter().map(prune).collect()),
        Expr::Typed(b, t) => Expr::Typed(Box::new(prune(*b)), t),
        Expr::Member(b, s) => Expr::Member(Box::new(prune(*b)), s),
        Expr::Index(a, b) => Expr::Index(Box::new(prune(*a)), Box::new(prune(*b))),
        Expr::ElemOf(b) => Expr::ElemOf(Box::new(prune(*b))),
        Expr::And(v) => Expr::And(v.into_iter().map(prune).collect()),
        Expr::Eq(a, b) => Expr::Eq(Box::new(prune(*a)), Box::new(prune(*b))),
        other => other,
    }
}

fn callee_parts(callee: &Expr) -> (Option<Sym>, Recv) {
    match callee {
        Expr::Ident(s) => (Some(*s), Recv::None),
        Expr::Member(base, s) => (
            Some(*s),
            match base.as_ref() {
                Expr::This => Recv::This,
                Expr::Ident(r) | Expr::Member(_, r) => Recv::Ident(*r),
                _ => Recv::Other,
            },
        ),
        _ => (None, Recv::Other),
    }
}

fn expr_mentions(e: &Expr, sym: Sym) -> bool {
    match e {
        Expr::Ident(s) => *s == sym,
        Expr::Member(b, _) | Expr::Typed(b, _) | Expr::ElemOf(b) => expr_mentions(b, sym),
        Expr::Index(a, b) | Expr::Eq(a, b) => expr_mentions(a, sym) || expr_mentions(b, sym),
        Expr::Union(v) | Expr::And(v) => v.iter().any(|x| expr_mentions(x, sym)),
        Expr::Call(c) => expr_mentions(&c.callee, sym) || c.args.iter().any(|x| expr_mentions(x, sym)),
        _ => false,
    }
}

impl<'s> Parser<'s> {
    // ----- token helpers -----

    fn t(&self, i: usize) -> &'s str {
        match self.toks.get(i) {
            Some(t) => &self.src[t.start as usize..t.end as usize],
            None => "",
        }
    }

    fn p(&self, i: usize, s: &str) -> bool {
        self.toks.get(i).is_some_and(|t| t.kind == TokKind::Punct) && self.t(i) == s
    }

    fn kw(&self, i: usize, s: &str) -> bool {
        self.toks.get(i).is_some_and(|t| t.kind == TokKind::Ident) && self.t(i) == s
    }

    fn is_kind(&self, i: usize, kind: TokKind) -> bool {
        self.toks.get(i).is_some_and(|t| t.kind == kind)
    }

    fn ident(&self, i: usize) -> bool {
        self.is_kind(i, TokKind::Ident)
    }

    fn line(&self, i: usize) -> u32 {
        self.toks.get(i).or(self.toks.last()).map_or(1, |t| t.line)
    }

    fn close(&self, i: usize, end: usize) -> usize {
        match self.mat.get(i) {
            Some(&m) if m != u32::MAX && (m as usize) > i && (m as usize) <= end => m as usize,
            _ => end,
        }
    }

    fn sym(&mut self, s: &str) -> Sym {
        if let Some(&id) = self.intern.get(s) {
            return id;
        }
        let id = self.f.syms.len() as Sym;
        self.f.syms.push(s.into());
        self.intern.insert(s.into(), id);
        id
    }

    fn str_value(&self, i: usize) -> &'s str {
        let t = self.t(i);
        if t.len() >= 2 {
            &t[1..t.len() - 1]
        } else {
            ""
        }
    }

    fn hash_tokens(&self, from: usize, to: usize) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for i in from..=to.min(self.toks.len().saturating_sub(1)) {
            for &b in self.t(i).as_bytes().iter().chain(b" ") {
                h ^= u64::from(b);
                h = h.wrapping_mul(0x0100_0000_01b3);
            }
        }
        h
    }

    fn recover_to_comma(&mut self, end: usize) {
        while self.pos < end && !self.p(self.pos, ",") {
            let before = self.pos;
            self.parse_assign(end);
            if self.pos <= before {
                self.pos = before + 1;
            }
        }
    }

    /// Parses every expression in `[from, to)` and returns the first one.
    fn scan_region(&mut self, from: usize, to: usize) -> Expr {
        self.pos = from;
        let mut first = None;
        while self.pos < to {
            let before = self.pos;
            let e = self.parse_expr(to);
            first.get_or_insert(e);
            if self.pos <= before {
                self.pos = before + 1;
            }
        }
        first.unwrap_or(Expr::Neutral)
    }

    // ----- fact recording -----

    fn new_scope(&mut self) -> u32 {
        let id = self.f.scope_parent.len() as u32;
        self.f.scope_parent.push(self.scope);
        id
    }

    fn add_source(&mut self, source: Source) -> u32 {
        let id = self.f.sources.len() as u32;
        let source = Source { value: source.value.map(prune), ..source };
        self.f.sources.push(source);
        id
    }

    fn declare(&mut self, name: Sym, source: Source) -> u32 {
        let scope = self.scope;
        let id = self.add_source(source);
        self.f.bindings.entry((scope, name)).or_default().push(id);
        self.declared.insert((scope, name));
        id
    }

    /// An anonymous function bound to a name takes that name (and, for a
    /// class member, the class) so calls through the name resolve to it.
    fn name_function(&mut self, value: &Option<Expr>, name: Sym, member: bool) {
        let Some(Expr::Func(fid)) = value else {
            return;
        };
        let func = &mut self.f.funcs[*fid as usize];
        if func.name.is_none() {
            func.name = Some(name);
            if member {
                func.class = self.class;
            }
        }
    }

    fn declare_value(&mut self, name: Sym, ty: Option<Ty>, value: Option<Expr>) {
        self.name_function(&value, name, false);
        let scope = self.scope;
        self.declare(name, Source { scope, ty, value, param: None });
    }

    fn add_member(&mut self, name: Sym, ty: Option<Ty>, value: Option<Expr>) {
        self.name_function(&value, name, true);
        let scope = self.scope;
        let id = self.add_source(Source { scope, ty, value, param: None });
        self.f.members.entry(name).or_default().push(id);
    }

    fn record_assign(&mut self, target: &Expr, value: Expr) {
        match target {
            Expr::Ident(s) => self.pending_assigns.push((self.scope, *s, value)),
            Expr::Member(base, s) if matches!(base.as_ref(), Expr::This) => self.add_member(*s, None, Some(value)),
            _ => {}
        }
    }

    fn add_return(&mut self, e: Expr) {
        if let Some(&f) = self.func_stack.last() {
            self.f.funcs[f as usize].returns.push(prune(e));
        }
    }

    fn push_site(&mut self, order: usize, line: u32, text_hash: u64, kind: SiteKind) {
        let site = Site {
            order: order as u32,
            scope: self.scope,
            line,
            text_hash,
            funcs: self.func_stack.clone().into_boxed_slice(),
            kind,
        };
        self.f.sites.push(site);
    }

    fn add_table_ref(&mut self, name: &str) {
        let name = name.rsplit('/').next().unwrap_or(name);
        if !name.is_empty() {
            self.table_refs.insert(name.to_ascii_lowercase());
        }
    }

    fn begin_func(&mut self, name: Option<Sym>) -> (u32, u32) {
        let saved = self.scope;
        let body = self.new_scope();
        let fid = self.f.funcs.len() as u32;
        self.f.funcs.push(FuncInfo { name, class: self.class, body_scope: body, ..FuncInfo::default() });
        self.scope = body;
        self.func_stack.push(fid);
        (fid, saved)
    }

    fn end_func(&mut self, saved_scope: u32) {
        self.scope = saved_scope;
        self.func_stack.pop();
    }

    // ----- statements -----

    fn parse_stmts(&mut self, end: usize) {
        while self.pos < end {
            let before = self.pos;
            self.parse_stmt(end);
            if self.pos <= before {
                self.pos = before + 1;
            }
        }
    }

    fn parse_stmt(&mut self, end: usize) {
        let i = self.pos;
        let tok = self.toks[i];
        match tok.kind {
            TokKind::Punct => match self.t(i) {
                ";" => {
                    self.pos += 1;
                    return;
                }
                "{" => {
                    let c = self.close(i, end);
                    self.pos = i + 1;
                    self.parse_stmts(c);
                    self.pos = c + 1;
                    return;
                }
                "@" => {
                    self.pos += 1;
                    self.parse_postfix(end, false);
                    return;
                }
                _ => {}
            },
            TokKind::Ident => {
                let word = self.t(i);
                match word {
                    "import" if !self.p(i + 1, "(") && !self.p(i + 1, ".") => {
                        self.pos += 1;
                        self.skip_module_clause(end);
                        return;
                    }
                    "export" => {
                        self.pos += 1;
                        if self.kw(self.pos, "default") {
                            self.pos += 1;
                        }
                        if self.p(self.pos, "{") || self.p(self.pos, "*") {
                            self.skip_module_clause(end);
                        } else if self.p(self.pos, "=") {
                            self.pos += 1;
                        }
                        return;
                    }
                    "let" | "const" | "var" if self.ident(i + 1) || self.p(i + 1, "{") || self.p(i + 1, "[") => {
                        if self.kw(i + 1, "enum") {
                            if self.ident(i + 2) {
                                self.f.enums.push(self.t(i + 2).into());
                            }
                            self.pos = i + 1;
                            self.skip_braced_decl(end);
                        } else {
                            self.parse_var_decls(end);
                        }
                        return;
                    }
                    "function" => {
                        self.parse_function(end);
                        return;
                    }
                    "async" if self.kw(i + 1, "function") => {
                        self.pos += 1;
                        self.parse_function(end);
                        return;
                    }
                    "class" => {
                        self.parse_class(end);
                        return;
                    }
                    "abstract" | "declare" if self.ident(i + 1) => {
                        self.pos += 1;
                        return;
                    }
                    "interface" | "enum" if self.ident(i + 1) => {
                        if word == "enum" {
                            self.f.enums.push(self.t(i + 1).into());
                        }
                        self.skip_braced_decl(end);
                        return;
                    }
                    "type" if self.ident(i + 1) && (self.p(i + 2, "=") || self.p(i + 2, "<")) => {
                        self.pos = i + 2;
                        self.skip_generics(end);
                        if self.p(self.pos, "=") {
                            self.pos += 1;
                            self.parse_type(end);
                        }
                        return;
                    }
                    "namespace" | "module" if (self.ident(i + 1) || self.is_kind(i + 1, TokKind::Str)) && self.p(i + 2, "{") => {
                        self.pos = i + 2;
                        return;
                    }
                    "if" | "while" | "switch" | "with" if self.p(i + 1, "(") => {
                        let c = self.close(i + 1, end);
                        self.scan_region(i + 2, c);
                        self.pos = c + 1;
                        return;
                    }
                    "for" => {
                        self.parse_for(end);
                        return;
                    }
                    "catch" => {
                        self.pos += 1;
                        if self.p(self.pos, "(") {
                            let c = self.close(self.pos, end);
                            for j in self.pos + 1..c {
                                if self.ident(j) {
                                    let s = self.sym(self.t(j));
                                    self.declare_value(s, None, Some(Expr::Other));
                                }
                            }
                            self.pos = c + 1;
                        }
                        return;
                    }
                    "do" | "else" | "try" | "finally" => {
                        self.pos += 1;
                        return;
                    }
                    "return" | "throw" => {
                        self.pos += 1;
                        if self.pos < end && !self.p(self.pos, ";") && !self.p(self.pos, "}") && self.line(self.pos) == tok.line {
                            let e = self.parse_expr(end);
                            if word == "return" {
                                self.add_return(e);
                            }
                        }
                        return;
                    }
                    "case" => {
                        self.pos += 1;
                        self.parse_expr(end);
                        if self.p(self.pos, ":") {
                            self.pos += 1;
                        }
                        return;
                    }
                    "default" if self.p(i + 1, ":") => {
                        self.pos += 2;
                        return;
                    }
                    "break" | "continue" => {
                        self.pos += 1;
                        if self.ident(self.pos) && self.line(self.pos) == tok.line {
                            self.pos += 1;
                        }
                        return;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        self.parse_expr(end);
    }

    fn skip_module_clause(&mut self, end: usize) {
        while self.pos < end {
            if self.p(self.pos, ";") {
                self.pos += 1;
                return;
            }
            if self.is_kind(self.pos, TokKind::Str) {
                self.pos += 1;
                return;
            }
            if self.p(self.pos, "{") || self.p(self.pos, "(") {
                self.pos = self.close(self.pos, end) + 1;
                if !self.kw(self.pos, "from") {
                    return;
                }
                continue;
            }
            self.pos += 1;
        }
    }

    /// Skips `interface X ... { }`, `enum X { }` and similar declarations.
    fn skip_braced_decl(&mut self, end: usize) {
        while self.pos < end && !self.p(self.pos, "{") {
            self.pos += 1;
        }
        if self.pos < end {
            self.pos = self.close(self.pos, end) + 1;
        }
    }

    fn skip_generics(&mut self, end: usize) {
        if !self.p(self.pos, "<") {
            return;
        }
        let mut depth = 0i32;
        let limit = (self.pos + 400).min(end);
        while self.pos < limit {
            if self.p(self.pos, "<") {
                depth += 1;
            } else if self.p(self.pos, ">") {
                depth -= 1;
                if depth == 0 {
                    self.pos += 1;
                    return;
                }
            } else if self.p(self.pos, "(") || self.p(self.pos, "{") || self.p(self.pos, "[") {
                self.pos = self.close(self.pos, end);
            }
            self.pos += 1;
        }
    }

    fn parse_var_decls(&mut self, end: usize) {
        self.pos += 1;
        while self.pos < end {
            if self.ident(self.pos) && !RESERVED.contains(&self.t(self.pos)) {
                let name = self.sym(self.t(self.pos));
                self.pos += 1;
                if self.p(self.pos, "!") {
                    self.pos += 1;
                }
                let ty = if self.p(self.pos, ":") {
                    self.pos += 1;
                    self.parse_type(end)
                } else {
                    None
                };
                let init = if self.p(self.pos, "=") {
                    self.pos += 1;
                    Some(self.parse_assign(end))
                } else {
                    None
                };
                self.declare_value(name, ty, init);
            } else if self.p(self.pos, "{") || self.p(self.pos, "[") {
                let open = self.pos;
                let c = self.close(open, end);
                self.pos = c + 1;
                if self.p(self.pos, ":") {
                    self.pos += 1;
                    self.parse_type(end);
                }
                let init = if self.p(self.pos, "=") {
                    self.pos += 1;
                    Some(self.parse_assign(end))
                } else {
                    None
                };
                let after = self.pos;
                self.bind_pattern(open, c, init.as_ref());
                self.pos = after;
            } else {
                return;
            }
            if self.p(self.pos, ",") {
                self.pos += 1;
            } else {
                return;
            }
        }
    }

    /// Declares the names of a destructuring pattern spanning `[open, close]`.
    fn bind_pattern(&mut self, open: usize, close: usize, init: Option<&Expr>) {
        let is_obj = self.p(open, "{");
        let member = |init: Option<&Expr>, key: Option<Sym>| -> Option<Expr> {
            match (init, key) {
                (Some(e), Some(k)) => Some(Expr::Member(Box::new(e.clone()), k)),
                (Some(_), None) => Some(Expr::Other),
                (None, _) => None,
            }
        };
        self.pos = open + 1;
        while self.pos < close {
            if self.p(self.pos, ",") {
                self.pos += 1;
                continue;
            }
            if self.p(self.pos, "...") {
                self.pos += 1;
                if self.ident(self.pos) {
                    let s = self.sym(self.t(self.pos));
                    self.declare_value(s, None, Some(Expr::Other));
                    self.pos += 1;
                }
                continue;
            }
            let value = if is_obj {
                let key = if self.ident(self.pos) || self.is_kind(self.pos, TokKind::Str) {
                    let text = if self.ident(self.pos) { self.t(self.pos) } else { self.str_value(self.pos) };
                    let k = self.sym(text);
                    self.pos += 1;
                    Some(k)
                } else if self.p(self.pos, "[") {
                    self.pos = self.close(self.pos, close) + 1;
                    None
                } else {
                    self.recover_to_comma(close);
                    continue;
                };
                let value = member(init, key);
                if self.p(self.pos, ":") {
                    self.pos += 1;
                    self.bind_target(close, value);
                } else if let Some(k) = key {
                    self.declare_value(k, None, value);
                }
                None
            } else {
                Some(init.map(|e| Expr::Index(Box::new(e.clone()), Box::new(Expr::Neutral))))
            };
            if let Some(value) = value {
                self.bind_target(close, value);
            }
            if self.p(self.pos, "=") {
                self.pos += 1;
                self.parse_assign(close);
            }
            self.recover_to_comma(close);
        }
    }

    fn bind_target(&mut self, close: usize, value: Option<Expr>) {
        if self.ident(self.pos) {
            let s = self.sym(self.t(self.pos));
            self.pos += 1;
            self.declare_value(s, None, value);
        } else if self.p(self.pos, "{") || self.p(self.pos, "[") {
            let open = self.pos;
            let c = self.close(open, close);
            self.bind_pattern(open, c, value.as_ref());
            self.pos = c + 1;
        }
    }

    fn parse_for(&mut self, end: usize) {
        self.pos += 1;
        if self.kw(self.pos, "await") {
            self.pos += 1;
        }
        if !self.p(self.pos, "(") {
            return;
        }
        let open = self.pos;
        let c = self.close(open, end);
        let mut j = open + 1;
        let mut split = None;
        while j < c {
            if self.p(j, ";") {
                break;
            }
            if (self.kw(j, "of") || self.kw(j, "in")) && j > open + 1 {
                split = Some(j);
                break;
            }
            if self.p(j, "(") || self.p(j, "[") || self.p(j, "{") {
                j = self.close(j, c);
            }
            j += 1;
        }
        if let Some(k) = split {
            let is_of = self.kw(k, "of");
            let iterable = self.scan_region(k + 1, c);
            let value = if is_of { Expr::ElemOf(Box::new(iterable)) } else { Expr::Neutral };
            let mut t = open + 1;
            let declares = self.kw(t, "let") || self.kw(t, "const") || self.kw(t, "var");
            if declares {
                t += 1;
            }
            self.pos = t;
            if declares {
                self.bind_target(k, Some(value));
            } else if self.ident(t) {
                let s = self.sym(self.t(t));
                self.record_assign(&Expr::Ident(s), value);
            }
        } else {
            self.pos = open + 1;
            while self.pos < c {
                let before = self.pos;
                if self.p(self.pos, ";") {
                    self.pos += 1;
                    continue;
                }
                if self.kw(self.pos, "let") || self.kw(self.pos, "const") || self.kw(self.pos, "var") {
                    self.parse_var_decls(c);
                } else {
                    self.parse_expr(c);
                }
                if self.pos <= before {
                    self.pos = before + 1;
                }
            }
        }
        self.pos = c + 1;
    }

    fn parse_function(&mut self, end: usize) -> Expr {
        self.pos += 1;
        if self.p(self.pos, "*") {
            self.pos += 1;
        }
        let name = if self.ident(self.pos) && !self.p(self.pos + 1, "=>") {
            let s = self.sym(self.t(self.pos));
            self.pos += 1;
            Some(s)
        } else {
            None
        };
        let fid = self.parse_callable(name, end);
        Expr::Func(fid)
    }

    /// Parses `<T>(params): Ret { body }` starting at the generics or the parameter list.
    fn parse_callable(&mut self, name: Option<Sym>, end: usize) -> u32 {
        self.skip_generics(end);
        let (fid, saved) = self.begin_func(name);
        if self.p(self.pos, "(") {
            let open = self.pos;
            let c = self.close(open, end);
            self.parse_params(open, c, fid);
            self.pos = c + 1;
            if self.p(self.pos, ":") {
                self.pos += 1;
                self.f.funcs[fid as usize].ret_ty = self.parse_type(end);
            }
            if self.p(self.pos, "{") {
                let c = self.close(self.pos, end);
                self.pos += 1;
                self.parse_stmts(c);
                self.pos = c + 1;
            }
        }
        self.end_func(saved);
        fid
    }

    fn parse_params(&mut self, open: usize, close: usize, fid: u32) {
        self.pos = open + 1;
        let mut idx = 0u32;
        while self.pos < close {
            if self.p(self.pos, ",") {
                self.pos += 1;
                continue;
            }
            if self.p(self.pos, "@") {
                self.pos += 1;
                self.parse_postfix(close, false);
                continue;
            }
            let mut is_member = false;
            while PARAM_MODIFIERS.contains(&self.t(self.pos)) && self.ident(self.pos + 1) {
                is_member = true;
                self.pos += 1;
            }
            if self.p(self.pos, "...") {
                self.pos += 1;
            }
            if self.kw(self.pos, "this") && self.p(self.pos + 1, ":") {
                self.pos += 2;
                self.parse_type(close);
                self.recover_to_comma(close);
                continue;
            }
            let name = if self.ident(self.pos) {
                let s = self.sym(self.t(self.pos));
                self.pos += 1;
                Some(s)
            } else if self.p(self.pos, "{") || self.p(self.pos, "[") {
                let pat_open = self.pos;
                let c = self.close(pat_open, close);
                self.bind_pattern(pat_open, c, Some(&Expr::Other));
                self.pos = c + 1;
                None
            } else {
                self.recover_to_comma(close);
                continue;
            };
            if self.p(self.pos, "?") {
                self.pos += 1;
            }
            let ty = if self.p(self.pos, ":") {
                self.pos += 1;
                self.parse_type(close)
            } else {
                None
            };
            if self.p(self.pos, "=") {
                self.pos += 1;
                self.parse_assign(close);
            }
            let scope = self.scope;
            let source = Source { scope, ty, value: None, param: Some((fid, idx)) };
            let src_id = match name {
                Some(n) => self.declare(n, source),
                None => self.add_source(source),
            };
            let placeholder = self.sym("");
            let func = &mut self.f.funcs[fid as usize];
            func.params.push(name.unwrap_or(placeholder));
            func.param_sources.push(src_id);
            if let (true, Some(n)) = (is_member, name) {
                self.add_member(n, ty, None);
            }
            idx += 1;
            self.recover_to_comma(close);
        }
    }

    fn parse_class(&mut self, end: usize) -> Expr {
        self.pos += 1;
        let name = if self.ident(self.pos) && !self.kw(self.pos, "extends") && !self.kw(self.pos, "implements") {
            let s = self.sym(self.t(self.pos));
            self.pos += 1;
            Some(s)
        } else {
            None
        };
        let mut j = self.pos;
        while j < end && !self.p(j, "{") {
            if self.p(j, "(") || self.p(j, "[") {
                j = self.close(j, end);
            }
            j += 1;
        }
        if j >= end {
            self.pos = end;
            return Expr::Other;
        }
        let c = self.close(j, end);
        let saved = std::mem::replace(&mut self.class, name);
        self.parse_class_body(j + 1, c);
        self.class = saved;
        self.pos = c + 1;
        Expr::Other
    }

    fn parse_class_body(&mut self, from: usize, close: usize) {
        self.pos = from;
        while self.pos < close {
            let before = self.pos;
            self.parse_class_member(close);
            if self.pos <= before {
                self.pos = before + 1;
            }
        }
    }

    fn parse_class_member(&mut self, close: usize) {
        if self.p(self.pos, ";") || self.p(self.pos, ",") {
            self.pos += 1;
            return;
        }
        if self.p(self.pos, "@") {
            self.pos += 1;
            self.parse_postfix(close, false);
            return;
        }
        let mut is_getter = false;
        while CLASS_MODIFIERS.contains(&self.t(self.pos))
            && (self.ident(self.pos + 1)
                || self.is_kind(self.pos + 1, TokKind::Str)
                || self.p(self.pos + 1, "[")
                || self.p(self.pos + 1, "#")
                || self.p(self.pos + 1, "*"))
        {
            if self.t(self.pos) == "get" {
                is_getter = true;
            }
            self.pos += 1;
        }
        if self.kw(self.pos, "static") && self.p(self.pos + 1, "{") {
            self.pos += 1;
            let c = self.close(self.pos, close);
            self.pos += 1;
            self.parse_stmts(c);
            self.pos = c + 1;
            return;
        }
        if self.p(self.pos, "*") || self.p(self.pos, "#") {
            self.pos += 1;
        }
        let Some(name) = self.property_name(close) else {
            return;
        };
        if self.p(self.pos, "?") || self.p(self.pos, "!") {
            self.pos += 1;
        }
        if self.p(self.pos, "(") || self.p(self.pos, "<") {
            let fid = self.parse_callable(name, close);
            if let (true, Some(n)) = (is_getter, name) {
                let ty = self.f.funcs[fid as usize].ret_ty;
                self.add_member(n, ty, Some(Expr::FuncResult(fid)));
            }
            return;
        }
        let ty = if self.p(self.pos, ":") {
            self.pos += 1;
            self.parse_type(close)
        } else {
            None
        };
        let init = if self.p(self.pos, "=") {
            self.pos += 1;
            Some(self.parse_assign(close))
        } else {
            None
        };
        if let Some(n) = name {
            self.add_member(n, ty, init);
        }
    }

    // ----- types -----

    /// Parses a type annotation and returns it when it names a single row-like type.
    fn parse_type(&mut self, end: usize) -> Option<Ty> {
        let mut found: Option<Ty> = None;
        let mut other = false;
        if self.p(self.pos, "|") || self.p(self.pos, "&") {
            self.pos += 1;
        }
        loop {
            match self.parse_type_atom(end) {
                TyAtom::Nullish => {}
                TyAtom::Ty(t) => {
                    if found.is_some_and(|f| f != t) {
                        other = true;
                    }
                    found = Some(t);
                }
                TyAtom::Other => other = true,
            }
            if self.pos < end && (self.p(self.pos, "|") || self.p(self.pos, "&")) {
                self.pos += 1;
                continue;
            }
            break;
        }
        if other {
            None
        } else {
            found
        }
    }

    fn parse_type_atom(&mut self, end: usize) -> TyAtom {
        if self.pos >= end {
            return TyAtom::Other;
        }
        let i = self.pos;
        let mut atom = if self.p(i, "(") {
            self.pos = self.close(i, end) + 1;
            if self.p(self.pos, "=>") {
                self.pos += 1;
                self.parse_type(end);
            }
            TyAtom::Other
        } else if self.p(i, "{") {
            let c = self.close(i, end);
            // `{ [key: number]: XxxData }`
            let mapped = self.p(i + 1, "[") && {
                let ic = self.close(i + 1, c);
                self.p(ic + 1, ":") && self.ident(ic + 2) && (self.p(ic + 3, "}") || self.p(ic + 3, ";") || self.p(ic + 3, ",")) && ic + 3 >= c.saturating_sub(1)
            };
            let atom = if mapped {
                let ic = self.close(i + 1, c);
                let s = self.sym(self.t(ic + 2));
                TyAtom::Ty(Ty::Map(s))
            } else {
                TyAtom::Other
            };
            self.pos = c + 1;
            atom
        } else if self.p(i, "[") {
            self.pos = self.close(i, end) + 1;
            TyAtom::Other
        } else if self.ident(i) {
            match self.t(i) {
                "null" | "undefined" | "void" | "never" => {
                    self.pos += 1;
                    TyAtom::Nullish
                }
                "typeof" | "keyof" | "unique" | "infer" => {
                    self.pos += 1;
                    self.parse_type_atom(end);
                    TyAtom::Other
                }
                "readonly" => {
                    self.pos += 1;
                    self.parse_type_atom(end)
                }
                "new" => {
                    self.pos += 1;
                    self.parse_type_atom(end);
                    TyAtom::Other
                }
                _ => self.parse_type_ref(end),
            }
        } else {
            self.pos += 1;
            TyAtom::Other
        };
        while self.pos < end && self.p(self.pos, "[") {
            if self.p(self.pos + 1, "]") {
                self.pos += 2;
                atom = match atom {
                    TyAtom::Ty(Ty::Row(s)) => TyAtom::Ty(Ty::Rows(s)),
                    TyAtom::Nullish => TyAtom::Nullish,
                    _ => TyAtom::Other,
                };
            } else {
                self.pos = self.close(self.pos, end) + 1;
                atom = TyAtom::Other;
            }
        }
        atom
    }

    fn parse_type_ref(&mut self, end: usize) -> TyAtom {
        let mut name = self.t(self.pos);
        self.pos += 1;
        while self.p(self.pos, ".") && self.ident(self.pos + 1) {
            name = self.t(self.pos + 1);
            self.pos += 2;
        }
        let mut args = Vec::new();
        if self.p(self.pos, "<") {
            self.pos += 1;
            while self.pos < end && !self.p(self.pos, ">") {
                let before = self.pos;
                args.push(self.parse_type(end));
                if self.p(self.pos, ",") {
                    self.pos += 1;
                }
                if self.pos <= before {
                    self.pos = before + 1;
                }
            }
            self.pos += 1;
        }
        match (name, args.as_slice()) {
            ("Array" | "ReadonlyArray", [Some(Ty::Row(s))]) => TyAtom::Ty(Ty::Rows(*s)),
            ("Promise", [Some(t)]) => TyAtom::Ty(*t),
            ("Record", [_, Some(Ty::Row(s))]) => TyAtom::Ty(Ty::Map(*s)),
            (_, []) => {
                let s = self.sym(name);
                TyAtom::Ty(Ty::Row(s))
            }
            _ => TyAtom::Other,
        }
    }

    /// Tries `<T, U>` type arguments followed by `(`; restores on failure.
    fn try_type_args(&mut self, end: usize) -> Option<Option<Ty>> {
        let saved = self.pos;
        self.pos += 1;
        let mut first = None;
        let mut n = 0;
        while self.pos < end && !self.p(self.pos, ">") {
            let before = self.pos;
            let t = self.parse_type(end);
            if n == 0 {
                first = t;
            }
            n += 1;
            if self.p(self.pos, ",") {
                self.pos += 1;
            } else if !self.p(self.pos, ">") || self.pos <= before {
                self.pos = saved;
                return None;
            }
        }
        if self.p(self.pos, ">") && self.p(self.pos + 1, "(") {
            self.pos += 1;
            Some(first)
        } else {
            self.pos = saved;
            None
        }
    }

    // ----- expressions -----

    fn parse_expr(&mut self, end: usize) -> Expr {
        let mut e = self.parse_assign(end);
        while self.pos < end && self.p(self.pos, ",") {
            self.pos += 1;
            e = self.parse_assign(end);
        }
        e
    }

    fn parse_assign(&mut self, end: usize) -> Expr {
        if self.pos >= end {
            return Expr::Other;
        }
        if let Some(e) = self.try_arrow(end) {
            return e;
        }
        let lhs = self.parse_cond(end);
        if self.pos < end && self.is_kind(self.pos, TokKind::Punct) {
            let op = self.t(self.pos);
            if matches!(op, "=" | "||=" | "??=" | "&&=" | "+=" | "-=" | "*=" | "/=" | "%=" | "**=" | "<<=" | "&=" | "|=" | "^=") {
                self.pos += 1;
                let rhs = self.parse_assign(end);
                let recorded = if matches!(op, "=" | "||=" | "??=") { rhs.clone() } else { Expr::Other };
                self.record_assign(&lhs, recorded);
                return rhs;
            }
            if op == ">" && self.p(self.pos + 1, ">=") {
                self.pos += 2;
                self.parse_assign(end);
                self.record_assign(&lhs, Expr::Other);
                return Expr::Other;
            }
        }
        lhs
    }

    fn parse_cond(&mut self, end: usize) -> Expr {
        let c = self.parse_binary(1, end);
        if self.pos < end && self.p(self.pos, "?") {
            self.pos += 1;
            let a = self.parse_assign(end);
            if self.p(self.pos, ":") {
                self.pos += 1;
                let b = self.parse_assign(end);
                return Expr::Union(vec![a, b]);
            }
            return Expr::Other;
        }
        c
    }

    fn binop(&self, i: usize) -> Option<(BinOp, u8, usize)> {
        let tok = self.toks.get(i)?;
        let text = self.t(i);
        if tok.kind == TokKind::Ident {
            return matches!(text, "instanceof" | "in").then_some((BinOp::Other, 7, 1));
        }
        if tok.kind != TokKind::Punct {
            return None;
        }
        Some(match text {
            "||" | "??" => (BinOp::Or, 1, 1),
            "&&" => (BinOp::And, 2, 1),
            "|" => (BinOp::Other, 3, 1),
            "^" => (BinOp::Other, 4, 1),
            "&" => (BinOp::Other, 5, 1),
            "==" | "===" => (BinOp::Eq, 6, 1),
            "!=" | "!==" => (BinOp::Other, 6, 1),
            "<" | "<=" | ">=" => (BinOp::Other, 7, 1),
            ">" => {
                let glued = |j: usize| self.p(j, ">") && self.toks[j].start == self.toks[j - 1].end;
                if glued(i + 1) {
                    if self.p(i + 2, ">=") || self.p(i + 2, "=") {
                        return None;
                    }
                    (BinOp::Other, 8, if glued(i + 2) { 3 } else { 2 })
                } else {
                    (BinOp::Other, 7, 1)
                }
            }
            "<<" => (BinOp::Other, 8, 1),
            "+" | "-" => (BinOp::Other, 9, 1),
            "*" | "/" | "%" => (BinOp::Other, 10, 1),
            "**" => (BinOp::Other, 11, 1),
            _ => return None,
        })
    }

    fn parse_binary(&mut self, min_prec: u8, end: usize) -> Expr {
        let mut left = self.parse_unary(end);
        loop {
            if self.pos >= end {
                break;
            }
            if (self.kw(self.pos, "as") || self.kw(self.pos, "satisfies")) && self.line(self.pos) == self.line(self.pos - 1) {
                let is_as = self.kw(self.pos, "as");
                self.pos += 1;
                if self.kw(self.pos, "const") {
                    self.pos += 1;
                    continue;
                }
                let ty = self.parse_type(end);
                if let (true, Some(ty)) = (is_as, ty) {
                    left = Expr::Typed(Box::new(left), ty);
                }
                continue;
            }
            let Some((op, prec, ntoks)) = self.binop(self.pos) else { break };
            if prec < min_prec {
                break;
            }
            self.pos += ntoks;
            let right = self.parse_binary(prec + 1, end);
            left = match op {
                BinOp::Or => match left {
                    Expr::Union(mut v) => {
                        v.push(right);
                        Expr::Union(v)
                    }
                    l => Expr::Union(vec![l, right]),
                },
                BinOp::And => match left {
                    Expr::And(mut v) => {
                        v.push(right);
                        Expr::And(v)
                    }
                    l => Expr::And(vec![l, right]),
                },
                BinOp::Eq => Expr::Eq(Box::new(left), Box::new(right)),
                BinOp::Other => Expr::Other,
            };
        }
        left
    }

    fn parse_unary(&mut self, end: usize) -> Expr {
        if self.pos >= end {
            return Expr::Other;
        }
        let i = self.pos;
        let tok = self.toks[i];
        if tok.kind == TokKind::Punct {
            match self.t(i) {
                "!" | "-" | "~" | "++" | "--" => {
                    self.pos += 1;
                    self.parse_unary(end);
                    return Expr::Other;
                }
                "+" => {
                    self.pos += 1;
                    return self.parse_unary(end);
                }
                "..." => {
                    self.pos += 1;
                    self.parse_assign(end);
                    return Expr::Other;
                }
                "<" => {
                    let saved = self.pos;
                    self.pos += 1;
                    let ty = self.parse_type(end);
                    if self.p(self.pos, ">") {
                        self.pos += 1;
                        let inner = self.parse_unary(end);
                        return match ty {
                            Some(ty) => Expr::Typed(Box::new(inner), ty),
                            None => inner,
                        };
                    }
                    self.pos = saved;
                    return Expr::Other;
                }
                _ => {}
            }
        } else if tok.kind == TokKind::Ident {
            match self.t(i) {
                "typeof" | "void" | "delete" if !self.p(i + 1, ".") && !self.p(i + 1, ",") && !self.p(i + 1, ")") => {
                    self.pos += 1;
                    self.parse_unary(end);
                    return Expr::Other;
                }
                "await" if !self.p(i + 1, ".") && !self.p(i + 1, ",") && !self.p(i + 1, ")") && !self.p(i + 1, ";") => {
                    self.pos += 1;
                    return self.parse_unary(end);
                }
                "yield" => {
                    self.pos += 1;
                    if self.p(self.pos, "*") {
                        self.pos += 1;
                    }
                    if self.pos < end && !self.p(self.pos, ")") && !self.p(self.pos, ";") && !self.p(self.pos, "}") {
                        self.parse_assign(end);
                    }
                    return Expr::Other;
                }
                "new" if !self.p(i + 1, ".") => {
                    self.pos += 1;
                    self.parse_postfix(end, true);
                    return Expr::Other;
                }
                _ => {}
            }
        }
        self.parse_postfix(end, false)
    }

    fn parse_postfix(&mut self, end: usize, is_new: bool) -> Expr {
        let start = self.pos;
        let mut e = self.parse_primary(end);
        let mut type_arg: Option<Ty> = None;
        let mut first_call = true;
        while self.pos < end {
            let i = self.pos;
            let tok = self.toks[i];
            if tok.kind == TokKind::Template {
                self.scan_template_refs(i);
                self.pos += 1;
                e = Expr::Other;
                continue;
            }
            if tok.kind != TokKind::Punct {
                break;
            }
            match self.t(i) {
                "." | "?." if self.ident(i + 1) || (self.t(i) == "." && self.p(i + 1, "#") && self.ident(i + 2)) => {
                    let name_at = if self.p(i + 1, "#") { i + 2 } else { i + 1 };
                    let name = self.t(name_at);
                    self.pos = name_at + 1;
                    e = match &e {
                        Expr::Ident(s) if TABLE_REF_OBJECTS.contains(&self.f.sym(*s)) => {
                            self.add_table_ref(name);
                            Expr::TableRef(self.sym(name))
                        }
                        _ => {
                            let s = self.sym(name);
                            Expr::Member(Box::new(e), s)
                        }
                    };
                }
                "?." if self.p(i + 1, "(") || self.p(i + 1, "[") => {
                    self.pos = i + 1;
                }
                "[" => {
                    let c = self.close(i, end);
                    let line = self.line(i + 1);
                    let index = self.scan_region(i + 1, c);
                    self.pos = c + 1;
                    let as_table = match (&e, &index) {
                        (Expr::Ident(s), Expr::Str(k)) if TABLE_REF_OBJECTS.contains(&self.f.sym(*s)) => Some(*k),
                        _ => None,
                    };
                    if let Some(k) = as_table {
                        let name = self.f.sym(k).to_owned();
                        self.add_table_ref(&name);
                        e = Expr::TableRef(k);
                        continue;
                    }
                    if !matches!(e, Expr::Neutral | Expr::Str(_) | Expr::Other | Expr::TableRef(_) | Expr::StrList(_)) {
                        let cand = IndexCandidate {
                            order: i as u32,
                            scope: self.scope,
                            line,
                            text_hash: self.hash_tokens(start, c),
                            funcs: self.func_stack.clone().into_boxed_slice(),
                            base: prune(e.clone()),
                            index: prune(index.clone()),
                        };
                        self.pending_index.push(cand);
                    }
                    e = Expr::Index(Box::new(e), Box::new(index));
                }
                "(" => {
                    let c = self.close(i, end);
                    let args = self.parse_args(i, c);
                    self.pos = c + 1;
                    e = self.on_call(e, args, start, i, c, type_arg.take(), is_new && first_call);
                    first_call = false;
                }
                "<" => match self.try_type_args(end) {
                    Some(t) => type_arg = t,
                    None => break,
                },
                "!" if self.line(i) == self.line(i - 1) => self.pos += 1,
                "++" | "--" if self.line(i) == self.line(i - 1) => {
                    self.pos += 1;
                    e = Expr::Other;
                    break;
                }
                _ => break,
            }
        }
        e
    }

    fn scan_template_refs(&mut self, i: usize) {
        let raw = self.t(i);
        for marker in ["__Prop__.", "Prop."] {
            let mut from = 0;
            while let Some(at) = raw[from..].find(marker) {
                let abs = from + at;
                from = abs + marker.len();
                if abs > 0 && is_ident_byte(raw.as_bytes()[abs - 1]) {
                    continue;
                }
                let rest = &raw[from..];
                let len = rest.bytes().take_while(|b| is_ident_byte(*b)).count();
                if len > 0 {
                    self.add_table_ref(&rest[..len]);
                }
            }
        }
    }

    fn parse_args(&mut self, open: usize, close: usize) -> Vec<(Expr, u32)> {
        self.pos = open + 1;
        let mut args = Vec::new();
        while self.pos < close {
            if self.p(self.pos, ",") {
                self.pos += 1;
                continue;
            }
            let line = self.line(self.pos);
            let e = self.parse_assign(close);
            args.push((e, line));
            self.recover_to_comma(close);
        }
        args
    }

    fn parse_primary(&mut self, end: usize) -> Expr {
        let i = self.pos;
        let Some(tok) = self.toks.get(i).copied() else { return Expr::Other };
        match tok.kind {
            TokKind::Num | TokKind::Regex => {
                self.pos += 1;
                Expr::Neutral
            }
            TokKind::Str => {
                self.pos += 1;
                Expr::Str(self.sym(self.str_value(i)))
            }
            TokKind::Template => {
                self.scan_template_refs(i);
                self.pos += 1;
                // requireProp(`../props/${__Prop__.heroprop}`) is a static
                // table path. Arbitrary interpolation remains untraced.
                let text = self.t(i).trim_matches('`');
                let reference = ["${__Prop__.", "${Prop."].iter().find_map(|prefix| {
                    let (before, after) = text.split_once(prefix)?;
                    if before.contains("${") { return None; }
                    let name = after.strip_suffix('}')?;
                    name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_').then_some(name)
                });
                if let Some(name) = reference { Expr::TableRef(self.sym(name)) }
                else if !text.contains("${") { Expr::Str(self.sym(text)) }
                else { Expr::Other }
            }
            TokKind::Ident => match self.t(i) {
                "true" | "false" | "null" | "undefined" | "NaN" | "Infinity" => {
                    self.pos += 1;
                    Expr::Neutral
                }
                "this" => {
                    self.pos += 1;
                    Expr::This
                }
                "function" => self.parse_function(end),
                "class" => self.parse_class(end),
                word => {
                    self.pos += 1;
                    Expr::Ident(self.sym(word))
                }
            },
            TokKind::Punct => match self.t(i) {
                "(" => {
                    let c = self.close(i, end);
                    let inner = self.scan_region(i + 1, c);
                    self.pos = c + 1;
                    inner
                }
                "[" => self.parse_array(i, end),
                "{" => self.parse_object(i, end),
                _ => Expr::Other,
            },
        }
    }

    fn parse_array(&mut self, open: usize, end: usize) -> Expr {
        let c = self.close(open, end);
        self.pos = open + 1;
        let mut strs = Vec::new();
        let mut all_str = true;
        let mut count = 0;
        while self.pos < c {
            if self.p(self.pos, ",") {
                self.pos += 1;
                continue;
            }
            let e = self.parse_assign(c);
            count += 1;
            match e {
                Expr::Str(s) => strs.push(s),
                _ => all_str = false,
            }
            self.recover_to_comma(c);
        }
        self.pos = c + 1;
        if count == 0 {
            Expr::Neutral
        } else if all_str {
            Expr::StrList(strs)
        } else {
            Expr::Other
        }
    }

    /// Consumes the property name at the cursor. `Some(None)` is a computed
    /// `[key]`, scanned for lookups but unnamed; `None` means no name here.
    fn property_name(&mut self, end: usize) -> Option<Option<Sym>> {
        if self.ident(self.pos) {
            let s = self.sym(self.t(self.pos));
            self.pos += 1;
            return Some(Some(s));
        }
        if self.is_kind(self.pos, TokKind::Str) || self.is_kind(self.pos, TokKind::Num) {
            let s = self.sym(self.str_value(self.pos));
            self.pos += 1;
            return Some(Some(s));
        }
        if self.p(self.pos, "[") {
            let c = self.close(self.pos, end);
            self.scan_region(self.pos + 1, c);
            self.pos = c + 1;
            return Some(None);
        }
        None
    }

    fn parse_object(&mut self, open: usize, end: usize) -> Expr {
        let c = self.close(open, end);
        self.pos = open + 1;
        let mut entries = Vec::new();
        while self.pos < c {
            if self.p(self.pos, ",") {
                self.pos += 1;
                continue;
            }
            if self.p(self.pos, "...") {
                self.pos += 1;
                self.parse_assign(c);
                self.recover_to_comma(c);
                continue;
            }
            if matches!(self.t(self.pos), "get" | "set" | "async")
                && self.ident(self.pos)
                && (self.ident(self.pos + 1) || self.is_kind(self.pos + 1, TokKind::Str) || self.p(self.pos + 1, "["))
            {
                self.pos += 1;
            }
            if self.p(self.pos, "*") {
                self.pos += 1;
            }
            let Some(key) = self.property_name(c) else {
                self.recover_to_comma(c);
                continue;
            };
            if self.p(self.pos, ":") {
                self.pos += 1;
                let line = self.line(self.pos);
                let value = self.parse_assign(c);
                if let Some(key) = key {
                    entries.push(ObjEntry { key, value, line });
                }
            } else if self.p(self.pos, "(") || self.p(self.pos, "<") {
                self.parse_callable(key, c);
            } else if self.p(self.pos, "=") {
                self.pos += 1;
                self.parse_assign(c);
            } else if let Some(key) = key {
                let line = self.line(self.pos.saturating_sub(1));
                entries.push(ObjEntry { key, value: Expr::Ident(key), line });
            }
            self.recover_to_comma(c);
        }
        self.pos = c + 1;
        Expr::Obj(entries)
    }

    fn try_arrow(&mut self, end: usize) -> Option<Expr> {
        let mut i = self.pos;
        if self.kw(i, "async") && (self.ident(i + 1) || self.p(i + 1, "(")) {
            i += 1;
        }
        if self.ident(i) && self.p(i + 1, "=>") && !RESERVED.contains(&self.t(i)) {
            let name = self.sym(self.t(i));
            let (fid, saved) = self.begin_func(None);
            let scope = self.scope;
            let src = self.declare(name, Source { scope, ty: None, value: None, param: Some((fid, 0)) });
            let func = &mut self.f.funcs[fid as usize];
            func.params.push(name);
            func.param_sources.push(src);
            self.pos = i + 2;
            self.parse_arrow_body(end);
            self.end_func(saved);
            return Some(Expr::Func(fid));
        }
        if !self.p(i, "(") {
            return None;
        }
        let c = self.close(i, end);
        let (body_at, ret_ty) = if self.p(c + 1, "=>") {
            (c + 2, None)
        } else if self.p(c + 1, ":") {
            let saved = self.pos;
            self.pos = c + 2;
            let ty = self.parse_type(end);
            let at = self.p(self.pos, "=>").then_some(self.pos + 1);
            self.pos = saved;
            match at {
                Some(at) => (at, ty),
                None => return None,
            }
        } else {
            return None;
        };
        let (fid, saved) = self.begin_func(None);
        self.parse_params(i, c, fid);
        self.f.funcs[fid as usize].ret_ty = ret_ty;
        self.pos = body_at;
        self.parse_arrow_body(end);
        self.end_func(saved);
        Some(Expr::Func(fid))
    }

    fn parse_arrow_body(&mut self, end: usize) {
        if self.p(self.pos, "{") {
            let c = self.close(self.pos, end);
            self.pos += 1;
            self.parse_stmts(c);
            self.pos = c + 1;
        } else {
            let e = self.parse_assign(end);
            self.add_return(e);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn on_call(&mut self, callee: Expr, args: Vec<(Expr, u32)>, start: usize, open: usize, close: usize, type_arg: Option<Ty>, is_new: bool) -> Expr {
        let (name, recv) = callee_parts(&callee);
        if let Some(name) = name {
            let name_str = self.f.sym(name);
            let is_table_func = TABLE_FUNCS.contains(&name_str);
            let is_keyed = KEYED_LOOKUP_FUNCS.contains(&name_str);
            let is_callback = CALLBACK_METHODS.contains(&name_str);
            let is_pred = PREDICATE_METHODS.contains(&name_str);
            let blacklisted = is_blacklisted_call(name_str) || name_str.len() < 3;
            let table = match args.first() {
                Some((Expr::TableRef(s) | Expr::Str(s), _)) if is_table_func => Some(*s),
                _ => None,
            };
            if let Some(table) = table {
                let table_name = self.f.sym(table).to_owned();
                self.add_table_ref(&table_name);
                if is_keyed {
                    let key_sym = self.sym("key");
                    let value_sym = self.sym("value");
                    let mut pairs = Vec::new();
                    for (arg, _) in &args[1..] {
                        let Expr::Obj(entries) = arg else { continue };
                        let key = entries.iter().find(|en| en.key == key_sym).and_then(|en| match en.value {
                            Expr::Str(k) => Some(k),
                            _ => None,
                        });
                        let value = entries.iter().find(|en| en.key == value_sym);
                        if let (Some(key), Some(value)) = (key, value) {
                            pairs.push((key, prune(value.value.clone()), value.line));
                        }
                    }
                    if !pairs.is_empty() {
                        let hash = self.hash_tokens(start, close);
                        self.push_site(open, self.line(open), hash, SiteKind::Direct { table, pairs });
                    }
                }
            } else if is_table_func && !matches!(args.first(), Some((Expr::Ident(_) | Expr::Member(..), _))) {
                // Dynamic table name: not a static lookup.
            } else if let (true, Expr::Member(recv_expr, _), Some((Expr::Func(fid), _))) = (is_callback, &callee, args.first()) {
                let fid = *fid;
                let func = &self.f.funcs[fid as usize];
                if let Some(&src) = func.param_sources.first() {
                    let source = &mut self.f.sources[src as usize];
                    if source.ty.is_none() {
                        source.value = Some(Expr::ElemOf(Box::new(prune((**recv_expr).clone()))));
                        source.scope = self.scope;
                    }
                }
                let func = &self.f.funcs[fid as usize];
                if is_pred && func.returns.len() == 1 && !func.params.is_empty() {
                    let hash = self.hash_tokens(start, close);
                    let recv = prune((**recv_expr).clone());
                    self.push_site(open, self.line(open), hash, SiteKind::Pred { recv, func: fid });
                }
            } else if !is_new && !blacklisted && args.iter().any(|(a, _)| !matches!(a, Expr::Neutral | Expr::Str(_) | Expr::StrList(_) | Expr::Func(_) | Expr::Obj(_))) {
                let hash = self.hash_tokens(start, close);
                let stored: Vec<(Expr, u32)> = args.iter().map(|(a, l)| (prune(a.clone()), *l)).collect();
                self.push_site(open, self.line(open), hash, SiteKind::Call { name, recv, args: stored });
            }
        }
        Expr::Call(Box::new(CallExpr { callee: prune(callee), args: args.into_iter().map(|(a, _)| prune(a)).collect(), type_arg }))
    }

    // ----- finishing -----

    fn finish(mut self) -> FileFacts {
        for (scope, name, value) in std::mem::take(&mut self.pending_assigns) {
            let mut s = scope;
            let target = loop {
                if self.declared.contains(&(s, name)) {
                    break s;
                }
                if s == 0 {
                    break 0;
                }
                s = self.f.scope_parent[s as usize];
            };
            let id = self.add_source(Source { scope, ty: None, value: Some(value), param: None });
            self.f.bindings.entry((target, name)).or_default().push(id);
        }

        let map_call_syms: Vec<Sym> = ["getTableByName", "getPropByKeys"].iter().filter_map(|n| self.intern.get(*n).copied()).collect();
        let mut mapish_names: HashSet<Sym> = HashSet::new();
        let mut mapish_members: HashSet<Sym> = HashSet::new();
        let is_mapish = |src: &Source| matches!(src.ty, Some(Ty::Map(_))) || src.value.as_ref().is_some_and(|v| contains_call(v, &map_call_syms));
        for ((_, name), ids) in &self.f.bindings {
            if ids.iter().any(|&id| is_mapish(&self.f.sources[id as usize])) {
                mapish_names.insert(*name);
            }
        }
        for (name, ids) in &self.f.members {
            if ids.iter().any(|&id| is_mapish(&self.f.sources[id as usize])) {
                mapish_members.insert(*name);
            }
        }
        for cand in std::mem::take(&mut self.pending_index) {
            let keep = match index_root(&cand.base) {
                IndexRoot::Ident(s) => mapish_names.contains(&s),
                IndexRoot::Member(s) => mapish_members.contains(&s),
                IndexRoot::Expr(e) => contains_call(e, &map_call_syms),
            };
            if keep {
                self.f.sites.push(Site {
                    order: cand.order,
                    scope: cand.scope,
                    line: cand.line,
                    text_hash: cand.text_hash,
                    funcs: cand.funcs,
                    kind: SiteKind::Index { base: cand.base, index: cand.index },
                });
            }
        }
        self.f.sites.sort_by_key(|s| s.order);

        let mut lines: BTreeSet<u32> = BTreeSet::new();
        for (i, site) in self.f.sites.iter().enumerate() {
            for &fid in site.funcs.iter() {
                self.f.sites_by_func.entry(fid).or_default().push(i as u32);
            }
            match &site.kind {
                SiteKind::Direct { pairs, .. } => lines.extend(pairs.iter().map(|p| p.2)),
                SiteKind::Call { args, .. } => lines.extend(args.iter().map(|a| a.1)),
                SiteKind::Index { .. } | SiteKind::Pred { .. } => {
                    lines.insert(site.line);
                }
            }
        }
        let line_starts = line_starts(self.src);
        for line in lines {
            self.f.snippets.insert(line, snippet_at(self.src, &line_starts, line).into());
        }
        for (i, func) in self.f.funcs.iter().enumerate() {
            if let Some(name) = func.name {
                self.f.funcs_by_name.entry(name).or_default().push(i as u32);
            }
        }
        self.f.table_refs = std::mem::take(&mut self.table_refs).into_iter().collect();
        self.f
    }
}

enum TyAtom {
    Nullish,
    Ty(Ty),
    Other,
}

#[derive(Clone, Copy)]
enum BinOp {
    Or,
    And,
    Eq,
    Other,
}

enum IndexRoot<'e> {
    Ident(Sym),
    Member(Sym),
    Expr(&'e Expr),
}

fn index_root(e: &Expr) -> IndexRoot<'_> {
    match e {
        Expr::Index(b, _) | Expr::Typed(b, _) => index_root(b),
        Expr::Ident(s) => IndexRoot::Ident(*s),
        Expr::Member(b, s) if matches!(b.as_ref(), Expr::This) => IndexRoot::Member(*s),
        other => IndexRoot::Expr(other),
    }
}

fn contains_call(e: &Expr, names: &[Sym]) -> bool {
    if names.is_empty() {
        return false;
    }
    match e {
        Expr::Call(c) => callee_parts(&c.callee).0.is_some_and(|n| names.contains(&n)) || contains_call(&c.callee, names),
        Expr::Member(b, _) | Expr::Typed(b, _) | Expr::ElemOf(b) | Expr::Index(b, _) => contains_call(b, names),
        Expr::Union(v) => v.iter().any(|x| contains_call(x, names)),
        _ => false,
    }
}

fn line_starts(src: &str) -> Vec<usize> {
    std::iter::once(0).chain(src.bytes().enumerate().filter(|(_, b)| *b == b'\n').map(|(i, _)| i + 1)).collect()
}

fn snippet_at(src: &str, starts: &[usize], line: u32) -> String {
    let Some(&start) = starts.get(line.saturating_sub(1) as usize) else { return String::new() };
    let end = starts.get(line as usize).map_or(src.len(), |&e| e.saturating_sub(1));
    let text = src.get(start..end.max(start)).unwrap_or("").trim();
    text.chars().take(SNIPPET_MAX_CHARS).collect()
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

struct Tables {
    names: Vec<String>,
    cols: Vec<Vec<String>>,
    by_name: HashMap<String, u32>,
    col_by_lower: Vec<HashMap<String, u16>>,
    first_key: Vec<Option<u16>>,
    string_cols: Vec<Vec<bool>>,
}

impl Tables {
    fn new(columns: &TableColumns, client: &HashMap<String, ClientTable>) -> Self {
        let mut names: Vec<(String, &Vec<String>)> = columns.iter().map(|(k, v)| (k.to_ascii_lowercase(), v)).collect();
        names.sort_by(|a, b| a.0.cmp(&b.0));
        names.dedup_by(|a, b| a.0 == b.0);
        let mut tables = Tables {
            names: Vec::new(),
            cols: Vec::new(),
            by_name: HashMap::new(),
            col_by_lower: Vec::new(),
            first_key: Vec::new(),
            string_cols: Vec::new(),
        };
        for (i, (name, cols)) in names.into_iter().enumerate() {
            let col_by_lower: HashMap<String, u16> =
                cols.iter().enumerate().rev().map(|(ci, c)| (c.to_ascii_lowercase(), ci as u16)).collect();
            let info = client.get(&name);
            let first = match info.and_then(|t| t.first.as_ref()) {
                Some(first) => col_by_lower.get(&first.to_ascii_lowercase()).copied(),
                None => (!cols.is_empty()).then_some(0),
            };
            let string_cols = cols.iter().map(|c| info.is_some_and(|t| t.string_fields.contains(&c.to_ascii_lowercase()))).collect();
            tables.by_name.insert(name.clone(), i as u32);
            tables.names.push(name);
            tables.cols.push(cols.clone());
            tables.col_by_lower.push(col_by_lower);
            tables.first_key.push(first);
            tables.string_cols.push(string_cols);
        }
        tables
    }

    fn is_string(&self, table: u32, col: u16) -> bool {
        self.string_cols[table as usize][col as usize]
    }

    fn is_display_text(&self, table: u32, col: u16) -> bool {
        const SUFFIXES: &[&str] = &["name", "des", "desc", "text", "title", "tips"];
        let name = self.cols[table as usize][col as usize].to_ascii_lowercase();
        self.is_string(table, col) && SUFFIXES.iter().any(|s| name.ends_with(s))
    }

    fn table(&self, name: &str) -> Option<u32> {
        let name = name.rsplit('/').next().unwrap_or(name);
        self.by_name.get(&name.to_ascii_lowercase()).copied()
    }

    fn table_of_type(&self, type_name: &str) -> Option<u32> {
        let lower = type_name.to_ascii_lowercase();
        self.by_name.get(lower.strip_suffix("data")?).copied()
    }

    fn col(&self, table: u32, name: &str) -> Option<u16> {
        self.col_by_lower[table as usize].get(&name.to_ascii_lowercase()).copied()
    }
}

/// Abstract value of an expression.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Val {
    Unknown,
    Neutral,
    Row(u32),
    Rows(u32),
    Map { table: u32, keys: Vec<Option<u16>>, depth: u8, single: bool },
    Fields(Vec<(u32, u16)>),
    Param { file: u32, func: u32, idx: u32 },
}

fn combine(vals: impl IntoIterator<Item = Val>) -> Val {
    let mut out: Option<Val> = None;
    let mut fields: Vec<(u32, u16)> = Vec::new();
    for v in vals {
        match v {
            Val::Neutral => {}
            Val::Unknown => return Val::Unknown,
            Val::Fields(f) => {
                if out.is_some() {
                    return Val::Unknown;
                }
                fields.extend(f);
            }
            other => {
                if !fields.is_empty() {
                    return Val::Unknown;
                }
                match &out {
                    None => out = Some(other),
                    Some(o) if *o == other => {}
                    Some(_) => return Val::Unknown,
                }
            }
        }
    }
    if fields.is_empty() {
        out.unwrap_or(Val::Neutral)
    } else {
        fields.sort_unstable();
        fields.dedup();
        Val::Fields(fields)
    }
}

/// Parameter index -> (table, key column) that a wrapper's parameter feeds.
type Sig = Rc<Vec<(u32, u32, u16)>>;

struct Lookup<'a> {
    table: u32,
    col: u16,
    value: &'a Expr,
    scope: u32,
    line: u32,
}

struct Resolver<'a> {
    files: &'a [&'a FileFacts],
    tables: &'a Tables,
    global_funcs: HashMap<&'a str, Vec<(u32, u32)>>,
    /// Keyed by lowercased class name so `g_ItemMgr` / `mmgr.itemMgr` reach `class ItemMgr`.
    class_funcs: HashMap<(String, &'a str), Vec<(u32, u32)>>,
    enums: HashSet<&'a str>,
    ident_memo: HashMap<(u32, u32, Sym), Val>,
    member_memo: HashMap<(u32, Sym), Val>,
    ret_memo: HashMap<(u32, u32), Val>,
    sig_memo: HashMap<(u32, u32), Option<Sig>>,
    busy_ident: HashSet<(u32, u32, Sym)>,
    busy_member: HashSet<(u32, Sym)>,
    busy_func: HashSet<(u32, u32)>,
    busy_sig: HashSet<(u32, u32)>,
    reached: HashSet<(u32, u32)>,
    depth: u32,
}

impl<'a> Resolver<'a> {
    fn new(files: &'a [&'a FileFacts], tables: &'a Tables) -> Self {
        let mut global_funcs: HashMap<&'a str, Vec<(u32, u32)>> = HashMap::new();
        let mut class_funcs: HashMap<(String, &'a str), Vec<(u32, u32)>> = HashMap::new();
        let mut enums = HashSet::new();
        for (fi, file) in files.iter().enumerate() {
            enums.extend(file.enums.iter().map(|e| e.as_ref()));
            for (name, ids) in &file.funcs_by_name {
                let name = file.sym(*name);
                for &id in ids {
                    global_funcs.entry(name).or_default().push((fi as u32, id));
                    if let Some(class) = file.funcs[id as usize].class {
                        class_funcs.entry((file.sym(class).to_ascii_lowercase(), name)).or_default().push((fi as u32, id));
                    }
                }
            }
        }
        Resolver {
            files,
            tables,
            global_funcs,
            class_funcs,
            enums,
            ident_memo: HashMap::new(),
            member_memo: HashMap::new(),
            ret_memo: HashMap::new(),
            sig_memo: HashMap::new(),
            busy_ident: HashSet::new(),
            busy_member: HashSet::new(),
            busy_func: HashSet::new(),
            busy_sig: HashSet::new(),
            reached: HashSet::new(),
            depth: 0,
        }
    }

    fn file(&self, f: u32) -> &'a FileFacts {
        self.files[f as usize]
    }

    fn ty_val(&self, f: u32, ty: Ty) -> Option<Val> {
        let file = self.file(f);
        Some(match ty {
            Ty::Row(s) => Val::Row(self.tables.table_of_type(file.sym(s))?),
            Ty::Rows(s) => Val::Rows(self.tables.table_of_type(file.sym(s))?),
            Ty::Map(s) => {
                let table = self.tables.table_of_type(file.sym(s))?;
                Val::Map { table, keys: vec![self.tables.first_key[table as usize]], depth: 0, single: false }
            }
        })
    }

    fn table_of(&self, f: u32, e: &Expr) -> Option<u32> {
        match e {
            Expr::TableRef(s) | Expr::Str(s) => self.tables.table(self.file(f).sym(*s)),
            _ => None,
        }
    }

    fn find_bucket(&self, f: u32, scope: u32, sym: Sym) -> Option<u32> {
        let file = self.file(f);
        let mut s = scope;
        loop {
            if file.bindings.contains_key(&(s, sym)) {
                return Some(s);
            }
            if s == 0 {
                return None;
            }
            s = file.scope_parent[s as usize];
        }
    }

    fn source_val(&mut self, f: u32, src: &'a Source) -> Val {
        match (&src.value, src.param) {
            (Some(v), _) => self.eval(f, src.scope, v),
            (None, Some((func, idx))) => Val::Param { file: f, func, idx },
            (None, None) => Val::Neutral,
        }
    }

    fn typed_sources(&self, f: u32, ids: &[u32]) -> Vec<Val> {
        let file = self.file(f);
        ids.iter().filter_map(|&id| file.sources[id as usize].ty.and_then(|ty| self.ty_val(f, ty))).collect()
    }

    fn combine_sources(&mut self, f: u32, ids: &'a [u32]) -> Val {
        let typed = self.typed_sources(f, ids);
        if !typed.is_empty() {
            return combine(typed);
        }
        let file = self.file(f);
        let vals: Vec<Val> = ids.iter().map(|&id| self.source_val(f, &file.sources[id as usize])).collect();
        combine(vals)
    }

    fn eval_ident(&mut self, f: u32, scope: u32, sym: Sym) -> Val {
        let Some(bucket) = self.find_bucket(f, scope, sym) else { return Val::Unknown };
        let key = (f, bucket, sym);
        if let Some(v) = self.ident_memo.get(&key) {
            return v.clone();
        }
        if !self.busy_ident.insert(key) {
            return Val::Unknown;
        }
        let ids = &self.file(f).bindings[&(bucket, sym)];
        let v = self.combine_sources(f, ids);
        self.busy_ident.remove(&key);
        self.ident_memo.insert(key, v.clone());
        v
    }

    fn eval_member(&mut self, f: u32, sym: Sym) -> Val {
        let key = (f, sym);
        if let Some(v) = self.member_memo.get(&key) {
            return v.clone();
        }
        let Some(ids) = self.file(f).members.get(&sym) else { return Val::Unknown };
        if !self.busy_member.insert(key) {
            return Val::Unknown;
        }
        let v = self.combine_sources(f, ids);
        self.busy_member.remove(&key);
        self.member_memo.insert(key, v.clone());
        v
    }

    fn eval(&mut self, f: u32, scope: u32, e: &'a Expr) -> Val {
        if self.depth >= MAX_EVAL_DEPTH {
            return Val::Unknown;
        }
        self.depth += 1;
        let v = self.eval_inner(f, scope, e);
        self.depth -= 1;
        v
    }

    fn field_of(&self, base: Val, f: u32, col: Sym) -> Val {
        let table = match base {
            Val::Row(t) => t,
            Val::Map { table, depth: 0, single: true, .. } => table,
            _ => return Val::Unknown,
        };
        match self.tables.col(table, self.file(f).sym(col)) {
            Some(c) => Val::Fields(vec![(table, c)]),
            None => Val::Unknown,
        }
    }

    fn eval_inner(&mut self, f: u32, scope: u32, e: &'a Expr) -> Val {
        match e {
            Expr::Neutral | Expr::Str(_) | Expr::StrList(_) => Val::Neutral,
            Expr::Ident(s) => self.eval_ident(f, scope, *s),
            Expr::Member(base, col) => {
                match base.as_ref() {
                    Expr::This => return self.eval_member(f, *col),
                    Expr::Ident(s) if self.enums.contains(self.file(f).sym(*s)) && self.find_bucket(f, scope, *s).is_none() => {
                        return Val::Neutral;
                    }
                    _ => {}
                }
                let b = self.eval(f, scope, base);
                self.field_of(b, f, *col)
            }
            Expr::Index(base, _) => match self.eval(f, scope, base) {
                Val::Map { table, keys, depth, .. } => {
                    if depth as usize + 1 >= keys.len() {
                        Val::Row(table)
                    } else {
                        Val::Map { table, keys, depth: depth + 1, single: false }
                    }
                }
                Val::Rows(t) => Val::Row(t),
                _ => Val::Unknown,
            },
            Expr::ElemOf(base) => match self.eval(f, scope, base) {
                Val::Rows(t) => Val::Row(t),
                _ => Val::Unknown,
            },
            Expr::Typed(base, ty) => match self.ty_val(f, *ty) {
                Some(v) => v,
                None => self.eval(f, scope, base),
            },
            Expr::Union(items) => {
                let vals: Vec<Val> = items.iter().map(|x| self.eval(f, scope, x)).collect();
                combine(vals)
            }
            Expr::FuncResult(fid) => self.func_ret(f, *fid),
            Expr::Call(c) => self.eval_call(f, scope, c),
            Expr::This | Expr::TableRef(_) | Expr::Obj(_) | Expr::Eq(..) | Expr::And(_) | Expr::Func(_) | Expr::Other => Val::Unknown,
        }
    }

    fn eval_call(&mut self, f: u32, scope: u32, c: &'a CallExpr) -> Val {
        let (Some(name), recv) = callee_parts(&c.callee) else { return Val::Unknown };
        let file = self.file(f);
        let n = file.sym(name);
        if TABLE_FUNCS.contains(&n) {
            let table = c.args.first().and_then(|a| self.table_of(f, a)).or_else(|| match c.type_arg.and_then(|t| self.ty_val(f, t)) {
                Some(Val::Row(t)) => Some(t),
                _ => None,
            });
            if let Some(t) = table {
                return match n {
                    "getPropLine" => Val::Row(t),
                    "getTableByName" => Val::Map { table: t, keys: vec![self.tables.first_key[t as usize]], depth: 0, single: true },
                    "getPropByKeys" => match c.args.get(1) {
                        Some(Expr::StrList(keys)) if !keys.is_empty() => {
                            let keys = keys.iter().map(|k| self.tables.col(t, file.sym(*k))).collect();
                            Val::Map { table: t, keys, depth: 0, single: false }
                        }
                        _ => Val::Unknown,
                    },
                    _ => Val::Rows(t),
                };
            }
        }
        let recv_expr = match &c.callee {
            Expr::Member(b, _) => Some(b.as_ref()),
            _ => None,
        };
        match (n, recv_expr) {
            (_, None) if CONVERSION_FUNCS.contains(&n) => c.args.first().map_or(Val::Unknown, |a| self.eval(f, scope, a)),
            ("toString" | "valueOf", Some(r)) if c.args.is_empty() => self.eval(f, scope, r),
            ("values", Some(Expr::Ident(o))) if file.sym(*o) == "Object" => match c.args.first().map(|a| self.eval(f, scope, a)) {
                Some(Val::Map { table, keys, depth, .. }) if depth as usize + 1 >= keys.len() => Val::Rows(table),
                Some(Val::Rows(t)) => Val::Rows(t),
                _ => Val::Unknown,
            },
            ("find" | "findLast", Some(r)) => match self.eval(f, scope, r) {
                Val::Rows(t) => Val::Row(t),
                _ => Val::Unknown,
            },
            ("filter" | "slice" | "concat" | "sort" | "reverse", Some(r)) => match self.eval(f, scope, r) {
                Val::Rows(t) => Val::Rows(t),
                _ => Val::Unknown,
            },
            _ if is_blacklisted_call(n) => Val::Unknown,
            _ => {
                let defs = self.resolve_defs(f, name, recv);
                if defs.is_empty() || defs.len() > MAX_NAME_DEFS {
                    return Val::Unknown;
                }
                // Same-named methods on unrelated classes must agree exactly; merging
                // their fields would attribute one class's table to every caller.
                let mut out: Option<Val> = None;
                for &(df, dfn) in &defs {
                    let v = self.func_ret(df, dfn);
                    match &out {
                        None => out = Some(v),
                        Some(prev) if *prev == v => {}
                        Some(_) => return Val::Unknown,
                    }
                }
                out.unwrap_or(Val::Unknown)
            }
        }
    }

    fn func_ret(&mut self, f: u32, func: u32) -> Val {
        let key = (f, func);
        if let Some(v) = self.ret_memo.get(&key) {
            return v.clone();
        }
        if !self.busy_func.insert(key) {
            return Val::Unknown;
        }
        let info = &self.file(f).funcs[func as usize];
        let v = match info.ret_ty.and_then(|t| self.ty_val(f, t)) {
            Some(v) => v,
            None if info.returns.is_empty() => Val::Unknown,
            None => {
                let vals: Vec<Val> = info
                    .returns
                    .iter()
                    .map(|r| match self.eval(f, info.body_scope, r) {
                        Val::Param { .. } => Val::Unknown,
                        v => v,
                    })
                    .collect();
                combine(vals)
            }
        };
        self.busy_func.remove(&key);
        self.ret_memo.insert(key, v.clone());
        v
    }

    /// Function definitions a call by `name` on `recv` may reach.
    fn resolve_defs(&self, f: u32, name: Sym, recv: Recv) -> Vec<(u32, u32)> {
        let file = self.file(f);
        let n = file.sym(name);
        let global = || self.global_funcs.get(n).cloned().unwrap_or_default();
        match recv {
            Recv::None | Recv::This => match file.funcs_by_name.get(&name) {
                Some(ids) if !ids.is_empty() => ids.iter().map(|&id| (f, id)).collect(),
                _ => global(),
            },
            Recv::Ident(r) if BUILTIN_RECEIVERS.contains(&file.sym(r)) => Vec::new(),
            Recv::Ident(r) => {
                let r = file.sym(r).to_ascii_lowercase();
                let by_class = self.class_funcs.get(&(r.clone(), n)).or_else(|| {
                    r.strip_prefix("g_").and_then(|stripped| self.class_funcs.get(&(stripped.to_owned(), n)))
                });
                match by_class {
                    Some(defs) if !defs.is_empty() => defs.clone(),
                    _ => global(),
                }
            }
            Recv::Other => global(),
        }
    }

    fn resolve_call(&mut self, f: u32, name: Sym, recv: Recv) -> Option<Sig> {
        let defs = self.resolve_defs(f, name, recv);
        if defs.is_empty() || defs.len() > MAX_NAME_DEFS {
            return None;
        }
        let mut sig: Option<Sig> = None;
        for &(df, dfn) in &defs {
            let s = self.func_sig(df, dfn)?;
            match &sig {
                Some(prev) if prev != &s => return None,
                Some(_) => {}
                None => sig = Some(s),
            }
        }
        self.reached.extend(defs);
        sig
    }

    /// Which parameters of `func` flow unchanged into lookup keys.
    fn func_sig(&mut self, f: u32, func: u32) -> Option<Sig> {
        let key = (f, func);
        if let Some(s) = self.sig_memo.get(&key) {
            return s.clone();
        }
        if !self.busy_sig.insert(key) {
            return None;
        }
        let file = self.file(f);
        let mut entries = Vec::new();
        if let Some(ids) = file.sites_by_func.get(&func) {
            for &si in ids {
                let site = &file.sites[si as usize];
                for lk in self.site_lookups(f, site) {
                    let alts = self.eval_alts(f, lk.scope, lk.value, 0);
                    if let [Val::Param { file: pf, func: pfn, idx }] = alts.as_slice() {
                        if *pf == f && *pfn == func {
                            entries.push((*idx, lk.table, lk.col));
                        }
                    }
                }
            }
        }
        entries.sort_unstable();
        entries.dedup();
        let sig = (!entries.is_empty()).then(|| Rc::new(entries));
        self.busy_sig.remove(&key);
        self.sig_memo.insert(key, sig.clone());
        sig
    }

    fn site_lookups(&mut self, f: u32, site: &'a Site) -> Vec<Lookup<'a>> {
        let mut out = Vec::new();
        match &site.kind {
            SiteKind::Direct { table, pairs } => {
                let Some(t) = self.tables.table(self.file(f).sym(*table)) else { return out };
                for (key, value, line) in pairs {
                    if let Some(col) = self.tables.col(t, self.file(f).sym(*key)) {
                        out.push(Lookup { table: t, col, value, scope: site.scope, line: *line });
                    }
                }
            }
            SiteKind::Index { base, index } => {
                if let Val::Map { table, keys, depth, .. } = self.eval(f, site.scope, base) {
                    if let Some(Some(col)) = keys.get(depth as usize) {
                        out.push(Lookup { table, col: *col, value: index, scope: site.scope, line: site.line });
                    }
                }
            }
            SiteKind::Pred { recv, func } => {
                let table = match self.eval(f, site.scope, recv) {
                    Val::Rows(t) => t,
                    _ => return out,
                };
                let info = &self.file(f).funcs[*func as usize];
                let (Some(&param), Some(pred)) = (info.params.first(), info.returns.first()) else { return out };
                let mut eqs = Vec::new();
                collect_eqs(pred, &mut eqs);
                for (a, b) in eqs {
                    for (x, y) in [(a, b), (b, a)] {
                        let Expr::Member(obj, col) = x else { continue };
                        if !matches!(obj.as_ref(), Expr::Ident(s) if *s == param) || expr_mentions(y, param) {
                            continue;
                        }
                        if let Some(col) = self.tables.col(table, self.file(f).sym(*col)) {
                            out.push(Lookup { table, col, value: y, scope: info.body_scope, line: site.line });
                        }
                    }
                }
            }
            SiteKind::Call { name, recv, args } => {
                if let Some(sig) = self.resolve_call(f, *name, *recv) {
                    for &(idx, table, col) in sig.iter() {
                        if let Some((value, line)) = args.get(idx as usize) {
                            out.push(Lookup { table, col, value, scope: site.scope, line: *line });
                        }
                    }
                }
            }
        }
        out
    }

    /// Alternative values an expression may take, expanding unions and aliases.
    fn eval_alts(&mut self, f: u32, scope: u32, e: &'a Expr, depth: u32) -> Vec<Val> {
        if depth > MAX_ALT_DEPTH {
            return vec![self.eval(f, scope, e)];
        }
        match e {
            Expr::Union(items) => items.iter().flat_map(|x| self.eval_alts(f, scope, x, depth + 1)).collect(),
            Expr::Typed(inner, ty) => match self.ty_val(f, *ty) {
                Some(v) => vec![v],
                None => self.eval_alts(f, scope, inner, depth + 1),
            },
            Expr::Ident(sym) => {
                let Some(bucket) = self.find_bucket(f, scope, *sym) else { return vec![Val::Unknown] };
                let ids = &self.file(f).bindings[&(bucket, *sym)];
                self.source_alts(f, ids, (f, bucket, *sym), depth)
            }
            Expr::Member(base, sym) if matches!(base.as_ref(), Expr::This) => match self.file(f).members.get(sym) {
                Some(ids) => self.source_alts(f, ids, (f, u32::MAX, *sym), depth),
                None => vec![Val::Unknown],
            },
            Expr::Call(c) => {
                let file = self.file(f);
                match (&c.callee, c.args.first()) {
                    (Expr::Ident(n), Some(arg)) if CONVERSION_FUNCS.contains(&file.sym(*n)) => self.eval_alts(f, scope, arg, depth + 1),
                    (Expr::Member(r, n), None) if matches!(file.sym(*n), "toString" | "valueOf") => self.eval_alts(f, scope, r, depth + 1),
                    _ => vec![self.eval(f, scope, e)],
                }
            }
            _ => vec![self.eval(f, scope, e)],
        }
    }

    fn source_alts(&mut self, f: u32, ids: &'a [u32], guard: (u32, u32, Sym), depth: u32) -> Vec<Val> {
        let typed = self.typed_sources(f, ids);
        if !typed.is_empty() {
            return vec![combine(typed)];
        }
        if !self.busy_ident.insert(guard) {
            return vec![Val::Unknown];
        }
        let file = self.file(f);
        let mut out = Vec::new();
        for &id in ids {
            let src = &file.sources[id as usize];
            match (&src.value, src.param) {
                (Some(v), _) => out.extend(self.eval_alts(f, src.scope, v, depth + 1)),
                (None, Some((func, idx))) => out.push(Val::Param { file: f, func, idx }),
                (None, None) => out.push(Val::Neutral),
            }
        }
        self.busy_ident.remove(&guard);
        out
    }

    /// Values passed for parameter `idx` of `func` at same-file call sites.
    fn trace_param(&mut self, f: u32, func: u32, idx: u32, depth: u32) -> Vec<Val> {
        let file = self.file(f);
        let Some(name) = file.funcs[func as usize].name else { return vec![Val::Unknown] };
        if depth > MAX_PARAM_TRACE_DEPTH {
            return vec![Val::Unknown];
        }
        let mut out = Vec::new();
        for site in &file.sites {
            let SiteKind::Call { name: n, recv: Recv::None | Recv::This, args } = &site.kind else { continue };
            if *n != name {
                continue;
            }
            let Some((arg, _)) = args.get(idx as usize) else {
                out.push(Val::Neutral);
                continue;
            };
            for alt in self.eval_alts(f, site.scope, arg, 0) {
                match alt {
                    Val::Param { file: pf, func: pfn, idx: pi } => out.extend(self.trace_param(pf, pfn, pi, depth + 1)),
                    v => out.push(v),
                }
            }
        }
        if out.is_empty() {
            out.push(Val::Unknown);
        }
        out
    }

    fn report(mut self, cancel: &AtomicBool) -> Result<CodeScanReport, String> {
        let mut report = CodeScanReport::default();
        for file in self.files {
            for name in &file.table_refs {
                if let Some(t) = self.tables.table(name) {
                    report.used_tables.insert(self.tables.names[t as usize].clone());
                }
            }
        }
        let mut emitter = Emitter::default();
        let mut deferred = Vec::new();
        for (fi, file) in self.files.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let f = fi as u32;
            for site in &file.sites {
                for lk in self.site_lookups(f, site) {
                    let alts = self.eval_alts(f, lk.scope, lk.value, 0);
                    if let [Val::Param { .. }] = alts.as_slice() {
                        deferred.push((f, site, lk, alts));
                        continue;
                    }
                    self.classify(f, site, &lk, alts, &mut emitter);
                }
            }
        }
        // Call sites are only recorded when an argument is non-literal, so a wrapper whose
        // name never shows up there is only ever called with constants (or not at all).
        let mut called: HashSet<&str> = HashSet::new();
        for file in self.files {
            for site in &file.sites {
                if let SiteKind::Call { name, .. } = &site.kind {
                    called.insert(file.sym(*name));
                }
            }
        }
        for (f, site, lk, alts) in deferred {
            let Val::Param { file: pf, func, idx } = alts[0] else { continue };
            if self.reached.contains(&(pf, func)) {
                continue;
            }
            let pfile = self.file(pf);
            if pfile.funcs[func as usize].name.is_some_and(|n| !called.contains(pfile.sym(n))) {
                continue;
            }
            let traced = self.trace_param(pf, func, idx, 1);
            self.classify(f, site, &lk, traced, &mut emitter);
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        report.relations = emitter.relations;
        report.untraced = emitter.untraced;
        Ok(report)
    }

    fn classify(&mut self, f: u32, site: &'a Site, lk: &Lookup<'a>, alts: Vec<Val>, out: &mut Emitter) {
        let mut sources: Vec<(u32, u16)> = Vec::new();
        let mut untraced = false;
        for alt in alts {
            match alt {
                Val::Neutral => {}
                Val::Fields(list) => sources.extend(list),
                Val::Param { file: pf, func, idx } => {
                    for v in self.trace_param(pf, func, idx, 1) {
                        match v {
                            Val::Neutral => {}
                            Val::Fields(list) => sources.extend(list),
                            _ => untraced = true,
                        }
                    }
                }
                _ => untraced = true,
            }
        }
        sources.sort_unstable();
        sources.dedup();
        // Flow-insensitive bindings also see later reassignments such as
        // `p = getQualityText(p).Name`; display text cannot be a numeric key. Other
        // string fields stay, since ids are often stored as text and `parseInt`-ed.
        let target_is_string = self.tables.is_string(lk.table, lk.col);
        sources.retain(|&(st, sc)| target_is_string || !self.tables.is_display_text(st, sc));
        let file = self.file(f);
        let location = || CodeLocation {
            file: file.rel.clone(),
            line: lk.line,
            snippet: file.snippets.get(&lk.line).map(|s| s.to_string()).unwrap_or_default(),
        };
        let tables = self.tables;
        for (st, sc) in sources {
            if (st, sc) == (lk.table, lk.col) {
                continue;
            }
            let rel = CodeRelation {
                source_table: tables.names[st as usize].clone(),
                source_column: tables.cols[st as usize][sc as usize].clone(),
                target_table: tables.names[lk.table as usize].clone(),
                target_column: tables.cols[lk.table as usize][lk.col as usize].clone(),
                location: location(),
                fingerprint: String::new(),
            };
            out.push_relation(rel, site.text_hash);
        }
        if untraced {
            out.push_untraced(UntracedLookup {
                target_table: tables.names[lk.table as usize].clone(),
                target_column: tables.cols[lk.table as usize][lk.col as usize].clone(),
                location: location(),
            });
        }
    }
}

fn collect_eqs<'e>(e: &'e Expr, out: &mut Vec<(&'e Expr, &'e Expr)>) {
    match e {
        Expr::Eq(a, b) => out.push((a, b)),
        Expr::And(items) => items.iter().for_each(|x| collect_eqs(x, out)),
        _ => {}
    }
}

#[derive(Default)]
struct Emitter {
    relations: Vec<CodeRelation>,
    untraced: Vec<UntracedLookup>,
    ordinals: HashMap<String, u32>,
    seen_untraced: HashSet<(String, u32, String, String)>,
}

impl Emitter {
    fn push_relation(&mut self, mut rel: CodeRelation, text_hash: u64) {
        let material = format!(
            "{}\n{:016x}\n{}.{}\n{}.{}",
            rel.location.file, text_hash, rel.source_table, rel.source_column, rel.target_table, rel.target_column
        );
        let ordinal = self.ordinals.entry(material.clone()).or_insert(0);
        let mut hasher = Sha256::new();
        hasher.update(material.as_bytes());
        hasher.update(format!("\n{ordinal}").as_bytes());
        *ordinal += 1;
        let digest = hasher.finalize();
        rel.fingerprint = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
        self.relations.push(rel);
    }

    fn push_untraced(&mut self, entry: UntracedLookup) {
        let key = (entry.location.file.clone(), entry.location.line, entry.target_table.clone(), entry.target_column.clone());
        if self.seen_untraced.insert(key) {
            self.untraced.push(entry);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    const CATALOG: &str = r#"export type rewardpropData = {ID:number/*奖励ID, 主键*/,ItemID:number/*道具，对应goodsprop.ID*/,Num:number,};
export type goodspropData = {ID:number,Name:string,Kind:number,};
export type heropropData = {ID:number,CareerID:number,Star:number,SkinID:number,};
export type herostarpropData = {CareerID:number,Star:number,Point:number,Attr:string,};
export type shoppropData = {GoodsID:number,Price:number,HeroID:number,};
export type taskpropData = {TaskLine:number,TaskIdx:number,RewardID:number,};
"#;

    struct TempClient {
        root: PathBuf,
    }

    impl TempClient {
        fn new(dialect: ClientDialect, files: &[(&str, &str)]) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!("dbscout-code-scan-test-{}-{n}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(root.join("assets/src/props")).unwrap();
            match dialect {
                ClientDialect::Jswz => fs::write(root.join("package.json"), r#"{"name": "jswz", "creator": {"version": "3.8.8"}}"#).unwrap(),
                ClientDialect::Nzg => fs::write(root.join("project.json"), r#"{"engine": "cocos2d-html5", "name": "nzg"}"#).unwrap(),
            }
            fs::write(root.join("assets/src/props/propDataDefine.ts"), CATALOG).unwrap();
            let client = TempClient { root };
            for (rel, text) in files {
                client.write(rel, text);
            }
            client
        }

        fn write(&self, rel: &str, text: &str) {
            let path = self.root.join("assets/src").join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }

        fn columns(&self, dialect: ClientDialect) -> TableColumns {
            read_catalog(&self.root, dialect).tables.into_iter().collect()
        }

        fn scan(&self, dialect: ClientDialect, cache: &mut ScanCache) -> CodeScanReport {
            let columns = self.columns(dialect);
            scan(&self.root, dialect, &columns, cache, &AtomicBool::new(false)).unwrap()
        }
    }

    impl Drop for TempClient {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn rel_keys(report: &CodeScanReport) -> Vec<String> {
        let mut keys: Vec<String> = report
            .relations
            .iter()
            .map(|r| format!("{}.{} -> {}.{}", r.source_table, r.source_column, r.target_table, r.target_column))
            .collect();
        keys.sort();
        keys
    }

    fn untraced_keys(report: &CodeScanReport) -> Vec<String> {
        let mut keys: Vec<String> = report.untraced.iter().map(|u| format!("{}.{}", u.target_table, u.target_column)).collect();
        keys.sort();
        keys
    }

    fn scan_one(dialect: ClientDialect, code: &str) -> CodeScanReport {
        let client = TempClient::new(dialect, &[("game/Test.ts", code)]);
        client.scan(dialect, &mut ScanCache::default())
    }

    #[test]
    fn detects_dialects_and_reads_catalog() {
        let jswz = TempClient::new(ClientDialect::Jswz, &[]);
        let nzg = TempClient::new(ClientDialect::Nzg, &[]);
        assert_eq!(detect_dialect(&jswz.root), Some(ClientDialect::Jswz));
        assert_eq!(detect_dialect(&nzg.root), Some(ClientDialect::Nzg));
        assert_eq!(detect_dialect(&jswz.root.join("assets")), None);
        let catalog = read_catalog(&jswz.root, ClientDialect::Jswz);
        assert_eq!(catalog.tables["rewardprop"], vec!["ID", "ItemID", "Num"]);
        assert_eq!(catalog.tables.len(), 6);
        assert_eq!(catalog.source_files.len(), 1);
    }

    #[test]
    fn typed_variable_source() {
        let report = scan_one(
            ClientDialect::Jswz,
            r#"
export class RewardView {
    private reward: rewardpropData;
    show(reward: rewardpropData) {
        const goods = g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: reward.ItemID });
        const again: goodspropData = g_PropMgr.getPropLine(__Prop__.goodsprop, { key: 'ID', value: this.reward.ItemID }) as goodspropData;
    }

}
"#,
        );
        assert_eq!(rel_keys(&report), vec!["rewardprop.ItemID -> goodsprop.ID", "rewardprop.ItemID -> goodsprop.ID"]);
        assert!(report.untraced.is_empty(), "{:?}", report.untraced);
        assert!(report.used_tables.contains("goodsprop"));
        let first = &report.relations[0];
        assert_eq!(first.location.file, "assets/src/game/Test.ts");
        assert_eq!(first.location.line, 5);
        assert!(first.location.snippet.starts_with("const goods = g_PropMgr.getPropLine"));
        assert_ne!(report.relations[0].fingerprint, report.relations[1].fingerprint);
    }

    #[test]
    fn static_template_config_paths_preserve_row_provenance() {
        let report = scan_one(ClientDialect::Jswz, r#"
            async function check() {
                const rows = await this.requireProp(`../props/${__Prop__.rewardprop}`);
                for (const reward of rows) {
                    g_PropMgr.getPropLine(__Prop__.goodsprop, {key: "ID", value: reward.ItemID});
                }
            }
        "#);
        assert!(rel_keys(&report).contains(&"rewardprop.ItemID -> goodsprop.ID".into()));
    }

    #[test]
    fn assignment_from_lookup_source() {
        let report = scan_one(
            ClientDialect::Jswz,
            r#"
function show(id: number) {
    let reward = null;
    reward = g_PropMgr.getPropLine(__Prop__.rewardprop, { key: "ID", value: 3 });
    const shops = g_PropMgr.getPropsByKeys(__Prop__.shopprop, { key: "GoodsID", value: 5 });
    for (const shop of shops) {
        g_PropMgr.getPropLine(__Prop__.heroprop, { key: "ID", value: shop.HeroID });
    }
    shops.forEach((s) => g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: s.GoodsID }));
    return g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: reward?.ItemID });
}
"#,
        );
        assert_eq!(
            rel_keys(&report),
            vec!["rewardprop.ItemID -> goodsprop.ID", "shopprop.GoodsID -> goodsprop.ID", "shopprop.HeroID -> heroprop.ID"]
        );
        assert!(report.untraced.is_empty(), "{:?}", report.untraced);
    }

    #[test]
    fn nzg_wrapper_call_and_composite_keys() {
        let client = TempClient::new(
            ClientDialect::Nzg,
            &[
                (
                    "model/PropM.ts",
                    r#"
export default class PropM {
    getTableByName(propName: string) { return this[propName]; }
    getPropByKeys(propName: string, keys: string[]) { return this[propName]; }
    getHeroProp(heroID: number): heropropData {
        let heroprop = this.getTableByName(Prop.heroprop);
        if (!heroprop[heroID]) { return null; }
        return heroprop[heroID];
    }
    getHeroStarProp(careerID: number, star: number, point: number): herostarpropData {
        let props = this.getPropByKeys(Prop.herostarprop, ["CareerID", "Star", "Point"]);
        return props[careerID][star][point];
    }
}
"#,
                ),
                (
                    "views/HeroView.ts",
                    r#"
export class HeroView {
    refresh(shop: shoppropData, task: taskpropData) {
        const hero = PropM.getHeroProp(shop.HeroID);
        const star = PropM.getHeroStarProp(hero.CareerID, hero.Star, 0);
        const reward: rewardpropData = PropM.getTableByName(Prop.rewardprop)[task.RewardID];
        const goodsMap = PropM.getTableByName(Prop.goodsprop);
        const goods = goodsMap[reward.ItemID];
        const tasks = PropM.getPropByKeys(Prop.taskprop, ["TaskLine", "TaskIdx"]);
        const next = tasks[task.TaskLine][task.TaskIdx + 1];
        PropM.getHeroProp(1001);
    }
}
"#,
                ),
            ],
        );
        let report = client.scan(ClientDialect::Nzg, &mut ScanCache::default());
        assert_eq!(
            rel_keys(&report),
            vec![
                "heroprop.CareerID -> herostarprop.CareerID",
                "heroprop.Star -> herostarprop.Star",
                "rewardprop.ItemID -> goodsprop.ID",
                "shopprop.HeroID -> heroprop.ID",
                "taskprop.RewardID -> rewardprop.ID",
            ]
        );
        // `TaskLine` self-reference is dropped, `TaskIdx + 1` and the wrapper's literal point are not traceable.
        assert_eq!(untraced_keys(&report), vec!["taskprop.TaskIdx"]);
        let wrapper = report.relations.iter().find(|r| r.target_table == "heroprop").unwrap();
        assert_eq!(wrapper.location.file, "assets/src/views/HeroView.ts");
        assert!(wrapper.location.snippet.contains("PropM.getHeroProp(shop.HeroID)"));
    }

    #[test]
    fn alias_chain_and_destructuring() {
        let report = scan_one(
            ClientDialect::Jswz,
            r#"
function show(cfg: rewardpropData) {
    const id = cfg.ItemID;
    const other = id;
    const { ItemID: goodsId } = cfg;
    g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: Number(other) });
    g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: goodsId });
}
"#,
        );
        assert_eq!(rel_keys(&report), vec!["rewardprop.ItemID -> goodsprop.ID", "rewardprop.ItemID -> goodsprop.ID"]);
        assert!(report.untraced.is_empty());
    }

    #[test]
    fn parameter_traced_through_same_file_call_sites() {
        let report = scan_one(
            ClientDialect::Jswz,
            r#"
export class ItemTip {
    private showGoods(goodsID: number) {
        const goods: goodspropData = g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: goodsID });
        return goods;
    }
    open(reward: rewardpropData, shop: shoppropData) {
        this.showGoods(reward.ItemID);
        this.showGoods(shop.GoodsID);
        this.showGoods(7);
    }
    private findHero(heroID: number, cfg: rewardpropData) {
        return g_PropMgr.getPropLine(__Prop__.heroprop, { key: "ID", value: heroID || cfg.ItemID });
    }
}
"#,
        );
        assert_eq!(
            rel_keys(&report),
            vec!["rewardprop.ItemID -> goodsprop.ID", "rewardprop.ItemID -> heroprop.ID", "shopprop.GoodsID -> goodsprop.ID"]
        );
        // `findHero` has no callers, so its parameter half stays untraced.
        assert_eq!(untraced_keys(&report), vec!["heroprop.ID"]);
        let call = report.relations.iter().find(|r| r.source_table == "shopprop").unwrap();
        assert_eq!(call.location.line, 9);
    }

    #[test]
    fn literal_keys_are_ignored() {
        let report = scan_one(
            ClientDialect::Jswz,
            r#"
const a = g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: 2 });
const b = g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: "2" });
const c = g_PropMgr.getPropLine(dynamicTable, { key: "ID", value: unknownValue });
"#,
        );
        assert!(report.relations.is_empty());
        assert!(report.untraced.is_empty());
    }

    #[test]
    fn ambiguous_or_unknown_sources_are_untraced() {
        let report = scan_one(
            ClientDialect::Jswz,
            r#"
function pick(flag: boolean) {
    let row = g_PropMgr.getPropLine(__Prop__.rewardprop, { key: "ID", value: 1 });
    if (flag) {
        row = g_PropMgr.getPropLine(__Prop__.shopprop, { key: "GoodsID", value: 1 });
    }
    g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: row.ItemID });
    const cfg: rewardpropData = loadReward();
    g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "Kind", value: cfg.Missing });
    g_PropMgr.getPropLine(__Prop__.heroprop, { key: "ID", value: this.view.heroId + 1 });
    g_PropMgr.getPropLine(__Prop__.heroprop, { key: "NotAColumn", value: cfg.ItemID });
}
"#,
        );
        assert!(report.relations.is_empty(), "{:?}", rel_keys(&report));
        assert_eq!(untraced_keys(&report), vec!["goodsprop.ID", "goodsprop.Kind", "heroprop.ID"]);
    }

    #[test]
    fn same_named_methods_resolve_by_receiver_or_stay_untraced() {
        let client = TempClient::new(
            ClientDialect::Jswz,
            &[
                (
                    "a/RewardGemM.ts",
                    r#"export class RewardGemM {
    getItem(id: number) { const p: rewardpropData = g_PropMgr.getPropLine(__Prop__.rewardprop, { key: "ID", value: id }); return p.ItemID; }
}"#,
                ),
                (
                    "a/ShopGemM.ts",
                    r#"export class ShopGemM {
    getItem(id: number) { const p: shoppropData = g_PropMgr.getPropLine(__Prop__.shopprop, { key: "HeroID", value: id }); return p.GoodsID; }
}"#,
                ),
                (
                    "b/View.ts",
                    r#"export enum EGoodsKind { Coin = 1 }
function show(x: any) {
    g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: mmgr.EquipMgr.shopGemM.getItem(1) });
    g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: x.getItem(1) });
    g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "Kind", value: EGoodsKind.Coin });
}"#,
                ),
            ],
        );
        let report = client.scan(ClientDialect::Jswz, &mut ScanCache::default());
        assert_eq!(rel_keys(&report), vec!["shopprop.GoodsID -> goodsprop.ID"]);
        assert_eq!(untraced_keys(&report), vec!["goodsprop.ID"]);
    }

    #[test]
    fn text_fields_never_feed_numeric_keys() {
        let report = scan_one(
            ClientDialect::Jswz,
            r#"
function label(reward: rewardpropData, p: number) {
    p = reward.ItemID;
    if (p > 0) {
        p = g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: p }).Name;
    }
    return p;
}
"#,
        );
        assert_eq!(rel_keys(&report), vec!["rewardprop.ItemID -> goodsprop.ID"]);
    }

    #[test]
    fn scan_cache_can_move_between_threads() {
        fn assert_send<T: Send>() {}
        assert_send::<ScanCache>();
    }

    #[test]
    fn find_predicate_lookups() {
        let report = scan_one(
            ClientDialect::Jswz,
            r#"
function show(reward: rewardpropData) {
    const rows: goodspropData[] = g_PropMgr.getProp(__Prop__.goodsprop);
    const goods = rows.find((g) => g.ID === reward.ItemID && g.Kind == 3);
    const shop = g_PropMgr.getProp<shoppropData>(__Prop__.shopprop).filter(s => { return s.GoodsID == goods.ID; });
}
"#,
        );
        assert_eq!(rel_keys(&report), vec!["goodsprop.ID -> shopprop.GoodsID", "rewardprop.ItemID -> goodsprop.ID"]);
        assert!(report.untraced.is_empty());
    }

    #[test]
    fn fingerprint_is_stable_across_line_shifts() {
        let code = r#"
function show(reward: rewardpropData) {
    g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: reward.ItemID });
}
"#;
        let client = TempClient::new(ClientDialect::Jswz, &[("game/Test.ts", code)]);
        let mut cache = ScanCache::default();
        let before = client.scan(ClientDialect::Jswz, &mut cache);
        client.write("game/Test.ts", &format!("// header\nconst unrelated = 1;\n\n{code}"));
        let shifted = client.scan(ClientDialect::Jswz, &mut cache);
        assert_eq!(before.relations.len(), 1);
        assert_eq!(before.relations[0].fingerprint, shifted.relations[0].fingerprint);
        assert_eq!(shifted.relations[0].location.line, before.relations[0].location.line + 3);
        assert_eq!(before.relations[0].fingerprint.len(), 16);

        client.write("game/Test.ts", &code.replace("reward.ItemID", "reward.ItemID ?? 0"));
        let changed = client.scan(ClientDialect::Jswz, &mut cache);
        assert_eq!(changed.relations.len(), 1);
        assert_ne!(before.relations[0].fingerprint, changed.relations[0].fingerprint);
    }

    #[test]
    fn rescans_are_incremental() {
        let client = TempClient::new(
            ClientDialect::Jswz,
            &[
                ("a/A.ts", "function a(r: rewardpropData) { g_PropMgr.getPropLine(__Prop__.goodsprop, { key: 'ID', value: r.ItemID }); }"),
                ("b/B.ts", "export const x = 1;"),
                ("c/C.ts", "export const y = 2;"),
            ],
        );
        let mut cache = ScanCache::default();
        let cold = client.scan(ClientDialect::Jswz, &mut cache);
        assert_eq!((cold.files_scanned, cold.files_reparsed), (3, 3));
        let warm = client.scan(ClientDialect::Jswz, &mut cache);
        assert_eq!((warm.files_scanned, warm.files_reparsed), (3, 0));
        assert_eq!(rel_keys(&warm), rel_keys(&cold));
        client.write("b/B.ts", "export const x = 12345;");
        let touched = client.scan(ClientDialect::Jswz, &mut cache);
        assert_eq!((touched.files_scanned, touched.files_reparsed), (3, 1));
        fs::remove_file(client.root.join("assets/src/a/A.ts")).unwrap();
        let removed = client.scan(ClientDialect::Jswz, &mut cache);
        assert_eq!((removed.files_scanned, removed.files_reparsed), (2, 0));
        assert!(removed.relations.is_empty());
    }

    #[test]
    fn cancellation_stops_the_scan() {
        let client = TempClient::new(ClientDialect::Jswz, &[("a/A.ts", "export const x = 1;")]);
        let columns = client.columns(ClientDialect::Jswz);
        let cancel = AtomicBool::new(true);
        let result = scan(&client.root, ClientDialect::Jswz, &columns, &mut ScanCache::default(), &cancel);
        assert_eq!(result.unwrap_err(), "cancelled");
    }

    #[test]
    fn tokenizer_handles_regex_templates_and_comments() {
        let report = scan_one(
            ClientDialect::Jswz,
            r#"
const re = /["'`]+\//g; // "unterminated
/* g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: x.ItemID }) */
const path = `../props/${__Prop__.heroprop}`;
function show(r: rewardpropData) {
    const half = total / 2 / r.Num;
    g_PropMgr.getPropLine(__Prop__.goodsprop, { key: "ID", value: r.ItemID });
}
"#,
        );
        assert_eq!(rel_keys(&report), vec!["rewardprop.ItemID -> goodsprop.ID"]);
        assert!(report.used_tables.contains("heroprop"));
    }

    fn real_client(var: &str, dialect: ClientDialect) {
        let Ok(root) = std::env::var(var) else {
            eprintln!("{var} not set; skipping");
            return;
        };
        let root = PathBuf::from(root);
        assert_eq!(detect_dialect(&root), Some(dialect));
        let started = Instant::now();
        let catalog = read_catalog(&root, dialect);
        let catalog_ms = started.elapsed().as_millis();
        let columns: TableColumns = catalog.tables.clone().into_iter().collect();
        let mut cache = ScanCache::default();
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        let cold = scan(&root, dialect, &columns, &mut cache, &cancel).unwrap();
        let cold_ms = started.elapsed().as_millis();
        let mut warm_ms = u128::MAX;
        let mut warm = CodeScanReport::default();
        for _ in 0..3 {
            let started = Instant::now();
            warm = scan(&root, dialect, &columns, &mut cache, &cancel).unwrap();
            warm_ms = warm_ms.min(started.elapsed().as_millis());
        }
        assert_eq!(warm.files_reparsed, 0);
        assert_eq!(rel_keys(&warm), rel_keys(&cold));
        let mut changed_columns = columns.clone();
        changed_columns.insert("zz_unused_probe".into(), vec!["ID".into()]);
        let started = Instant::now();
        let resolved = scan(&root, dialect, &changed_columns, &mut cache, &cancel).unwrap();
        let resolve_ms = started.elapsed().as_millis();
        assert_eq!(resolved.files_reparsed, 0);
        assert_eq!(rel_keys(&resolved), rel_keys(&cold));
        let sites: usize = cache.files.values().map(|c| c.facts.sites.len()).sum();
        let sources: usize = cache.files.values().map(|c| c.facts.sources.len()).sum();
        println!("== {dialect:?} {}", root.display());
        println!("catalog: {} tables in {catalog_ms} ms", catalog.tables.len());
        println!(
            "files: {} scanned, cold {cold_ms} ms ({} parsed), warm unchanged {warm_ms} ms, warm re-resolve {resolve_ms} ms",
            cold.files_scanned, cold.files_reparsed
        );
        println!("cached sites: {sites}, sources: {sources}");
        println!("used tables: {}", cold.used_tables.len());
        let distinct: BTreeSet<String> = rel_keys(&cold).into_iter().collect();
        println!("relations: {} usages, {} distinct", cold.relations.len(), distinct.len());
        let mut fps = HashSet::new();
        for r in &cold.relations {
            assert!(fps.insert(r.fingerprint.clone()), "duplicate fingerprint {r:?}");
        }
        let step = (cold.relations.len() / 12).max(1);
        for r in cold.relations.iter().step_by(step).take(12) {
            println!(
                "  {}.{} -> {}.{}  {}:{}  {}",
                r.source_table, r.source_column, r.target_table, r.target_column, r.location.file, r.location.line, r.location.snippet
            );
        }
        println!("untraced: {}", cold.untraced.len());
        let mut by_table: HashMap<&str, usize> = HashMap::new();
        for u in &cold.untraced {
            *by_table.entry(u.target_table.as_str()).or_default() += 1;
        }
        let mut by_table: Vec<_> = by_table.into_iter().collect();
        by_table.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        println!("  top untraced targets: {:?}", &by_table[..by_table.len().min(10)]);
        let step = (cold.untraced.len() / 8).max(1);
        for u in cold.untraced.iter().step_by(step).take(8) {
            println!("  {}.{}  {}:{}  {}", u.target_table, u.target_column, u.location.file, u.location.line, u.location.snippet);
        }
    }

    #[test]
    #[ignore]
    fn real_jswz_client() {
        real_client("DBSCOUT_RELATIONS_JSWZ_ROOT", ClientDialect::Jswz);
    }

    #[test]
    #[ignore]
    fn real_nzg_client() {
        real_client("DBSCOUT_RELATIONS_NZG_ROOT", ClientDialect::Nzg);
    }
}
