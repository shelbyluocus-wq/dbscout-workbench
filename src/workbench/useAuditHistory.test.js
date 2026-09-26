import test from "node:test";
import assert from "node:assert/strict";
import { useAuditHistory } from "./composables/useAuditHistory.js";
import { createMockAuditHistory, recordMockTableDiff } from "./mock/mockAuditHistory.js";

const table = { columns: [{ column_name: "id", is_primary_key: true }, { column_name: "value" }] };
const target = { connectionId: "one", database: "db", tableName: "items" };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; };
function fixture() {
  const logs = [], rows = Array.from({ length: 1001 }, (_, i) => ({ id: String(i), value: "before" }));
  const other = [{ id: "0", value: "untouched" }];
  const api = createMockAuditHistory({ logs, getRows: (r) => r.tableName === "other" ? other : rows, getTable: () => table });
  const importRows = rows.map((row) => ({ ...row, value: "imported" }));
  recordMockTableDiff(logs, target, table, rows, importRows, "import");
  rows.splice(0, rows.length, ...importRows);
  return { logs, rows, other, api };
}
test("1001 changes group as one import; paged details, reverse later edits and repeat restoration", async () => {
  const { api, logs, rows, other } = fixture();
  let operations = await api("list_audit_operations", target);
  assert.equal(operations.items.length, 1); assert.equal(operations.items[0].entryCount, 1001);
  const importId = operations.items[0].id;
  const detail = await api("list_audit_operation_details", { ...target, auditId: importId });
  assert.equal(detail.items.length, 50); assert.equal(detail.hasMore, true);
  assert.equal((await api("list_audit_operation_details", { ...target, auditId: importId, offset: 1000 })).items.length, 1);
  const before = structuredClone(rows); rows[0].value = "afternoon";
  recordMockTableDiff(logs, target, table, before, rows);
  const preview = await api("preview_audit_table_restore", { ...target, auditId: importId });
  assert.equal(preview.operations, 2); assert.equal(preview.entries, 1002);
  await api("restore_audit_table", { ...target, auditId: importId, token: preview.token });
  assert.ok(rows.every((row) => row.value === "before")); assert.equal(other[0].value, "untouched");
  operations = await api("list_audit_operations", target);
  assert.equal(operations.items[0].source, "rollback");
  const undoRestore = await api("preview_audit_table_restore", { ...target, auditId: operations.items[0].id });
  await api("restore_audit_table", { ...target, auditId: operations.items[0].id, token: undoRestore.token });
  assert.equal(rows[0].value, "afternoon"); assert.equal(rows[1].value, "imported");
});
test("stale preview and incomplete batches never mutate data", async () => {
  const { api, logs, rows } = fixture(); const auditId = Math.min(...logs.map((r) => r.id));
  const preview = await api("preview_audit_table_restore", { ...target, auditId });
  rows.push({ id: "external", value: "external" });
  const before = structuredClone(rows);
  await assert.rejects(api("restore_audit_table", { ...target, auditId, token: preview.token }), /重新预览/);
  assert.deepEqual(rows, before);
  logs.splice(1, 1);
  await assert.rejects(api("preview_audit_table_restore", { ...target, auditId }), /缺失/);
  assert.deepEqual(rows, before);
});
test("conflict after inverse steps leaves original rows unchanged", async () => {
  const { api, logs, rows } = fixture(); rows[0].value = "external";
  const before = structuredClone(rows);
  await assert.rejects(api("preview_audit_table_restore", { ...target, auditId: Math.min(...logs.map((r) => r.id)) }), /不一致/);
  assert.deepEqual(rows, before);
});
test("same-name tables remain separate; same-timestamp operations do not merge", async () => {
  const { api, logs, rows } = fixture();
  recordMockTableDiff(logs, { ...target, connectionId: "two" }, table, [{ id: "0", value: "old" }], [{ id: "0", value: "new" }]);
  recordMockTableDiff(logs, target, table, rows, rows.map((r) => ({ ...r, value: "latest" })));
  for (const row of logs) row.ts = "2026-01-01T00:00:00.000Z";
  assert.equal((await api("list_audit_tables", {})).items.length, 2);
  assert.equal((await api("list_audit_operations", target)).items.length, 2);
});
test("insert/delete/null/empty and changed primary keys restore together", async () => {
  const logs = [], before = [{ id: "1", value: null }, { id: "2", value: "" }];
  const rows = [{ id: "3", value: "changed-key" }, { id: "4", value: "inserted" }];
  recordMockTableDiff(logs, target, table, before, rows, "import");
  const api = createMockAuditHistory({ logs, getRows: () => rows, getTable: () => table });
  const request = { ...target, auditId: Math.min(...logs.map((r) => r.id)) };
  const preview = await api("preview_audit_table_restore", request);
  await api("restore_audit_table", { ...request, token: preview.token });
  assert.deepEqual(rows.sort((a, b) => a.id.localeCompare(b.id)), before);
});
test("slow selection, details and preview cannot overwrite a later table", async () => {
  const requests = [];
  const history = useAuditHistory({ invokeWorkbench: (command) => { const d = deferred(); requests.push({ ...d, command }); return d.promise; } });
  const first = history.selectTable(target);
  const second = history.selectTable({ ...target, tableName: "other" });
  requests[1].resolve({ items: [{ id: 2 }], hasMore: false }); await second;
  requests[0].resolve({ items: [{ id: 1 }], hasMore: true }); await first;
  assert.equal(history.state.operations[0].id, 2);
  const detail = history.loadDetails({ id: 2 });
  const preview = history.prepareRestore({ id: 2 });
  const third = history.selectTable(target);
  requests[4].resolve({ items: [], hasMore: false }); await third;
  requests[2].resolve({ items: [{ id: 99 }], hasMore: false }); await detail;
  requests[3].resolve({ token: "stale" }); await preview;
  assert.deepEqual(history.state.details, {}); assert.equal(history.state.preview, null);
  assert.equal(history.state.loadingDetails, false);
});
test("close invalidates pending table loads", async () => {
  const d = deferred(); const h = useAuditHistory({ invokeWorkbench: () => d.promise });
  const load = h.loadTables(); h.dispose(); d.resolve({ items: [target], hasMore: false }); await load;
  assert.equal(h.state.tables.length, 0); assert.equal(h.state.loadingTables, false);
});
