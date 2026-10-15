import test from "node:test";
import assert from "node:assert/strict";
import { computed, reactive, ref } from "vue";

import {
  commitUndoTransaction,
  createEditState,
  createUndoTransaction,
  recordUndoEntry,
} from "./editState.js";
import { useUndo } from "./composables/useUndo.js";
import { buildRowIdentity, buildRowKey } from "./utils/rowIdentity.js";

function flushAsyncHandler() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForTestCondition(predicate, message, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await flushAsyncHandler();
  }
  assert.ok(predicate(), message);
}

function createUndoHarness(
  row,
  entry,
  invokeResult = { updated: true, conflict: false },
  undoOptions = {},
) {
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
    { statusText, ...undoOptions },
  );
  return { tab, editState, calls, statusText, undo };
}

test("undo and redo after paste belong to the grid while its IME input is primed", async () => {
  const harness = createUndoHarness({ id: "1", note: "pasted" }, {
    tableName: "player", rowKey: "id=1",
    beforeRowKey: "id=1", afterRowKey: "id=1",
    beforeIdentity: { id: "1" }, afterIdentity: { id: "1" },
    columnName: "note", oldValue: "original", newValue: "pasted",
  });
  const input = { tagName: "INPUT", matches: (selector) => selector === "input.wb-cell-ime-hold" };
  const event = {
    key: "z", ctrlKey: true, target: input,
    composedPath: () => [input, { tagName: "TD" }],
    preventDefault() {},
  };
  assert.equal(harness.undo.handleUndoKeydown(event), true);
  await waitForTestCondition(() => harness.editState.redoStack.length === 1, "paste undo should finish");
  assert.equal(harness.tab.rows[0].note, "original");
  assert.equal(harness.undo.handleRedoKeydown({ ...event, key: "y" }), true);
  await waitForTestCondition(() => harness.editState.undoStack.length === 1, "paste redo should finish");
  assert.equal(harness.tab.rows[0].note, "pasted");
  assert.equal(harness.calls.length, 2);
});

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

test("undo shortcuts stay native inside editable controls", () => {
  const row = { id: "1", note: "saved" };
  const harness = createUndoHarness(row, {
    tableName: "player",
    rowKey: "id=1",
    columnName: "note",
    oldValue: "before",
    newValue: "saved",
  });
  for (const target of [
    { tagName: "INPUT" },
    { tagName: "textarea" },
    { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
    { tagName: "SPAN", getAttribute: (name) => name === "contenteditable" ? "true" : null },
  ]) {
    let prevented = false;
    const handled = harness.undo.handleUndoKeydown({
      key: "z",
      ctrlKey: true,
      shiftKey: false,
      target,
      preventDefault() { prevented = true; },
    });
    assert.equal(handled, false);
    assert.equal(prevented, false);
  }
  assert.equal(harness.editState.undoStack.length, 1);
});

test("undo finds the latest entry for the active table below another table history item", async () => {
  const row = { id: "1", note: "saved" };
  const playerEntry = {
    tableName: "player",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    columnName: "note",
    oldValue: "before",
    newValue: "saved",
  };
  const harness = createUndoHarness(row, playerEntry);
  const otherEntry = { ...playerEntry, tableName: "inventory" };
  harness.editState.undoStack.push(otherEntry);

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await flushAsyncHandler();

  assert.equal(harness.tab.rows[0].note, "before");
  assert.deepEqual(harness.editState.undoStack, [otherEntry]);
  assert.equal(harness.editState.redoStack.length, 1);
});

test("undo pressed during a save waits for and reverses only the new history", async () => {
  const row = { id: "1", note: "pending" };
  const oldEntry = {
    tableName: "player",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    columnName: "note",
    oldValue: "old",
    newValue: "saved",
  };
  const harness = createUndoHarness(row, oldEntry);
  const transaction = createUndoTransaction(harness.editState, {
    tableName: "player",
    tabId: harness.tab.id,
    label: "编辑单元格",
  });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  assert.equal(harness.calls.length, 0);

  const pendingEntry = { ...oldEntry, oldValue: "saved", newValue: "pending" };
  recordUndoEntry(harness.editState, pendingEntry, transaction);
  commitUndoTransaction(harness.editState, transaction);
  await flushAsyncHandler();

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].payload.request.newValue, "saved");
  assert.equal(harness.tab.rows[0].note, "saved");
  assert.deepEqual(harness.editState.undoStack, [oldEntry]);
  assert.equal(harness.editState.redoStack.length, 1);
});

test("a failed pending save does not make queued undo consume older history", async () => {
  const row = { id: "1", note: "saved" };
  const oldEntry = {
    tableName: "player",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    columnName: "note",
    oldValue: "before",
    newValue: "saved",
  };
  const harness = createUndoHarness(row, oldEntry);
  const transaction = createUndoTransaction(harness.editState, {
    tableName: "player",
    tabId: harness.tab.id,
    label: "编辑单元格",
  });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  commitUndoTransaction(harness.editState, transaction);
  await flushAsyncHandler();

  assert.equal(harness.calls.length, 0);
  assert.deepEqual(harness.editState.undoStack, [oldEntry]);
  assert.equal(harness.editState.redoStack.length, 0);
  assert.equal(harness.statusText.value, "无可撤销操作");
});

test("composite history undoes in reverse and redoes in forward order", async () => {
  const row = { id: "1", note: "B", score: "2" };
  const base = {
    tableName: "player",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
  };
  const entry = {
    kind: "history-composite",
    tableName: "player",
    label: "混合粘贴",
    entries: [
      { ...base, columnName: "note", oldValue: "A", newValue: "B" },
      { ...base, columnName: "score", oldValue: "1", newValue: "2" },
    ],
  };
  const committedColumns = [];
  const harness = createUndoHarness(row, entry, undefined, {
    onCellCommitted: (event) => committedColumns.push(event.column),
  });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await flushAsyncHandler();
  assert.deepEqual(harness.calls.map((call) => call.payload.request.columnName), ["score", "note"]);
  assert.deepEqual(committedColumns, ["score", "note"]);
  assert.deepEqual([harness.tab.rows[0].note, harness.tab.rows[0].score], ["A", "1"]);
  assert.equal(harness.editState.redoStack[0].kind, "history-composite");

  harness.undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await flushAsyncHandler();
  assert.deepEqual(harness.calls.map((call) => call.payload.request.columnName), ["score", "note", "note", "score"]);
  assert.deepEqual(committedColumns, ["score", "note", "note", "score"]);
  assert.deepEqual([harness.tab.rows[0].note, harness.tab.rows[0].score], ["B", "2"]);
});

test("composite failure compensates applied children and restores its history", async () => {
  const row = { id: "1", note: "B", score: "2" };
  const base = {
    tableName: "player",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
  };
  const entry = {
    kind: "history-composite",
    tableName: "player",
    entries: [
      { ...base, columnName: "note", oldValue: "A", newValue: "B" },
      { ...base, columnName: "score", oldValue: "1", newValue: "2" },
    ],
  };
  const committedCells = [];
  const harness = createUndoHarness(
    row,
    entry,
    (_command, payload) => (
      payload.request.columnName === "note" && payload.request.newValue === "A"
        ? { updated: false, conflict: true }
        : { updated: true, conflict: false }
    ),
    { onCellCommitted: (event) => committedCells.push(event) },
  );

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await flushAsyncHandler();

  assert.deepEqual(harness.calls.map((call) => call.payload.request.columnName), ["score", "note", "score"]);
  assert.deepEqual([harness.tab.rows[0].note, harness.tab.rows[0].score], ["B", "2"]);
  assert.equal(harness.editState.undoStack.length, 1);
  assert.equal(harness.editState.undoStack[0].kind, "history-composite");
  assert.equal(harness.editState.redoStack.length, 0);
  assert.deepEqual(committedCells, []);
  assert.match(harness.statusText.value, /撤销失败.*数据已被别人修改/);
});

test("rapid undo requests run serially against the value left by the previous undo", async () => {
  let releaseFirst;
  let callCount = 0;
  const row = { id: "1", note: "C" };
  const base = {
    tableName: "player",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    columnName: "note",
  };
  const harness = createUndoHarness(row, { ...base, oldValue: "A", newValue: "B" }, async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise((resolve) => { releaseFirst = resolve; });
    }
    return { updated: true, conflict: false };
  });
  harness.editState.undoStack.push({ ...base, oldValue: "B", newValue: "C" });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].payload.request.oldValue, "C");
  assert.equal(harness.calls[0].payload.request.newValue, "B");

  releaseFirst({ updated: true, conflict: false });
  await flushAsyncHandler();
  await flushAsyncHandler();

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1].payload.request.oldValue, "B");
  assert.equal(harness.calls[1].payload.request.newValue, "A");
  assert.equal(harness.tab.rows[0].note, "A");
  assert.equal(harness.editState.undoStack.length, 0);
  assert.equal(harness.editState.redoStack.length, 2);
});

test("a failed undo cancels later queued undos instead of skipping past it", async () => {
  let releaseFirst;
  let callCount = 0;
  const base = {
    tableName: "player",
    tabId: "tab-1",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    columnName: "note",
  };
  const harness = createUndoHarness(
    { id: "1", note: "C" },
    { ...base, oldValue: "A", newValue: "B" },
    async () => {
      callCount += 1;
      if (callCount === 1) return await new Promise((resolve) => { releaseFirst = resolve; });
      return { updated: true, conflict: false };
    },
  );
  harness.editState.undoStack.push({ ...base, oldValue: "B", newValue: "C" });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => typeof releaseFirst === "function", "latest undo should reach the backend");
  releaseFirst({ updated: false, conflict: true });
  await flushAsyncHandler();
  await flushAsyncHandler();

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.tab.rows[0].note, "C");
  assert.deepEqual(harness.editState.undoStack.map((entry) => entry.newValue), ["B", "C"]);
  assert.equal(harness.editState.redoStack.length, 0);
  assert.match(harness.statusText.value, /撤销失败/);
});

test("ordinary cell history belongs to the tab that created it", async () => {
  const entry = {
    tableName: "player",
    tabId: "tab-a",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    columnName: "note",
    oldValue: "A",
    newValue: "B",
  };
  const harness = createUndoHarness({ id: "1", note: "B" }, entry);
  harness.tab.id = "tab-b";
  harness.tab.sessionId = "session-b";

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await flushAsyncHandler();

  assert.equal(harness.calls.length, 0);
  assert.equal(harness.tab.rows[0].note, "B");
  assert.deepEqual(harness.editState.undoStack, [entry]);
  assert.equal(harness.statusText.value, "无可撤销操作");
});

test("redo pressed during an in-flight undo targets that undo before older redo history", async () => {
  let releaseUndo;
  let callCount = 0;
  const base = {
    tableName: "player",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    columnName: "note",
  };
  const harness = createUndoHarness(
    { id: "1", note: "B" },
    { ...base, oldValue: "A", newValue: "B" },
    async () => {
      callCount += 1;
      if (callCount === 1) return await new Promise((resolve) => { releaseUndo = resolve; });
      return { updated: true, conflict: false };
    },
  );
  harness.editState.redoStack.push({ ...base, oldValue: "B", newValue: "C" });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  harness.undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => typeof releaseUndo === "function", "undo should reach the backend");

  releaseUndo({ updated: true, conflict: false });
  await waitForTestCondition(() => harness.calls.length === 2, "redo should run after undo");

  assert.deepEqual(harness.calls.map((call) => [
    call.payload.request.oldValue,
    call.payload.request.newValue,
  ]), [["B", "A"], ["A", "B"]]);
  assert.equal(harness.tab.rows[0].note, "B");
  assert.equal(harness.editState.redoStack.length, 1);
  assert.equal(harness.editState.redoStack[0].newValue, "C");
});

test("a pending mutation for another table does not block undo on the active table", async () => {
  const entry = {
    tableName: "player",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    columnName: "note",
    oldValue: "A",
    newValue: "B",
  };
  const harness = createUndoHarness({ id: "1", note: "B" }, entry);
  const otherTableTransaction = createUndoTransaction(harness.editState, {
    tableName: "inventory",
    tabId: "inventory-tab",
  });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => harness.calls.length === 1, "active-table undo should not wait for another table");

  assert.equal(harness.tab.rows[0].note, "A");
  commitUndoTransaction(harness.editState, otherTableTransaction);
});

test("an in-flight composite undo stays bound to its original tab after tab switching", async () => {
  let releaseFirstChild;
  let callCount = 0;
  const tabA = reactive({
    id: "tab-a",
    tableName: "player",
    sessionId: "session-a",
    primaryKeys: ["id"],
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "note" }, { column_name: "score" }],
    rows: [{ id: "1", note: "B", score: "2" }],
  });
  const tabB = reactive({
    id: "tab-b",
    tableName: "inventory",
    sessionId: "session-b",
    primaryKeys: ["id"],
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "note" }],
    rows: [{ id: "9", note: "untouched" }],
  });
  const base = {
    tableName: "player",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
  };
  const editState = reactive(createEditState());
  editState.undoStack.push({
    kind: "history-composite",
    tableName: "player",
    entries: [
      { ...base, columnName: "note", oldValue: "A", newValue: "B" },
      { ...base, columnName: "score", oldValue: "1", newValue: "2" },
    ],
  });
  const active = ref(tabA);
  const calls = [];
  const undo = useUndo(
    editState,
    async (command, payload) => {
      calls.push({ command, payload });
      callCount += 1;
      if (callCount === 1) return await new Promise((resolve) => { releaseFirstChild = resolve; });
      return { updated: true, conflict: false };
    },
    computed(() => active.value),
    { statusText: { value: "" } },
  );

  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => typeof releaseFirstChild === "function", "first composite child should start");
  active.value = tabB;
  tabA.sessionId = "session-a-refreshed";
  releaseFirstChild({ updated: true, conflict: false });
  await waitForTestCondition(() => calls.length === 2, "remaining child should finish on the original tab");

  assert.deepEqual(calls.map((call) => call.payload.request.sessionId), ["session-a", "session-a"]);
  assert.deepEqual([tabA.rows[0].note, tabA.rows[0].score], ["A", "1"]);
  assert.equal(tabB.rows[0].note, "untouched");
});

test("single-cell undo never applies to a different row loaded while the request is pending", async () => {
  let releaseUndo;
  const entry = {
    tableName: "player",
    tabId: "tab-1",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    columnName: "note",
    oldValue: "A",
    newValue: "B",
  };
  const harness = createUndoHarness({ id: "1", note: "B" }, entry, async () => (
    await new Promise((resolve) => { releaseUndo = resolve; })
  ));

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => typeof releaseUndo === "function", "undo should reach the backend");
  harness.tab.rows = [{ id: "2", note: "B" }];
  releaseUndo({ updated: true, conflict: false });
  await waitForTestCondition(() => harness.editState.activeHistoryEntries.size === 0, "undo should settle");

  assert.deepEqual(harness.tab.rows, [{ id: "2", note: "B" }]);
  assert.equal(harness.editState.redoStack.length, 1);
});

test("single-cell undo and redo update a reloaded clone and keep the original session", async () => {
  const releases = [];
  const entry = {
    tableName: "player",
    tabId: "tab-1",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    columnName: "note",
    oldValue: "A",
    newValue: "B",
  };
  const harness = createUndoHarness({ id: "1", note: "B" }, entry, async () => (
    await new Promise((resolve) => { releases.push(resolve); })
  ));

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => releases.length === 1, "undo should reach the backend");
  harness.tab.rows = [{ id: "1", note: "B" }];
  harness.tab.sessionId = "session-refreshed";
  releases.shift()({ updated: true, conflict: false });
  await waitForTestCondition(() => harness.editState.redoStack.length === 1, "undo should settle");
  assert.equal(harness.tab.rows[0].note, "A");

  harness.undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => releases.length === 1, "redo should reach the backend");
  harness.tab.rows = [{ id: "1", note: "A" }];
  harness.tab.sessionId = "session-after-redo-started";
  releases.shift()({ updated: true, conflict: false });
  await waitForTestCondition(() => harness.editState.activeHistoryEntries.size === 0, "redo should settle");

  assert.equal(harness.tab.rows[0].note, "B");
  assert.deepEqual(harness.calls.map((call) => call.payload.request.sessionId), [
    "session-1",
    "session-refreshed",
  ]);
});

test("primary-key undo and redo relocate a clone by source and target row keys", async () => {
  const releases = [];
  const entry = {
    tableName: "player",
    tabId: "tab-1",
    rowKey: "id=2",
    beforeRowKey: "id=1",
    afterRowKey: "id=2",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "2" },
    columnName: "id",
    oldValue: "1",
    newValue: "2",
  };
  const harness = createUndoHarness({ id: "2", note: "same" }, entry, async () => (
    await new Promise((resolve) => { releases.push(resolve); })
  ));

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => releases.length === 1, "primary-key undo should reach the backend");
  harness.tab.rows = [{ id: "2", note: "same" }];
  releases.shift()({ updated: true, conflict: false });
  await waitForTestCondition(() => harness.editState.redoStack.length === 1, "primary-key undo should settle");
  assert.equal(harness.tab.rows[0].id, "1");

  harness.undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => releases.length === 1, "primary-key redo should reach the backend");
  harness.tab.rows = [{ id: "1", note: "same" }];
  releases.shift()({ updated: true, conflict: false });
  await waitForTestCondition(() => harness.editState.activeHistoryEntries.size === 0, "primary-key redo should settle");

  assert.equal(harness.tab.rows[0].id, "2");
  assert.deepEqual(harness.calls.map((call) => call.payload.request.rowIdentity), [
    { id: "2" },
    { id: "1" },
  ]);
});

test("batch undo never applies to different rows loaded while the request is pending", async () => {
  let releaseUndo;
  const base = {
    tableName: "player",
    tabId: "tab-1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "1" },
    undoRowId: 1,
  };
  const entry = {
    kind: "cell-batch",
    tableName: "player",
    tabId: "tab-1",
    entries: [
      { ...base, rowKey: "id=1", columnName: "note", oldValue: "A", newValue: "B" },
      { ...base, rowKey: "id=1", columnName: "score", oldValue: "1", newValue: "2" },
    ],
  };
  const harness = createUndoHarness({ id: "1", note: "B", score: "2" }, entry, async () => (
    await new Promise((resolve) => { releaseUndo = resolve; })
  ));
  harness.tab.columns.push({ column_name: "score" });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => typeof releaseUndo === "function", "batch undo should reach the backend");
  harness.tab.rows = [{ id: "9", note: "B", score: "2" }];
  releaseUndo({ updated: 1, conflict: false });
  await waitForTestCondition(() => harness.editState.activeHistoryEntries.size === 0, "batch undo should settle");

  assert.deepEqual(harness.tab.rows, [{ id: "9", note: "B", score: "2" }]);
});

test("batch undo and redo relocate reordered row clones after each request", async () => {
  const releases = [];
  const rowEntry = (id, columnName, oldValue, newValue, undoRowId) => ({
    tableName: "player",
    tabId: "tab-1",
    rowKey: `id=${id}`,
    beforeRowKey: `id=${id}`,
    afterRowKey: `id=${id}`,
    beforeIdentity: { id },
    afterIdentity: { id },
    undoRowId,
    columnName,
    oldValue,
    newValue,
  });
  const entry = {
    kind: "cell-batch",
    tableName: "player",
    tabId: "tab-1",
    entries: [
      rowEntry("1", "note", "A", "B", 1),
      rowEntry("2", "note", "C", "D", 2),
    ],
  };
  const harness = createUndoHarness([
    { id: "1", note: "B" },
    { id: "2", note: "D" },
  ], entry, async () => await new Promise((resolve) => { releases.push(resolve); }));

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => releases.length === 1, "batch undo should reach the backend");
  harness.tab.rows = [
    { id: "2", note: "D" },
    { id: "9", note: "untouched" },
    { id: "1", note: "B" },
  ];
  releases.shift()({ updated: 2, conflict: false });
  await waitForTestCondition(() => harness.editState.redoStack.length === 1, "batch undo should settle");
  assert.deepEqual(harness.tab.rows.map((row) => [row.id, row.note]), [
    ["2", "C"],
    ["9", "untouched"],
    ["1", "A"],
  ]);

  harness.undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => releases.length === 1, "batch redo should reach the backend");
  harness.tab.rows = [
    { id: "1", note: "A" },
    { id: "9", note: "untouched" },
    { id: "2", note: "C" },
  ];
  releases.shift()({ updated: 2, conflict: false });
  await waitForTestCondition(() => harness.editState.activeHistoryEntries.size === 0, "batch redo should settle");

  assert.deepEqual(harness.tab.rows.map((row) => [row.id, row.note]), [
    ["1", "B"],
    ["9", "untouched"],
    ["2", "D"],
  ]);
});

test("single-cell undo and redo use frozen identities when the row is not loaded", async () => {
  const committedCells = [];
  const entry = {
    tableName: "player",
    tabId: "tab-1",
    rowKey: "id=2",
    beforeRowKey: "id=1",
    afterRowKey: "id=2",
    beforeIdentity: { id: "1" },
    afterIdentity: { id: "2" },
    columnName: "id",
    oldValue: "1",
    newValue: "2",
  };
  const harness = createUndoHarness([], entry, undefined, {
    onCellCommitted: ({ rowKey, column, oldValue, newValue }) => {
      committedCells.push({ rowKey, column, oldValue, newValue });
    },
  });

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(
    () => harness.calls.length === 1 && harness.editState.activeHistoryEntries.size === 0,
    "unloaded-row undo should finish",
  );

  assert.deepEqual(harness.calls[0].payload.request.rowIdentity, { id: "2" });
  assert.deepEqual(harness.tab.rows, []);
  assert.equal(harness.editState.redoStack.length, 1);
  assert.deepEqual(committedCells, [{
    rowKey: "id=2",
    column: "id",
    oldValue: "2",
    newValue: "1",
  }]);

  harness.undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(
    () => harness.calls.length === 2 && harness.editState.activeHistoryEntries.size === 0,
    "unloaded-row redo should finish",
  );

  assert.deepEqual(harness.calls[1].payload.request.rowIdentity, { id: "1" });
  assert.deepEqual(harness.tab.rows, []);
  assert.deepEqual(committedCells, [
    { rowKey: "id=2", column: "id", oldValue: "2", newValue: "1" },
    { rowKey: "id=1", column: "id", oldValue: "1", newValue: "2" },
  ]);
});

test("unloaded legacy history without a frozen identity remains safely undoable later", async () => {
  const entry = {
    tableName: "player",
    tabId: "tab-1",
    rowKey: "id=1",
    beforeRowKey: "id=1",
    afterRowKey: "id=1",
    columnName: "note",
    oldValue: "A",
    newValue: "B",
  };
  const harness = createUndoHarness([], entry);

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(
    () => harness.editState.activeHistoryEntries.size === 0,
    "legacy unloaded-row undo should settle",
  );

  assert.equal(harness.calls.length, 0);
  assert.equal(harness.editState.undoStack.length, 1);
  assert.equal(harness.editState.redoStack.length, 0);
  assert.match(harness.statusText.value, /撤销失败.*行不存在/);
});

test("unloaded batch undo and redo publish composite-key cells in identity-safe order", async () => {
  const committedCells = [];
  const base = {
    tableName: "player",
    tabId: "tab-1",
    undoRowId: 1,
  };
  const entry = {
    kind: "cell-batch",
    tableName: "player",
    tabId: "tab-1",
    entries: [
      {
        ...base,
        rowKey: "realm=2&player_id=1",
        beforeRowKey: "realm=1&player_id=1",
        afterRowKey: "realm=2&player_id=1",
        beforeIdentity: { realm: "1", player_id: "1" },
        afterIdentity: { realm: "2", player_id: "1" },
        columnName: "realm",
        oldValue: "1",
        newValue: "2",
      },
      {
        ...base,
        rowKey: "realm=2&player_id=2",
        beforeRowKey: "realm=2&player_id=1",
        afterRowKey: "realm=2&player_id=2",
        beforeIdentity: { realm: "2", player_id: "1" },
        afterIdentity: { realm: "2", player_id: "2" },
        columnName: "player_id",
        oldValue: "1",
        newValue: "2",
      },
    ],
  };
  const harness = createUndoHarness([], entry, { updated: 1, conflict: false }, {
    onCellCommitted: ({ rowKey, column }) => committedCells.push([rowKey, column]),
  });
  harness.tab.primaryKeys = ["realm", "player_id"];
  harness.tab.columns = [
    { column_name: "realm", is_primary_key: true },
    { column_name: "player_id", is_primary_key: true },
  ];

  harness.undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(
    () => harness.calls.length === 1 && harness.editState.activeHistoryEntries.size === 0,
    "unloaded batch undo should finish",
  );

  assert.deepEqual(harness.calls[0].payload.request.rows[0].rowIdentity, {
    realm: "2",
    player_id: "2",
  });
  assert.deepEqual(committedCells, [
    ["realm=2&player_id=2", "player_id"],
    ["realm=2&player_id=1", "realm"],
  ]);

  harness.undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(
    () => harness.calls.length === 2 && harness.editState.activeHistoryEntries.size === 0,
    "unloaded batch redo should finish",
  );

  assert.deepEqual(harness.calls[1].payload.request.rows[0].rowIdentity, {
    realm: "1",
    player_id: "1",
  });
  assert.deepEqual(committedCells, [
    ["realm=2&player_id=2", "player_id"],
    ["realm=2&player_id=1", "realm"],
    ["realm=1&player_id=1", "realm"],
    ["realm=2&player_id=1", "player_id"],
  ]);
});

test("table-replace undo reverses patches and redo re-applies them", async () => {
  const rows = [
    { id: "1", note: "aa-x" },
    { id: "2", note: "bb-x" },
  ];
  const tab = reactive({
    id: "tab-1",
    tableName: "player",
    sessionId: "session-1",
    primaryKeys: ["id"],
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "note" }],
    rows,
  });
  const editState = reactive(createEditState());
  const patches = [
    { rowIdentity: { id: "1" }, changes: [{ columnName: "note", oldValue: "aa", newValue: "aa-x" }] },
    { rowIdentity: { id: "2" }, changes: [{ columnName: "note", oldValue: "bb", newValue: "bb-x" }] },
  ];
  const { recordTableReplaceHistory } = await import("./editState.js");
  assert.equal(recordTableReplaceHistory(editState, {
    tableName: "player",
    tabId: "tab-1",
    patches,
  }), true);
  assert.equal(editState.undoStack.at(-1)?.kind, "table-replace");
  assert.equal(editState.undoStack.at(-1)?.cellCount, 2);

  const calls = [];
  const statusText = { value: "" };
  const progressSnapshots = [];
  const undo = useUndo(
    editState,
    async (command, payload) => {
      calls.push({ command, payload });
      progressSnapshots.push(editState.historyProgress ? { ...editState.historyProgress } : null);
      return { updated: payload.request.rows.length, conflict: false };
    },
    computed(() => tab),
    { statusText },
  );

  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(
    () => calls.length === 1 && editState.activeHistoryEntries.size === 0,
    "table-replace undo should finish",
  );

  assert.equal(calls[0].command, "update_cells");
  assert.deepEqual(calls[0].payload.request.rows, [
    { rowIdentity: { id: "1" }, changes: [{ columnName: "note", oldValue: "aa-x", newValue: "aa" }] },
    { rowIdentity: { id: "2" }, changes: [{ columnName: "note", oldValue: "bb-x", newValue: "bb" }] },
  ]);
  assert.equal(tab.rows[0].note, "aa");
  assert.equal(tab.rows[1].note, "bb");
  assert.equal(statusText.value, "已撤销整表替换（2 个单元格）");
  assert.equal(editState.historyProgress, null);
  assert.ok(progressSnapshots.some((snap) => snap && snap.total === 2));
  assert.equal(editState.redoStack.at(-1)?.kind, "table-replace");

  undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(
    () => calls.length === 2 && editState.activeHistoryEntries.size === 0,
    "table-replace redo should finish",
  );

  assert.deepEqual(calls[1].payload.request.rows, [
    { rowIdentity: { id: "1" }, changes: [{ columnName: "note", oldValue: "aa", newValue: "aa-x" }] },
    { rowIdentity: { id: "2" }, changes: [{ columnName: "note", oldValue: "bb", newValue: "bb-x" }] },
  ]);
  assert.equal(tab.rows[0].note, "aa-x");
  assert.equal(tab.rows[1].note, "bb-x");
  assert.equal(statusText.value, "已重做整表替换（2 个单元格）");
});

test("table-replace undo trims the entry to unapplied patches after a mid-way failure", async () => {
  const rows = Array.from({ length: 3 }, (_, index) => ({ id: String(index + 1), note: `n${index}-x` }));
  const tab = reactive({
    id: "tab-1",
    tableName: "player",
    sessionId: "session-1",
    primaryKeys: ["id"],
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "note" }],
    rows,
  });
  const editState = reactive(createEditState());
  // 三个 patch，chunk 大小 500 之外无法分块，这里通过第二次调用失败模拟：
  // 第一行成功（由单 chunk 内 update_cells 原子提交），用 throwing invoke
  // 让第一次调用就失败，验证历史项保持不变可重试。
  const patches = rows.map((row, index) => ({
    rowIdentity: { id: row.id },
    changes: [{ columnName: "note", oldValue: `n${index}`, newValue: `n${index}-x` }],
  }));
  const { recordTableReplaceHistory } = await import("./editState.js");
  recordTableReplaceHistory(editState, { tableName: "player", tabId: "tab-1", patches });

  const statusText = { value: "" };
  let shouldFail = true;
  const undo = useUndo(
    editState,
    async () => {
      if (shouldFail) throw new Error("模拟保存失败");
      return { updated: 3, conflict: false };
    },
    computed(() => tab),
    { statusText },
  );

  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(
    () => statusText.value.startsWith("撤销失败") && editState.activeHistoryEntries.size === 0,
    "failed undo should surface an error",
  );
  assert.equal(editState.undoStack.at(-1)?.kind, "table-replace");
  assert.equal(editState.undoStack.at(-1)?.patches?.length, 3);
  assert.equal(editState.historyProgress, null);

  shouldFail = false;
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(
    () => statusText.value === "已撤销整表替换（3 个单元格）",
    "retried undo should succeed",
  );
  assert.deepEqual(tab.rows.map((row) => row.note), ["n0", "n1", "n2"]);
});
