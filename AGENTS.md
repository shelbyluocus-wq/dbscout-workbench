# AGENTS.md

This file provides guidance to Codex (codex.ai/code) when working with code in this repository.

> A near-identical `CLAUDE.md` exists for Claude Code. When you change project
> structure or conventions, keep both files in sync.

## Communication Style

When replying to the user, use product-manager-friendly language by default:
explain what the user will see, what changed, and what the impact is. Avoid
low-level implementation details, code identifiers, framework jargon, and file
paths unless the user explicitly asks for technical detail. If technical context
is necessary, first state the product-facing meaning, then offer to expand on the
technical details separately.

## Project Overview

DB Scout Workbench (product name **黑猫**, `com.dbscout.workbench`) is a
cross-platform desktop database workbench (Windows + macOS) built with Tauri 2 +
Vue 3 + Vite + Rust. It is independent from the original `dbsearch` project.

It started as a MySQL reader/editor and has grown into a full workbench. Current
capabilities:

- **Data browsing/editing** — connection tree, database selector, table
  sessions, paging, filtering, sorting, inline optimistic cell saving,
  insert/delete rows, quick search, import/export (XLSX/CSV).
- **Multi-engine** — MySQL (via `sqlx`) and ClickHouse (via HTTP + `reqwest`).
- **Table design (DDL)** — visual column/index editor with preview + apply.
- **Database sync** — preview and overwrite one database from another.
- **Table copy / rename**, batch transfer.
- **Safety layers** — full-database logical **snapshots/backup** (层1, GFS
  retention + restore) and a **change-audit + rollback** trail (层2, isolated
  SQLite).
- **Accounts + central server** — optional login to a central server that
  aggregates a **shared audit log** across workstations.
- **Built-in AI assistant** — Claude Agent SDK running in a Node sidecar with
  read-only DB tools auto-approved, database writes gated behind user approval,
  and approved local XLSX/text artifact generation in a dedicated output folder.
- **Desktop integration** — system tray with hide-to-tray, global shortcut
  (`Alt+Shift+F`) to toggle the window, light/dark theme, and an SVN-based
  in-app updater.

The app runs against built-in demo data by default, so it launches with no
database configured. Provide a real MySQL server via `DBSCOUT_MYSQL_URL` before
launch, or connect interactively through the `+` connection dialog.

## Development Commands

```bash
npm install                              # Install JS dependencies
npm run dev                              # Frontend only with mock backend fallback (Vite on port 1431)
npm run tauri -- dev                     # Full desktop app (Vite dev server + Rust backend)
npm run build                            # ensure-node + build sidecar + vite build (outputs to dist/)
npm run build:sidecar                    # Bundle the agent sidecar only
npm run preview                          # Preview the frontend build on 127.0.0.1
cd sidecar && npm install                # Install Agent SDK sidecar dependencies
cd src-tauri && cargo check              # Type-check the Rust backend
cd src-tauri && cargo test               # Run Rust unit tests
node scripts/test-workbench.mjs  # Run all workbench JS unit tests recursively
node --test src/workbench/useGridEditor.test.js  # Run a single JS test file
node scripts/test-sidecar.mjs  # Run all sidecar unit tests recursively
```

Release with `npm run release:package`; it builds the desktop app, renames the
Windows installer to `blackcat_<version>_x64-setup.exe`, and updates
`latest.json` to that exact filename. Lower-level helpers are
`npm run release:sync-version` (sync application versions) and
`npm run release:svn-manifest` (generate the SVN updater manifest). There is no
lint script defined in `package.json`.

To launch the full app against a real MySQL server:

```bash
export DBSCOUT_MYSQL_URL="mysql://user:password@127.0.0.1:3306"
npm run tauri -- dev
```

### Bundled Node runtime (agent sidecar)

The agent sidecar ships with a pinned portable Node runtime (v22.11.0) under
`src-tauri/resources/node/`. That directory is **gitignored** (it's a ~80MB
binary) and is referenced by the `resources/node/*` glob in
`src-tauri/tauri.conf.json`, so `cargo build` / `tauri dev` fail on a fresh
clone until it's populated.

- `npm run tauri -- dev` and `npm run build` auto-run `ensure-node` first,
  which fetches the runtime on demand (no-op if already present). You should
  not need to do anything manually on a fresh clone.
- `npm run fetch-node` does the same download explicitly, and accepts
  `--target=win32-x64|darwin-arm64|...` for cross-platform prep.
- Set `DBSCOUT_SKIP_NODE_FETCH=1` to skip the auto-fetch (the Tauri build
  will then fail on the resources glob — only useful with a matching
  `tauri.conf.json` override).
- Mirrors tried in order: Tsinghua → npmmirror → Aliyun → nodejs.org.
  Override with `DBSCOUT_NODE_MIRROR=https://your-mirror/`.

## Architecture

### Frontend (`src/workbench/`)

The frontend uses a component/composable decomposition pattern.
`MySqlWorkbench.vue` is the orchestrator that creates shared reactive state,
wires composables together, and passes props/events into presentation
components.

**State modules** (factory functions returning reactive objects, kept separate
from UI):
- `workspaceState.js` — Tab lifecycle, page data, schema tree filtering
- `editState.js` — Cell editing state machine: optimistic updates, pending
  tracking, per-cell error recording, undo stack. Composite key:
  `tableName\x1frowKey\x1fcolumnName`
- `paneLayoutState.js` — Persisted pane sizes / collapse state
- `sidebarTreeState.js`, `sidebarSearchState.js`, `sidebarScroll.js`,
  `sidebarDragPreview.js` — Sidebar tree/search/scroll/drag state
- `sqlExecutionState.js` — SQL console job/result event state and lifecycle
- `constants.js` — `DEFAULT_PAGE_SIZE` (100), `REQUEST_PAGE_SIZE` (1000),
  `GRID_ROW_HEIGHT`/`GRID_HEADER_HEIGHT` (28), `VIRTUAL_BUFFER` (10),
  `SIDEBAR_TABLE_ROW_HEIGHT`, and adaptive column-width constants
  (`MIN_COL_WIDTH`, `AUTOFIT_MAX_COL_WIDTH`, `COL_PADDING`, …)

**Composables** (`composables/`) — one responsibility each:
- Connection/table workflows: `useConnection.js`, `useTableSession.js`,
  `useTableSearch.js`, `useSidebarVirtualTables.js`, `aliasStore.js`
- Grid interactions: `useGridEditor.js`, `useVirtualGrid.js`,
  `useRowSelection.js`, `useColumnResize.js`, `useCellHighlight.js`,
  `usePersistentScrollbars.js`
- Table operations: `useTableDesign.js` (DDL editor), `useTableCopy.js`,
  `useDatabaseSync.js`, `useBatchTransfer.js`, `useImportWizard.js`,
  `useExport.js`, `useUndo.js`
- SQL console: `useSqlQuery.js` — editor drafts, execution, transactions,
  history, file state, result export, and close protection
- Safety / server: `useBackupCenter.js`, `useAccount.js`
- Shell/UX: `usePaneResize.js`, `useInspectorResize.js`, `useContextMenu.js`,
  `useConfirm.js`, `useEscClose.js`, `useShortcuts.js`, `useTheme.js`,
  `useTabWindowDrag.js`, `useUpdater.js`
- Agent: `useAgent.js` — Claude Agent SDK sidecar integration (streaming
  transcript, session lifecycle, approval flow)

**Utilities** (`utils/`):
- `tauriBridge.js` — `invokeWorkbench()` tries Tauri `invoke()`, falls back to
  `mockWorkbenchInvoke()` for browser-only dev
- `normalize.js` — Case normalization helpers (`normalizeTableName`, `columnName`)
- `rowIdentity.js` — Composite row key packing (`key1=val1&key2=val2`)
- `cellDisplay.js` — Cell value formatting for grid display
- `valueValidation.js`, `tableDesign.js`, `searchMatch.js`,
  `connectionConfigImport.js`, `connectionDisplay.js`, `workspacePersistence.js`,
  `markdown.js`, `updaterAdapter.js`, `xlsxLimit.js` / `xlsxWorkbook.js`,
  `performanceMarks.js`, `sidebarSearchHistory.js`, `tabActivation.js`,
  `selectedCellIdentity.js`

**Components** (`components/`) render panes and dialogs: `WorkbenchSidebar.vue`,
`WorkbenchTabs.vue`, `DataGrid.vue`, `InspectorPanel.vue`, `CellDetailPanel.vue`,
`ContextMenu.vue`, `ConnectionDialog.vue`, import/export dialogs,
`TableDesignEditor.vue`, `DatabaseSyncDialog.vue`, `TableCopyDialog.vue`,
`BackupCenterDialog.vue`, `UpdateDialog.vue`, `ShortcutSettingsDialog.vue`,
`PaneDivider.vue`, the `SqlQueryWorkspace.vue` / `SqlCodeEditor.vue` /
`SqlResultGrid.vue` / `SqlHistoryDialog.vue` query surfaces, and the `Agent*`
panel/message/card components. `DataGrid.vue`
renders only `visibleRows` from `useVirtualGrid`; new grid features must preserve
this virtualized flow.

**Mock data** (`mock/`):
- `mockBackend.js` — Browser-only mock implementing the Tauri command contract
- `mockSchema.js` / `mockRows.js` — In-memory demo database
- `mockEventBus.js` — Emulates Tauri window events for mock mode

### Backend (`src-tauri/src/`)

The Rust backend is split by concern:
- **`main.rs`** — Entry point, calls `lib::run()`
- **`lib.rs`** — Module declarations, Tauri builder, managed `AppState`, system
  tray + global shortcut setup, background schedulers (backup + audit sync), and
  `invoke_handler` command registration
- **`types.rs`** — All request/response structs + `AppState`/`RuntimeState`
- **`commands.rs`** — All Tauri `#[tauri::command]` functions (dual-mode)
- **`db.rs`** — MySQL connection, schema reading, safe SQL construction,
  filtering/sorting, page fetching
- **`clickhouse.rs`** — ClickHouse support over HTTP (`reqwest`), mirroring the
  `db.rs` page/schema/search contract
- **`demo.rs`** — In-memory demo schema/rows and fallback paging/filtering
- **`ddl.rs`** — Table design metadata + preview/apply of column/index changes
- **`sql_console.rs`** — SQL splitting/classification, cancellable streaming
  execution, MySQL transactions, ClickHouse read-only enforcement, and audit
  integration
- **`sql_history.rs`** — SQLite-backed query history and favorites
- **`sync.rs`** — Database-sync preview + overwrite (emits progress events); destructive sync creates a complete local protection snapshot through `backup.rs` and never creates a temporary database on the MySQL server
- **`table_replace.rs`** — Whole-table import preparation and primary-key identity rules; `replace_table_rows` applies the complete diff atomically with rollback-capable audit entries
- **`validation.rs`** — Row/primary-key validation shared by write paths
- **`backup.rs`** — Full-database logical snapshots (层1): dump, GFS retention,
  restore (with a pre-restore snapshot), exact sync-failure recovery from local
  protection snapshots, plus the background scheduler
- **`audit.rs`** — Change-audit trail (层2): before-image + inverse SQL in an
  isolated SQLite DB, with rollback that is itself audited
- **`audit_sync.rs`** — Background outbox that pushes local audit rows to the
  central server (offline-first, idempotent on `client_id`)
- **`account.rs`** — Account/session persistence + central-server client
- **`svn_updater.rs`** — SVN-based in-app updater (config, check, install)
- **`agent/`** — Node sidecar lifecycle (`mod.rs`), stdio JSON-lines protocol
  (`protocol.rs`), DB MCP bridge (`db_bridge.rs`), read-only SQL guard
  (`sql_guard.rs`), and generated-artifact path validation/opening (`artifact.rs`)

Dual-mode: commands inspect the selected connection pool. With a MySQL pool they
use `db.rs`; a ClickHouse connection routes to `clickhouse.rs`; with no pool they
fall back to `demo.rs`. SQL identifiers are escaped with `escape_ident()` and
user/data values are bound as query parameters.

SQL console commands use `start_sql_execution` / `cancel_sql_execution`, the
`begin_sql_transaction` / `commit_sql_transaction` /
`rollback_sql_transaction` lifecycle, SQL history commands, and SQL file
open/save commands. Execution batches are emitted through
`sql-execution-event`; keep this event contract aligned with the browser mock.

When adding or changing Tauri commands, keep names and payload shapes in sync
across frontend `invokeWorkbench()` callers, `mock/mockBackend.js`, Rust
`commands.rs`, the `lib.rs` command registration, and the `types.rs` structs.

## Agent Architecture

The built-in database assistant is powered by the Claude Agent SDK running in a
Node sidecar process:

- **`sidecar/agent-runner.mjs`** — Node entry point bundled by esbuild into
  `src-tauri/resources/agent-runner.mjs`
  - Drives the SDK `query()` API in streaming-input mode
  - Exposes DB tools as an in-process MCP server (`list_databases`,
    `list_tables`, `describe_table`, `sample_rows`, `search_schema`,
    `search_values`, `run_read_query`, `run_write_query`)
  - Exposes approved artifact tools through `sidecar/artifactTools.mjs`:
    `create_spreadsheet` for multi-sheet XLSX and `create_text_file` for
    TXT/Markdown/JSON/CSV/HTML/SQL. Files are created without overwrite under
    `Documents/DB Scout Workbench/Agent Files`.
  - Forwards DB tool calls to the Rust host via `db_request` / `db_response`
    JSON-lines ops
  - `canUseTool` approval gate: read-only DB tools auto-approved,
    `run_write_query`, artifact creation, and other write tools require user approval (see
    `sidecar/toolApproval.mjs`)
  - Supports `permissionMode: 'plan'` for planning without tool execution, an
    auto-approve toggle, and session persistence (`listSessions` /
    `deleteSession` / message history)
  - Sets `options.pathToClaudeCodeExecutable` explicitly because esbuild removes
    the node_modules layout the SDK uses to resolve its native CLI binary
- **`sidecar/resolveNativeCli.mjs`** — Locates the native Claude Code CLI binary:
  1. `DBSCOUT_AGENT_NATIVE_CLI_PATH` env var (injected by the Rust host)
  2. A bundled binary next to the sidecar script
  3. The locally installed optional SDK package in `sidecar/node_modules` (dev)
- **`sidecar/sdkMessageForwarder.mjs`** / **`proxyEnv.mjs`** — SDK event
  forwarding and proxy env normalization
- **`sidecar/scripts/build.mjs`** — Bundles the sidecar and copies the
  platform-specific native CLI binary into `src-tauri/resources/`

Rust side: `agent/mod.rs` spawns the sidecar, routes stdout to `agent-event`
window events, and handles `db_request` / `approval_request`; `agent/db_bridge.rs`
dispatches DB tool requests to MySQL/ClickHouse/demo; `agent/sql_guard.rs`
validates `run_read_query` is read-only and injects/caps `LIMIT`. Agent commands:
`agent_start_session`, `agent_send`, `agent_abort`, `agent_approve_tool`,
`agent_deny_tool`, `agent_set_mode`, `agent_set_auto_approve`,
`agent_list_sessions`, `agent_delete_session`, `agent_get_session_messages`.

Frontend state lives in `composables/useAgent.js`; UI lives in the `Agent*`
components (`AgentPanel.vue`, `AgentMessage.vue`, `AgentArtifactCard.vue`, `AgentApprovalCard.vue`,
`AgentPlanCard.vue`, `AgentSessionList.vue`, `AgentSettings.vue`, …).

### UI Layout

Three-pane flex shell: left sidebar (default 292px) | center main pane
(flex, ~400px min) | right inspector (default 322px), with a top tab/tool area
and a bottom status bar. Panes are resizable/collapsible via `PaneDivider.vue`
+ `usePaneResize.js`.

- **Left pane** — Connection cards, database selector, search, virtualized table
  list with context menu
- **Center pane** — Tab bar, toolbar (filter/sort/export/import/design), virtual-
  scroll data grid, insert row, batch delete
- **Right pane** — Column schema inspector, text editor panel for the selected cell

## Code Quality Requirements

**All new code must prioritize extensibility, elegance, and componentization.**

- **Component decomposition** — Extract logical units into separate Vue
  components, composables, or JS modules with a clear single responsibility.
- **State separation** — Keep state logic in factory-function modules
  (`workspaceState.js`, `editState.js` style) separate from UI.
- **Backend modularity** — Keep the Rust backend split by concern; add a new
  module rather than growing `commands.rs`/`db.rs` unboundedly.
- **CSS design tokens** — Use and extend the `--wb-*` custom properties in
  `workbench.css`. Avoid inline styles or magic color values (dimensions
  computed by an interaction composable are fine).
- **Performance-conscious** — The data grid and sidebar table list use virtual
  scrolling. New grid features must respect this pattern; avoid reactive
  watchers over large arrays.

## Key Patterns

- **Serde camelCase** — Rust request structs (deserialized from frontend) use
  `#[serde(rename_all = "camelCase")]`. Response structs are mixed: table/column
  metadata is commonly snake_case, some session/search responses are camelCase.
  Check `types.rs` and normalize at the frontend boundary.
- **Dual naming** — Backend uses `snake_case`; frontend normalizes with helpers
  in `utils/normalize.js`. Schema data often arrives in both forms.
- **Row identity** — Rows are identified by primary-key columns (or all columns
  as fallback) packed into a composite string key (`key1=val1&key2=val2`).
- **Optimistic editing** — Cell saves apply immediately in the frontend, then
  commit to the backend. On failure the optimistic value is cleared and a
  per-cell error is recorded.
- **Safety layers** — Writes flow through backup (层1) + audit (层2); a
  successful mutation always has a committed audit row so it can be rolled back.
- **Node.js test runner** — JS/sidecar tests use `node:test` and
  `node:assert/strict`, not Jest/Vitest. Run with `node --test`.
- **Tauri bridge fallback** — `invokeWorkbench()` attempts Tauri invoke first; if
  `__TAURI_INTERNALS__` is unavailable it falls back to the JS mock backend,
  allowing `npm run dev` (browser only) without the Rust backend.

## Dependencies

- **Frontend**: Vue 3 (Composition API, `<script setup>`), XLSX (import/export),
  Tauri API v2 (+ global-shortcut and process plugins)
- **Backend**: Tauri 2 (tray-icon), sqlx 0.8 (MySQL + SQLite), tokio 1,
  serde/serde_json, reqwest (ClickHouse HTTP + central server), rfd 0.17 (native
  file dialogs), chrono, uuid
- **Agent sidecar**: Node 22 (bundled runtime), `@anthropic-ai/claude-agent-sdk`,
  zod
- **Build**: Vite 6 with `@vitejs/plugin-vue`, Tauri CLI 2, esbuild (sidecar
  bundling), Playwright (dev screenshots/scripts)
