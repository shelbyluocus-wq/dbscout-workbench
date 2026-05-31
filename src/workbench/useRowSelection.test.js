import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { useRowSelection } from "./composables/useRowSelection.js";
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
    options.rowSelectionOptions || {},
  );
  return { tab, calls, fetched, statusText, selection };
}

function keys(tab) {
  return tab.rows.map((row) => buildRowKey(tab, row));
}

test("plain row-header clicks toggle multiple selected rows", () => {
  const { tab, selection } = createHarness();
  const allKeys = keys(tab);

  selection.toggleRowSelect(tab, tab.rows[0], {});
  selection.toggleRowSelect(tab, tab.rows[2], {});
  selection.toggleRowSelect(tab, tab.rows[3], {});

  assert.deepEqual([...tab.selectedRowKeys], [allKeys[0], allKeys[2], allKeys[3]]);

  selection.toggleRowSelect(tab, tab.rows[2], {});
  assert.deepEqual([...tab.selectedRowKeys], [allKeys[0], allKeys[3]]);
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

test("long-press row-header drag selects contiguous whole rows", () => {
  const { tab, selection } = createHarness({ rowSelectionOptions: { rowDragDelayMs: 0 } });
  const allKeys = keys(tab);

  selection.startRowDragSelection(tab, tab.rows[1], { button: 0 });
  selection.extendRowDragSelection(tab, tab.rows[3]);

  assert.deepEqual([...tab.selectedRowKeys], allKeys.slice(1, 4));
  assert.equal(selection.finishRowDragSelection(), true);
  assert.equal(selection.consumeRowDragClickSuppression(), true);
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
  globalThis.window = { confirm: () => true };

  selection.toggleRowSelect(tab, tab.rows[0], {});
  selection.toggleRowSelect(tab, tab.rows[2], { ctrlKey: true });
  await selection.deleteSelectedRows(tab);

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
