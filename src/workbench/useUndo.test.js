import test from "node:test";
import assert from "node:assert/strict";
import { computed, reactive } from "vue";

import { createEditState } from "./editState.js";
import { useUndo } from "./composables/useUndo.js";
import { buildRowIdentity, buildRowKey } from "./utils/rowIdentity.js";

function flushAsyncHandler() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createUndoHarness(row, entry, invokeResult = { updated: true, conflict: false }) {
  const tab = reactive({
    id: "tab-1",
    tableName: "player",
    sessionId: "session-1",
    primaryKeys: ["id"],
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "note" }],
    rows: Array.isArray(row) ? row : [row],
  });
  const editState = reactive(createEditState());
  editState.undoStack.push(entry);
  const calls = [];
  const statusText = { value: "" };
  const undo = useUndo(
    editState,
    async (command, payload) => {
      calls.push({ command, payload });
      return typeof invokeResult === "function" ? invokeResult(command, payload) : invokeResult;
    },
    computed(() => tab),
    { statusText },
  );
  return { tab, editState, calls, statusText, undo };
}

test("undo preserves SQL NULL instead of converting it to an empty string", async () => {
  const row = { id: "1", note: "saved" };
  const rowKey = buildRowKey({ primaryKeys: ["id"], columns: [] }, row);
  const harness = createUndoHarness(row, {
    tableName: "player",
    rowKey,
    beforeRowKey: rowKey,
    afterRowKey: rowKey,
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    columnName: "note",
    oldValue: null,
    newValue: "saved",
  });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await flushAsyncHandler();

  assert.equal(harness.calls[0].payload.request.oldValue, "saved");
  assert.equal(harness.calls[0].payload.request.newValue, null);
  assert.equal(harness.tab.rows[0].note, null);
  assert.equal(harness.statusText.value, "已撤销");
});

test("one undo and redo reverses an entire multi-row paste atomically", async () => {
  const rows = [
    { id: "1", note: "A", score: "11" },
    { id: "2", note: "B", score: "22" },
  ];
  const entry = {
    kind: "cell-batch",
    groupId: 7,
    tableName: "player",
    entries: [
      {
        tableName: "player", rowKey: "id=1", beforeRowKey: "id=1", afterRowKey: "id=1",
        beforeIdentity: { id: "1" }, afterIdentity: { id: "1" }, undoRowId: 1,
        columnName: "note", oldValue: "before-a", newValue: "A",
      },
      {
        tableName: "player", rowKey: "id=1", beforeRowKey: "id=1", afterRowKey: "id=1",
        beforeIdentity: { id: "1" }, afterIdentity: { id: "1" }, undoRowId: 1,
        columnName: "score", oldValue: "10", newValue: "11",
      },
      {
        tableName: "player", rowKey: "id=2", beforeRowKey: "id=2", afterRowKey: "id=2",
        beforeIdentity: { id: "2" }, afterIdentity: { id: "2" }, undoRowId: 2,
        columnName: "note", oldValue: "before-b", newValue: "B",
      },
      {
        tableName: "player", rowKey: "id=2", beforeRowKey: "id=2", afterRowKey: "id=2",
        beforeIdentity: { id: "2" }, afterIdentity: { id: "2" }, undoRowId: 2,
        columnName: "score", oldValue: "20", newValue: "22",
      },
    ],
  };
  const harness = createUndoHarness(rows, entry, { updated: 2, conflict: false });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await flushAsyncHandler();

  assert.equal(harness.calls[0].command, "update_cells");
  assert.equal(harness.calls[0].payload.request.rows.length, 2);
  assert.deepEqual(harness.tab.rows.map((row) => [row.note, row.score]), [
    ["before-a", "10"],
    ["before-b", "20"],
  ]);
  assert.equal(harness.editState.undoStack.length, 0);
  assert.equal(harness.editState.redoStack.length, 1);
  assert.equal(harness.statusText.value, "已撤销 4 个单元格");

  harness.undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await flushAsyncHandler();

  assert.equal(harness.calls[1].command, "update_cells");
  assert.deepEqual(harness.tab.rows.map((row) => [row.note, row.score]), [
    ["A", "11"],
    ["B", "22"],
  ]);
  assert.equal(harness.editState.undoStack.length, 1);
  assert.equal(harness.editState.redoStack.length, 0);
  assert.equal(harness.statusText.value, "已重做 4 个单元格");
});

test("undo locates a row by its post-edit primary key and redo uses the original key", async () => {
  const row = { id: "2", note: "same" };
  const table = { primaryKeys: ["id"], columns: [{ column_name: "id" }, { column_name: "note" }] };
  const beforeRow = { id: "1", note: "same" };
  const afterRow = { id: "2", note: "same" };
  const harness = createUndoHarness(row, {
    tableName: "player",
    rowKey: buildRowKey(table, afterRow),
    beforeRowKey: buildRowKey(table, beforeRow),
    afterRowKey: buildRowKey(table, afterRow),
    beforeIdentity: buildRowIdentity(table, beforeRow),
    afterIdentity: buildRowIdentity(table, afterRow),
    columnName: "id",
    oldValue: "1",
    newValue: "2",
  });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await flushAsyncHandler();

  assert.deepEqual(harness.calls[0].payload.request.rowIdentity, { id: "2" });
  assert.equal(harness.tab.rows[0].id, "1");

  harness.undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await flushAsyncHandler();

  assert.deepEqual(harness.calls[1].payload.request.rowIdentity, { id: "1" });
  assert.equal(harness.tab.rows[0].id, "2");
});

test("undo keeps the local value and history when the backend reports a conflict", async () => {
  const row = { id: "1", note: "saved" };
  const rowKey = buildRowKey({ primaryKeys: ["id"], columns: [] }, row);
  const entry = {
    tableName: "player",
    rowKey,
    beforeRowKey: rowKey,
    afterRowKey: rowKey,
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    columnName: "note",
    oldValue: "before",
    newValue: "saved",
  };
  const harness = createUndoHarness(row, entry, { updated: false, conflict: true });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await flushAsyncHandler();

  assert.equal(harness.tab.rows[0].note, "saved");
  assert.deepEqual(harness.editState.undoStack, [entry]);
  assert.match(harness.statusText.value, /撤销失败.*数据已被别人修改/);
});
