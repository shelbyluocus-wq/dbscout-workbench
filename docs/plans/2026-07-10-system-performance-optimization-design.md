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
- Frontend and backend spans share the run/span IDs so an IPC duration can be
  reconciled with its database and serialization phases.
- A bounded in-memory ring buffer prevents instrumentation from becoming a leak.
- Production logging remains off by default. Release benchmark builds enable it
  explicitly.

Add deterministic fixtures:

- frontend pure benchmarks at 1k/10k/50k/100k rows,
- 800 tables with 60 columns for schema search,
- 40/200/500-column grids,
- a release-mode stress profile with deterministic data,
- a deterministic real MySQL 5.7 fixture with 1 million rows and composite-key,
  nullable-key, no-key, and same-table-name cross-database cases.

The browser and release demo fixtures are generated from one versioned canonical
JSON profile. A browser-safe generator, the Node harness, and Rust hash the exact
same specification bytes and publish the profile, version, and SHA-256 with
every report; Node-only APIs never enter the frontend bundle. Named scenarios
are whitelisted and large pages are generated lazily; benchmark scripts cannot
inject rows directly into Vue state or mount a substitute grid. Browser runs
exercise the ordinary `invokeWorkbench -> mockWorkbenchInvoke` path.

A recognized `DBSCOUT_PERF_PROFILE` is the only way to activate this fixture in
a release build and takes precedence over `DBSCOUT_MYSQL_URL`, so a benchmark
can never connect to a user's configured database. Blank or unknown profiles do
not alter normal behavior. Runtime metadata also reports
`debugAssertions`, `frontendSource` (from `tauri::is_dev()`), and
`usesExternalDatabase`.

The real MySQL fixture is a completion requirement, not an optional skipped
check. On this Windows host it is created as an isolated temporary instance from
the installed MySQL 5.7 binaries. It never uses or modifies the user's running
MySQL service. A supported MySQL 8 fixture is also required before final release
when MySQL 8 is in the supported product matrix.

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
- Agent DB tools obtain pools by their explicit database context.
- Audit rollback obtains the pool from the audit entry's connection/database and
  safely executes historical unqualified inverse SQL in that database context.

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
- Count cache keys include the table mutation generation. Insert, delete,
  filtered-column update, import, rollback, sync, restore, and Agent writes
  invalidate affected table/database generations.
- Count, metadata prefetch, value search, Agent profiling, export, and backup all
  consume one shared per-pool background budget that reserves capacity for
  foreground page/edit commands.

Paging uses a hybrid strategy:

- Sequential next/previous navigation on a stable primary/unique key uses a
  cursor.
- Sorts use `(sort_column, primary_key...)` cursor tuples to handle duplicates.
- Composite keys, NULL ordering, and ascending/descending order get dedicated
  tests. A nullable unique key is not a stable total order by itself.
- Arbitrary page jumps, unsupported sorts, and tables without a stable unique
  order fall back to OFFSET with an explicit performance classification.
- Interactive browsing uses live-keyset semantics: rows committed behind the
  cursor may appear later, and mutations ahead of/behind the cursor can change
  what subsequent pages contain. Cursors are bound to pool, table, filter, sort,
  page size, schema generation, and typed values, and stale/tampered cursors are
  rejected.
- Export and backup use one dedicated connection and a `REPEATABLE READ`
  consistent snapshot. They use sequential cursor reads and never infer
  completion from an inexact row-count lower bound.

This is a separate later stage because keyset pagination changes ordering and
navigation semantics; it is not treated as a drop-in SQL replacement.

### 5. Frontend Data Version And Row Index

Introduce a `RowStore` interface before adding caches. It separates absolute row
position, loaded page/range, row key, and materialized row access. Small tables
use a dense array implementation; later bounded paging uses the same interface.
Grid/editor/search/Inspector/Agent consumers do not read `tab.rows` directly
after migration.

Create one tab data generation that increments on every operation that can
change row identity or order:

- page replace/append,
- successful edit and optimistic rollback,
- inserted-row promotion,
- delete/refresh,
- primary-key metadata change,
- sibling-tab synchronization.

A WeakMap cache keyed by RowStore and generation stores:

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
find a match. Existing exact/prefix/contains/subsequence/Levenshtein behavior is
preserved through a dedicated cancellable backend search job:

- input is debounced,
- SQL-compatible candidates return first,
- when typo-distance semantics can add results, the backend streams remaining
  rows through the same matcher and emits progressive result pages,
- local matching only renders/navigates returned matches,
- continuing search fetches the next result page without populating the normal
  table RowStore,
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

Add a chunked batch insert contract:

```text
begin: session, job_id, expected_rows, options
append: job_id, chunk_id, rows[{source_row, draft}]
finish: job_id
cancel: job_id
response: accepted_chunk, inserted, skipped, row_errors[], cancelled
```

Backend behavior:

- limit each chunk by row count and serialized bytes, allow one in-flight chunk,
  and make `chunk_id` idempotent,
- load schema once,
- build primary-key signature sets once,
- validate in O(rows),
- persist audit job/chunk/row intent before business writes and fail closed when
  the audit store is unavailable,
- process bounded chunks in transactions; use a multi-row fast path and roll the
  failed chunk back before a savepoint-per-row diagnostic fallback,
- reuse prepared SQL where row shape permits,
- batch pending/final audit updates in SQLite transactions,
- use the savepoint-per-row fallback to preserve exact per-row error reporting,
- check cancellation between chunks,
- classify each row/chunk as pending, committed, aborted, or commit_unknown,
- reconcile incomplete jobs at startup without blindly retrying ambiguous
  business commits,
- expose only terminal audit rows to outbox sync and notify once per batch.

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

The final backend export path uses `rust_xlsxwriter` constant-memory mode with
inline strings, a byte-bounded row buffer, and a dedicated snapshot connection.
It avoids complete row arrays, complete JS workbook objects,
byte-array-to-number-array IPC, and synchronous file writes in async commands.

Backup snapshots use a dedicated `REPEATABLE READ` connection and stream database
rows through a byte-bounded buffer to a temporary file. Every write/flush/rename
error is propagated, and success atomically publishes the data file followed by
its manifest as the completion marker. Restore uses a streaming SQL parser rather
than reading the whole file and building a complete statement vector. Before its
destructive phase it acquires an exclusive per-database maintenance barrier,
stops background work, and rejects new reads/writes. Cancellation remains safe
before that phase; once MySQL DDL has started, the job finishes or reports
`recovery_required` with the pre-restore snapshot instead of claiming an atomic
rollback. Every exit invalidates affected sessions, cursors, caches, pending
edits, and RowStores. Snapshot size checks use estimates first and exact counts
only near a configured threshold. Verification compares restored schema, row
counts, and per-table checksums rather than unstable SQL byte ordering.

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

One per-pool scheduler owns foreground/background permits for Agent DB requests,
schema prefetch, count, value search, import/export, and backup. It reserves
foreground capacity, bounds all background work together, and defines fairness
and timeout rules. Profile and schema caches are bounded LRU caches with
cancellation. Server-side query cancellation is verified; when it cannot be
guaranteed, background queries use a separate low-capacity pool and query
timeout.

Agent streaming buffers text/thinking deltas and flushes at most once per frame
or every 30-50 ms. Streaming uses a lightweight representation; full Markdown
is parsed once at completion. Auto-scroll is coalesced, and old messages use
content visibility or virtualization after measured validation.

## Error Handling And Fallbacks

- Cache miss/freshness failure falls back to a real schema read.
- Cache loads capture the current generation and discard late results after
  invalidation. Connection/database/old-table/new-table invalidation is
  case-normalized; failures are never cached; external DDL ages out by TTL.
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
- Composite/non-null-unique cursor paging has no gaps or duplicates for a stable
  dataset. Live browsing concurrency follows the documented live-keyset rules;
  export/backup proves snapshot consistency.
- Search mode preserves filter, sort, draft, selection, and clear/restore rules.
- Batch import preserves source row numbers, partial success, cancellation,
  audit records, and rollback behavior.
- Export continues until `has_more == false`, independent of exact totals.
- Deterministic parser fixtures preserve statement semantics; real streamed
  backup/restore preserves schema signatures, row counts, and canonical per-table
  checksums rather than unstable SQL byte order.

### Performance Gates

Measurement protocols differ by metric:

- interactive latency: at least 100 samples, same-machine before/after runs
  interleaved, with bootstrap confidence intervals,
- startup: a fresh process for every sample, reported separately for app-cold
  and OS-cold runs, with no warmup applied to cold-start samples,
- frames: the complete distribution over thousands of frame intervals,
- memory: retained-memory slope and plateau at 20/50/100 repetitions,
- database throughput: fixed fixture/server state with raw samples retained.

The table below defines product targets, but regression decisions are made only
when confidence intervals cross the configured threshold:

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
| Browse 1M rows through page store | materialized rows <= resident-window + row shadows; WebView retained growth <= 96 MB and plateaus |
| Import 10k rows | no >100 ms UI long task; record throughput and errors |
| Open/close 20/50/100 tabs | retained slope plateaus; 20-cycle growth <= 15 MB |
| Grid at 200/500 columns | frame p95 <= 20/25 ms; mounted cells bounded to window |
| Agent 20k-char stream | no >100 ms long task; final Markdown parse <= 100 ms |

Shared regression budget:

- primary target paths improve p95 by at least 25%,
- non-target confidence interval does not prove a regression above 5%,
- retained memory does not regress by more than 10%,
- foreground latency with backup/Agent/audit activity does not regress by more
  than 10%.

All confidence decisions use a deterministic-seed 95% bootstrap interval. An
absolute p95 target passes only when its upper confidence bound is inside the
budget. A required 25% improvement passes only when the lower confidence bound
of the improvement reaches 25%. A regression fails when the lower confidence
bound of the regression exceeds its allowed budget. A result that crosses a
boundary is `INCONCLUSIVE`; the harness adds samples and cannot report completion
while it remains inconclusive.

The authoritative Windows run builds with the literal command
`npm run tauri -- build` and launches the newly produced release executable with
embedded `frontendDist`. Browser Playwright is supporting evidence only. The
release report binds source commit, dirty-diff hash, executable SHA-256, WebView2
version, frontend/backend run ID, fixture hash, and scenario version so an old
binary or stale report cannot satisfy a gate.

The early Task 4 `before` capture is a raw, single-build diagnostic baseline.
It never claims an improvement and cannot satisfy an authoritative matrix cell.
Task 29 rebuilds that exact commit and the candidate, runs both real executables
in deterministic interleaved order, and owns all bootstrap confidence verdicts.

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
- mandatory isolated MySQL 5.7 integration suite created by the fixture script,
- worktree diff and generated-artifact audit.

## Delivery Stages

1. Performance harness, evidence matrix, and clean correctness baseline.
2. Cross-database pool identity across UI/Agent/rollback, session lifecycle,
   backup lock release.
3. RowStore abstraction, shared row index, visual addressing, linear validation,
   append behavior.
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
- all correctness and performance gates have authoritative results; `SKIP`,
  `missing`, `indirect`, and `INCONCLUSIVE` evidence count as incomplete.
  Evidence-gated Task 28 may use `NOT_REQUIRED` only when its direct 200/500-
  column release measurements already satisfy every absolute gate,
- the cross-database sentinel suite proves read/write isolation,
- session/pool/memory cleanup is demonstrated,
- no required test/build/runtime path is failing,
- release-mode before/after reports are stored with environment metadata,
- an evidence matrix links every baseline finding to its implementation task,
  correctness test, performance scenario, raw before/after reports, and status,
- the final diff contains no unrelated user changes.
