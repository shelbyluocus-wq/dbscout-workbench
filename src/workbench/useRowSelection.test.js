import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { useRowSelection } from "./composables/useRowSelection.js";
import { useConfirm } from "./composables/useConfirm.js";
import { buildRowKey } from "./utils/rowIdentity.js";

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
    { fetchPage: async (targetTab, page) => fetched.push({ tab: targetTab, page }) },
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
