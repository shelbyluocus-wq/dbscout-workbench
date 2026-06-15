# Dev Stress Demo Performance Design

## Goal

Add a development-only stress demo mode for measuring DB Scout Workbench performance under large schema and row counts, while ensuring packaged/release builds show no built-in demo data.

The stress mode should make `npm run tauri -- dev` useful for performance investigation with large synthetic databases. Release builds should not expose Demo GameDB or any stress/demo dataset when no real MySQL connection is configured.

## Requirements

- In Tauri development builds, when no `DBSCOUT_MYSQL_URL` is configured, the app uses a stress demo dataset by default.
- In release builds, when no `DBSCOUT_MYSQL_URL` is configured, the app starts with no demo connections and presents the real connection entry/empty state only.
- Stress demo scale:
  - 10-15 databases on the demo connection.
  - Around 800 tables per database.
  - Table metadata should resemble game configuration, operations, activity, inventory, localization, economy, analytics, and logs.
  - Some tables should be large, around 3000-5000 total rows.
  - Some tables should be wide, around 20-40 columns.
  - Common tables can be smaller, around 200-1000 rows.
- Stress data must be deterministic so repeated measurements are comparable.
- Stress rows should not all be generated at app startup.
- Add measurement points that separate backend/demo generation time from frontend rendering time where practical.

## Architecture

Use compile-time gating in Rust to separate debug/development demo behavior from release behavior:

- Debug/dev builds may create demo connections and stress metadata.
- Release builds do not create demo connections when `DBSCOUT_MYSQL_URL` is absent.
- Real MySQL connections via `DBSCOUT_MYSQL_URL` continue to work in both modes.

The demo module should expose a small profile boundary rather than scattering build-mode checks through commands. A profile-oriented boundary keeps the command handlers simple:

- Connection/database listing asks the runtime what demo profile exists.
- Schema reads ask the demo profile for table metadata.
- Page reads ask the demo profile for the requested page.

In release builds the demo profile is absent. Commands that depend on demo data should return empty connection/database/table data or a clear no-demo state rather than synthesizing data.

## Data Generation

Stress schema generation should be eager enough to test sidebar scale, but row generation should be lazy:

- Generate database names and table metadata during runtime initialization in dev builds.
- Do not materialize all rows in `RuntimeState`.
- Generate page rows on demand for `open_table_session` and `fetch_table_page`.
- Use deterministic formulas based on database name, table name, row index, and column name.
- Return only the requested page size, preserving the current frontend pagination contract.

This avoids measuring a synthetic startup penalty caused by constructing millions of unused rows.

## Frontend Runtime Behavior

The frontend should not need to know whether the backend is using real MySQL, normal demo, or stress demo. It should continue to call the existing Tauri commands:

- `list_connections`
- `list_databases`
- `select_database`
- `list_tables`
- `get_table_schema`
- `open_table_session`
- `fetch_table_page`

If release mode has no configured MySQL connection and no demo connections, the existing connection dialog/empty state should be reachable without errors. If the current UI assumes at least one connection, adjust only the empty-state path needed for release-without-demo.

## Performance Measurements

Add lightweight development-only performance instrumentation for these points:

1. App boot:
   - frontend script start to Vue mounted;
   - connection list loaded;
   - first usable workspace state.
2. Sidebar/database scale:
   - selecting a database;
   - receiving table metadata;
   - first sidebar render after table list update.
3. Table open:
   - backend page generation/read time;
   - Tauri command round trip;
   - frontend tab/page replacement;
   - first rendered grid frame after opening.
4. Grid interaction:
   - scroll sampling for long frames;
   - current number of loaded rows, visible rows, and columns.

Measurements should be visible in development through console logs or a small debug-only reporter. They should not appear in release builds.

## Testing and Verification

Automated tests should cover:

- Release-mode runtime initialization creates no demo connections when no MySQL URL exists.
- Debug/dev demo profile creates stress databases and table metadata.
- Stress table page generation returns only the requested page size while reporting the larger total row count.
- Existing command payload shapes remain compatible with frontend callers.

Runtime verification should use Tauri dev mode:

1. Run `npm run tauri -- dev` without `DBSCOUT_MYSQL_URL`.
2. Confirm the stress demo connection appears.
3. Confirm multiple databases are available.
4. Select a stress database and confirm around 800 tables render.
5. Open representative small, large, and wide tables.
6. Record startup, sidebar, table-open, and scroll measurements.

Release verification should build or run a release-equivalent path:

1. Run without `DBSCOUT_MYSQL_URL`.
2. Confirm no demo connection appears.
3. Confirm the app presents an empty/real-connection entry path instead of Demo GameDB.

## Out of Scope

This design does not optimize the grid, add column virtualization, refactor startup restoration, or tune SQL. It creates a reliable pressure environment and measurement baseline so those optimizations can be chosen from evidence.
