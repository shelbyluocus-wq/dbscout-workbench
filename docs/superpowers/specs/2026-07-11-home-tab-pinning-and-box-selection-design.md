# Homepage Tab Pinning And Box Selection Design

## Problem

The database homepage is a global, non-closable tab, but its order is currently
handled like an ordinary table tab. Other tabs can be moved before it, and a
saved workspace can restore it in a non-leading position.

The homepage table list also blocks box-selection whenever the pointer starts
anywhere inside a table row. The comment and field-count columns have no row
interaction, so requiring users to start outside all three columns makes box
selection unnecessarily difficult.

## Decision

Preserve one global homepage tab. In whichever pane owns it, the homepage is
always the leftmost tab. The homepage cannot be dragged manually, and any other
tab dropped before it is clamped to the position immediately after it.

For homepage table box selection, only the table-name column, its button, and
its rename input block the starting pointer. The comment and field-count columns
become valid box-selection starting surfaces.

## Alternatives Considered

### Render-only homepage sorting

Sorting the displayed tabs without updating workspace state would look correct
but leave drag previews, persistence, keyboard order, and pane ownership out of
sync. This is rejected.

### Disable only homepage dragging

Preventing the homepage itself from being dragged would not stop another tab
from being inserted before it or an older snapshot from restoring the wrong
order. This is rejected.

### State invariant plus matching UI constraints (selected)

The state layer normalizes homepage order after creation, movement, reordering,
and restoration. The tab bar mirrors the rule in its drag affordances and
preview. This keeps the model and visible order consistent.

## Tab Ordering Behavior

- The homepage remains globally unique and non-closable.
- The homepage is first in both the owning pane's tab IDs and the global tab
  order used to render pane tabs.
- Creating or reusing the homepage moves it to index zero in its owner pane.
- Programmatic movement to another pane places it at index zero in that pane.
- Dragging the homepage is disabled in the tab bar.
- Dropping another tab before the homepage is interpreted as dropping it after
  the homepage, including the drag preview.
- Workspace restoration normalizes old saved orders after reconstructed panes
  are assigned.
- Existing active-tab and focused-pane state remains unchanged by normalization.

## Box Selection Behavior

- Left-button pointer down on the table-name column does not begin box
  selection. Existing click, double-click, keyboard, context-menu, and rename
  behavior remains unchanged.
- Left-button pointer down on the comment or field-count column begins box
  selection using the existing selection rectangle.
- Header, empty-state, and rename-input interactions continue to block box
  selection.
- The existing four-pixel movement threshold remains, so a click without a drag
  does not replace the current selection.
- The selection rectangle continues to select every rendered row it intersects;
  virtualization behavior is unchanged.

## Components And State

- `workspaceState.js` owns a reusable homepage-order normalization helper and
  applies it to creation and tab movement operations.
- `MySqlWorkbench.vue` calls the same normalizer after workspace restoration.
- `WorkbenchTabs.vue` disables homepage dragging and clamps drag targets around
  the pinned first position so previews match committed state.
- `DatabaseTableList.vue` narrows the box-selection exclusion selector from the
  entire row to the table-name column and existing non-row surfaces.

## Tests

Focused tests will verify:

- Homepage creation places it before existing data and design tabs.
- Reordering another tab before the homepage keeps the homepage first.
- Moving the homepage between panes places it first without changing its global
  uniqueness.
- Normalizing restored pane state moves the homepage first while preserving the
  active tab.
- The homepage tab is not draggable and drag preview cannot place another tab
  before it.
- Table-name pointer down is excluded from box selection.
- Comment and field-count pointer down are accepted as box-selection starts.
- Header, empty-state, rename behavior, and the movement threshold remain
  intact.

Manual browser verification will confirm the homepage remains visually first
after tab drag attempts and that box selection can start from both non-name
columns.
