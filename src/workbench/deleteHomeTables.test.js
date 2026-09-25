import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./MySqlWorkbench.vue", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("async function deleteHomeTables("), source.indexOf("async function refreshHome("));

function harness({ result, refreshError = false, busy = false, invoke, tableNames = ["a", "b"] } = {}) {
  const closed = [];
  const home = { selectedTableNames: ["a", "b"] };
  const state = {
    busy: { value: busy }, statusText: { value: "" }, workspace: {},
    recentHomeTableNames: { value: ["a", "b", "c"] },
    isReadOnlyConnection: () => false, connectionCapability: () => true,
    confirmDialogConfirm: async () => true,
    invokeWorkbench: invoke || (async () => result),
    closeTableObjectTabs: (_, { tableNames }) => { closed.push(...tableNames); return []; },
    clearTabCellErrors() {},
    loadTables: async () => { if (refreshError) throw new Error("offline"); },
    openCurrentDatabaseHome: () => home,
  };
  const run = runInNewContext(`${handler}; deleteHomeTables`, state);
  return { state, home, closed, run: () => run({ connectionId: "c", database: "db", tableNames }) };
}

test("large table deletions report bounded progress and retain prior results after a later request fails", async () => {
  const tableNames = Array.from({ length: 70 }, (_, index) => `table_${index}`);
  const batches = [];
  let h;
  h = harness({ tableNames, invoke: async (_, { request }) => {
    batches.push([...request.tables]);
    assert.ok(request.tables.length <= 32);
    if (batches.length === 2) {
      assert.match(h.state.statusText.value, /32\/70/);
      throw new Error("offline");
    }
    return { dropped: request.tables.map((tableName) => ({ tableName })), failed: [] };
  } });
  await h.run();
  assert.equal(batches.length, 2);
  assert.deepEqual(h.closed, tableNames.slice(0, 32));
  assert.equal(h.home.selectedTableNames.length, 38);
  assert.match(h.state.statusText.value, /已删除 32/);
  assert.match(h.state.statusText.value, /offline/);
});

test("table deletion only closes successful tables and preserves failed selections", async () => {
  const h = harness({ result: { dropped: [{ tableName: "a" }], failed: [{ tableName: "b", reason: "denied" }] } });
  await h.run();
  assert.deepEqual(h.closed, ["a"]);
  assert.equal(JSON.stringify(h.home.selectedTableNames), '["b"]');
  assert.match(h.state.statusText.value, /1.*失败.*1|1.*未删除/);
  assert.match(h.state.statusText.value, /denied/);
  assert.deepEqual(h.state.recentHomeTableNames.value, ["b", "c"]);
});

test("large table deletions cover each table once and refresh only once", async () => {
  const tableNames = Array.from({ length: 70 }, (_, index) => `table_${index}`);
  const requests = [];
  const h = harness({ tableNames, invoke: async (_, { request }) => {
    requests.push(...request.tables);
    return { dropped: request.tables.map((tableName) => ({ tableName })), failed: [] };
  } });
  let refreshes = 0;
  h.state.loadTables = async () => { refreshes += 1; };
  await h.run();
  assert.deepEqual(requests, tableNames);
  assert.deepEqual(h.closed, tableNames);
  assert.equal(refreshes, 1);
  assert.equal(h.home.selectedTableNames.length, 0);
  assert.match(h.state.statusText.value, /已删除 70 张表/);
});

test("all failed tables remain open and are not reported as deleted", async () => {
  const h = harness({ result: { dropped: [], failed: [{ tableName: "a", reason: "locked" }, { tableName: "b", reason: "denied" }] } });
  await h.run();
  assert.deepEqual(h.closed, []);
  assert.doesNotMatch(h.state.statusText.value, /已删除 2/);
  assert.equal(h.home.selectedTableNames.length, 2);
});

test("successful deletion is preserved when refreshing the list fails", async () => {
  const h = harness({ result: { dropped: [{ tableName: "a" }, { tableName: "b" }], failed: [] }, refreshError: true });
  await h.run();
  assert.match(h.state.statusText.value, /已删除 2.*刷新.*失败/);
  assert.deepEqual(h.closed, ["a", "b"]);
  assert.deepEqual(h.state.recentHomeTableNames.value, ["c"]);
  assert.equal(h.state.busy.value, false);
});

test("missing table results are not treated as success", async () => {
  const h = harness({ result: { dropped: [{ tableName: "a" }], failed: [] } });
  await h.run();
  assert.deepEqual(h.closed, ["a"]);
  assert.match(h.state.statusText.value, /未确认/);
});
