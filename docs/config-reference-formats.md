# Config Reference Formats

Relations describe a target column separately from the parser used to extract
its keys. Relation IDs keep their existing scalar/list identity so existing
review decisions survive the change. A legacy scalar decision is reused if the
same source and target acquire a list representation.

## Supported Formats

| Format | Key extraction | Non-key content |
| --- | --- | --- |
| Comma or pipe list | Each complete token, in order, deduplicated | Empty, 0 and -1 sentinels |
| Scalar JSON array | Each string or number | Objects and nested arrays are refused |
| Typed nested JSON path | Named members, array indexes and array wildcards | Non-scalar leaves; scalars never auto-wrap as arrays |
| Selected token | Only the specified comma/pipe position | Later parameters, counts and options |
| Prefixed identity | Whole key, only for its declared prefix | Another activity family's prefix |
| Flat object array | An explicit case-insensitive member | Amounts, weights and other members |
| ENC | Ordinary ID; core ID to heroprop; ID=0 Num to optional gift; ID=999 Num to purchase PID | ID=998 is an ad marker |
| Open condition | Prefix to the condition definition; B/G/F/P_ arguments to their documented tables | Operators, levels, amounts, days and item quantities |
| Dynamic expression | Not evaluated | Reported as unchecked rather than missing |

The ENC and project mappings require the corresponding schema. No database
host, credentials or workstation paths are encoded. Key-list parsing only
refines comment/code evidence or an explicitly verified project mapping;
weights, colors, coordinates and timing arrays do not create references.

Foreground assembly uses declared formats immediately. Background sampling
reads 200 rows per table. An additional single aggregate per condition-bearing
table obtains examples of rare reference branches beyond the sample window.
Those scans stay on the background scheduler and never run on row selection.
A transient format-read failure retains the previous parser.

Outgoing lookup, expanded incoming rows, counts and filtered tabs use the same
parser contract. SQL identifiers are escaped and values/patterns are bound.
Flat JSON predicates keep selectors in the same object, regardless of member
order. Unknown formats do not silently become scalar equality filters.
`constraints.rs` / `relationConstraints.js` carry source-row discriminators to
every lookup path, including tab identity and refresh after edits. The jswz
registry lives in `project_relations.rs`; its rules only apply when the project
schema matches. Known obsolete automatic guesses are suppressed; manual review
history remains visible, stale and non-executable.

Nested path inverse predicates use `JSON_TABLE` and require a MySQL version
supporting it (verified on the requested server). They guard every object/array
step and scalar leaf, unlike recursive `JSON_CONTAINS` or JSON path auto-wrapping.
On older servers a query failure must remain unknown/error, never a false zero.
This new nested-path feature has not been accepted on MySQL 5.7.

## Verification

Shared cases are in `tests/fixtures/config-reference-formats.json` and exercised
by both Rust and JavaScript. These include ID boundaries, amounts versus keys,
JSON member order, false matches inside strings, deduplication and invalid data.

For an explicitly obtained, read-only export, place `audit.json` (a `tables`
array with `tableName`/`tableComment`) and one `<table>.json` per table in a
private directory. Table files contain the Blackcat `describe_table` result as
`schema` and the complete string-valued `read_table_page` rows as `rows`.
Do not commit real exports or credentials.

```sh
DBSCOUT_RELATION_AUDIT_DIR=<export-directory> \
DBSCOUT_RELATION_CLIENT=<client-directory> \
cargo test --manifest-path src-tauri/Cargo.toml exported_config_database --lib -- --ignored --nocapture
node scripts/verify-config-reference-export.mjs <export-directory>
node scripts/verify-config-reference-sql.mjs <export-directory> <connection-id> <database>
DBSCOUT_PLAYWRIGHT_CHANNEL=chrome DBSCOUT_RELATIONS_TEST_URL=http://127.0.0.1:1431 \
node scripts/test-config-relations-export-browser.mjs <export-directory>
node scripts/report-config-relations-audit.mjs <export-directory> <baseline-audit-json> <report.md>
```

The Rust audit checks actual client-code evidence, compares full-export and
production sampling results, and emits `relations-audit.json`, including
parameterized SQL cases. The JS verifier compares the ordered parsed keys of
every adapted cell against Rust and validates inverse-filter counts. Neither command writes to
the database. Offline predicate comparisons do not replace execution on the
supported MySQL server or desktop interaction acceptance.

## Audit On 2026-10-23

- Latest read-only export: 336 tables, 2,893 columns, 140,196 rows. This replaces
  the earlier 330-table export; the live database is changing. Two monthly-event
  tables were emptied between reads, so the audit was repeated on a fresh export.
- A read-only client-source copy freezes 1,771 scanned files for reproducible
  cold/warm checks; the original client was changing during the first scan.
- Result: 1,230 relations, 172 added and 67 removed against the 1,125-relation
  baseline. Parser/guard improvements to existing identities are not additions.
  The full per-table inventory is `docs/jswz-relations-audit-2026-10-23.md`.
- Passed: 69 Rust relation tests including the complete export; 587,754
  JS/Rust row/relation comparisons; 1,036 inverse checks; 1,407 live read-only SQL
  checks. The 612 unchecked row/relation combinations include functions,
  malformed examples and references needing contextual keys, not 612 bugs.
- Browser replay of real exported data confirms goods 11007 has five incoming
  box rewards; cold/warm expansion, filtered-table opening, box 35011 -> goods,
  and the reverse primary-key jump work. Generic browser regressions also pass,
  including 125-row paging. This is frontend replay, not installed desktop IPC
  acceptance. No production rows are stored in the repo.
- Full JS suite: 2,282 / 2,285 pass; the same three unrelated source-contract
  failures concern the favorites rail, macOS traffic lights and SVN updater.
  Full Rust suite also exposes an unrelated Windows-path assertion on macOS
  in `svn_updater::tests::tortoise_svn_path_is_under_program_files`.
- Production frontend/sidecar build and duplication gate pass (2.39% duplicated
  lines). Full Rust result: 588 passed, one unrelated failure, seven ignored.
- Dynamic functions are never executed; contextual references such as guide
  event kinds, skill family IDs and same-group prerequisite nodes are not
  fabricated as single-key matches. Tables containing unsupported fields no
  longer report complete coverage merely because static scanning found nothing.
- Missing targets remain visible for review; no database or client data was
  changed. Installed application binaries are unchanged.
