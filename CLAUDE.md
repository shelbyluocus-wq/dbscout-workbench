# CLAUDE.md

External MCP navigation: `get_mcp_capabilities` exposes the tool catalog and live
desktop capabilities/permissions; `list_connections` discovers credential-free
targets. Context reads fetch fresh viewport/selection state without revealing the
window. `scroll_table` browses actual grids; complete-primary-key focus can open a
separate exact-key tab without clearing the original filters. Batch actions default
to compact results and fast execution; optional demo mode labels/pauses steps.
See `docs/local-control-connections.md` for limits and verification commands.

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

## Typography

Interface text uses six tokens defined in `workbench.css` `:root`:
`--wb-fs-micro` (fixed-size badges/counters/kbd glyphs), `--wb-fs-caption`
(hints, meta, secondary text), `--wb-fs-body` (default controls/grid/menus,
13px), `--wb-fs-title` (section and dialog titles), `--wb-fs-heading`
(page/panel headings), `--wb-fs-display` (empty-state heroes). Never hard-code
`font-size` in CSS, `<style>` blocks, or inline styles — use a token;
`src/workbench/typographyTokens.test.js` enforces it.

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
  (Windows: `.exe/.bat/.cmd/.lnk`; macOS: Bash `.sh/.command`, manually selected;
  `.lnk` resolved via PowerShell COM, script stdin is
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
- **Release workspace** — the activity-rail Release entry (below one-click
  table transfer) opens a lazily loaded workspace for every platform's
  updates. A board on the left shows each platform as a note (state: not
  scheduled / scheduled / updating / needs attention / done, progress, last
  and planned update, the first issue such as a failed step, SVN conflicts,
  files a sync missed, steps to run again or a missed start); clicking one
  opens its update, whose steps unfold under its note. Each platform has at
  most one update on its card, with its own progress, schedule and demo GM
  clock, so several platforms run side by side; New update asks for the
  platform and, when it still has an open update, whether to continue it or
  abandon it (kept in the history). A finished update is written to the
  history once and stays read-only on its card until the next update.
  Header pages, opened from anywhere and returning to the update they were
  opened from: the overview (what needs attention, open and scheduled
  updates, open plans of the coming week, recent records, quick actions),
  the history (every update with its steps, results, errors, warnings and
  last log lines, every client build and SVN operation; filtered by platform
  and kind, simulated entries marked Demo), open plans, client build, SVN and
  platform settings. An update's brief (date, maintenance or no-downtime,
  and which of database / client / server / activities it contains) decides
  which steps apply. The GM steps follow the jswz GM's own flows (source in
  a separate GM repository; every platform's live servers have their own
  GM). Then: one database page (overwrite sync into the platform's intranet
  relay database, never the live one, with kept
  tables chosen from a styled suggestion list; the overwrite backs the
  relay database up first and its backup offers a confirmed restore that
  resets the overwrite and what was built on it, while a change already
  applied on the platform is rolled back there with the previous config
  version; then the open plan written
  as one UPDATE per table and direction, composite keys as row-value IN,
  rows the person leaves out skipped); SVN update with a choice per
  conflicting file; file sync with gitignore-like exclusion rules
  (`.svn/` always excluded) listed by kind, edited in place, and added by
  typing or with the native file or folder dialog, which opens in the client
  folder and only accepts paths inside a client folder of the sync (checked
  after resolving `..` and links, anchored as `/name/`); table conversion
  with a one-click transfer template whose settings show and can change
  there, new templates made there too (the same store as the transfer
  dialog), log kept open; the diff review on the shared SVN view (below)
  over a simulated working copy; the Cocos build; GM preparation while the
  servers run (a config version the company GM packs from the relay
  database and sends to the platform's GM; the activity table uploaded and
  scheduled as the next version; the hot update uploaded to the company GM,
  confirmed and synced, named `ver_<platform>_<version>.zip`; the server
  version the company GM builds from SVN and syncs; activities are reloaded
  only without downtime), all of which the pre-maintenance waits for, as
  the GM's maintenance checklist does; and the last page. With maintenance
  that page is a live server console: schedule the pre-maintenance together
  with the hot update's opening (both or neither), wait on a countdown while
  the monitors close the servers by themselves at the start time (an `auto`
  task that only watches the zones: one not finished waits for a retry, one
  cut off by closing the workspace runs again), apply the server version
  and the config version (confirmed), start the zones still closed to
  players and check them, then open; a hot update that follows maintenance
  opens with an early reopening. Without downtime the page applies the
  config version, has the servers read it again and sets the hot update's
  opening. One-click mode runs a whole update by itself: the brief's panel
  holds the times and the rules for what it meets (SVN conflicts, files the
  sync missed, a conversion that still fails, the diff review, unreadable
  plan notes, the config apply, a passed maintenance start, opening the
  servers; retries and their delay), shared by every platform; the run
  pauses where a rule says stop or a step fails past its retries (build
  checks, the release guard and failed zone checks always stop; the
  servers are never opened then), a bar above the page shows what it does,
  why it paused and its log, cards tag it, and it goes on where it was
  when the workspace opens again. Open plans are a memo the team keeps (no
  table is read): entries (hero, mount, spirit, battle pet, feature or other;
  name and optional ID) are added, edited and deleted, with every platform's
  free-text note ("10/28 開放", "10/28-11/30 開放", "11/30 關閉", "已開放",
  "暫不開放", a date picker writes the usual form) parsed and judged for a
  date; entries with a category table and a complete ID are written,
  others (and unreadable notes) are listed to do by hand. The client build
  is real (backend below): the build step and the client build page share
  the settings and checks (project engine from `package.json`
  `creator.version` or 2.x `project.json`, editors found next to the project,
  in Cocos Dashboard folders, or in the Dashboard's installed-editor list,
  platform per 2.4 / 3.x, exported build
  configuration, output folder, a family mismatch blocks and a version
  mismatch warns), confirm the project, versions, platform and output folder
  (and an overwrite) before starting, stream the editor's output, run the
  project's `qa-tests/QAReleaseGuard.mjs` on the output, and record the
  build; the build page builds a platform's client (or another folder) on
  its own and, when that platform's update has not reached its build step,
  asks "目前尚未執行完整的版本更新流程，確定要直接打包客戶端嗎？". The SVN view
  (after the Cairn client's: changes in conflict / changed / unversioned
  groups with check boxes, a side-by-side or unified diff with line numbers,
  in-line highlights and previous/next change, commit adding unversioned and
  deleting missing files, confirmed revert, conflict resolution, log) runs
  real svn on the SVN page and a simulated working copy on the diff step.
  Every other step runs through a driver (`run(taskId, context, io)`): the
  build step through `createReleaseBuildDriver`, the rest through
  `releaseFlowDemoDriver.js`, which touches no database, file, working copy
  or GM; the header badge, page chips, confirmations and history entries
  say which is simulated (in the browser preview the mock backend simulates
  the build and SVN too and says so). Real integrations replace the demo task
  by task. Demo content uses the jswz client's real table, item, file and
  folder names (`newsg_4cfg`, `heroprop`, `buildopenplatprop`, platforms
  抖音 / TAP / 玩心 / TW); platform databases and folders, backups, the
  changes themselves, versions, GM replies and the seeded history are
  simulated, and the client's server settings (`Config.ts` endpoints and
  keys) are never copied into source. The workspace (platforms, memo,
  rules, updates, view) persists in `dbscout_release_flow_v3` and the history
  separately in `dbscout_release_history_v1`; a started v2 draft becomes an
  update; rerunning or editing the input of a finished task resets the tasks
  built on it.
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
  do not reference the row are hidden, with no zero-reference toggle or list.
  Unknown and pending counts stay visible. Composite-key jumps
  match every key, and a jump to referenced rows selects the first of them so
  the chain can be followed. `IncomingRelationRows.vue` renders these lines
  and `incomingRelationRows.js` owns their paging and stale-request guards.
  **Relation map** draws the current table's neighbours (depth 1–2) on a
  dot-grid canvas, circles tinted by side (tables it references / tables
  referencing it, whose switches double as the colour key) and lines
  coloured by relation status. Up to 60 tables it is a ring view (SVG):
  second-ring tables gather beside the table that brought them in, lines
  bow around tables in their way and every name takes the side of its table
  that keeps lines and arrowheads clear (busy tables choose first, a side is
  kept unless another is clearly better); in a crowded ring, names that
  would pile up or be cut off at the edge wait until zooming in makes room
  (the current table, the hovered one and its neighbours keep theirs).
  Past that (a hub's neighbourhood, up to thousands of tables) it is a
  large-graph view after Obsidian's graph view: a force layout (d3-force
  with typed-array many-body and collision forces) runs in a worker and
  streams positions, keeping generous room around every table and steering
  the picture toward the shape of its view as it settles (a wide window gets
  a wide picture, never a flat band), and one canvas draws only what is on
  screen, lines batched by colour, circles that shrink slower than the zoom
  (round dots when small, squares once thousands are in view), names that
  fade in with the zoom (busier tables first, never piled up, no more than
  the view has calm room for, clear of the tool strip) and arrowheads once
  they can be seen; drawing stops when nothing moves. A fresh picture starts
  in rings by distance and grows from the middle, a picture seen before in
  the session comes back at rest (stretched and eased into a view of
  another shape, such as full screen), and a changed graph only adjusts
  (new tables start beside their neighbours).
  When painting a frame costs more than a frame (no graphics acceleration),
  camera moves reuse the last sharp picture and highlights switch at once.
  A depth switch always announces what it changed (how many tables depth 2
  adds, or that it adds none) and a quiet note shows while a large layout
  settles. Clicking a node opens that table. Tables can be dragged anywhere
  and stay where they are dropped (one table per frame keeping the grab
  offset; in the large view only the small tables hanging on it follow
  while every other table holds still, so the picture never turns or
  shivers; arrow keys nudge a focused table in the ring view) for the
  session, in the inline and full-screen views alike, until "restore layout"
  (which moves just the released tables back); the wheel zooms around
  the pointer (eased, about 1.5× per notch in the large view, where a
  released pan coasts), fitting never enlarges a small graph past a
  readable scale and takes in dragged tables, a find box brings a table into
  view and pins it, the bottom edge resizes the graph (height remembered)
  and a help button explains the gestures. Full screen covers the whole
  window, stretches the rings to the room instead of enlarging circles and
  names, shows comments under names and the fields of the active table's
  lines, widens from the table to the whole database on request, and lets a
  pinned table become the new center (one button leads back). The info card
  lists the hovered table's drawn relations grouped by the other table
  (fields beneath, status per field) in the half or corner away from that
  table; right-clicking a table (or Shift+F10) pins it with actions (open,
  center on it in full screen, unpin), and in a narrow graph the pinned card
  docks under the canvas. Right-clicking the pinned table, the card or empty
  space unpins (Esc lets go of a pin before it closes full screen); every
  right-click in the graph is consumed, so neither the app's, the WebView's
  nor the system's menu opens there. **Field relations** lists every
  relation by direction, waiting decisions first; each row opens its
  evidence (comment text, client code file:line with the line itself, data
  sample). On the relation page and in the review dialog, hovering (or
  keyboard-focusing) a table or field name floats a small card with its
  comment (`CommentTip.vue`, opted in via `commentTips.js`); fields of the
  relation map's info card offer it once the card is pinned. Relation
  responses' table labels carry the comments of the columns their relations
  use (`columns`, lowercase name -> comment).
  A slim notice appears only when the client folder needs binding;
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
- **Page zoom** uses macOS `Cmd` / Windows `Ctrl` with `+` (or `=`), `-`, and
  `0` (reset), in 10% steps from 50% to 200%, through native WebView zoom.
  These fixed shortcuts work inside editors and dialogs, are listed in shortcut
  settings and the macOS View menu, and leave graph wheel/pinch zoom untouched.
  Holding the same platform modifier while scrolling the wheel also zooms the
  page (up enlarges, down shrinks); plain scrolling and relation-graph gestures
  stay unchanged. `Cmd` / `Ctrl` + `0` resets to the default 100% size.
- **Desktop integration** — system tray with hide-to-tray, global shortcut
  (`Alt+Shift+F`) to toggle the window, light/dark theme, a switchable color-theme system (slate / teal /
  azure presets with a settings-drawer picker), and an SVN-based
  in-app updater. On macOS the app additionally behaves like a Mac app:
  a native menu bar built from `utils/nativeAppMenuModel.js` +
  `composables/useNativeAppMenu.js` (labels/accelerators come from the live
  i18n catalogs and shortcut bindings; ⌘W falls back to hiding the window
  when no tab is open), macOS default shortcuts (`⌘T` new SQL tab,
  `⌥⌘F` replace, `⇧⌘]`/`⇧⌘[` tab cycling — physical `Ctrl+Tab` still cycles
  as a fixed alias), a one-time localStorage migration that rewrites stored
  Windows-era defaults, Apple-order shortcut glyphs (`⌥⇧⌘P`), Finder wording
  via `.macos` catalog variants (`utils/platformLabels.js` `tPlatform`),
  a dropped traffic-light clearance in native fullscreen, and a
  title-bar double-click that follows `AppleActionOnDoubleClick`
  (`src-tauri/src/macos_appearance.rs`; the injected drag-region double-click
  is swallowed so it does not toggle twice — the swallow matches Tauri's own
  target check so double clicks on tabs inside drag regions still work).
  Appearance: Light/Dark/Follow system (`setThemePreference`; "system"
  removes the stored key and follows prefers-color-scheme, also in the
  显示 menu as three check items); a macOS-only "sidebar blur" setting
  (localStorage `dbscout_macos_vibrancy`, `useMacosVibrancy.js`,
  `macOSPrivateApi` + `transparent` macOS window + `setEffects(Sidebar)`,
  `is-vibrancy` root class — only the rail/sidebar/sidebar titlebar get
  translucent `--wb-vibrancy-*` tints, everything else stays opaque);
  a "system accent" color-theme preset (`macos_accent_color` command reads
  `AppleAccentColor`, `systemAccentTheme.js` derives the accent tokens and
  picks control text by luminance; re-read on window focus while active,
  unavailable outside Tauri macOS and falls back to slate);
  `data-wb-platform="macos"` on `<html>` drives Mac font stacks, smaller
  rounded scrollbars, `overscroll-behavior:none`, and native-style popup
  menus (translucent + backdrop blur); relation maps support trackpad
  pinch (WebKit gesture events and proportional ctrl+wheel).

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
bump + notes summary + package + commit/push to main) only when the user explicitly
requests "打包流程". On macOS, a plain "打包" request means building the current
working-tree code and installing it locally, without an SVN path, version bump,
or automatic commit/push. Lower-level helpers are
`npm run release:sync-version` (sync application versions) and
`npm run release:svn-manifest` (generate the SVN updater manifest). There is no
lint script defined in `package.json`. `release:package` rejects a Windows
installer larger than 20 MB or any configuration that puts Node / the native
Claude CLI back into the main bundle. Windows builds fetch a pinned Apache
Subversion command-line client into `src-tauri/resources/svn/` (`npm run
ensure-svn` / `npm run fetch-svn`) and ship it with the installer so in-app
updates work without a system `svn.exe`. The default 1.14.5 client and the
1.9.7 SSL compatibility client (`svn/compat-1.9.7/`) ship with separate DLLs
and licenses; both downloads have pinned sizes and hashes.

To launch the full app against a real MySQL server:

```bash
export DBSCOUT_MYSQL_URL="mysql://user:password@127.0.0.1:3306"
npm run tauri -- dev
```

### On-demand AI runtime (agent sidecar)

The external Blackcat MCP endpoint exposes data mutations through
`run_write_query` (single INSERT/UPDATE/DELETE/REPLACE), table copy/rename/drop,
and table design through `get_table_design`, `preview_table_design_change` and
`apply_table_design_change`. New mutation tools require explicit connection and
database targets and `confirmed=true`; the calling AI is responsible for obtaining
the user's authorization. `control_table_tools.rs` validates these requests at the
backend boundary and reuses desktop command implementations. Design apply requires
the original draft and preview signatures, preserving stale-schema rejection.
Column drafts accept optional `unsigned`: true/false explicitly changes numeric
signedness; omission preserves existing signedness and defaults new columns to
signed. Inline `int unsigned` / `int signed` is also supported; conflicting
settings and unsigned nonnumeric types are rejected. Signedness changes take
part in data compatibility checks, SQL previews and preview signatures.
Read-only engines remain protected. `refresh_table` updates the visible table
after changes. Only the existing XLSX import automatically creates a backup;
other mutations do not add automatic backups or promise one-click undo.
The activity rail's 黑猫 MCP entry opens a dialog with the master switch plus
four coarse permission groups — 打开和定位表 (open/focus UI actions), 修改数据
(writes and whole-table import), 修改表结构 (design apply), and 复制、重命名和
删除表 — enforced at the control endpoint and persisted in
`control-config.json` alongside `enabled`; all groups default to on.
`refresh_table` is never gated, but while navigation is off it no longer pulls
the window forward. While the external MCP drives the workbench, a soft inner window-edge
glow (`AiActivityGlow.vue`, fed by `control-activity` events) signals activity —
calmer for reads/UI, stronger during writes — and UI actions surface the window
passively (visible windows are never focused; hidden ones only un-minimize, so
the AI never pops the window over the user). The navigate group 操作黑猫界面
also covers `select_database`, `open_sql` (read-only when `run`), `select_range`,
open_table `filter`/`filterMode`/`sort`, and the `run_ui_actions` batch tool.


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
- `releaseFlowState.js` — One update's pages, tasks (including the
  automatic shutdown and the database restore action), dependencies,
  scope/mode applicability, invalidation and restore of saved tasks
- `releaseAutopilotState.js` — One-click mode: its rules (choices,
  defaults, restore), an update's one-click state and log, and the decision
  of what a run does next
- `releaseWorkspaceState.js` — Release workspace: platforms, the open-plan
  memo, rules, updates (one per platform), view, card states and issues,
  history entries and their compaction, v2 migration and storage
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
- Release workspace: `useReleaseWorkspace.js` — the workspace state and its
  persistence, one live flow per update, cards, view and way back, creating,
  continuing and abandoning updates, the history, the open-plan memo,
  platform and build-target settings and the demo options;
  `useReleaseFlow.js` (`createRunFlow`) — one update's brief, per-task input,
  logs, results and events, run/cancel/skip through the driver, resets
  after input changes, backup/restore, and its GM clock (injectable `ticker`,
  per-update demo fast-forward) that starts the shutdown;
  `useReleaseAutopilot.js` (`createAutopilot`) — the one-click runner that
  drives a flow through its own actions, retries, pauses and resumes;
  `useCocosBuild.js`
  — the real build backend, the build step's driver, `composeDrivers`, the
  build confirmation and the build page's state; `useSvnWorkspace.js` — the
  SVN view's state over a backend or demo source. Helpers in `utils/`:
  `releasePlanNotes.js` (note parsing, date judgement, plan diff and
  per-table statements), `releaseFileRules.js` (exclusion rules, rule kinds,
  picked paths), `releaseServer.js` (server phases, maintenance stages,
  countdowns and schedule times), `cocosBuildCommand.js` (Cocos options,
  command line, platforms, output folders, checks and exit codes),
  `unifiedDiff.js` (svn diff parsing, side-by-side rows and in-line
  highlights), `releaseFlowDemo.js` / `releaseFlowDemoTables.js` /
  `releaseFlowDemoDriver.js` / `releaseSvnDemo.js` / `releaseWorkspaceDemo.js`
  (sample content, the config table catalogue, the simulation, the demo
  working copy and the seeded history), `releaseFlowFormat.js` and
  `releaseHistoryFormat.js`; copy in `i18n/releaseFlowMessages.js` and
  `i18n/releaseWorkspaceMessages.js` ([en, zh-CN, zh-TW] per key)
- Config relations: `useConfigRelations.js` — mirrors each scope's relation
  overview, refreshes on `config-relations-updated`, and serves the
  table/row lookups plus the per-revision cached scope graph;
  `useGraphViewport.js` / `useGraphArrangement.js` — ring-view zoom/pan
  with glide animation and a measured-width fit, and where tables are drawn
  (ring layout plus session-remembered dragged tables, gliding between
  pictures); `useGraphDepthNotice.js` — the line announcing what a depth
  switch changed;
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
  `commentTip.js` (placement and warm-up timing of the table/field comment card);
  `relationGraph.js` (local relation subgraph by depth/direction and the
  whole-database graph, per-pair worst-status merge, node sizing,
  deterministic ring layout with an optional stretch, parent-grouped second
  ring, card grouping, depth notices and persisted graph options);
  `relationGraphGeometry.js` (ring view: layout stretch for large views,
  line routing around tables, name-side placement clear of lines and
  arrowheads, info-card placement and glide starts); `relationGraphCard.js`
  (the info card's content); for the large-graph view
  `relationGraphModel.js` (typed-array graph and starting positions),
  `forceLayout.js` + `fastForces.js` + `forceLayoutAlpha.js` (the force
  layout, run by `workers/relationGraphLayout.worker.js` or a main-thread
  fallback), `relationGraphLayout.js` (that runner and the session memory of
  laid-out graphs), `relationGraphCanvas.js` (frame drawing, zoom-dependent
  detail, hit testing) and `graphCamera.js` (eased wheel zoom, coasting pan,
  fit)

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
`ReleaseFlowDialog.vue` (release workspace shell with the `ReleasePlatformBoard.vue` board; `ReleaseRunView.vue` shows an update, the workspace pages and shared parts such as `ReleaseSplitDiff.vue`, `ReleaseSvnWorkspace.vue` and `ReleaseBuildPanel.vue` are the other `Release*.vue` components),
`ConfigRelationsPanel.vue` (inspector relation page, composed of
`ConfigRelationRowSection.vue` and `ConfigRelationTableSection.vue` under the
shared `RelationSectionHead.vue`) /
`ConfigRelationsDialog.vue` (review dialog) / `ConfigRelationCard.vue`
(shared relation item: compact list row in the inspector, detailed card in the
dialog, with `RelationStatusBadge.vue` and `RelationEvidenceList.vue`) /
`ConfigRelationGraphSection.vue` +
`ConfigRelationGraphView.vue` (local relation graph section; the view picks
the ring view `ConfigRelationGraph.vue` (SVG) or the large-graph
`ConfigRelationGraphCanvas.vue`, both inside the shared
`ConfigRelationGraphFrame.vue` with its tool strip, the
`ConfigRelationGraphFind.vue` find box and the `ConfigRelationGraphCard.vue`
info card; `ConfigRelationGraphSegment.vue` switches depth and scope, with
`ConfigRelationGraphLegend.vue` and the full-screen
`ConfigRelationGraphDialog.vue`),
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

Grid regressions: `node scripts/test-grid-columns.mjs`,
`DBSCOUT_GRID_TEST_URL=<preview URL> node scripts/test-grid-insert-drag.mjs`
and `node scripts/test-grid-delete-browser.mjs` (against a Vite dev server,
`DBSCOUT_GRID_DELETE_TEST_URL`). Refreshes after rows change in place
(delete, insert, paste, replace, import) fetch the loaded row window again
from where it is (`fetchPage(..., { inPlace: true })`), so a grid scrolled far
down keeps its place; an explicitly requested page is drawn at its own
position in the table.
Relation page regressions: `node scripts/test-relations-panel-browser.mjs`,
`node scripts/test-relation-graph-browser.mjs`,
`node scripts/test-relation-graph-large-browser.mjs` (the generated relation
lab, `DBSCOUT_RELATION_LAB_SIZE`, default 2000) and
`node scripts/test-incoming-relations-browser.mjs` against a Vite dev server
(`DBSCOUT_RELATIONS_TEST_URL`, default `http://127.0.0.1:1431`).
Release workspace regressions: `node --test src/workbench/useReleaseFlow.test.js
src/workbench/releaseFlowState.test.js src/workbench/releaseWorkspaceState.test.js
src/workbench/releaseAutopilotState.test.js src/workbench/releaseFlowCopy.test.js src/workbench/useCocosBuild.test.js
src/workbench/useSvnWorkspace.test.js` plus the `utils/release*.test.js` /
`cocosBuildCommand.test.js` / `unifiedDiff.test.js` units, `cargo test
--manifest-path src-tauri/Cargo.toml --lib -- cocos_build svn_workspace
release_paths` (the SVN round trip runs against a local repository when
`svn`/`svnadmin` are installed), and `node scripts/test-release-flow-browser.mjs`
against a Vite dev server (`DBSCOUT_RELEASE_TEST_URL`, default
`http://127.0.0.1:1431`).
The performance sampler is `node scripts/perf/grid-interaction.mjs --base <URL>
--scenario schema-800x60 --label <name>`; build a production preview first.
Large relation graphs: `node scripts/perf/relation-graph.mjs --base <URL>
--sizes 500,2000,5000 --label <name>` (first open, reopen, zoom, pan, hover
and drag frame times on the relation lab).
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
- `mockReleaseTools.js` — Browser-preview stand-ins for the release
  workspace's real tools (exclusion picker, SVN working copies, Cocos
  builds); answers are marked `simulated`, and tests choose the picked path
  through `globalThis.__dbscoutMockPick`
- `mockRelationLab.js` — the generated relation lab: `?relationLab=<tables>`
  (50–5000) adds a deterministic `relation_lab` database to the demo server,
  with hub tables, modules, list cells, conflicts and stale relations

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
- **`svn_client.rs`** — Shared SVN execution for updates and table transfer.
  Retries an update once with the other client only for `E120171` SSL
  communication failures, never certificate validation/authentication/conflict
  failures. Successful choices are remembered per HTTPS origin in
  `svn-client-preferences.json` in the app config directory (survives upgrades).
  Local commands use the selected client; conversion scripts are never replayed.
- **`table_transfer.rs`** — One-click table transfer: runs the user's conversion script,
  locates the timestamped output package, svn-updates the selected game
  project folder (same as a manual SVN Update on that folder) with automatic
  conflict resolution, and merge-copies the package into `assets`. Commands:
  `table_transfer_pick_script`,
  `table_transfer_pick_project_dir`, `table_transfer_discover_paths`,
  `table_transfer_run`, `table_transfer_cancel`; progress via the
  `table-transfer-progress` event.
  `svn_updater::resolve_svn_exe` is shared (Tortoise first, bundled fallback).
- **`release_paths.rs`** — `release_pick_exclusion`: the native file or
  folder dialog for an exclusion rule, opening in the client folder; the
  choice is classified after resolving `..` and links and refused outside the
  sync's client folders or as a client folder itself.
- **`svn_workspace.rs`** — The SVN page's working-copy commands
  (`svn_wc_info`, `svn_wc_status`, `svn_wc_file_diff`, `svn_wc_commit`,
  `svn_wc_revert`, `svn_wc_resolve`, `svn_wc_log`, `svn_wc_pick_folder`)
  through `SvnClient::run_targets` (options before `--`, paths inside the
  working copy only, `--internal-diff`, commit messages from a UTF-8 file;
  unversioned choices are added and missing ones deleted before a commit).
  XML output is read with `roxmltree`; errors read `code: detail`
  (notWorkingCopy, outOfDate, locked, auth, network, conflict, failed).
- **`cocos_build.rs`** — Cocos Creator command-line builds: project engine
  version, build configurations, editors next to the project, in Cocos
  Dashboard folders, or in the Dashboard's installed-editor list, one build at a time (`cocos_build_start` /
  `cocos_build_cancel`, process tree stopped on cancel) with
  `cocos-build-progress` lines, exit codes per 2.4 / 3.x, the output folder,
  and the project's release guard run with Node.js; plus
  `cocos_inspect_project`, `cocos_find_editors`, `cocos_output_status` and the
  `cocos_pick_*` dialogs. `test_temp_dir.rs` is the shared test folder.
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
  `parser.rs` and the frontend `utils/referenceParser.js` share explicit
  parsers for comma/pipe key lists, scalar JSON arrays, flat JSON members,
  conditional ENC members and open-condition prefixes. `project_formats.rs`
  holds schema-gated client conventions; numeric arrays alone never establish
  foreign keys. Counts, expanded incoming rows and filtered tabs carry the same
  parser. Unsupported dynamic expressions stay unchecked, not missing; client
  functions are never executed. Rare condition branches are probed only in the
  background. Shared fixtures live in `tests/fixtures/config-reference-formats.json`.
  `project_relations.rs` holds audited jswz mappings and scoped corrections;
  `constraints.rs` / `relationConstraints.js` apply type guards to outgoing
  targets, incoming counts, expanded rows and tab filters. Restricted nested
  JSON paths, selected tokens and prefixed keys have shared Rust/JS fixtures.
  Nested inverse filters require JSON_TABLE support; failures remain unknown,
  not zero. Function/context-dependent fields show incomplete coverage.
  See `docs/config-reference-formats.md` for read-only export/SQL/browser replay
  commands and `docs/jswz-relations-audit-2026-10-23.md` for the per-table audit.
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
  quick open, favorite databases, backup center, table transfer and the
  release guide; a settings gear is pinned at the bottom edge. Add connection
  and settings are fixed;
  the tool group between them is press-and-drag reorderable (pointer-based via
  `useActivityRailSort.js`, Alt+Arrow from the keyboard) and the order persists
  in `dbscout_activity_rail_order`. New feature entries go in
  `useActivityRail.js`; the width is shared by `--wb-activity-rail-width` and
  `ACTIVITY_RAIL_WIDTH`. A fixed More button below the tool group opens a
  right-side menu for database sync, sending tables, batch import/export and
  relation review. It snapshots the focused page's database and home selection;
  unsupported actions are disabled. `WorkbenchMoreMenu.vue` owns its popup.
  The settings sheet itself stays in
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
  place (`.wb-context-shortcut`, `aria-hidden`). Text inputs get selection-aware
  Copy/Paste before page menus, including in dialogs; `textInputClipboard.js`
  preserves native insertion/undo and refuses stale asynchronous pastes. The
  cell-detail editor retains its own draft-aware menu. Destructive confirmations
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
