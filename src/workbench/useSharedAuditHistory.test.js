import test from "node:test";
import assert from "node:assert/strict";
import { shallowRef } from "vue";
import { useSharedAuditHistory } from "./composables/useSharedAuditHistory.js";

const row = (id, overrides = {}) => ({ clientId: `client-${id}`, connectionId: "demo", database: "game_db", tableName: "player",
  ts: "2026-01-01T12:00:00Z", operation: "UPDATE", source: "grid", status: "committed", username: "tester",
  columnName: "level", oldValue: "1", newValue: "2", ...overrides });
function fixture(rows) {
  const calls = [];
  const history = useSharedAuditHistory({ invokeWorkbench: async (command, { request }) => {
    calls.push({ command, request });
    assert.equal(command, "list_shared_audit_logs");
    return rows.filter((entry) => ["connectionId", "database", "tableName"].every((key) => !request[key] || request[key] === entry[key]))
      .slice(request.offset, request.offset + request.limit);
  } });
  return { history, calls };
}

test("shared history uses the table/timeline model, retains actors and has no write methods", async () => {
  const { history, calls } = fixture([row(1), row(2, { username: "other" }), row(3, { connectionId: "other" })]);
  await history.loadTables({});
  assert.equal(history.state.tables.length, 2);
  await history.selectTable(history.state.tables[0]);
  assert.equal(history.state.operations.length, 2);
  assert.equal(history.state.operations[1].username, "other");
  assert.ok(history.state.operations.every((operation) => operation.entryCount === 1));
  history.loadDetails(history.state.operations[0]);
  assert.equal(Object.values(history.state.details)[0].items[0].newValue, "2");
  history.loadDetails(history.state.operations[0]);
  assert.equal(history.state.expanded, null);
  assert.equal(history.readOnly, true);
  assert.equal(history.prepareRestore, undefined);
  assert.equal(history.restore, undefined);
  assert.equal(calls.length, 2);
});

test("paging uses raw row offsets, including pages with no matching tables, and never prefetches", async () => {
  const { history, calls } = fixture([...Array.from({ length: 1000 }, (_, i) => row(i)), row(1001, { tableName: "older" })]);
  await history.loadTables({});
  assert.equal(calls.length, 1);
  assert.equal(history.state.tables.length, 1);
  assert.equal(history.state.tablesMore, true);
  history.state.search = "older";
  await history.loadTables();
  assert.equal(history.state.tables.length, 0);
  assert.equal(calls.length, 1);
  for (let i = 0; i < 5; i++) await history.loadTables(undefined, true);
  assert.deepEqual(calls.map(({ request }) => request.offset), [0, 200, 400, 600, 800, 1000]);
  assert.equal(history.state.tables[0].tableName, "older");
  assert.equal(history.state.tablesMore, false);
});

test("selected table loads its own pages with full scope and deduplicates shared identities", async () => {
  const rows = Array.from({ length: 201 }, (_, i) => row(i));
  const { history, calls } = fixture([...rows, rows[200], row(202, { tableName: "other" })]);
  await history.selectTable(row(0));
  assert.equal(history.state.operations.length, 200);
  assert.equal(history.state.operationsMore, true);
  await history.loadOperations(true);
  assert.equal(history.state.operations.length, 201);
  assert.equal(history.state.operationsMore, false);
  assert.deepEqual(calls[1].request, { connectionId: "demo", database: "game_db", tableName: "player", limit: 200, offset: 200 });
});

test("late table and timeline responses cannot repopulate closed or switched views", async () => {
  const pending = [];
  const history = useSharedAuditHistory({ invokeWorkbench: () => new Promise((resolve) => pending.push(resolve)) });
  const first = history.selectTable(row(1));
  const second = history.selectTable(row(2, { tableName: "other" }));
  pending[1]([row(2, { tableName: "other" })]); await second;
  pending[0]([row(1)]); await first;
  assert.equal(history.state.operations[0].tableName, "other");
  const load = history.loadTables({});
  history.dispose(); pending[2]([row(3)]); await load;
  assert.deepEqual(history.state.tables, []);
  assert.deepEqual(history.state.operations, []);
  assert.equal(history.state.loadingTables, false);
});

test("errors remain visible and table refresh clears old scope", async () => {
  let fail = false;
  const history = useSharedAuditHistory({ invokeWorkbench: async () => { if (fail) throw new Error("offline"); return [row(1)]; } });
  await history.loadTables({});
  await history.selectTable(row(1));
  fail = true;
  assert.equal(await history.loadTables({ database: "other" }), false);
  assert.equal(history.state.error, "offline");
  assert.deepEqual(history.state.tables, []);
  assert.equal(history.state.selected, null);
});

test("local enrichment requires both client identity and table scope; shared status wins", async () => {
  const entry = row(1, { notes: null });
  const localLogs = shallowRef([row(1, { notes: "local note", rowIdentity: { id: "1" }, status: "rolled_back" })]);
  const history = useSharedAuditHistory({ localLogs, invokeWorkbench: async () => [entry] });
  await history.selectTable(entry);
  const op = history.state.operations[0]; history.loadDetails(op);
  assert.equal(history.state.details[op.id].items[0].notes, "local note");
  assert.equal(history.state.details[op.id].items[0].status, "committed");
  history.loadDetails(op);
  localLogs.value = [row(1, { database: "wrong", notes: "wrong note" })];
  history.loadDetails(op);
  assert.equal(history.state.details[op.id].items[0].notes, null);
});
