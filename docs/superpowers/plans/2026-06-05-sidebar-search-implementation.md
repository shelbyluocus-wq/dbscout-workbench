# Sidebar Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the sidebar search so typing previews schema matches and pressing Enter searches table values across the selected database, with result activation opening and positioning the table grid.

**Architecture:** Add a richer schema-search result model and a focused sidebar search state module on the frontend. Add a dedicated `search_values` Tauri command and matching mock command for bounded database value scans. Wire a new `SidebarSearchPanel.vue` into `WorkbenchSidebar.vue` while keeping table opening, backend calls, and grid positioning in `MySqlWorkbench.vue`.

**Tech Stack:** Vue 3 Composition API, Node.js `node:test`, Tauri 2 commands, Rust, sqlx MySQL, existing mock backend.

---

## File Structure

- Create `src/workbench/sidebarSearchState.js`: Pure state helpers for query changes, value-search lifecycle, freshness checks, and visible-result keyboard selection.
- Create `src/workbench/sidebarSearchState.test.js`: Node tests for Enter gating, stale result clearing, and keyboard selection.
- Modify `src/workbench/workspaceState.js`: Add rich schema search result helpers while preserving `filterSchemaTree`.
- Modify `src/workbench/workspaceState.test.js`: Add tests for table comments, column names, column comments, ranking, and capped column previews.
- Create `src/workbench/components/SidebarSearchPanel.vue`: Presentational search box and grouped result list. Emits only query, search, and activation events.
- Modify `src/workbench/components/WorkbenchSidebar.vue`: Replace inline table-search input/list with `SidebarSearchPanel.vue`, keep connection/database tree behavior, and keep table context menu behavior.
- Modify `src/workbench/MySqlWorkbench.vue`: Own sidebar search orchestration, call `search_values`, open schema/value results, and bridge value activation to `runTableSearch`.
- Modify `src/workbench/composables/useTableSession.js`: Return the opened tab from `openTable` so callers can continue after a table is loaded.
- Modify `src/workbench/composables/useVirtualGrid.js`: Export the existing `scrollColumnIntoView` helper so schema column hits can reveal a header.
- Modify `src/workbench/mock/mockBackend.js`: Replace the old unused `search_data` command with `search_values` while accepting the new request contract.
- Modify `src-tauri/src/types.rs`: Add `SearchValuesRequest` and `SearchValueItem`.
- Modify `src-tauri/src/db.rs`: Add LIKE escaping and real-MySQL value-search helpers.
- Modify `src-tauri/src/demo.rs`: Add demo value-search helper.
- Modify `src-tauri/src/commands.rs`: Add `search_values` command orchestration.
- Modify `src-tauri/src/lib.rs`: Register `commands::search_values`.
- Modify `src/workbench/workbench.css`: Add compact grouped-result styles using `--wb-*` tokens.
- Modify `src/workbench/workbenchShell.test.js`: Update static shell tests for the new component, Enter-triggered value search, and preserved table toolbar search.

## Task 1: Rich Schema Search Results

**Files:**
- Modify: `src/workbench/workspaceState.js`
- Test: `src/workbench/workspaceState.test.js`

- [ ] **Step 1: Write failing tests for rich schema search**

Append these tests to `src/workbench/workspaceState.test.js`. Update the import to include `buildSchemaSearchResults`.

```js
import {
  buildSchemaSearchResults,
  closeAllTableTabs,
  closeTableTab,
  createWorkspaceState,
  filterSchemaTree,
  moveTableTab,
  openTableTab,
  replaceTabPage,
} from "./workspaceState.js";

test("buildSchemaSearchResults exposes table comment matches", () => {
  const tree = [
    { tableName: "player", tableComment: "玩家账号表", columns: [] },
    { tableName: "item", tableComment: "道具配置", columns: [] },
  ];

  const results = buildSchemaSearchResults(tree, "账号");

  assert.equal(results.length, 1);
  assert.equal(results[0].table.tableName, "player");
  assert.equal(results[0].matchKind, "tableComment");
  assert.equal(results[0].matchedColumns.length, 0);
});

test("buildSchemaSearchResults exposes column name and comment matches", () => {
  const tree = [
    {
      tableName: "player",
      tableComment: "玩家账号表",
      columns: [
        { column_name: "nickname", column_comment: "昵称" },
        { column_name: "last_login_at", column_comment: "最后登录时间" },
      ],
    },
  ];

  assert.deepEqual(
    buildSchemaSearchResults(tree, "login").map((result) => ({
      tableName: result.table.tableName,
      matchKind: result.matchKind,
      columns: result.matchedColumns.map((column) => column.column_name),
    })),
    [{ tableName: "player", matchKind: "columnName", columns: ["last_login_at"] }],
  );

  assert.deepEqual(
    buildSchemaSearchResults(tree, "昵称").map((result) => ({
      tableName: result.table.tableName,
      matchKind: result.matchKind,
      columns: result.matchedColumns.map((column) => column.column_name),
    })),
    [{ tableName: "player", matchKind: "columnComment", columns: ["nickname"] }],
  );
});

test("buildSchemaSearchResults caps visible column matches and reports overflow", () => {
  const table = {
    tableName: "wide_table",
    tableComment: "",
    columns: [
      { column_name: "match_a", column_comment: "" },
      { column_name: "match_b", column_comment: "" },
      { column_name: "match_c", column_comment: "" },
      { column_name: "match_d", column_comment: "" },
    ],
  };

  const [result] = buildSchemaSearchResults([table], "match");

  assert.deepEqual(result.visibleColumns.map((column) => column.column_name), ["match_a", "match_b", "match_c"]);
  assert.equal(result.hiddenColumnCount, 1);
});
```

- [ ] **Step 2: Run the focused test to confirm failure**

Run:

```bash
node --test src/workbench/workspaceState.test.js
```

Expected: fail with `does not provide an export named 'buildSchemaSearchResults'`.

- [ ] **Step 3: Implement the rich result builder**

In `src/workbench/workspaceState.js`, keep the existing ranking helpers and add these helpers near `filterSchemaTree`:

```js
const COLUMN_PREVIEW_LIMIT = 3;

function columnMatchKind(column, query) {
  const names = [column?.column_name, column?.columnName].map(normalizeText).filter(Boolean);
  const comments = [column?.column_comment, column?.columnComment].map(normalizeText).filter(Boolean);
  if (names.some((item) => item === query || item.startsWith(query) || item.includes(query))) return "columnName";
  if (comments.some((item) => item.includes(query))) return "columnComment";
  return "";
}

function tableMatchKind(table, query) {
  const names = [table?.tableName, table?.table_name].map(normalizeText).filter(Boolean);
  const comments = [table?.tableComment, table?.table_comment].map(normalizeText).filter(Boolean);
  if (names.some((item) => item === query || item.startsWith(query) || item.includes(query))) return "tableName";
  if (comments.some((item) => item.includes(query))) return "tableComment";
  return "";
}

function cloneTableWithColumns(table, columns) {
  return { ...table, columns: Array.isArray(columns) ? [...columns] : [] };
}

export function buildSchemaSearchResults(schema = [], query = "") {
  const needle = normalizeText(query);
  const list = Array.isArray(schema) ? schema : [];
  if (!needle) {
    return list.map((table, index) => {
      const columns = Array.isArray(table.columns) ? table.columns : [];
      return {
        key: `table:${table?.tableName || table?.table_name || index}`,
        rank: index,
        matchKind: "none",
        table: cloneTableWithColumns(table, columns),
        matchedColumns: [],
        visibleColumns: [],
        hiddenColumnCount: 0,
      };
    });
  }

  return list
    .map((table, index) => {
      const columns = Array.isArray(table.columns) ? table.columns : [];
      const tableRank = tableMatchRank(table, needle);
      const tableKind = tableMatchKind(table, needle);
      const columnMatches = columns
        .map((column) => ({
          rank: columnMatchRank(column, needle),
          kind: columnMatchKind(column, needle),
          column,
        }))
        .filter((match) => Number.isFinite(match.rank));

      if (!Number.isFinite(tableRank) && columnMatches.length === 0) return null;

      const matchedColumns = columnMatches.map((match) => match.column);
      const bestColumnRank = columnMatches.length
        ? Math.min(...columnMatches.map((match) => match.rank))
        : Number.POSITIVE_INFINITY;
      const bestColumnKind = columnMatches.find((match) => match.rank === bestColumnRank)?.kind || "";
      const rank = Math.min(tableRank, bestColumnRank);
      const matchKind = Number.isFinite(tableRank) && tableRank <= bestColumnRank ? tableKind : bestColumnKind;
      const tableColumns = Number.isFinite(tableRank) ? columns : matchedColumns;

      return {
        key: `table:${table?.tableName || table?.table_name || index}`,
        rank,
        index,
        matchKind,
        table: cloneTableWithColumns(table, tableColumns),
        matchedColumns,
        visibleColumns: matchedColumns.slice(0, COLUMN_PREVIEW_LIMIT),
        hiddenColumnCount: Math.max(0, matchedColumns.length - COLUMN_PREVIEW_LIMIT),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
}
```

Then replace `filterSchemaTree` with a delegating version:

```js
export function filterSchemaTree(schema = [], query = "") {
  return buildSchemaSearchResults(schema, query).map((result) => result.table);
}
```

- [ ] **Step 4: Run the focused tests**

Run:

```bash
node --test src/workbench/workspaceState.test.js
```

Expected: pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/workbench/workspaceState.js src/workbench/workspaceState.test.js
git commit -m "feat: add rich schema search results"
```

## Task 2: Sidebar Search State Helpers

**Files:**
- Create: `src/workbench/sidebarSearchState.js`
- Test: `src/workbench/sidebarSearchState.test.js`

- [ ] **Step 1: Write failing tests for state lifecycle and keyboard selection**

Create `src/workbench/sidebarSearchState.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  beginValueSearch,
  buildVisibleSidebarSearchItems,
  clearValueSearchResults,
  createSidebarSearchState,
  finishValueSearch,
  moveSidebarSearchSelection,
  setSidebarSearchQuery,
  sidebarValueResultsAreFresh,
} from "./sidebarSearchState.js";

test("setSidebarSearchQuery clears previous value results when the query changes", () => {
  const state = createSidebarSearchState();
  state.query = "alice";
  finishValueSearch(state, "alice", [{ tableName: "player" }]);

  setSidebarSearchQuery(state, "bob");

  assert.equal(state.query, "bob");
  assert.deepEqual(state.valueResults, []);
  assert.equal(state.valueSearchedQuery, "");
  assert.equal(state.selectedIndex, 0);
});

test("beginValueSearch and finishValueSearch track fresh value results", () => {
  const state = createSidebarSearchState();

  const token = beginValueSearch(state, "alice");
  finishValueSearch(state, "alice", [{ tableName: "player" }], token);

  assert.equal(state.valueLoading, false);
  assert.equal(state.valueError, "");
  assert.equal(sidebarValueResultsAreFresh(state), true);
  assert.equal(state.valueResults.length, 1);
});

test("clearValueSearchResults removes stale value result state", () => {
  const state = createSidebarSearchState();
  finishValueSearch(state, "alice", [{ tableName: "player" }]);

  clearValueSearchResults(state);

  assert.deepEqual(state.valueResults, []);
  assert.equal(state.valueSearchedQuery, "");
  assert.equal(state.valueError, "");
});

test("keyboard selection moves through grouped visible result items", () => {
  const state = createSidebarSearchState();
  state.query = "player";
  const schemaResults = [{ key: "schema:player", table: { tableName: "player" } }];
  finishValueSearch(state, "player", [{ tableName: "player", columnName: "nickname" }]);
  const items = buildVisibleSidebarSearchItems(schemaResults, state.valueResults);

  moveSidebarSearchSelection(state, items, 1);
  assert.equal(state.selectedIndex, 1);

  moveSidebarSearchSelection(state, items, 1);
  assert.equal(state.selectedIndex, 0);

  moveSidebarSearchSelection(state, items, -1);
  assert.equal(state.selectedIndex, 1);
});
```

- [ ] **Step 2: Run the focused test to confirm failure**

Run:

```bash
node --test src/workbench/sidebarSearchState.test.js
```

Expected: fail because `sidebarSearchState.js` does not exist.

- [ ] **Step 3: Implement the state helper module**

Create `src/workbench/sidebarSearchState.js`:

```js
export function createSidebarSearchState() {
  return {
    query: "",
    selectedIndex: 0,
    valueLoading: false,
    valueError: "",
    valueResults: [],
    valueSearchedQuery: "",
    valueSearchToken: 0,
  };
}

export function normalizeSidebarSearchQuery(value) {
  return String(value ?? "").trim();
}

export function clearValueSearchResults(state) {
  state.valueLoading = false;
  state.valueError = "";
  state.valueResults = [];
  state.valueSearchedQuery = "";
}

export function setSidebarSearchQuery(state, query) {
  const next = String(query ?? "");
  if (state.query === next) return;
  state.query = next;
  state.selectedIndex = 0;
  clearValueSearchResults(state);
}

export function beginValueSearch(state, query) {
  const normalized = normalizeSidebarSearchQuery(query);
  state.valueSearchToken += 1;
  state.valueLoading = Boolean(normalized);
  state.valueError = "";
  state.valueResults = [];
  state.valueSearchedQuery = "";
  return state.valueSearchToken;
}

export function finishValueSearch(state, query, results, token = state.valueSearchToken) {
  if (token !== state.valueSearchToken) return false;
  state.valueLoading = false;
  state.valueError = "";
  state.valueResults = Array.isArray(results) ? results : [];
  state.valueSearchedQuery = normalizeSidebarSearchQuery(query);
  state.selectedIndex = 0;
  return true;
}

export function failValueSearch(state, query, error, token = state.valueSearchToken) {
  if (token !== state.valueSearchToken) return false;
  state.valueLoading = false;
  state.valueError = String(error ?? "");
  state.valueResults = [];
  state.valueSearchedQuery = normalizeSidebarSearchQuery(query);
  state.selectedIndex = 0;
  return true;
}

export function sidebarValueResultsAreFresh(state) {
  const query = normalizeSidebarSearchQuery(state.query);
  return Boolean(query && state.valueSearchedQuery === query);
}

export function buildVisibleSidebarSearchItems(schemaResults = [], valueResults = []) {
  return [
    ...schemaResults.map((result, index) => ({
      key: result.key || `schema:${index}`,
      kind: "schema",
      result,
    })),
    ...valueResults.map((result, index) => ({
      key: `value:${result.tableName || index}:${result.columnName || ""}`,
      kind: "value",
      result,
    })),
  ];
}

export function clampSidebarSearchSelection(state, items) {
  const count = Array.isArray(items) ? items.length : 0;
  if (count === 0) {
    state.selectedIndex = -1;
    return -1;
  }
  if (state.selectedIndex < 0) state.selectedIndex = 0;
  if (state.selectedIndex >= count) state.selectedIndex = count - 1;
  return state.selectedIndex;
}

export function moveSidebarSearchSelection(state, items, delta) {
  const count = Array.isArray(items) ? items.length : 0;
  if (count === 0) {
    state.selectedIndex = -1;
    return -1;
  }
  const current = state.selectedIndex < 0 ? 0 : state.selectedIndex;
  state.selectedIndex = ((current + delta) % count + count) % count;
  return state.selectedIndex;
}
```

- [ ] **Step 4: Run the focused tests**

Run:

```bash
node --test src/workbench/sidebarSearchState.test.js
```

Expected: pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/workbench/sidebarSearchState.js src/workbench/sidebarSearchState.test.js
git commit -m "feat: add sidebar search state helpers"
```

## Task 3: Backend Value Search Helpers

**Files:**
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/demo.rs`

- [ ] **Step 1: Write failing Rust tests for LIKE escaping and demo value search**

In `src-tauri/src/db.rs`, append these tests inside `mod tests`:

```rust
#[test]
fn escape_like_pattern_escapes_wildcards_and_backslashes() {
    assert_eq!(escape_like_pattern("a%b_c\\d"), "%a\\%b\\_c\\\\d%");
}

#[test]
fn build_value_search_sql_uses_cast_like_and_limit_one() {
    let table = TableMeta {
        table_name: "player`profile".into(),
        table_comment: String::new(),
        columns: vec![
            ColumnMeta {
                column_name: "nickname".into(),
                column_type: "varchar(64)".into(),
                column_comment: String::new(),
                is_primary_key: false,
                is_nullable: false,
            },
            ColumnMeta {
                column_name: "remark`text".into(),
                column_type: "text".into(),
                column_comment: String::new(),
                is_primary_key: false,
                is_nullable: true,
            },
        ],
    };

    let (sql, bind_count) = build_value_search_sql(&table).expect("columns are searchable");

    assert!(sql.contains("FROM `player``profile`"));
    assert!(sql.contains("CAST(`nickname` AS CHAR) LIKE ? ESCAPE '\\\\'"));
    assert!(sql.contains("CAST(`remark``text` AS CHAR) LIKE ? ESCAPE '\\\\'"));
    assert!(sql.ends_with(" LIMIT 1"));
    assert_eq!(bind_count, 2);
}
```

In `src-tauri/src/demo.rs`, append this test inside `mod tests`:

```rust
#[test]
fn search_demo_values_returns_one_preview_per_table() {
    let schema = demo_schema_for("demo", "game_db");
    let rows = demo_rows();

    let results = search_demo_values(&schema, &rows, "冒险者", 50);

    assert!(results.iter().any(|item| item.table_name == "player"));
    assert!(results.iter().all(|item| !item.preview_value.is_empty()));
    assert!(results.iter().all(|item| !item.column_name.is_empty()));
}
```

- [ ] **Step 2: Run Rust tests to confirm failure**

Run:

```bash
cd src-tauri && cargo test
```

Expected: fail because `escape_like_pattern`, `build_value_search_sql`, and `search_demo_values` do not exist.

- [ ] **Step 3: Add search value types**

In `src-tauri/src/types.rs`, add these structs after `QuickSearchItem`:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchValuesRequest {
    pub connection_id: Option<String>,
    pub database: Option<String>,
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchValueItem {
    pub table_name: String,
    pub table_comment: String,
    pub column_name: String,
    pub preview_value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_identity: Option<HashMap<String, String>>,
}
```

- [ ] **Step 4: Add real-MySQL helper functions**

In `src-tauri/src/db.rs`, add these functions after `build_where`:

```rust
pub fn escape_like_pattern(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub fn build_value_search_sql(table: &TableMeta) -> Result<(String, usize), String> {
    let columns = table
        .columns
        .iter()
        .filter(|column| !column.column_name.trim().is_empty())
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Err("没有可搜索字段".into());
    }

    let select_sql = columns
        .iter()
        .map(|column| format!("CAST(`{}` AS CHAR) AS `{}`", escape_ident(&column.column_name), escape_ident(&column.column_name)))
        .collect::<Vec<_>>()
        .join(", ");
    let where_sql = columns
        .iter()
        .map(|column| format!("CAST(`{}` AS CHAR) LIKE ? ESCAPE '\\\\'", escape_ident(&column.column_name)))
        .collect::<Vec<_>>()
        .join(" OR ");
    let sql = format!(
        "SELECT {} FROM `{}` WHERE ({}) LIMIT 1",
        select_sql,
        escape_ident(&table.table_name),
        where_sql
    );
    Ok((sql, columns.len()))
}

pub async fn search_first_value_match(
    pool: &MySqlPool,
    table: &TableMeta,
    query: &str,
) -> Result<Option<SearchValueItem>, String> {
    let (sql, bind_count) = match build_value_search_sql(table) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let pattern = escape_like_pattern(query);
    let mut statement = sqlx::query(&sql);
    for _ in 0..bind_count {
        statement = statement.bind(&pattern);
    }
    let row = statement
        .fetch_optional(pool)
        .await
        .map_err(|error| format!("搜索值失败: {error}"))?;
    let Some(row) = row else {
        return Ok(None);
    };

    let needle = query.to_lowercase();
    for column in &table.columns {
        let value = row
            .try_get::<Option<String>, _>(column.column_name.as_str())
            .unwrap_or(None)
            .unwrap_or_default();
        if value.to_lowercase().contains(&needle) {
            return Ok(Some(SearchValueItem {
                table_name: table.table_name.clone(),
                table_comment: table.table_comment.clone(),
                column_name: column.column_name.clone(),
                preview_value: value.chars().take(80).collect(),
                row_identity: None,
            }));
        }
    }
    Ok(None)
}
```

- [ ] **Step 5: Add demo value search helper**

In `src-tauri/src/demo.rs`, add this public helper near the paging helpers:

```rust
pub fn search_demo_values(
    schema: &[TableMeta],
    rows: &HashMap<String, Vec<HashMap<String, String>>>,
    query: &str,
    limit: usize,
) -> Vec<SearchValueItem> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() || limit == 0 {
        return Vec::new();
    }

    let mut out = Vec::new();
    for table in schema {
        let Some(table_rows) = rows.get(&table.table_name) else {
            continue;
        };
        let mut found = None;
        'rows: for row in table_rows {
            for column in &table.columns {
                let value = row.get(&column.column_name).cloned().unwrap_or_default();
                if value.to_lowercase().contains(&needle) {
                    found = Some(SearchValueItem {
                        table_name: table.table_name.clone(),
                        table_comment: table.table_comment.clone(),
                        column_name: column.column_name.clone(),
                        preview_value: value.chars().take(80).collect(),
                        row_identity: None,
                    });
                    break 'rows;
                }
            }
        }
        if let Some(item) = found {
            out.push(item);
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}
```

Ensure `demo.rs` imports `HashMap` and `SearchValueItem` through the existing `use crate::types::*;` path. If `HashMap` is not already imported at the top, use:

```rust
use std::collections::HashMap;
```

- [ ] **Step 6: Run Rust tests**

Run:

```bash
cd src-tauri && cargo test
```

Expected: pass.

- [ ] **Step 7: Commit Task 3**

```bash
git add src-tauri/src/types.rs src-tauri/src/db.rs src-tauri/src/demo.rs
git commit -m "feat: add value search helpers"
```

## Task 4: Tauri and Mock `search_values` Command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/workbench/mock/mockBackend.js`
- Test: `src/workbench/mockBackend.test.js`

- [ ] **Step 1: Write failing frontend mock and shell tests**

Append to `src/workbench/mockBackend.test.js`:

```js
test("mock search_values returns first preview match per table", async () => {
  const results = await mockWorkbenchInvoke("search_values", {
    request: {
      connectionId: "demo",
      database: "game_db",
      query: "冒险者",
      limit: 50,
    },
  });

  assert.ok(results.some((item) => item.tableName === "player"));
  assert.ok(results.every((item) => item.previewValue));
  assert.ok(results.every((item) => item.columnName));
  assert.equal(results.every((item) => "matchCount" in item), false);
});
```

- [ ] **Step 2: Run failing JS tests**

Run:

```bash
node --test src/workbench/mockBackend.test.js
```

Expected: fail because `search_values` is not implemented in the mock backend yet.

- [ ] **Step 3: Implement mock command**

In `src/workbench/mock/mockBackend.js`, replace the `search_data` branch with this `search_values` branch:

```js
  if (command === "search_values") {
    const { connectionId, database } = resolveContext(payload.request || payload);
    const request = payload.request || payload;
    const query = String(request.query || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(50, Math.floor(Number(request.limit) || 50)));
    if (!query) return [];
    const schema = resolveMockSchema(connectionId, database);
    const results = [];
    for (const table of schema) {
      const rows = getOrInitRows(connectionId, database, table.table_name);
      let hit = null;
      for (const row of rows) {
        for (const col of table.columns) {
          const colName = col.column_name;
          const value = String(row[colName] ?? "");
          if (value.toLowerCase().includes(query)) {
            hit = {
              tableName: table.table_name,
              tableComment: table.table_comment || "",
              columnName: colName,
              previewValue: value.length > 80 ? value.slice(0, 80) : value,
            };
            break;
          }
        }
        if (hit) break;
      }
      if (hit) {
        results.push(hit);
        if (results.length >= limit) break;
      }
    }
    return results;
  }
```

- [ ] **Step 4: Register and implement Rust command**

In `src-tauri/src/lib.rs`, add the command to the invoke handler:

```rust
            commands::search_values,
```

In `src-tauri/src/commands.rs`, update imports:

```rust
use crate::demo::{demo_schema_for, demo_databases, read_demo_page, resolve_demo_table, search_demo_values};
use crate::db::{connect_database, list_tables_from_db, read_schema, read_db_page, escape_ident, build_where, search_first_value_match};
```

Add this command before `quick_search`:

```rust
#[tauri::command]
pub async fn search_values(request: SearchValuesRequest, state: State<'_, AppState>) -> Result<Vec<SearchValueItem>, String> {
    let query = request.query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = request.limit.unwrap_or(50).clamp(1, 50);
    let (connection_id, database, mysql_url, schema, demo_rows) = {
        let rt = state.runtime.lock().await;
        let connection_id = request.connection_id.clone().unwrap_or_else(|| rt.selected_connection_id.clone());
        let connection = rt
            .connections
            .get(&connection_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        let database = request
            .database
            .clone()
            .unwrap_or_else(|| connection.database.clone().unwrap_or_else(|| rt.selected_database.clone()));
        (
            connection_id,
            database,
            connection.mysql_url.clone(),
            rt.schema.clone(),
            rt.demo_rows.clone(),
        )
    };

    if database.trim().is_empty() {
        return Err("请先选择数据库".into());
    }

    if let Some(mysql_url) = mysql_url {
        let pool = connect_database(&mysql_url, Some(&database)).await?;
        let mut results = Vec::new();
        let tables = if schema.is_empty() {
            list_tables_from_db(&pool, &database)
                .await?
                .into_iter()
                .map(|table| TableMeta { table_name: table.table_name, table_comment: table.table_comment, columns: Vec::new() })
                .collect::<Vec<_>>()
        } else {
            schema
        };
        for table_ref in tables.iter() {
            let table = read_schema(&pool, &database, &table_ref.table_name).await?;
            if let Some(item) = search_first_value_match(&pool, &table, &query).await? {
                results.push(item);
                if results.len() >= limit {
                    break;
                }
            }
        }
        return Ok(results);
    }

    let schema = if schema.is_empty() {
        demo_schema_for(&connection_id, &database)
    } else {
        schema
    };
    Ok(search_demo_values(&schema, &demo_rows, &query, limit))
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test src/workbench/mockBackend.test.js
cd src-tauri && cargo test
cd src-tauri && cargo check
```

Expected: mock backend test passes; Rust tests and check pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/workbench/mock/mockBackend.js src/workbench/mockBackend.test.js
git commit -m "feat: add search_values command"
```

## Task 5: Table Session Return Value and Column Scroll Export

**Files:**
- Modify: `src/workbench/composables/useTableSession.js`
- Modify: `src/workbench/useTableSession.test.js`
- Modify: `src/workbench/composables/useVirtualGrid.js`
- Modify: `src/workbench/useVirtualGrid.test.js`

- [ ] **Step 1: Write failing tests for `openTable` return and exported column scroll**

In `src/workbench/useTableSession.test.js`, add:

```js
test("openTable returns the opened tab after loading", async () => {
  const workspace = createWorkspaceState({ connectionId: "demo", database: "game_db" });
  workspace.schema = [{ table_name: "player", table_comment: "玩家账号表", columns: [{ column_name: "id", is_primary_key: true }] }];
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_schema") return workspace.schema[0];
    if (command === "open_table_session") {
      return {
        sessionId: "s1",
        tableName: "player",
        tableComment: "玩家账号表",
        columns: [{ column_name: "id", is_primary_key: true }],
        primaryKeys: ["id"],
        rows: [{ id: "1" }],
        totalRows: 1,
        page: 1,
        pageSize: 1000,
      };
    }
    throw new Error(command);
  };
  const busy = { value: false };
  const statusText = { value: "" };
  const { openTable } = useTableSession(workspace, invoke, { busy, statusText });

  const tab = await openTable({ tableName: "player", connectionId: "demo", database: "game_db" });

  assert.equal(tab.tableName, "player");
  assert.equal(tab.sessionId, "s1");
  assert.equal(workspace.activeTabId, tab.id);
});
```

In `src/workbench/useVirtualGrid.test.js`, add a static assertion:

```js
test("useVirtualGrid exposes column scrolling for schema search activation", () => {
  const source = fs.readFileSync(new URL("./composables/useVirtualGrid.js", import.meta.url), "utf8");

  assert.match(source, /function\s+scrollColumnIntoView/);
  assert.match(source, /scrollColumnIntoView,/);
});
```

If `useVirtualGrid.test.js` does not already import `fs`, add:

```js
import fs from "node:fs";
```

- [ ] **Step 2: Run focused tests to confirm failure**

Run:

```bash
node --test src/workbench/useTableSession.test.js src/workbench/useVirtualGrid.test.js
```

Expected: `openTable` return assertion fails and `scrollColumnIntoView` export assertion fails.

- [ ] **Step 3: Return the opened tab from `openTable`**

In `src/workbench/composables/useTableSession.js`, add `return tab;` at the successful end of `openTable` after the status update:

```js
      statusText.value = `${database ? `${database}.` : ""}${tableName}：${page.totalRows} 行`;
      return tab;
```

Also return the existing tab path after it has been refreshed. The simplest implementation is the single `return tab;` above because `tab` is assigned for both new and existing tabs.

- [ ] **Step 4: Export `scrollColumnIntoView`**

In the return object of `useVirtualGrid`, add:

```js
    scrollColumnIntoView,
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test src/workbench/useTableSession.test.js src/workbench/useVirtualGrid.test.js
```

Expected: pass.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/workbench/composables/useTableSession.js src/workbench/useTableSession.test.js src/workbench/composables/useVirtualGrid.js src/workbench/useVirtualGrid.test.js
git commit -m "feat: expose table open and column scroll hooks"
```

## Task 6: Sidebar Search Panel Component

**Files:**
- Create: `src/workbench/components/SidebarSearchPanel.vue`
- Modify: `src/workbench/components/WorkbenchSidebar.vue`
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Write failing shell tests for grouped search UI**

Append to `src/workbench/workbenchShell.test.js`:

```js
test("sidebar search panel shows schema and value result groups", () => {
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const panel = read("./components/SidebarSearchPanel.vue");
  const styles = read("./workbench.css");

  assert.match(sidebar, /import\s+SidebarSearchPanel\s+from\s+["']\.\/SidebarSearchPanel\.vue["']/);
  assert.match(sidebar, /<SidebarSearchPanel/);
  assert.match(panel, /搜索表、备注、字段；回车搜索值/);
  assert.match(panel, /结构结果/);
  assert.match(panel, /值结果/);
  assert.match(panel, /按 Enter 搜索具体值/);
  assert.match(panel, /至少 1 处/);
  assert.match(panel, /search-values/);
  assert.match(panel, /open-schema-result/);
  assert.match(panel, /open-value-result/);
  assert.match(styles, /\.wb-sidebar-search-panel/);
  assert.match(styles, /\.wb-search-result-group/);
});
```

Update the existing sidebar structure test that currently asserts `placeholder="搜索表"`. Replace that assertion with:

```js
  assert.match(sidebar, /SidebarSearchPanel/);
```

Update the existing `sidebar search supports keyboard selection and enter open` test to read the new panel instead of the old sidebar-local functions:

```js
test("sidebar search supports keyboard selection and enter behavior", () => {
  const panel = read("./components/SidebarSearchPanel.vue");
  const styles = read("./workbench.css");

  assert.match(panel, /function\s+handleKeydown/);
  assert.match(panel, /ArrowDown/);
  assert.match(panel, /ArrowUp/);
  assert.match(panel, /Enter/);
  assert.match(panel, /moveSidebarSearchSelection/);
  assert.match(panel, /emit\(["']search-values["']\)/);
  assert.match(panel, /emit\(["']open-schema-result["']/);
  assert.match(panel, /emit\(["']open-value-result["']/);
  assert.match(panel, /keyboard-selected/);
  assert.match(panel, /aria-selected/);
  assert.match(styles, /\.wb-search-result\.keyboard-selected/);
});
```

- [ ] **Step 2: Run shell test to confirm failure**

Run:

```bash
node --test src/workbench/workbenchShell.test.js
```

Expected: fail because `SidebarSearchPanel.vue` does not exist.

- [ ] **Step 3: Create `SidebarSearchPanel.vue`**

Create `src/workbench/components/SidebarSearchPanel.vue`:

```vue
<script setup>
import { computed } from "vue";
import {
  buildVisibleSidebarSearchItems,
  clampSidebarSearchSelection,
  moveSidebarSearchSelection,
  sidebarValueResultsAreFresh,
} from "../sidebarSearchState.js";
import { columnName } from "../utils/normalize.js";

const props = defineProps({
  query: { type: String, default: "" },
  schemaResults: { type: Array, default: () => [] },
  searchState: { type: Object, required: true },
});

const emit = defineEmits([
  "update:query",
  "search-values",
  "open-schema-result",
  "open-value-result",
]);

const visibleItems = computed(() => buildVisibleSidebarSearchItems(props.schemaResults, props.searchState.valueResults));
const hasQuery = computed(() => props.query.trim().length > 0);
const hasFreshValues = computed(() => sidebarValueResultsAreFresh(props.searchState));
const selectedIndex = computed(() => clampSidebarSearchSelection(props.searchState, visibleItems.value));

function tableName(table) {
  return table?.tableName || table?.table_name || "";
}

function tableComment(table) {
  return table?.tableComment || table?.table_comment || "";
}

function activateItem(item) {
  if (!item) return;
  if (item.kind === "value") emit("open-value-result", item.result);
  else emit("open-schema-result", item.result);
}

function handleKeydown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveSidebarSearchSelection(props.searchState, visibleItems.value, 1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveSidebarSearchSelection(props.searchState, visibleItems.value, -1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (!hasFreshValues.value) {
      emit("search-values");
      return;
    }
    activateItem(visibleItems.value[selectedIndex.value]);
  }
}
</script>

<template>
  <section class="wb-sidebar-search-panel">
    <label class="wb-table-search">
      <span class="wb-visually-hidden">搜索表、备注、字段和值</span>
      <input
        :value="query"
        placeholder="搜索表、备注、字段；回车搜索值"
        @input="emit('update:query', $event.target.value)"
        @keydown="handleKeydown"
      />
    </label>

    <p v-if="hasQuery && !hasFreshValues && !searchState.valueLoading" class="wb-search-hint">按 Enter 搜索具体值</p>
    <p v-if="searchState.valueLoading" class="wb-search-hint">搜索值...</p>
    <p v-if="searchState.valueError" class="wb-search-error">{{ searchState.valueError }}</p>

    <section v-if="hasQuery" class="wb-search-result-group" aria-label="结构结果">
      <header class="wb-search-group-title">结构结果</header>
      <button
        v-for="(result, index) in schemaResults"
        :key="result.key"
        type="button"
        class="wb-search-result wb-schema-result"
        :class="{ 'keyboard-selected': selectedIndex === index }"
        :aria-selected="selectedIndex === index ? 'true' : undefined"
        @click="emit('open-schema-result', result)"
      >
        <span class="wb-object-icon" data-kind="table"></span>
        <span class="wb-search-result-copy">
          <span class="wb-table-name">{{ tableName(result.table) }}</span>
          <span v-if="tableComment(result.table)" class="wb-table-comment">{{ tableComment(result.table) }}</span>
          <span v-for="column in result.visibleColumns" :key="columnName(column)" class="wb-column-hit">
            字段: {{ columnName(column) }}<template v-if="column.column_comment || column.columnComment"> · {{ column.column_comment || column.columnComment }}</template>
          </span>
          <span v-if="result.hiddenColumnCount" class="wb-column-hit is-overflow">还有 {{ result.hiddenColumnCount }} 个字段命中</span>
        </span>
      </button>
      <p v-if="!schemaResults.length" class="wb-tree-empty">没有匹配的表或字段</p>
    </section>

    <section v-if="hasFreshValues || searchState.valueLoading" class="wb-search-result-group" aria-label="值结果">
      <header class="wb-search-group-title">值结果</header>
      <button
        v-for="(result, index) in searchState.valueResults"
        :key="`${result.tableName}:${result.columnName}`"
        type="button"
        class="wb-search-result wb-value-result"
        :class="{ 'keyboard-selected': selectedIndex === schemaResults.length + index }"
        :aria-selected="selectedIndex === schemaResults.length + index ? 'true' : undefined"
        @click="emit('open-value-result', result)"
      >
        <span class="wb-object-icon" data-kind="table"></span>
        <span class="wb-search-result-copy">
          <span class="wb-table-name">{{ result.tableName }}</span>
          <span v-if="result.tableComment" class="wb-table-comment">{{ result.tableComment }}</span>
          <span class="wb-value-hit">至少 1 处 · {{ result.columnName }}: {{ result.previewValue }}</span>
        </span>
      </button>
      <p v-if="hasFreshValues && !searchState.valueResults.length" class="wb-tree-empty">当前数据库没有匹配的值</p>
    </section>
  </section>
</template>
```

- [ ] **Step 4: Wire the panel into `WorkbenchSidebar.vue`**

In `src/workbench/components/WorkbenchSidebar.vue`:

Add import:

```js
import SidebarSearchPanel from "./SidebarSearchPanel.vue";
```

Replace props:

```js
  filteredTables: { type: Array, default: () => [] },
```

with:

```js
  schemaSearchResults: { type: Array, default: () => [] },
  sidebarSearchState: { type: Object, required: true },
```

Add emits:

```js
  "search-values",
  "open-schema-result",
  "open-value-result",
```

Add a computed table list for the normal tree:

```js
const filteredTables = computed(() => props.schemaSearchResults.map((result) => result.table));
```

Remove the old `selectedSearchIndex`, keyboard handlers, and watcher tied to `props.filteredTables`. The `SidebarSearchPanel` now owns visible result keyboard movement through `sidebarSearchState`.

Replace the inline `<label class="wb-table-search">...` and the old `v-for="(table, index) in filteredTables"` search block with:

```vue
<SidebarSearchPanel
  :query="treeQuery"
  :schema-results="schemaSearchResults"
  :search-state="sidebarSearchState"
  @update:query="emit('update:treeQuery', $event)"
  @search-values="emit('search-values')"
  @open-schema-result="emit('open-schema-result', $event)"
  @open-value-result="emit('open-value-result', $event)"
/>
```

Keep the existing table list only for the no-query tree view by rendering it when `!treeQuery.trim()`. Use the existing `filteredTables` computed for that normal list:

```vue
<template v-if="!treeQuery.trim()">
  <button
    v-for="table in filteredTables"
    :key="table.tableName"
    class="wb-tree-row wb-table-item"
    :data-table-name="table.tableName"
    :class="{ active: isTableActive(table) }"
    :aria-current="isTableActive(table) ? 'page' : undefined"
    :title="tableTitle(table)"
    @click="openSelectedTable(table)"
    @contextmenu.prevent.stop="emit('contextmenu', $event, table.raw || table)"
  >
    <span class="wb-tree-spacer" aria-hidden="true"></span>
    <span class="wb-object-icon" data-kind="table"></span>
    <span class="wb-table-copy" :class="{ 'has-comment': table.tableComment }">
      <span class="wb-table-name">{{ table.tableName }}</span>
      <span v-if="table.tableComment" class="wb-table-comment">{{ table.tableComment }}</span>
    </span>
  </button>
</template>
```

- [ ] **Step 5: Add CSS styles**

In `src/workbench/workbench.css`, add near the existing sidebar search styles:

```css
.wb-sidebar-search-panel {
  margin: 2px 5px 7px 0;
}

.wb-search-hint,
.wb-search-error,
.wb-search-group-title {
  margin: 5px 0 4px 31px;
  font-size: 11px;
  color: var(--wb-quiet-text);
}

.wb-search-error {
  color: var(--wb-danger);
}

.wb-search-result-group {
  display: grid;
  gap: 2px;
  margin-top: 5px;
}

.wb-search-result {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: start;
  width: 100%;
  min-height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--wb-tree-text);
  text-align: left;
  cursor: default;
}

.wb-search-result:hover,
.wb-search-result.keyboard-selected {
  background: var(--wb-accent-soft);
}

.wb-search-result-copy {
  display: grid;
  min-width: 0;
  gap: 1px;
  padding: 3px 0;
}

.wb-column-hit,
.wb-value-hit {
  overflow: hidden;
  color: var(--wb-remark-text);
  font-size: 11px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-column-hit.is-overflow {
  color: var(--wb-quiet-text);
}
```

This uses the existing `--wb-danger` token. Do not introduce hard-coded colors.

- [ ] **Step 6: Run shell tests**

Run:

```bash
node --test src/workbench/workbenchShell.test.js
```

Expected: all existing shell tests and this task's grouped UI test pass.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/workbench/components/SidebarSearchPanel.vue src/workbench/components/WorkbenchSidebar.vue src/workbench/workbench.css src/workbench/workbenchShell.test.js
git commit -m "feat: add sidebar grouped search panel"
```

## Task 7: Frontend Orchestration and Result Activation

**Files:**
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Write failing shell tests for orchestration and activation**

Append to `src/workbench/workbenchShell.test.js`:

```js
test("sidebar value result activation opens table and runs table search", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const mock = read("./mock/mockBackend.js");

  assert.match(orchestrator, /createSidebarSearchState/);
  assert.match(orchestrator, /buildSchemaSearchResults/);
  assert.match(orchestrator, /runSidebarValueSearch/);
  assert.match(orchestrator, /invokeWorkbench\(["']search_values["']/);
  assert.match(orchestrator, /openSidebarValueResult/);
  assert.match(orchestrator, /openSidebarSchemaResult/);
  assert.match(orchestrator, /runTableSearch\(query\)/);
  assert.match(orchestrator, /scrollColumnIntoView/);
  assert.match(orchestrator, /@search-values="runSidebarValueSearch"/);
  assert.match(orchestrator, /@open-schema-result="openSidebarSchemaResult"/);
  assert.match(orchestrator, /@open-value-result="openSidebarValueResult"/);
  assert.match(mock, /command === ["']search_values["']/);
  assert.doesNotMatch(orchestrator, /invokeWorkbench\(["']search_data["']/);
});
```

- [ ] **Step 2: Run shell tests to confirm failure**

Run:

```bash
node --test src/workbench/workbenchShell.test.js
```

Expected: fail because the orchestrator does not yet import or use the new search state and result activation functions.

- [ ] **Step 3: Import new helpers and state**

In `src/workbench/MySqlWorkbench.vue`, update imports:

```js
import {
  buildSchemaSearchResults,
  closeAllTableTabs,
  closeTableTab,
  createWorkspaceState,
  filterSchemaTree,
  getActiveTab,
  moveTableTab,
} from "./workspaceState.js";
import {
  beginValueSearch,
  createSidebarSearchState,
  failValueSearch,
  finishValueSearch,
  normalizeSidebarSearchQuery,
  setSidebarSearchQuery,
} from "./sidebarSearchState.js";
```

Keep `filterSchemaTree` only if an existing computed still needs it during the transition. Remove it after `filteredTables` is fully replaced by `schemaSearchResults`.

Replace:

```js
const treeQuery = ref("");
```

with:

```js
const sidebarSearch = reactive(createSidebarSearchState());
const treeQuery = computed({
  get: () => sidebarSearch.query,
  set: (value) => setSidebarSearchQuery(sidebarSearch, value),
});
```

- [ ] **Step 4: Build schema search results for the sidebar**

Replace the old `filteredTables` computed with:

```js
const schemaSearchSource = computed(() =>
  workspace.schema.map((table) => ({
    tableName: normalizeTableName(table),
    tableComment: normalizeTableComment(table),
    columns: table.columns || [],
    raw: {
      ...table,
      connectionId: selectedConnectionId.value,
      database: selectedDatabase.value,
    },
  })),
);

const schemaSearchResults = computed(() =>
  buildSchemaSearchResults(schemaSearchSource.value, treeQuery.value),
);

const filteredTables = computed(() => schemaSearchResults.value.map((result) => result.table));
```

The `filteredTables` computed can stay for existing normal tree rendering and compatibility.

- [ ] **Step 5: Include `scrollColumnIntoView` from the virtual grid composable**

Change the `useVirtualGrid` destructuring to include:

```js
const { gridWrapRef, virtualRange, onGridScroll, scrollRowIntoView, scrollColumnIntoView, scrollCellIntoView, scrollInsertCellIntoView, visibleRows } =
  useVirtualGrid(activeTab, editState);
```

- [ ] **Step 6: Add sidebar value search orchestration**

Add these functions near other local helpers in `MySqlWorkbench.vue`:

```js
async function runSidebarValueSearch() {
  const query = normalizeSidebarSearchQuery(treeQuery.value);
  if (!query) {
    return;
  }
  if (!selectedDatabase.value) {
    sidebarSearch.valueError = "请先选择数据库";
    statusText.value = "请先选择数据库";
    return;
  }

  const token = beginValueSearch(sidebarSearch, query);
  statusText.value = "搜索值...";
  try {
    const results = await invokeWorkbench("search_values", {
      request: {
        connectionId: selectedConnectionId.value,
        database: selectedDatabase.value,
        query,
        limit: 50,
      },
    });
    if (finishValueSearch(sidebarSearch, query, results, token)) {
      statusText.value = `值命中 ${sidebarSearch.valueResults.length} 张表`;
    }
  } catch (error) {
    if (failValueSearch(sidebarSearch, query, String(error), token)) {
      statusText.value = `值搜索失败：${String(error)}`;
    }
  }
}
```

- [ ] **Step 7: Add schema result activation**

Add this function in `MySqlWorkbench.vue`:

```js
async function openSidebarSchemaResult(result) {
  const table = result?.table?.raw || result?.table;
  if (!table) return;
  resetGridState();
  const tab = await openTable(table);
  const firstColumn = result.visibleColumns?.[0] || result.matchedColumns?.[0];
  const targetColumn = columnName(firstColumn);
  if (!tab || !targetColumn) return;
  await nextTick();
  const columnIndex = (tab.columns || []).findIndex((column) => columnName(column) === targetColumn);
  if (columnIndex >= 0) scrollColumnIntoView(columnIndex, "th");
}
```

- [ ] **Step 8: Add value result activation**

Add this function in `MySqlWorkbench.vue`:

```js
async function openSidebarValueResult(result) {
  if (!result?.tableName) return;
  const query = normalizeSidebarSearchQuery(sidebarSearch.valueSearchedQuery || treeQuery.value);
  resetGridState();
  const tab = await openTable({
    tableName: result.tableName,
    tableComment: result.tableComment || "",
    connectionId: selectedConnectionId.value,
    database: selectedDatabase.value,
  });
  if (!tab || !query) return;
  tab.filter = query;
  tab.searchQuery = query;
  await nextTick();
  await runTableSearch(query);
}
```

- [ ] **Step 9: Update `openTableFromSidebar` to await `openTable`**

Replace:

```js
function openTableFromSidebar(table) {
  resetGridState();
  openTable(table);
}
```

with:

```js
async function openTableFromSidebar(table) {
  resetGridState();
  await openTable(table);
}
```

- [ ] **Step 10: Pass new props and events to `WorkbenchSidebar`**

In the template, replace:

```vue
:filtered-tables="filteredTables"
:tree-query="treeQuery"
```

with:

```vue
:schema-search-results="schemaSearchResults"
:sidebar-search-state="sidebarSearch"
:tree-query="treeQuery"
```

Add events:

```vue
@search-values="runSidebarValueSearch"
@open-schema-result="openSidebarSchemaResult"
@open-value-result="openSidebarValueResult"
```

- [ ] **Step 11: Run focused shell tests**

Run:

```bash
node --test src/workbench/workbenchShell.test.js
```

Expected: pass.

- [ ] **Step 12: Run frontend unit tests touched so far**

Run:

```bash
node --test src/workbench/workspaceState.test.js src/workbench/sidebarSearchState.test.js src/workbench/mockBackend.test.js src/workbench/useTableSession.test.js src/workbench/useVirtualGrid.test.js src/workbench/workbenchShell.test.js
```

Expected: pass.

- [ ] **Step 13: Commit Task 7**

```bash
git add src/workbench/MySqlWorkbench.vue src/workbench/workbenchShell.test.js
git commit -m "feat: wire sidebar search activation"
```

## Task 8: Final Styling, Full Verification, and Cleanup

**Files:**
- No planned new files.
- If verification fails, modify only the file named by the failing test, compiler error, or browser smoke check from Tasks 1-7.

- [ ] **Step 1: Run full frontend tests**

Run:

```bash
node --test src/workbench
```

Expected: all JS tests pass.

- [ ] **Step 2: Run Rust tests and check**

Run:

```bash
cd src-tauri && cargo test
cd src-tauri && cargo check
```

Expected: all Rust tests pass and `cargo check` exits successfully.

- [ ] **Step 3: Run frontend build**

Run:

```bash
npm run build
```

Expected: Vite build succeeds and writes `dist/`.

- [ ] **Step 4: Start the frontend dev server**

Run:

```bash
npm run dev
```

Expected: Vite reports a local URL on port `1431` or another available port. Keep the server running for the browser verification step.

- [ ] **Step 5: Browser smoke test**

Use the Browser plugin or Playwright to open the local Vite URL.

Manual checks:

- Sidebar input placeholder says `搜索表、备注、字段；回车搜索值`.
- Typing `昵称` shows a structure result with a column row.
- Typing does not show value results before Enter.
- Pressing Enter shows the value result group or the no-results value empty state.
- Clicking a value result opens the table and selects a matching cell.
- The current table toolbar search still supports Ctrl+F and next/previous navigation.

- [ ] **Step 6: Stop the dev server**

Stop the `npm run dev` process started in Step 4.

Expected: no development server remains running from this task.

- [ ] **Step 7: Review final diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only files from this plan are changed. The pre-existing `src-tauri/Cargo.toml` modification may still appear if it was present before execution; do not stage it unless the user explicitly asks.

- [ ] **Step 8: Commit final cleanup if any files changed in Task 8**

If Task 8 made code or CSS fixes, commit them:

```bash
git add src/workbench/workbench.css src/workbench/*.js src/workbench/*.test.js src/workbench/components/*.vue src/workbench/composables/*.js src-tauri/src/*.rs
git commit -m "fix: polish sidebar search integration"
```

If Task 8 made no additional changes, do not create an empty commit.

## Final Acceptance Checklist

- [ ] Sidebar typing previews table name, table comment, column name, and column comment matches.
- [ ] Pressing Enter is the only action that invokes `search_values`.
- [ ] Value search sends the selected `connectionId` and `database`.
- [ ] Value results show one preview per table and use `至少 1 处`.
- [ ] Clicking a schema table hit opens the table.
- [ ] Clicking a schema column hit opens the table and reveals the column.
- [ ] Clicking a value hit opens the table and selects a matching cell through `runTableSearch`.
- [ ] The old `search_data` command is not used by frontend code.
- [ ] Existing table toolbar search behavior remains unchanged.
- [ ] `node --test src/workbench` passes.
- [ ] `cd src-tauri && cargo test` passes.
- [ ] `cd src-tauri && cargo check` passes.
- [ ] `npm run build` passes.
