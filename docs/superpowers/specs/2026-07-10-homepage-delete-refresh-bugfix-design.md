# Homepage Delete And Refresh Bugfix Design

**Status:** Approved on 2026-07-10

## Goal

Fix two database-homepage context-menu regressions:

- Confirming table deletion must invoke the real Tauri command and remove the table.
- Refreshing from the homepage context menu must not reveal a second refresh menu.

## Confirmed Root Causes

- `drop_tables` is invoked with flattened arguments, while the Rust command accepts a single `request: DropTablesRequest` argument. The browser mock accepts both shapes, so browser-only verification did not expose the desktop failure.
- The homepage list's blank-area `contextmenu` handler prevents the native menu but does not stop propagation. The same event therefore opens both the homepage menu and the workbench-wide context menu. Closing the homepage menu reveals the second menu underneath.

## Selected Design

- Send `drop_tables` as `{ request: { connectionId, database, tables } }`, matching the existing Rust command contract and the pattern already used by `copy_tables`.
- Stop propagation on the homepage list's blank-area context-menu event. Row-level context-menu handlers already use this behavior.
- Keep the backend and shared Tauri bridge unchanged; they should not silently normalize an incorrect caller contract.

## Error Handling

The existing confirmation dialog, busy state, success refresh, and visible failure status remain unchanged. The fix only corrects the request boundary and event boundary.

## Verification

- Add a regression assertion for the nested `drop_tables.request` payload.
- Add a regression assertion that the blank-area context-menu handler uses both `prevent` and `stop`.
- Run focused homepage shell tests, homepage controller tests, the frontend build, and the full frontend baseline comparison.
- Verify the two flows in the desktop runtime or the closest available runtime path: confirm deletion removes the table, and refresh closes without exposing another menu.

## Out Of Scope

- Redesigning the homepage context menu.
- Changing backend delete semantics.
- Generalizing Tauri payload normalization across unrelated commands.
