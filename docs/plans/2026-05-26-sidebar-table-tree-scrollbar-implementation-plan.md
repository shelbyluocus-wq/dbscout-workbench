# Sidebar Table Tree And Scrollbar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the split sidebar browser with a compact connection/database/table tree and restore real interactive scrollbars.

**Architecture:** Keep existing connection and table-session state unchanged, and alter only how the selected source is rendered in `WorkbenchSidebar.vue`. Remove the root-level custom scrollbar overlay registration so scrollable components rely on styled native scrollbars.

**Tech Stack:** Vue 3 `<script setup>`, CSS design tokens, Node.js test runner, Vite.

---

### Task 1: Capture The Navigation And Scrollbar Contract

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`

**Step 1: Write the failing tests**

Require a single `wb-source-tree` structure with connection, database, and table rows; reject the internal split divider; and require that `MySqlWorkbench.vue` does not install `usePersistentScrollbars`.

**Step 2: Run the tests to verify they fail**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because the current sidebar contains `wb-browser-split-divider` and the orchestrator still calls `usePersistentScrollbars`.

### Task 2: Render A Single Table Navigation Tree

**Files:**
- Modify: `src/workbench/components/WorkbenchSidebar.vue`
- Modify: `src/workbench/workbench.css`

**Step 1: Implement the minimal tree markup**

Remove internal resize state and the two-column layout. Render a header followed by one scrollable tree containing root connection rows, nested database rows, a compact table-filter input under the active database, and nested table buttons.

**Step 2: Implement the restrained styling**

Use `--wb-*` tokens to create compact single-line rows, indentation guides, quiet active states, and small icons. Remove CSS for the browser split divider and table-column layout.

**Step 3: Run the focused test**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: Remaining failure only relates to the scrollbar overlay until Task 3 is complete.

### Task 3: Restore Native Scrollbar Interaction

**Files:**
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbench.css`

**Step 1: Remove overlay registration**

Remove the `usePersistentScrollbars` import, `workbenchRef` dependency for that composable, and its invocation.

**Step 2: Remove obsolete overlay styles**

Delete `.wb-scrollbar-indicator` and `.wb-hide-scrollbar` rules. Retain thin native WebKit/Firefox scrollbar styling based on `--wb-scrollbar-*`.

**Step 3: Run the focused test**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: PASS.

### Task 4: Verify The Finished Behavior

**Files:**
- No additional code changes expected.

**Step 1: Run frontend tests**

Run: `node --test src/workbench/*.test.js`

Expected: All tests pass.

**Step 2: Run frontend build**

Run: `npm run build`

Expected: Vite build exits with code 0.

**Step 3: Verify in the browser**

Run the Vite app, inspect the left pane with sufficient database/table rows, and confirm tree density, selection behavior, track click, and thumb dragging without visual residue.
