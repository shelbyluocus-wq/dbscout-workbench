# Column Sort Menu Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace direct column-header click sorting with a hover-revealed arrow menu that applies ascending, descending, or no sort.

**Architecture:** `ColumnSortMenu.vue` encapsulates the arrow button and menu. `DataGrid.vue` renders one menu per column and emits `apply-sort`. `useTableSession.js` adds explicit sort application while preserving `toggleSort()` for compatibility.

**Tech Stack:** Vue 3 `<script setup>`, Node.js test runner, existing CSS tokens in `src/workbench/workbench.css`.

---

### Task 1: Session Sort API

**Files:**
- Modify: `src/workbench/composables/useTableSession.js`
- Test: `src/workbench/useTableSession.test.js`

**Step 1: Write the failing test**

Add tests that call `applySort(tab, "name", "ascending")`, `applySort(tab, "name", "descending")`, and `applySort(tab, "name", "none")`, then assert the backend request receives the matching `request.sort`.

**Step 2: Run test to verify it fails**

Run: `node --test src/workbench/useTableSession.test.js`

Expected: FAIL because `applySort` is not exported.

**Step 3: Write minimal implementation**

Add `applySort(tab, column, direction)`:
- `"ascending"` sets `{ columnName: column, descending: false }`
- `"descending"` sets `{ columnName: column, descending: true }`
- `"none"` clears `tab.sort`
- each path calls `fetchPage(tab, 1)`

**Step 4: Run test to verify it passes**

Run: `node --test src/workbench/useTableSession.test.js`

Expected: PASS.

### Task 2: Header Menu Markup

**Files:**
- Create: `src/workbench/components/ColumnSortMenu.vue`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Test: `src/workbench/workbenchShell.test.js`

**Step 1: Write the failing test**

Add a shell test that asserts:
- `DataGrid.vue` imports and renders `ColumnSortMenu`
- `DataGrid.vue` emits `apply-sort`
- data column `<th>` no longer has `@click="onHeaderClick(...)"`
- `WorkbenchPane.vue` wires `@apply-sort="applyGridSort"`

**Step 2: Run test to verify it fails**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because the component and wiring do not exist yet.

**Step 3: Write minimal implementation**

Create `ColumnSortMenu.vue` with a button, menu state, outside-click/Escape close behavior, and action buttons. Update `DataGrid.vue` to render it inside each column header and emit `apply-sort`. Update `WorkbenchPane.vue` to call `props.applySort`.

**Step 4: Run test to verify it passes**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: PASS.

### Task 3: Styling And Verification

**Files:**
- Modify: `src/workbench/workbench.css`
- Test: `src/workbench/workbenchShell.test.js`

**Step 1: Write the failing test**

Add CSS assertions for `.wb-column-sort-trigger`, `.wb-column-sort-menu`, and hover/focus visibility behavior.

**Step 2: Run test to verify it fails**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because styles are missing.

**Step 3: Write minimal implementation**

Add token-based CSS for the header layout, hover-only arrow visibility, sticky-safe popup, active sort indicator, and compact menu buttons.

**Step 4: Run test to verify it passes**

Run:
- `node --test src/workbench/useTableSession.test.js src/workbench/workbenchShell.test.js`
- `node --test src/workbench`
- `npm run build`

Expected: PASS.
