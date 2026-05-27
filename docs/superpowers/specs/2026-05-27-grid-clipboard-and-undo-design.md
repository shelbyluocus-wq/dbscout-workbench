# Grid Clipboard And Undo Design

**Status:** Approved on 2026-05-27

## Goal

Improve data-grid editing with spreadsheet-style interactions while retaining
database-safe semantics:

- Treat the bottom insert row as selectable cells before editing begins.
- Allow rows copied from the grid to be pasted as one or more new records.
- Let `Delete` clear selected data cells without entering edit mode.
- Add row-header context-menu operations for copying, deleting, and pasting
  copied rows as new records.
- Extend undo from single-cell edits to all user-facing data mutations in this
  feature area.

The application remains a database editor, not a positional spreadsheet.
Inserting records does not imply a stable display position after the active
sort and filter are reapplied.

## Interaction Model

### Persisted Cells

- A single click selects a cell and displays the existing selection outline.
- Double-click, `Enter`, `F2`, or printable keyboard input starts cell editing.
- Pressing `Delete` while one persisted cell is selected saves an empty string
  (`""`) to that cell immediately.
- Pressing `Delete` while a rectangular persisted-cell range is selected saves
  `""` to every cell in the range as one user operation.
- When whole rows are selected through row headers, `Delete` retains its
  row-deletion behavior and confirmation prompt rather than clearing cells.
- `Delete` never changes a cell to SQL `NULL`. The removed `设为 NULL` menu
  action is not reintroduced.
- `Backspace` is not treated as grid-level clearing for selected cells; it
  remains available for text editing once an editor is open.

### Insert Cells

- The bottom insert row no longer renders as permanently focused input fields.
  It renders selectable cells with the same outline-first behavior as persisted
  cells.
- A single click or keyboard navigation into an insert cell selects it without
  entering an input.
- Double-click, `Enter`, `F2`, or printable keyboard input starts editing the
  draft value for a new single row.
- Existing manual insert submission continues to create one record, and a
  successful manual insert is recorded as an undoable insert operation.
- With an insert cell selected but not editing, `Ctrl/Cmd + V` can paste the
  application's copied whole-row payload as new records. One copied row inserts
  one record; multiple copied rows insert multiple records immediately.
- If a manually entered insert draft already contains unsaved values, row
  paste-as-new does not discard or merge that draft silently. The user must
  submit or clear the draft before bulk row insertion proceeds.
- After insertion, the table reloads under the current filter and sort. The
  new record is not promised to remain beside the insert row or above a row
  that opened a context menu.

### Whole-Row Selection And Context Menu

- Row selection continues through the row-header/row-number area.
- Right-clicking a selected row header retains the active multi-row selection.
  Right-clicking an unselected row header replaces the selection with that one
  row before opening the menu.
- The row-header menu contains `复制`, `删除整行`, and `刷新`.
- The row-header menu additionally exposes `粘贴为新记录` when an internal
  whole-row copy payload exists. Before executing that action, the application
  verifies that the system clipboard still represents the captured copied rows;
  if the clipboard has changed, no insertion occurs and a clear message is
  displayed.
- The label is `粘贴为新记录`, not `向上插入粘贴内容`, because a MySQL table has
  no persistent visible row position.
- Context menus outside row headers retain the previously approved workbench
  rule: they expose only `刷新`, with no browser-native save, print, or inspect
  actions.

## Clipboard Semantics

Create a dedicated clipboard-state boundary rather than deriving row behavior
from raw TSV text:

- Copying selected rows creates an internal whole-row payload containing source
  column names, ordered row values, and the text written to the system
  clipboard.
- The system clipboard output for copied rows is data-only TSV, with no
  application-added column-header row. This matches spreadsheet paste
  expectations when the user pastes outside DB Scout.
- The internal payload retains column names for database-safe mapping when
  pasting as new records.
- Pasting an internal row payload into an insert cell or selecting
  `粘贴为新记录` maps values by target column name rather than by the currently
  focused column position. Columns absent from the target table are skipped
  and reported. If no writable mapped column remains, no records are inserted.
- Ordinary external TSV remains supported for overwriting loaded persisted
  cells from the selected starting cell. It does not automatically create
  records when pasted into the insert row, because arbitrary external text
  should not silently become multiple database inserts.
- Copying a single cell or rectangular cell range continues to provide ordinary
  TSV paste behavior and does not enable the row-menu insert action.

## Generated Fields And Row Identity

Whole-row insertion must not duplicate database-generated values while still
allowing required natural primary keys to be copied:

- Backend column metadata gains a generated-field indicator derived from MySQL
  schema information.
- Values for auto-increment columns and computed/generated columns are omitted
  when copied rows are inserted as new records.
- A primary key is not omitted merely because it is a primary key. A
  user-supplied natural primary key remains part of the insert unless metadata
  marks it as database-generated.
- Default-valued columns that are not generated may still be copied explicitly;
  copying a record should preserve ordinary stored values.

For undoable insertion, the insert response must include the inserted row
values as accepted/generated by the database and its resulting row identity.
Real primary keys provide the stable identity when a table has them. Tables
without a real primary key retain the application's existing all-column
logical-identity fallback; for duplicate all-value rows, undo can restore the
logical row count and values but cannot identify a distinct physical record.

## Undo Model

Replace the existing cell-only stack with operation-level history scoped by
table session identity (connection, database, and table), rather than by table
name alone.

Undoable operations are:

- A single-cell edit.
- Clearing a single cell or selected cell range with `Delete`.
- Pasting into loaded persisted cells.
- Inserting one row manually.
- Pasting one or more copied rows as new records.
- Deleting one or more selected rows, including deletion invoked from the
  row-header context menu.

Each direct user action records one history entry containing only mutations
that actually succeeded:

- Cell mutation entries store row identity, column, pre-action value, and
  post-action value. When a key column changes, they retain both the before
  and after row identities so the inverse mutation locates the saved record.
- Insert entries store identities and returned persisted row snapshots.
- Delete entries store complete deleted-row snapshots so undo can reinsert
  their prior values.

`Ctrl/Cmd + Z` reverses the most recent operation for the active table
session. Switching tabs does not allow a history entry from another connection
or table to mutate the active data. History for other table sessions remains
available when that table becomes active again.

The first version does not provide redo (`Ctrl/Cmd + Shift + Z`).

## Mutation And Failure Handling

Multi-row paste-as-new follows the existing import behavior: records are
inserted one at a time, successful rows remain written if another row fails,
and the status message reports success and failure counts. The undo entry
contains only successfully inserted records.

Bulk clearing, persisted-cell paste, row deletion, and undo operations must
never force data over a value that no longer matches the operation's expected
state:

- A cell inverse update proceeds only when the database still holds the
  post-action value that is being undone.
- Undoing inserted rows deletes only rows identified by the persisted insertion
  result.
- Undoing deleted rows reinserts their saved snapshots. Constraint or primary
  key conflicts are surfaced instead of being overwritten. Restore insertion
  preserves an original auto-increment key when required to recreate the
  deleted identity, but omits computed/generated columns that MySQL must
  calculate itself; it is distinct from paste-as-new insertion.
- When a multi-item action or undo has partial successes, report the
  succeeded/failed counts. History tracks successful original mutations only;
  an undo attempt never manufactures a replacement for a failed or conflicting
  inverse operation.

Backend contracts must return enough per-row/per-cell outcome information for
the frontend to record what actually changed. In particular, a deletion that
can partially execute cannot return only an aggregate affected count if its
individual successful row snapshots are needed for undo.

## Component And Module Boundaries

### Frontend

- `components/DataGrid.vue` renders distinct selection and editing states for
  persisted and insert cells, emits row-header context-menu events, and
  preserves virtualized rendering for loaded data rows.
- `composables/useGridEditor.js` remains responsible for keyboard navigation,
  selecting/editing cells, clearing selected cells, and routing paste commands.
  Insert-row keyboard behavior changes from focus-first to selection-first.
- Add a focused clipboard state/composable for internal whole-row payloads and
  TSV parsing/serialization. It must not own database calls.
- Refactor `composables/useUndo.js` into the single owner of operation history
  and reversal execution. Remove the duplicate dormant undo handler currently
  present in `useGridEditor.js`.
- `composables/useRowSelection.js` supplies selected rows for row operations
  and records successful deletes through the undo owner.
- Extend `composables/useContextMenu.js` and `components/ContextMenu.vue` with
  an explicit row-menu context and row actions while leaving non-row menus
  refresh-only.
- `MySqlWorkbench.vue` coordinates the composables and refreshes the active
  page after insert, delete, or undo outcomes; it does not absorb mutation
  algorithms.

### Backend And Mock

- Extend column metadata returned from Rust and the mock backend with the
  generated-field indicator used during row-payload insert mapping.
- Extend insertion results to return persisted row snapshots and identities
  needed to undo created records.
- Extend deletion/mutation responses or introduce focused mutation commands so
  operation history can represent per-item success without guessing from a
  refreshed page, including post-update identity when an edited column changes
  the row key.
- Keep MySQL identifiers escaped and values parameterized as in current
  database commands.
- Keep browser-mode mock behavior contract-compatible with Rust responses.

## Verification

Add focused frontend tests before implementation for:

- Insert cells selecting without entering an input, then entering edit through
  double-click, `Enter`, `F2`, or printable typing.
- Whole-row copy serializing data-only TSV while retaining structured
  column-aware clipboard state.
- Single-row and multi-row paste-as-new from a selected insert cell.
- Pasting through the row-header context menu, including stale clipboard
  rejection and column mapping.
- Generated-field omission while natural primary-key fields remain insertable.
- Single-cell and range `Delete` saving `""` without invoking NULL behavior.
- Row-header menu actions and selection rules, while non-row context menus
  still expose only `刷新`.
- Operation-level undo for edit, clear, persisted-cell paste, manual insert,
  pasted insert, and row delete.
- Conflict, partial-success, no-primary-key logical identity, and cross-table
  history protection paths.

Add or update Rust and mock-contract tests for generated-column metadata,
returned insertion identity/snapshot data, and deletion/mutation outcomes
required by undo.

After implementation, run all JavaScript unit tests, the frontend production
build, `cargo check`, and Rust unit tests. Manually verify the principal grid
keyboard and row-context-menu interactions in the browser-mode workbench.

## Out Of Scope

- Redo support.
- Restoring the removed `设为 NULL` menu item or treating `Delete` as SQL
  `NULL`.
- Positional database insertion or any promise that inserted records remain
  visually above a particular row.
- Treating arbitrary external TSV pasted into the insert row as automatic
  multi-record insertion.
- The separately requested database synchronization workflow (`A` database
  overwriting `B` with excluded-table selection). That destructive workflow
  requires its own safety and confirmation design.
