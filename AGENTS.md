# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

DB Scout Workbench is a cross-platform desktop MySQL database workbench (Mac + Windows) built with Tauri 2 + Vue 3 + Vite + Rust. It is independent from the original `dbsearch` project. The first phase focuses on database reading/editing: connection tree, table sessions, paging, filtering, sorting, inline cell saving, insert/delete rows, and quick search. The UI follows a Navicat-like interaction model with a three-pane layout (navigation | data grid | inspector).

## Development Commands

```bash
npm install                              # Install JS dependencies
npm run dev                              # Run the frontend only with mock backend fallback (port 1431)
npm run tauri -- dev                     # Run the full desktop app (Vite dev server on port 1431 + Rust backend)
npm run build                            # Build sidecar + frontend (outputs to dist/)
cd sidecar && npm install                # Install Agent SDK sidecar dependencies
cd src-tauri && cargo check              # Type-check the Rust backend
cd src-tauri && cargo test               # Run Rust unit tests in db.rs and demo.rs
node --test src/workbench                # Run all JS unit tests recursively
node --test src/workbench/useGridEditor.test.js  # Run a single JS test file
```

The app runs with built-in demo data by default. To connect to a real MySQL server:

```bash
export DBSCOUT_MYSQL_URL="mysql://user:password@127.0.0.1:3306"
npm run tauri -- dev
```

Users can also connect interactively via the "+" button in the navigation pane.

## Architecture

### Frontend (`src/workbench/`)

The frontend uses a component/composable decomposition pattern. `MySqlWorkbench.vue` is the orchestrator that wires together child components and composables.

**State modules** (factory functions returning reactive objects):
- `workspaceState.js` — Tab lifecycle, page data, schema tree filtering
- `editState.js` — Cell editing state machine: optimistic updates, pending tracking, error recording, undo stack. Composite key: `tableName\x1frowKey\x1fcolumnName`
- `constants.js` — `DEFAULT_PAGE_SIZE` (100), `REQUEST_PAGE_SIZE` (1000), `GRID_ROW_HEIGHT` (26), `VIRTUAL_BUFFER` (10)

**Composables** (`composables/`):
- `useGridEditor.js` — Grid cell selection/editing logic, keyboard entry, and drag-range selection
- `useTableSession.js` — Table session lifecycle (open, fetch pages)
- `useConnection.js` — Saved connection management and database selection
- `useImportWizard.js` — Import workflow state machine
- `useVirtualGrid.js` — Virtual scroll range calculation
- `useRowSelection.js` — Row selection and batch operations
- `useExport.js` — Data export
- `useUndo.js` — Undo stack for edits
- `useContextMenu.js` — Context menu positioning and actions
- `useDataSearch.js` — Quick search across table data
- `useAgent.js` — Claude Code Agent SDK sidecar integration: streaming transcript, session lifecycle
- `useColumnResize.js` / `usePaneResize.js` — Resizable columns and pane dividers

**Utilities** (`utils/`):
- `tauriBridge.js` — `invokeWorkbench()` tries Tauri `invoke()`, falls back to `mockWorkbenchInvoke()` for browser-only dev
- `normalize.js` — Case normalization helpers (`normalizeTableName`, `columnName`)
- `rowIdentity.js` — Composite row key packing (`key1=val1&key2=val2`)
- `cellDisplay.js` — Cell value formatting for grid display

**Mock data** (`mock/`):
- `mockBackend.js` — Browser-only mock implementing the Tauri command contract
- `mockSchema.js` / `mockRows.js` — In-memory demo database (`game_db`)

### Backend (`src-tauri/src/`)

The Rust backend is split into six core files plus the new `agent/` module:
- **`main.rs`** — Entry point, calls `lib::run()`
- **`lib.rs`** — Module declarations + Tauri builder with `invoke_handler` registering all commands
- **`types.rs`** — All structs (`WorkbenchConnection`, `TableOption`, `ColumnMeta`, `TableMeta`, `TableSessionPage`, `UpdateCellRequest`, `AgentStartSessionRequest`, etc.) + `AppState`/`RuntimeState`
- **`commands.rs`** — All Tauri `#[tauri::command]` functions, including agent commands: `agent_start_session`, `agent_send`, `agent_abort`, `agent_approve_tool`, `agent_deny_tool`, `agent_list_sessions`, `agent_delete_session`
- **`db.rs`** — MySQL connection, schema reading, query building, page fetching (4 unit tests)
- **`demo.rs`** — In-memory demo schema/rows generation and fallback logic (1 unit test)
- **`agent/`** — Node sidecar lifecycle (`mod.rs`), stdio JSON-lines protocol (`protocol.rs`), DB MCP bridge (`db_bridge.rs`), read-only SQL guard (`sql_guard.rs`)

Dual-mode: every command checks for a real MySQL pool; if absent, falls back to demo data. SQL safety uses `escape_ident()` for backtick escaping and parameterized queries with bind values.

## Agent Architecture

The built-in database assistant is powered by the Claude Agent SDK running in a Node sidecar process:

- **`sidecar/agent-runner.mjs`** — Node entry point bundled by esbuild into `src-tauri/resources/agent-runner.mjs`
  - Drives the SDK `query()` API in streaming-input mode
  - Exposes DB tools as an in-process MCP server (`list_databases`, `list_tables`, `describe_table`, `sample_rows`, `search_schema`, `search_values`, `run_read_query`, `run_write_query`)
  - Forwards DB tool calls to the Rust host via `db_request` / `db_response` JSON-lines ops
  - Implements `canUseTool` approval gate: read-only DB tools are auto-approved, `run_write_query` and other tools require user approval
  - Supports `permissionMode: 'plan'` for planning without tool execution
  - Supports session persistence via SDK `persistSession` and `listSessions` / `deleteSession`

- **`src-tauri/src/agent/mod.rs`** — Spawns the Node sidecar, routes stdout events to frontend `agent-event` window events, and handles `db_request` / `approval_request` locally
- **`src-tauri/src/agent/db_bridge.rs`** — Dispatches DB tool requests to either the real MySQL pool (`db.rs`) or demo data (`demo.rs`)
- **`src-tauri/src/agent/sql_guard.rs`** — Validates `run_read_query` SQL is read-only, rejects multiple statements and dangerous keywords, and injects/caps `LIMIT`

Frontend state lives in `src/workbench/composables/useAgent.js`; UI lives in `src/workbench/components/AgentPanel.vue`.

### UI Layout

Three-pane CSS Grid: `292px | minmax(540px, 1fr) | 322px`

- **Left pane** — Connection cards, database selector, search, table list with context menu
- **Center pane** — Tab bar, toolbar (filter/sort/export/import), virtual-scroll data grid, insert row, batch delete
- **Right pane** — Column schema inspector, text editor panel for selected cell

Resizable via `PaneDivider.vue` component.

## Code Quality Requirements

**All new code must prioritize extensibility, elegance, and componentization.**

- **Component decomposition** — Extract logical units into separate Vue components, composables, or JS modules. Each piece should have a clear responsibility.
- **State separation** — Keep state logic in factory-function modules (`workspaceState.js`, `editState.js` style) separate from UI. New state domains get their own modules.
- **Backend modularity** — Keep the Rust backend split by concern (`commands`, `db`, `demo`, `types`).
- **CSS design tokens** — Use and extend the `--wb-*` custom properties defined in `workbench.css`. Avoid inline styles or magic color values.
- **Performance-conscious** — The data grid uses virtual scrolling. New grid features must respect this pattern. Avoid reactive watchers on large arrays.

## Key Patterns

- **Serde camelCase** — Rust structs that are deserialized from frontend requests use `#[serde(rename_all = "camelCase")]`. Serialize-only structs (responses) use snake_case field names that the mock backend matches.
- **Dual naming** — Backend uses `snake_case` (e.g., `table_name`, `column_name`), frontend normalizes with helpers in `utils/normalize.js`. Schema data often arrives in both forms.
- **Row identity** — Rows identified by primary key columns (or all columns as fallback) packed into a composite string key (`key1=val1&key2=val2`).
- **Optimistic editing** — Cell saves apply immediately in the frontend, then commit to backend. On failure, the old value is restored and an error is shown per-cell.
- **Node.js test runner** — JS tests use `node:test` and `node:assert/strict`, not Jest/Vitest. Run with `node --test`.
- **Tauri bridge fallback** — `invokeWorkbench()` in `tauriBridge.js` attempts Tauri invoke first; if `__TAURI_INTERNALS__` is unavailable, falls back to the JS mock backend. This allows running `npm run dev` (browser only) without the Rust backend.

## Dependencies

- **Frontend**: Vue 3 (Composition API, `<script setup>`), XLSX (import/export), Tauri API v2
- **Backend**: Tauri 2, sqlx 0.8 (MySQL, async), tokio 1 (sync), serde/serde_json, rfd 0.17 (native file dialogs)
- **Agent sidecar**: Node 18+, `@anthropic-ai/claude-agent-sdk`, zod
- **Build**: Vite 6 with @vitejs/plugin-vue, Tauri CLI 2, esbuild (sidecar bundling)
