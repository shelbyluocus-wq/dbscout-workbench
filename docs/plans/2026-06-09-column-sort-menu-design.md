# Column Sort Menu Design

## Goal

Change grid sorting from direct header clicks to a hover-only arrow menu on each column header.

## Decisions

- Column header text no longer triggers sorting.
- Each data column header owns a compact arrow button on the right edge.
- The arrow is visible only when the header is hovered, focused, actively sorted, or its menu is open.
- The menu provides three explicit actions: ascending sort, descending sort, and remove sort.
- Sorting remains single-column because the current backend request shape only supports one `sort` object.

## Architecture

- Add a small `ColumnSortMenu.vue` component for the header button and popup menu.
- Keep `DataGrid.vue` responsible for header rendering and event emission.
- Add `applySort(tab, column, direction)` to `useTableSession.js` for explicit sort states while keeping `toggleSort()` compatible with existing code.
- Route menu actions through `WorkbenchPane.vue` so selection and scroll state are reset before fetching page 1.

## Testing

- Add source-level shell tests for the header menu markup and absence of header-click sorting.
- Add `useTableSession` tests for ascending, descending, and clearing sort requests.
