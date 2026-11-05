import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeControlAction, useExternalMcp } from "./useExternalMcp.js";

test("external MCP starts without assistant commands and deduplicates queued events", async () => {
  const calls = [];
  const action = { requestId: "queued", action: "open_table", table: "goodsprop", filter: "ID = 1", sort: { column: "ID", direction: "desc" } };
  let listener;
  let stopped = false;
  const control = useExternalMcp(async (command, args) => {
    calls.push([command, args]);
    return command === "control_frontend_ready" ? [action] : null;
  }, async (name, callback) => {
    assert.equal(name, "control-workbench-action");
    listener = callback;
    callback({ payload: action });
    return () => { stopped = true; };
  });
  await Promise.all([control.ensureControlListener(), control.ensureControlListener()]);
  assert.equal(calls.filter(([command]) => command === "control_frontend_ready").length, 1);
  assert.equal(control.pendingWorkbenchActions.value.length, 1);
  const queued = control.pendingWorkbenchActions.value[0];
  assert.equal(queued.tableName, "goodsprop");
  assert.equal(queued.filter, "ID = 1");
  await control.completeControlWorkbenchAction(queued, { context: { tableName: "goodsprop" } });
  control.markWorkbenchActionHandled(queued.requestId);
  assert.equal(control.pendingWorkbenchActions.value.length, 0);
  await control.updateControlContext({ activeView: "home" });
  await control.disposeControlListener();
  listener({ payload: { ...action, requestId: "late" } });
  assert.equal(control.pendingWorkbenchActions.value.length, 0);
  assert.ok(stopped);
  assert.ok(calls.every(([command]) => command.startsWith("control_")));
});

test("external MCP preserves exact composite keys and validates navigation actions", () => {
  const action = normalizeControlAction({ action: "focus_cell", table: "prop", column: "Name", row_identity: { ID: 10, Type: 2 } });
  assert.deepEqual(action.rowIdentity, { ID: "10", Type: "2" });
  assert.equal(action.columnName, "Name");
  for (const payload of [
    { action: "delete_table", table: "prop" },
    { action: "open_table" },
    { action: "focus_row", table: "prop" },
    { action: "focus_cell", table: "prop", rowKey: "1" },
    { action: "select_range", table: "prop", startColumn: "ID", startRowIdentity: {} },
    { action: "select_database" },
    { action: "open_sql", sql: " " },
  ]) assert.equal(normalizeControlAction(payload), null);
  assert.equal(normalizeControlAction({ action: "get_view_state" }).action, "get_view_state");
  assert.equal(normalizeControlAction({ action: "open_sql", sql: "select 1", run: true }).run, true);
  assert.equal(normalizeControlAction({ action: "scroll_table", table: "prop", direction: "down" }).screens, 1);
});

test("MCP permission failures restore the previous switches without invoking AI", async () => {
  const control = useExternalMcp(async (command) => {
    if (command === "get_external_mcp_status") return { enabled: true, permissions: { navigate: true } };
    throw new Error("denied");
  });
  await control.loadExternalMcpStatus();
  const pending = control.setExternalMcpPermission("navigate", false);
  assert.equal(control.externalMcpStatus.value.permissions.navigate, false);
  await pending;
  assert.equal(control.externalMcpStatus.value.permissions.navigate, true);
  assert.equal(control.externalMcpStatus.value.permissions.readProject, false);
  assert.equal(control.externalMcpError.value, "denied");
  assert.equal(await control.setExternalMcpEnabled(false), null);
  assert.equal(control.externalMcpLoading.value, false);
});
