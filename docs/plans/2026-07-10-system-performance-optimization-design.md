# System Performance Optimization Design

## Status

Approved direction: staged system-wide performance program.

This document turns the July 10 performance audit into an implementation
architecture. It intentionally treats correctness, responsiveness, throughput,
and memory as one system. A fast result that can query the wrong database, lose
audit coverage, or exhaust memory is not an acceptable optimization.

## Goal

Make DB Scout Workbench consistently responsive under large and concurrent
workloads:

- large schemas (800 to 2,000 tables),
- large loaded grids (50,000 to 100,000 rows),
- wide tables (40 to 500 columns),
- deep MySQL and ClickHouse pagination,
- 10,000 to 100,000 row imports and exports,
- long Agent conversations and streaming output,
- background backup, audit sync, updater, and Agent work.

The primary product path is opening and browsing a large table. Search, editing,
import/export, startup, and background tasks are equal regression gates.

## Non-Goals

- Replacing Vue, Tauri, sqlx, or the existing product shell.
- Rewriting the grid before measured evidence shows that the current renderer
  cannot meet the wide-table budget after lower-risk hot-path fixes.
- Removing safety layers, exact validation, audit history, rollback semantics,
  or partial-import reporting to obtain benchmark wins.
- Treating debug-mode timings or one-off console logs as release evidence.

## Confirmed Baseline Findings

The following are current-code facts, not speculative opportunities:

1. A single `RuntimeConnection.pool` can be reused for a different database.
   Schema reads qualify the requested database, while page and mutation SQL use
   an unqualified table. Same-named tables can therefore be read or written in
   the wrong database after a database switch.
2. Database selection reads the table list in `select_database`, then the
   frontend immediately reads it again with `list_tables`.
3. Database selection starts four workers that fetch schema for the first 80
   tables. The database-home visible-row loader has a separate in-flight set, so
   the same table can be fetched twice.
4. Opening, paging, updating, inserting, and deleting repeatedly read schema
   metadata that the table session already had enough information to retain.
5. Exact row count is requested through a one-row page request. The backend
   performs both `COUNT(*)` and the otherwise-unused one-row data query.
6. Table sessions are inserted but never removed. Sessions retain pool clones,
   so closed tabs and temporary export sessions keep resources alive.
7. The backup scheduler awaits network/database work while holding the global
   runtime mutex.
8. Grid navigation repeatedly reconstructs visual rows and linearly searches
   row keys. A local synthetic run measured about 110 ms per arrow-key move at
   100,000 loaded rows.
9. Insert-draft primary-key feedback rebuilds loaded-row signatures on each
   draft update. A local synthetic run measured about 76 ms per update at
   100,000 loaded rows.
10. Import preflight validation compares each accepted draft with all earlier
    drafts. A local synthetic run measured about 4.5 seconds for 10,000 rows,
    before any database work.
11. Import then calls the complete insert/schema/audit/sync path once per row.
12. Audit sync spawns a new outbox push task after each committed mutation,
    without debounce or single-flight protection.
13. Table search can load the entire table and run fuzzy matching on every cell
    on the UI thread. For tables without a primary key, row-key reconstruction
    makes the effective work approach O(rows * columns^2).
14. Appending pages copies all previously loaded rows into a new array, making a
    long infinite-scroll session increasingly expensive.
15. Vertical row virtualization exists, but scroll state updates on every event
    and all columns are rendered. There is no horizontal column window.
16. Excel import/export parses, builds, and copies complete workbooks on the UI
    thread. Export converts a byte buffer to a normal JavaScript number array
    before IPC.
17. Agent text deltas mutate reactive text immediately, causing repeated full
    Markdown parsing and scroll work as the response grows.
18. Performance marks only print isolated development logs. They cannot produce
    p50/p95, slow-frame ratios, memory-retention results, or reproducible reports.
19. The current explicit frontend test enumeration has five pre-existing static
    assertion failures. The documented directory test commands do not recurse
    correctly under the installed Windows/Node runtime.

The audit also found an export completeness risk: export loops use an inexact
lower-bound `totalRows` as if it were exact, so a full first page can incorrectly
terminate the export. That regression must be covered before export refactoring.

## Chosen Approach

Use a staged performance program, with a correctness and measurement foundation
before high-risk paging or rendering changes.

The rejected alternatives are:

- Hotspot-only patches. They would improve isolated interactions but leave pool
  identity, session leaks, bulk IO, and background contention intact.
- Immediate grid/data-layer rewrite. It has a larger regression surface than the
  evidence currently justifies and would make before/after attribution weak.

Each stage must leave the product releasable, publish before/after measurements,
and meet the shared regression budget.

## Architecture

### 1. Measurement And Reproducibility

Replace isolated console timing with a small performance recorder:

- Every run gets a run ID, commit, build mode, WebView version, OS, CPU, memory,
  database version, fixture version, and power-mode metadata.
- Timed operations produce structured start/end records and a final JSON report.
- UI actions use input-to-double-rAF measurement so the end point is after a
  render opportunity rather than before paint.
- Scroll tests record every sampled frame interval, long tasks, mounted rows and
  cells, and slow-frame ratio.
- Backend commands record phases separately: pool acquisition, schema, SQL,
  row conversion, serialization, audit, and sync notification.
- A bounded in-memory ring buffer prevents instrumentation from becoming a leak.
- Production logging remains off by default. Release benchmark builds enable it
  explicitly.

Add deterministic fixtures:

- frontend pure benchmarks at 1k/10k/50k/100k rows,
- 800 tables with 60 columns for schema search,
- 40/200/500-column grids,
- a release-mode stress profile with deterministic data,
- an optional real MySQL 5.7 fixture with 1 million rows and composite-key,
  nullable-key, no-key, and same-table-name cross-database cases.

Time budgets are local release gates, not brittle unit assertions. Unit tests
instead assert operation counts and complexity boundaries, such as one index
build followed by O(1) navigation lookups.

### 2. Connection And Pool Identity

Introduce explicit pool identity:

```text
PoolKey = (connection_id, database)
```

`RuntimeConnection` retains connection configuration and a database-neutral pool
for server-level operations. A bounded pool registry owns database-specific
pools. A table session records the exact `PoolKey` it was created from.

Rules:

- A session may only execute through a pool whose key matches its database.
- Session SQL qualifies both database and table as defense in depth.
- Pool creation is single-flight per key.
- Idle pools with no live sessions are eligible for LRU eviction.
- Removing a connection closes its pools and invalidates its sessions.
- ClickHouse connections own one reusable `reqwest::Client` instead of creating
  a client per request.

Database selection becomes one operation with one owner for table-list loading.
The frontend must not issue a duplicate list request.

### 3. Session And Schema Lifecycle

Expand `TableSession` to own:

- pool identity and pool handle,
- `Arc<TableMeta>`,
- schema generation,
- creation and last-access timestamps,
- pagination cursor state,
- count request/cache state.

Add explicit close commands. Frontend tab removal, temporary export completion,
connection deletion, and app teardown close sessions. The backend also enforces
an idle timeout and a hard capacity limit as a safety net.

Schema metadata uses a cache keyed by connection/database/table:

- single-flight load,
- short freshness TTL,
- explicit invalidation after DDL, rename, drop, copy, sync, restore, and import
  operations that can change schema,
- manual refresh bypass,
- generation checks in sessions,
- one safe refresh-and-retry for idempotent reads after a schema mismatch.

Writes never blindly retry after execution uncertainty. They invalidate schema
and return a clear recoverable error.

The frontend replaces separate background and visible-table in-flight sets with
one metadata coordinator. Batch schema reads use the existing multi-table
information-schema query instead of one request per table.

### 4. Count And Paging

Separate row counting from page fetching:

- Interactive page requests never perform a count.
- A dedicated count command returns exact/estimated state explicitly.
- Unfiltered MySQL tables may show a fast information-schema estimate first.
- Exact count runs at low priority, is single-flight by filter signature, and is
  cancellable when the tab/filter/session changes.
- Count completion updates metadata only; it does not fetch a data row.

Paging uses a hybrid strategy:

- Sequential next/previous navigation on a stable primary/unique key uses a
  cursor.
- Sorts use `(sort_column, primary_key...)` cursor tuples to handle duplicates.
- Composite keys, NULL ordering, ascending/descending order, and concurrent
  inserts/deletes get dedicated tests.
- Arbitrary page jumps, unsupported sorts, and tables without a stable unique
  order fall back to OFFSET with an explicit performance classification.
- Exports use sequential cursor reads and never infer completion from an inexact
  row-count lower bound.

This is a separate later stage because keyset pagination changes ordering and
navigation semantics; it is not treated as a drop-in SQL replacement.

### 5. Frontend Data Version And Row Index

Create one tab data generation that increments on every operation that can
change row identity or order:

- page replace/append,
- successful edit and optimistic rollback,
- inserted-row promotion,
- delete/refresh,
- primary-key metadata change,
- sibling-tab synchronization.

A WeakMap cache keyed by tab and generation stores:

- row keys in data order,
- `rowKey -> dataIndex`,
- primary-key signature set,
- insert-row positions,
- visual-index translation helpers.

Normal navigation, row selection, selected-cell lookup, agent focus actions,
range copy, and delete lookup use this shared index. They must not rebuild all
row keys or all visual rows per pointer/key event.

Visual rows become an addressable model rather than a repeatedly materialized
array. Range copy resolves the model once and reads cells directly. Insert paste
applies a complete matrix, then validates and invalidates once.

Page append mutates/chunks the destination array without copying all historical
rows, then increments the generation exactly once.

### 6. Search

Table search no longer loads an entire table into the ordinary tab merely to
find a match:

- input is debounced,
- backend filtered result pages are the default whole-table path,
- local matching locates the matching cell only inside returned pages,
- continuing search fetches the next filtered page,
- clearing search restores normal page/sort/selection semantics,
- unsaved insert drafts are resolved before mode changes.

Local scan helpers receive precomputed row keys and skip typo-distance for long
text/query combinations where it cannot meet the interaction budget.

Schema search builds a normalized index when metadata changes, debounces input,
uses cheap exact/prefix/contains checks first, bounds typo matching, and
virtualizes result rendering.

Cross-database value search gains a backend cancellation token, bounded
concurrency, progressive result events, and a query shape that avoids scanning
the same table once per column where supported. UI work has higher pool/task
priority than value-search work.

### 7. Grid Rendering

First optimize the current renderer:

- coalesce scroll updates with rAF,
- update the virtual window only when row indices change,
- precompute visible-row and visible-column metadata,
- compute highlight/error/selection render state once per visible cell,
- apply column widths through a shared track/colgroup rather than touching every
  mounted cell during pointer movement,
- add CSS containment/content visibility where WebView behavior is verified.

If the 200/500-column release fixture still misses the frame budget, add a
horizontal column window:

- render the union of visible, overscan, frozen, selected, and actively edited
  columns,
- use prefix-sum column metrics and stable left/right spacers,
- keep clipboard/range operations data-driven rather than DOM-driven,
- ensure keyboard navigation can cross an unmounted column and then mount it,
- preserve frozen columns, auto-fit, resize, and context menus.

The horizontal window is evidence-gated but fully specified because it is the
expected solution for genuinely wide tables.

### 8. Bulk Writes And Audit

Add a batch insert contract:

```text
request: session, job_id, rows[{source_row, draft}], chunk_size
response: inserted, skipped, row_errors[], cancelled
```

Backend behavior:

- load schema once,
- build primary-key signature sets once,
- validate in O(rows),
- process bounded chunks in transactions,
- reuse prepared SQL where row shape permits,
- batch pending/final audit updates in SQLite transactions,
- use savepoints or split a failed chunk to preserve per-row error reporting,
- check cancellation between chunks,
- notify audit sync once after a committed batch.

The same infrastructure supports batch delete and multi-cell paste. It preserves
partial completion at chunk boundaries, progress, cancellation, before-images,
rollback records, and deterministic error row numbers.

Audit sync becomes one background worker driven by a channel/`Notify`. Multiple
mutation signals coalesce, maximum network concurrency is one, and new work that
arrives during a push schedules one subsequent pass.

### 9. Import, Export, Backup, And Restore

Excel parsing/generation must not block the UI thread.

Transition path:

1. Move workbook parse/build to a Web Worker and keep large non-UI structures in
   shallow/non-reactive state.
2. Replace per-row imports with the backend batch command.
3. Move export to a backend job that opens the destination first, streams rows,
   writes a temporary file, reports progress, supports cancellation, and
   atomically renames on success.

The final backend export path avoids complete row arrays, complete JS workbook
objects, byte-array-to-number-array IPC, and synchronous file writes in async
commands.

Backup snapshots stream database rows through a bounded buffer to disk. Restore
uses a streaming SQL parser rather than reading the whole file and building a
complete statement vector. Snapshot size checks use estimates first and exact
counts only near a configured threshold.

The backup scheduler copies connection configuration while holding the runtime
lock, releases the lock, and only then performs network work. If the enabled
database whitelist is empty, it performs no database enumeration.

### 10. Startup, Agent, And Background Priority

Startup establishes the first usable screen before secondary work:

- restore the selected connection first,
- show saved non-selected connections as placeholders and restore them lazily or
  with bounded background concurrency,
- enforce connection timeouts,
- schedule updater checks and Agent prewarm only after first usable paint/idle,
- cancel or defer background schema/value/profile work when foreground table
  work arrives.

Agent DB requests use bounded concurrency and a low-priority permit pool. Profile
and schema caches are bounded LRU caches with cancellation. They cannot consume
all five MySQL connections needed by foreground work.

Agent streaming buffers text/thinking deltas and flushes at most once per frame
or every 30-50 ms. Streaming uses a lightweight representation; full Markdown
is parsed once at completion. Auto-scroll is coalesced, and old messages use
content visibility or virtualization after measured validation.

## Error Handling And Fallbacks

- Cache miss/freshness failure falls back to a real schema read.
- Idempotent page reads may refresh schema and retry once; writes do not retry
  after ambiguous execution.
- Cursor paging falls back to OFFSET when a stable order cannot be proven.
- Batch job cancellation leaves committed chunks audited and reports the exact
  stopping point.
- Export/backup cancellation removes temporary files and never replaces a valid
  destination with a partial file.
- Worker failure falls back to a surfaced error, not silent main-thread work for
  an unbounded workbook.
- Background task errors never hold runtime locks or block foreground commands.
- Performance instrumentation is bounded and failure-isolated.

## Test Strategy

### Correctness Gates

- Two databases with same-named sentinel tables: read/update/insert/delete must
  only affect the requested database after arbitrary database switching.
- Simultaneous sessions for both databases remain isolated.
- Closing tabs, temporary exports, connection removal, and idle cleanup release
  sessions and eligible pools.
- DDL/rename/drop/copy/sync/restore invalidate exactly the affected schema.
- Composite/nullable cursor paging has no gaps or duplicates in both directions.
- Search mode preserves filter, sort, draft, selection, and clear/restore rules.
- Batch import preserves source row numbers, partial success, cancellation,
  audit records, and rollback behavior.
- Export continues until `has_more == false`, independent of exact totals.
- Backup/restore streaming output is byte/statement equivalent to the current
  accepted format.

### Performance Gates

Run five warmups and 30 measured samples in release mode:

| Scenario | Initial target |
| --- | --- |
| Cold startup | p95 <= 2 s |
| Warm startup | p95 <= 1 s |
| Switch 800-table database | first paint p95 <= 250 ms, no >50 ms long task |
| Open 1,000 x 12 table | first row paint p95 <= 350 ms |
| Open 1,000 x 40 table | first row paint p95 <= 500 ms |
| Arrow navigation at 100k loaded rows | p95 <= 16 ms |
| Insert draft update at 100k rows | p95 <= 16 ms |
| Scroll 5,000 x 40 for 10 s | frame p95 <= 20 ms, >50 ms frames < 1% |
| Search 5,000 x 40 | first result p95 <= 100 ms, next hit <= 16 ms |
| Deep page in 1M-row MySQL table | page 1000 p95 <= 2x page 1 on cursor path |
| Import 10k rows | no >100 ms UI long task; record throughput and errors |
| Open/close 20 tabs | retained growth <= 15 MB |

Shared regression budget:

- primary target paths improve p95 by at least 25%,
- non-target p95 does not regress by more than 5%,
- retained memory does not regress by more than 10%,
- foreground latency with backup/Agent/audit activity does not regress by more
  than 10%.

### Verification Commands

The implementation plan will replace broken directory shortcuts with explicit
test scripts. Final verification includes:

- focused frontend tests per task,
- all frontend tests through the new recursive runner,
- sidecar test files through an explicit runner,
- Rust unit/integration tests,
- `cargo check`,
- production frontend/sidecar build,
- release-mode Playwright/Tauri performance suite,
- real MySQL integration suite when credentials are available,
- worktree diff and generated-artifact audit.

## Delivery Stages

1. Performance harness and clean correctness baseline.
2. Cross-database pool identity, session lifecycle, backup lock release.
3. Shared row index, visual addressing, linear validation, append behavior.
4. Schema single-flight/cache, duplicate selection removal, dedicated count.
5. Search pipeline and grid hot-path reduction.
6. Batch import/delete and audit-sync worker.
7. Cursor pagination and bounded page memory.
8. Streaming export/backup/restore.
9. Startup/background priority, ClickHouse client reuse, Agent buffering.
10. Evidence-gated horizontal column virtualization.
11. Full release benchmarks, regression repairs, and completion audit.

Each stage is test-driven, independently reviewed, benchmarked against the same
fixture, and committed separately. Existing unrelated version changes remain
outside these commits.

## Completion Criteria

The goal is complete only when:

- every confirmed hotspot above is fixed or has measured evidence showing it is
  below its budget,
- all correctness and performance gates have authoritative results,
- the cross-database sentinel suite proves read/write isolation,
- session/pool/memory cleanup is demonstrated,
- no required test/build/runtime path is failing,
- release-mode before/after reports are stored with environment metadata,
- the final diff contains no unrelated user changes.
