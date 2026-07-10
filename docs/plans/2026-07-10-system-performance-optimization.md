# System Performance Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the confirmed correctness, latency, throughput, and memory bottlenecks in DB Scout Workbench and prove the improvement with repeatable release-mode evidence.

**Architecture:** Establish deterministic measurement first, then fix pool/session identity and shared data indexing before changing search, paging, and bulk IO. Foreground work gets explicit priority; caches use generation-based invalidation plus bounded lifetime; high-volume operations become cancellable backend jobs instead of repeated UI-thread or IPC work.

**Tech Stack:** Tauri 2, Rust 2021, sqlx 0.8 MySQL/SQLite, reqwest ClickHouse, Vue 3 Composition API, Vite 6, Node `node:test`, Playwright, XLSX.

**Design:** `docs/plans/2026-07-10-system-performance-optimization-design.md`

---

## Working Rules

- Commit this plan first, then execute in a dedicated worktree based on that
  plan commit.
- Preserve the user's unstaged `0.1.8` version changes in the original worktree.
- Use @superpowers:test-driven-development for every behavioral change.
- Use @superpowers:systematic-debugging for every unexpected failure.
- Use @superpowers:verification-before-completion before each stage handoff.
- One behavior boundary per commit. Never combine unrelated cleanup.
- Timing assertions do not belong in normal unit tests. Unit tests assert work
  counts/complexity; local release benchmarks record timings.
- Update command contracts together across Rust, registration, frontend bridge,
  mock backend, and tests.

## Stage 1: Measurement And Correctness Foundation

### Task 0: Create The Isolated Worktree And Capture The Raw Baseline

**Files:**
- No source changes.
- Runtime output only: `output/performance/task-0-baseline.txt`

**Step 1: Verify the worktree parent is ignored**

Run from `E:\project\dbscout-workbench`:

```powershell
git check-ignore -q .worktrees
if ($LASTEXITCODE -ne 0) { throw '.worktrees must be ignored before use' }
git status --short
```

Expected: `.worktrees` is ignored; only the user's existing `0.1.8` changes are
dirty in the original worktree.

**Step 2: Create the feature worktree from the committed plan**

```powershell
git worktree add .worktrees/system-performance-optimization -b codex/system-performance-optimization HEAD
Set-Location .worktrees/system-performance-optimization
git status --short
```

Expected: the new worktree is clean and contains both July 10 performance docs.

**Step 3: Install exact dependencies**

```powershell
npm ci
Push-Location sidecar
npm ci
Pop-Location
npm run ensure-node
npm run build:sidecar
```

Expected: both installs exit 0 without changing either lockfile. The ignored
`src-tauri/resources/node/node.exe`, `agent-runner.mjs`, and native CLI resource
exist before any direct Cargo command; a fresh worktree otherwise fails Tauri's
resource glob before compiling the crate.

**Step 4: Capture the known frontend baseline before repairing it**

```powershell
New-Item -ItemType Directory -Force output/performance | Out-Null
$tests = Get-ChildItem src/workbench -Recurse -File | Where-Object { $_.Name -match '\.test\.(js|mjs)$' } | Sort-Object FullName
& node --test $tests.FullName 2>&1 | Tee-Object output/performance/task-0-baseline.txt
```

Expected on `65ae0f2`: 829 tests, 824 passing, with the five documented
`workbenchShell.test.js` failures. The two additional passing tests relative to
the earlier 827-test audit came from merged homepage-keyboard fixes in `30ac81d`.
Any different result must be investigated before Task 1.

**Step 5: Capture Rust and repository state**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
git status --short
git rev-parse HEAD
```

Expected: Rust tests complete; dependency installation did not dirty tracked
files. Task 0 has no commit.

### Task 1: Reliable Recursive Test Runners

**Files:**
- Create: `scripts/test-files.mjs`
- Create: `scripts/test-files.test.mjs`
- Create: `scripts/test-workbench.mjs`
- Create: `scripts/test-sidecar.mjs`
- Modify: `AGENTS.md:45-65`
- Modify: `CLAUDE.md:45-65`

**Step 1: Write the failing collector tests**

Test deterministic recursive collection, lexical ordering, ignored directories,
and exact `.test.js` / `.test.mjs` matching:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("collectTestFiles recursively returns only ordered test modules", async (t) => {
  const module = await import("./test-files.mjs").catch(() => ({}));
  assert.equal(typeof module.collectTestFiles, "function", "collector module is unavailable");
  const { collectTestFiles } = module;
  const root = await mkdtemp(path.join(tmpdir(), "dbscout-tests-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested"), { recursive: true });
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "a.test.js"), ""),
    writeFile(path.join(root, "ignored.js"), ""),
    writeFile(path.join(root, "nested", "b.test.mjs"), ""),
    writeFile(path.join(root, "node_modules", "hidden.test.js"), ""),
  ]);

  const files = await collectTestFiles(root, {
    ignoredDirectories: new Set(["node_modules", "resources"]),
  });
  assert.deepEqual(files.map((file) => path.relative(root, file).replaceAll("\\", "/")), [
    "a.test.js",
    "nested/b.test.mjs",
  ]);
});
```

**Step 2: Run the test and verify RED**

Run: `node --test scripts/test-files.test.mjs`

Expected: FAIL with `collector module is unavailable` (not an uncaught module
loader error).

**Step 3: Implement the collector and runners**

`test-workbench.mjs` must collect under `src/workbench` and spawn:

```js
spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
```

`test-sidecar.mjs` must enumerate sidecar test modules explicitly so it never
executes the long-running sidecar entrypoint.

**Step 4: Run focused and full baseline commands**

Run:

```powershell
node --test scripts/test-files.test.mjs
node scripts/test-workbench.mjs
node scripts/test-sidecar.mjs
```

Expected: collector PASS; workbench reports the known baseline failures by exact
name; sidecar exits instead of hanging.

**Step 5: Update both project instruction files**

Replace the broken directory commands with the two scripts. Keep `AGENTS.md` and
`CLAUDE.md` byte-equivalent except for their existing introductory wording.

**Step 6: Commit**

```powershell
git add scripts/test-files.mjs scripts/test-files.test.mjs scripts/test-workbench.mjs scripts/test-sidecar.mjs AGENTS.md CLAUDE.md
git commit -m "test: add reliable recursive test runners"
```

### Task 2: Repair The Pre-Existing Frontend Baseline

**Files:**
- Modify: `src/workbench/workbenchShell.test.js:1260-1490`
- Modify: `src/workbench/components/DataGrid.vue:710-730`
- Modify: `src-tauri/Cargo.toml:30`
- Modify mechanically: `Cargo.lock`
- Test: `src/workbench/workbenchShell.test.js`

**Step 1: Reproduce each failure independently**

Run:

```powershell
node --test src/workbench/workbenchShell.test.js
```

Reproduce these exact failures:

- `theme palettes style the full workbench and its sidebar settings control`
- `grid readability uses comfortable density and stronger theme contrast tokens`
- `semantic text tokens keep metadata and support content readable in both themes`
- `data grid uses row headers and insert-row keyboard wiring`
- `tauri updater uses the local SVN update directory flow`

Expected: RED with exactly these five failures and no additional failure.

**Step 2: Fix the smallest authoritative side**

- Update the first three test helpers to extract the dark-theme block from the
  valid combined selector `.mysql-workbench[data-theme="dark"],
  .wb-floating-themed[data-theme="dark"]`. Keep assertions for the actual
  tokens; do not loosen them to arbitrary CSS.
- Change the frozen-row header in `DataGrid.vue` to use the same
  `dataRowVisualIndex(tab, originalIndex)` helper as ordinary virtual rows so
  anchored insert drafts cannot produce inconsistent row numbers.
- Remove the unused `tauri-plugin-updater` dependency. The product uses the
  local SVN updater; source, capability, and Tauri configuration have no live
  plugin-updater path. Regenerate only the dependency graph in `Cargo.lock`.
- Do not weaken regexes to accept both incompatible states.

**Step 3: Verify the repaired baseline**

Run: `node scripts/test-workbench.mjs`

Expected: all current workbench tests PASS before performance code begins.

Also run:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS without the unused updater crate.

**Step 4: Commit the three independent repairs**

```powershell
git add src/workbench/workbenchShell.test.js
git commit -m "test: support combined theme selectors"
git add src/workbench/components/DataGrid.vue src/workbench/workbenchShell.test.js
git commit -m "fix: keep frozen row numbers insert-aware"
git add src-tauri/Cargo.toml Cargo.lock
git commit -m "chore: remove unused updater dependency"
```

### Task 3: Structured Performance Recorder

**Files:**
- Modify: `src/workbench/utils/performanceMarks.js`
- Modify: `src/workbench/utils/performanceMarks.test.js`
- Create: `src/workbench/utils/performanceReport.js`
- Create: `src/workbench/utils/performanceReport.test.js`
- Modify: `src/workbench/utils/tauriBridge.js`
- Modify: `src/workbench/utils/tauriBridge.test.js`
- Create: `src-tauri/src/perf.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/clickhouse.rs`

**Step 1: Write failing recorder tests**

Cover bounded records plus `droppedEvents`, run metadata, unique/explicitly
parented span IDs, nearest-rank percentile summaries, double-rAF paint completion,
reset/end, error propagation, and disabled-mode zero work. Disabled tests inject
`now`/detail closures and prove neither is called.

`tauriBridge.test.js` must prove an active run sends
`x-dbscout-perf-run-id`/`x-dbscout-perf-span-id` through Tauri invoke options,
does not mutate the business payload, creates exactly one IPC span, and sends no
headers in disabled/mock fallback mode.

```js
test("recorder keeps a bounded run and summarizes percentiles", () => {
  const recorder = createPerformanceRecorder({ capacity: 3, now: fakeNow });
  recorder.recordDuration("grid.navigate", 10);
  recorder.recordDuration("grid.navigate", 20);
  recorder.recordDuration("grid.navigate", 30);
  recorder.recordDuration("grid.navigate", 40);
  assert.deepEqual(recorder.snapshot().events.map((e) => e.durationMs), [20, 30, 40]);
  assert.equal(recorder.summary("grid.navigate").p95, 40);
});
```

**Step 2: Run tests and verify RED**

Run:

```powershell
node --test src/workbench/utils/performanceMarks.test.js src/workbench/utils/performanceReport.test.js src/workbench/utils/tauriBridge.test.js
```

Expected: FAIL for missing report/recorder APIs.

**Step 3: Implement a bounded recorder**

Expose development/benchmark-only APIs on
`globalThis.__DBSCOUT_PERFORMANCE__`:

```js
{
  beginRun(metadata),
  beginSpan(label, { phase, parentSpanId, details }),
  endRun(),
  recordDuration(label, durationMs, details),
  snapshot(),
  reset(),
}
```

`invokeWorkbench` creates one explicit-parent span only and transports its IDs as
Tauri invoke headers, never request fields. Remove nested duplicate timing from
callers only as they migrate; preserve existing labels in span details. Existing
console diagnostics are separate from structured collection so console IO cannot
pollute benchmark runs. Details are a whitelisted count/stage map: never SQL,
bind values, cell data, credentials, or URLs.

**Step 4: Write and run failing Rust recorder tests**

Add tests for capacity/dropped count, concurrent explicit-parent spans, disabled
lazy details, stale guards after reset, frontend header run/span correlation,
and control-command gating. Test `PerfResponse<T>` produces JSON identical to
the original response while recording the actual `IpcResponse::body()`
serialization phase. Then run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml perf::tests
```

Expected: compile/test failure for the missing recorder API.

**Step 5: Implement the Rust recorder**

Add a Rust recorder with the same bounded/run/span model. An owned `PerfContext`
command argument reads the frontend IDs from request headers; do not add fields to
114 business request contracts. Benchmark-only commands `perf_begin_run`,
`perf_snapshot`, and `perf_end_run` are accepted only in debug or with explicit
`DBSCOUT_PERF_ENABLED=1`, do not recursively record themselves, and correlate
backend phases with the frontend run ID.

Instrument truthful boundaries only:

- command-level pool resolution/creation and schema fetch,
- MySQL and ClickHouse request/SQL wait inside `db.rs`/`clickhouse.rs`,
- their separate row/JSON conversion loops,
- audit persistence stages and audit-sync notification enqueue (not background
  HTTP completion),
- successful large-response serialization for `open_table_session` and
  `fetch_table_page` through `PerfResponse<T>: IpcResponse`.

Disabled mode must allocate no event records, call no timer, and format no detail
strings. Error-response serialization is explicitly outside this first recorder
boundary rather than mislabeled as measured.

**Step 6: Verify focused tests**

Run the commands from Steps 2 and 4, then:

```powershell
node scripts/test-workbench.mjs
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

**Step 7: Commit frontend and backend recorders separately**

```powershell
git add src/workbench/utils/performanceMarks.js src/workbench/utils/performanceMarks.test.js src/workbench/utils/performanceReport.js src/workbench/utils/performanceReport.test.js src/workbench/utils/tauriBridge.js src/workbench/utils/tauriBridge.test.js
git commit -m "perf: add structured performance recorder"
git add src-tauri/src/perf.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/commands.rs src-tauri/src/db.rs src-tauri/src/clickhouse.rs
git commit -m "perf: record backend command phases"
```

### Task 4: Deterministic Microbenchmark Harness

**Files:**
- Create: `scripts/perf/fixture-profile.v1.json`
- Create: `scripts/perf/fixtures.mjs`
- Create: `scripts/perf/fixtures.test.mjs`
- Create: `scripts/perf/workbench-benchmarks.mjs`
- Create: `scripts/perf/workbench-benchmarks.test.mjs`
- Create: `scripts/perf/ui-suite.mjs`
- Create: `scripts/perf/ui-suite.test.mjs`
- Create: `scripts/perf/process-tree.mjs`
- Create: `scripts/perf/process-tree.test.mjs`
- Create: `scripts/perf/report.mjs`
- Create: `scripts/perf/report.test.mjs`
- Create: `scripts/perf/evidence-matrix.mjs`
- Create: `scripts/perf/evidence-matrix.json`
- Create: `scripts/perf/evidence-matrix.schema.json`
- Create: `scripts/perf/evidence-matrix.test.mjs`
- Create: `src/workbench/mock/perfFixture.js`
- Create: `src/workbench/perfFixture.test.js`
- Modify: `src/workbench/mock/mockBackend.js`
- Modify: `src/workbench/mock/mockRows.js`
- Modify: `src/workbench/mock/mockSchema.js`
- Modify: `src/workbench/mockBackend.test.js`
- Create: `src-tauri/src/perf_fixture.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/demo.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `Cargo.lock`

**Step 1: Write failing fixture, report, matrix, process, and release tests**

Create `fixture-profile.v1.json` as the canonical JS/Rust fixture specification.
Test two independent generations for deep equality and identical SHA-256, fixed
sentinel cells, every required shape, primary-key and no-primary-key variants,
and lazy page generation. The fixture and ordinary mock-row path must contain no
`Math.random()` calls. A 100k x 500 scenario must never be fully materialized.

Test median/p95 calculation, environment metadata, comparison percentages, raw
sample preservation, and non-zero exit only for an explicitly requested
regression gate. Define stable finding IDs `F01` through `F20` and load the JSON
only through `evidence-matrix.mjs`. Schema mode requires every ID exactly once,
rejects duplicates and unknown IDs, and validates task, correctness test,
performance scenario, fixture/harness/scenario versions, before/after artifact
paths and SHA-256, environment ID, status, and note. Schema mode permits
`PENDING` and an empty after artifact. Completion mode additionally resolves all
artifacts, verifies SHA-256, and rejects `SKIP`, `missing`, `indirect`,
`INCONCLUSIVE`, absent before/after evidence, and stale versions.

Add injected-runner tests for exact Vite arguments, startup timeout, browser and
server cleanup in `finally`, Windows process-tree termination, child exit
waiting, port-release verification, and non-zero exit on cleanup failure.

Add Rust tests proving an explicit `DBSCOUT_PERF_PROFILE` selects deterministic
profiles even in a release build, while absent, blank, or unknown values keep
ordinary behavior unchanged. The required precedence matrix is:

- recognized profile without MySQL: use the deterministic fixture,
- recognized profile plus `DBSCOUT_MYSQL_URL`: the fixture wins and no external
  pool is created,
- absent/blank/unknown profile plus MySQL: preserve ordinary MySQL behavior,
- absent/blank/unknown profile in a release-like runtime: preserve the ordinary
  no-demo behavior.

The `perf_fixture_metadata` response exposes `profile`, `version`, `hash`,
`debugAssertions`, `frontendSource`, and `usesExternalDatabase`.
`frontendSource` is derived from `tauri::is_dev()` as `devUrl` or
`embeddedDist`, never inferred from debug assertions. Ensure the Rust filter
runs at least one named test: first add the test module with references to the
missing APIs, then observe a compile/test failure rather than accepting a
zero-test success.

Run:

```powershell
node --test scripts/perf/fixtures.test.mjs scripts/perf/report.test.mjs scripts/perf/evidence-matrix.test.mjs scripts/perf/ui-suite.test.mjs scripts/perf/workbench-benchmarks.test.mjs scripts/perf/process-tree.test.mjs
node --test src/workbench/mockBackend.test.js
cargo test --manifest-path src-tauri/Cargo.toml perf_fixture::tests -- --nocapture
```

Expected: RED for the missing canonical fixture, harness modules, product-path
profile integration, process cleanup, and explicit release-profile APIs. The
Rust output must name at least one `perf_fixture::tests` test.

**Step 2: Implement one canonical deterministic fixture specification**

The browser-safe `perfFixture.js`, Node harness, and Rust fixture consume the
same canonical specification bytes and report the same SHA-256. Keep Node-only
filesystem/crypto/process APIs out of the browser module. Generate values only
from the fixture version, scenario, row, and column indexes. Include fixed,
whitelisted named scenarios for:

- 1k/10k/50k/100k rows,
- primary-key and no-primary-key tables,
- 12/40/200/500 columns,
- insert matrices of 100x20 and 500x20,
- 800 tables x 60 columns for schema search.

Large scenarios expose page/range generators and metadata; they never allocate
the full rows-by-columns product. Replace existing random ordinary mock values
with deterministic row-index values too, so importing `mockRows.js` cannot add
random startup/search noise. Add an explicit reset API for rows, schema
overrides, and sessions so every warmup and measured sample starts from the same
fixture state.

**Step 3: Route the browser and release fixtures through product code**

`ui-suite.mjs` opens ordinary
`index.html?perfProfile=deterministic-v1&scenario=<whitelisted-name>`. Both query
values use exact whitelist parsing; arbitrary row/column parameters are
rejected. `list_connections`, `list_databases`, `list_tables`,
`open_table_session`, and `fetch_table_page` all flow through the existing
`invokeWorkbench -> mockWorkbenchInvoke` product path. Playwright performs real
UI actions and reads recorder/DOM results. It must not import fixtures into the
page, replace Vue state, mount a standalone grid, or inject benchmark rows.

Mirror the same profiles in `perf_fixture.rs`. A recognized
`DBSCOUT_PERF_PROFILE` is available in release builds and takes precedence over
`DBSCOUT_MYSQL_URL`; it uses only deterministic demo data and reports
`usesExternalDatabase=false`. Unknown and blank values do not activate a
fixture. Register `perf_fixture_metadata` for runtime provenance. The real
MySQL fixture remains a separate mandatory path for database correctness and
deep-page evidence.

**Step 4: Implement the report envelope and evidence-matrix loader**

Reports retain raw samples, warmup/sample counts, source commit, dirty-diff
hash, fixture profile/version/hash, `debugAssertions`, `frontendSource`,
`usesExternalDatabase`, environment ID, scenario/harness versions, and an
explicit `supporting` or `authoritative` evidence class. Keep this metadata in
the report envelope rather than silently losing it through the recorder's event
detail whitelist. The matrix loader is the only API used by later scripts.

**Step 5: Implement deterministic benchmark cases**

Record, but do not initially gate:

- visual index lookup,
- arrow navigation,
- row-range selection,
- insert-draft update and paste,
- import validation,
- page append,
- schema search,
- Agent 20k-character delta aggregation.

Interactive microbenchmarks use five warmups and at least 100 raw samples from
this single build. Heavy parser/import/database-throughput cases retain their
declared fixed-fixture raw samples without pretending they are interaction
latency. Every case resets fixture state before each warmup and sample and
writes `output/performance/<run-id>.json`. Task 4 may implement and unit-test a
deterministic pair/interleave scheduler for later reuse, but it does not yet
have a candidate build and must not claim an improvement or final regression
verdict.

`ui-suite.mjs` starts a deterministic frontend fixture on a discovered free
port by spawning `node_modules/vite/bin/vite.js --host 127.0.0.1 --port <port>
--strictPort` directly. It launches Playwright Chromium, records double-rAF
action spans, frame intervals, long tasks, mounted rows/cells, and browser heap
where available. Browser Chromium and pure-JS results are `supporting` evidence,
not authoritative Tauri/WebView2 evidence.

**Step 6: Make child-process cleanup deterministic**

Always close Playwright first in `finally`. Then terminate only the Vite PID
created by the harness. On Windows use `taskkill /PID <pid> /T /F`, await child
exit, and verify the selected port is released; use equivalent process-group
termination elsewhere. Startup failure, timeout, browser-close failure,
process-tree cleanup failure, or a still-bound port causes a non-zero exit. Do
not invoke `npm run dev`, which would add an unowned wrapper process.

**Step 7: Make the focused suites GREEN**

Run the commands from Step 1, assert their real test counts, then run:

```powershell
node scripts/test-workbench.mjs
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/perf/ui-suite.mjs --scenario smoke --samples 5
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: PASS, fixture state is reset between samples, and no Vite/browser
process or bound port remains. The five-sample run is smoke evidence only.

**Step 8: Commit the harness before capturing the baseline**

```powershell
git add scripts/perf src/workbench/mock/perfFixture.js src/workbench/perfFixture.test.js src/workbench/mock/mockBackend.js src/workbench/mock/mockRows.js src/workbench/mock/mockSchema.js src/workbench/mockBackend.test.js src-tauri/src/perf_fixture.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/demo.rs src-tauri/src/commands.rs src-tauri/Cargo.toml Cargo.lock
git commit -m "perf: add deterministic benchmark harness"
```

**Step 9: Run and save the diagnostic pre-change baseline**

Run: `node scripts/perf/workbench-benchmarks.mjs --label before`

Expected: a single-build raw JSON report with environment and all cases; source
tree unchanged. It is explicitly diagnostic/supporting and cannot populate an
authoritative matrix result or assert before/after improvement.

Also run `npm run tauri -- build`, resolve the Cargo target directory through
`cargo metadata`, and copy the newly built release executable plus its SHA-256,
mtime, source commit, dirty-diff hash, scenario version, and fixture hash into
the ignored `output/performance/baseline/` archive. Record that manifest in the
matrix. Task 29 must rebuild this exact baseline commit and interleave it with
the candidate, launch both real Tauri/WebView2 executables, and apply bootstrap
confidence gates; this early capture is diagnostic, not the final A/B verdict.

## Stage 2: Pool Identity, Sessions, And Background Safety

### Task 5: Database-Qualified Session Identity

**Files:**
- Create: `scripts/perf/mysql-fixture.ps1`
- Create: `src-tauri/src/runtime_resources.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs:53-65,553-595`
- Modify: `src-tauri/src/commands.rs:341-371,1280-1445,1942-2107`
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/audit.rs`
- Modify: `src-tauri/src/agent/db_bridge.rs`
- Create: `src-tauri/tests/cross_database_sessions.rs`
- Test: `src-tauri/src/runtime_resources.rs`
- Test: `src-tauri/src/db.rs`
- Test: `src-tauri/src/commands.rs`

**Step 1: Create and start an isolated MySQL 5.7 fixture**

The PowerShell script discovers `mysqld.exe`, initializes an insecure temporary
data directory under ignored `target/perf-mysql`, chooses a free localhost port,
starts that process (never the Windows service), waits for readiness, and writes
`output/performance/mysql-fixture.json`. `stop` reads the PID, verifies its
executable/data path belongs to this fixture, stops it, and removes only the
verified fixture directory.

Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/perf/mysql-fixture.ps1 start
$fixture = Get-Content output/performance/mysql-fixture.json -Raw | ConvertFrom-Json
$env:DBSCOUT_TEST_MYSQL_URL = $fixture.url
```

Expected: a reachable, empty temporary MySQL instance. Failure is a hard blocker,
not a skipped test.

**Step 2: Write the failing real cross-database sentinel test first**

Create databases A/B with one same-named table and different sentinels. Against
the current implementation, select B and explicitly open A. Assert the page
contains A. Add read/update/insert/delete, simultaneous A/B sessions, Agent
read/write, historical UPDATE/INSERT/DELETE rollback, and row-exists probes to
the same fixture suite as the required end state.

Run the initial read reproduction:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test cross_database_sessions cross_database_session_uses_requested_database -- --ignored --nocapture
```

Expected: FAIL because the current B-default pool returns B's sentinel for A.

**Step 3: Write failing pure Rust tests for pool/session keys**

```rust
#[test]
fn pool_key_distinguishes_databases_on_one_connection() {
    assert_ne!(
        PoolKey::new("mysql-1", "game_a"),
        PoolKey::new("mysql-1", "game_b"),
    );
}

#[test]
fn qualified_table_escapes_database_and_table() {
    assert_eq!(qualified_table("game-db", "order`item"), "`game-db`.`order``item`");
}
```

Add a command-level fake registry test proving a request for A never receives
the pool entry registered for B.

**Step 4: Run and verify pure RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml runtime_resources
```

Expected: FAIL because the module and `PoolKey` do not exist.

**Step 5: Implement the pool registry and qualified session SQL**

Use a key containing connection ID and database. Pool creation must be
single-flight. Keep server-level pools separate from database pools. Do not hold
`AppState.runtime` across connection establishment.

`TableSession` stores its `PoolKey`. All session reads and mutations build SQL
through a qualified-table helper. Audit forward/inverse SQL must use the same
qualified identity.

Inventory every connection-level pool consumer with:

```powershell
rg -n "real_connection_pool|connection\.pool|session\.pool" src-tauri/src
```

Migrate Agent tools by explicit context database. Rollback resolves the pool from
the audit entry's database and executes legacy unqualified inverse SQL only on
that database-bound pool.

**Step 6: Make the full sentinel integration suite GREEN**

Always drop the temporary databases in a cleanup guard. A missing fixture URL is
a test failure in the release matrix. Verify live UI commands, Agent tools,
historical audit rollback, and row-exists probes all stay in A while B remains
unchanged.

**Step 7: Run focused Rust tests and check**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml runtime_resources
cargo test --manifest-path src-tauri/Cargo.toml db::tests
cargo test --manifest-path src-tauri/Cargo.toml commands::tests
cargo test --manifest-path src-tauri/Cargo.toml --test cross_database_sessions -- --ignored --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

**Step 8: Stop the fixture and commit**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/perf/mysql-fixture.ps1 stop
```

```powershell
git add scripts/perf/mysql-fixture.ps1 src-tauri/src/runtime_resources.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/commands.rs src-tauri/src/db.rs src-tauri/src/audit.rs src-tauri/src/agent/db_bridge.rs src-tauri/tests/cross_database_sessions.rs
git commit -m "fix: isolate database connection pools"
```

### Task 6: Explicit Session Lifecycle And Capacity

**Files:**
- Create: `src-tauri/src/table_sessions.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/workbench/composables/useTableSession.js`
- Modify: `src/workbench/composables/useExport.js`
- Modify: `src/workbench/composables/useBatchTransfer.js`
- Modify: `src/workbench/mock/mockBackend.js`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Test: `src-tauri/src/table_sessions.rs`
- Test: `src/workbench/useTableSession.test.js`
- Test: `src/workbench/useExport.test.js`
- Test: `src/workbench/useBatchTransfer.test.js`
- Test: `src/workbench/mockBackend.test.js`

**Step 1: Write failing lifecycle tests**

Cover explicit close, close idempotency, connection-level invalidation, idle
expiration, hard capacity eviction of only idle sessions, and temporary export
session closure in success/error/cancel paths.

Run:

```powershell
node --test src/workbench/useTableSession.test.js src/workbench/useExport.test.js src/workbench/useBatchTransfer.test.js src/workbench/mockBackend.test.js
cargo test --manifest-path src-tauri/Cargo.toml table_sessions
```

Expected: RED for the missing close contract, expiry/capacity manager, and
temporary-session cleanup.

**Step 2: Add the `close_table_session` contract**

Register it in Rust and mock backend. The response is idempotent:

```rust
pub struct CloseTableSessionResponse {
    pub closed: bool,
}
```

**Step 3: Implement frontend ownership**

`useTableSession` owns normal tab sessions. A watcher compares the previous and
current live session ID sets and closes removed IDs. Export/import helpers close
sessions they open in `finally`; they never close a UI-owned session.

**Step 4: Implement backend safety cleanup**

Store `created_at` and `last_accessed`. Touch on every command. Prune idle
sessions before insertion and enforce a documented maximum. Removing a
connection invalidates all its sessions before closing eligible pools.

**Step 5: Run focused tests**

```powershell
node --test src/workbench/useTableSession.test.js src/workbench/useExport.test.js src/workbench/useBatchTransfer.test.js src/workbench/mockBackend.test.js
cargo test --manifest-path src-tauri/Cargo.toml table_sessions
```

Expected: PASS with no session left after temporary operations.

**Step 6: Commit**

```powershell
git add src-tauri/src/table_sessions.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/commands.rs src/workbench/composables/useTableSession.js src/workbench/composables/useExport.js src/workbench/composables/useBatchTransfer.js src/workbench/mock/mockBackend.js src/workbench/MySqlWorkbench.vue src/workbench/useTableSession.test.js src/workbench/useExport.test.js src/workbench/useBatchTransfer.test.js src/workbench/mockBackend.test.js
git commit -m "perf: manage table session lifecycle"
```

### Task 7: Release Backup Runtime Lock Before IO

**Files:**
- Modify: `src-tauri/src/backup.rs:842-936`
- Test: `src-tauri/src/backup.rs`

**Step 1: Write failing lock-scope tests**

Extract a pure collection helper and an async test hook. Prove the runtime lock
can be acquired by a foreground task while the injected database lister is
blocked.

Also prove an empty enabled-database whitelist invokes the lister zero times.

**Step 2: Run and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml backup::tests`

Expected: new concurrency tests FAIL.

**Step 3: Copy configuration under lock, then release**

Collect only `(connection_id, mysql_url)` while locked. Drop the guard. Perform
database enumeration afterward, and only for connections with enabled snapshot
targets.

**Step 4: Run focused tests**

Run the command from Step 2.

Expected: PASS.

**Step 5: Commit**

```powershell
git add src-tauri/src/backup.rs
git commit -m "perf: release backup runtime lock before IO"
```

### Task 8: Single-Flight Audit Sync Worker

**Files:**
- Modify: `src-tauri/src/audit_sync.rs`
- Modify: `src-tauri/src/types.rs`
- Test: `src-tauri/src/audit_sync.rs`

**Step 1: Write failing worker tests**

Inject a push function that blocks. Send 100 mutation notifications and assert:

- maximum concurrent pushes is one,
- duplicate notifications coalesce,
- a notification arriving during a push causes one follow-up pass,
- shutdown releases the worker.

Run: `cargo test --manifest-path src-tauri/Cargo.toml audit_sync::tests`

Expected: RED because notifications currently spawn independent sync tasks.

**Step 2: Implement channel/Notify-driven worker**

Replace `trigger_immediate_sync` task spawning with a cheap signal. Keep the
30-second retry tick, but route it through the same worker.

**Step 3: Run focused tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml audit_sync::tests`

Expected: PASS.

**Step 4: Commit**

```powershell
git add src-tauri/src/audit_sync.rs src-tauri/src/types.rs
git commit -m "perf: coalesce audit synchronization"
```

## Stage 3: Frontend Hot Paths

### Task 9: Unified Tab Data Generation And Row Index

**Files:**
- Create: `src/workbench/rowStore.js`
- Create: `src/workbench/rowStore.test.js`
- Create: `src/workbench/utils/rowIndex.js`
- Create: `src/workbench/utils/rowIndex.test.js`
- Modify: `src/workbench/workspaceState.js`
- Modify: `src/workbench/workspaceState.test.js`
- Modify: `src/workbench/composables/useGridEditor.js`
- Modify: `src/workbench/composables/useRowSelection.js`
- Modify: `src/workbench/composables/useTableSearch.js`
- Modify: `src/workbench/composables/useTableSession.js`
- Modify: `src/workbench/composables/useUndo.js`
- Modify: `src/workbench/composables/useVirtualGrid.js`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/utils/rowIdentity.js`
- Modify: `src/workbench/useGridEditor.test.js`
- Modify: `src/workbench/useRowSelection.test.js`

**Step 1: Write failing `DenseRowStore` contract tests**

Define and test `length`, `loadedLength`, `get(index)`, `replacePage`,
`appendPage`, `iterateLoadedRange`, `indexOfKey`, `rowForKey`, `mutateRow`, and
generation notification. Absolute positions and loaded positions are distinct
types in test names and API arguments.

Run:

```powershell
node --test src/workbench/rowStore.test.js
```

Expected: FAIL with `rowStore module is unavailable`.

**Step 2: Implement the dense store and migrate direct consumers**

Wrap the current dense array without changing small-table behavior. Migrate the
production files returned by:

```powershell
rg -l "\btab\??\.rows|\btab\.rows|activeDataTab\.value\??\.rows" src/workbench -g "*.js" -g "*.vue"
```

Tests may still construct `rows` fixtures through a compatibility factory, but
production editor/search/grid/session/undo/identity code must consume RowStore.
Add a static regression assertion listing the allowed compatibility boundary.

**Step 3: Write failing index and invalidation tests**

Test one index build for repeated lookup, and invalidation after page append,
cell mutation, rollback, insert promotion, delete/refresh, primary-key change,
and sibling-tab synchronization.

```js
test("repeated navigation reuses one row index generation", () => {
  const count = { buildRowKey: 0 };
  const index = createRowIndex(tab, { buildRowKey: countingBuilder(count) });
  for (let i = 0; i < 100; i += 1) index.indexOfKey("id=9999");
  assert.equal(count.buildRowKey, tab.rows.length);
});
```

**Step 4: Run and verify RED**

```powershell
node --test src/workbench/rowStore.test.js src/workbench/utils/rowIndex.test.js src/workbench/workspaceState.test.js src/workbench/useGridEditor.test.js src/workbench/useRowSelection.test.js src/workbench/useTableSearch.test.js src/workbench/useTableSession.test.js
```

Expected: missing index API and stale-generation failures.

**Step 5: Implement `tab.dataVersion` and cache**

Expose only RowStore mutation helpers to bump the version. The WeakMap entry
contains keys, `indexByKey`, and primary-key signatures. It validates version,
row count, and primary-key signature before reuse.

**Step 6: Replace linear consumers**

Migrate editor navigation, selected-cell lookup, row selection, delete identity
resolution, sibling synchronization, and Agent row focus. Normal single-row
click must not build all keys if the index is not otherwise needed.

**Step 7: Run tests and benchmark**

Run focused tests, then:

`node scripts/perf/workbench-benchmarks.mjs --label row-index`

Expected: 100k-row navigation p95 <= 16 ms and at least 25% improvement; behavior
tests PASS.

**Step 8: Commit RowStore and row indexing separately**

```powershell
git add src/workbench/rowStore.js src/workbench/rowStore.test.js src/workbench/workspaceState.js src/workbench/workspaceState.test.js src/workbench/composables/useGridEditor.js src/workbench/composables/useRowSelection.js src/workbench/composables/useTableSearch.js src/workbench/composables/useTableSession.js src/workbench/composables/useUndo.js src/workbench/composables/useVirtualGrid.js src/workbench/components/DataGrid.vue src/workbench/components/WorkbenchPane.vue src/workbench/MySqlWorkbench.vue src/workbench/utils/rowIdentity.js
git commit -m "refactor: route table rows through row store"
git add src/workbench/utils/rowIndex.js src/workbench/utils/rowIndex.test.js src/workbench/workspaceState.js src/workbench/workspaceState.test.js src/workbench/composables/useGridEditor.js src/workbench/composables/useRowSelection.js src/workbench/components/WorkbenchPane.vue src/workbench/MySqlWorkbench.vue src/workbench/useGridEditor.test.js src/workbench/useRowSelection.test.js
git commit -m "perf: index table rows by data generation"
```

### Task 10: Addressable Visual Rows And Batched Draft Updates

**Files:**
- Create: `src/workbench/utils/visualRows.js`
- Create: `src/workbench/utils/visualRows.test.js`
- Modify: `src/workbench/composables/useGridEditor.js`
- Modify: `src/workbench/useGridEditor.test.js`

**Step 1: Write failing model tests**

Cover anchored/trailing drafts, out-of-range anchors, data-to-visual and
visual-to-data translation, insertion/removal, and direct range traversal.

Run:

```powershell
node --test src/workbench/utils/visualRows.test.js src/workbench/useGridEditor.test.js
```

Expected: RED for the missing addressable visual-row model and batched draft
invalidation.

**Step 2: Implement addressable model**

Do not allocate one entry per data row per lookup. Keep sorted insert anchors and
prefix counts so translations are logarithmic or constant for the common few-
draft case.

**Step 3: Batch matrix paste**

Apply all draft cell changes first, invalidate visual/signature state once, then
validate once. Range copy obtains one model snapshot and reads direct entries.

**Step 4: Verify and benchmark**

Run:

```powershell
node --test src/workbench/utils/visualRows.test.js src/workbench/useGridEditor.test.js
node scripts/perf/workbench-benchmarks.mjs --label visual-rows
```

Expected: 500x20 paste has no O(cells * loadedRows) growth; tests PASS.

**Step 5: Commit**

```powershell
git add src/workbench/utils/visualRows.js src/workbench/utils/visualRows.test.js src/workbench/composables/useGridEditor.js src/workbench/useGridEditor.test.js
git commit -m "perf: address visual rows without rebuilding"
```

### Task 11: Linear Batch Validation And Non-Copying Append

**Files:**
- Modify: `src/workbench/utils/valueValidation.js`
- Modify: `src/workbench/valueValidation.test.js`
- Modify: `src/workbench/composables/useImportWizard.js`
- Modify: `src/workbench/composables/useBatchTransfer.js`
- Modify: `src/workbench/workspaceState.js`
- Modify: `src/workbench/workspaceState.test.js`

**Step 1: Write failing operation-count tests**

Inject/count primary-key signature creation and prove validating N drafts creates
O(N) signatures, not N(N-1)/2 comparisons. Prove appending 100 pages preserves
the original array identity and bumps data generation once per page.

Run:

```powershell
node --test src/workbench/valueValidation.test.js src/workbench/workspaceState.test.js src/workbench/useImportWizard.test.js src/workbench/useBatchTransfer.test.js
```

Expected: RED because validation grows quadratically and page append replaces or
copies historical storage.

**Step 2: Implement validation context**

Build one signature set from existing rows, add accepted drafts as validation
advances, and return row-specific duplicate errors. Keep scalar validation
unchanged.

**Step 3: Implement chunked in-place append**

Use a bounded `push`/`splice` loop to avoid both historical-array copies and
argument-count limits. Increment generation once after the append.

**Step 4: Run tests and benchmark**

```powershell
node --test src/workbench/valueValidation.test.js src/workbench/workspaceState.test.js src/workbench/useImportWizard.test.js src/workbench/useBatchTransfer.test.js
node scripts/perf/workbench-benchmarks.mjs --label linear-import
node scripts/perf/ui-suite.mjs --scenario import-10k --samples 5
```

Expected: 10k preflight no longer exhibits quadratic growth and no UI task over
100 ms in the browser fixture.

**Step 5: Commit**

```powershell
git add src/workbench/utils/valueValidation.js src/workbench/valueValidation.test.js src/workbench/composables/useImportWizard.js src/workbench/composables/useBatchTransfer.js src/workbench/workspaceState.js src/workbench/workspaceState.test.js
git commit -m "perf: validate imports in linear time"
```

### Task 11A: Shared Foreground/Background Database Scheduler

**Files:**
- Create: `src-tauri/src/work_scheduler.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Test: `src-tauri/src/work_scheduler.rs`

**Step 1: Write failing deterministic scheduler tests**

With paused Tokio time and injected tasks, prove per-`PoolKey` foreground
reservation, bounded total background concurrency, FIFO fairness within a class,
foreground admission while background work is queued, cancellation, timeout,
and permit release after panic/error.

Run: `cargo test --manifest-path src-tauri/Cargo.toml work_scheduler::tests`

Expected: RED for the missing scheduler API.

**Step 2: Implement the scheduler**

For a five-connection pool, reserve at least two permits for foreground work and
allow at most two shared background permits by default. Configuration is explicit
and testable. Background consumers cannot create private semaphores that bypass
this budget.

**Step 3: Add cancellation/timeout probes**

The scheduler cancellation token stops queued work. For running SQL, tests must
show whether dropping the future releases the connection and cancels the server
query. If not, use a separate low-capacity background pool plus database query
timeout before integrating count/search/export/Agent work.

**Step 4: Verify and commit**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml work_scheduler::tests
cargo check --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/work_scheduler.rs src-tauri/src/lib.rs src-tauri/src/types.rs
git commit -m "perf: schedule database work by priority"
```

## Stage 4: Metadata And Count Pipeline

### Task 12: Single-Flight Schema Cache And Batch Metadata Command

**Files:**
- Create: `src-tauri/src/schema_cache.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/clickhouse.rs`
- Modify: `src/workbench/composables/useConnection.js`
- Create: `src/workbench/composables/useSchemaMetadata.js`
- Create: `src/workbench/useSchemaMetadata.test.js`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/mock/mockBackend.js`
- Modify: `src/workbench/useConnection.test.js`

**Step 1: Write failing Rust cache tests**

Cover concurrent one-load behavior, TTL, force refresh, generation invalidation,
targeted DDL invalidation, connection reconfiguration/removal, database restore,
old/new rename keys, case normalization, late in-flight completion, capacity
bound, failure-not-cached, external-DDL TTL refresh, and idempotent read retry.

**Step 2: Write failing frontend coordinator tests**

Prove database selection performs one table-list command, visible/eager requests
for one table coalesce, stale source results do not merge, and 80 table schemas
use one batch command rather than 80 commands.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml schema_cache::tests
node --test src/workbench/useSchemaMetadata.test.js src/workbench/useConnection.test.js
```

Expected: RED for the missing single-flight cache/batch command and duplicate
frontend owners.

**Step 3: Implement backend cache and batch contract**

Add `get_table_schemas({ connectionId, database, tableNames, force })`. Reuse
`read_schemas_for_tables` for MySQL and one system-columns query for ClickHouse.
Store `Arc<TableMeta>` in live sessions.

Every load captures the current key generation before IO and discards its result
if the generation changed before completion. Every session command compares its
schema generation with the cache generation before use; TTL therefore refreshes
long-lived sessions instead of leaving their `Arc` permanently stale.

**Step 4: Make `select_database` the single table-list owner**

Return a typed response containing table placeholders. Frontend initializes
workspace tables/schema from that response and removes the immediate duplicate
`list_tables`. Manual refresh may still call `list_tables` explicitly.

**Step 5: Replace both frontend in-flight sets**

`useSchemaMetadata` keys work by connection/database/table, batches adjacent
requests, prioritizes visible/recent tables, and cancels stale database work.

**Step 6: Wire invalidation**

DDL, rename, drop, copy, database sync, restore, and schema-affecting imports
invalidate exact keys/generations. Connection changes invalidate the connection
scope; restore invalidates the database scope; rename invalidates both old and
new normalized keys. Add command-level tests for each owner and for a late load
that must not repopulate an invalidated key.

**Step 7: Verify**

Run focused frontend/Rust tests, `cargo check`, and the database-switch benchmark.

Expected: one list query, one batch metadata query for a batch, no duplicate
visible schema request, and p95 target met.

**Step 8: Commit**

```powershell
git add src-tauri/src/schema_cache.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/commands.rs src-tauri/src/clickhouse.rs src/workbench/composables/useConnection.js src/workbench/composables/useSchemaMetadata.js src/workbench/useSchemaMetadata.test.js src/workbench/MySqlWorkbench.vue src/workbench/mock/mockBackend.js src/workbench/useConnection.test.js
git commit -m "perf: cache and batch table metadata"
```

### Task 13: Dedicated Cancellable Count Command

**Files:**
- Create: `src-tauri/src/table_count.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/clickhouse.rs`
- Modify: `src/workbench/composables/useTableSession.js`
- Modify: `src/workbench/useTableSession.test.js`
- Modify: `src/workbench/mock/mockBackend.js`

**Step 1: Write failing tests**

Prove page fetch never counts, count never fetches a data row, identical count
requests single-flight, changed filter/session cancels the previous result, and
stale completion cannot update a tab. Also prove insert, delete, filtered-column
update, batch import, rollback, sync, restore, and Agent write invalidate count
generations in every sibling session.

Run:

```powershell
node --test src/workbench/useTableSession.test.js
cargo test --manifest-path src-tauri/Cargo.toml table_count
```

Expected: RED because page fetch still owns counting and no cancellable
generation-bound count manager exists.

**Step 2: Implement command and count state**

Add `fetch_table_count` and `cancel_table_count`. Key cache/single-flight by
`PoolKey + table + normalized filter signature + mutation generation`. Acquire a
background permit from `work_scheduler`; foreground page commands never wait for
a count permit. Return `{ totalRows, exact, estimated }`.

**Step 3: Migrate frontend exact-total scheduling**

Delete the page-size-one count request. Schedule the count after first usable
paint at low priority. Cancel on tab close, search/filter/sort change, or new
session.

**Step 4: Verify and commit**

```powershell
node --test src/workbench/useTableSession.test.js
cargo test --manifest-path src-tauri/Cargo.toml table_count
git add src-tauri/src/table_count.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/commands.rs src-tauri/src/db.rs src-tauri/src/clickhouse.rs src/workbench/composables/useTableSession.js src/workbench/useTableSession.test.js src/workbench/mock/mockBackend.js
git commit -m "perf: separate row counts from page reads"
```

## Stage 5: Search And Grid Rendering

### Task 14: Backend-Page Table Search

**Files:**
- Create: `src-tauri/src/table_search.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/clickhouse.rs`
- Modify: `src/workbench/composables/useTableSearch.js`
- Modify: `src/workbench/useTableSearch.test.js`
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/composables/useTableSession.js`
- Modify: `src/workbench/utils/searchMatch.js`
- Modify: `src/workbench/searchMatch.test.js`
- Create: `src/workbench/utils/searchSemantics.fixture.json`
- Modify: `src/workbench/mock/mockBackend.js`

**Step 1: Write failing behavior tests**

Cover debounce, one filtered backend page, next-match continuation, no ordinary-
tab full-table accumulation, clear/restore, stale request cancellation, sort,
selection, and insert-draft handling.

Add golden cases that match only by Levenshtein typo distance (not contains or
subsequence), including a hit after the first physical page. Run the same fixture
through the current JavaScript matcher and the new Rust matcher; ordered matches
must be identical.

Before implementation run:

```powershell
node --test src/workbench/searchMatch.test.js src/workbench/useTableSearch.test.js
cargo test --manifest-path src-tauri/Cargo.toml table_search::tests
```

Expected: frontend golden characterization PASS; Rust command/matcher tests RED.

**Step 2: Implement a dedicated cancellable search job**

Add begin/next/cancel commands. SQL-compatible exact/contains/subsequence
candidates can return first, but a background cursor scan must apply the same
Levenshtein semantics before the job is complete. Results contain rows plus exact
matching cell/rank metadata and never populate the normal table RowStore. The job
uses a shared background permit, releases it on cancel, and has a bounded result
buffer.

**Step 3: Wire debounced frontend result paging**

Debounce input, cancel the previous backend job, ignore stale job IDs, and page
results into search-result mode. Clearing restores normal page/sort/selection;
draft resolution remains unchanged. Pass precomputed row keys to display and
highlight helpers.

**Step 4: Verify semantics, cancellation, and performance**

Run the commands from Step 1 plus `useTableSession.test.js` and the release
fixture. Expected: golden order parity; cancel stops/releases backend work;
debounce-fire-to-first-result p95 <= 100 ms; input-to-result p95 <= 300 ms; next
hit <= 16 ms.

**Step 5: Commit**

```powershell
git add src-tauri/src/table_search.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/commands.rs src-tauri/src/db.rs src-tauri/src/clickhouse.rs src/workbench/utils/searchSemantics.fixture.json
git commit -m "perf: add cancellable table search jobs"
git add src/workbench/composables/useTableSearch.js src/workbench/useTableSearch.test.js src/workbench/components/WorkbenchPane.vue src/workbench/MySqlWorkbench.vue src/workbench/composables/useTableSession.js src/workbench/utils/searchMatch.js src/workbench/searchMatch.test.js src/workbench/mock/mockBackend.js
git commit -m "perf: search tables through result pages"
```

### Task 15: Indexed Schema Search And Virtual Results

**Files:**
- Create: `src/workbench/utils/schemaSearchIndex.js`
- Create: `src/workbench/utils/schemaSearchIndex.test.js`
- Modify: `src/workbench/workspaceState.js`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/components/SidebarSearchPanel.vue`
- Modify: `src/workbench/components/QuickOpenPalette.vue`

**Step 1: Write failing index/debounce/result-window tests**

Prove normalized text is built once per metadata generation, 800x60 no-match
search does bounded fuzzy work, stale debounced queries do not render, and result
DOM count stays within the virtual window.

Run:

```powershell
node --test src/workbench/utils/schemaSearchIndex.test.js src/workbench/workspaceState.test.js src/workbench/workbenchShell.test.js
```

Expected: RED for the missing index and unbounded result rendering.

**Step 2: Implement index and result window**

Keep stable source IDs so keyboard selection survives window changes. Use
150-200 ms debounce for non-empty input and immediate clear.

**Step 3: Verify and commit**

Expected: 800x60 search-execution p95 <= 100 ms after the debounce fires,
input-to-result p95 <= 300 ms, and bounded mounted nodes.

```powershell
node --test src/workbench/utils/schemaSearchIndex.test.js src/workbench/workspaceState.test.js src/workbench/workbenchShell.test.js
node scripts/perf/workbench-benchmarks.mjs --label schema-search
git add src/workbench/utils/schemaSearchIndex.js src/workbench/utils/schemaSearchIndex.test.js src/workbench/workspaceState.js src/workbench/MySqlWorkbench.vue src/workbench/components/SidebarSearchPanel.vue src/workbench/components/QuickOpenPalette.vue src/workbench/workbenchShell.test.js
git commit -m "perf: index and virtualize schema search"
```

### Task 16: Scroll Window And Cell Render-State Reduction

**Files:**
- Modify: `src/workbench/composables/useVirtualGrid.js`
- Modify: `src/workbench/useVirtualGrid.test.js`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/composables/useColumnResize.js`
- Modify: `src/workbench/workbenchShell.test.js`

**Step 1: Write failing work-count tests**

Prove multiple scroll events inside one row coalesce without rebuilding visible
rows; one visible cell computes highlight/error/range state once; column resize
does not write per-cell styles.

Run:

```powershell
node --test src/workbench/useVirtualGrid.test.js src/workbench/workbenchShell.test.js
```

Expected: RED because within-row scrolls rebuild the window and resize still
touches mounted cells.

**Step 2: Implement rAF row-window updates and prepared cell state**

Keep raw scroll position for native movement but update Vue window state only
when start/end row indices change. Apply width through shared column tracks.

**Step 3: Run scroll fixture**

Expected: frame p95 <= 20 ms, >50 ms frames below 1%, no >100 ms long task.

Run:

```powershell
node --test src/workbench/useVirtualGrid.test.js src/workbench/workbenchShell.test.js
node scripts/perf/ui-suite.mjs --scenario grid-scroll --samples 5
```

**Step 4: Commit**

```powershell
git add src/workbench/composables/useVirtualGrid.js src/workbench/useVirtualGrid.test.js src/workbench/components/DataGrid.vue src/workbench/composables/useColumnResize.js src/workbench/workbenchShell.test.js
git commit -m "perf: coalesce grid rendering work"
```

### Task 17: Cancellable Cross-Database Value Search

**Files:**
- Create: `src-tauri/src/value_search.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/clickhouse.rs`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/sidebarSearchState.js`
- Modify: `src/workbench/mock/mockBackend.js`
- Test: `src-tauri/src/value_search.rs`
- Test: `src/workbench/sidebarSearchState.test.js`
- Test: `src/workbench/mockBackend.test.js`
- Test: `src/workbench/workbenchShell.test.js`

**Step 1: Write failing cancellation and concurrency tests**

Cover backend cancellation, shared background-permit maximum, progressive
results, priority ordering, bounded buffers, one scan after cancel at most, and
stale frontend job IDs.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml value_search::tests
node --test src/workbench/sidebarSearchState.test.js src/workbench/mockBackend.test.js src/workbench/workbenchShell.test.js
```

Expected: RED for missing job manager/cancel command and result-batch handling.

**Step 2: Implement the bounded backend job manager**

Add `cancel_search_values`, use `work_scheduler` background permits, bound result
and progress queues, and release work on cancel. Replace per-column scans with a
one-table query shape where semantics match; keep and test the fallback.

**Step 3: Wire progressive result batches**

Emit result batches with job ID. Frontend merges only the active ID and sends a
real backend cancel instead of only invalidating its local token.

**Step 4: Verify and commit**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml value_search::tests
node --test src/workbench/sidebarSearchState.test.js src/workbench/mockBackend.test.js src/workbench/workbenchShell.test.js
git add src-tauri/src/value_search.rs src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/src/db.rs src-tauri/src/clickhouse.rs
git commit -m "perf: bound and cancel value search"
git add src/workbench/MySqlWorkbench.vue src/workbench/sidebarSearchState.js src/workbench/sidebarSearchState.test.js src/workbench/mock/mockBackend.js src/workbench/mockBackend.test.js src/workbench/workbenchShell.test.js
git commit -m "perf: stream value search results"
```

## Stage 6: Bulk Mutation Throughput

### Task 18A: Crash-Recoverable Audit Job State Machine

**Files:**
- Create: `src-tauri/src/audit_job.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/audit.rs`
- Modify: `src-tauri/src/audit_sync.rs`
- Test: `src-tauri/src/audit_job.rs`
- Create: `src-tauri/tests/audit_recovery.rs`

**Step 1: Write failing state-transition and crash-injection tests**

Define persistent job/chunk/row states `pending`, `committed`, `aborted`, and
`commit_unknown`. Inject failures before/after pending persistence, before/after
MySQL commit, before/after SQLite finalize, and at unknown network/commit result.
Prove audit-unavailable fails closed, terminal transitions reset `synced=0`, and
outbox reads only terminal committed/rolled-back records.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml audit_job::tests
cargo test --manifest-path src-tauri/Cargo.toml audit_sync::tests
```

Expected: RED for missing durable states/reconciliation and current pending
outbox behavior.

**Step 2: Implement durable state and reconciliation**

Persist idempotency keys for job/chunk/source row before business writes. A
pending record must commit in SQLite before MySQL begins. A MySQL commit error is
`commit_unknown`, never automatically retried. Startup reconciliation checks
deterministic row identities where possible and otherwise leaves an explicit
ambiguous record for recovery; it never invents success/failure.

**Step 3: Make finalization and outbox fail visibly**

Remove best-effort swallowing for required audit state transitions. Outbox
queries terminal records only. Replaying finalization is idempotent.

**Step 4: Verify and commit**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml audit_job::tests
cargo test --manifest-path src-tauri/Cargo.toml audit::tests
cargo test --manifest-path src-tauri/Cargo.toml audit_sync::tests
cargo test --manifest-path src-tauri/Cargo.toml --test audit_recovery -- --ignored --nocapture
git add src-tauri/src/audit_job.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/audit.rs src-tauri/src/audit_sync.rs src-tauri/tests/audit_recovery.rs
git commit -m "fix: make audit jobs crash recoverable"
```

The ignored integration binary is run explicitly against Task 5's isolated
MySQL fixture. It launches a child test process at each crash injection point,
reopens SQLite/MySQL state, and verifies deterministic reconciliation. Missing
fixture state is a failure, not a skip.

### Task 18: Backend Batch Insert Job

**Files:**
- Create: `src-tauri/src/bulk_write.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/validation.rs`
- Modify: `src-tauri/src/audit.rs`
- Modify: `src/workbench/composables/useImportWizard.js`
- Modify: `src/workbench/composables/useBatchTransfer.js`
- Modify: `src/workbench/mock/mockBackend.js`
- Test: `src-tauri/src/bulk_write.rs`
- Test: `src/workbench/useImportWizard.test.js`
- Test: `src/workbench/useBatchTransfer.test.js`
- Test: `src/workbench/mockBackend.test.js`

**Step 1: Write failing contract and semantics tests**

Cover begin/append/finish/cancel, idempotent chunk IDs, maximum 500 rows and 1 MiB
serialized data per chunk, one in-flight frontend chunk, backpressure, 10k source
row numbers, duplicate primary keys, defaults/generated columns, fast-path chunk
rollback, diagnostic fallback errors, cancel between chunks, durable audit
states, and exactly one audit-sync notification.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml bulk_write::tests
node --test src/workbench/useImportWizard.test.js src/workbench/useBatchTransfer.test.js src/workbench/mockBackend.test.js
```

Expected: RED for missing job commands and current per-row frontend invocation.

**Step 2: Implement O(N) validation and chunk executor**

Load session/schema once. For each bounded chunk, try one multi-row statement in
a transaction. On failure, roll the whole chunk back, then retry that chunk with
a savepoint per row to preserve exact error rows; do not use an undecided split
strategy. Batch SQLite audit persistence/finalization through `audit_job`.

**Step 3: Add progress/cancel commands**

Use `begin_import_job`, `append_import_chunk`, `finish_import_job`, and
`cancel_import_job`. A cancelled response includes committed counts and exact
last source row. Duplicate `(job_id, chunk_id)` returns the stored result without
reapplying writes.

**Step 4: Migrate both import frontends**

Send one bounded chunk command at a time, not one command for the entire file or
one per row. Release each chunk after acknowledgement. Preserve current progress,
skip, partial success, error display, and refresh behavior.

**Step 5: Verify and commit**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml bulk_write::tests
node --test src/workbench/useImportWizard.test.js src/workbench/useBatchTransfer.test.js src/workbench/mockBackend.test.js
cargo check --manifest-path src-tauri/Cargo.toml
node scripts/perf/ui-suite.mjs --scenario import-10k --samples 5
git add src-tauri/src/bulk_write.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/commands.rs src-tauri/src/validation.rs src-tauri/src/audit.rs
git commit -m "perf: execute audited import chunks"
git add src/workbench/composables/useImportWizard.js src/workbench/composables/useBatchTransfer.js src/workbench/mock/mockBackend.js src/workbench/useImportWizard.test.js src/workbench/useBatchTransfer.test.js src/workbench/mockBackend.test.js
git commit -m "perf: stream import chunks to backend"
```

### Task 19: Batch Delete And Multi-Cell Mutation

**Files:**
- Modify: `src-tauri/src/bulk_write.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/audit.rs`
- Modify: `src/workbench/composables/useRowSelection.js`
- Modify: `src/workbench/composables/useGridEditor.js`
- Test: `src-tauri/src/bulk_write.rs`
- Test: `src/workbench/useRowSelection.test.js`
- Test: `src/workbench/useGridEditor.test.js`

**Step 1: Write failing delete/paste job tests**

Cover before-image batching, crash states, rollback, partial failures, duplicate
chunk idempotency, cancel, and one sync notification. Frontend tests must prove
large selection delete does not perform `selected * loadedRows` lookup and paste
optimism only applies confirmed row results.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml bulk_write::tests
node --test src/workbench/useRowSelection.test.js src/workbench/useGridEditor.test.js
```

Expected: RED for missing batch delete/edit operations.

**Step 2: Reuse job/chunk/audit infrastructure**

Add typed delete and edit chunks with before-images and idempotency keys. Preserve
optimistic UI behavior only where row-level outcome is known.

**Step 3: Verify and commit separately from insert**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml bulk_write::tests
node --test src/workbench/useRowSelection.test.js src/workbench/useGridEditor.test.js
git add src-tauri/src/bulk_write.rs src-tauri/src/commands.rs src-tauri/src/audit.rs
git commit -m "perf: batch audited deletes and edits"
git add src/workbench/composables/useRowSelection.js src/workbench/composables/useGridEditor.js src/workbench/useRowSelection.test.js src/workbench/useGridEditor.test.js
git commit -m "perf: apply batch mutation outcomes"
```

## Stage 7: Scalable Paging And Memory

### Task 20: Cursor Pagination SQL Builders

**Files:**
- Create: `src-tauri/src/pagination.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/clickhouse.rs`
- Modify: `src-tauri/src/schema_cache.rs`
- Modify: `src-tauri/src/table_sessions.rs`
- Modify: `src/workbench/composables/useTableSession.js`
- Modify: `src/workbench/mock/mockBackend.js`
- Test: `src-tauri/src/pagination.rs`
- Create: `src-tauri/tests/cursor_pagination.rs`
- Test: `src/workbench/useTableSession.test.js`

**Step 1: Characterize stable-order metadata with failing tests**

Add MySQL metadata cases for primary keys, composite/non-null unique indexes,
nullable unique indexes, and duplicate sort columns. Add ClickHouse cases for
`sorting_key`/`primary_key` expressions, while explicitly proving that these do
not imply uniqueness. A cursor path is legal only when the backend can append a
non-null unique tie-breaker and therefore prove a total order; otherwise it must
return `offset` mode.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml pagination::tests
```

Expected: RED because unique-index and ClickHouse ordering metadata are not part
of the table/session model.

**Step 2: Write failing cursor-context and SQL tests**

Cover one/composite key, duplicate user-sort values, NULL data values, ASC/DESC,
forward/back, filter binds, page size, unsupported-order fallback, token expiry,
and context mismatch. A cursor entry contains and validates:

```rust
struct CursorContext {
    version: u8,
    engine: DatabaseKind,
    pool_key: PoolKey,
    normalized_table: String,
    schema_generation: u64,
    mutation_generation: u64,
    filter_signature: String,
    sort_signature: String,
    page_size: u32,
    direction: CursorDirection,
    ordering_columns: Vec<TypedOrderingColumn>,
    boundary: Vec<TypedCursorValue>,
}
```

The frontend receives only a random opaque token. The bounded, TTL cursor map is
owned by the table session, so edited/tampered tokens cannot change SQL values.
All values are binds; identifiers use the existing escaping helpers.

Run the command from Step 1. Expected: RED for the missing context registry and
keyset predicate builders.

**Step 3: Implement metadata and opaque cursor registry**

Read MySQL unique indexes in one metadata batch and ClickHouse ordering
expressions from system metadata. Cache them under the existing schema
generation. Add a bounded per-session cursor registry with TTL and invalidate it
on schema generation, filter, sort, page-size, session, or application-known
mutation-generation changes.

**Step 4: Integrate sequential reads with explicit live semantics**

Return `nextCursor`, `previousCursor`, and `paginationMode`. Arbitrary page jumps
remain OFFSET. Sequential browsing uses live keyset semantics: it sees committed
rows as each page is fetched; inserts before the boundary are not revisited,
inserts after it may appear, deletes disappear, and external sort-key changes can
move a row. App-known writes expire cursors and trigger refresh. Static fixtures
must have no gaps/duplicates; concurrency tests assert these documented outcomes
instead of claiming snapshot semantics.

Exports and backups do not use live semantics: Tasks 23-24 use a dedicated
`REPEATABLE READ` snapshot (or one ClickHouse streaming query).
`pagination.rs` also exposes a connection-scoped keyset builder that accepts
`&mut MySqlConnection`; it never reacquires from a pool between export reads.

**Step 5: Add mandatory MySQL integration RED/GREEN coverage**

Use the Task 5 isolated fixture. Seed primary, composite unique, nullable unique,
no-key, duplicate-sort, and 1M-row deep-page tables. Test forward/back navigation,
cursor expiry/tamper, sort-key updates, and OFFSET fallback.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/perf/mysql-fixture.ps1 start
$fixture = Get-Content output/performance/mysql-fixture.json -Raw | ConvertFrom-Json
$env:DBSCOUT_TEST_MYSQL_URL = $fixture.url
cargo test --manifest-path src-tauri/Cargo.toml --test cursor_pagination -- --ignored --nocapture
```

Expected before implementation: RED. A missing fixture, ignored test, or missing
1M table is a failure, never a skip.

**Step 6: Migrate frontend sequential paging**

Prefer returned cursors for next/previous sequential navigation, clear them on
context changes, and preserve current page-jump behavior. The mock implements the
same expiry/fallback contract.

**Step 7: Verify performance and commit**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml pagination::tests
cargo test --manifest-path src-tauri/Cargo.toml --test cursor_pagination -- --ignored --nocapture
node --test src/workbench/useTableSession.test.js src/workbench/mockBackend.test.js
cargo check --manifest-path src-tauri/Cargo.toml
node scripts/perf/ui-suite.mjs --scenario deep-page --samples 5
powershell -ExecutionPolicy Bypass -File scripts/perf/mysql-fixture.ps1 stop
git add src-tauri/src/pagination.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/db.rs src-tauri/src/clickhouse.rs src-tauri/src/schema_cache.rs src-tauri/src/table_sessions.rs src-tauri/tests/cursor_pagination.rs
git commit -m "perf: add context-bound cursor pagination"
git add src/workbench/composables/useTableSession.js src/workbench/useTableSession.test.js src/workbench/mock/mockBackend.js src/workbench/mockBackend.test.js
git commit -m "perf: use cursors for sequential paging"
```

The smoke run is diagnostic. Final authoritative evidence requires page-1000
p95 <= 2x page 1 under Task 29's interleaved release protocol.

### Task 21: Bounded Frontend Page Store

**Files:**
- Create: `src/workbench/pagedRowStore.js`
- Modify: `src/workbench/rowStore.js`
- Modify: `src/workbench/rowStore.test.js`
- Create: `src/workbench/rowStoreConsumers.test.js`
- Modify: `src/workbench/constants.js`
- Modify: `src/workbench/workspaceState.js`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/composables/useTableSession.js`
- Modify: `src/workbench/composables/useGridEditor.js`
- Modify: `src/workbench/composables/useRowSelection.js`
- Modify: `src/workbench/composables/useTableSearch.js`
- Modify: `src/workbench/composables/useUndo.js`
- Modify: `src/workbench/composables/useAgent.js`
- Modify: `src/workbench/composables/useVirtualGrid.js`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Modify: `src/workbench/utils/rowIdentity.js`
- Test: `src/workbench/workspaceState.test.js`
- Test: `src/workbench/useTableSession.test.js`
- Test: `src/workbench/useGridEditor.test.js`
- Test: `src/workbench/useRowSelection.test.js`
- Test: `src/workbench/useTableSearch.test.js`
- Test: `src/workbench/useVirtualGrid.test.js`

**Step 1: Run the stop/go gate**

After Tasks 9, 10, 16, and 20, run:

```powershell
node scripts/perf/ui-suite.mjs --scenario page-store-1m --samples 100 --label pre-paged-store
```

`STOP/NOT_REQUIRED` is legal only if materialized rows already plateau within the
configured resident window and the upper confidence bound of retained WebView
growth is <= 96 MB. Unbounded materialized-row growth, a missed memory target, or
a sparse navigation failure is `GO`. A confidence interval crossing a boundary
adds samples; it is not a decision. Save the gate artifact in the evidence
matrix. The current dense store is structurally unbounded, so a passing STOP
requires direct contrary evidence.

**Step 2: Parameterize failing RowStore contract tests**

Run the same contract against `DenseRowStore` and `PagedRowStore`: absolute
length, loaded length, sparse gaps, absolute lookup, page replacement, missing-
page request de-duplication, forward/back pages, LRU, row key lookup, iteration,
and generation changes. Add eviction cases for selection, editing, undo/redo,
Inspector lookup, Agent focus, search results, sibling sync, auto-fit, and drafts.

Selected rows retain identity, not an entire page. Dirty/pending rows move into a
bounded row-shadow map; drafts remain in the separate visual-row model. Default
resident capacity is eight pages and the shadow map has an explicit hard limit
with write backpressure, so pinning cannot make memory unbounded.

```powershell
node --test src/workbench/rowStore.test.js src/workbench/rowStoreConsumers.test.js
```

Expected: RED because `PagedRowStore` and the consumer gate do not exist.

**Step 3: Implement sparse page and row-shadow storage**

Implement the existing RowStore interface with absolute ranges and LRU pages.
Expose `ensureRange`, `evict`, and bounded shadow operations through the store;
consumers never inspect page maps. Keep `DenseRowStore` for small tables and
switch only after the measured threshold. Eviction never changes absolute scroll
geometry or row numbers.

**Step 4: Migrate every direct row-array consumer**

Migrate the complete production set listed in Files. The static regression test
parses JS/Vue source and fails on tab-like `.rows` access, including names such as
`tab`, `activeTab`, `targetTab`, and `activeDataTab`; only `rowStore.js` and test
fixture factories are allowlisted. Verify with:

```powershell
rg -n "(tab|activeTab|targetTab|activeDataTab).*\.rows" src/workbench -g "*.js" -g "*.vue"
```

Expected after migration: no production match outside the allowlist.

**Step 5: Run behavior suites and the 1M-row gate**

```powershell
node --test src/workbench/rowStore.test.js src/workbench/rowStoreConsumers.test.js src/workbench/workspaceState.test.js src/workbench/useTableSession.test.js src/workbench/useGridEditor.test.js src/workbench/useRowSelection.test.js src/workbench/useTableSearch.test.js src/workbench/useVirtualGrid.test.js src/workbench/composables/useAgent.test.js
node scripts/perf/ui-suite.mjs --scenario page-store-1m --samples 100 --label paged-store
```

Expected: all tests PASS; materialized rows stay within eight pages plus bounded
row shadows; retained growth upper bound <= 96 MB and plateaus; scroll/navigation
meet existing frame budgets.

**Step 6: Commit**

```powershell
git add src/workbench/pagedRowStore.js src/workbench/rowStore.js src/workbench/rowStore.test.js src/workbench/rowStoreConsumers.test.js src/workbench/constants.js src/workbench/workspaceState.js src/workbench/MySqlWorkbench.vue src/workbench/composables/useTableSession.js src/workbench/composables/useGridEditor.js src/workbench/composables/useRowSelection.js src/workbench/composables/useTableSearch.js src/workbench/composables/useUndo.js src/workbench/composables/useAgent.js src/workbench/composables/useVirtualGrid.js src/workbench/components/DataGrid.vue src/workbench/components/WorkbenchPane.vue src/workbench/utils/rowIdentity.js src/workbench/workspaceState.test.js src/workbench/useTableSession.test.js src/workbench/useGridEditor.test.js src/workbench/useRowSelection.test.js src/workbench/useTableSearch.test.js src/workbench/useVirtualGrid.test.js src/workbench/composables/useAgent.test.js
git commit -m "perf: bound large table page memory"
```

## Stage 8: Streaming IO

### Task 22: Worker-Based Excel Parsing As An Immediate UI Safeguard

**Files:**
- Create: `src/workbench/workers/xlsxWorkerCore.js`
- Create: `src/workbench/workers/xlsxWorkerCore.test.js`
- Create: `src/workbench/workers/xlsxWorker.js`
- Create: `src/workbench/utils/xlsxWorkerClient.js`
- Create: `src/workbench/utils/xlsxWorkerClient.test.js`
- Modify: `src/workbench/composables/useImportWizard.js`
- Modify: `src/workbench/composables/useBatchTransfer.js`
- Modify: `src/workbench/useImportWizard.test.js`
- Modify: `src/workbench/useBatchTransfer.test.js`
- Modify: `scripts/perf/ui-suite.mjs`

**Step 1: Write a real XLSX parsing RED test**

Generate workbook bytes with the existing `xlsx` package, then parse them through
`xlsxWorkerCore`. Cover headers, blanks, Unicode, dates, formulas, multiple
sheets, source row numbers, Excel row/column limits, and deterministic errors.
The core must not call `sheet_to_json` for a complete sheet.

```powershell
node --test src/workbench/workers/xlsxWorkerCore.test.js
```

Expected: RED because the worker core is missing.

**Step 2: Write failing backpressure/client tests**

Use a fake Worker for transferable ArrayBuffer ownership, progress, errors,
cancel, and termination. Reuse Task 18 limits: <=500 rows and <=1 MiB serialized
data per chunk, exactly one in-flight chunk. Assert no second chunk before ACK,
duplicate/out-of-order ACK rejection, cancel produces no later message, and the
main thread releases each acknowledged chunk.

```powershell
node --test src/workbench/utils/xlsxWorkerClient.test.js src/workbench/useImportWizard.test.js src/workbench/useBatchTransfer.test.js
```

Expected: RED for the missing protocol and current main-thread whole-sheet parse.

**Step 3: Implement chunked extraction in the worker**

Transfer the file ArrayBuffer into the worker. The worker may retain SheetJS's
parsed workbook, but extracts rows incrementally by range and emits only one
bounded chunk. The main thread forwards that chunk to `append_import_chunk`,
releases it, then ACKs the worker. Keep only preview rows, progress, and bounded
error summaries in Vue state; never retain complete raw rows or workbook data in
the main thread.

**Step 4: Make tests and release smoke GREEN**

```powershell
node --test src/workbench/workers/xlsxWorkerCore.test.js src/workbench/utils/xlsxWorkerClient.test.js src/workbench/useImportWizard.test.js src/workbench/useBatchTransfer.test.js
node scripts/perf/ui-suite.mjs --scenario xlsx-import-50k --samples 5
```

Expected: correct real-workbook readback, queue depth <=1, no >100 ms UI long
task, and bounded main-thread heap. The five samples are smoke only.

**Step 5: Commit**

```powershell
git add src/workbench/workers/xlsxWorkerCore.js src/workbench/workers/xlsxWorkerCore.test.js src/workbench/workers/xlsxWorker.js src/workbench/utils/xlsxWorkerClient.js src/workbench/utils/xlsxWorkerClient.test.js src/workbench/composables/useImportWizard.js src/workbench/composables/useBatchTransfer.js src/workbench/useImportWizard.test.js src/workbench/useBatchTransfer.test.js scripts/perf/ui-suite.mjs
git commit -m "perf: parse Excel imports in bounded worker chunks"
```

### Task 23: Backend Streaming Export Job

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify mechanically: `Cargo.lock`
- Create: `src-tauri/src/export.rs`
- Create: `src-tauri/src/atomic_file.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/workbench/composables/useExport.js`
- Modify: `src/workbench/composables/useBatchTransfer.js`
- Modify: `src/workbench/mock/mockBackend.js`
- Modify: `src/workbench/useExport.test.js`
- Modify: `src/workbench/useBatchTransfer.test.js`
- Modify: `src/workbench/mockBackend.test.js`
- Test inline: `src-tauri/src/export.rs`
- Test inline: `src-tauri/src/atomic_file.rs`

**Step 1: Pin and prove the constant-memory writer**

Add exact dependencies:

```toml
rust_xlsxwriter = { version = "=0.96.0", features = ["constant_memory"] }
tempfile = "=3.27.0"

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "=0.61.2", features = ["Win32_Storage_FileSystem"] }

[dev-dependencies]
calamine = "=0.36.0"
```

Write a Rust test that uses `Workbook::add_worksheet_with_constant_memory`,
writes rows strictly in ascending order, and proves through XLSX ZIP/XML and
Calamine readback that strings are inline rather than accumulated in a shared
string table. Cover large integers, leading-zero text, formula-looking text,
NULL versus empty string, Unicode, row/column/cell limits, and multi-sheet write
order. Add a 100k-row RSS test under the performance fixture.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml export::tests
```

Expected: RED/compile failure before the dependency and exporter exist.

**Step 2: Write failing job and frontend contract tests**

Cover begin/status/cancel, `hasMore == false` completion independent of inexact
count, filter/sort, safe sheet/file names, Excel limits, multi-sheet/separate
modes, progress, writer errors, cancel/error cleanup, and no complete row/workbook
payload through IPC.

```powershell
node --test src/workbench/useExport.test.js src/workbench/useBatchTransfer.test.js src/workbench/mockBackend.test.js
```

Expected: RED for the missing backend job contract.

**Step 3: Implement snapshot producer and bounded writer**

MySQL uses one dedicated connection with `REPEATABLE READ` and
`START TRANSACTION WITH CONSISTENT SNAPSHOT`; schema, a `sqlx` row stream, and
final commit/rollback stay on that connection. Do not materialize a complete
page. ClickHouse uses one streaming HTTP query instead of cross-query paging.
Feed a blocking XLSX writer through a channel charged by serialized bytes, with
at most two chunks and 1 MiB queued. Apply Excel's 32,767-character cell and
sheet-size limits before enqueueing, so a single item cannot bypass the bound.

The writer uses constant-memory worksheets, monotonically increasing rows, inline
strings, and an exporter-owned temporary directory. It never serializes workbook
bytes into frontend/Rust IPC.

**Step 4: Implement crash-safe file publication**

Write beside the chosen destination as `.partial-<uuid>`, flush and `sync_all`
the file and parent directory, then publish atomically. On Windows use
`ReplaceFileW`/`MoveFileExW` through `windows-sys`; on Unix use same-filesystem
rename. Success, error, panic, and cancellation tests prove the old destination
is intact until publish and every temporary file is removed.

**Step 5: Migrate frontend export ownership**

The frontend starts a job, observes bounded progress, and cancels by job ID. It
does not open a temporary table session or build XLSX bytes. Preserve current
dialogs, modes, filter/sort, file naming, and user-visible errors. Mock mode uses
the same state machine.

**Step 6: Verify integrity, memory, and commit in boundaries**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml export::tests
cargo test --manifest-path src-tauri/Cargo.toml atomic_file::tests
node --test src/workbench/useExport.test.js src/workbench/useBatchTransfer.test.js src/workbench/mockBackend.test.js
cargo check --manifest-path src-tauri/Cargo.toml
node scripts/perf/ui-suite.mjs --scenario export-100k --samples 5
git add src-tauri/Cargo.toml Cargo.lock src-tauri/src/export.rs src-tauri/src/atomic_file.rs src-tauri/src/lib.rs
git commit -m "perf: stream constant-memory XLSX exports"
git add src-tauri/src/types.rs src-tauri/src/commands.rs
git commit -m "feat: expose cancellable export jobs"
git add src/workbench/composables/useExport.js src/workbench/composables/useBatchTransfer.js src/workbench/mock/mockBackend.js src/workbench/useExport.test.js src/workbench/useBatchTransfer.test.js src/workbench/mockBackend.test.js
git commit -m "perf: move export work out of the WebView"
```

Calamine must read back row counts, values, types, sheet names, and formulas.
Peak Rust RSS must plateau across 20/50/100 runs and cannot scale with row count.

### Task 24: Streaming Backup And Restore

**Files:**
- Modify: `src-tauri/src/backup.rs`
- Create: `src-tauri/src/sql_stream.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/schema_cache.rs`
- Modify: `src-tauri/src/table_count.rs`
- Modify: `src-tauri/src/table_sessions.rs`
- Modify: `src/workbench/composables/useBackupCenter.js`
- Modify: `src/workbench/useBackupCenter.test.js`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workspaceState.js`
- Modify: `src/workbench/mock/mockBackend.js`
- Modify: `src/workbench/mockBackend.test.js`
- Create: `src-tauri/tests/snapshot_restore.rs`
- Test inline: `src-tauri/src/sql_stream.rs`
- Test inline: `src-tauri/src/backup.rs`

**Step 1: Write failing stream/parser and job tests**

Test escaped quotes, delimiters, comments, Unicode, NULL, binary data, large
values, truncated input, maximum statement bytes, cancellation, writer errors,
temporary cleanup, and atomic publication through Task 23's `atomic_file`. Compare
parsed statements and restored semantics, not unstable SQL byte order.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml sql_stream::tests
cargo test --manifest-path src-tauri/Cargo.toml backup::tests
```

Expected: RED for the missing stream parser/job contract.

**Step 2: Write mandatory snapshot-consistency integration tests**

On the isolated MySQL fixture, mutate rows concurrently while a snapshot is
running. Assert the restored database corresponds to one consistent snapshot,
with identical schema, table counts, row counts, and per-table canonical checksums.
Inject cancel before the destructive phase and process failure after the first
restore mutation. Pre-phase cancel leaves the database unchanged. Once mutation
starts, cancellation is deferred; a crash/error reports `recovery_required` and
preserves the pre-restore snapshot path, never ordinary success.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test snapshot_restore -- --ignored --nocapture
```

Expected before implementation: RED. Missing fixture is incomplete.

**Step 3: Stream snapshot data on a dedicated connection**

Use one `REPEATABLE READ` consistent-snapshot connection for table list, counts,
DDL, column metadata, schema signature, and all InnoDB rows. Finish each table's
row stream before issuing the next query on that connection. Detect a concurrent
DDL/schema-signature change and fail without publishing. Replace `fetch_all` with
`sqlx` row streams. Encode separators and tuples directly into a fixed-capacity
`BufWriter`; do not build `Vec<String>` and `join()` it. The memory contract is
configured buffer bytes plus one validated row. Reject a row whose encoded
statement exceeds the explicit snapshot statement limit before publishing any
final file. Propagate every write/flush/sync/rename error, including injected
short write, disk full, and flush failure.

Write SQL and manifest to same-directory UUID temporary paths. Publish the SQL
through `atomic_file`, then publish the manifest last as the completion marker;
listing ignores orphan/partial files. Use estimates for scheduling/progress, but
validate exact bytes and free space before final publication.

**Step 4: Stream restore and expose cancellation**

Parse from `BufRead` without `read_to_end` or a whole statement vector. Execute
one bounded statement at a time on the same dedicated connection because
`FOREIGN_KEY_CHECKS` is session-scoped. Before the first destructive statement,
acquire the PoolKey exclusive maintenance barrier, stop background jobs, reject
new reads/writes, and honor cancellation. Once destructive work starts, defer
cancellation and finish or return `recovery_required`; MySQL DDL cannot be
honestly presented as atomic rollback.

On every post-mutation exit, close the database pool and invalidate database-wide
schema/count/mutation generations, all table sessions/cursors, and all matching
frontend tabs, RowStores, drafts, pending edits, and undo state before another
read/write is allowed. Emit `{ connectionId, database, generation }` so sibling
tabs cannot retain restored-away data.

**Step 5: Make all tests and memory fixtures GREEN**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml sql_stream::tests
cargo test --manifest-path src-tauri/Cargo.toml backup::tests
cargo test --manifest-path src-tauri/Cargo.toml --test snapshot_restore -- --ignored --nocapture
node --test src/workbench/useBackupCenter.test.js
cargo check --manifest-path src-tauri/Cargo.toml
node scripts/perf/ui-suite.mjs --scenario snapshot-restore-large --samples 5
```

Expected: semantic readback PASS, no leaked temp files/jobs/sessions, and Rust RSS
plateaus instead of following snapshot size.

**Step 6: Commit snapshot and restore separately**

```powershell
git add src-tauri/src/backup.rs src-tauri/src/sql_stream.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/commands.rs
git commit -m "perf: stream logical database snapshots"
git add src-tauri/src/backup.rs src-tauri/src/sql_stream.rs src-tauri/src/schema_cache.rs src-tauri/src/table_count.rs src-tauri/src/table_sessions.rs src-tauri/tests/snapshot_restore.rs src/workbench/composables/useBackupCenter.js src/workbench/useBackupCenter.test.js src/workbench/MySqlWorkbench.vue src/workbench/workspaceState.js src/workbench/mock/mockBackend.js src/workbench/mockBackend.test.js
git commit -m "perf: stream and invalidate snapshot restores"
```

## Stage 9: Startup And Background Work

### Task 25: Foreground-First Startup Coordinator

**Files:**
- Create: `src/workbench/composables/useStartupCoordinator.js`
- Create: `src/workbench/useStartupCoordinator.test.js`
- Modify: `src/workbench/composables/useConnection.js`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workspaceState.js`
- Modify: `src/workbench/composables/useUpdater.js`
- Modify: `src/workbench/composables/useAgent.js`
- Modify: `src/workbench/useConnection.test.js`
- Modify: `src/workbench/useUpdater.test.js`
- Modify: `src/workbench/composables/useAgent.test.js`

**Step 1: Write deterministic scheduler RED tests**

Inject rAF, idle callback, timers, cancellation tokens, connection restore,
updater, and Agent prewarm. Tests use a fake clock, never wall time. Prove a
selected connection that is not first restores first, a blocked secondary cannot
delay first usable paint, restore concurrency is bounded, and a foreground table
action cancels/defer idle updater/Agent work.

```powershell
node --test src/workbench/useStartupCoordinator.test.js src/workbench/useConnection.test.js src/workbench/useUpdater.test.js src/workbench/composables/useAgent.test.js
```

Expected: RED for the missing coordinator and current eager startup ordering.

**Step 2: Implement foreground-first phases**

Render connection/tab placeholders from persisted metadata immediately. Restore
the selected connection first with an explicit timeout, then allow first usable
paint. Restore secondary connections through a bounded idle queue. Updater and
Agent prewarm begin only after double-rAF plus idle and are cancelled/rescheduled
when foreground work arrives. All task errors are isolated and observable.

**Step 3: Make focused tests and startup smoke GREEN**

```powershell
node --test src/workbench/useStartupCoordinator.test.js src/workbench/useConnection.test.js src/workbench/useUpdater.test.js src/workbench/composables/useAgent.test.js
node scripts/perf/ui-suite.mjs --scenario startup --mode app-cold,warm --samples 5
```

Expected: tests PASS, selected connection owns the first foreground slot, and no
secondary/prewarm job blocks first usable paint. Five samples are smoke only;
Task 29 starts a fresh release process for every authoritative app-cold sample.

**Step 4: Commit**

```powershell
git add src/workbench/composables/useStartupCoordinator.js src/workbench/useStartupCoordinator.test.js src/workbench/composables/useConnection.js src/workbench/MySqlWorkbench.vue src/workbench/workspaceState.js src/workbench/composables/useUpdater.js src/workbench/composables/useAgent.js src/workbench/useConnection.test.js src/workbench/useUpdater.test.js src/workbench/composables/useAgent.test.js
git commit -m "perf: prioritize first usable startup work"
```

### Task 26: Bounded Agent DB Work And Streaming UI

**Files:**
- Modify: `src-tauri/src/agent/mod.rs`
- Modify: `src-tauri/src/agent/db_bridge.rs`
- Modify: `src-tauri/src/agent/profile.rs`
- Create: `src/workbench/utils/agentStreamBuffer.js`
- Create: `src/workbench/utils/agentStreamBuffer.test.js`
- Modify: `src/workbench/composables/useAgent.js`
- Modify: `src/workbench/components/AgentPanel.vue`
- Modify: `src/workbench/components/AgentMessage.vue`
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/composables/useAgent.test.js`
- Modify: `src/workbench/markdown.test.js`

**Step 1: Write backend concurrency/cache RED tests**

Prove Agent profile and DB calls use Task 11A's shared background permit,
foreground page work always obtains its reserved capacity, cancellation releases
the connection/query, and the profile cache has capacity, TTL, and generation
invalidation.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml agent::
```

Expected: RED for unbounded Agent work and cache growth.

**Step 2: Implement and commit bounded backend work**

Route every Agent DB/profile request through the shared scheduler and existing
PoolKey. Propagate cancellation to the SQL/HTTP future, enforce a query timeout,
and store only bounded profile summaries.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml agent::
cargo check --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/agent/mod.rs src-tauri/src/agent/db_bridge.rs src-tauri/src/agent/profile.rs
git commit -m "perf: bound background Agent database work"
```

**Step 3: Write frontend stream-buffer RED tests**

Use fake rAF/timers. The only flush rule is at most once per animation frame;
a 50 ms timer is a no-frame fallback. Assert text/thinking order, synchronous
flush before tool/done/error, no update after abort, one final full Markdown
parse, and one coalesced auto-scroll per frame.

```powershell
node --test src/workbench/utils/agentStreamBuffer.test.js src/workbench/composables/useAgent.test.js src/workbench/markdown.test.js
```

Expected: RED because each delta currently mutates reactive text and reparses the
complete message.

**Step 4: Implement and commit buffered rendering**

Accumulate deltas outside deep reactivity, publish one string update per frame,
render the in-progress message as escaped pre-wrapped text, and run the full
Markdown parser exactly once on completion. Flush before structural events.
Apply `content-visibility` to completed offscreen messages and coalesce scroll.

```powershell
node --test src/workbench/utils/agentStreamBuffer.test.js src/workbench/composables/useAgent.test.js src/workbench/markdown.test.js
node scripts/perf/ui-suite.mjs --scenario agent-stream-20k --samples 100
git add src/workbench/utils/agentStreamBuffer.js src/workbench/utils/agentStreamBuffer.test.js src/workbench/composables/useAgent.js src/workbench/components/AgentPanel.vue src/workbench/components/AgentMessage.vue src/workbench/workbench.css src/workbench/composables/useAgent.test.js src/workbench/markdown.test.js
git commit -m "perf: buffer Agent streaming renders"
```

Expected: no >100 ms long task, final Markdown parse <=100 ms, and foreground
table latency with Agent active stays within the shared 10% regression budget.

**Step 5: Gate long-history message virtualization**

Run a 500-message/20k-character history fixture. If content visibility meets DOM,
frame, and retained-memory targets, record `NOT_REQUIRED`. Otherwise add a
separate RED test and virtual message window before this task is complete. Never
record ordinary `SKIP`.

### Task 27: Reusable ClickHouse Client And Compact Responses

**Files:**
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/clickhouse.rs`
- Modify: `src-tauri/src/runtime_resources.rs`
- Test inline: `src-tauri/src/clickhouse.rs`

**Step 1: RED/GREEN reusable-client behavior**

Use a local controllable HTTP server that records accepted TCP connections and
remote ports. Two commands on one runtime connection must share the configured
`reqwest::Client`, timeout policy, and connection pool; different connection IDs
must remain isolated.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml clickhouse::tests::reuses_client
```

Expected: RED because commands construct independent clients.

Implement the client in `RuntimeConnection`, then run the test and commit:

```powershell
git add src-tauri/src/types.rs src-tauri/src/clickhouse.rs src-tauri/src/runtime_resources.rs
git commit -m "perf: reuse ClickHouse HTTP clients"
```

**Step 2: RED/GREEN batched schema metadata**

Add a server fixture that counts requests and returns multiple tables. Assert one
batch request returns the same normalized metadata, errors, and order as the old
per-table path, including sorting/primary expressions from Task 20.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml clickhouse::tests::batches_schema
```

Expected: RED with more than one metadata request. Implement the batch query,
make it GREEN, and commit:

```powershell
git add src-tauri/src/clickhouse.rs
git commit -m "perf: batch ClickHouse schema reads"
```

**Step 3: Evidence-gated compact/streaming response**

Characterize current JSON with a golden fixture, then add JSONCompactEachRow or
streaming parsing only if the measured 100k-row response misses memory/latency
targets. The golden test compares every field, NULL, numeric/string boundary,
error, timeout, cancellation, and read-only guard.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml clickhouse::tests
cargo check --manifest-path src-tauri/Cargo.toml
```

If changed, commit `src-tauri/src/clickhouse.rs` as
`perf: stream compact ClickHouse responses`; otherwise record direct
`NOT_REQUIRED` evidence. This does not undo Task 23's mandatory one-query
ClickHouse export stream.

## Stage 10: Evidence-Gated Wide Grid

### Task 28: Horizontal Column Window

Execute only if the optimized 200/500-column release fixture still misses the
frame/DOM budget. Record `NOT_REQUIRED`, never `SKIP`, if implementation is not
needed.

**Files:**
- Create: `src/workbench/composables/useVirtualColumns.js`
- Create: `src/workbench/useVirtualColumns.test.js`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/composables/useVirtualGrid.js`
- Modify: `src/workbench/composables/useColumnResize.js`
- Modify: `src/workbench/composables/useGridEditor.js`
- Modify: `src/workbench/useVirtualGrid.test.js`
- Modify: `src/workbench/useColumnResize.test.js`
- Modify: `src/workbench/useGridEditor.test.js`
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `scripts/perf/evidence-matrix.json`

**Step 1: Run and classify the pre-gate**

```powershell
node scripts/perf/ui-suite.mjs --scenario wide-grid --columns 200,500 --samples 100 --label pre-column-window
```

`STOP/NOT_REQUIRED` requires both p95 upper confidence bounds <=20 ms at 200
columns and <=25 ms at 500, >50 ms frames <1%, no >100 ms long task, and mounted
cells <= this measured formula:

```text
(visible row window + 2 * row overscan)
* (visible columns + 2 * column overscan + frozen/selected/edited union)
```

The observed count may not exceed the formula or 2,500 cells, whichever is
smaller. A confirmed failure is `GO`; a confidence interval crossing a threshold
adds samples. For STOP, update the matrix with raw artifact/SHA and commit only
that evidence change.

**Step 2: For GO, write interaction/geometry RED tests**

Cover prefix-sum geometry, dynamic widths, spacers, overscan, frozen/selected/
edited union, keyboard navigation across unmounted columns, range copy, resize,
auto-fit, context menus, accessibility indices, and focus restoration.

```powershell
node --test src/workbench/useVirtualColumns.test.js src/workbench/useVirtualGrid.test.js src/workbench/useColumnResize.test.js src/workbench/useGridEditor.test.js src/workbench/workbenchShell.test.js
```

Expected: RED because the full column DOM is mounted and no column-window API
exists.

**Step 3: Implement the data-driven column window**

Use prefix sums for x/width lookup and render left/right spacers. Union the
visible window with frozen, selected, edited, and focus-target columns. Clipboard,
selection, and auto-fit read the data model, never absent DOM cells. Keep the
40-column path behavior-compatible.

**Step 4: Make absolute and relative gates GREEN**

```powershell
node --test src/workbench/useVirtualColumns.test.js src/workbench/useVirtualGrid.test.js src/workbench/useColumnResize.test.js src/workbench/useGridEditor.test.js src/workbench/workbenchShell.test.js
node scripts/perf/ui-suite.mjs --scenario wide-grid --columns 40,200,500 --samples 100 --label column-window
```

Accept only when all absolute targets pass, wide-grid p95 improves at least 25%
by lower confidence bound, and the 40-column regression is not proven above 5%.
Otherwise continue optimizing; do not bypass the gate.

**Step 5: Commit implementation or gate evidence**

```powershell
git add src/workbench/composables/useVirtualColumns.js src/workbench/useVirtualColumns.test.js src/workbench/components/DataGrid.vue src/workbench/composables/useVirtualGrid.js src/workbench/composables/useColumnResize.js src/workbench/composables/useGridEditor.js src/workbench/useVirtualGrid.test.js src/workbench/useColumnResize.test.js src/workbench/useGridEditor.test.js src/workbench/workbenchShell.test.js scripts/perf/evidence-matrix.json
git commit -m "perf: virtualize wide grid columns"
```

For `NOT_REQUIRED`, stage only `scripts/perf/evidence-matrix.json` and the small
versioned gate artifact, then commit `perf: record wide grid stop gate`.

## Stage 11: Full Verification And Completion Audit

### Task 29: Automated Regression Matrix

**Files:**
- Create: `scripts/perf/release-suite.mjs`
- Create: `scripts/perf/release-suite.test.mjs`
- Create: `scripts/perf/compare.mjs`
- Create: `scripts/perf/compare.test.mjs`
- Create: `scripts/perf/archive.mjs`
- Create: `scripts/perf/mysql-seed.ps1`
- Modify: `scripts/perf/mysql-fixture.ps1`
- Modify: `scripts/perf/evidence-matrix.json`
- Create: `docs/performance/evidence/2026-07/manifest.json`
- Create: `docs/performance/2026-07-system-performance-report.md`

**Step 1: Write compare/matrix RED tests**

Use a deterministic bootstrap seed and 95% intervals. Tests require non-zero for
missing before/after, schema/scenario version mismatch, <100 interaction samples,
environment/fixture/harness mismatch, stale hashes, `SKIP`, `missing`, `indirect`,
`INCONCLUSIVE`, failed absolute target, or regression CI beyond budget.
`NOT_REQUIRED` is valid only for an evidence-gated task with direct passing
measurements. Absolute p95 uses its upper bound; 25% improvement uses the lower
improvement bound; regression uses the lower regression bound. Inconclusive
results request more samples up to 500 and cannot finish.

```powershell
node --test scripts/perf/compare.test.mjs scripts/perf/evidence-matrix.test.mjs
```

Expected: RED because the comparison engine does not exist and matrix rows remain
pending.

**Step 2: Write release-orchestrator RED tests**

Inject a fake process runner and clock. Verify exact command order, stop on first
failure, MySQL/process/worktree cleanup in `finally`, ignored integration tests
run explicitly, missing/stale exe rejected, and absent artifacts never continue.
Verify it invokes the literal `npm run tauri -- build` for both baseline and
candidate and never substitutes `npm run build`/`tauri dev`.

```powershell
node --test scripts/perf/release-suite.test.mjs
```

Expected: RED for the missing orchestrator.

**Step 3: Implement reproducible baseline/candidate builds**

Read the baseline commit and scenario version from the matrix. Create a detached
temporary baseline worktree under `target/perf-baseline`, install locked
dependencies, and build baseline and candidate with `npm run tauri -- build`.
Resolve Cargo's target directory via `cargo metadata`; require each
`dbscout-workbench.exe` mtime after its build start. Record source commit,
dirty-diff SHA, exe SHA-256/size/mtime/version, `debug_assertions=false`, and
embedded frontend source. Reject reused executables.

Final A/B sampling runs both builds on the same machine in deterministic
interleaved order. Reports must match OS build, CPU, power mode, WebView2, MySQL
version, fixture hash, harness hash, and scenario version.

**Step 4: Implement metric-specific protocols**

- Interaction: at least 100 samples per build, interleaved.
- App-cold startup: new process for every sample and no warmup. OS-cold is a
  separately labeled observational run after a controlled machine restart; no
  fake cache-clearing command is used for the app-cold gate.
- Frames: retain the full distribution of thousands of intervals.
- Memory: record main process, WebView2 children, and Node sidecar as a process
  tree at 20/50/100 repetitions; compare slope and plateau.
- Database: reset to the same fixture snapshot between A/B rounds.

Any task-local `--samples 5` output is smoke only and cannot populate an
authoritative matrix cell.

**Step 5: Make MySQL and all regression paths mandatory**

`release-suite` performs `start -> seed -> test -> release audit -> stop` in
`finally`. `mysql-seed.ps1` creates deterministic 1M/deep-page, cross-database,
composite/nullable/no-key, import/export, and backup/restore fixtures. Missing
`mysqld.exe`, wrong version, incomplete seed, or any sentinel operation exits
non-zero as `INCOMPLETE`.

It explicitly runs:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test cross_database_sessions -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --test cursor_pagination -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --test audit_recovery -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --test snapshot_restore -- --ignored --nocapture
```

**Step 6: Make unit tests GREEN and run the non-UI matrix**

```powershell
node --test scripts/perf/compare.test.mjs scripts/perf/evidence-matrix.test.mjs scripts/perf/release-suite.test.mjs
node scripts/test-workbench.mjs
node scripts/test-sidecar.mjs
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
node scripts/perf/release-suite.mjs --phase build,test,database
```

Expected: all PASS, both fresh release exes proven, fixture always cleaned.

**Step 7: Persist auditable evidence**

`archive.mjs` stores compact raw numeric samples, command exit/timing logs, and
matrix inputs as gzip files under `docs/performance/evidence/2026-07/`. Commit the
manifest with relative paths, sizes, and SHA-256. Exes, DB data, and screenshots
remain in `output/performance/final/`, but their hashes and provenance are in the
versioned manifest. Generate the Markdown report from matrix/JSON only; hand-
edited result cells are rejected.

Do not commit the report yet; Task 30 adds authoritative Tauri results.

### Task 30: Real Runtime And UI Audit

**Files:**
- Modify: `package.json`
- Modify mechanically: `package-lock.json`
- Create: `scripts/perf/ensure-tauri-driver.ps1`
- Create: `scripts/perf/tauri-release-suite.mjs`
- Create: `scripts/perf/tauri-release-suite.test.mjs`
- Create: `src/workbench/utils/perfRuntime.js`
- Create: `src/workbench/utils/perfRuntime.test.js`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `scripts/perf/release-suite.mjs`
- Modify: `scripts/perf/evidence-matrix.json`
- Modify: `docs/performance/evidence/2026-07/manifest.json`
- Modify: `docs/performance/2026-07-system-performance-report.md`

**Step 1: Write the real-runtime harness RED tests**

Pin `webdriverio` at `9.29.1`. The setup script requires `tauri-driver 2.0.6`,
detects the installed WebView2 runtime version, and obtains a matching Edge
WebDriver in an ignored tools directory with SHA/version validation. Unit tests
inject process/HTTP/WebDriver adapters and prove startup timeout, stale driver,
crash, teardown, and result collection behavior.

```powershell
node --test scripts/perf/tauri-release-suite.test.mjs src/workbench/utils/perfRuntime.test.js
```

Expected: RED because no Tauri WebDriver harness or benchmark runtime bridge
exists.

**Step 2: Implement an instrumented, not DevTools-timed, release harness**

Use Tauri WebDriver/WebView2 for real UI actions. The app's bounded recorder
collects performance with no DevTools/CDP timing connection; WebDriver only
drives and reads final JSON. For every session assert:

- actual release `.exe` hash equals the build manifest,
- `debugAssertions == false` and `frontendSource == "embedded"`,
- no Vite/dev server is running,
- `navigator.userAgent` and WebView2 version match the environment manifest,
- frontend and Rust spans share one run ID,
- whole process-tree RSS includes WebView2 and Node sidecar children.

`perfRuntime.js` is inert unless the explicit release performance profile is
active and exposes only benchmark actions/snapshots, never database credentials.

**Step 3: Make the harness GREEN and commit it**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/perf/ensure-tauri-driver.ps1
node --test scripts/perf/tauri-release-suite.test.mjs src/workbench/utils/perfRuntime.test.js
git add package.json package-lock.json scripts/perf/ensure-tauri-driver.ps1 scripts/perf/tauri-release-suite.mjs scripts/perf/tauri-release-suite.test.mjs src/workbench/utils/perfRuntime.js src/workbench/utils/perfRuntime.test.js src/workbench/MySqlWorkbench.vue scripts/perf/release-suite.mjs
git commit -m "test: automate real Tauri release performance"
```

**Step 4: Run browser-supporting and authoritative Tauri matrices**

Playwright Chromium checks layout/screenshots and mounted-node invariants for
normal, 800-table, 100k-row, 200/500-column, desktop, and constrained viewports.
It is supporting evidence only.

Then run the literal build and full release suite:

```powershell
npm run tauri -- build
node scripts/perf/ui-suite.mjs --scenario all-supporting --samples 100
node scripts/perf/release-suite.mjs --phase all
```

The real Tauri phase must cover startup, schema switch, open/scroll/navigation,
search, paged memory, import/audit/rollback, export readback, backup/restore,
Agent streaming, ClickHouse mock-server behavior, background contention, session
cleanup, and cross-database sentinels against the mandatory isolated MySQL
fixture. No `SKIP`, missing, indirect, or inconclusive cell may remain.

**Step 5: Bind report, matrix, and executable provenance**

Cross-check source commit, dirty-diff SHA, exe SHA-256, frontend/backend run ID,
fixture/scenario/harness hashes, WebView2 version, and every raw artifact. Run
`archive.mjs`, regenerate the report, and fail if a report value differs from its
machine-readable source.

**Step 6: Run full correctness/build verification**

```powershell
node scripts/test-workbench.mjs
node scripts/test-sidecar.mjs
node --test scripts/perf/*.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
git diff --check
```

Expected: all PASS; the just-built release exe is the one named in the report.

**Step 7: Independent review and final commit**

Use @superpowers:requesting-code-review. Resolve every confirmed P0/P1 or attach
direct measured evidence that the path is already below budget, then rerun its
affected matrix and the completion validator.

```powershell
git add scripts/perf/evidence-matrix.json docs/performance/evidence/2026-07 docs/performance/2026-07-system-performance-report.md
git commit -m "docs: publish verified performance results"
git status --short
git diff --check c89f219..HEAD
```

Inspect the original worktree separately and prove its version changes remain
untouched. Only then may the persistent goal be marked complete.

## Execution Order And Checkpoints

Execute Tasks 0-13 strictly in order. After Task 13, rerun the full correctness
suite and publish an interim benchmark. Tasks 14-19 may be split among agents
only when their files do not overlap. Tasks 20-21 require the session/schema
foundation. Tasks 22-24 require batch/cursor infrastructure. Tasks 25-27 may run
after Stage 4 but must be benchmarked against foreground work. Task 28 is gated.
Tasks 29-30 are mandatory. A gated task uses `NOT_REQUIRED` only with direct
passing evidence; all ordinary skips are incomplete.

At every stage checkpoint:

```powershell
git status --short
git diff --check c89f219..HEAD
node scripts/test-workbench.mjs
node scripts/test-sidecar.mjs
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Do not claim a stage complete from a focused test alone.
