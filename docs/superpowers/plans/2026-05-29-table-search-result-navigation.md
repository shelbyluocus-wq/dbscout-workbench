# Table Search Result Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Previous and Next buttons to the table search toolbar when matches exist, and use them to jump between matching cells with wraparound.

**Architecture:** Extend the existing `useTableSearch` composable so search matching, active match state, and navigation live in one place. `DataGrid.vue` remains a presentation component that receives a `hasSearchMatches` prop and emits previous/next search events; `MySqlWorkbench.vue` wires those events to the composable and keeps selection/scroll behavior on the existing `selectCellAt()` path.

**Tech Stack:** Vue 3 Composition API, existing table search composable, Node `node:test`, Vite browser verification.

---

## File Structure

- Modify `src/workbench/composables/useTableSearch.js`: export all loaded search matches, expose reactive match availability, track the active match index, and add previous/next navigation functions.
- Modify `src/workbench/useTableSearch.test.js`: cover loaded match collection, next navigation, previous navigation, wraparound, and no-match state.
- Modify `src/workbench/components/DataGrid.vue`: add a `hasSearchMatches` prop, show `上一个` and `下一个` buttons when true, and emit `search-previous` / `search-next`.
- Modify `src/workbench/MySqlWorkbench.vue`: destructure and pass `hasSearchMatches`, wire previous/next events to `goToPreviousSearchMatch` and `goToNextSearchMatch`.
- Modify `src/workbench/workbenchShell.test.js`: add static wiring coverage for the new toolbar controls and event flow.

---

### Task 1: Add search match state and navigation logic

**Files:**
- Modify: `src/workbench/composables/useTableSearch.js`
- Test: `src/workbench/useTableSearch.test.js`

- [ ] **Step 1: Write failing tests for match availability and navigation**

Append these tests to `src/workbench/useTableSearch.test.js`:

```js
test("runTableSearch exposes match availability when loaded matches exist", async () => {
  const tab = makeTab();
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => false,
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");

  assert.equal(searched.hasSearchMatches.value, true);
  assert.deepEqual(searched.searchMatches.value, [{ rowIndex: 1, columnIndex: 2 }]);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 1, columnIndex: 2 }]);
});

test("goToNextSearchMatch moves through matches and wraps to the first match", async () => {
  const tab = makeTab();
  tab.rows.push({ id: "3", name: "Needle hero", note: "third" });
  tab.totalRows = 3;
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => false,
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");
  await searched.goToNextSearchMatch();
  await searched.goToNextSearchMatch();

  assert.deepEqual(selected, [
    { targetTab: tab, rowIndex: 1, columnIndex: 2 },
    { targetTab: tab, rowIndex: 2, columnIndex: 1 },
    { targetTab: tab, rowIndex: 1, columnIndex: 2 },
  ]);
});

test("goToPreviousSearchMatch moves backward through matches and wraps to the last match", async () => {
  const tab = makeTab();
  tab.rows.push({ id: "3", name: "Needle hero", note: "third" });
  tab.totalRows = 3;
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => false,
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");
  await searched.goToPreviousSearchMatch();
  await searched.goToPreviousSearchMatch();

  assert.deepEqual(selected, [
    { targetTab: tab, rowIndex: 1, columnIndex: 2 },
    { targetTab: tab, rowIndex: 2, columnIndex: 1 },
    { targetTab: tab, rowIndex: 1, columnIndex: 2 },
  ]);
});

test("clearing table search hides search navigation", async () => {
  const tab = makeTab();
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => false,
    selectCellAt: () => {},
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");
  await searched.runTableSearch("");

  assert.equal(searched.hasSearchMatches.value, false);
  assert.deepEqual(searched.searchMatches.value, []);
});
```

- [ ] **Step 2: Run the focused search tests to verify they fail**

Run:

```bash
node --test src/workbench/useTableSearch.test.js
```

Expected: FAIL with missing `hasSearchMatches`, `searchMatches`, `goToNextSearchMatch`, and `goToPreviousSearchMatch` exports from `useTableSearch()`.

- [ ] **Step 3: Add all-match collection helper**

In `src/workbench/composables/useTableSearch.js`, add this function after `findFirstSearchMatch()`:

```js
export function findSearchMatches(editState, tab) {
  const query = String(tab?.filter || "").trim();
  if (!tab || !query) return [];
  const columns = Array.isArray(tab.columns) ? tab.columns : [];
  const rows = Array.isArray(tab.rows) ? tab.rows : [];
  const matches = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columnName(columns[columnIndex]);
      const value = displayCellValue(editState || {}, tab, rows[rowIndex], column);
      if (cellMatchesSearch(value, query, tab.filterMode || "fuzzy")) {
        matches.push({ rowIndex, columnIndex });
      }
    }
  }
  return matches;
}
```

- [ ] **Step 4: Add reactive match state inside `useTableSearch()`**

Change the Vue import at the top of `src/workbench/composables/useTableSearch.js` to:

```js
import { computed, ref } from "vue";
```

Inside `useTableSearch()`, after `const searchInputRef = ref(null);`, add:

```js
  const searchMatches = ref([]);
  const activeSearchMatchIndex = ref(-1);
  const hasSearchMatches = computed(() => searchMatches.value.length > 0);
```

Add these helper functions inside `useTableSearch()` before `focusTableSearch()`:

```js
  function resetSearchMatches() {
    searchMatches.value = [];
    activeSearchMatchIndex.value = -1;
  }

  function refreshSearchMatches(tab) {
    searchMatches.value = findSearchMatches(editState, tab);
    if (searchMatches.value.length === 0) {
      activeSearchMatchIndex.value = -1;
      return null;
    }
    if (activeSearchMatchIndex.value < 0 || activeSearchMatchIndex.value >= searchMatches.value.length) {
      activeSearchMatchIndex.value = 0;
    }
    return searchMatches.value[activeSearchMatchIndex.value];
  }

  function selectSearchMatch(tab, matchIndex) {
    if (!tab || searchMatches.value.length === 0) return false;
    const count = searchMatches.value.length;
    activeSearchMatchIndex.value = ((matchIndex % count) + count) % count;
    const match = searchMatches.value[activeSearchMatchIndex.value];
    selectCellAt(tab, match.rowIndex, match.columnIndex);
    if (statusText) statusText.value = `搜索命中第 ${match.rowIndex + 1} 行`;
    return true;
  }
```

- [ ] **Step 5: Update `runTableSearch()` to populate match state**

In `runTableSearch(query)`, replace:

```js
    if (!tab.filter.trim()) return;
```

with:

```js
    resetSearchMatches();
    if (!tab.filter.trim()) return;
```

Replace the loop body that calls `findFirstSearchMatch(editState, tab)` with this version:

```js
      const match = refreshSearchMatches(tab);
      if (match) {
        if (activeTab.value !== tab) return;
        selectSearchMatch(tab, activeSearchMatchIndex.value);
        return;
      }
```

Leave the existing `tab.fullyLoaded`, `loadNextSearchPage(tab)`, stale run, and active-tab checks in place after that replacement.

- [ ] **Step 6: Add next and previous navigation functions**

Add these functions inside `useTableSearch()` after `runTableSearch(query)`:

```js
  async function goToNextSearchMatch() {
    const tab = activeTab.value;
    if (!tab || !String(tab.filter || "").trim()) return;
    refreshSearchMatches(tab);
    if (searchMatches.value.length === 0) {
      await runTableSearch(tab.filter);
      return;
    }
    selectSearchMatch(tab, activeSearchMatchIndex.value + 1);
  }

  async function goToPreviousSearchMatch() {
    const tab = activeTab.value;
    if (!tab || !String(tab.filter || "").trim()) return;
    refreshSearchMatches(tab);
    if (searchMatches.value.length === 0) {
      await runTableSearch(tab.filter);
      return;
    }
    selectSearchMatch(tab, activeSearchMatchIndex.value - 1);
  }
```

- [ ] **Step 7: Return the new state and functions**

In the object returned from `useTableSearch()`, add:

```js
    searchMatches,
    hasSearchMatches,
    goToNextSearchMatch,
    goToPreviousSearchMatch,
```

The returned object should include `searchInputRef`, `searchMatches`, `hasSearchMatches`, `focusTableSearch`, `runTableSearch`, `goToNextSearchMatch`, `goToPreviousSearchMatch`, and `handleTableFindKeydown`.

- [ ] **Step 8: Run the focused search tests**

Run:

```bash
node --test src/workbench/useTableSearch.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit the search navigation logic**

```bash
git add src/workbench/composables/useTableSearch.js src/workbench/useTableSearch.test.js
git commit -m "feat: navigate table search matches"
```

---

### Task 2: Add Previous and Next buttons to the table toolbar

**Files:**
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Test: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Write failing static wiring test**

Append this test to `src/workbench/workbenchShell.test.js`:

```js
test("table search toolbar exposes previous and next result navigation", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const grid = read("./components/DataGrid.vue");

  assert.match(grid, /hasSearchMatches/);
  assert.match(grid, /search-previous/);
  assert.match(grid, /search-next/);
  assert.match(grid, />上一个<\/button>/);
  assert.match(grid, />下一个<\/button>/);
  assert.match(orchestrator, /:has-search-matches="hasSearchMatches"/);
  assert.match(orchestrator, /@search-previous="goToPreviousSearchMatch"/);
  assert.match(orchestrator, /@search-next="goToNextSearchMatch"/);
});
```

- [ ] **Step 2: Run the static test to verify it fails**

Run:

```bash
node --test src/workbench/workbenchShell.test.js
```

Expected: FAIL because the DataGrid prop, emits, buttons, and orchestrator wiring are not present.

- [ ] **Step 3: Add the presentation prop and emits in `DataGrid.vue`**

In `src/workbench/components/DataGrid.vue`, add this prop after `highlightCell`:

```js
  hasSearchMatches: { type: Boolean, default: false },
```

In the `defineEmits([...])` array, add these entries after `'search-input'`:

```js
  'search-previous',
  'search-next',
```

- [ ] **Step 4: Render navigation buttons in `DataGrid.vue`**

In the toolbar template, after the exact/fuzzy mode button, add:

```vue
      <button
        v-if="hasSearchMatches"
        class="wb-search-nav-btn"
        type="button"
        @click="emit('search-previous')"
      >上一个</button>
      <button
        v-if="hasSearchMatches"
        class="wb-search-nav-btn"
        type="button"
        @click="emit('search-next')"
      >下一个</button>
```

Keep the existing export/import buttons after these search navigation buttons.

- [ ] **Step 5: Wire the composable exports in `MySqlWorkbench.vue`**

In `src/workbench/MySqlWorkbench.vue`, change the `useTableSearch()` destructuring from:

```js
const {
  searchInputRef,
  runTableSearch,
  handleTableFindKeydown,
} = useTableSearch(activeTab, {
```

to:

```js
const {
  searchInputRef,
  hasSearchMatches,
  runTableSearch,
  goToNextSearchMatch,
  goToPreviousSearchMatch,
  handleTableFindKeydown,
} = useTableSearch(activeTab, {
```

- [ ] **Step 6: Pass the prop and events to `DataGrid`**

In the `DataGrid` usage inside `src/workbench/MySqlWorkbench.vue`, add this prop after `:highlight-cell="highlightCell"`:

```vue
          :has-search-matches="hasSearchMatches"
```

Add these events after `@search-input="runTableSearch"`:

```vue
          @search-previous="goToPreviousSearchMatch"
          @search-next="goToNextSearchMatch"
```

- [ ] **Step 7: Run static wiring tests**

Run:

```bash
node --test src/workbench/workbenchShell.test.js
```

Expected: PASS.

- [ ] **Step 8: Run search and shell tests together**

Run:

```bash
node --test src/workbench/useTableSearch.test.js src/workbench/workbenchShell.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit the toolbar wiring**

```bash
git add src/workbench/components/DataGrid.vue src/workbench/MySqlWorkbench.vue src/workbench/workbenchShell.test.js
git commit -m "feat: add table search navigation controls"
```

---

### Task 3: Verify in browser and full test suite

**Files:**
- No source changes unless verification finds defects.

- [ ] **Step 1: Run all JS tests**

Run:

```bash
node --test src/workbench
```

Expected: PASS.

- [ ] **Step 2: Run the frontend build**

Run:

```bash
npm run build
```

Expected: PASS and Vite reports a successful production build.

- [ ] **Step 3: Start the frontend app**

Run:

```bash
npm run dev
```

Expected: Vite starts on the configured local dev URL without compile errors.

- [ ] **Step 4: Manually verify search navigation in the browser**

Use the running app and verify:

1. Open any table with visible rows.
2. Type a search term with at least two matching cells.
3. Confirm `上一个` and `下一个` appear next to the search mode button.
4. Click `下一个` repeatedly and confirm selection moves through matching cells and wraps from the last match to the first.
5. Click `上一个` repeatedly and confirm selection moves backward through matching cells and wraps from the first match to the last.
6. Clear the search input and confirm the navigation buttons disappear.
7. Search for text with no matches and confirm the navigation buttons stay hidden.

- [ ] **Step 5: Fix any verification defect with a regression test first**

If a verification item fails, add the smallest failing `node:test` assertion to `src/workbench/useTableSearch.test.js` or `src/workbench/workbenchShell.test.js`, then fix only the code needed for that assertion and rerun the relevant command.

- [ ] **Step 6: Commit verification fixes if source files changed**

If Step 5 changed files:

```bash
git add src/workbench/composables/useTableSearch.js src/workbench/useTableSearch.test.js src/workbench/components/DataGrid.vue src/workbench/MySqlWorkbench.vue src/workbench/workbenchShell.test.js
git commit -m "fix: stabilize table search navigation"
```

If Step 5 changed nothing, do not create a commit.

---

## Self-Review

- Spec coverage: Task 1 implements match tracking, next/previous navigation, and wraparound; Task 2 implements conditional toolbar buttons and event wiring; Task 3 covers tests, build, and browser verification.
- Placeholder scan: no TBD, TODO, placeholder, or deferred implementation instructions remain.
- Type consistency: `searchMatches`, `hasSearchMatches`, `goToNextSearchMatch()`, `goToPreviousSearchMatch()`, `search-previous`, and `search-next` are defined before use and use the same names in tests, composable, component, and orchestrator.
