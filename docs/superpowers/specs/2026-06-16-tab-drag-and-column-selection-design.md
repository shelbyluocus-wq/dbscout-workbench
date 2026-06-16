# Tab-bar window drag + column header selection

**Goal:** Make the workbench tab bar draggable to move the application window and unify its styling with the toolbar row, and let users select an entire table column by clicking its header.

**Scope:** Two independent UI features in `src/workbench/`:
1. Window drag from the tab-bar background.
2. Whole-column selection via column-header clicks.

**Execution model:** Implemented in an isolated git worktree by two independent subagents (one per feature), each following TDD and code review.

---

## Feature 1: Tab-bar window drag + unified styling

### Background

The tab bar (`WorkbenchTabs.vue`) currently supports reordering tabs via HTML5 drag-and-drop. In the screenshot the tab strip sits above the table toolbar, but its background differs from the toolbar row, so the header looks visually split. Users also expect desktop apps to let them drag the window from any unused chrome area, including the empty space on the tab bar.

### Requirements

1. **Window drag:** Holding the left mouse button on the tab-bar background (any area of `.wb-object-tabs` that is not a `.wb-tab`) starts a window drag after a small movement threshold.
2. **No interference:** Clicking/dragging a tab itself continues to activate/reorder the tab as today. The close button and context menu are unaffected.
3. **Cross-platform:** The drag uses Tauri v2's `window.startDragMove()`. When Tauri is unavailable (browser mock dev mode) the call silently does nothing.
4. **Visual unity:** The tab strip background uses the same surface token as the table toolbar (`--wb-toolbar-surface`). Inactive tabs blend with the strip; the active tab keeps `--wb-tab-active` for contrast. Borders between the strip and the toolbar are removed or softened so the two rows read as one continuous header.

### Approach

- Add pointer tracking to `WorkbenchTabs.vue`:
  - `mousedown` on `.wb-object-tabs` records the start point if the target is not inside a `.wb-tab`.
  - `mousemove` beyond a threshold (e.g. 4 px) calls the Tauri drag API and stops tracking.
  - `mouseup` clears tracking state.
- Guard the Tauri call with a try/catch and check for `window.__TAURI_INTERNALS__` or the imported `getCurrentWindow()` API.
- Update `workbench.css` so `.wb-object-tabs` uses `--wb-toolbar-surface` as its background, inactive tabs are transparent, and the bottom border visually merges with `.wb-table-toolbar`.

### Files touched

- `src/workbench/components/WorkbenchTabs.vue`
- `src/workbench/workbench.css`

---

## Feature 2: Column header click selects the whole column

### Background

`DataGrid.vue` already supports cell selection and range selection through `useGridEditor.js`. Row selection is handled separately by `useRowSelection.js`. There is currently no way to select an entire column with one click.

### Requirements

1. **Single click:** Clicking a column header selects every cell in that column for all rows (including insert rows when visible).
2. **Multi-select:** Ctrl/Cmd+click adds or removes a column from the current column selection. Shift+click selects every column from the anchor column to the clicked column.
3. **Visual feedback:** Selected columns reuse the existing range-selection highlight (`range-selected`, etc.) so no new rendering path is needed. The header itself gets an additional `.col-selected` class.
4. **Integration:** Column selection is stored as a normal cell range, so existing keyboard navigation, copy/paste, and delete behavior work without extra wiring.
5. **No regressions:** Clicking the sort menu or dragging the resize handle on a header must not select the column.

### Approach

- Extend `useGridEditor.js` with:
  - `selectedColumnAnchor` (column index) and `selectedColumnSet` (Set of indices) for multi-column tracking.
  - `selectColumn(tab, columnName, event)`:
    - Plain click clears row selection, clears previous cell range, then creates a range from row 0 to the last row at the clicked column index.
    - Ctrl/Cmd toggles the column in `selectedColumnSet` and recomputes the union range.
    - Shift extends from `selectedColumnAnchor` to the clicked column and selects the rectangular union.
  - `clearColumnSelection()` resets the anchor and set.
- Update `DataGrid.vue`:
  - Add `@mousedown.left="emit('select-column', tab, columnName(column), $event)"` on each `<th>`.
  - Add `@mousedown.stop` on the sort-menu trigger and resize handle so they don't bubble and trigger column selection.
  - Add `.col-selected` class when the header's column index is in the selected columns.
- Update `WorkbenchPane.vue` and `MySqlWorkbench.vue` to listen for `select-column` and route it to `useGridEditor.selectColumn`.

### Files touched

- `src/workbench/composables/useGridEditor.js`
- `src/workbench/components/DataGrid.vue`
- `src/workbench/components/WorkbenchPane.vue`
- `src/workbench/MySqlWorkbench.vue`
- `src/workbench/workbench.css`

---

## Worktree and subagent execution

1. Create a git worktree from `refactor/agent-cleanup-and-rust-commands`.
2. Subagent A implements Feature 1 (tab drag + styling).
3. Subagent B implements Feature 2 (column selection).
4. Each subagent writes tests first, implements, commits, and passes spec + code-quality review.
5. Final integration review and full test run (`node --test src/workbench`).

## Testing

- JS unit tests for `useGridEditor.js` column selection helpers.
- JS unit tests for `WorkbenchTabs.vue` drag-start behavior (mock Tauri window API).
- Manual verification: tab reordering still works, window drags from empty tab-bar space, column clicks select/highlight the full column, multi-select works with Ctrl/Shift.
