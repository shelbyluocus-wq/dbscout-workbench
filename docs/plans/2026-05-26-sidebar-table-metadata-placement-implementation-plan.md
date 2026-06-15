# Sidebar Table Metadata Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show table comments inline in the sidebar and move active table source/row count into the existing lower-left bottom status row.

**Architecture:** Reuse the metadata already flowing through `filteredTables` and `activeTab`, so the change remains presentation-only. `WorkbenchSidebar.vue` owns navigation comments, `MySqlWorkbench.vue` fills its existing global bottom row with active-table context, and `usePaneResize.js` publishes live sidebar width while dragging so that context stays aligned.

**Tech Stack:** Vue 3 `<script setup>`, CSS design tokens, Node.js test runner, Vite.

---

### Task 1: Capture The Visible Metadata Contract

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Write failing assertions for table comments and the active-table footer**

Add assertions to the navigation contract that require `wb-table-comment`, the top-level `wb-grid-statusbar` / `wb-sidebar-status`, `activeTab.database`, `activeTab.tableComment`, and `activeTab.totalRows`, and corresponding CSS selectors.

- [ ] **Step 2: Write a failing assertion for toolbar simplification**

Require `DataGrid.vue` not to contain `wb-object-heading`, since table identity and row count now live in the sidebar footer.

- [ ] **Step 3: Run the focused test to verify RED**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because the sidebar does not render the metadata/footer yet and `DataGrid.vue` still contains `wb-object-heading`.

### Task 2: Render Sidebar Table Comments And Active Footer

**Files:**
- Modify: `src/workbench/components/WorkbenchSidebar.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbench.css`

- [ ] **Step 1: Render inline comments**

Inside each `wb-table-item`, wrap the visible label in `wb-table-copy`, apply `has-comment` only where a comment exists, render the existing name as `wb-table-name`, and conditionally render `table.tableComment` as `wb-table-comment`.

- [ ] **Step 2: Render footer state from the existing active tab**

In `MySqlWorkbench.vue`, populate the existing bottom row with a `wb-sidebar-status` segment only when `activeTab` exists. Output `activeTab.database + "." + activeTab.tableName`, a muted ellipsized `activeTab.tableComment` when present, and a formatted `activeTab.totalRows + " 行"` without introducing new state.

- [ ] **Step 3: Style compact, truncated metadata**

Use existing `--wb-*` tokens for one-line truncation, full-width names when no comment is present, muted comment text, a subtle status-segment separator, and tabular row-count alignment.

### Task 3: Remove Duplicate Center Metadata

**Files:**
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/workbench.css`

- [ ] **Step 1: Remove the obsolete toolbar source block**

Delete `tabDisplayName()` and the `wb-object-heading` element from the grid toolbar. Keep the search input and data actions untouched.

- [ ] **Step 2: Remove obsolete style rules**

Delete `.wb-object-heading` styling because its visible responsibility has moved into the sidebar footer.

- [ ] **Step 3: Run the focused test to verify GREEN**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: PASS.

### Task 4: Keep Bottom Metadata Aligned During Sidebar Resize

**Files:**
- Create: `src/workbench/usePaneResize.test.js`
- Modify: `src/workbench/composables/usePaneResize.js`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbench.css`

- [ ] **Step 1: Write a failing resize-state test**

Exercise a sidebar drag and assert that `sidebarStyle.value.width` updates during `mousemove`, before `mouseup`, so external UI segments can share the active boundary.

- [ ] **Step 2: Publish live pane width and remove animated lag**

Update the appropriate pane width ref during pointer movement, avoid imperative writes to the pane's Vue-managed width, and keep `wb-sidebar-status` width unanimated so it never lags behind the live navigation boundary.

- [ ] **Step 3: Verify the focused resize and shell contracts**

Run: `node --test src/workbench/usePaneResize.test.js src/workbench/workbenchShell.test.js`

Expected: PASS.

### Task 5: Verify The Product Surface

**Files:**
- No additional code changes expected.

- [ ] **Step 1: Run frontend tests**

Run: `node --test src/workbench/*.test.js`

Expected: All tests pass.

- [ ] **Step 2: Run frontend build**

Run: `npm run build`

Expected: Vite build exits with code 0.

- [ ] **Step 3: Inspect the UI in the browser**

Open the local app and confirm the single-line table comments truncate cleanly, the active-table summary appears in the pre-existing lower-left status row, and the center toolbar is visually balanced after removing the duplicate heading.
