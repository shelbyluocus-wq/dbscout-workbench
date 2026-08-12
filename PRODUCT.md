# Product

<!-- impeccable:product-schema 1 -->

## Platform

desktop (Windows and macOS)

## Users

DB Scout Workbench is for developers, database operators, and technical users who inspect, debug, maintain, and synchronize database data from a desktop workbench. They often work in focused, long-running sessions that involve moving between connections and databases, scanning large tables, making targeted edits, reviewing file imports, and checking the result before a change is applied.

## Product Purpose

DB Scout Workbench is the development name for the cross-platform desktop database workbench shipped as **黑猫**. It brings database browsing, editing, querying, schema work, import/export, synchronization, recovery, and optional AI assistance into one workspace.

Success means users can move from finding data to making a verified change quickly, without losing their place or being left unsure about loading, pending work, failures, or destructive consequences.

## Positioning

黑猫 combines everyday database work with preview-first bulk operations and built-in recovery. Imports and synchronization can be reviewed before execution; full-database snapshots and an independent change-audit trail provide two separate recovery paths. An optional shared audit service and an approval-gated AI assistant extend the same workspace without making them prerequisites for normal database work.

## Operating Context

- The product runs as a Windows and macOS desktop application in a Tauri shell, with a Vue-based workbench interface.
- Users work through persistent connections, database and table tabs, a dense data grid, a SQL workspace, schema tools, and import/export dialogs.
- The application opens with built-in demo data when no database is configured. Real databases can be connected from the application; development can also provide a MySQL connection through `DBSCOUT_MYSQL_URL`.
- Import and synchronization work is review-driven: users select data, inspect the expected result, then explicitly start the write.
- Optional central-account, updater, and AI-runtime services may be unavailable or slow. Core database work must remain usable without waiting for them.

## Capabilities and Constraints

- MySQL is the primary read/write engine. ClickHouse is also supported, with read-only enforcement where writes are not allowed.
- Table work includes paging, filtering, sorting, search, find and replace, inline edits, row insertion and deletion, undoable whole-table find-and-replace, and XLSX/CSV import and export.
- Single-table and batch Excel imports provide a side-by-side comparison before synchronization. Users can switch between changed rows and all rows, show or hide primary-key columns, search cell values with exact, continuous, or fuzzy matching and move between hits, enter fullscreen comparison, and adjust synchronized field widths across both sides.
- Schema and transfer work includes visual table design, table copy and rename, batch transfer, and database synchronization with reusable exclusions.
- Destructive database synchronization creates a local protection snapshot. Successful writes also enter an isolated audit trail that can be reviewed and rolled back.
- Optional login can aggregate audit records across workstations. The built-in AI assistant keeps read-only database work automatic, requires approval for writes and file creation, and installs its large runtime on demand instead of bundling it into the main application.
- Foreground actions must deliver usable content first. Background prefetch, metadata, totals, cache filling, runtime updates, and other secondary work must not delay an immediate user action.
- Responsiveness must never be bought by weakening correctness, consistency, validation, or data safety.

## Brand Commitments

- The installed product name is **黑猫**; the project and development name is **DB Scout Workbench**; the application identifier is `com.dbscout.workbench`.
- The product voice is quiet, precise, and capable. It should feel like a trustworthy work instrument rather than a marketing surface.
- The interface is intentionally dense, calm, and explicit about state, errors, pending edits, and destructive actions.
- Cat-eye teal is the signature brand accent. The shipped color-theme choices are slate, teal, and azure, with light and dark appearance support.

## Evidence on Hand

- The runnable frontend and desktop backend live in `src/workbench/` and `src-tauri/`.
- Built-in demonstration schemas and rows live in `src/workbench/mock/`, so product flows can be exercised without a configured database.
- Product behavior is covered by the recursive workbench tests under `src/workbench/` and the browser-oriented scripts under `scripts/`.
- Desktop identity and Windows/macOS bundle targets are recorded in `src-tauri/tauri.conf.json`; release behavior is documented in `README.md` and `AGENTS.md`.
- No confirmed customer testimonials, usage benchmarks, case studies, pricing, or licensing claims are present in the repository. Future product material must not fabricate them.

## Product Principles

1. Put usable content first: foreground database work must stay responsive even when secondary work is still running.
2. Keep correctness and recovery non-negotiable: validate writes, preview broad changes, and preserve reliable recovery paths.
3. Keep users in context: stable tabs, panes, keyboard behavior, selection, and scroll position matter during long sessions.
4. Make state and consequences obvious: loading, pending saves, errors, filters, comparison scope, and destructive actions must be unambiguous.
5. Prefer focused workbench capability over decoration: every product decision should help users inspect, compare, edit, query, or recover data.

## Accessibility & Inclusion

The default target is WCAG AA. Keyboard access, visible focus, sufficient contrast in light and dark appearances, non-color-only state indicators, and reduced-motion alternatives are production requirements.
