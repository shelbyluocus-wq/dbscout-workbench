# Selected Cell Primary Key Status Design

**Status:** Approved on 2026-05-26

## Goal

When a user selects or edits a data-grid cell, make the database record being
acted on immediately identifiable without leaving the grid context. The bottom
status bar must show the selected cell's column and the focused row's real
primary key information next to the existing table row count.

This feature is for user-facing record confirmation. It must not expose the
internal all-column fallback that the editor uses to locate rows in tables
without a primary key.

## User Experience

Add a compact current-cell identity item immediately to the right of the
existing `database.table / comment / row count` item in the bottom status bar.
The item is visible only while a persisted data cell is focused.

Examples:

```text
当前单元格 name | 主键 id=10021
当前单元格 quantity | 多主键 server_id=3 + role_id=10021
当前单元格 level | 主键 id=10021 | 已选 12 个单元格
当前单元格 remark | 无主键
```

The status item uses the existing 24px footer height. Labels are muted and the
key/value identity receives the visual emphasis. A subtle vertical divider
separates it from the row-count section. Overflow remains single-line with
ellipsis, and the full identity text is available through the native tooltip.

## Display Rules

- With no selected persisted cell, render no current-cell identity item.
- For exactly one real primary-key column, render `主键` and `key=value`.
- For two or more real primary-key columns, render `多主键` followed by all
  primary-key pairs in schema/session order, joined with ` + `.
- For a table with no real primary key, render `无主键`; do not display the
  full-row identity used internally for updates.
- For a drag or keyboard range selection, use the current focus cell's row for
  identity. When the selected range contains more than one cell, append
  `已选 N 个单元格`.
- Selecting the insert row renders no identity item because the row has not
  been persisted and has no stable primary-key identity.
- Clearing selection, changing tabs, or changing to row selection removes the
  identity item along with the cell focus.
- A null primary-key field value is rendered as `NULL`; an empty string is
  rendered as `""`. The item always includes the key name so anomalous data
  can be diagnosed without ambiguity.

## Component Boundary

Create a focused presentation component such as
`components/SelectedCellIdentity.vue`. It receives the active tab, selected
cell, and selected range, then renders the footer item. It does not manage
grid focus, mutation, requests, or selection changes.

Keep identity derivation in a small utility function consumed by the component
so each display rule can be tested without mounting the application shell. It
must use the existing user-visible primary key source:

- `tab.primaryKeys` determines whether a real primary key exists and whether it
  is composite.
- `selectedCell.rowKey` and the existing row lookup behavior identify the
  focused loaded row.
- `selectedRange` supplies range dimensions for the selected-cell count.

Do not derive the display from the serialized `rowKey` when `tab.primaryKeys`
is empty, because that key deliberately contains internal fallback identity.

## Integration

`MySqlWorkbench.vue` owns the status bar and already has `activeTab`,
`selectedCell`, and `selectedRange`. It mounts the new component beside the
current row-count presentation and passes only these inputs.

Add scoped status-bar styles to `workbench.css` using existing `--wb-*` tokens.
The status item must remain flexible within the footer so narrow windows
truncate identity text rather than widening or reflowing the workbench.

No Rust command, table-session payload, mock-backend contract, or virtual-grid
rendering change is required: all required primary-key metadata and focused row
data are already loaded on the frontend.

## Verification

Add focused frontend tests for the presentation rules and retain shell-level
coverage that wires the component into the status bar:

- A single-primary-key row shows its column name, `主键`, and the correct
  primary-key value.
- A composite-primary-key row shows `多主键` and all key/value pairs in order.
- A table without a real primary key shows `无主键` only.
- A multi-cell range shows the focus row identity and the correct cell count.
- Clearing cell selection, selecting the insert row, or switching selection
  away from persisted cells hides the item.
- Long identity content exposes the complete tooltip while allowing footer
  truncation.

Run the existing Node frontend tests and frontend build after implementation.

## Out Of Scope

- Exposing or copying the internal row identity for no-primary-key tables.
- Displaying identities for every row covered by a range selection.
- Backend/schema protocol changes.
- Reorganizing the inspector panel or changing the current cell editing flow.
