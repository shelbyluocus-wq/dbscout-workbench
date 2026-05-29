# Table Search and Continuous Browsing Design

## Goal

Opening a table should feel like browsing one continuous table, not a single 1000-row page. The table search box should search the current table without invoking browser search, highlight matching cells without hiding non-matching rows, and jump to the first matching cell.

## Current Behavior

- `DataGrid.vue` has a toolbar search input bound to `tab.filter`.
- `useTableSession.js` sends `tab.filter` to `fetch_table_page`, so search currently behaves like a backend filter and replaces visible rows with only matches.
- The frontend requests `REQUEST_PAGE_SIZE` rows per fetch, currently 1000, and replaces `tab.rows` on each page fetch.
- `useVirtualGrid.js` virtualizes only the rows currently present in `tab.rows`, so browsing stops at the loaded 1000 rows.
- Scrollbar width is controlled globally by `--wb-scrollbar-size` in `workbench.css`.

## Design

### Continuous table browsing

Keep the current virtualized renderer, but change the table session flow so additional backend pages are appended into the active tab as the user scrolls near the bottom. The first table open still loads an initial batch. Subsequent loads request the next page and append rows until `tab.rows.length >= tab.totalRows`.

The grid should present this as one continuous scrollable table. Row numbers continue from the full table index, and existing virtualization remains tied to `tab.rows` so rendering stays bounded.

### Table search behavior

The search input becomes an in-table search control, not a filtering control. Typing updates the search query immediately and never changes the row collection to only matching rows.

Search behavior:

- Ctrl+F while a table is active prevents the browser search box and focuses/selects the table search input.
- Input immediately highlights all matching cells in currently loaded rows.
- The first matching cell is selected and scrolled into view.
- If no loaded row matches and the table is not fully loaded, the app continues loading later batches until it finds the first match or reaches the end.
- Non-matching rows remain visible.

The existing fuzzy/exact mode can remain as the matching mode for the in-table search. Highlighting should continue using the existing `<mark>` path, but keyed from the table search query rather than a backend filter.

### Data flow

`useTableSession.js` owns table page loading. It should expose a way to load the next page and append it, while keeping the existing page replacement behavior only where explicit refresh/sort semantics require it.

`MySqlWorkbench.vue` coordinates search intent:

1. The search box updates the active tab search query.
2. Search code scans loaded rows and columns for matches.
3. On first match, it selects that cell and scrolls it into view.
4. If more rows are needed, it asks the table session to append batches and repeats the scan.

Sorting still refreshes from the backend because row order changes. After a sort, loaded rows are reset to the first sorted batch and continuous browsing resumes from there.

### Error handling

If an appended page fails to load, keep already loaded rows visible and show a status-bar error. Search remains usable over the loaded portion. A later scroll or search can retry loading more rows.

### Scrollbar size

Increase the global scrollbar size token and use a non-thin Firefox scrollbar setting so scrollbars are easier to grab. Keep the existing color tokens and hover behavior.

## Test Plan

Automated tests:

- Table session tests cover appending later pages without replacing earlier rows.
- Search tests cover query updates that do not send backend filters or shrink `tab.rows`.
- Shell/static tests cover Ctrl+F handling and thicker scrollbar CSS.

Manual verification:

- Run the app in browser mode.
- Open a table with more than 1000 rows and scroll past the first batch.
- Press Ctrl+F and confirm browser search does not open.
- Type a value that exists later in the table and confirm the grid highlights matches, keeps non-matching rows visible, and scrolls to the first match.
- Confirm sorting still works and continuous browsing resumes after sorting.
