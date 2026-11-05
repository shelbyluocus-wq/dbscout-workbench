# AI-Assisted Config Relations

The external Blackcat MCP now exposes the real config-relation engine and a
bounded, read-only investigation workflow. AI interprets evidence; the desktop
persists explicitly approved declarative rules. This is not an automatic claim
that every occurrence of a number is a foreign key.

## Workflow

1. Discover connections and permissions with `get_mcp_capabilities`.
2. Read binding, analysis progress and coverage with `get_relation_overview`.
3. Use `get_record_relations` with the complete primary key. It returns outgoing
   targets and both directions' relation definitions/statuses without waiting
   for whole-database incoming counts. `get_table_relations` reads definitions
   without a selected record.
4. Page `read_reference_rows` for each confirmed incoming relation, retaining
   `revision`, `nextOffset`, `hasMore` and any parser mismatch. Each result has
   its source field, cell preview, row identity, name and SQL-NULL column metadata.
   `includeRow=true` returns the full row; `valueTruncated` flags cell previews.
5. If coverage is incomplete, start a scoped or database-wide
   `start_reference_scan`, poll `get_reference_scan`, and distinguish literals
   from encoded numeric candidates such as `G1001_5`. Neither is proof of a
   reference: counts, weights, descriptions and function bodies also match.
6. Inspect `search_relation_code` / `read_relation_code` and column comments.
   Follow indirect chains explicitly with a visited set; keep them separate
   from direct references. Use existing `focus_cell` with the returned complete
   `rowIdentity` to show a result in the workbench.
7. Propose a parser and source-row constraints. `test_relation_rule_page` can
   traverse the source data without saving. Check every `hasMore`, unknown
   parse, conditional branch and missing target rather than just the first page.
8. `preview_relation_rule` checks a 200-row window, optionally starting at
   `sampleOffset` for rare branches. Show the evidence, parser, old rule,
   extracted keys, unknowns, scope and limits to the user. Only after explicit
   authorization call `apply_relation_rule` with `confirmed=true`.

These tools currently require a real MySQL connection. Existing generic
`find_related_tables` remains a name-based hint, not the evidence-backed engine.

## Permissions

The original four permission groups retain their defaults. Three new groups
are opt-in and default **off**, including when upgrading an older config:

| Permission | Controls |
| --- | --- |
| `readProject` | Search/read the bound client's permitted code files |
| `scanRelations` | Start/resume candidate scans, preview/test rule samples |
| `editRelations` | Apply an explicitly confirmed local-rule preview |

Reading existing relations, scan results and rule history needs only the MCP
master switch. Pausing, cancelling and forgetting a scan do not require its
scan permission. Disabling scan permission or the master switch pauses a
worker before its next page. In-flight reads can finish but no new page starts.
Code snippets and stored rule evidence are withheld without project permission;
sensitive-looking lines are redacted even when permission is granted.

Permission checks run at the Rust control boundary, not just in tool schemas.
Rule apply rechecks permission after validation. These tools never execute
client/config functions, write business data or change the schema. Applying a
rule does write the local relation store and is signalled as a write; code
reads and background scans are signalled as reads.

## Bounds And Responsiveness

- Relation row lookup binds the full primary key and checks the returned text
  exactly, avoiding numeric coercion and loss of large-integer precision. Pass
  integers beyond JavaScript's safe range as strings.
- Scan pages contain 100 rows, run through the background work scheduler, and
  yield between pages. Each worker reuses a table's schema across pages rather
  than rediscovering it on every read. Interactive grid work keeps its reserved capacity.
  Per-page scan waits are capped at 30 seconds; a failure records the table and
  offset rather than calling it checked. A slow database can still affect
  overall throughput; no production speedup factor is asserted.
- One running scan per connection/database, at most eight retained jobs.
  Results pause at 5,000 rows or 8 MiB. Poll using `nextCursor`; pause and resume
  with `discardThrough` only after saving/reading those results. The first
  unconsumed row is retried after a buffer pause. Jobs are process-local and
  disappear on restart. Cancellation does not erase results; `forget` does.
  Each poll returns at most 200 result rows, with a 512 KiB result-body budget;
  always follow the returned cursor rather than assuming the requested count.
- A result includes at most 64 matching cells, with an 800-character preview
  each. `cellsTruncated` and per-cell `truncated` require a full row reread.
  Oversized/unavailable primary keys return no navigable identity.
- Code access is restricted to permitted UTF-8 code/document types under the
  canonical bound root. Traversal, outside symlinks, hidden/dependency/build
  paths and known sensitive filenames are refused. Files are bounded to 1 MB,
  reads to 200 lines and line previews to 1,000 characters. Redaction is a
  conservative heuristic, not a guarantee that arbitrary source is secret-free.
- Code searches process at most 100 files and return at most 100 hits per call.
  Discovery is capped at 10,000 files / 30,000 entries and reports truncation.
  Cursors bind the root, keyword and metadata manifest, plus the current file's
  hash for within-file continuation. This is not a filesystem snapshot.

## Rule Safety And Persistence

Rules are stored under the exact database name in the existing server record
in `config-relations.json`. Client binding and pre-existing review decisions
remain server-wide. Database names are not folded together. No schema migration
or game-config import is involved.

- Supported parsers reuse the desktop's extraction and inverse-filter contract:
  scalar, comma/pipe keys, scalar JSON arrays, selected tokens, prefixes, flat
  JSON members/selectors, restricted nested JSON paths and open conditions.
  Conditions can constrain source-row types. Arbitrary SQL, regular expressions
  and executable code are not accepted as rules.
- New enabled rules must point to a single-column primary key. Composite or
  non-unique targets need contextual rules not supported by this version.
  Existing engine relations to non-unique fields can still be inspected, but
  their incoming results are labelled field references, not unique-row proof.
- A preview expires after 15 minutes and is single-use, bound to the explicit
  connection/database, schema, sample data, binding, specified code hashes and
  rule-book revision. Apply rejects drift. A failed apply requires a new preview.
- Validation is sample parsing, **not semantic proof, target-existence proof or
  full-table validation**. Enabling requires at least one extracted sample key
  and no unknown parses in that window. Empty/nonmatching branches elsewhere
  still need investigation. Live data can change after any check.
- At most 500 rules and the latest 100 changes are retained. Replacing a parser
  for the same endpoints replaces one edge and records the previous rule,
  including a scalar-to-list change. `get_relation_rules` pages 50 rules by
  default (at most 200), optionally selects `relationId`, and only includes
  history when `includeHistory=true`;
  restoring a prior draft requires another preview and confirmation.
- `enabled=false` disables an existing override, even when its source table or
  evidence file has disappeared. It restores automatic inference, **not** a
  rejected relation or deletion of business data. It still needs a preview,
  revision check, local-rule permission and user confirmation.
- Existing manual confirmations/rejections cannot be overwritten. Ordinary
  relation-review actions on an active assisted rule are refused so they cannot
  accidentally discard its parser. Re-preview or disable it through MCP first.
- Schema/binding drift and changes to the specified `codePaths` mark the rule
  stale and non-executable on the engine's next background refresh. No code
  dependency means no code-change detection. Verification fingerprints include
  the entire saved rule so an older verification cannot authorize a newer rule.
  Referenced files are read once per verification pass even when rules share them.
- Atomic store-save failure restores the previous in-memory record. A subsequent
  index-refresh problem is returned as `saved:true` plus `refreshWarning`, not
  misreported as a failed save that encourages duplicate application.

## Coverage Interpretation

`dataTraversalComplete` means the selected tables reached their ends without
recorded read errors. It does not establish a stable snapshot: OFFSET pagination
can skip/repeat rows during edits, and keyless tables cannot be reliably located.
`semanticCoverageComplete` is always false for candidate scans. Computed IDs,
server-only behavior, unsupported encodings and runtime conditions remain
unknown. Never turn an error, unsupported parser, NULL or ambiguity into a
fabricated zero-reference result.

Scan scope fixes the table list at start and uses each table's initial schema;
schema/data changes during a run require a fresh scan. A resumed worker rereads
the current table's schema. This cache reduces metadata queries, not the need
to validate against a stable dataset for consequential changes.

Nested inverse filters require MySQL `JSON_TABLE` support. A query error on an
older server remains an error. Incoming rows are rechecked with the local
extractor; SQL/parser mismatches are separately returned, not counted as proven
references. Continue with `nextOffset` even if a page contains only mismatches.

## Validation

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib config_relations
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib control_server::tests
node --test sidecar/relationTools.test.mjs sidecar/mcp-server.test.mjs
node --test src/workbench/composables/useAgent.test.js
node scripts/test-mcp-permissions-browser.mjs
npm run build
DBSCOUT_MCP_SERVER_PATH=src-tauri/resources/mcp-server.mjs node --test sidecar/mcp-server.test.mjs
```

The browser check uses a Vite mock server at `DBSCOUT_MCP_TEST_URL` (default
`http://127.0.0.1:1431`). It verifies opt-in defaults, independent toggles,
dialog reopening and small-window scrolling. It does not enable permissions in
an installed desktop app. Fixtures cover rule versions/history, schema drift,
parser boundaries, scan buffering/cursors, source access and redaction. Installed
desktop/MySQL end-to-end acceptance and representative cold/warm timing remain
separate from unit, protocol, mock-browser and build validation.
