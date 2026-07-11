# Table Toolbar Actions Design

## Goal

Move the table-level import, export, and split-screen actions out of the hidden
"more options" menu and place them beside the table search controls. Keep the
toolbar compact, predictable, and usable in narrow split panes.

## Scope

This change applies to data-table tabs, where the search toolbar is available.
The existing overflow entry remains on table-design and empty-pane views because
those views do not have a table search row.

No import, export, batch-transfer, or pane-splitting behavior changes. Only the
entry points and dropdown presentation change.

## Toolbar Layout

The primary control order is:

1. Table search field
2. Fuzzy/exact match selector
3. Freeze split button
4. Export split button
5. Import split button
6. Split-screen split button

Existing sort and schema-search status remain visible without breaking the
adjacency and order of the four action controls. The data-table "more options"
button is removed after all of its actions have been exposed.

## Interactions

### Match mode

The current mode remains visible as "模糊" or "精确". Opening the adjacent
caret shows both choices. The selected mode has a check indicator and supporting
text that explains the matching behavior.

### Export

- Clicking "导出" exports the current table.
- Clicking its caret opens a menu containing "批量导出".
- Current busy-state and active-table restrictions remain unchanged.

### Freeze

- The freeze control sits between match mode and export.
- Clicking "冻结" applies the default freeze to the current live selection.
- A full-column selection freezes through the rightmost selected column and
  clears any row freeze.
- A normal cell or cell range freezes through the active cell's row and column.
- With no valid cell or column selection, the direct action is a silent no-op
  and does not alter an existing freeze.
- The trigger keeps the label "冻结" and uses the shared active styling whenever
  the table has frozen rows or columns.

The caret menu contains "冻结到当前单元格", "冻结到当前行", "冻结到当前列",
"冻结首行", "冻结首列", and "取消冻结". Selection-dependent items remain
visible but disabled when their target is unavailable. "取消冻结" is disabled
when the table has no active freeze. The existing right-click freeze entries
remain available.

### Import

- Clicking "导入" opens the current-table import flow.
- Clicking its caret opens a menu containing "批量导入".
- Current busy-state, active-session, and read-only restrictions remain
  unchanged and are represented through disabled states.

### Split screen

- Clicking "分屏" performs the default left-right split.
- Clicking its caret opens "左右分屏" and "上下分屏" choices.

### Shared dropdown behavior

All four dropdowns use the same menu surface, spacing, row height, typography,
icons, hover state, focus state, disabled state, opening motion, and placement.
Opening one menu closes any other toolbar menu. Clicking outside or pressing
Escape closes the open menu and returns focus predictably.

Menus render outside scroll-clipped toolbar containers and stay within the
viewport. Motion is short and state-oriented, with a reduced-motion fallback.

## Component Boundaries

Create one reusable toolbar dropdown/split-button component that owns trigger
semantics, menu placement, outside-click handling, Escape handling, focus, and
shared item rendering. DataGrid supplies labels, enabled states, selected state,
and action callbacks. A focused freeze-selection utility resolves full-column
versus active-cell targets without depending on context-menu state. DataGrid uses
the existing freeze-panes composable to apply those resolved row/column counts.
WorkbenchPane continues to own the actual import, export, batch-transfer, and
pane-splitting commands.

This avoids four independent menu implementations and ensures future styling or
accessibility fixes apply uniformly.

## Responsive Behavior

Buttons keep stable dimensions and do not compress their labels. The toolbar may
scroll horizontally in narrow panes, preserving the existing dense workbench
behavior. Dropdowns are positioned against the viewport so toolbar scrolling
does not clip them.

## Accessibility

- Split-button label and caret are separate keyboard-focusable controls.
- Carets expose `aria-haspopup="menu"` and accurate `aria-expanded` state.
- Menus and items use menu semantics and visible keyboard focus.
- Disabled actions remain discoverable but cannot be triggered.
- The selected match mode is communicated without relying on color alone.

## Verification

Automated checks cover the new toolbar order, direct-action wiring, dropdown
contents, removal of the data-table overflow button, disabled-state wiring,
shared menu semantics, full-column freeze resolution, active-cell freeze
resolution, and the no-selection no-op. Existing import, export, batch-transfer,
split-pane, freeze-pane, and table-search tests must remain green.

Browser verification covers light and dark themes at a normal desktop width and
a narrow split-pane width. It confirms that menus are not clipped, controls do
not overlap, disabled states are legible, outside-click and Escape close menus,
and only one dropdown can be open at a time.
