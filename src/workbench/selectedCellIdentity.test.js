import test from "node:test";
import assert from "node:assert/strict";
import { buildRowKey } from "./utils/rowIdentity.js";
import { buildSelectedCellIdentity } from "./utils/selectedCellIdentity.js";

function makeTab(overrides = {}) {
  return {
    id: "tab-1",
    primaryKeys: ["id"],
    columns: [{ column_name: "id" }, { column_name: "name" }],
    rows: [{ id: "10021", name: "Alice" }],
    ...overrides,
  };
}

function focus(tab, row = tab.rows[0], column = "name") {
  return { tabId: tab.id, rowKey: buildRowKey(tab, row), column };
}

test("builds a single-primary-key identity for the focused cell", () => {
  const tab = makeTab();
  const identity = buildSelectedCellIdentity(tab, focus(tab), null);

  assert.deepEqual(identity, {
    column: "name",
    keyLabel: "主键",
    primaryKeyText: "id=10021",
    selectedCount: 0,
    title: "当前单元格 name | 主键 id=10021",
  });
});

test("labels composite keys and preserves key order", () => {
  const tab = makeTab({
    primaryKeys: ["server_id", "role_id"],
    columns: [{ column_name: "server_id" }, { column_name: "role_id" }, { column_name: "quantity" }],
    rows: [{ server_id: 3, role_id: "10021", quantity: 9 }],
  });

  const identity = buildSelectedCellIdentity(tab, focus(tab, tab.rows[0], "quantity"), null);

  assert.equal(identity.keyLabel, "多主键");
  assert.equal(identity.primaryKeyText, "server_id=3 + role_id=10021");
});

test("does not expose fallback row identity for a table without a primary key", () => {
  const tab = makeTab({ primaryKeys: [] });
  const identity = buildSelectedCellIdentity(tab, focus(tab), null);

  assert.equal(identity.keyLabel, "无主键");
  assert.equal(identity.primaryKeyText, "");
  assert.equal(identity.title, "当前单元格 name | 无主键");
  assert.doesNotMatch(identity.title, /10021|Alice/);
});

test("shows the focus row identity and cell count for a range", () => {
  const tab = makeTab({ rows: [{ id: "10021", name: "Alice" }, { id: "10022", name: "Bob" }] });
  const range = {
    tabId: tab.id,
    anchor: { rowIndex: 0, columnIndex: 0 },
    focus: { rowIndex: 1, columnIndex: 1 },
  };

  const identity = buildSelectedCellIdentity(tab, focus(tab, tab.rows[1]), range);

  assert.equal(identity.primaryKeyText, "id=10022");
  assert.equal(identity.selectedCount, 4);
  assert.equal(identity.title, "当前单元格 name | 主键 id=10022 | 已选 4 个单元格");
});

test("formats anomalous key values without ambiguity", () => {
  const tab = makeTab({
    primaryKeys: ["left_id", "right_id"],
    rows: [{ left_id: null, right_id: "", name: "orphan" }],
  });

  assert.equal(
    buildSelectedCellIdentity(tab, focus(tab), null).primaryKeyText,
    'left_id=NULL + right_id=""',
  );
});

test("hides identity when the focused row is absent or belongs to another tab", () => {
  const tab = makeTab();

  assert.equal(buildSelectedCellIdentity(tab, null, null), null);
  assert.equal(buildSelectedCellIdentity(tab, { tabId: tab.id, rowKey: "id=missing", column: "name" }, null), null);
  assert.equal(buildSelectedCellIdentity(tab, { tabId: "other", rowKey: "id=10021", column: "name" }, null), null);
});
