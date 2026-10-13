import test from "node:test";
import assert from "node:assert/strict";
import { createIncomingRelationRows, fetchIncomingRelationRows, incomingRelationFilter } from "./incomingRelationRows.js";
import { mockWorkbenchInvoke } from "./mock/mockBackend.js";
import { rowCache } from "./mock/mockRows.js";

const context = {
  scope: { connectionId: "demo", database: "game_db" },
  tableName: "activity",
  relation: { sourceColumn: "reward_pool", kind: "list" },
  value: "1001",
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("details use the original list relation filter, preserve composite keys, and close their session", async () => {
  const calls = [];
  const page = await fetchIncomingRelationRows(context, 50, async (command, payload) => {
    calls.push({ command, payload });
    return command === "open_table_session" ? {
      sessionId: "detail-session", primaryKeys: ["ID", "ZoneIDStart", "ZoneIDEnd"],
      rows: [{ ID: "7", ZoneIDStart: "1", ZoneIDEnd: "20" }], hasMore: true,
    } : null;
  });
  assert.deepEqual(calls[0].payload.options, {
    page: 1, pageSize: 50, offset: 50, includeTotal: false,
    filter: { query: "", relation: { column: "reward_pool", kind: "listContains", values: ["1001"] } },
  });
  assert.equal(page.rows[0].label, "ID=7 + ZoneIDStart=1 + ZoneIDEnd=20");
  assert.deepEqual(page.rows[0].identity, { ID: "7", ZoneIDStart: "1", ZoneIDEnd: "20" });
  assert.equal(page.rows[0].ordinal, 51);
  assert.deepEqual(calls[1], { command: "close_table_session", payload: { sessionId: "detail-session" } });
  assert.deepEqual(incomingRelationFilter({ sourceColumn: "JumpID", kind: "value" }, 9), {
    column: "JumpID", kind: "equals", values: ["9"],
  });
});

test("referencing rows read by name as well as by key", async () => {
  const page = await fetchIncomingRelationRows(context, 0, async (command) => (command === "open_table_session" ? {
    sessionId: "named",
    primaryKeys: ["id"],
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true },
      { column_name: "name", column_type: "varchar(64)" },
    ],
    rows: [{ id: "3", name: "  Seven-day  login " }, { id: "4", name: null }],
    hasMore: false,
  } : null));
  assert.deepEqual(page.rows.map((row) => [row.label, row.name]), [["id=3", "Seven-day login"], ["id=4", ""]]);
});

test("no-key records are explicitly non-navigable and empty pages cannot keep loading", async () => {
  const invoke = async (command) => command === "open_table_session"
    ? { sessionId: "s", columns: [{ column_name: "name" }], rows: [{ name: "hello" }], hasMore: false }
    : null;
  const page = await fetchIncomingRelationRows(context, 0, invoke);
  assert.equal(page.rows[0].identity, null);
  assert.equal(page.rows[0].label, "");
  const empty = await fetchIncomingRelationRows(context, 0, async () => ({ rows: [], hasMore: true }));
  assert.equal(empty.hasMore, false);
});

test("expansion is lazy, keeps warm results, paginates, and retries errors without losing rows", async () => {
  const offsets = [];
  let fail = false;
  const { state, toggle, loadMore } = createIncomingRelationRows(async (offset) => {
    offsets.push(offset);
    if (fail) throw new Error("offline");
    return { rows: [{ key: String(offset) }], hasMore: offset === 0 };
  });
  assert.deepEqual(offsets, []);
  toggle();
  await tick();
  assert.equal(state.expanded, true);
  toggle(); toggle();
  await tick();
  assert.deepEqual(offsets, [0]);
  fail = true;
  await loadMore();
  assert.equal(state.error, "offline");
  assert.equal(state.rows.length, 1);
  fail = false;
  await loadMore();
  assert.deepEqual(offsets, [0, 1, 1]);
  assert.equal(state.rows.length, 2);
  assert.equal(state.error, "");
  await loadMore();
  assert.deepEqual(offsets, [0, 1, 1]);
});

test("changing row invalidates in-flight results and allows the new row to load immediately", async () => {
  const resolve = [];
  const { state, toggle, reset, loadMore } = createIncomingRelationRows(() => new Promise((done) => resolve.push(done)));
  toggle();
  await loadMore();
  assert.equal(resolve.length, 1, "duplicate requests coalesce");
  reset(); toggle();
  resolve[1]({ rows: [{ key: "new" }], hasMore: false });
  await tick();
  resolve[0]({ rows: [{ key: "stale" }], hasMore: true });
  await tick();
  assert.deepEqual(state.rows, [{ key: "new" }]);
  assert.equal(state.hasMore, false);
  assert.equal(state.loading, false);
});

test("actual mock page queries return only rows referencing the selected key", async () => {
  const page = await fetchIncomingRelationRows({
    ...context, tableName: "hero", relation: { sourceColumn: "skill_id", kind: "value" }, value: "1",
  }, 0, mockWorkbenchInvoke);
  const raw = await mockWorkbenchInvoke("open_table_session", {
    ...context.scope, tableName: "hero", options: { pageSize: 10000 },
  });
  try {
    const expected = raw.rows.filter((row) => String(row.skill_id) === "1");
    assert.ok(expected.length > 0, "fixture must exercise a real reference");
    assert.deepEqual(page.rows.map((row) => row.identity.id), expected.map((row) => row.id));
  } finally {
    await mockWorkbenchInvoke("close_table_session", { sessionId: raw.sessionId });
  }
});

test("real paging returns all matching primary keys without truncation or repeated pages", async () => {
  const cacheKey = "demo/game_db/hero";
  const previous = rowCache.get(cacheKey);
  const rows = Array.from({ length: 125 }, (_, index) => ({ id: String(index + 1), skill_id: "7" }));
  rowCache.set(cacheKey, [...rows, { id: "999", skill_id: "8" }]);
  try {
    const request = { ...context, tableName: "hero", relation: { sourceColumn: "skill_id", kind: "value" }, value: "7" };
    const { state, loadMore } = createIncomingRelationRows((offset) => fetchIncomingRelationRows(request, offset, mockWorkbenchInvoke));
    await loadMore();
    assert.equal(state.rows.length, 50);
    assert.equal(state.hasMore, true);
    while (state.hasMore) await loadMore();
    assert.deepEqual(state.rows.map((row) => row.identity.id), rows.map((row) => row.id));
  } finally {
    if (previous) rowCache.set(cacheKey, previous);
    else rowCache.delete(cacheKey);
  }
});
