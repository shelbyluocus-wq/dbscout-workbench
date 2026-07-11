# Context Menu Surface Scoping Design

## Goal

Only show actions that are meaningful for the surface the user right-clicked.
The current menu infers actions from whether a table is available, which makes
grid freeze actions and table management actions appear in unrelated areas.

## Behavior

- Sidebar table: show table operations and refresh. Do not show freeze actions.
- Inspector: show refresh only. Do not show freeze or table management actions.
- Data grid and grid rows: keep the existing data and freeze actions.
- Connection, database, and general menus: keep their existing behavior.

## Design

The shared context-menu state will record an explicit surface. Callers set the
surface when opening the menu, and the menu derives action groups from that
surface instead of treating every table-scoped target as a grid target.

Table identity remains available for refresh and table operations even when the
surface suppresses those operations. This keeps refresh correctly scoped to the
active table while allowing the inspector to present only the relevant action.

## Verification

Add focused tests for sidebar, inspector, and grid menu openings. Verify that
the shared menu component gates freeze and table-operation groups independently,
then run the existing context-menu and workbench shell tests.
