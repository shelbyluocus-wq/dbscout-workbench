# Sidebar Drag Reorder Animation Design

## Goal

Improve the left sidebar MySQL connection and database drag reorder interaction so it previews the final order while dragging. When the user drags a node over another node, the dragged node should appear in the would-be insertion slot and the surrounding nodes should move smoothly out of the way. Dropping commits the existing reorder action; cancelling restores the original order.

## Scope

- Applies to top-level MySQL connection nodes.
- Applies to database nodes inside the selected connection.
- Does not change table nodes, data grid drag selection, backend commands, or persisted order format.

## Interaction

- Drag start records the source kind and id.
- Drag over computes the target id plus before/after insertion position.
- The sidebar renders a temporary preview order for the active drag kind.
- The dragged source remains visible in its preview slot so the user can see where it will land before releasing.
- Drop emits the existing `reorder-connections` or `reorder-databases` event with the target and position.
- Drag end clears preview state. If no drop happened, the normal prop order renders again.

## Implementation Shape

- Keep drag state local to `WorkbenchSidebar.vue`.
- Add small pure helpers for preview ordering and drag target equality, exported for unit tests if practical.
- Render connection and database lists from computed preview arrays rather than raw props during a matching drag.
- Wrap the draggable node lists in Vue `TransitionGroup` so DOM reordering gets FLIP-style movement.
- Keep animation styling in `workbench.css` using existing `--wb-*` tokens.

## Motion

- Use transform and opacity transitions for smooth list movement.
- Give the source row a subtle lifted state with opacity, shadow, and a small translate/scale.
- Give the active insertion target a clear but restrained state so the preview remains readable.
- Respect `prefers-reduced-motion` by disabling movement-heavy transitions.

## Tests

- Add JS unit coverage for preview ordering: before, after, same source, missing target, and kind mismatch behavior.
- Extend shell/structure tests to ensure the sidebar uses transition groups and preview drag state classes.
- Run `node --test src/workbench`.
