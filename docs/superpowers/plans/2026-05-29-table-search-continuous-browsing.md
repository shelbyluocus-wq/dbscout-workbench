# Table Search Continuous Browsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make table browsing continuous beyond the first 1000 rows, make Ctrl+F focus the table search box, search all rows without filtering the grid, highlight matches, jump to the first match, and thicken scrollbars.

**Architecture:** Keep the existing paged backend contract and virtualized grid, but append fetched pages into `tab.rows` as the user scrolls. Split in-table search into a small composable that scans loaded rows, asks the table session to load more rows when needed, and selects the first matching cell without replacing visible rows.

**Tech Stack:** Vue 3 Composition API, Node `node:test`, existing Tauri invoke bridge and mock backend.

---

## File Structure

- Modify `src/workbench/workspaceState.js`: add append-page state fields and an `appendTabPage()` helper next to `replaceTabPage()`.
- Modify `src/workbench/composables/useTableSession.js`: expose `loadNextPage(tab)` and support explicit append vs replacement loading.
- Create `src/workbench/composables/useTableSearch.js`: owns search query scanning, first-match selection, Ctrl+F focus target, and loading more rows during search.
- Modify `src/workbench/MySqlWorkbench.vue`: wire the new search composable, Ctrl+F handler, and near-bottom continuous load trigger.
- Modify `src/workbench/components/DataGrid.vue`: expose/search input ref and emit search-query updates instead of backend filter-page events.
- Modify `src/workbench/utils/cellDisplay.js`: highlight from `tab.searchQuery` while preserving `tab.filter` compatibility until all callers are moved.
- Modify `src/workbench/workbench.css`: increase scrollbar token and use `scrollbar-width: auto`.
- Modify tests: `src/workbench/useTableSession.test.js`, `src/workbench/workbenchShell.test.js`, and add `src/workbench/useTableSearch.test.js`.

---

### Task 1: Append fetched table pages

**Files:**
- Modify: `src/workbench/workspaceState.js`
- Modify: `src/workbench/composables/useTableSession.js`
- Test: `src/workbench/useTableSession.test.js`

- [ ] **Step 1: Write the failing append-page tests**

Add these imports and tests to `src/workbench/useTableSession.test.js`:

```js
import { appendTabPage } from "./workspaceState.js";

test("appendTabPage appends rows and preserves existing columns when later pages omit columns", () => {
  const workspace = createWorkspaceState();
  workspace.tabs = [{
    id: "tab-1",
    sessionId: "hero-session",
    columns: [{ column_name: "id" }],
    rows: [{ id: 1 }],
    totalRows: 3,
    page: 1,
    pageSize: 1000,
    loading: false,
    loadingMore: false,
  }];

  appendTabPage(workspace, "tab-1", {
    sessionId: "hero-session",
    rows: [{ id: 2 }, { id: 3 }],
    totalRows: 3,
    page: 2,
    pageSize: 1000,
  });

  assert.deepEqual(workspace.tabs[0].rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(workspace.tabs[0].columns, [{ column_name: "id" }]);
  assert.equal(workspace.tabs[0].page, 2);
  assert.equal(workspace.tabs[0].loadingMore, false);
});

test("loadNextPage appends the next backend page and does not send a filter", async () => {
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  workspace.tabs = [{
    id: "tab-1",
    connectionId: "mysql-1",
    database: "game",
    tableName: "hero",
    sessionId: "hero-session",
    page: 1,
    pageSize: 1000,
    rows: [{ id: 1 }],
    columns: [{ column_name: "id" }],
    totalRows: 2,
    filter: "needle",
    filterMode: "fuzzy",
    sort: null,
    loading: false,
    loadingMore: false,
  }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return { sessionId: "hero-session", rows: [{ id: 2 }], totalRows: 2, page: 2, pageSize: 1000 };
  };
  const session = useTableSession(workspace, invoke, { busy: ref(false), statusText: ref("") });

  await session.loadNextPage(workspace.tabs[0]);

  assert.equal(calls[0].payload.request.page, 2);
  assert.equal(calls[0].payload.request.filter, null);
  assert.deepEqual(workspace.tabs[0].rows, [{ id: 1 }, { id: 2 }]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test src/workbench/useTableSession.test.js`

Expected: FAIL because `appendTabPage` is not exported and `loadNextPage` is not a function.

- [ ] **Step 3: Add append state and helper**

In `src/workbench/workspaceState.js`, add fields to `createEmptyTab()`:

```js
    loadingMore: false,
    fullyLoaded: false,
```

Add this function after `replaceTabPage()`:

```js
export function appendTabPage(state, tabId, pageData = {}) {
  const tab = state?.tabs?.find((item) => item.id === tabId);
  if (!tab) return null;
  tab.sessionId = String(pageData.sessionId ?? tab.sessionId ?? "");
  if (Array.isArray(pageData.columns) && pageData.columns.length > 0) tab.columns = pageData.columns;
  if (Array.isArray(pageData.rows) && pageData.rows.length > 0) tab.rows.push(...pageData.rows);
  tab.totalRows = Math.max(0, Math.floor(Number(pageData.totalRows) || tab.totalRows || 0));
  tab.page = Math.max(1, Math.floor(Number(pageData.page) || tab.page || 1));
  tab.pageSize = Math.max(1, Math.floor(Number(pageData.pageSize) || tab.pageSize || DEFAULT_PAGE_SIZE));
  tab.loadingMore = false;
  tab.fullyLoaded = tab.totalRows > 0 && tab.rows.length >= tab.totalRows;
  return tab;
}
```

In `replaceTabPage()`, add:

```js
  tab.loadingMore = false;
  tab.fullyLoaded = tab.totalRows > 0 && tab.rows.length >= tab.totalRows;
```

- [ ] **Step 4: Add next-page loading**

In `src/workbench/composables/useTableSession.js`, change the import to:

```js
import { openTableTab, replaceTabPage, appendTabPage } from "../workspaceState.js";
```

Add this helper inside `useTableSession()` before `fetchPage()`:

```js
function buildPageRequest(tab, page, { includeFilter = false } = {}) {
  return {
    page,
    pageSize: REQUEST_PAGE_SIZE,
    filter: includeFilter && tab.filter
      ? {
          query: tab.filter,
          columns: [],
          mode: tab.filterMode || "fuzzy",
        }
      : null,
    sort: tab.sort || null,
  };
}
```

Change `fetchPage()` request construction to:

```js
          request: buildPageRequest(tab, page),
```

Add this function before `toggleSort()`:

```js
async function loadNextPage(tab) {
  if (!tab?.sessionId || tab.loadingMore || tab.fullyLoaded) return false;
  if (tab.totalRows > 0 && tab.rows.length >= tab.totalRows) {
    tab.fullyLoaded = true;
    return false;
  }
  const requestToken = beginTabRequest(tab.id);
  tab.loadingMore = true;
  try {
    const nextPage = Math.floor((tab.rows.length || 0) / REQUEST_PAGE_SIZE) + 1;
    const payload = await invokeWorkbench("fetch_table_page", {
      sessionId: tab.sessionId,
      request: buildPageRequest(tab, nextPage),
    });
    if (!isCurrentTabRequest(tab.id, requestToken)) return false;
    appendTabPage(workspace, tab.id, payload);
    tab.primaryKeys = payload.primaryKeys || tab.primaryKeys || [];
    statusText.value = `${tab.database ? `${tab.database}.` : ""}${tab.tableName}：已加载 ${tab.rows.length}/${payload.totalRows} 行`;
    return Array.isArray(payload.rows) && payload.rows.length > 0;
  } catch (error) {
    if (isCurrentTabRequest(tab.id, requestToken)) {
      tab.loadingMore = false;
      statusText.value = `继续读取失败：${String(error)}`;
    }
    return false;
  }
}
```

Return it:

```js
    loadNextPage,
```

- [ ] **Step 5: Run tests**

Run: `node --test src/workbench/useTableSession.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workbench/workspaceState.js src/workbench/composables/useTableSession.js src/workbench/useTableSession.test.js
git commit -m "feat: append table pages for continuous browsing"
```

---

### Task 2: Add in-table search scanner

**Files:**
- Create: `src/workbench/composables/useTableSearch.js`
- Test: `src/workbench/useTableSearch.test.js`

- [ ] **Step 1: Write failing search tests**

Create `src/workbench/useTableSearch.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { computed, ref } from "vue";

import { useTableSearch, cellMatchesSearch } from "./composables/useTableSearch.js";

function makeTab() {
  return {
    id: "tab-1",
    tableName: "hero",
    rows: [
      { id: "1", name: "Alpha", note: "first" },
      { id: "2", name: "Beta", note: "Needle value" },
    ],
    columns: [{ column_name: "id" }, { column_name: "name" }, { column_name: "note" }],
    primaryKeys: ["id"],
    filter: "",
    filterMode: "fuzzy",
    totalRows: 2,
    fullyLoaded: true,
  };
}

test("cellMatchesSearch supports fuzzy and exact modes", () => {
  assert.equal(cellMatchesSearch("Needle value", "needle", "fuzzy"), true);
  assert.equal(cellMatchesSearch("Needle value", "needle", "exact"), false);
  assert.equal(cellMatchesSearch("Needle value", "Needle value", "exact"), true);
});

test("runTableSearch selects the first matching loaded cell without removing rows", async () => {
  const tab = makeTab();
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => false,
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");

  assert.equal(tab.filter, "needle");
  assert.equal(tab.rows.length, 2);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 1, columnIndex: 2 }]);
});

test("runTableSearch loads more rows until it finds the first table match", async () => {
  const tab = makeTab();
  tab.rows = [{ id: "1", name: "Alpha", note: "first" }];
  tab.totalRows = 2;
  tab.fullyLoaded = false;
  let loads = 0;
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => {
      loads++;
      tab.rows.push({ id: "2", name: "Beta", note: "Needle value" });
      tab.fullyLoaded = true;
      return true;
    },
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");

  assert.equal(loads, 1);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 1, columnIndex: 2 }]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test src/workbench/useTableSearch.test.js`

Expected: FAIL because `useTableSearch.js` does not exist.

- [ ] **Step 3: Implement the search composable**

Create `src/workbench/composables/useTableSearch.js`:

```js
import { ref } from "vue";
import { columnName } from "../utils/normalize.js";
import { displayCellValue } from "../utils/cellDisplay.js";

export function cellMatchesSearch(value, query, mode = "fuzzy") {
  const needle = String(query ?? "").trim();
  if (!needle) return false;
  const text = String(value ?? "");
  if (mode === "exact") return text === needle;
  return text.toLowerCase().includes(needle.toLowerCase());
}

export function findFirstSearchMatch(editState, tab) {
  const query = String(tab?.filter || "").trim();
  if (!tab || !query) return null;
  const columns = Array.isArray(tab.columns) ? tab.columns : [];
  const rows = Array.isArray(tab.rows) ? tab.rows : [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columnName(columns[columnIndex]);
      const value = displayCellValue(editState || {}, tab, rows[rowIndex], column);
      if (cellMatchesSearch(value, query, tab.filterMode || "fuzzy")) return { rowIndex, columnIndex };
    }
  }
  return null;
}

export function useTableSearch(activeTab, { editState = {}, loadNextPage, selectCellAt, statusText }) {
  const searchInputRef = ref(null);
  let searchRunId = 0;

  function focusTableSearch() {
    searchInputRef.value?.focus();
    searchInputRef.value?.select?.();
  }

  async function runTableSearch(query) {
    const tab = activeTab.value;
    if (!tab) return;
    tab.filter = String(query ?? "");
    const runId = ++searchRunId;
    if (!tab.filter.trim()) return;

    while (runId === searchRunId) {
      const match = findFirstSearchMatch(editState, tab);
      if (match) {
        selectCellAt(tab, match.rowIndex, match.columnIndex);
        if (statusText) statusText.value = `搜索命中第 ${match.rowIndex + 1} 行`;
        return;
      }
      if (tab.fullyLoaded) {
        if (statusText) statusText.value = "当前表未找到匹配内容";
        return;
      }
      const loaded = await loadNextPage(tab);
      if (!loaded) return;
    }
  }

  function handleTableFindKeydown(event) {
    const key = String(event.key || "").toLowerCase();
    if (!(event.ctrlKey || event.metaKey) || key !== "f") return false;
    const tab = activeTab.value;
    if (!tab) return false;
    event.preventDefault();
    event.stopPropagation();
    focusTableSearch();
    return true;
  }

  return {
    searchInputRef,
    focusTableSearch,
    runTableSearch,
    handleTableFindKeydown,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test src/workbench/useTableSearch.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workbench/composables/useTableSearch.js src/workbench/useTableSearch.test.js
git commit -m "feat: add in-table search scanner"
```

---

### Task 3: Wire search and continuous loading into the UI

**Files:**
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Write failing static wiring tests**

Add to `src/workbench/workbenchShell.test.js`:

```js
test("table search uses Ctrl+F and input scanning instead of backend filtering", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dataGrid = read("./components/DataGrid.vue");

  assert.match(orchestrator, /import\s+\{\s*useTableSearch\s*\}\s+from\s+["']\.\/composables\/useTableSearch\.js["']/);
  assert.match(orchestrator, /handleTableFindKeydown\(event\)/);
  assert.match(orchestrator, /@keydown="handleWorkbenchKeydown"/);
  assert.match(orchestrator, /@search-input="runTableSearch"/);
  assert.match(orchestrator, /@search-ready="setSearchInputElement"/);
  assert.match(orchestrator, /loadNextPage\(tab\)/);
  assert.match(orchestrator, /maybeLoadMoreRows\(event\)/);
  assert.doesNotMatch(dataGrid, /@keydown\.enter\.prevent="emit\('filter-page'/);
  assert.match(dataGrid, /search-ready/);
  assert.match(dataGrid, /search-input/);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because the wiring is absent.

- [ ] **Step 3: Update `DataGrid.vue` search events**

In `src/workbench/components/DataGrid.vue`, add a ref near `gridWrapRef`:

```js
const searchInputRef = ref(null);
```

Change `defineEmits` entries by replacing `'filter-page'` with:

```js
  'search-ready',
  'search-input',
```

In `onMounted()`, emit the input ref:

```js
  emit('search-ready', searchInputRef.value);
```

Replace the toolbar search input and mode button with:

```vue
<input
  ref="searchInputRef"
  v-model="tab.filter"
  :placeholder="'搜索当前表（' + (tab.filterMode === 'exact' ? '精确' : '模糊') + '）'"
  @input="emit('search-input', tab.filter)"
/>
<button
  class="wb-filter-mode-btn"
  @click="tab.filterMode = tab.filterMode === 'exact' ? 'fuzzy' : 'exact'; if (tab.filter) emit('search-input', tab.filter)"
>{{ tab.filterMode === 'exact' ? '精确' : '模糊' }}</button>
```

- [ ] **Step 4: Update `MySqlWorkbench.vue` imports and session destructuring**

Add import:

```js
import { useTableSearch } from "./composables/useTableSearch.js";
```

Change table session destructuring:

```js
const { openTable, fetchPage, loadNextPage, toggleSort } = useTableSession(
```

- [ ] **Step 5: Add search selection helpers in `MySqlWorkbench.vue`**

Add after `toggleAllGridRows(tab)`:

```js
function selectCellAt(tab, rowIndex, columnIndex) {
  const row = tab?.rows?.[rowIndex];
  const column = activeColumns.value[columnIndex];
  if (!row || !column) return;
  clearRowSelection(tab);
  clearSelection();
  selectCell(tab, row, normalizeTableName({ table_name: column.column_name || column.columnName || column }), rowIndex, columnIndex);
}
```

If the column expression is awkward after implementation, use the existing imported `columnName` utility instead by adding it to the normalize import and calling `columnName(column)`.

- [ ] **Step 6: Wire `useTableSearch()` in `MySqlWorkbench.vue`**

Add after the editor destructuring block:

```js
const {
  searchInputRef,
  runTableSearch,
  handleTableFindKeydown,
} = useTableSearch(activeTab, {
  editState,
  loadNextPage,
  selectCellAt,
  statusText: conn.statusText,
});

function setSearchInputElement(element) {
  searchInputRef.value = element;
}

function handleWorkbenchKeydown(event) {
  if (handleTableFindKeydown(event)) return;
  handleUndoKeydown(event);
}
```

Change the root handler:

```vue
@keydown="handleWorkbenchKeydown"
```

- [ ] **Step 7: Load more rows near the bottom**

Add this function near `filterPage()`:

```js
function maybeLoadMoreRows(event) {
  const tab = activeTab.value;
  const target = event?.target;
  if (!tab || !target || tab.loadingMore || tab.fullyLoaded) return;
  const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
  if (remaining < GRID_ROW_HEIGHT * 20) loadNextPage(tab);
}
```

Change the DataGrid scroll handler in the template:

```vue
@scroll="onGridScroll($event); maybeLoadMoreRows($event)"
```

Add DataGrid search wiring:

```vue
@search-ready="setSearchInputElement"
@search-input="runTableSearch"
```

Remove the old `@filter-page="filterPage"` binding if it is no longer emitted.

- [ ] **Step 8: Run tests**

Run: `node --test src/workbench/workbenchShell.test.js src/workbench/useTableSearch.test.js src/workbench/useTableSession.test.js`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/workbench/MySqlWorkbench.vue src/workbench/components/DataGrid.vue src/workbench/workbenchShell.test.js
git commit -m "feat: wire continuous table search"
```

---

### Task 4: Make highlighting use in-table search only

**Files:**
- Modify: `src/workbench/utils/cellDisplay.js`
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Add a static regression test**

Add to `src/workbench/workbenchShell.test.js`:

```js
test("cell highlighting reads the in-table search query without requiring backend filtering", () => {
  const display = read("./utils/cellDisplay.js");

  assert.match(display, /const query = \(tab\?\.searchQuery \?\? tab\?\.filter \?\? ""\)\.trim\(\)/);
  assert.match(display, /tab\.filterMode \|\| "fuzzy"/);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because `highlightCell()` reads only `tab.filter`.

- [ ] **Step 3: Update highlight query source**

In `src/workbench/utils/cellDisplay.js`, replace:

```js
  const query = tab?.filter?.trim();
```

with:

```js
  const query = (tab?.searchQuery ?? tab?.filter ?? "").trim();
```

In `src/workbench/composables/useTableSearch.js`, after setting `tab.filter`, also set:

```js
    tab.searchQuery = String(query ?? "");
```

- [ ] **Step 4: Run tests**

Run: `node --test src/workbench/workbenchShell.test.js src/workbench/useTableSearch.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workbench/utils/cellDisplay.js src/workbench/composables/useTableSearch.js src/workbench/workbenchShell.test.js
git commit -m "fix: highlight table search without filtering rows"
```

---

### Task 5: Thicken scrollbars

**Files:**
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Update scrollbar test expectation**

In `src/workbench/workbenchShell.test.js`, replace test name and expectations:

```js
test("scrollable panes keep thicker native interactive scrollbars", () => {
  const allComponents = readAllComponents();
  const orchestrator = read("./MySqlWorkbench.vue");
  const styles = read("./workbench.css");

  assert.doesNotMatch(allComponents, /wb-grid-scroll-indicator/);
  assert.match(styles, /--wb-scrollbar-size:\s*10px/);
  assert.match(styles, /\.mysql-workbench \*\s*\{[\s\S]*scrollbar-width:\s*auto/);
  assert.match(styles, /\.mysql-workbench \*::\-webkit-scrollbar/);
  assert.doesNotMatch(styles, /\.wb-scrollbar-indicator|\.wb-hide-scrollbar/);
  assert.doesNotMatch(orchestrator, /usePersistentScrollbars/);
  assert.doesNotMatch(styles, /\.wb-grid-wrap\s*\{[\s\S]*scrollbar-width:\s*none/);
  assert.doesNotMatch(styles, /\.wb-grid-wrap::-webkit-scrollbar\s*\{[\s\S]*display:\s*none/);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because CSS still uses `6px` and `thin`.

- [ ] **Step 3: Update CSS tokens**

In `src/workbench/workbench.css`, replace:

```css
  --wb-scrollbar-size: 6px;
```

with:

```css
  --wb-scrollbar-size: 10px;
```

Replace:

```css
  scrollbar-width: thin;
```

with:

```css
  scrollbar-width: auto;
```

- [ ] **Step 4: Run test**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workbench/workbench.css src/workbench/workbenchShell.test.js
git commit -m "style: thicken workbench scrollbars"
```

---

### Task 6: Full verification

**Files:**
- No source changes unless verification finds defects.

- [ ] **Step 1: Run all JS tests**

Run: `node --test src/workbench`

Expected: PASS.

- [ ] **Step 2: Run frontend build**

Run: `npm run build`

Expected: PASS and Vite reports a built `dist/` output.

- [ ] **Step 3: Manual browser verification**

Run: `npm run dev`

Open the Vite URL in Chrome DevTools MCP or the browser.

Verify:

1. Open a table with more than 1000 rows.
2. Scroll downward past the first 1000 loaded rows; rows continue loading.
3. Press Ctrl+F with the table active; browser find does not open and the table search input gets focus.
4. Type a value that appears in a later row; non-matching rows remain visible, matching cells are highlighted, and the first match is selected/scrolled into view.
5. Toggle fuzzy/exact mode; highlighting and first-match selection update.
6. Sort a column; rows refresh in the sorted order and continuous loading still works.
7. Scrollbars are visibly easier to grab.

- [ ] **Step 4: Fix defects found during manual verification**

If any verification item fails, add a focused regression test first, then fix the smallest amount of code needed, then rerun the failed verification.

- [ ] **Step 5: Commit verification fixes if any**

If Step 4 changed files:

```bash
git add <changed-files>
git commit -m "fix: stabilize continuous table search"
```

If Step 4 changed nothing, do not create a commit.

---

## Self-Review

- Spec coverage: continuous browsing is covered by Tasks 1 and 3; Ctrl+F and table search are covered by Tasks 2 and 3; highlighting without filtering is covered by Task 4; thicker scrollbars are covered by Task 5; verification is covered by Task 6.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: `loadNextPage(tab)`, `runTableSearch(query)`, `searchInputRef`, `appendTabPage(state, tabId, pageData)`, and `cellMatchesSearch(value, query, mode)` are defined before use.
