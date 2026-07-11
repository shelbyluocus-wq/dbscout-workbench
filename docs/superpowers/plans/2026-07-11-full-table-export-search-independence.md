# Full-Table Export Search Independence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure single-table export always includes every table row even when an in-table search is active.

**Architecture:** Keep the existing independent, paginated export session and remove only the UI search filter from its page requests. Preserve the active sort so it controls row order without narrowing the exported dataset.

**Tech Stack:** Vue 3 composables, JavaScript ES modules, Node.js test runner, SheetJS (`xlsx`)

## Global Constraints

- Single-table export must ignore the in-table search query, search mode, and active match.
- Current column sorting must remain in export requests.
- Export must continue reading every page from a fresh table session.
- Existing empty-table, workbook naming, save fallback, and success-feedback behavior must remain unchanged.
- Do not modify the unrelated existing change in `src-tauri/Cargo.toml`.

---

### Task 1: Decouple Export Pagination from In-Table Search

**Files:**
- Modify: `src/workbench/useExport.test.js`
- Modify: `src/workbench/composables/useExport.js`

**Interfaces:**
- Consumes: `useExport(invokeWorkbench, options)` and `exportTable(tab)`.
- Produces: export page requests shaped as `{ page, pageSize, sort? }`, with no `filter` derived from the active tab.

- [x] **Step 1: Change the pagination regression test to require complete-table requests**

In `export table fetches all pages before writing workbook`, keep the tab's `filter`, `filterMode`, and `sort`, but change the expected first request to:

```js
assert.deepEqual(openCall.payload, {
  connectionId: "demo",
  database: "game_db",
  tableName: "player",
  options: {
    page: 1,
    pageSize: 2,
    sort: { columnName: "id", descending: true },
  },
});
```

Change the expected follow-up requests to:

```js
[
  {
    page: 2,
    pageSize: 2,
    sort: { columnName: "id", descending: true },
  },
  {
    page: 3,
    pageSize: 2,
    sort: { columnName: "id", descending: true },
  },
]
```

The existing workbook assertion for row IDs `1` through `5` remains the proof that every returned page is exported.

- [x] **Step 2: Run the focused test and verify it fails for the reported bug**

Run:

```bash
node --test src/workbench/useExport.test.js
```

Expected: FAIL in `export table fetches all pages before writing workbook` because actual request options still contain `filter: { query: "Ada", columns: [], mode: "exact" }`.

- [x] **Step 3: Remove search filtering from export page requests**

Replace `buildExportPageRequest` in `src/workbench/composables/useExport.js` with:

```js
function buildExportPageRequest(tab, page, pageSize) {
  const request = {
    page,
    pageSize,
    sort: tab?.sort || null,
  };
  if (!request.sort) delete request.sort;
  return request;
}
```

This is the smallest source-level fix: both the first and later pages already call this helper.

- [x] **Step 4: Run the focused export tests and verify they pass**

Run:

```bash
node --test src/workbench/useExport.test.js
```

Expected: all tests in the file PASS with no warnings or errors.

- [x] **Step 5: Run the full frontend JavaScript test suite**

Run:

```bash
node --test src/workbench
```

Expected: all frontend JavaScript tests PASS with no failures.

Actual baseline note: the full suite has five unrelated pre-existing failures in
`workbenchShell.test.js` (four stale theme/grid static assertions and one caused
by the existing uncommitted `src-tauri/Cargo.toml` updater dependency change).
The other 58 test files pass.

- [x] **Step 6: Commit the focused bug fix**

```bash
git add src/workbench/useExport.test.js src/workbench/composables/useExport.js docs/superpowers/plans/2026-07-11-full-table-export-search-independence.md
git commit -m "fix(export): ignore table search when exporting"
```
