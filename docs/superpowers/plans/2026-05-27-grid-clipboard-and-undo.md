# Grid Clipboard And Undo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add spreadsheet-style row copy/paste-as-new, selection-first insert cells, `Delete` clearing, row-header actions, and reliable operation-level undo to the database grid.

**Architecture:** Introduce a small structured clipboard state for internal whole-row copies and replace cell-only undo entries with table-scoped mutation operations. Extend Rust and mock mutation responses so inserts return persisted identities/snapshots and deletes report the identities actually removed; the UI composes those results without assuming a database row position.

**Tech Stack:** Vue 3 `<script setup>`, JavaScript ES modules, Node.js `node:test`, Tauri 2, Rust, sqlx/MySQL, Vite.

---

## File Structure

- Create `src/workbench/clipboardState.js`: pure internal row-payload and target-column mapping functions; no database calls.
- Create `src/workbench/clipboardState.test.js`: structured clipboard and generated-column mapping tests.
- Modify `src/workbench/editState.js`: pending-cell state plus generic operation-history helpers.
- Modify `src/workbench/editState.test.js`: operation history recording/pop behavior.
- Modify `src/workbench/utils/rowIdentity.js`: deterministic serialization for identities returned by Rust maps.
- Create `src/workbench/rowIdentity.test.js`: stable identity-key ordering regression test.
- Modify `src/workbench/composables/useUndo.js`: sole execution owner for inverse mutations.
- Create `src/workbench/useUndo.test.js`: cell, insert, delete, conflict, and cross-table undo tests.
- Modify `src/workbench/composables/useGridEditor.js`: selection-first insert row, `Delete`, clipboard routing, insert recording, and remove duplicate undo logic.
- Modify `src/workbench/useGridEditor.test.js`: keyboard selection, paste, clear, partial insert, and history tests.
- Modify `src/workbench/composables/useRowSelection.js`: row context selection and undoable delete outcomes.
- Modify `src/workbench/useRowSelection.test.js`: context selection and successful-delete snapshot tests.
- Modify `src/workbench/composables/useContextMenu.js`: distinguish general/table refresh menus from row menus.
- Modify `src/workbench/useContextMenu.test.js`: row-context target/state coverage.
- Modify `src/workbench/components/DataGrid.vue`: insert selection/edit rendering and row-header context event.
- Modify `src/workbench/components/ContextMenu.vue`: conditionally render row actions in the existing styled menu.
- Modify `src/workbench/MySqlWorkbench.vue`: instantiate clipboard/history collaborators and route row-menu actions.
- Modify `src/workbench/workbench.css`: reuse `--wb-*` tokens for insert-cell selection/edit detail and menu separators only if required.
- Modify `src/workbench/workbenchShell.test.js`: component wiring and refresh-only non-row menu contract.
- Modify `src/workbench/mock/mockSchema.js`: identify mock generated fields.
- Modify `src/workbench/mock/mockBackend.js`: generate IDs and mirror insert/delete result contracts.
- Create `src/workbench/mockBackendMutations.test.js`: browser-mode mutation-contract tests.
- Modify `src-tauri/src/types.rs`: column generation metadata and mutation result structures.
- Modify `src-tauri/src/db.rs`: schema generation metadata and row identity/readback helpers.
- Modify `src-tauri/src/demo.rs`: demo metadata parity and unit expectations.
- Modify `src-tauri/src/commands.rs`: persisted insert response and per-identity delete result.

The requested database synchronization workflow is intentionally absent from this plan; it needs a separate destructive-operation design.

### Task 1: Return Stable Mutation Results From Rust And The Mock Backend

**Files:**
- Modify: `src-tauri/src/types.rs:36-125`
- Modify: `src-tauri/src/db.rs:17-27,83-123,229-295`
- Modify: `src-tauri/src/demo.rs:6-15,724-764`
- Modify: `src-tauri/src/commands.rs:236-355`
- Modify: `src/workbench/mock/mockSchema.js:1-8`
- Modify: `src/workbench/mock/mockBackend.js:74-108,171-196`
- Create: `src/workbench/mockBackendMutations.test.js`

- [ ] **Step 1: Write failing Rust tests for generated metadata and identity selection**

In `src-tauri/src/db.rs`, extend the unit-test fixtures with `is_generated` and add pure-helper tests before the helper implementation:

```rust
#[test]
fn row_identity_uses_primary_keys_and_falls_back_to_values() {
    let keyed = TableMeta {
        table_name: "hero".into(),
        table_comment: String::new(),
        columns: vec![
            ColumnMeta {
                column_name: "id".into(),
                column_type: "int".into(),
                column_comment: String::new(),
                is_primary_key: true,
                is_nullable: false,
                is_generated: true,
                is_auto_increment: true,
            },
            ColumnMeta {
                column_name: "name".into(),
                column_type: "varchar(32)".into(),
                column_comment: String::new(),
                is_primary_key: false,
                is_nullable: false,
                is_generated: false,
                is_auto_increment: false,
            },
        ],
    };
    let row = HashMap::from([("id".into(), "41".into()), ("name".into(), "mage".into())]);
    assert_eq!(row_identity(&keyed, &row), HashMap::from([("id".into(), "41".into())]));

    let unkeyed = TableMeta { columns: keyed.columns.iter().map(|column| ColumnMeta { is_primary_key: false, ..column.clone() }).collect(), ..keyed };
    assert_eq!(row_identity(&unkeyed, &row), row);
}

#[test]
fn generated_columns_are_recognized_from_mysql_extra_values() {
    assert!(is_generated_column("auto_increment", ""));
    assert!(is_generated_column("DEFAULT_GENERATED", "(`qty` * `price`)"));
    assert!(!is_generated_column("DEFAULT_GENERATED", ""));
    assert!(is_auto_increment_column("auto_increment"));
    assert!(!is_auto_increment_column("STORED GENERATED"));
}

#[test]
fn safe_insert_lookup_requires_complete_key_or_complete_plain_row() {
    let keyed = TableMeta {
        table_name: "keyed".into(),
        table_comment: String::new(),
        columns: vec![ColumnMeta {
            column_name: "id".into(), column_type: "int".into(), column_comment: String::new(),
            is_primary_key: true, is_nullable: false, is_generated: true, is_auto_increment: true,
        }],
    };
    assert!(has_safe_insert_lookup(&keyed, &HashMap::new(), &HashMap::from([("id".into(), "9".into())])));
    assert!(!has_safe_insert_lookup(&keyed, &HashMap::new(), &HashMap::new()));
}
```

Update existing `ColumnMeta` literals in `db.rs` tests with
`is_generated: false, is_auto_increment: false`.

- [ ] **Step 2: Run Rust tests to verify RED**

Run: `cd src-tauri && cargo test db::tests --lib`

Expected: FAIL because generation fields, `row_identity`, and the generation
helpers are not defined.

- [ ] **Step 3: Extend the Rust contract and schema metadata**

In `src-tauri/src/types.rs`, add generated-column metadata and replace aggregate-only row mutation responses with persisted outcomes:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct ColumnMeta {
    pub column_name: String,
    pub column_type: String,
    pub column_comment: String,
    pub is_primary_key: bool,
    pub is_nullable: bool,
    pub is_generated: bool,
    pub is_auto_increment: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedRowResult {
    pub identity: HashMap<String, String>,
    pub row: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertRowResult {
    pub affected: u64,
    pub inserted: Option<PersistedRowResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRowsResult {
    pub affected: u64,
    pub deleted_identities: Vec<HashMap<String, String>>,
    pub failed_identities: Vec<HashMap<String, String>>,
}
```

In `src-tauri/src/db.rs`, add helpers and select MySQL generation metadata:

```rust
pub fn is_generated_column(extra: &str, generation_expression: &str) -> bool {
    extra.to_ascii_lowercase().contains("auto_increment")
        || !generation_expression.trim().is_empty()
}

pub fn is_auto_increment_column(extra: &str) -> bool {
    extra.to_ascii_lowercase().contains("auto_increment")
}

pub fn row_identity(table: &TableMeta, row: &HashMap<String, String>) -> HashMap<String, String> {
    let keys = primary_keys(table);
    let selected = if keys.is_empty() {
        table.columns.iter().map(|column| column.column_name.clone()).collect::<Vec<_>>()
    } else {
        keys
    };
    selected
        .into_iter()
        .map(|key| (key.clone(), row.get(&key).cloned().unwrap_or_default()))
        .collect()
}

pub fn has_safe_insert_lookup(
    table: &TableMeta,
    draft: &HashMap<String, String>,
    lookup: &HashMap<String, String>,
) -> bool {
    let keys = primary_keys(table);
    if !keys.is_empty() {
        return keys.iter().all(|key| lookup.contains_key(key));
    }
    table.columns.iter().all(|column| {
        !column.is_generated && draft.contains_key(&column.column_name)
    })
}
```

Update the `information_schema.COLUMNS` query and conversion:

```rust
"SELECT COLUMN_NAME, COLUMN_TYPE, COALESCE(COLUMN_COMMENT, '') AS COLUMN_COMMENT, \
 COLUMN_KEY = 'PRI' AS IS_PRIMARY_KEY, IS_NULLABLE = 'YES' AS IS_NULLABLE, \
 COALESCE(EXTRA, '') AS EXTRA, COALESCE(GENERATION_EXPRESSION, '') AS GENERATION_EXPRESSION \
 FROM information_schema.COLUMNS \
 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION"
```

```rust
is_generated: is_generated_column(
    &row.try_get::<String, _>("EXTRA").unwrap_or_default(),
    &row.try_get::<String, _>("GENERATION_EXPRESSION").unwrap_or_default(),
),
is_auto_increment: is_auto_increment_column(
    &row.try_get::<String, _>("EXTRA").unwrap_or_default(),
),
```

Add a helper which reads one complete persisted row from an identity using the same `CAST(... AS CHAR)` presentation used by table pages:

```rust
pub async fn read_row_by_identity(
    pool: &MySqlPool,
    table: &TableMeta,
    identity: &HashMap<String, String>,
) -> Result<Option<HashMap<String, String>>, String> {
    let select_columns = table.columns.iter()
        .map(|column| format!("CAST(`{}` AS CHAR) AS `{}`", escape_ident(&column.column_name), escape_ident(&column.column_name)))
        .collect::<Vec<_>>().join(", ");
    let (where_sql, values) = build_where(identity)?;
    let sql = format!("SELECT {} FROM `{}` WHERE {} LIMIT 1", select_columns, escape_ident(&table.table_name), where_sql);
    let mut query = sqlx::query(&sql);
    for value in values { query = query.bind(value); }
    let row = query.fetch_optional(pool).await.map_err(|error| format!("读取写入结果失败: {error}"))?;
    Ok(row.map(|row| table.columns.iter().map(|column| {
        let value = row.try_get::<Option<String>, _>(column.column_name.as_str()).unwrap_or(None).unwrap_or_default();
        (column.column_name.clone(), value)
    }).collect()))
}
```

- [ ] **Step 4: Return inserted rows and actually deleted identities**

In `src-tauri/src/commands.rs`, import `primary_keys`, `read_schema`,
`read_row_by_identity`, `has_safe_insert_lookup`, and `row_identity`. Change
`insert_row` to return
`Result<InsertRowResult, String>`, retain its existing session lookup and
parameterized `INSERT`, and replace the empty-content guard with:

```rust
if request.draft.is_empty() {
    return Ok(InsertRowResult { affected: 0, inserted: None });
}
```

This allows a copied row containing explicit empty-string values to insert
while the frontend continues to prevent empty manual drafts.

Use this concrete MySQL identity construction after `query.execute(&pool)`.
If the inserted row cannot be safely read back after the insert has already
committed, return `affected > 0` with `inserted: None`; the frontend reports
the successful but non-undoable insert instead of falsely reporting failure:

```rust
let result = query.execute(&pool).await.map_err(|error| format!("插入失败: {error}"))?;
let table = read_schema(&pool, &session.database, &session.table_name).await?;
let keys = primary_keys(&table);
let mut primary_lookup = HashMap::new();
for key in &keys {
    if let Some(value) = draft.get(key) {
        primary_lookup.insert(key.clone(), value.clone());
    } else if table.columns.iter().any(|column| column.column_name == *key && column.is_auto_increment) {
        primary_lookup.insert(key.clone(), result.last_insert_id().to_string());
    }
}
let lookup = if !keys.is_empty() && primary_lookup.len() == keys.len() {
    primary_lookup
} else {
    draft.clone()
};
let inserted = if has_safe_insert_lookup(&table, &draft, &lookup) {
    read_row_by_identity(&pool, &table, &lookup).await
        .ok()
        .flatten()
        .map(|row| PersistedRowResult { identity: row_identity(&table, &row), row })
} else {
    None
};
return Ok(InsertRowResult {
    affected: result.rows_affected(),
    inserted,
});
```

For a table without real primary keys, only use a logical draft lookup when
the inserted draft supplies every non-generated column needed to recreate the
row identity and no omitted generated/default value could distinguish it from
an existing row. Otherwise, return `inserted: None` after the successful
insert. This preserves the specification's logical-identity fallback for fully
copied rows while refusing to guess an undo identity for partial/default-driven
inserts.

For demo mode, resolve the table from runtime schema, fill an omitted
auto-increment key, append the persisted row, and return exactly the same
contract:

```rust
let mut rt = state.runtime.lock().await;
let table = resolve_demo_table(&session.table_name, &rt.schema)?;
let rows = rt.demo_rows.entry(session.table_name).or_default();
let mut row = draft;
for column in table.columns.iter().filter(|column| column.is_auto_increment && column.is_primary_key) {
    if !row.contains_key(&column.column_name) {
        let next_id = rows.iter()
            .filter_map(|item| item.get(&column.column_name)?.parse::<u64>().ok())
            .max().unwrap_or(0) + 1;
        row.insert(column.column_name.clone(), next_id.to_string());
    }
}
rows.push(row.clone());
Ok(InsertRowResult {
    affected: 1,
    inserted: Some(PersistedRowResult { identity: row_identity(&table, &row), row }),
})
```

Replace `delete_rows` with `Result<DeleteRowsResult, String>` and evaluate each requested identity independently:

```rust
let mut deleted_identities = Vec::new();
let mut failed_identities = Vec::new();
for identity in &request.row_identities {
    let (where_sql, values) = build_where(identity)?;
    let sql = format!("DELETE FROM `{}` WHERE {} LIMIT 1", escape_ident(&session.table_name), where_sql);
    let mut query = sqlx::query(&sql);
    for value in values { query = query.bind(value); }
    match query.execute(&pool).await {
        Ok(result) if result.rows_affected() > 0 => deleted_identities.push(identity.clone()),
        Ok(_) | Err(_) => failed_identities.push(identity.clone()),
    }
}
Ok(DeleteRowsResult {
    affected: deleted_identities.len() as u64,
    deleted_identities,
    failed_identities,
})
```

Apply the equivalent result construction in demo mode, deleting at most one row for each identity so its no-primary-key behavior matches `DELETE ... LIMIT 1`.

- [ ] **Step 5: Keep demo and browser mock contracts aligned**

In `src-tauri/src/demo.rs`, add `is_generated` to the local `cm` helpers and mark demo `id` primary-key columns generated:

```rust
fn cm(name: &str, typ: &str, comment: &str, pk: bool, nullable: bool) -> ColumnMeta {
    ColumnMeta {
        column_name: name.into(),
        column_type: typ.into(),
        column_comment: comment.into(),
        is_primary_key: pk,
        is_nullable: nullable,
        is_generated: pk && name == "id",
        is_auto_increment: pk && name == "id",
    }
}
```

In `src/workbench/mock/mockSchema.js`, expose the same field:

```js
const cm = (name, type, comment, pk = false, nullable = false, generated = pk && name === "id", autoIncrement = generated && pk) => ({
  column_name: name,
  column_type: type,
  column_comment: comment,
  is_primary_key: pk,
  is_nullable: nullable,
  is_generated: generated,
  is_auto_increment: autoIncrement,
});
```

Update `src/workbench/mock/mockBackend.js` so `insert_row` allocates an omitted generated numeric primary key and returns:

```js
const table = resolveMockSchema(connectionId, database).find((candidate) => candidate.table_name === tableName);
if (!Object.keys(payload.request?.draft || {}).length) return { affected: 0, inserted: null };
const inserted = { ...(payload.request?.draft || {}) };
for (const column of table.columns.filter((candidate) => candidate.is_auto_increment && candidate.is_primary_key)) {
  if (inserted[column.column_name] == null) {
    const highest = rows.reduce((max, row) => Math.max(max, Number(row[column.column_name]) || 0), 0);
    inserted[column.column_name] = String(highest + 1);
  }
}
rows.push(inserted);
const identity = Object.fromEntries(
  (table.columns.filter((column) => column.is_primary_key).map(columnName).length
    ? table.columns.filter((column) => column.is_primary_key).map(columnName)
    : table.columns.map(columnName))
    .map((key) => [key, String(inserted[key] ?? "")]),
);
return { affected: 1, inserted: { identity, row: { ...inserted } } };
```

Return `{ affected, deletedIdentities, failedIdentities }` from mock `delete_rows`, removing at most one matching row per requested identity.

- [ ] **Step 6: Write and run mock-contract tests**

Create `src/workbench/mockBackendMutations.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mockWorkbenchInvoke } from "./mock/mockBackend.js";

async function openPlayerSession() {
  const page = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
    options: { page: 1, pageSize: 1000 },
  });
  return page.sessionId;
}

test("mock insert returns generated identity and persisted row", async () => {
  const sessionId = await openPlayerSession();
  const result = await mockWorkbenchInvoke("insert_row", {
    request: { sessionId, draft: { username: "pasted-user", nickname: "Pasted" } },
  });
  assert.equal(result.affected, 1);
  assert.ok(Number(result.inserted.identity.id) > 0);
  assert.equal(result.inserted.row.username, "pasted-user");
});

test("mock delete reports only identities actually removed", async () => {
  const sessionId = await openPlayerSession();
  const inserted = await mockWorkbenchInvoke("insert_row", {
    request: { sessionId, draft: { username: "remove-me" } },
  });
  const result = await mockWorkbenchInvoke("delete_rows", {
    request: { sessionId, rowIdentities: [inserted.inserted.identity, { id: "-missing-" }] },
  });
  assert.equal(result.affected, 1);
  assert.deepEqual(result.deletedIdentities, [inserted.inserted.identity]);
  assert.deepEqual(result.failedIdentities, [{ id: "-missing-" }]);
});
```

Run: `node --test src/workbench/mockBackendMutations.test.js && (cd src-tauri && cargo test --lib)`

Expected: PASS.

- [ ] **Step 7: Commit the mutation contract**

```bash
git add src-tauri/src/types.rs src-tauri/src/db.rs src-tauri/src/demo.rs src-tauri/src/commands.rs src/workbench/mock/mockSchema.js src/workbench/mock/mockBackend.js src/workbench/mockBackendMutations.test.js
git commit -m "feat: return stable row mutation outcomes"
```

### Task 2: Add Structured Whole-Row Clipboard State

**Files:**
- Create: `src/workbench/clipboardState.js`
- Create: `src/workbench/clipboardState.test.js`

- [ ] **Step 1: Write failing clipboard-state tests**

Create `src/workbench/clipboardState.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  createClipboardState,
  captureRowCopy,
  mapCopiedRowsForInsert,
  matchesClipboardText,
} from "./clipboardState.js";

const sourceColumns = [{ column_name: "id" }, { column_name: "name" }, { column_name: "level" }];

test("captured whole rows serialize data only while retaining column names", () => {
  const state = createClipboardState();
  const text = captureRowCopy(state, sourceColumns, [
    { id: "1", name: "Alice", level: "10" },
    { id: "2", name: "Bob", level: "12" },
  ]);
  assert.equal(text, "1\tAlice\t10\n2\tBob\t12");
  assert.deepEqual(state.rowPayload.columns, ["id", "name", "level"]);
  assert.equal(matchesClipboardText(state, text), true);
  assert.equal(matchesClipboardText(state, "changed"), false);
});

test("insert mapping omits generated columns but keeps natural primary keys and blanks", () => {
  const state = createClipboardState();
  captureRowCopy(state, sourceColumns, [{ id: "8", name: "", level: "20" }]);
  const targetColumns = [
    { column_name: "id", is_primary_key: true, is_generated: true },
    { column_name: "name", is_primary_key: true, is_generated: false },
    { column_name: "level", is_generated: false },
  ];
  assert.deepEqual(mapCopiedRowsForInsert(state, targetColumns), {
    drafts: [{ name: "", level: "20" }],
    skippedColumns: ["id"],
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test src/workbench/clipboardState.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `clipboardState.js`.

- [ ] **Step 3: Implement the pure clipboard state module**

Create `src/workbench/clipboardState.js`:

```js
import { columnName } from "./utils/normalize.js";

export function createClipboardState() {
  return { rowPayload: null };
}

function serializeMatrix(matrix) {
  return matrix.map((row) => row.map((value) => String(value ?? "")).join("\t")).join("\n");
}

export function captureRowCopy(state, columns, rows) {
  const names = columns.map(columnName).filter(Boolean);
  const matrix = rows.map((row) => names.map((name) => String(row?.[name] ?? "")));
  const text = serializeMatrix(matrix);
  state.rowPayload = { columns: names, matrix, text };
  return text;
}

export function clearRowCopy(state) {
  state.rowPayload = null;
}

export function matchesClipboardText(state, text) {
  return Boolean(state.rowPayload && state.rowPayload.text === String(text ?? ""));
}

export function mapCopiedRowsForInsert(state, targetColumns) {
  const payload = state.rowPayload;
  if (!payload) return { drafts: [], skippedColumns: [] };
  const writable = new Map(
    targetColumns
      .filter((column) => !column.is_generated)
      .map((column) => [columnName(column), column]),
  );
  const skippedColumns = payload.columns.filter((name) => !writable.has(name));
  const drafts = payload.matrix.map((values) =>
    Object.fromEntries(payload.columns.flatMap((name, index) =>
      writable.has(name) ? [[name, String(values[index] ?? "")]] : [])),
  ).filter((draft) => Object.keys(draft).length > 0);
  return { drafts, skippedColumns };
}
```

- [ ] **Step 4: Run clipboard tests to verify GREEN**

Run: `node --test src/workbench/clipboardState.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the structured clipboard state**

```bash
git add src/workbench/clipboardState.js src/workbench/clipboardState.test.js
git commit -m "feat: add structured row clipboard state"
```

### Task 3: Replace Cell-Only History With Operation-Level Undo

**Files:**
- Modify: `src/workbench/editState.js`
- Modify: `src/workbench/editState.test.js`
- Modify: `src/workbench/utils/rowIdentity.js`
- Create: `src/workbench/rowIdentity.test.js`
- Modify: `src/workbench/composables/useUndo.js`
- Create: `src/workbench/useUndo.test.js`

- [ ] **Step 1: Write failing operation-history state tests**

Replace the undo-history expectation in `src/workbench/editState.test.js` and add an explicit operation test:

```js
import {
  createEditState,
  failCellCommit,
  finishCellCommit,
  getCellError,
  isCellPending,
  pushUndoOperation,
  popUndoOperation,
  startCellCommit,
} from "./editState.js";

test("finishCellCommit clears pending state without manufacturing a user operation", () => {
  const edit = createEditState();
  const key = startCellCommit(edit, {
    tableName: "demo\u001fgame_db\u001fitems",
    rowKey: "id=1",
    columnName: "name",
    oldValue: "Potion",
    newValue: "Mega Potion",
  });
  finishCellCommit(edit, key);
  assert.equal(isCellPending(edit, "demo\u001fgame_db\u001fitems", "id=1", "name"), false);
  assert.deepEqual(edit.undoStack, []);
});

test("operation history stores table-scoped grouped mutations", () => {
  const edit = createEditState();
  const operation = {
    scopeKey: "demo\u001fgame_db\u001fitems",
    kind: "cells",
    cells: [{ columnName: "name", oldValue: "Potion", newValue: "" }],
  };
  pushUndoOperation(edit, operation);
  assert.deepEqual(popUndoOperation(edit), operation);
});
```

- [ ] **Step 2: Write failing deterministic-identity and undo-composable tests**

Create `src/workbench/rowIdentity.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { identityKey } from "./utils/rowIdentity.js";

test("identityKey is stable when backend object key order differs", () => {
  assert.equal(identityKey({ shard: "cn", id: "8" }), identityKey({ id: "8", shard: "cn" }));
  assert.equal(identityKey({ id: "8", shard: "cn" }), "id=8&shard=cn");
});
```

Create `src/workbench/useUndo.test.js` with a reactive tab and invoke harness:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { computed, reactive } from "vue";
import { createEditState, pushUndoOperation } from "./editState.js";
import { useUndo } from "./composables/useUndo.js";

function createHarness() {
  const tab = reactive({
    tableKey: "demo\u001fgame_db\u001fplayer",
    sessionId: "session-1",
    page: 1,
    primaryKeys: ["id"],
    columns: [{ column_name: "id" }, { column_name: "name" }],
    rows: [{ id: "1", name: "" }],
  });
  const edit = reactive(createEditState());
  const calls = [];
  const fetched = [];
  const statusText = { value: "" };
  const undo = useUndo(edit, async (command, payload) => {
    calls.push({ command, payload });
    if (command === "delete_rows") return { affected: 1, deletedIdentities: payload.request.rowIdentities, failedIdentities: [] };
    if (command === "insert_row") return { affected: 1, inserted: { identity: { id: "1" }, row: payload.request.draft } };
    return {};
  }, computed(() => tab), { statusText, fetchPage: async (...args) => fetched.push(args) });
  return { tab, edit, calls, fetched, statusText, undo };
}

test("undo reverses a successful group of cleared cells", async () => {
  const { tab, edit, calls, undo } = createHarness();
  pushUndoOperation(edit, {
    scopeKey: tab.tableKey,
    kind: "cells",
    cells: [{
      beforeIdentity: { id: "1" },
      afterIdentity: { id: "1" },
      columnName: "name",
      oldValue: "Alice",
      newValue: "",
    }],
  });
  await undo.undoLatest();
  assert.equal(calls[0].command, "update_cell");
  assert.equal(calls[0].payload.request.newValue, "Alice");
});

test("undo deletes rows created by an insert operation", async () => {
  const { tab, edit, calls, undo } = createHarness();
  pushUndoOperation(edit, {
    scopeKey: tab.tableKey,
    kind: "insert",
    rows: [{ identity: { id: "9" }, row: { id: "9", name: "pasted" } }],
  });
  await undo.undoLatest();
  assert.deepEqual(calls[0].payload.request.rowIdentities, [{ id: "9" }]);
});

test("undo restores deleted row snapshots through insert_row", async () => {
  const { tab, edit, calls, undo } = createHarness();
  pushUndoOperation(edit, {
    scopeKey: tab.tableKey,
    kind: "delete",
    rows: [{ identity: { id: "1" }, row: { id: "1", name: "Alice" } }],
  });
  await undo.undoLatest();
  assert.equal(calls[0].command, "insert_row");
  assert.deepEqual(calls[0].payload.request.draft, { id: "1", name: "Alice" });
});

test("undo never consumes the most recent operation for another table", async () => {
  const { edit, calls, undo } = createHarness();
  pushUndoOperation(edit, {
    scopeKey: "demo\u001fgame_db\u001fother_table",
    kind: "insert",
    rows: [{ identity: { id: "9" }, row: { id: "9" } }],
  });
  await undo.undoLatest();
  assert.equal(calls.length, 0);
  assert.equal(edit.undoStack.length, 1);
});
```

- [ ] **Step 3: Run focused tests to verify RED**

Run: `node --test src/workbench/editState.test.js src/workbench/rowIdentity.test.js src/workbench/useUndo.test.js`

Expected: FAIL because operation helpers, stable identity serialization, and
`undoLatest` are absent and existing `finishCellCommit` still pushes cell
entries.

- [ ] **Step 4: Implement generic history helpers**

In `src/workbench/editState.js`, stop pushing a history entry in `finishCellCommit`, then replace `popUndo` with:

```js
export function pushUndoOperation(edit, operation) {
  if (!edit || !operation?.scopeKey) return false;
  const itemCount = operation.kind === "cells" ? operation.cells?.length : operation.rows?.length;
  if (!itemCount) return false;
  edit.undoStack.push(operation);
  return true;
}

export function popUndoOperation(edit, scopeKey) {
  if (!edit?.undoStack?.length) return null;
  for (let index = edit.undoStack.length - 1; index >= 0; index -= 1) {
    if (!scopeKey || edit.undoStack[index].scopeKey === scopeKey) {
      return edit.undoStack.splice(index, 1)[0];
    }
  }
  return null;
}
```

- [ ] **Step 5: Add stable identity serialization**

Append this helper to `src/workbench/utils/rowIdentity.js`; it is used when
matching Rust-returned `HashMap` identities to frontend snapshots:

```js
export function identityKey(identity = {}) {
  return Object.entries(identity)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value ?? "")}`)
    .join("&");
}
```

- [ ] **Step 6: Make `useUndo.js` the only inverse-mutation executor**

Replace `src/workbench/composables/useUndo.js` with operation handling. Use this public surface:

```js
import { popUndoOperation, pushUndoOperation } from "../editState.js";
import { identityKey } from "../utils/rowIdentity.js";

export function useUndo(editState, invokeWorkbench, activeTab, { statusText, fetchPage }) {
  async function undoLatest() {
    const tab = activeTab.value;
    if (!tab) return { succeeded: 0, failed: 0 };
    const operation = popUndoOperation(editState, tab.tableKey || tab.tableName);
    if (!operation) {
      statusText.value = "无可撤销操作";
      return { succeeded: 0, failed: 0 };
    }
    let succeeded = 0;
    let unresolved = [];
    try {
      if (operation.kind === "cells") {
        for (const cell of [...operation.cells].reverse()) {
          const result = await invokeWorkbench("update_cell", {
            request: {
              sessionId: tab.sessionId,
              rowIdentity: cell.afterIdentity,
              columnName: cell.columnName,
              oldValue: cell.newValue,
              newValue: cell.oldValue,
            },
          });
          if (result?.conflict) unresolved.push(cell);
          else succeeded += 1;
        }
      } else if (operation.kind === "insert") {
        const result = await invokeWorkbench("delete_rows", {
          request: { sessionId: tab.sessionId, rowIdentities: operation.rows.map((row) => row.identity) },
        });
        const removed = new Set((result.deletedIdentities || []).map(identityKey));
        succeeded = removed.size;
        unresolved = operation.rows.filter((row) => !removed.has(identityKey(row.identity)));
      } else if (operation.kind === "delete") {
        for (const deleted of operation.rows) {
          try {
            const draft = Object.fromEntries(Object.entries(deleted.row).filter(([name]) =>
              !tab.columns.some((column) =>
                column.column_name === name && column.is_generated && !column.is_auto_increment)));
            const result = await invokeWorkbench("insert_row", { request: { sessionId: tab.sessionId, draft } });
            if (result.affected > 0) succeeded += 1;
            else unresolved.push(deleted);
          } catch {
            unresolved.push(deleted);
          }
        }
      }
      const failed = unresolved.length;
      if (failed) {
        pushUndoOperation(editState, {
          ...operation,
          ...(operation.kind === "cells" ? { cells: unresolved } : { rows: unresolved }),
        });
      }
      await fetchPage(tab, tab.page || 1);
      statusText.value = failed ? `已撤销 ${succeeded} 项，${failed} 项失败` : `已撤销 ${succeeded} 项`;
      return { succeeded, failed };
    } catch (error) {
      pushUndoOperation(editState, operation);
      statusText.value = `撤销失败：${String(error)}`;
      return { succeeded: 0, failed: operation.kind === "cells" ? operation.cells.length : operation.rows.length };
    }
  }

  async function handleUndoKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || String(event.key).toLowerCase() !== "z" || event.shiftKey) return;
    event.preventDefault();
    await undoLatest();
  }

  return { undoLatest, handleUndoKeydown };
}
```

- [ ] **Step 7: Run focused tests and commit**

Run: `node --test src/workbench/editState.test.js src/workbench/rowIdentity.test.js src/workbench/useUndo.test.js`

Expected: PASS.

```bash
git add src/workbench/editState.js src/workbench/editState.test.js src/workbench/utils/rowIdentity.js src/workbench/rowIdentity.test.js src/workbench/composables/useUndo.js src/workbench/useUndo.test.js
git commit -m "feat: add operation-level undo history"
```

### Task 4: Implement Selection-First Insert Cells, Delete Clearing, And Paste Workflows

**Files:**
- Modify: `src/workbench/composables/useGridEditor.js`
- Modify: `src/workbench/useGridEditor.test.js`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbench.css`

- [ ] **Step 1: Update grid-editor tests for insert selection and grouped data mutations**

Modify the harness in `src/workbench/useGridEditor.test.js` to inject `clipboardState`, `pushUndoOperation`, and an `insert_row` response:

```js
const clipboardState = reactive(createClipboardState());
const history = [];
const refreshes = [];
const editor = useGridEditor(
  reactive(createEditState()),
  async (command, payload) => {
    invokeCalls.push({ command, payload });
    if (command === "insert_row") {
      const row = { id: String(50 + invokeCalls.length), ...payload.request.draft };
      if (options.insertWithoutIdentity) return { affected: 1, inserted: null };
      return { affected: 1, inserted: { identity: { id: row.id }, row } };
    }
    return { updated: true, conflict: false };
  },
  computed(() => tab),
  gridWrapRef,
  virtualGrid,
  { busy: { value: false }, statusText },
  {
    clipboardState,
    recordOperation: (operation) => history.push(operation),
    refreshRows: async (tab) => refreshes.push(tab.id),
  },
);
```

Include `history`, `clipboardState`, and `refreshes` in `createEditor()`'s
returned harness object.

Replace the old focus-first expectation and add these tests:

```js
test("ArrowDown selects the insert cell without focusing an input", async () => {
  const { editor, tab, insertInput } = createEditor();
  editor.selectCell(tab, tab.rows[2], "level", 2, 1);
  await editor.handleGridKeydown({ key: "ArrowDown", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });
  await nextTick();
  assert.equal(editor.selectedInsertCell.value.column, "level");
  assert.equal(editor.editingInsertCell.value, null);
  assert.equal(insertInput.focused, false);
});

test("Delete clears a selected range as one operation", async () => {
  const { editor, tab, history, invokeCalls } = createEditor();
  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();
  await editor.handleGridKeydown({ key: "Delete", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });
  assert.equal(invokeCalls.filter((call) => call.command === "update_cell").length, 4);
  assert.equal(history.length, 1);
  assert.equal(history[0].kind, "cells");
  assert.equal(history[0].cells.length, 4);
});

test("an internal row payload pasted from an insert selection creates multiple rows", async () => {
  const { editor, tab, clipboard, history, invokeCalls, refreshes } = createEditor();
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[1]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false });
  editor.selectInsertCell(tab, 1);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false });
  assert.equal(invokeCalls.filter((call) => call.command === "insert_row").length, 2);
  assert.equal(history.at(-1).kind, "insert");
  assert.equal(clipboard.text, "Alice\t10\tRed\nBob\t12\tBlue");
  assert.deepEqual(refreshes, ["tab-1"]);
});

test("pasting into persisted cells records one grouped undo operation", async () => {
  const clipboard = { text: "Ann\t20\nBen\t21", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, history } = createEditor({ clipboard });
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false });
  assert.equal(history.length, 1);
  assert.equal(history[0].kind, "cells");
  assert.equal(history[0].cells.length, 4);
});

test("manual insert records the returned persisted identity for undo", async () => {
  const { editor, tab, history } = createEditor();
  editor.updateInsertDraft(tab, "name", "Dana");
  assert.equal(await editor.commitInsertRow(tab), true);
  assert.equal(history[0].kind, "insert");
  assert.equal(history[0].rows[0].row.name, "Dana");
});

test("a saved insert without returned identity is reported as successful but is not added to undo", async () => {
  const { editor, tab, history, statusText } = createEditor({ insertWithoutIdentity: true });
  editor.updateInsertDraft(tab, "name", "Database accepted it");
  assert.equal(await editor.commitInsertRow(tab), true);
  assert.equal(history.length, 0);
  assert.match(statusText.value, /无法撤销/);
});
```

Update the existing row-copy test expectation from header-plus-data TSV to
data-only TSV: `"Alice\t10\tRed\nCara\t14\tGreen"`.

- [ ] **Step 2: Run grid-editor tests to verify RED**

Run: `node --test src/workbench/useGridEditor.test.js`

Expected: FAIL because the insert row still focuses its input, row copying still adds a header, and no grouped clear/insert history collaborator exists.

- [ ] **Step 3: Change editor dependencies and mutation recording**

In `src/workbench/composables/useGridEditor.js`, add clipboard imports and an optional mutation collaborator:

```js
import { captureRowCopy, clearRowCopy, mapCopiedRowsForInsert, matchesClipboardText } from "../clipboardState.js";

export function useGridEditor(
  editState,
  invokeWorkbench,
  activeTab,
  gridWrapRef,
  virtualGrid,
  { busy, statusText },
  { clipboardState, recordOperation = () => {}, refreshRows = async () => {} } = {},
) {
  const editingInsertCell = ref(null);
```

Make `commitCellValue` return a mutation without recording by itself when called as part of a grouped operation, and record a single direct edit:

```js
async function commitCellValue(tab, row, column, nextValue, { deferHistory = false } = {}) {
  const oldValue = String(row?.[column] ?? "");
  const value = String(nextValue ?? "");
  if (!tab || oldValue === value) return null;
  const beforeIdentity = buildRowIdentity(tab, row);
  const rowKey = buildRowKey(tab, row);
  const key = startCellCommit(editState, {
    tableName: tabScopeKey(tab), rowKey, columnName: column, oldValue, newValue: value,
  });
  row[column] = value;
  try {
    const result = await invokeWorkbench("update_cell", {
      request: { sessionId: tab.sessionId, rowIdentity: beforeIdentity, columnName: column, oldValue, newValue: value },
    });
    if (result?.conflict) throw new Error("数据已被别人修改，请刷新后再试");
    finishCellCommit(editState, key);
    const cell = {
      beforeIdentity,
      afterIdentity: buildRowIdentity(tab, row),
      columnName: column,
      oldValue,
      newValue: value,
    };
    if (!deferHistory) recordOperation({ scopeKey: tabScopeKey(tab), kind: "cells", cells: [cell] });
    return cell;
  } catch (error) {
    row[column] = oldValue;
    failCellCommit(editState, key, String(error));
    statusText.value = `保存失败：${String(error)}`;
    return null;
  }
}
```

Add selected-range mutation iteration and delete routing:

```js
async function clearSelectedCells(tab) {
  const bounds = getRangeBounds(selectedRange.value);
  if (!bounds) return;
  const cells = [];
  for (let rowIndex = bounds.top; rowIndex <= bounds.bottom; rowIndex += 1) {
    for (let columnIndex = bounds.left; columnIndex <= bounds.right; columnIndex += 1) {
      const row = tab.rows[rowIndex];
      const column = columnName(activeColumns.value[columnIndex]);
      const mutation = await commitCellValue(tab, row, column, "", { deferHistory: true });
      if (mutation) cells.push(mutation);
    }
  }
  recordOperation({ scopeKey: tabScopeKey(tab), kind: "cells", cells });
  statusText.value = `已清空 ${cells.length} 个单元格`;
}
```

For existing-cell TSV paste, collect the successful results from
`commitCellValue(..., { deferHistory: true })`, then record exactly one
`{ scopeKey, kind: "cells", cells }` operation after the loop. Handle
`Delete` before clipboard and navigation branches only when a persisted-cell
range is active. Leave row-header deletion in `MySqlWorkbench.vue` precedence.

- [ ] **Step 4: Implement selection-first insert editing and paste-as-new**

Replace focus-on-select with separate selection/edit behavior:

```js
function selectInsertCell(tab, columnIndex) {
  if (!tab || activeColumns.value.length === 0) return;
  const clampedColumnIndex = Math.max(0, Math.min(activeColumns.value.length - 1, columnIndex));
  const column = columnName(activeColumns.value[clampedColumnIndex]);
  if (editingCell.value) finishEditing();
  selectedCell.value = null;
  selectedRange.value = null;
  editingInsertCell.value = null;
  selectedInsertCell.value = { tabId: tab.id, columnIndex: clampedColumnIndex, column };
  scrollInsertCellIntoView(clampedColumnIndex);
  nextTick(() => gridWrapRef.value?.focus());
}

function startInsertEditing(tab, columnIndex, initialValue = null) {
  selectInsertCell(tab, columnIndex);
  editingInsertCell.value = { ...selectedInsertCell.value };
  if (initialValue != null) updateInsertDraft(tab, selectedInsertCell.value.column, initialValue);
  focusInsertInput(columnIndex);
}
```

For row copy and row paste inside `handleGridKeydown`:

```js
async function copySelectedRows(tab) {
  const selectedRows = tab.rows.filter((row) => tab.selectedRowKeys.has(buildRowKey(tab, row)));
  if (!selectedRows.length) return false;
  const text = captureRowCopy(clipboardState, activeColumns.value, selectedRows);
  await navigator.clipboard.writeText(text);
  statusText.value = `已复制 ${selectedRows.length} 行`;
  return true;
}

async function pasteRowsAsNew(tab) {
  const text = await navigator.clipboard.readText();
  if (!matchesClipboardText(clipboardState, text)) {
    statusText.value = "剪贴板已变化，无法粘贴为新记录";
    return false;
  }
  if (Object.values(getInsertDraft(tab)).some((value) => String(value).length > 0)) {
    statusText.value = "请先保存或清空当前新增草稿";
    return false;
  }
  const { drafts, skippedColumns } = mapCopiedRowsForInsert(clipboardState, activeColumns.value);
  if (!drafts.length) {
    statusText.value = "没有可粘贴的新记录字段";
    return false;
  }
  const inserted = [];
  let committed = 0;
  let notUndoable = 0;
  let failed = 0;
  for (const draft of drafts) {
    try {
      const result = await invokeWorkbench("insert_row", { request: { sessionId: tab.sessionId, draft } });
      if (result.affected > 0) {
        committed += 1;
        if (result.inserted) inserted.push(result.inserted);
        else notUndoable += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  recordOperation({ scopeKey: tabScopeKey(tab), kind: "insert", rows: inserted });
  if (committed) await refreshRows(tab);
  const ignored = skippedColumns.length ? "，已忽略自动生成字段" : "";
  const unsafe = notUndoable ? `，${notUndoable} 行无法撤销` : "";
  statusText.value = failed
    ? `已新增 ${committed} 行，${failed} 行失败${unsafe}${ignored}`
    : `已新增 ${committed} 行${unsafe}${ignored}`;
  return committed > 0;
}
```

Use `copySelectedRows(tab)` from the row-copy shortcut. On cell/range copy,
call `clearRowCopy(clipboardState)` before writing ordinary TSV so
`粘贴为新记录` cannot use an older whole-row payload.

Record manual insert using its returned persisted row:

```js
async function commitInsertRow(tab) {
  const cleaned = Object.fromEntries(
    Object.entries(getInsertDraft(tab)).filter(([, value]) => String(value ?? "").trim() !== ""),
  );
  if (!tab?.sessionId || !Object.keys(cleaned).length) return false;
  try {
    const result = await invokeWorkbench("insert_row", { request: { sessionId: tab.sessionId, draft: cleaned } });
    if (!result.affected) return false;
    clearInsertDraft(tab);
    if (result.inserted) {
      recordOperation({ scopeKey: tabScopeKey(tab), kind: "insert", rows: [result.inserted] });
      statusText.value = "已插入 1 行";
    } else {
      statusText.value = "已插入 1 行（无法安全定位，不能撤销）";
    }
    return true;
  } catch (error) {
    statusText.value = `插入失败：${String(error)}`;
    return false;
  }
}
```

When `selectedInsertCell` exists and no insert editor is active, handle its
keys before persisted-cell navigation:

```js
if (selectedInsertCell.value && !editingInsertCell.value) {
  if (isPaste) {
    event.preventDefault();
    await pasteRowsAsNew(tab);
    return;
  }
  if (event.key === "Enter" || event.key === "F2") {
    event.preventDefault();
    startInsertEditing(tab, selectedInsertCell.value.columnIndex);
    return;
  }
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    startInsertEditing(tab, selectedInsertCell.value.columnIndex, event.key);
    return;
  }
  if (["ArrowUp", "ArrowLeft", "ArrowRight", "Tab", "Escape"].includes(event.key)) {
    event.preventDefault();
    handleInsertKeydown(tab, selectedInsertCell.value.columnIndex, event);
    return;
  }
}
```

Return `editingInsertCell`, `startInsertEditing`, `copySelectedRows`, and
`pasteRowsAsNew` from the composable and remove its unused duplicate
`handleUndoKeydown`/`popUndo` import.

- [ ] **Step 5: Render selected insert cells like normal cells**

In `src/workbench/components/DataGrid.vue`, add `editingInsertCell` prop and new insert events:

```vue
const emit = defineEmits([
  "grid-ready", "scroll", "keydown", "cell-click", "cell-mousedown",
  "cell-enter", "range-pointer", "range-end", "cell-dblclick",
  "cell-blur", "edit-input", "finish-edit", "cancel-edit", "tab-edit",
  "toggle-sort", "toggle-row-select", "toggle-all-rows",
  "insert-input", "insert-commit", "insert-keydown",
  "export", "import", "filter-page", "contextmenu",
  'insert-select',
  'insert-dblclick',
]);
```

Replace the unconditional insert `<input>` with selection/edit rendering:

```vue
<td
  v-for="(column, columnIndex) in activeColumns"
  :key="`insert-${columnName(column)}`"
  :style="colStyle(tab.id, columnName(column))"
  :class="{
    'insert-selected': selectedInsertCell?.tabId === tab.id && selectedInsertCell?.columnIndex === columnIndex,
    'insert-editing': editingInsertCell?.tabId === tab.id && editingInsertCell?.columnIndex === columnIndex,
  }"
  @click="emit('insert-select', tab, columnIndex)"
  @dblclick="emit('insert-dblclick', tab, columnIndex)"
>
  <input
    v-if="editingInsertCell?.tabId === tab.id && editingInsertCell?.columnIndex === columnIndex"
    :value="getInsertDraft(tab)[columnName(column)] || ''"
    :data-insert-column-index="columnIndex"
    @input="emit('insert-input', tab, columnName(column), $event.target.value)"
    @keydown.enter.prevent.stop="emit('insert-commit', tab)"
    @keydown.tab.prevent.stop="emit('insert-keydown', tab, columnIndex, $event)"
    @keydown.escape.prevent.stop="emit('insert-keydown', tab, columnIndex, $event)"
  />
  <span v-else class="wb-cell-text">{{ getInsertDraft(tab)[columnName(column)] || "" }}</span>
</td>
```

Update `.wb-insert-row td.insert-selected` and add `.insert-editing` styling only with existing `--wb-accent`/`--wb-insert-row` tokens, matching normal selected/editing cells.

- [ ] **Step 6: Wire base editor collaborators and insert events in the shell**

In `src/workbench/MySqlWorkbench.vue`, import the new state/history APIs and
create the collaborators before `useGridEditor` is called:

```js
import { createClipboardState } from "./clipboardState.js";
import { createEditState, isCellPending, getCellError, pushUndoOperation } from "./editState.js";

const clipboardState = reactive(createClipboardState());
const recordOperation = (operation) => pushUndoOperation(editState, operation);
```

Pass them to the editor, and give undo its page refresh dependency:

```js
const editor = useGridEditor(
  editState,
  invokeWorkbench,
  activeTab,
  gridWrapRef,
  { scrollRowIntoView, scrollCellIntoView, scrollInsertCellIntoView },
  { busy: conn.busy, statusText: conn.statusText },
  {
    clipboardState,
    recordOperation,
    refreshRows: (tab) => fetchPage(tab, tab.page || 1),
  },
);

const { handleUndoKeydown } = useUndo(editState, invokeWorkbench, activeTab, {
  statusText: conn.statusText,
  fetchPage,
});
```

Destructure `editingInsertCell` and `startInsertEditing` from `editor`. Add
these bindings to the existing `DataGrid` invocation and remove
`@insert-focus="selectInsertCell"`:

```vue
:editing-insert-cell="editingInsertCell"
@insert-select="selectInsertCell"
@insert-dblclick="startInsertEditing"
@insert-input="updateInsertDraft"
@insert-commit="commitInsertAndRefresh"
@insert-keydown="handleInsertKeydown"
```

Selected insert cells now retain grid focus until an edit is deliberately
started.

- [ ] **Step 7: Run focused grid tests and commit**

Run: `node --test src/workbench/clipboardState.test.js src/workbench/editState.test.js src/workbench/useGridEditor.test.js`

Expected: PASS.

```bash
git add src/workbench/composables/useGridEditor.js src/workbench/useGridEditor.test.js src/workbench/components/DataGrid.vue src/workbench/MySqlWorkbench.vue src/workbench/workbench.css
git commit -m "feat: add selection-first grid paste and clearing"
```

### Task 5: Add Row-Header Context Actions And Undoable Row Deletion

**Files:**
- Modify: `src/workbench/components/ContextMenu.vue`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/composables/useContextMenu.js`
- Modify: `src/workbench/useContextMenu.test.js`
- Modify: `src/workbench/composables/useRowSelection.js`
- Modify: `src/workbench/useRowSelection.test.js`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Write failing row-context and delete-history tests**

Add to `src/workbench/useContextMenu.test.js`:

```js
test("opening a row menu stores its explicit row-action context", () => {
  const menu = useContextMenu(
    { statusText: { value: "" } },
    { loadTables: async () => {}, ensureTableSchema: async () => {}, fetchPage: async () => {} },
    { value: null },
  );
  menu.openRowContextMenu({ clientX: 8, clientY: 13 }, { tableName: "player" });
  assert.equal(menu.contextMenu.kind, "row");
  assert.equal(menu.contextMenu.x, 8);
  assert.equal(menu.contextMenu.tableName, "player");
});
```

Modify the row-selection harness to inject `recordOperation`, return `deletedIdentities`, and add:

```js
test("right-click selection retains selected rows or selects the clicked row", () => {
  const { tab, selection } = createHarness();
  selection.toggleRowSelect(tab, tab.rows[0], {});
  selection.toggleRowSelect(tab, tab.rows[2], { ctrlKey: true });
  selection.selectRowsForContextMenu(tab, tab.rows[2]);
  assert.equal(tab.selectedRowKeys.size, 2);
  selection.selectRowsForContextMenu(tab, tab.rows[1]);
  assert.deepEqual([...tab.selectedRowKeys], [buildRowKey(tab, tab.rows[1])]);
});

test("successful selected-row deletion records only deleted row snapshots", async () => {
  const { tab, selection, history } = createHarness({ deletedIdentities: [{ id: "1" }] });
  globalThis.window = { confirm: () => true };
  selection.toggleRowSelect(tab, tab.rows[0], {});
  selection.toggleRowSelect(tab, tab.rows[2], { ctrlKey: true });
  await selection.deleteSelectedRows(tab);
  assert.equal(history[0].kind, "delete");
  assert.deepEqual(history[0].rows, [{ identity: { id: "1" }, row: { id: "1", name: "Alice" } }]);
});
```

Extend `src/workbench/workbenchShell.test.js` assertions:

```js
assert.match(grid, /row-contextmenu/);
assert.match(orchestrator, /openRowHeaderContextMenu/);
assert.match(orchestrator, /copySelectedRows/);
assert.match(orchestrator, /pasteRowsAsNew/);
assert.match(menu, />复制</);
assert.match(menu, />删除整行</);
assert.match(menu, />粘贴为新记录</);
```

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test src/workbench/useContextMenu.test.js src/workbench/useRowSelection.test.js src/workbench/workbenchShell.test.js`

Expected: FAIL because row-menu state/actions and history wiring are not present.

- [ ] **Step 3: Add row menu context and presentation**

Extend context state in `src/workbench/composables/useContextMenu.js`:

```js
const contextMenu = reactive({
  open: false,
  kind: "general",
  x: 0,
  y: 0,
  tableName: "",
  connectionId: "",
  database: "",
});

function openContextMenu(event, table = null) {
  contextMenu.kind = table ? "table" : "general";
  contextMenu.open = true;
  contextMenu.x = event.clientX;
  contextMenu.y = event.clientY;
  contextMenu.tableName = normalizeTableName(table);
  contextMenu.connectionId = String(table?.connectionId || table?.connection_id || "");
  contextMenu.database = String(table?.database || "");
}

function openRowContextMenu(event, tab) {
  openContextMenu(event, tab);
  contextMenu.kind = "row";
}
```

Return `openRowContextMenu`. In `src/workbench/components/ContextMenu.vue`, add props and emits:

```vue
const props = defineProps({
  open: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  kind: { type: String, default: "general" },
  canPasteRows: { type: Boolean, default: false },
});
const emit = defineEmits(["refresh", "copy-rows", "delete-rows", "paste-rows"]);
```

```vue
<menu v-if="open" class="wb-context-menu" :style="contextMenuStyle" @click.stop>
  <template v-if="kind === 'row'">
    <button type="button" @click="emit('copy-rows')">复制</button>
    <button type="button" @click="emit('delete-rows')">删除整行</button>
    <button v-if="canPasteRows" type="button" @click="emit('paste-rows')">粘贴为新记录</button>
  </template>
  <button type="button" @click="emit('refresh')">刷新</button>
</menu>
```

- [ ] **Step 4: Route row-header events and record successful deletes**

In `src/workbench/components/DataGrid.vue`, add `"row-contextmenu"` to
`defineEmits` and emit the prevented row-specific event before the section
fallback can run:

```vue
@contextmenu.prevent.stop="emit('row-contextmenu', $event, tab, row)"
```

In `src/workbench/composables/useRowSelection.js`, import `identityKey` from
`../utils/rowIdentity.js`, accept `{ fetchPage, recordOperation }`, add
selection-for-context behavior, and build a snapshot map before delete:

```js
function selectRowsForContextMenu(tab, row) {
  const key = buildRowKey(tab, row);
  if (!tab.selectedRowKeys.has(key)) {
    tab.selectedRowKeys.clear();
    tab.selectedRowKeys.add(key);
    rowSelectionAnchor = key;
  }
}

async function deleteSelectedRows(tab) {
  if (!tab || tab.selectedRowKeys.size === 0) return;
  const requestedCount = tab.selectedRowKeys.size;
  if (!window.confirm(`确定删除选中的 ${requestedCount} 行？`)) return;
  try {
    const selected = tab.rows.filter((row) => tab.selectedRowKeys.has(buildRowKey(tab, row)));
    const snapshots = new Map(selected.map((row) => {
      const identity = buildRowIdentity(tab, row);
      return [identityKey(identity), { identity, row: { ...row } }];
    }));
    const result = await invokeWorkbench("delete_rows", {
      request: { sessionId: tab.sessionId, rowIdentities: selected.map((row) => buildRowIdentity(tab, row)) },
    });
    const deleted = (result.deletedIdentities || [])
      .map((identity) => snapshots.get(identityKey(identity)))
      .filter(Boolean);
    recordOperation({ scopeKey: tab.tableKey || tab.tableName, kind: "delete", rows: deleted });
    tab.selectedRowKeys = new Set();
    await fetchPage(tab, 1);
    const failures = result.failedIdentities?.length || 0;
    statusText.value = failures
      ? `已删除 ${deleted.length} 行，${failures} 行失败`
      : `已删除 ${deleted.length} 行`;
  } catch (error) {
    statusText.value = `删除失败：${String(error)}`;
  }
}
```

- [ ] **Step 5: Wire row actions through the shell**

In `src/workbench/MySqlWorkbench.vue`, reuse the `clipboardState`,
`recordOperation`, and editor row-paste functions wired in Task 4. Pass the
same recorder into row selection and add:

Add `copySelectedRows` and `pasteRowsAsNew` to the existing `editor`
destructuring, then replace the row-selection instantiation and add handlers:

```js
const { clearRowSelection, toggleRowSelect, toggleAllRows, selectRowsForContextMenu, deleteSelectedRows, deleteRow } =
  useRowSelection(invokeWorkbench, { statusText: conn.statusText }, { fetchPage, recordOperation });

function openRowHeaderContextMenu(event, tab, row) {
  clearSelection();
  selectRowsForContextMenu(tab, row);
  openRowContextMenu(event, tab);
}

async function copyRowsFromContextMenu() {
  closeContextMenu();
  await copySelectedRows(activeTab.value);
}

async function pasteRowsFromContextMenu() {
  closeContextMenu();
  await pasteRowsAsNew(activeTab.value);
}

async function deleteRowsFromContextMenu() {
  closeContextMenu();
  await deleteSelectedRows(activeTab.value);
}
```

Add these bindings to the existing component invocations:

```vue
@row-contextmenu="openRowHeaderContextMenu"

:kind="contextMenu.kind"
:can-paste-rows="Boolean(clipboardState.rowPayload)"
@copy-rows="copyRowsFromContextMenu"
@delete-rows="deleteRowsFromContextMenu"
@paste-rows="pasteRowsFromContextMenu"
```

- [ ] **Step 6: Run focused tests and commit**

Run: `node --test src/workbench/useContextMenu.test.js src/workbench/useRowSelection.test.js src/workbench/workbenchShell.test.js src/workbench/useGridEditor.test.js src/workbench/useUndo.test.js`

Expected: PASS.

```bash
git add src/workbench/components/ContextMenu.vue src/workbench/components/DataGrid.vue src/workbench/composables/useContextMenu.js src/workbench/useContextMenu.test.js src/workbench/composables/useRowSelection.js src/workbench/useRowSelection.test.js src/workbench/MySqlWorkbench.vue src/workbench/workbenchShell.test.js
git commit -m "feat: add undoable row context actions"
```

### Task 6: Close Integration Gaps And Verify The Workbench

**Files:**
- Modify if assertions require it: `src/workbench/useGridEditor.test.js`
- Modify if assertions require it: `src/workbench/useUndo.test.js`
- Modify if assertions require it: `src/workbench/workbenchShell.test.js`
- Verify: all frontend and Rust source touched above

- [ ] **Step 1: Add regression cases for partial success and safety guards**

Before broad verification, add these focused assertions where they fit the harnesses:

```js
test("paste-as-new refuses a stale system clipboard or an unsaved insert draft", async () => {
  const { editor, tab, clipboard, invokeCalls, statusText } = createEditor();
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false });
  clipboard.text = "changed outside the app";
  editor.selectInsertCell(tab, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false });
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
  assert.match(statusText.value, /剪贴板已变化/);

  editor.updateInsertDraft(tab, "name", "draft");
  assert.equal(await editor.pasteRowsAsNew(tab), false);
  assert.match(statusText.value, /保存或清空当前新增草稿/);
});

test("a conflicted inverse update is retained for another undo attempt", async () => {
  const tab = reactive({
    tableKey: "demo\u001fgame_db\u001fplayer",
    sessionId: "session-1",
    page: 1,
    columns: [{ column_name: "id" }, { column_name: "name" }],
  });
  const edit = reactive(createEditState());
  const statusText = { value: "" };
  pushUndoOperation(edit, {
    scopeKey: tab.tableKey,
    kind: "cells",
    cells: [{ beforeIdentity: { id: "1" }, afterIdentity: { id: "1" }, columnName: "name", oldValue: "Alice", newValue: "" }],
  });
  const undo = useUndo(
    edit,
    async () => ({ updated: false, conflict: true }),
    computed(() => tab),
    { statusText, fetchPage: async () => {} },
  );
  const result = await undo.undoLatest();
  assert.equal(result.failed, 1);
  assert.equal(edit.undoStack.length, 1);
  assert.match(statusText.value, /1 项失败/);
});
```

- [ ] **Step 2: Run all frontend unit tests**

Run: `node --test src/workbench/*.test.js`

Expected: PASS with zero failed tests.

- [ ] **Step 3: Run frontend and backend build verification**

Run:

```bash
npm run build
cd src-tauri && cargo check && cargo test
```

Expected: Vite builds `dist/` successfully; `cargo check` and `cargo test` finish without failures. The existing Vite large-chunk warning may remain informational.

- [ ] **Step 4: Perform browser-mode interaction verification**

Run: `npm run dev -- --host 127.0.0.1`

Using the in-app Browser at `http://127.0.0.1:1431/`, verify:

```text
1. Open a table; click a bottom insert cell. It displays selection styling and does not focus an editor.
2. Double-click or type in that insert cell. It enters editing and a manual inserted row can be saved.
3. Select two row headers and press Cmd/Ctrl+C; select an insert cell and press Cmd/Ctrl+V. Two records are added and generated id fields are newly assigned.
4. Select one cell and a dragged rectangular range; Delete clears values to blank without entering an editor.
5. Right-click a row header: 复制, 删除整行, 刷新 appear, and 粘贴为新记录 appears only after copying rows in DB Scout.
6. Right-click a normal cell or general workbench chrome: only 刷新 appears.
7. Use Cmd/Ctrl+Z after cell clear, paste-as-new, and row delete; each operation restores the previous data state or displays a conflict message without overwriting newer data.
```

Stop the dev-server process after verification.

- [ ] **Step 5: Commit any final regression tests or integration fixes**

If Step 1 required new tests or the verification steps required integration fixes:

```bash
git add src/workbench src-tauri/src
git commit -m "test: cover grid mutation undo safeguards"
```

If no files changed, do not create an empty commit.
