# Database Homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished Navicat-like database homepage where users manage the current database's tables from the main workspace.

**Architecture:** Add a first-class `home` tab kind to the existing pane/tab system, render a dedicated database-home view inside that tab, and route table-object operations through existing workbench flows plus a new `drop_tables` backend command. Homepage list behavior lives in `useDatabaseHome.js`; Rust and mock backends keep the same command contract.

**Tech Stack:** Vue 3 Composition API, existing workbench CSS tokens, Node `node:test`, Tauri 2 Rust commands, sqlx MySQL, browser mock backend.

## Global Constraints

- The homepage is a fixed per-database workbench entry, not a one-time empty state.
- The homepage appears in the existing tab area and stays returnable after data/design tabs are opened.
- Single click selects; Ctrl/Shift click multi-selects; double-click opens the table; Enter opens selected tables.
- F2 starts inline rename only when exactly one table is selected.
- Ctrl+C copies table object references to an app-internal clipboard, not plain text.
- Ctrl+V or blank-area paste copies clipboard tables into the current database.
- Duplicate paste names start at `table_copy1`, then `table_copy2`, and continue upward.
- Delete table is a danger flow with confirmation, real backend drop, homepage/sidebar refresh, and related tab closure.
- Read-only connections, including ClickHouse, allow browse/search/open only and disable copy, paste, rename, and delete.
- Homepage search only filters table name/comment; it does not trigger full database value search.
- Sorting supports name asc, name desc, comment first, recently opened first, and original order.
- Use existing `--wb-*` CSS custom properties and avoid inline styling.
- For visible workbench changes, run automated tests plus browser/runtime verification.

---

### Task 1: Workspace Home Tab Model

**Files:**
- Modify: `src/workbench/workspaceState.js`
- Test: `src/workbench/workspaceState.test.js`

**Interfaces:**
- Produces: `openDatabaseHomeTab(state, { connectionId, database, readOnly }, options) -> tab | null`
- Produces: `closeTableObjectTabs(state, { connectionId, database, tableNames }) -> tab[]`

- [ ] Write tests for one home tab per database and pane, separate homes across panes, and closing deleted table tabs while preserving home.
- [ ] Run `node --test src/workbench/workspaceState.test.js`; expected failure is missing exports.
- [ ] Implement `home` tab kind, database identity, home tab factory, open/reuse logic, and related table-tab closure.
- [ ] Re-run `node --test src/workbench/workspaceState.test.js`; expected pass.
- [ ] Commit `feat(workbench): add database home tab model`.

### Task 2: Backend Table Drop And Copy Naming

**Files:**
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces command `drop_tables` with request `{ connectionId, database, tables }` and response `{ dropped, failed }`.
- Produces `_copy1` first duplicate naming for Rust `copy_tables`.

- [ ] Add Rust tests proving copy-name helpers start at `_copy1` and skip `_copy1/_copy2`.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml resolve_copy_table_name`; expected failure under current `_copy` behavior.
- [ ] Add `DropTablesRequest`, `DropTablesResult`, `DropTablesResponse`, register `drop_tables`, implement MySQL drop and read-only rejection.
- [ ] Re-run focused Rust tests; expected pass.
- [ ] Commit `feat(workbench): add table drop command`.

### Task 3: Mock Backend Contract

**Files:**
- Modify: `src/workbench/mock/mockBackend.js`
- Test: `src/workbench/mockBackend.test.js`

**Interfaces:**
- Produces mock `drop_tables` response matching Rust and `_copy1` duplicate naming.

- [ ] Add tests for mock `copy_tables` `_copy1` naming and `drop_tables` removing table/schema/rows.
- [ ] Run `node --test src/workbench/mockBackend.test.js`; expected failure.
- [ ] Implement mock copy naming and drop behavior.
- [ ] Re-run mock tests; expected pass.
- [ ] Commit `feat(workbench): support mock table drops`.

### Task 4: Database Home Composable

**Files:**
- Create: `src/workbench/composables/useDatabaseHome.js`
- Test: `src/workbench/useDatabaseHome.test.js`

**Interfaces:**
- Produces `createDatabaseHomeController(options)` with table filtering, sorting, selection, rename validation, clipboard, and write-action flags.

- [ ] Add tests for sort modes, search, single/multi/range selection, F2 rename availability, clipboard payload, and read-only write disabling.
- [ ] Run `node --test src/workbench/useDatabaseHome.test.js`; expected failure because file is missing.
- [ ] Implement composable with `HOME_SORT_MODES`.
- [ ] Re-run composable tests; expected pass.
- [ ] Commit `feat(workbench): add database homepage state controller`.

### Task 5: Homepage Components And Styling

**Files:**
- Create: `src/workbench/components/DatabaseHome.vue`
- Create: `src/workbench/components/DatabaseTableList.vue`
- Modify: `src/workbench/workbench.css`
- Test: `src/workbench/workbenchCssPolish.test.js`

**Interfaces:**
- `DatabaseHome.vue` emits `open-table`, `open-design`, `copy-tables`, `paste-tables`, `rename-table`, `delete-tables`, `refresh`, and `state-change`.
- `DatabaseTableList.vue` emits selection, open/design, rename, and context-menu events.

- [ ] Add CSS/string tests for `.wb-database-home`, `.wb-dbhome-toolbar`, `.wb-dbhome-object-list`, `.wb-dbhome-object-row`, `.wb-dbhome-object-name`, and `.wb-dbhome-status`.
- [ ] Run `node --test src/workbench/workbenchCssPolish.test.js`; expected failure.
- [ ] Implement dense desktop homepage UI, virtualized list, stable row height, inline rename, compact toolbar, and token-based CSS.
- [ ] Re-run CSS test; expected pass.
- [ ] Commit `feat(workbench): add database homepage interface`.

### Task 6: Workbench Integration

**Files:**
- Modify: `src/workbench/components/WorkbenchPane.vue`
- Modify: `src/workbench/components/WorkbenchSplitLayout.vue`
- Modify: `src/workbench/components/WorkbenchTabs.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Test: `src/workbench/workbenchShell.test.js`

**Interfaces:**
- Consumes `openDatabaseHomeTab`, `closeTableObjectTabs`, `DatabaseHome.vue` events, and `drop_tables`.

- [ ] Add integration guards that homepage is imported, rendered, event-routed, opened after database selection, and calls `drop_tables`.
- [ ] Run `node --test src/workbench/workbenchShell.test.js`; expected failure.
- [ ] Wire homepage open/refresh/open-design/copy/paste/rename/delete flows and status feedback.
- [ ] Re-run integration test; expected pass.
- [ ] Commit `feat(workbench): wire database homepage flows`.

### Task 7: Full Verification And Runtime Check

**Files:** all changed files.

- [ ] Run focused tests: `node --test src/workbench/workspaceState.test.js src/workbench/mockBackend.test.js src/workbench/useDatabaseHome.test.js src/workbench/workbenchCssPolish.test.js src/workbench/workbenchShell.test.js`.
- [ ] Run full frontend tests by explicit file list: `$files = rg --files src/workbench -g "*.test.js"; node --test @($files)`.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml`.
- [ ] Run `npm.cmd run build`.
- [ ] Run `git diff --check`.
- [ ] Start `npm run dev`, read the printed Vite URL, and browser-verify homepage appearance, search, sort, double-click open, F2 rename, copy/paste `_copy1`, delete confirmation, and read-only disabling.
- [ ] Request code review and fix Critical/Important findings.
