# Context Menu Surface Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show only the right-click actions that apply to the sidebar table, inspector, or data grid surface.

**Architecture:** Add an explicit `surface` value to shared context-menu state. Opening handlers assign the surface, while the menu component independently gates freeze actions and table-management actions from that value.

**Tech Stack:** Vue 3 Composition API, Node.js `node:test`

---

### Task 1: Capture the opening surface

**Files:**
- Modify: `src/workbench/useContextMenu.test.js`
- Modify: `src/workbench/composables/useContextMenu.js`

- [x] **Step 1: Write failing state tests**

Add assertions that `openContextMenu(event, table, { surface: "sidebar" })` stores `sidebar`, that an inspector opening stores `inspector`, and that `openRowContextMenu` stores `grid`.

- [x] **Step 2: Verify the tests fail**

Run: `node --test src/workbench/useContextMenu.test.js`

Expected: FAIL because `contextMenu.surface` is not defined.

- [x] **Step 3: Implement surface state**

Initialize `contextMenu.surface` to `general`, accept `surface` in `openContextMenu` options, and set row context menus to `grid`.

- [x] **Step 4: Verify the state tests pass**

Run: `node --test src/workbench/useContextMenu.test.js`

Expected: PASS.

### Task 2: Gate menu groups by surface

**Files:**
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `src/workbench/components/ContextMenu.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`

- [x] **Step 1: Write failing wiring and rendering tests**

Assert that sidebar openings use `surface: "sidebar"`, inspector openings use a dedicated handler with `surface: "inspector"`, grid openings use `surface: "grid"`, and the menu gates freeze and table-management groups independently.

- [x] **Step 2: Verify the tests fail**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: FAIL because surface-aware wiring and component gates are absent.

- [x] **Step 3: Implement surface-aware menu rendering**

Pass `contextMenu.surface` into `ContextMenu`. Show freeze actions only for `grid` and `grid-row`; show table-management actions for table-scoped surfaces except `inspector`; retain refresh for every surface.

- [x] **Step 4: Verify focused behavior**

Run: `node --test src/workbench/useContextMenu.test.js src/workbench/workbenchShell.test.js`

Expected: PASS.

- [x] **Step 5: Verify the production build and browser behavior**

Run: `npm run build`

Expected: Vite build completes successfully. Then open the mock app and confirm sidebar table menus have no freeze actions, inspector menus show only refresh, and grid menus retain freeze actions.
