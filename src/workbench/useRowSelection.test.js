import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { useRowSelection } from "./composables/useRowSelection.js";
import { useConfirm } from "./composables/useConfirm.js";
import { buildRowKey, rowIdentityLabel } from "./utils/rowIdentity.js";
import { getInsertRowKey } from "./utils/gridRowIdentity.js";
import { createVisualRowModel } from "./utils/visualRows.js";

const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.window = originalWindow;
});

function createHarness(options = {}) {
  const tab = {
    id: "tab-1",
    tableName: "player",
    sessionId: "session-1",
    primaryKeys: ["id"],
    columns: [{ column_name: "id" }, { column_name: "name" }],
    rows: [
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
      { id: "3", name: "Cara" },
      { id: "4", name: "Dana" },
    ],
    page: 1,
    selectedRowKeys: new Set(),
  };
  const calls = [];
  const fetched = [];
  const statusText = { value: "" };
  const selection = useRowSelection(
    async (command, payload) => {
      calls.push({ command, payload });
      return {};
    },
    { statusText },
    {
      fetchPage: async (targetTab, page) => fetched.push({ tab: targetTab, page }),
      prepareForDelete: options.prepareForDelete,
      getVisualRowModel: options.getVisualRowModel,
      removeInsertRows: options.removeInsertRows,
    },
  );
  return { tab, calls, fetched, statusText, selection };
}

function keys(tab) {
  return tab.rows.map((row) => buildRowKey(tab, row));
}

function pointerYForRow(rowIndex, {
  wrapTop = 100,
  rowHeight = 28,
  fieldCommentHeight = 32,
  offset = rowHeight / 2,
} = {}) {
  return wrapTop + 28 + fieldCommentHeight + rowIndex * rowHeight + offset;
}

test("plain row-header click selects only the clicked row (single-select)", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);

  selection.toggleRowSelect(tab, tab.rows[0], {});
  assert.deepEqual([...tab.selectedRowKeys], [allKeys[0]]);

  selection.toggleRowSelect(tab, tab.rows[2], {});
  assert.deepEqual([...tab.selectedRowKeys], [allKeys[2]]);

  selection.toggleRowSelect(tab, tab.rows[3], {});
  assert.deepEqual([...tab.selectedRowKeys], [allKeys[3]]);

  // Clicking the already-selected row keeps it selected (single row remains selected)
  selection.toggleRowSelect(tab, tab.rows[3], {});
  assert.deepEqual([...tab.selectedRowKeys], [allKeys[3]]);
});

test("ctrl-click toggles additional row selection", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);

  selection.toggleRowSelect(tab, tab.rows[0], {});
  selection.toggleRowSelect(tab, tab.rows[2], { ctrlKey: true });

  assert.deepEqual([...tab.selectedRowKeys], [allKeys[0], allKeys[2]]);

  selection.toggleRowSelect(tab, tab.rows[0], { ctrlKey: true });
  assert.deepEqual([...tab.selectedRowKeys], [allKeys[2]]);
});

test("shift-click selects contiguous range from row anchor", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);

  selection.toggleRowSelect(tab, tab.rows[1], {});
  selection.toggleRowSelect(tab, tab.rows[3], { shiftKey: true });

  assert.deepEqual([...tab.selectedRowKeys], allKeys.slice(1, 4));
});

test("vertical arrow navigation keeps whole-row selection mode", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);

  selection.toggleRowSelect(tab, tab.rows[1], {});

  assert.equal(selection.moveRowSelection(tab, "ArrowDown"), true);
  assert.deepEqual([...tab.selectedRowKeys], [allKeys[2]]);

  assert.equal(selection.moveRowSelection(tab, "ArrowUp"), true);
  assert.deepEqual([...tab.selectedRowKeys], [allKeys[1]]);
});

test("horizontal arrows are not handled as whole-row navigation", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);

  selection.toggleRowSelect(tab, tab.rows[1], {});

  assert.equal(selection.moveRowSelection(tab, "ArrowRight"), false);
  assert.deepEqual([...tab.selectedRowKeys], [allKeys[1]]);

  assert.equal(selection.moveRowSelection(tab, "ArrowLeft"), false);
  assert.deepEqual([...tab.selectedRowKeys], [allKeys[1]]);
});

test("row-header drag via pointer selects contiguous whole rows", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);

  const wrap = {
    getBoundingClientRect: () => ({ top: 100, left: 0 }),
    scrollTop: 0,
  };

  selection.startRowDragSelection(tab, tab.rows[1], { button: 0 }, wrap);
  selection.extendRowDragSelectionFromPointer(tab, { clientY: pointerYForRow(3) });

  assert.deepEqual([...tab.selectedRowKeys], allKeys.slice(1, 4));
  assert.equal(selection.finishRowDragSelection(), true);
  assert.equal(selection.consumeRowDragClickSuppression(), true);
});

test("plain row-header click clears previous ctrl-based multi-selection", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);

  selection.toggleRowSelect(tab, tab.rows[0], { ctrlKey: true });
  selection.toggleRowSelect(tab, tab.rows[2], { ctrlKey: true });
  assert.deepEqual([...tab.selectedRowKeys], [allKeys[0], allKeys[2]]);

  selection.toggleRowSelect(tab, tab.rows[1], {});
  assert.deepEqual([...tab.selectedRowKeys], [allKeys[1]]);
});

test("pointer drag covers every row between anchor and pointer even across gaps", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);

  const wrap = {
    getBoundingClientRect: () => ({ top: 100, left: 0 }),
    scrollTop: 0,
  };

  selection.startRowDragSelection(tab, tab.rows[0], { button: 0 }, wrap);
  selection.extendRowDragSelectionFromPointer(tab, { clientY: pointerYForRow(3) });

  assert.deepEqual([...tab.selectedRowKeys], allKeys.slice(0, 4));
  assert.equal(selection.finishRowDragSelection(), true);
});

test("ctrl-drag adds the dragged range to existing selections", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);

  const wrap = {
    getBoundingClientRect: () => ({ top: 100, left: 0 }),
    scrollTop: 0,
  };

  selection.toggleRowSelect(tab, tab.rows[0], { ctrlKey: true });
  selection.startRowDragSelection(tab, tab.rows[2], { button: 0, ctrlKey: true }, wrap);
  selection.extendRowDragSelectionFromPointer(tab, { clientY: pointerYForRow(3) });

  assert.deepEqual([...tab.selectedRowKeys], [allKeys[0], ...allKeys.slice(2, 4)]);
  assert.equal(selection.finishRowDragSelection(), true);
});

test("pointer drag does not select the next row before crossing its visible boundary", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);
  tab.rowHeight = 40;
  tab.fieldCommentHeight = 44;

  const wrap = {
    getBoundingClientRect: () => ({ top: 100, left: 0 }),
    scrollTop: 0,
  };

  selection.startRowDragSelection(tab, tab.rows[0], { button: 0 }, wrap);
  assert.equal(selection.extendRowDragSelectionFromPointer(tab, {
    clientY: pointerYForRow(0, { rowHeight: 40, fieldCommentHeight: 44, offset: 39.5 }),
  }), false);
  assert.equal(tab.selectedRowKeys.size, 0);

  assert.equal(selection.extendRowDragSelectionFromPointer(tab, {
    clientY: pointerYForRow(1, { rowHeight: 40, fieldCommentHeight: 44, offset: 0.5 }),
  }), true);
  assert.deepEqual([...tab.selectedRowKeys], allKeys.slice(0, 2));
});

test("insert drafts use the same ctrl and shift whole-row selection as saved rows", () => {
  const firstInsert = { id: "insert-a", draft: { id: "5", name: "Eve" }, anchorIndex: 1 };
  const secondInsert = { id: "insert-b", draft: { id: "6", name: "Finn" }, anchorIndex: 1 };
  const getVisualRowModel = (tab) => createVisualRowModel({
    dataRowCount: tab.rows.length,
    dataRowAt: (index) => tab.rows[index],
    insertRows: [firstInsert, secondInsert],
    makeInsertRow: (insertRow) => ({ ...insertRow.draft, __insertRowId: insertRow.id }),
  });
  const { tab, selection } = createHarness({ getVisualRowModel });
  const firstRow = { ...firstInsert.draft, __insertRowId: firstInsert.id };
  const secondRow = { ...secondInsert.draft, __insertRowId: secondInsert.id };

  selection.toggleRowSelect(tab, firstRow, {});
  selection.toggleRowSelect(tab, secondRow, { ctrlKey: true });
  assert.deepEqual([...tab.selectedRowKeys], [
    getInsertRowKey(tab, firstInsert.id),
    getInsertRowKey(tab, secondInsert.id),
  ]);

  selection.toggleRowSelect(tab, tab.rows[2], { shiftKey: true });
  assert.deepEqual([...tab.selectedRowKeys], [
    getInsertRowKey(tab, secondInsert.id),
    buildRowKey(tab, tab.rows[1]),
    buildRowKey(tab, tab.rows[2]),
  ]);
});

test("deleting multiple selected insert drafts removes them without a database delete", async () => {
  const insertRows = [
    { id: "insert-a", draft: { id: "5" }, anchorIndex: null },
    { id: "insert-b", draft: { id: "6" }, anchorIndex: null },
  ];
  const removed = [];
  const getVisualRowModel = (tab) => createVisualRowModel({
    dataRowCount: tab.rows.length,
    dataRowAt: (index) => tab.rows[index],
    insertRows,
    makeInsertRow: (insertRow) => ({ ...insertRow.draft, __insertRowId: insertRow.id }),
  });
  const harness = createHarness({
    getVisualRowModel,
    removeInsertRows(_tab, rowIds) {
      removed.push(...rowIds);
      return rowIds.length;
    },
  });
  harness.tab.selectedRowKeys.add(getInsertRowKey(harness.tab, "insert-a"));
  harness.tab.selectedRowKeys.add(getInsertRowKey(harness.tab, "insert-b"));

  await harness.selection.deleteSelectedRows(harness.tab);

  assert.deepEqual(removed, ["insert-a", "insert-b"]);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.tab.selectedRowKeys.size, 0);
});

test("deleting a mixed saved-and-draft selection keeps database and local targets separate", async () => {
  const insertRows = [
    { id: "insert-a", draft: { id: "5", name: "Eve" }, anchorIndex: 1 },
  ];
  const removals = [];
  let preparationOptions = null;
  const getVisualRowModel = (tab) => createVisualRowModel({
    dataRowCount: tab.rows.length,
    dataRowAt: (index) => tab.rows[index],
    insertRows,
    makeInsertRow: (insertRow) => ({ ...insertRow.draft, __insertRowId: insertRow.id }),
  });
  const harness = createHarness({
    getVisualRowModel,
    async prepareForDelete(_tab, options) {
      preparationOptions = options;
      return true;
    },
    removeInsertRows(_tab, rowIds, options) {
      removals.push({ rowIds, options });
      return rowIds.length;
    },
  });
  harness.tab.selectedRowKeys.add(buildRowKey(harness.tab, harness.tab.rows[0]));
  harness.tab.selectedRowKeys.add(getInsertRowKey(harness.tab, "insert-a"));
  const { close } = useConfirm();

  const deletePromise = harness.selection.deleteSelectedRows(harness.tab);
  close(true);
  await deletePromise;

  assert.deepEqual(preparationOptions, { excludeInsertRowIds: ["insert-a"] });
  assert.deepEqual(harness.calls, [{
    command: "delete_rows",
    payload: {
      request: {
        sessionId: "session-1",
        rowIdentities: [{ id: "1" }],
      },
    },
  }]);
  assert.deepEqual(removals, [{
    rowIds: ["insert-a"],
    options: { recordHistory: false, updateStatus: false, refocus: false },
  }]);
  assert.equal(harness.fetched.length, 1);
  assert.equal(harness.tab.selectedRowKeys.size, 0);
  assert.equal(harness.statusText.value, "已删除 1 行，并移除 1 条未保存新增行");
});

test("rendered row under the pointer wins over fallback height estimates", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);
  const renderedRow = {
    getAttribute: (name) => (name === "data-row-selection-index" ? "1" : null),
  };
  const wrap = {
    getBoundingClientRect: () => ({ top: 100, left: 0 }),
    scrollTop: 0,
    contains: (element) => element === renderedRow,
  };

  selection.startRowDragSelection(tab, tab.rows[0], { button: 0 }, wrap);
  selection.extendRowDragSelectionFromPointer(tab, {
    clientY: 999,
    target: { closest: () => renderedRow },
  });

  assert.deepEqual([...tab.selectedRowKeys], allKeys.slice(0, 2));
});

test("select-all corner selects and clears loaded rows", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);

  selection.toggleAllRows(tab);
  assert.deepEqual([...tab.selectedRowKeys], allKeys);

  selection.toggleAllRows(tab);
  assert.equal(tab.selectedRowKeys.size, 0);
});

test("plain row-header click can select a row appended after insertion", () => {
  const { tab, selection } = createHarness();
  tab.rows.push({ id: "5", name: "Eve" });

  selection.toggleRowSelect(tab, tab.rows[4], {});

  assert.deepEqual([...tab.selectedRowKeys], [buildRowKey(tab, tab.rows[4])]);
});

test("right-clicking an unselected row makes it the only row target", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);
  tab.selectedRowKeys.add(allKeys[0]);
  tab.selectedRowKeys.add(allKeys[1]);

  selection.ensureRowContextSelection(tab, tab.rows[3]);

  assert.deepEqual([...tab.selectedRowKeys], [allKeys[3]]);
});

test("right-clicking inside the selected rows preserves the multi-row target", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);
  tab.selectedRowKeys.add(allKeys[0]);
  tab.selectedRowKeys.add(allKeys[1]);

  selection.ensureRowContextSelection(tab, tab.rows[1]);

  assert.deepEqual([...tab.selectedRowKeys], allKeys.slice(0, 2));
});

test("delete selected rows sends row identities", async () => {
  const { tab, calls, fetched, statusText, selection } = createHarness();
  const { close } = useConfirm();

  selection.toggleRowSelect(tab, tab.rows[0], {});
  selection.toggleRowSelect(tab, tab.rows[2], { ctrlKey: true });
  const deletePromise = selection.deleteSelectedRows(tab);
  close(true);
  await deletePromise;

  assert.deepEqual(calls.at(-1), {
    command: "delete_rows",
    payload: {
      request: {
        sessionId: "session-1",
        rowIdentities: [{ id: "1" }, { id: "3" }],
      },
    },
  });
  assert.equal(tab.selectedRowKeys.size, 0);
  assert.equal(fetched.at(-1).page, 1);
  assert.equal(statusText.value, "已删除 2 行");
});

test("cancelling insert-draft preparation prevents deletion", async () => {
  const { tab, calls, selection } = createHarness({ prepareForDelete: async () => false });
  const { close } = useConfirm();
  selection.toggleRowSelect(tab, tab.rows[0], {});

  const deletePromise = selection.deleteSelectedRows(tab);
  close(true);
  await deletePromise;

  assert.equal(calls.length, 0);
});


test("rowIdentityLabel formats primary-key identity for display", () => {
  assert.equal(rowIdentityLabel({ primaryKeys: ["id"] }, { id: 3 }), "id=3");
  assert.equal(rowIdentityLabel({ primaryKeys: ["a", "b"] }, { a: 1, b: "x" }), "a=1 + b=x");
  assert.equal(rowIdentityLabel({ primaryKeys: ["id"] }, { id: null }), "id=NULL");
  assert.equal(rowIdentityLabel({ primaryKeys: ["id"] }, { id: "" }), 'id=""');
  assert.equal(rowIdentityLabel({ primaryKeys: [] }, { id: 3 }), null);
  assert.equal(rowIdentityLabel({ primaryKeys: ["id"] }, null), null);
  const long = rowIdentityLabel({ primaryKeys: ["k"] }, { k: "x".repeat(100) });
  assert.ok(long.length <= 60);
  assert.ok(long.endsWith("…"));
});

test("deleteRow confirm names the row by primary key and mentions rollback", async () => {
  const { tab, selection } = createHarness();
  const { confirmDialog, close } = useConfirm();

  const deletePromise = selection.deleteRow(tab, tab.rows[1]);
  assert.match(confirmDialog.message, /player 中 id=2 的行/);
  assert.match(confirmDialog.message, /备份中心回滚/);
  assert.doesNotMatch(confirmDialog.message, /不可撤销/);
  close(true);
  await deletePromise;
});

test("deleteRow falls back to generic wording without a primary key", async () => {
  const { tab, selection } = createHarness();
  const { confirmDialog, close } = useConfirm();

  tab.primaryKeys = [];
  const deletePromise = selection.deleteRow(tab, tab.rows[0]);
  assert.match(confirmDialog.message, /player 的当前行/);
  close(true);
  await deletePromise;
});

test("deleteSelectedRows confirm names the table and mentions rollback", async () => {
  const { tab, selection } = createHarness();
  const { confirmDialog, close } = useConfirm();

  selection.toggleRowSelect(tab, tab.rows[0], {});
  const deletePromise = selection.deleteSelectedRows(tab);
  assert.match(confirmDialog.message, /player 中已选的 1 行/);
  assert.match(confirmDialog.message, /备份中心回滚/);
  assert.doesNotMatch(confirmDialog.message, /不可撤销/);
  close(true);
  await deletePromise;
});
