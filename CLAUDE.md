# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DB Scout Workbench is a standalone MySQL database workbench built with Tauri 2, Rust, Vue 3, and Vite. It is independent from the original `dbsearch` project and focuses on database reading/editing workflows: connection tree, database selection, table sessions, paging, filtering, sorting, inline cell saving, insert/delete rows, import/export, and quick search. The UI follows a Navicat-like desktop workbench model with navigation, data grid, and inspector panes.

The app runs against built-in demo data by default. Real MySQL connections can be provided either with `DBSCOUT_MYSQL_URL` before launching the Tauri app or interactively through the `+` connection dialog.

## Development Commands

```bash
npm install                              # Install JS dependencies
npm run dev                              # Run frontend only with mock backend fallback (Vite on port 1431)
npm run tauri -- dev                     # Run the full desktop app (Vite + Tauri/Rust backend)
npm run build                            # Build the frontend only (outputs to dist/)
npm run preview                          # Preview the frontend build on 127.0.0.1
cd src-tauri && cargo check              # Type-check the Rust backend
cd src-tauri && cargo test               # Run Rust unit tests
node --test src/workbench/*.test.js      # Run all JS unit tests
node --test src/workbench/useGridEditor.test.js  # Run a single JS test file
```

There is no lint script currently defined in `package.json`.

To launch the full app against a real MySQL server:

```bash
export DBSCOUT_MYSQL_URL="mysql://user:password@127.0.0.1:3306"
npm run tauri -- dev
```

## Architecture

### Frontend (`src/workbench/`)

`MySqlWorkbench.vue` is the orchestrator. It creates the shared reactive state, wires composables together, and passes props/events into presentation components.

**State modules** are factory-style JS modules kept separate from UI:
- `workspaceState.js` — database/table schema, tab lifecycle, active tab, page replacement, schema-tree filtering.
- `editState.js` — optimistic cell editing state: pending cells, optimistic values, cell errors, undo stack. Cell keys use `tableName\x1frowKey\x1fcolumnName`.
- `constants.js` — page size, requested fetch size, grid row height, and virtual-scroll buffer constants.

**Composables** hold workflow and interaction logic:
- Connection/table workflows: `useConnection.js`, `useTableSession.js`, `useDataSearch.js`.
- Grid interactions: `useGridEditor.js`, `useVirtualGrid.js`, `useRowSelection.js`, `useColumnResize.js`, `usePersistentScrollbars.js`.
- Surrounding workbench features: `useImportWizard.js`, `useExport.js`, `useUndo.js`, `useContextMenu.js`, `usePaneResize.js`.

**Components** render the workbench panes and dialogs: sidebar, tabs, `DataGrid.vue`, inspector, context menu, connection/import dialogs, and pane dividers. `DataGrid.vue` renders only `visibleRows` from `useVirtualGrid`; new grid features must preserve this virtualized flow.

**Utilities and mocks**:
- `utils/tauriBridge.js` calls Tauri `invoke()` and falls back to the JS mock backend when Tauri internals are unavailable, enabling `npm run dev` browser-only work.
- `utils/normalize.js`, `utils/rowIdentity.js`, and `utils/cellDisplay.js` handle frontend/backend naming differences, row identity packing, and grid/detail value display.
- `mock/mockBackend.js`, `mock/mockSchema.js`, and `mock/mockRows.js` implement the browser-only command contract and demo database.

When adding or changing Tauri commands, keep command names and payload shapes synchronized across frontend `invokeWorkbench()` callers, `mock/mockBackend.js`, Rust `commands.rs`, `lib.rs` command registration, and `types.rs` request/response structs.

### Backend (`src-tauri/src/`)

The Rust backend is split by concern:
- `main.rs` — binary entry point that calls `lib::run()`.
- `lib.rs` — Tauri builder, managed `AppState`, and command registration.
- `types.rs` — request/response structs plus `RuntimeConnection`, `RuntimeState`, and `AppState`.
- `commands.rs` — Tauri `#[tauri::command]` functions and dual-mode command behavior.
- `db.rs` — MySQL connection, schema reads, safe SQL construction, filtering/sorting, and page fetching.
- `demo.rs` — in-memory demo schema/rows and demo fallback paging/filtering/sorting.

`AppState::new()` creates either an environment-backed MySQL connection (`DBSCOUT_MYSQL_URL`) or a demo connection. Commands generally inspect the selected connection pool: with a pool they use `db.rs`; without one they fall back to `demo.rs`. SQL identifiers are escaped with `escape_ident()`, and user/data values are bound as query parameters.

## UI Layout and Styling

The root workbench uses a full-height shell with a workspace area and status bar. `.wb-workspace` is a flex layout: left sidebar defaults to 292px, center main pane flexes with a 400px minimum, and right inspector defaults to 322px. `PaneDivider.vue` plus `usePaneResize.js` handle resizing and collapse/expand behavior.

Use and extend the `--wb-*` CSS custom properties in `workbench.css`. Avoid inline styles and hard-coded colors unless they are computed dimensions controlled by an interaction composable.

## Key Patterns

- **Naming boundaries** — Rust request structs that receive frontend payloads use `#[serde(rename_all = "camelCase")]`. Response structs are mixed: table/column metadata is commonly snake_case, while some session/search responses serialize camelCase. Check `types.rs` and normalize at the frontend boundary.
- **Row identity** — Rows are identified by primary-key columns, or all columns as fallback, packed into strings like `key1=val1&key2=val2` by `utils/rowIdentity.js`.
- **Paging and virtualization** — Frontend table sessions request up to `REQUEST_PAGE_SIZE` rows and then virtualize rendered rows with `GRID_ROW_HEIGHT` and `VIRTUAL_BUFFER`.
- **Optimistic editing** — Cell saves apply immediately in the frontend, then commit to the backend. On failure, the optimistic value is cleared and the per-cell error map records the failure.
- **Node.js tests** — JS tests use `node:test` and `node:assert/strict`, not Jest or Vitest.
- **Dual backend contract** — Browser-only development depends on `mockBackend.js` matching the Tauri command contract closely enough for UI workflows.

## Code Quality Requirements

All new code should prioritize extensibility, elegance, and componentization.

- Extract logical units into Vue components, composables, utilities, or state modules with clear responsibilities.
- Keep state/workflow logic in modules and composables rather than burying it in templates.
- Keep Rust backend changes within the existing `commands`/`db`/`demo`/`types` boundaries.
- Preserve grid performance: avoid watchers over large row arrays and keep rendering tied to the virtual-scroll model.
- Use the existing CSS token system and workbench visual language for UI changes.

## Dependencies

- **Frontend**: Vue 3 Composition API, XLSX, Tauri API v2.
- **Backend**: Tauri 2, sqlx 0.8 for MySQL, tokio sync primitives, serde/serde_json, rfd native file dialogs.
- **Build**: Vite 6 with `@vitejs/plugin-vue`, Tauri CLI 2.
