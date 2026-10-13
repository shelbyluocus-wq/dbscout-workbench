# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> A near-identical `AGENTS.md` exists for Codex. When you change project
> structure or conventions, keep both files in sync.

## Highest Priority: User-Perceived Performance

User-perceived responsiveness is the project's highest engineering priority,
while correctness and data safety remain non-negotiable.

- Foreground interactions must never wait for speculative background prefetch.
- Deliver usable content first; defer secondary metadata, totals, and buffer filling.
- Background batching and caches must not couple their latency to user actions.
- Performance changes must verify cold and warm paths, especially immediate actions after navigation.
- Do not trade correctness, consistency, or data safety for speed.

## Communication Style

When replying to the user, use product-manager-friendly language by default:
explain what the user will see, what changed, and what the impact is. Avoid
low-level implementation details, code identifiers, framework jargon, and file
paths unless the user explicitly asks for technical detail. If technical context
is necessary, first state the product-facing meaning, then offer to expand on the
technical details separately.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-role triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain documentation layout. See `docs/agents/domain.md`.

## Project Overview

DB Scout Workbench (product name **Blackcat**, `com.dbscout.workbench`) is a
cross-platform desktop database workbench (Windows + macOS) built with Tauri 2 +
Vue 3 + Vite + Rust. It is independent from the original `dbsearch` project.

It started as a MySQL reader/editor and has grown into a full workbench. Current
capabilities:

- **Data browsing/editing** — connection tree, database selector, table
  sessions, paging, filtering, sorting, inline optimistic cell saving,
  insert/delete rows, quick search, unified find & replace dialog (Ctrl+F find tab /
  Ctrl+H replace tab) with a click-to-jump match list; selection-scoped or
  whole-table, and whole-table replace is Ctrl+Z-undoable with chunked
  progress), import/export (XLSX/CSV).
- **Multi-engine** — MySQL (via `sqlx`), ClickHouse (via HTTP + `reqwest`,
  read-only), and MongoDB (via the official `mongodb` crate). Mongo maps
  databases → databases, collections → tables, and documents → rows. Columns
  are sampled from top-level fields (`_id` is the primary key). Users can
  browse, search, export, and edit documents; SQL console, table design,
  sync, copy, import, snapshots, and whole-table find/replace stay blocked.
- **Table design (DDL)** — visual column/index editor with preview + apply.
- **Database sync** — preview and overwrite one database from another, with
  per-connection manual exclusion history plus global, named, combinable
  exclusion templates (stored in localStorage, unioned with dedup at sync time).
- **Table copy / rename**, batch transfer. Sending tables to another
  connection/database offers two modes: create a copy (duplicate names gain
  a `_copy` suffix) or overwrite same-named target tables in place.
- **Safety layers** — full-database logical **snapshots/backup** (layer 1, GFS
  retention + restore) and a **change-audit + rollback** trail (layer 2, isolated
  SQLite).
- **Accounts + central server** — optional login to a central server that
  aggregates a **shared audit log** across workstations.
- **Built-in AI assistant** — Claude Agent SDK running in a Node sidecar whose
  large Node + native CLI runtime is downloaded from the SVN release directory
  on first use, with
  read-only DB tools auto-approved, database writes gated behind user approval,
  and approved local XLSX/text artifact generation in a dedicated output folder.
- **Switch-database glow** — when open tabs span ≥2 databases,
  switching to another database's tab plays a traveling glow along the center
  pane's left/top/right edges and floats "<connection name> · <database label>"
  (both alias/decoration-aware) mid-pane; the effect color is configurable per
  light/dark theme in the settings drawer.
- **One-click table transfer** — an activity-rail entry below the backup
  center (or `Ctrl+Shift+T`) opens the dialog; the user clicks Start transfer to run
  the conversion script
  (`.exe/.bat/.cmd/.lnk`; `.lnk` resolved via PowerShell COM, script stdin is
  nulled so a trailing `pause` can't hang it), locates the produced
  timestamped package (`YYYY-MM-DD HH-mm-ss`, possibly nested one level under
  a database-name folder, must contain `props` + `src/props`), svn-updates the
  selected game project folder (same as right-click → SVN Update on that
  folder, not only `assets/props` + `assets/src/props`) with automatic conflict
  handling (cleanup, `--accept theirs-full/mine-full` per template, tree
  conflicts on Prefer remote use cleanup + revert, or postpone and stop before copy
  when the template is Resolve conflicts manually), then merge-copies
  the package into the project `assets` without deleting extras. Templates in
  localStorage remember script path, project root, and conflict strategy: two
  built-in ones (Game 1/Game 2) keep a fixed id for path discovery and can't be
  deleted; users add their own with New template, and every template is named
  inline (unique, at most 40 characters), renamed by double-click/F2/Rename,
  with user templates deleted after a confirmation. Opening
  the dialog auto-discovers script/project paths for the built-in templates
  only, on non-C drives using the SVN relative layout (`chengxu/client/jswz` +
  `chengxu/tool`, `trunk/client/nzg` + `trunk/tools`, plus the common
  `client/jswz` / `Versions/nzg` checkouts) and fills empty or missing ones.
  Path rows have a Browse button that reveals the script/project in Explorer.
- **Config relations** — for game-config databases the workbench works out
  which config tables reference each other from three evidence sources:
  database column comments, a static scan of the bound game client's source
  code, and recognisable list formats in the data. A table tab's inspector
  gains a relation page (its Fields/Relations switch shows the table's
  relation count, amber when some need review) with three collapsible,
  remembered sections: **Current row** (headed by the row's key and name)
  lists the rows the selected row points to — each target a jump, several
  targets openable at once — and the rows that point back. Incoming lines
  show their count, expand on demand into key + name lists (50 rows per
  batch), and open every referencing row as one filtered tab; columns that
  do not reference the row fold into one quiet toggle. Composite-key jumps
  match every key, and a jump to referenced rows selects the first of them so
  the chain can be followed. `IncomingRelationRows.vue` renders these lines
  and `incomingRelationRows.js` owns their paging and stale-request guards.
  **Relation map** draws the current table's neighbours (depth 1–2, at most
  60 tables) on a dot-grid canvas, circles tinted by side (tables it
  references / tables referencing it, whose switches double as the colour
  key) and lines coloured by relation status; clicking a node opens that
  table. Tables can be dragged (neighbours follow on springs and everything
  swings back to the ring layout on release), the wheel zooms around the
  pointer, fitting never enlarges a small graph past a readable scale, the
  bottom edge resizes the graph (height remembered), a help button explains
  the gestures and an enlarge button opens it in a large dialog. A corner
  card lists the hovered table's drawn relations field by field
  (`source.column → target.column` plus status); right-clicking a table locks
  the highlight and card (scrollable, table names open), right-clicking it
  again or clicking empty space unlocks. **Field relations** lists every
  relation by direction, waiting decisions first; each row opens its
  evidence (comment text, client code file:line with the line itself, data
  sample). A slim notice appears only when the client folder needs binding;
  softer coverage notes and the way into review sit at the bottom. One hue
  per direction (`--wb-relation-out*` / `--wb-relation-in*`, derived from the
  hit palette) is shared by the page, the map and the relation chip. The tab
  bar tags tables that take part in relations, and a review dialog (with an
  activity-rail badge counting what needs attention; opened from a relation
  page it reviews that table's database) summarises the totals, shows the
  bound client folder or candidate folders with their table coverage, and
  lets the user confirm or reject candidates with their evidence spelled out.
  Each MySQL server binds to its game client folder (auto-discovered across
  drives); client code changes that affect a relation mark it stale or
  conflicting for re-review while unrelated changes stay quiet. Bindings and
  review verdicts stay local in `config-relations.json`, shared by every
  database on the same server. Available for MySQL connections and the
  built-in demo data; ClickHouse and MongoDB are excluded.
- **Desktop integration** — system tray with hide-to-tray, global shortcut
  (`Alt+Shift+F`) to toggle the window, light/dark theme, a switchable color-theme system (slate / teal /
  azure presets with a settings-drawer picker), and an SVN-based
  in-app updater.

The app runs against built-in demo data by default, so it launches with no
database configured. Provide a real MySQL server via `DBSCOUT_MYSQL_URL` before
launch, or connect interactively through the `+` connection dialog.

## Development Commands

```bash
npm install                              # Install JS dependencies
npm run dev                              # Frontend only with mock backend fallback (Vite on port 1431)
npm run tauri -- dev                     # Full desktop app (Vite dev server + Rust backend)
npm run build                            # build sidecar + vite build (outputs to dist/)
npm run build:sidecar                    # Bundle the agent sidecar only
npm run preview                          # Preview the frontend build on 127.0.0.1
cd sidecar && npm install                # Install Agent SDK sidecar dependencies
cd src-tauri && cargo check              # Type-check the Rust backend
cd src-tauri && cargo test               # Run Rust unit tests
node scripts/test-workbench.mjs  # Run all workbench JS unit tests recursively
node --test src/workbench/useGridEditor.test.js  # Run a single JS test file
node scripts/test-sidecar.mjs  # Run all sidecar unit tests recursively
npm run quality:duplication  # Fail when maintainable source duplication reaches 5%
npm run release:agent-runtime -- --version 1  # Publish the independently versioned AI runtime
```

The macOS `icon.icns` is not full-bleed: it follows the macOS icon grid
(824px rounded tile with a drop shadow on a transparent 1024px canvas), while
the Windows `.ico` fills the canvas. After changing the artwork
(`src-tauri/icons/black-cat-icon.png`), regenerate it with
`swift scripts/build-macos-icon.swift`; do not let `tauri icon` overwrite it.

Release with `npm run release:package`; it builds the desktop app, renames the
Windows installer to `blackcat_<version>_x64-setup.exe`, and updates
`latest.json` to that exact filename. Pass `--notes-file <path>` (or `--notes
"<text>"`) to write real release notes into the `latest.json` `notes` field —
they surface in the in-app update notice and dialog. The
`.agents/skills/blackcat-release` skill automates the everyday flow (version
bump + notes summary + package + commit/push to main) when the user requests a release. Lower-level helpers are
`npm run release:sync-version` (sync application versions) and
`npm run release:svn-manifest` (generate the SVN updater manifest). There is no
lint script defined in `package.json`. `release:package` rejects a Windows
installer larger than 20 MB or any configuration that puts Node / the native
Claude CLI back into the main bundle. Windows builds fetch a pinned Apache
Subversion command-line client into `src-tauri/resources/svn/` (`npm run
ensure-svn` / `npm run fetch-svn`) and ship it with the installer so in-app
updates work without a system `svn.exe`.

To launch the full app against a real MySQL server:

```bash
export DBSCOUT_MYSQL_URL="mysql://user:password@127.0.0.1:3306"
npm run tauri -- dev
```

### On-demand AI runtime (agent sidecar)

Production installers contain the lightweight `agent-runner.mjs`,
`mcp-server.mjs`, and agent-auth configuration, but do **not** contain portable
Node or `claude-code-native(.exe)`. On first use, `agent_runtime.rs` reads
`agent-runtime.json` from the configured SVN working copy, verifies the ZIP
size and SHA-256, extracts it to `<app_data>/agent-runtime/`, and atomically
activates the version recorded in `state.json`. A valid previous version is
kept as rollback; missing or corrupt local files trigger repair on the next AI
use. Runtime version numbers are independent positive integers and never
downgrade automatically.

- Publish a runtime with `npm run release:agent-runtime -- --version <N>`.
  The command prepares local Node/CLI sources, creates
  `agent-runtime-v<N>-<platform>.zip`, and writes `agent-runtime.json`.
  `--min-app-version`, `--target`, and `--output-dir` are optional. The version
  is explicit: identical content at the same version is a no-op; changed
  content at the same version is rejected, so real Node/CLI changes require a
  version bump.
- `npm run tauri -- dev` still auto-runs `ensure-node` and uses the gitignored
  files under `src-tauri/resources/` directly. Development therefore does not
  need an installed runtime. `npm run build` does not fetch or bundle Node.
- `npm run fetch-node` prepares the local Node source explicitly and accepts
  `--target=win32-x64|darwin-arm64|...`. Mirrors are tried in the order
  the official nodejs.org host; override with
  `DBSCOUT_NODE_MIRROR=https://your-mirror/`.

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
- `cellDetailVisibility.js` — Cell-detail panel collapse state + auto-expand rule
  (persisted; default collapsed, auto-expands on long/multiline cell text)
- `inspectorVisibility.js` — Right inspector (notes/AI) open state per page kind
  (table data/home open, SQL/design collapsed by default; manual toggles persist
  per kind) and narrow-window yield (auto-collapses first when the main area
  would drop below 780px; a manual reopen is honoured until space returns)
- `sidebarTreeState.js`, `sidebarSearchState.js`, `sidebarScroll.js`,
  `sidebarDragPreview.js` — Sidebar tree/search/scroll/drag state
- `sqlExecutionState.js` — SQL console job/result event state and lifecycle
- `operationNotices.js` — Visible operation-feedback queue rendered by
  `OperationNoticeStack.vue` (bottom-right, below menus and dialogs): tone-based
  auto-dismiss, hover/focus pause, same-event coalescing and suppression of
  messages already shown beside a cell
- `constants.js` — `DEFAULT_PAGE_SIZE` (100), `REQUEST_PAGE_SIZE` (1000),
  `GRID_ROW_HEIGHT`/`GRID_HEADER_HEIGHT` (28), `VIRTUAL_BUFFER` (10),
  `SIDEBAR_TABLE_ROW_HEIGHT`, and adaptive column-width constants
  (`MIN_COL_WIDTH`, `AUTOFIT_MAX_COL_WIDTH`, `COL_PADDING`, …)

**Composables** (`composables/`) — one responsibility each:
- Connection/table workflows: `useConnection.js`, `useTableSession.js`
  (transparently reopens dead backend sessions — both on
  `table-sessions-invalidated` events and when a page fetch hits a
  session-expired error), `useTableSearch.js`,
  `useSidebarVirtualTables.js`, `useSidebarTableSelection.js` (sidebar
  Ctrl/Shift multi-selection; a plain click still opens the table),
  `aliasStore.js`
- Grid interactions: `useGridEditor.js`, `useVirtualGrid.js`,
  `useRowSelection.js`, `useColumnResize.js`, `useColumnReorder.js`, `useCellHighlight.js`,
  `usePersistentScrollbars.js`
- Table operations: `useTableDesign.js` (DDL editor), `useTableCopy.js`,
  `useDatabaseSync.js`, `useBatchTransfer.js`, `useImportWizard.js`,
  `useExport.js`, `useUndo.js`
- SQL console: `useSqlQuery.js` — editor drafts, execution, transactions,
  history, file state, result export, and close protection
- Tab-switch glow: `useDatabaseSwitchGlow.js` — cross-database switch trigger
  decision (`resolveSwitchGlow`), transient playback state, and the per-theme
  effect-color preference (`dbscout_glow_color_{light,dark}` →
  `--wb-glow-custom` root override, `useCellHighlight.js` pattern)
- Safety / server: `useBackupCenter.js`, `useAccount.js`
- Table transfer: `useTableTransfer.js` — one-click table transfer templates
  (localStorage), run/cancel state, `table-transfer-progress` event log
- Config relations: `useConfigRelations.js` — mirrors each scope's relation
  overview, refreshes on `config-relations-updated`, and serves the
  table/row lookups plus the per-revision cached scope graph;
  `useGraphViewport.js` / `useGraphForces.js` — relation-graph zoom/pan with
  glide animation, and the frame-driven spring simulation;
  `configRelationContext.js` — provided scope so grid
  chips can clear a relation filter without prop chains
- Shell/UX: `usePaneResize.js`, `useInspectorResize.js`, `useActivityRail.js`
  (activity-rail entries, order, and live shortcut labels), `useContextMenu.js`,
  `useConfirm.js`, `useEscClose.js`, `useShortcuts.js`, `useTheme.js`,
  `useTabWindowDrag.js`, `useUpdater.js`
- Color theme: `colorThemes.js` (preset registry) + `colorThemeController.js`
  (injects token overrides as a runtime <style> using the base selectors, so
  teleported surfaces inherit for free); persisted in localStorage`
- Agent: `useAgent.js` — Claude Agent SDK sidecar integration (streaming
  transcript, session lifecycle, approval flow)

**Utilities** (`utils/`):
- `tauriBridge.js` — `invokeWorkbench()` tries Tauri `invoke()`, falls back to
  `mockWorkbenchInvoke()` for browser-only dev
- `normalize.js` — Case normalization helpers (`normalizeTableName`, `columnName`)
- `rowIdentity.js` — Composite row key packing (`key1=val1&key2=val2`)
- `cellDisplay.js` — Cell value formatting for grid display
- `columnOrder.js` — Data-grid field order (apply/move, freeze-zone drop rules, per-table memory)
- `valueValidation.js`, `tableDesign.js`, `searchMatch.js`,
  `connectionKinds.js` (MySQL / ClickHouse / MongoDB kind + capability gates),
  `connectionConfigImport.js`, `connectionDisplay.js`, `workspacePersistence.js`,
  `markdown.js`, `updaterAdapter.js`, `xlsxLimit.js` / `xlsxWorkbook.js`,
  `performanceMarks.js`, `sidebarSearchHistory.js`, `tabActivation.js`,
  `selectedCellIdentity.js, `columnTypes.js` (numeric-type detection for
  right-aligned tabular data cells)`,
  `homeDesignTargets.js` (home-page multi-select → table-design targets),
  `changeSemantics.js` (format-only vs real diff detection for the comparison
  auto-jump)
  `tabSourceSync.js` (background sidebar connection/database sync after a tab
  is shown), `coalescedTask.js` (debounced persistence with max wait),
  `savedTabRestore.js` (source-matched saved tabs + view state applied before
  the first load); `selectionStats.js` also provides the incremental,
  time-sliced selection scan used by the cell detail bar;
  `statusMessages.js` (classifies legacy zh-CN `statusText` messages into
  notice tones — quiet, info, success, warning, error — and maps their
  templates to `status.*` catalog keys for display); `searchKindLabels.js`
  (shared localized labels for schema-search hit kinds); `listSelection.js`
  (shared table-list selection rules, open plans, the open-many guard and the
  Delete / context-menu key checks); `menuKeyboard.js` (arrow/Home/End/Escape
  navigation for context menus); `relationFilter.js` (relation-tab filter
  normalization and JSON list-cell key matching mirrored from the backend);
  `configRelations.js` (relation status/reason copy, coverage gaps, table
  labels, the tab chip, the per-connection capability gate, the row-name
  column mirrored from the backend and the switch-badge summary);
  `relationPanelPrefs.js` (remembered open state of the relation page sections);
  `relationGraph.js` (local relation subgraph by depth/direction, per-pair
  worst-status merge, node sizing, deterministic ring layout and persisted
  graph options); `relationGraphForces.js` (spring simulation anchored to
  the ring layout: link springs, collision, pin/unpin while dragging)

**Components** (`components/`) render panes and dialogs: `WorkbenchActivityRail.vue`,
`WorkbenchSidebar.vue`,
`WorkbenchTabs.vue`, `DataGrid.vue`, `InspectorPanel.vue`, `CellDetailPanel.vue`,
`ContextMenu.vue`, `ConnectionDialog.vue`, import/export dialogs (`ImportWizardDialog.vue` and
`BatchImportDialog.vue`, both with the side-by-side
`BatchImportComparison.vue` / `BatchImportDiffGrid.vue` change-diff view),
`TableDesignEditor.vue`, `DatabaseSyncDialog.vue`, `TableCopyDialog.vue`,
`BackupCenterDialog.vue` (shell + history tab, with the
`BackupSnapshotsPanel.vue` / `BackupSettingsPanel.vue` tabs),
`TableTransferDialog.vue` (one-click table transfer),
`ConfigRelationsPanel.vue` (inspector relation page, composed of
`ConfigRelationRowSection.vue` and `ConfigRelationTableSection.vue` under the
shared `RelationSectionHead.vue`) /
`ConfigRelationsDialog.vue` (review dialog) / `ConfigRelationCard.vue`
(shared relation item: compact list row in the inspector, detailed card in the
dialog, with `RelationStatusBadge.vue` and `RelationEvidenceList.vue`) /
`ConfigRelationGraphSection.vue` +
`ConfigRelationGraph.vue` (local relation graph section and its SVG view,
with `ConfigRelationGraphControls.vue`, `ConfigRelationGraphLegend.vue` and
the enlarged `ConfigRelationGraphDialog.vue`),
`UpdateDialog.vue`, `ShortcutSettingsDialog.vue`,
`PaneDivider.vue`, the `SqlQueryWorkspace.vue` / `SqlCodeEditor.vue` /
`SqlResultGrid.vue` / `SqlHistoryDialog.vue` query surfaces, the
`DatabaseGlowOverlay.vue` switch-database glow layer, and the `Agent*`
panel/message/card components. `DataGrid.vue`
renders only `visibleRows` from `useVirtualGrid`; new grid features must preserve
this virtualized flow.
`GridDataRow.vue` receives per-row selection/edit state and a row version; keep
unchanged row props stable. `useVirtualColumns.js` supplies exact-width spacer
segments shared by headers, comments, drafts and data rows. Logical column
indexes must never be interpreted as rendered DOM positions. Frozen, selected,
editing and selection-endpoint columns stay mounted. `rowStore.js` separates
content versions from identity versions; no-key tables use all columns for
identity. `rowIndex.js` resolves current row objects through the store.
Tab reorder animation measures geometry only while dragging.

Grid regressions: `node scripts/test-grid-columns.mjs` and
`DBSCOUT_GRID_TEST_URL=<preview URL> node scripts/test-grid-insert-drag.mjs`.
Relation page regressions: `node scripts/test-relations-panel-browser.mjs`,
`node scripts/test-relation-graph-browser.mjs` and
`node scripts/test-incoming-relations-browser.mjs` against a Vite dev server
(`DBSCOUT_RELATIONS_TEST_URL`, default `http://127.0.0.1:1431`).
The performance sampler is `node scripts/perf/grid-interaction.mjs --base <URL>
--scenario schema-800x60 --label <name>`; build a production preview first.
Mock performance fixture rows support conflict-checked updates independently of
the ordinary demo data. MySQL default page/search ordering follows primary-index
column order (backend-only `TableMeta.primary_key_order`); explicit sorting keeps
natural order. Audit durability remains FULL.


**Mock data** (`mock/`):
- `mockBackend.js` — Browser-only mock implementing the Tauri command contract
- `mockSchema.js` / `mockRows.js` — In-memory demo database
- `mockEventBus.js` — Emulates Tauri window events for mock mode
- `mockConfigRelations.js` — Demo-mode config-relations index and review
  storage so the feature works in the browser without the Rust backend

### Backend (`src-tauri/src/`)

The Rust backend is split by concern:
- **`main.rs`** — Entry point, calls `lib::run()`
- **`lib.rs`** — Module declarations, Tauri builder, managed `AppState`, system
  tray + global shortcut setup, background schedulers (backup + audit sync +
  table-session janitor), and
  `invoke_handler` command registration
- **`types.rs`** — All request/response structs + `AppState`/`RuntimeState`
- **`commands.rs`** — All Tauri `#[tauri::command]` functions (dual-mode)
- **`db.rs`** — MySQL connection, schema reading, safe SQL construction,
  filtering/sorting, page fetching
- **`clickhouse.rs`** — ClickHouse support over HTTP (`reqwest`), mirroring the
  `db.rs` page/schema/search contract
- **`mongodb.rs`** — MongoDB browse + document CRUD: list databases/collections,
  sample top-level schema, page/search documents, and write by `_id`
  (`updateOne` / `insertOne` / `deleteMany`). Mongo writes do not enter the
  MySQL audit/rollback trail.
- **`demo.rs`** — In-memory demo schema/rows and fallback paging/filtering
- **`table_sessions.rs`** — Leased table-session registry (30-min idle TTL,
  128-cap LRU eviction). A 60s janitor in `commands.rs` prunes expired sessions
  and `remove_connection` invalidates owned sessions; both emit
  `table-sessions-invalidated` so the frontend auto-reopens affected tabs.
- **`ddl.rs`** — Table design metadata + preview/apply of column/index changes
- **`sql_console.rs`** — SQL splitting/classification, cancellable streaming
  execution, MySQL transactions, ClickHouse read-only enforcement, and audit
  integration
- **`sql_history.rs`** — SQLite-backed query history and favorites
- **`sync.rs`** — Database-sync preview + overwrite (emits progress events); destructive sync creates a complete local protection snapshot through `backup.rs` and never creates a temporary database on the MySQL server
- **`table_replace.rs`** — Whole-table import preparation and primary-key identity rules; `replace_table_rows` applies the complete diff atomically with rollback-capable audit entries
- **`replace.rs`** — In-table find & replace: LIKE-prefiltered
  candidate rows + exact in-memory substring matching. `find_in_table`
  (read-only match list) and `replace_in_table` (writes executed through the
  `update_cells` atomic + audited path)
- **`validation.rs`** — Row/primary-key validation shared by write paths
- **`backup.rs`** — Full-database logical snapshots (layer 1): dump, GFS retention,
  restore (with a pre-restore snapshot), import of external .sql snapshot files
  into the snapshot store, exact sync-failure recovery from local protection
  snapshots, plus the background scheduler
- **`audit.rs`** — Change-audit trail (layer 2): before-image + inverse SQL in an
  isolated SQLite DB, with rollback that is itself audited
- **`audit_sync.rs`** — Background outbox that pushes local audit rows to the
  central server (offline-first, idempotent on `client_id`)
- **`account.rs`** — Account/session persistence + central-server client
- **`svn_updater.rs`** — SVN-based in-app updater (config, check, install).
  If no update folder is saved, auto-discovers a `Navicat Pro` release folder under a tools directory (leaf
  must contain `navicat` and include `latest.json`) on non-C drives. When
  several copies exist, pick the one whose latest.json version is newest.
  Windows `resolve_svn_exe` prefers local TortoiseSVN, then PATH `svn.exe`,
  then the bundled client.
- **`table_transfer.rs`** — One-click table transfer: runs the user's conversion script,
  locates the timestamped output package, svn-updates the selected game
  project folder (same as a manual SVN Update on that folder) with automatic
  conflict resolution, and merge-copies the package into `assets`. Commands:
  `table_transfer_pick_script`,
  `table_transfer_pick_project_dir`, `table_transfer_discover_paths`,
  `table_transfer_run`, `table_transfer_cancel`; progress via the
  `table-transfer-progress` event.
  `svn_updater::resolve_svn_exe` is shared (Tortoise first, bundled fallback).
- **`config_relations/`** — Config relations index: which config tables a row
  references and which tables reference it. `comments.rs` reads database
  column comments, `code_scan.rs` statically scans the bound game client's
  source, `formats.rs` recognises list-shaped cell data, and `assembly.rs`
  merges the evidence into relations with statuses (confirmed / unconfirmed /
  stale / conflict / rejected) plus per-table coverage gaps. `engine.rs`
  keeps one index per (connection, database) on the work scheduler — comments
  first, client code and data formats in the background — and republishes
  through the `config-relations-updated` event as steps finish; `store.rs`
  persists client bindings, the post-bind baseline and review verdicts per
  MySQL server in the local `config-relations.json`; `discovery.rs`
  auto-discovers client folders across drives; `rows.rs` resolves row-level
  jump targets and incoming references; `filter.rs` builds the
  relation-filter WHERE clause shared by page/count/search (MySQL and demo
  only — other engines refuse relation filters). Commands:
  `config_relations_overview`, `config_relations_table`,
  `config_relations_graph` (scope-wide relation keys + statuses, no evidence),
  `config_relations_row_targets`, `config_relations_row_references`,
  `config_relations_review_list`, `config_relations_review`,
  `config_relations_refresh`, `config_relations_discover_clients`,
  `config_relations_inspect_client`, `config_relations_bind_client`,
  `config_relations_unbind_client`, `config_relations_pick_client_dir`.
- **`agent/`** — Node sidecar lifecycle (`mod.rs`), stdio JSON-lines protocol
  (`protocol.rs`), DB MCP bridge (`db_bridge.rs`), read-only SQL guard
  (`sql_guard.rs`), and generated-artifact path validation/opening (`artifact.rs`)

Dual-mode: commands inspect the selected connection. MongoDB URLs go to
`mongodb.rs`; ClickHouse URLs go to `clickhouse.rs`; a MySQL pool uses `db.rs`;
with no pool they fall back to `demo.rs`. Mongo write commands must match
before Demo so they never mutate the in-memory demo tables. SQL identifiers
are escaped with `escape_ident()` and user/data values are bound as query
parameters.

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
  platform-specific native CLI binary into `src-tauri/resources/` for local
  development and runtime-package creation; Tauri excludes that binary from
  production installers

Rust side: `agent_runtime.rs` manages the independent integer-version manifest,
local state/rollback, package verification, safe ZIP extraction, and the
`agent-runtime-progress` event. `agent/mod.rs` resolves Node and the native CLI
from that installed runtime (environment overrides remain highest priority),
spawns the sidecar, and routes stdout to `agent-event`
window events, and handles `db_request` / `approval_request`; `agent/db_bridge.rs`
dispatches DB tool requests to MySQL/ClickHouse/demo; `agent/sql_guard.rs`
validates `run_read_query` is read-only and injects/caps `LIMIT`. Agent commands:
`agent_start_session`, `agent_send`, `agent_abort`, `agent_approve_tool`,
`agent_deny_tool`, `agent_set_mode`, `agent_set_auto_approve`,
`agent_list_sessions`, `agent_delete_session`, `agent_get_session_messages`,
plus `agent_runtime_status`, `agent_runtime_check`, and `agent_runtime_install`.

Frontend state lives in `composables/useAgent.js`; UI lives in the `Agent*`
components (`AgentPanel.vue`, `AgentMessage.vue`, `AgentArtifactCard.vue`, `AgentApprovalCard.vue`,
`AgentPlanCard.vue`, `AgentRuntimeCard.vue`, `AgentSessionList.vue`,
`AgentSettings.vue`, …). Runtime checking starts when the AI panel opens;
existing runtime upgrades may install in the background, and never block app
startup or non-AI work.

### UI Layout

Three-pane flex shell: left sidebar (default 292px) | center main pane
(flex, ~400px min) | right inspector (default 322px), with a top tab/tool area
and a bottom status bar. Panes are resizable/collapsible via `PaneDivider.vue`
+ `usePaneResize.js`.

- **Activity rail** — Fixed 40px icon column left of the sidebar that stays
  visible when the sidebar collapses: add connection, then (after a separator)
  quick open, favorite databases, backup center, and table transfer; a settings
  gear is pinned at the bottom edge. Add connection and settings are fixed;
  the tool group between them is press-and-drag reorderable (pointer-based via
  `useActivityRailSort.js`, Alt+Arrow from the keyboard) and the order persists
  in `dbscout_activity_rail_order`. New feature entries go in
  `useActivityRail.js`; the width is shared by `--wb-activity-rail-width` and
  `ACTIVITY_RAIL_WIDTH`. The settings sheet itself stays in
  `WorkbenchSidebar.vue` and teleports to `<body>` anchored at the rail's
  bottom-left.
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
- **Operation feedback** — `statusText` stays the single status channel (and
  the screen-reader live region). Every write is journaled by `useConnection`;
  the orchestrator drains the journal after each task and surfaces failures,
  blocked actions and completed operations as notices. Progress chatter and
  results already visible in place stay quiet. When adding a status message,
  add a rule in `utils/statusMessages.js` if it should notify or be translated.
- **List interactions** — The database home list and the sidebar table list
  share `utils/listSelection.js`: click selects (the sidebar also opens),
  Ctrl/Cmd+click toggles, Shift+click selects a range, Ctrl/Cmd+Shift adds a
  range. Enter, double-click and the context menu act on the whole selection
  when the target row belongs to it; only the row the user acted on becomes
  the active tab and more than 15 tables ask first. Delete (Backspace on
  macOS) deletes after a confirmation, F2 renames, Esc clears and Shift+F10
  opens the menu. Context menus show the key that does the same thing in that
  place (`.wb-context-shortcut`, `aria-hidden`). Destructive confirmations
  focus Cancel; others focus the primary button. F5 is the rebindable
  `refresh` shortcut and must never fall through to a WebView reload.
- **Safety layers** — Writes flow through backup (layer 1) + audit (layer 2); a
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

### Table history and recovery

The local Backup Center audit view is table-first. `AuditTableHistory.vue` and
`useAuditHistory.js` page table summaries, operation groups, and row details;
shared history remains read-only. Audit batches have an `operation_id` and an
expected record count independent of each row's sync `client_id`. Legacy rows
are labelled timestamp buckets, never inferred imports.

`audit_history.rs` serves the three paged history commands. `audit_restore.rs`
provides preview tokens and atomic reverse replay for one MySQL InnoDB table.
It locks and fingerprints the current table, verifies retained history, writes a
pending audit batch and a durable restore journal, then commits and settles the
journal. An uncertain commit is reconciled from before/after fingerprints on the
next preview; unknown outcomes block further restoration. Triggers, foreign keys,
automatic ON UPDATE fields, incomplete history and conflicting data block this
path. `audit_postimage.rs` captures complete inserted rows (including defaults),
with bounded batch reads and reuse of already fetched interactive insert rows.

Checks: `node --test src/workbench/useAuditHistory.test.js`,
`cargo test --manifest-path src-tauri/Cargo.toml audit --lib`, and
`node scripts/test-audit-history-browser.mjs` against a fresh Vite dev server
(`DBSCOUT_AUDIT_TEST_URL`, default `http://127.0.0.1:1431`). Browser test screenshots
use `DBSCOUT_AUDIT_SCREENSHOTS` (default `/tmp/blackcat-audit-review`).

### Localization and privacy

The interface supports English, Simplified Chinese and Traditional Chinese (Taiwan) through
`src/workbench/i18n/`. New installations default to English; an existing
workbench preference without an explicit language preserves Chinese.
The sidebar settings switch language without reloading database sessions.
Translate application-owned copy only, never query text, database values,
connection names, user aliases or file paths. Catalog key parity and live
switching are regression-tested. Some legacy dynamic/native messages still
need catalog migration; do not claim complete English coverage.

SVN is the application and AI-runtime update channel. Do not reintroduce a
GitHub/Gitee release updater. Ordinary dependency sources and issue-tracker
links are unrelated to the updater and remain valid. The legacy installed
product name and application identifier are retained for upgrade continuity.
Use English for new comments and developer documentation, and keep personal
paths, author identity and organization-specific default endpoints out of source.
The Tauri CLI wrapper remaps Rust source paths in future builds; old binaries
are not sanitized retroactively.
