# Local control: connection discovery

## External MCP navigation

Start with `get_mcp_capabilities` for the sidecar tool catalog, parameter schemas,
desktop version, supported UI actions, current context and permission groups.
`list_connections` exposes the credential-free connection discovery described below.
The sidecar catalog and the desktop `uiActions` are separate: a newly rebuilt sidecar
does not update an installed desktop, and an MCP host may cache tool descriptions
until reconnection. External host search ranking is not controlled by Blackcat.

`get_workbench_context` now asks the frontend for a fresh snapshot without revealing
the window. It includes open tabs, filter/sort, precise loaded-window offset,
loading/search-completion/total-exactness flags, selected cell/range endpoints and
the rendered cells intersecting the viewport. Hidden/unmounted grids return a null
viewport, not an invented visible range. Snapshot completion is not proof that a
screen animation has finished. Normal context synchronization avoids DOM reads;
viewport geometry is collected only for explicit requests and action completions.

`focus_row` / `focus_cell` first check loaded rows. With a complete `rowIdentity`,
an unloaded record opens in a separate exact-primary-key filtered tab, using every
composite-key member. The original tab, its filter and sorting remain untouched.
This is a bounded-result database lookup, not client-side traversal of every page
or a promise to show the record's original neighbours. The reused relation filter
is supported by MySQL/demo; other engines reject unloaded-key lookup. Database
query cost still depends on the existing filter planner and indexes.
`rowKey` remains loaded-row-only. Missing/partial
keys, unsafe numeric values, NULL/empty/edge-whitespace keys and tables without
primary keys report actionable errors rather than silently selecting a different row.
Use strings for large integer keys. `select_range` still requires loaded endpoints;
it does not materialize arbitrarily large selections. Invalid columns are errors.

`scroll_table` accepts `direction: up|down|left|right|top|bottom` and `screens: 1..5`.
It scrolls the actual focused grid, reuses loaded rows, directly fetches an unloaded
window when possible, and retains filters/sorting. Search views retain their own
paging rules; unsupported boundaries or busy loads report errors. Active editing
blocks navigation instead of implicitly saving a cell. Scrolls also protect insert
drafts. These actions, database selection, SQL opening and range selection require
the navigate permission; fresh context does not. Refresh remains ungated.

`run_ui_actions` runs 1–20 steps sequentially and stops on failure without rollback.
Default `mode: fast` adds no pauses. `mode: demo` labels each step in the existing
status bar and pauses between successful steps (`pauseMs: 100..3000`, default 600).
Default `detail: compact` returns per-step outcome/timing and one final context;
`detail: full` preserves complete per-step responses. Failure returns a zero-based
`stoppedIndex`. Timings measure completion responses, not screen paint. Window
reveal remains passive. Reconnect the MCP client after updating both components.

Validation: `node --test sidecar/mcp-server.test.mjs sidecar/uiActionBatch.test.mjs
src/workbench/controlNavigation.test.js` checks discovery, schemas, batches and
navigation helpers. `node scripts/test-mcp-navigation.mjs` exercises Chromium and
WebKit with the mock backend (cold/warm navigation, scrolling, live context,
invalid fields, selections and isolated exact-key lookup); it does not mutate a
real database or validate an installed app.

The authenticated JSON-lines control endpoint advertises `get_connections` in the hello response's `capabilities` array. This is an additive protocol-v1 capability; clients must check it before sending the new operation.

Request:

```json
{"op":"get_connections","id":"connections-1"}
```

Response example (illustrative values):

```json
{"id":"connections-1","ok":true,"data":[{"id":"mysql-7","label":"Config","kind":"mysql","host":"db.example","port":3306}]}
```

The operation waits for frontend connection restoration, uses the same per-launch-token authentication and external-MCP enable gate as other control requests, and does not reveal the window or change the selected connection. It returns runtime connections sorted by ID. Only `id`, `label`, `kind`, `host`, and `port` are exported; usernames, passwords and connection URLs are excluded.

Consumers such as Activity Studio match their configured server by host/port, verify the target database with the existing read-only `db_tool/list_databases` operation, and pass the resulting `connectionId` explicitly to `ui_action/open_table` or `ui_action/focus_row`. IDs such as `mysql-1` must not be hard-coded. Missing or ambiguous matches should produce an actionable error rather than use the currently selected server silently.

Legacy hosts without this capability remain usable when `get_context` identifies a current connection whose `list_databases` response contains the requested database. Otherwise the client should request switching the selected connection or updating Blackcat.

Validation: `cargo test --manifest-path src-tauri/Cargo.toml --lib control_server::tests` covers request parsing, restoration readiness, metadata allowlisting and existing authorization/dispatch contracts. Activity Studio's socket tests cover cross-server selection and legacy fallback. Rebuild/update the desktop executable for this capability to be available in an already installed Blackcat.
