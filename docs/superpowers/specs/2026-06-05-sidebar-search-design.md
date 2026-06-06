# Sidebar Search Design

Date: 2026-06-05

## Summary

The sidebar table search becomes a unified search entry for schema metadata and table values.
Typing in the search box previews schema results in real time. Pressing Enter searches concrete
values across all tables in the currently selected database. Value search is deliberately explicit
because row data can be large.

The selected design is one sidebar search panel with grouped results:

- Structure results: live preview for table names, table comments, column names, and column comments.
- Value results: Enter-triggered results for table data in the selected database.

Clicking a value result opens the matching table and positions the grid on the first matching cell.

## Goals

- Keep the current sidebar search as the single entry point.
- Make table comments, column names, and column comments visible as first-class search matches.
- Trigger value search only on Enter.
- Search values across the currently selected database, not just the active table.
- Keep large database behavior predictable with bounded backend work.
- Reuse the existing table tab, paging, and in-table search behavior where possible.

## Non-Goals

- Do not search every database under a connection in the first version.
- Do not show every matching row in the sidebar.
- Do not implement expandable per-table value result details in the first version.
- Do not replace the current table toolbar search. That search remains the active table find tool.
- Do not require loading all rows into the frontend to search values.

## Current Context

The existing frontend already has part of the structure-search foundation:

- `filterSchemaTree` ranks table-name, table-comment, column-name, and column-comment matches.
- `WorkbenchSidebar.vue` still presents the feature as if it only searches tables.
- `useTableSearch.js` searches the loaded active table and can continue loading pages until a match is found.
- `DataGrid.vue` uses the active tab search query to highlight matching cells.

The existing backend has a `quick_search` command and the mock backend has `search_data`, but the naming
and contracts are not aligned. The new design should introduce a clear value-search command instead of
mixing schema preview and data scans.

## Search Box Behavior

The sidebar search input should use copy similar to:

`搜索表、备注、字段；回车搜索值`

Input behavior:

- Every input change updates structure results immediately.
- Input changes do not trigger backend value search.
- Pressing Enter triggers value search for the current query.
- Clearing the input clears both structure results and value results.
- Changing the input after a value search clears the previous value results.

Status behavior:

- Before Enter, show a quiet hint such as `按 Enter 搜索具体值`.
- While searching values, show `搜索值...`.
- After a completed value search, show `值命中 N 张表`.
- On failure, show a concise error state inside the search panel and also update the existing status text.

Keyboard behavior:

- ArrowUp and ArrowDown move through the currently visible sidebar search result items.
- Enter first triggers value search when the current query has not been value-searched yet.
- After value results exist for the current query, Enter opens the selected visible result.
- The first Enter should not accidentally open the first structure result.

## Result Presentation

The search panel displays two grouped areas under the input.

### Structure Results

Structure results update in real time and are ranked in this order:

1. Table name exact, prefix, then contains matches.
2. Table comment matches.
3. Column name matches.
4. Column comment matches.

Table-name or table-comment matches show the full table item.

Column matches show the table plus up to three matching columns:

```text
player
玩家账号表
字段: nickname · 昵称
字段: last_login_at · 最后登录时间
```

If more than three columns match, show a compact overflow row such as `还有 5 个字段命中`.

Click behavior:

- Clicking a table structure result opens that table.
- Clicking a column structure result opens that table and scrolls the grid horizontally so the matching column is visible.
- If the table has no loaded rows, the matching column header is still brought into view after the table schema loads.

### Value Results

Value results appear only after Enter. They are shown below structure results.

Each value result represents one matching table:

```text
player
至少 1 处 · nickname: Alice
```

The first version returns the first preview match per table and does not compute an exact match count.
The UI should use wording such as `至少 1 处` instead of an exact count.

Empty states:

- No structure results: `没有匹配的表或字段`.
- Value search completed with no results: `当前数据库没有匹配的值`.
- Input exists before Enter: `按 Enter 搜索具体值`.

## Value Result Activation

Clicking a value result should:

1. Open the matching table tab for the current connection and database.
2. Preserve the value-search query as the active table search query.
3. Load the first page if the table is not already loaded.
4. Run the existing active-table search flow to find the first matching cell.
5. Select and scroll to that matching cell.

The value result response should include enough context to improve the first selection:

- `tableName`
- `tableComment`
- `columnName`
- `previewValue`
- Optional `rowIdentity` if the backend can provide primary-key values cheaply

The first implementation can locate by reusing `useTableSearch` with the original query. If `rowIdentity`
is present in the response, it is stored on the result item but is not required for first-version positioning.

## Frontend Architecture

Add a focused sidebar search state module, for example `sidebarSearchState.js`.

Responsibilities:

- Store the current query.
- Track the selected visible search result index.
- Track value-search loading, error, results, and searched query.
- Expose helpers to determine whether value results are fresh for the current query.

Add a presentational component, for example `SidebarSearchPanel.vue`.

Responsibilities:

- Render the search input.
- Render grouped structure and value results.
- Emit query updates, Enter searches, item activation, and keyboard navigation events.
- Avoid owning table-opening or backend-invocation logic.

Keep orchestration in `MySqlWorkbench.vue`.

Responsibilities:

- Build normalized structure-search input from `workspace.schema`.
- Invoke value search for the selected connection and database.
- Open tables from structure and value results.
- Bridge value-result activation into the active table search behavior.

The existing `filterSchemaTree` can be evolved or wrapped to return richer match metadata. It should keep
the same ranking semantics while exposing why a table matched and which columns matched.

## Backend Architecture

Add a dedicated Tauri command named `search_values`.

Request shape:

```ts
{
  connectionId: string;
  database: string;
  query: string;
  limit?: number;
}
```

Response shape:

```ts
Array<{
  tableName: string;
  tableComment: string;
  columnName: string;
  previewValue: string;
  rowIdentity?: Record<string, string>;
}>
```

Behavior:

- Empty query returns an empty array.
- The search scope is the selected database for the selected connection.
- Total returned tables are capped at 50 by default.
- Each table returns at most one preview match.
- Identifiers are escaped with the existing `escape_ident`.
- Query values use parameterized binds.
- The SQL pattern should escape LIKE metacharacters.
- Real MySQL search must happen in Rust, not by loading all rows into the frontend.

The mock backend should implement the same `search_values` command contract.

## Backend Search Strategy

For each table in the current schema:

1. Ensure column metadata is available.
2. Build a table-local search predicate across columns:
   `CAST(column AS CHAR) LIKE ? ESCAPE '\\'`
3. Query one preview row with `LIMIT 1`.
4. Return the first matching column and its string preview.
5. Stop when the global result limit is reached.

The first version should not run a separate `COUNT(*)` query for each table. This avoids doubling the
number of database scans and keeps the UI wording honest with `至少 1 处`.

## Error Handling

- If no database is selected, value search should not run and should show a quiet prompt to select a database.
- If a table fails during value search, the first version may fail the whole command with a clear message.
- If the selected database changes while search is in flight, stale frontend results should be ignored.
- If the query changes while search is in flight, stale frontend results should be ignored.
- If a value result opens a table but no matching cell is found after paging, show `当前表未找到匹配内容`.

## Performance Boundaries

- Value search is Enter-triggered only.
- Return at most 50 table results.
- Return one preview match per table.
- Do not compute exact match counts in the first version.
- Do not add watchers over large row arrays.
- Preserve the virtual grid behavior.
- Use backend pagination and the existing active-table search path for final grid positioning.

## Testing

Frontend Node tests:

- Structure search matches table comments.
- Structure search matches column names.
- Structure search matches column comments.
- Structure ranking keeps table-name hits ahead of comments and columns.
- Typing in the sidebar search does not invoke value search.
- Pressing Enter invokes value search for the selected connection and database.
- Changing the query clears previous value results.
- Activating a value result opens the matching table and starts active-table search.
- Keyboard selection moves through visible grouped results.

Backend Rust tests:

- Empty value-search query returns no results.
- LIKE query escaping handles `%`, `_`, and backslash literally.
- Identifier escaping is used for generated table and column names.
- Demo value search returns one preview match per table.
- Result limit caps the number of returned table results.

Shell/static tests:

- `node --test src/workbench`
- `cd src-tauri && cargo test`
- `cd src-tauri && cargo check`

## Acceptance Criteria

- The sidebar input clearly communicates that Enter searches values.
- Table comments, column names, and column comments are searchable in real time.
- Value search runs only on Enter.
- Value search scans the current selected database across tables.
- Value results appear below structure results and use non-exact wording such as `至少 1 处`.
- Clicking a value result opens the table and selects the first matching cell.
- Frontend and backend command names are aligned.
- Existing table-toolbar search still works as before.
