# Local control: connection discovery

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
