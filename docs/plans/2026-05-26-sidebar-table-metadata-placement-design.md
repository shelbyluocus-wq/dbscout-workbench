# Sidebar Table Metadata Placement Design

**Status:** Approved on 2026-05-26

## Goal

Expose each table's comment directly in the navigation list, and move the selected table's database, comment, and row-count context from the center toolbar into the unused bottom status row at the left edge.

## Considered Approaches

1. **Compact inline metadata with the existing bottom row (selected):** Keep every table row single-line, with a subdued, truncated comment after the table name, and populate the existing one-line bottom status row with the active table source and row count at its left edge. This preserves scanning density and uses the empty row the request identifies.
2. **Two-line table rows:** Render comments below table names. This gives comments more space, but materially reduces the number of visible tables in large schemas.
3. **Keep comments hover-only and move only row count:** This makes the smallest visual change, but leaves table comments undiscoverable and does not address the primary request.

## Sidebar Design

- Table rows remain compact and clickable. The table name stays visually primary; `tableComment` appears to its right in muted text with ellipsis truncation.
- The existing title tooltip remains the full-fidelity fallback for long comments.
- The existing bottom status row shows a left-aligned sidebar-width status segment while a table tab is active. It shows `database.tableName`, the table comment in muted truncatable text, and the active tab's total row count.
- The status segment follows sidebar width changes and uses the existing quiet separator, muted labels, and accent treatment, rather than inserting a new card inside the table tree.
- The pane and status segment both render from the live sidebar-width state, with no imperative pane-width override or animated status boundary, so the two edges stay aligned throughout resizing.

## Center Panel Design

- Remove the `database.tableName` and row-count heading from the table toolbar.
- Leave search mode, import, and export actions in the toolbar; the released width benefits filter/search use.
- No grid rendering or virtual-scroll behavior changes.

## Data And Boundaries

- The existing table list already carries `table_comment`, normalized as `tableComment` for the sidebar.
- The existing active tab already carries `database`, `tableName`, `tableComment`, and `totalRows` after opening a session or fetching a page.
- No Rust command, MySQL query, mock backend, or schema contract change is required.

## Verification

- Add shell-level component contract coverage for visible table comments, the bottom status segment, a non-animated aligned boundary, and removal of the center identity block.
- Add a composable test proving sidebar drag publishes its live width for companion surfaces.
- Run `node --test src/workbench/*.test.js`.
- Run `npm run build`.
- Inspect the browser-rendered UI to confirm alignment, ellipsis behavior, and that the active table summary appears in the existing lower-left status row without reducing tree height.
