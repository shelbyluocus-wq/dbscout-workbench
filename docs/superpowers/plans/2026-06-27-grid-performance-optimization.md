# Grid Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make table opening, large-grid scrolling, table search, and cleanup measurably faster while preserving current editing, sorting, filtering, export, and split-pane behavior.

**Architecture:** The first wave changes the paging contract so interactive table reads skip blocking exact counts and return explicit `hasMore` / `totalRowsExact` metadata. Later waves make table search incremental, reduce duplicated visible-cell work, schedule load-more checks outside the scroll hot path, and remove proven-dead search code.

**Tech Stack:** Tauri 2, Rust 2021, sqlx MySQL, Vue 3 Composition API, Vite, Node `node:test`, Rust `cargo test`.

---

## File Structure

- Modify `src-tauri/src/types.rs`
  - Add `include_total` to `TablePageRequest`.
  - Add `total_rows_exact` and `has_more` to `TableSessionPage`.
- Modify `src-tauri/src/db.rs`
  - Add count metadata helpers.
  - Make `read_db_page` skip `COUNT(*)` unless `request.include_total` is true.
  - Add pure Rust tests for count metadata and SQL-count gating.
- Modify `src-tauri/src/clickhouse.rs`
  - Mirror `include_total` behavior for ClickHouse page reads.
  - Add pure SQL-builder tests for read/count separation where practical.
- Modify `src-tauri/src/demo.rs`
  - Populate exact metadata for demo/stress pages because demo counts are cheap.
- Modify `src/workbench/workspaceState.js`
  - Store `totalRowsExact`, `hasMore`, and `rowKeyCacheVersion`.
  - Normalize the new fields in `replaceTabPage` / `appendTabPage`.
- Modify `src/workbench/workspaceState.test.js`
  - Cover unknown totals, exact totals, `hasMore`, and row-key cache invalidation.
- Modify `src/workbench/composables/useTableSession.js`
  - Request `includeTotal: false` for open/fetch/load-more.
  - Derive `nextPage` from `tab.pageSize`.
  - Stop load-more via `hasMore === false`.
  - Format status labels without claiming exact totals when unknown.
- Modify `src/workbench/useTableSession.test.js`
  - Cover `includeTotal: false`, unknown-count labels, `hasMore`, and returned page-size pagination.
- Later-wave files:
  - `src/workbench/composables/useTableSearch.js`
  - `src/workbench/utils/cellDisplay.js`
  - `src/workbench/composables/useVirtualGrid.js`
  - `src/workbench/components/DataGrid.vue`
  - `src/workbench/components/WorkbenchPane.vue`
  - `src/workbench/MySqlWorkbench.vue`
  - `src/workbench/composables/useDataSearch.js`
  - `src/workbench/mock/mockBackend.js`

---

### Task 1: First-Frame Paging Metadata

**Files:**
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/clickhouse.rs`
- Modify: `src-tauri/src/demo.rs`
- Modify: `src/workbench/workspaceState.js`
- Modify: `src/workbench/composables/useTableSession.js`
- Test: `src-tauri/src/db.rs`
- Test: `src-tauri/src/clickhouse.rs`
- Test: `src/workbench/workspaceState.test.js`
- Test: `src/workbench/useTableSession.test.js`

- [ ] **Step 1: Write failing Rust tests for count metadata**

Add tests proving:

```rust
let request = TablePageRequest { page: Some(1), page_size: Some(1000), include_total: Some(false), filter: None, sort: None };
assert!(!should_include_total(&request));
assert_eq!(count_metadata_without_total(1000, 1000, 1), (1000, false, true));
assert_eq!(count_metadata_without_total(400, 1000, 1), (400, false, false));
```

Expected red failure: `include_total`, `should_include_total`, and `count_metadata_without_total` are missing.

- [ ] **Step 2: Write failing frontend state tests**

Add tests proving `replaceTabPage` stores unknown total metadata and `appendTabPage` marks `fullyLoaded` only when `hasMore === false` or no rows are returned.

Expected red failure: `totalRowsExact`, `hasMore`, and `rowKeyCacheVersion` are missing or normalized incorrectly.

- [ ] **Step 3: Write failing table-session tests**

Add tests proving open/fetch/load-more requests include `includeTotal: false`, load-more uses the backend-returned `pageSize`, and labels show loaded progress when totals are unknown.

Expected red failure: requests omit the field, pagination still uses `REQUEST_PAGE_SIZE`, and labels still use exact `totalRows`.

- [ ] **Step 4: Implement Rust paging metadata**

Add `include_total` to `TablePageRequest` and `total_rows_exact` / `has_more` to `TableSessionPage`.

In MySQL and ClickHouse page reads:

```rust
let include_total = should_include_total(request);
let (total_rows, total_rows_exact, has_more) = if include_total {
    let total_rows = read_exact_count(...).await?;
    let loaded_end = (page as u64).saturating_mul(page_size as u64);
    (total_rows, true, loaded_end < total_rows)
} else {
    count_metadata_without_total(rows.len(), page_size, page)
};
```

Keep demo pages exact because their count is already known.

- [ ] **Step 5: Implement frontend paging state**

Add default tab fields:

```js
totalRowsExact: true,
hasMore: false,
rowKeyCacheVersion: 0,
```

Normalize page payloads in `replaceTabPage` and `appendTabPage`, incrementing `rowKeyCacheVersion` when rows or primary keys are replaced/appended.

- [ ] **Step 6: Implement table-session request and label changes**

Make `buildPageRequest` include `includeTotal: false` by default. Make `loadNextPage` use:

```js
const pageSize = Math.max(1, Math.floor(Number(tab.pageSize) || REQUEST_PAGE_SIZE));
const nextPage = Math.floor((tab.rows.length || 0) / pageSize) + 1;
```

Use labels that distinguish exact totals from loaded progress.

- [ ] **Step 7: Run focused verification**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml db::tests clickhouse::tests demo::tests
node --test src/workbench/workspaceState.test.js src/workbench/useTableSession.test.js
```

Expected: all focused tests pass.

---

### Task 2: Incremental Table Search

**Files:**
- Modify: `src/workbench/composables/useTableSearch.js`
- Modify: `src/workbench/utils/cellDisplay.js`
- Modify: `src/workbench/editState.js`
- Test: `src/workbench/useTableSearch.test.js`
- Test: `src/workbench/cellDisplay.test.js`
- Test: `src/workbench/editState.test.js`

- [ ] Add failing tests for cached same-query scans, chunked/yielding scans, edit-state invalidation, and retained match ranking.
- [ ] Add an edit-state mutation counter.
- [ ] Add query-signature search cache and incremental row scanning.
- [ ] Add highlight cache returning `{ html, matched }`.
- [ ] Run `node --test src/workbench/useTableSearch.test.js src/workbench/cellDisplay.test.js src/workbench/editState.test.js`.

---

### Task 3: Visible Grid Render-Path Reduction

**Files:**
- Modify: `src/workbench/composables/useVirtualGrid.js`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/composables/useColumnResize.js`
- Test: `src/workbench/useVirtualGrid.test.js`
- Test: `src/workbench/dataGridImports.test.js`
- Test: `src/workbench/workbenchShell.test.js`

- [ ] Add failing tests for precomputed visible row keys and normalized column names.
- [ ] Return visible row metadata and active column metadata.
- [ ] Replace repeated `columnName()` and duplicate `highlightCell()` calls in `DataGrid.vue`.
- [ ] Keep insert rows and column resize behavior intact.
- [ ] Run focused grid tests.

---

### Task 4: Scroll Load Scheduling

**Files:**
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Test: `src/workbench/workbenchShell.test.js`

- [ ] Add static/behavior tests proving grid scroll listeners are passive and load-more checks are scheduled through `requestAnimationFrame`.
- [ ] Move proximity checks into a scheduled helper.
- [ ] Keep `loadNextPage` guards as the final authority.
- [ ] Run focused shell tests.

---

### Task 5: Dead Code Removal

**Files:**
- Delete if proven unused: `src/workbench/composables/useDataSearch.js`
- Modify: `src/workbench/mock/mockBackend.js`
- Modify: `src/workbench/mockBackend.test.js`
- Modify: `src/workbench/workbenchShell.test.js`
- Modify only if proven safe: `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/db.rs`

- [ ] Add static tests proving no production import or invocation of `search_data` remains.
- [ ] Delete `useDataSearch.js` and mock `search_data` compatibility only after the static test fails for the old path.
- [ ] Keep `quick_search` if still registered or used by agent-facing flows.
- [ ] Remove Rust dead helpers only when all call sites and tests are replaced.
- [ ] Run frontend and Rust focused tests.

---

### Task 6: Full Verification And Runtime Smoke

**Files:**
- No planned code edits unless verification reveals a regression.

- [ ] Run explicit JS tests or `node --test src/workbench` if reliable in this checkout.
- [ ] Run `cargo test --manifest-path src-tauri\Cargo.toml`.
- [ ] Run `npm run build`.
- [ ] Start dev app and open a large stress table.
- [ ] Verify first grid rows render before exact totals are available.
- [ ] Scroll and table-search a large table while watching `[dbscout:perf]` records.
- [ ] Report remaining waves honestly if not all waves are complete.

---

## Self-Review

- Spec coverage:
  - First-frame count removal: Task 1.
  - Unknown total UI contract: Task 1.
  - Incremental search: Task 2.
  - Grid render reduction: Task 3.
  - Scroll jank reduction: Task 4.
  - Dead code removal: Task 5.
  - Verification: Task 6.
- Placeholder scan: no task uses `TBD`, `TODO`, or "add tests" without naming the expected behavior.
- Type consistency: Rust uses snake_case fields and serde camelCase, so frontend payloads use `includeTotal`, `totalRowsExact`, and `hasMore`.
