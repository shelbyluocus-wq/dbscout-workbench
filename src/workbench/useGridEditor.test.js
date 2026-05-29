import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { computed, nextTick, reactive } from "vue";
import { createEditState } from "./editState.js";
import { useGridEditor } from "./composables/useGridEditor.js";
import { buildRowKey } from "./utils/rowIdentity.js";

const initialNavigator = globalThis.navigator;

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", {
    value: initialNavigator,
    configurable: true,
  });
});

function createEditor(options = {}) {
  const clipboard = options.clipboard || { text: "", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  Object.defineProperty(globalThis, "navigator", {
    value: { ...(globalThis.navigator || {}), clipboard },
    configurable: true,
  });
  const tab = reactive({
    id: "tab-1",
    tableName: "player",
    sessionId: "session-1",
    columns: [{ column_name: "name" }, { column_name: "level" }, { column_name: "guild" }],
    rows: [
      { id: "1", name: "Alice", level: "10", guild: "Red" },
      { id: "2", name: "Bob", level: "12", guild: "Blue" },
      { id: "3", name: "Cara", level: "14", guild: "Green" },
    ],
    selectedRowKeys: new Set(),
  });
  const focused = { count: 0 };
  const input = {
    value: "Alice",
    focused: false,
    selection: null,
    focus() {
      this.focused = true;
    },
    setSelectionRange(start, end) {
      this.selection = [start, end];
    },
  };
  const scrollCalls = [];
  const insertInput = {
    focused: false,
    focus() {
      this.focused = true;
    },
  };
  const cells = options.cells || [];
  const gridWrapRef = {
    value: {
      scrollTop: options.scrollTop || 0,
      scrollLeft: options.scrollLeft || 0,
      clientHeight: options.clientHeight || 78,
      focus() {
        focused.count += 1;
      },
      getBoundingClientRect() {
        return options.wrapRect || { top: 0, bottom: 106, left: 0, right: 300 };
      },
      querySelector(selector) {
        if (selector === "td.editing input") return input;
        if (selector.includes('data-insert-column-index="')) return insertInput;
        if (selector.includes('data-column-index="')) {
          const match = selector.match(/data-column-index="(\d+)"/);
          return cells.find((cell) => cell.dataset.columnIndex === match?.[1]) || null;
        }
        return null;
      },
      querySelectorAll(selector) {
        return selector === "th[data-column-index], td[data-column-index]" ? cells : [];
      },
    },
  };
  const statusText = { value: "" };
  const invokeCalls = [];
  const editor = useGridEditor(
    reactive(createEditState()),
    async (command, payload) => {
      invokeCalls.push({ command, payload });
      return {};
    },
    computed(() => tab),
    gridWrapRef,
    {
      scrollRowIntoView(rowIndex) {
        scrollCalls.push([rowIndex]);
      },
      scrollCellIntoView(rowIndex, columnIndex) {
        scrollCalls.push([rowIndex, columnIndex]);
      },
      scrollInsertCellIntoView(columnIndex) {
        scrollCalls.push(["insert", columnIndex]);
      },
    },
    { busy: { value: false }, statusText },
  );
  return { editor, tab, focused, input, insertInput, clipboard, scrollCalls, invokeCalls, statusText, gridWrapRef };
}

test("single click selects a cell without entering edit mode", async () => {
  const { editor, tab } = createEditor();

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await nextTick();

  assert.equal(editor.selectedCell.value.column, "name");
  assert.equal(editor.editingCell.value, null);
});

test("programmatic search selection can preserve the current input focus", async () => {
  const { editor, tab, focused } = createEditor();

  editor.selectCell(tab, tab.rows[0], "name", 0, 0, { focusGrid: false });
  await nextTick();

  assert.equal(editor.selectedCell.value.column, "name");
  assert.equal(focused.count, 0);
});

test("repeated plain clicks keep selecting without entering edit mode", async () => {
  const { editor, tab } = createEditor();

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await nextTick();

  assert.equal(editor.selectedCell.value.column, "name");
  assert.equal(editor.editingCell.value, null);
});

test("double-click edit enters edit mode at the end", async () => {
  const { editor, tab, input } = createEditor();

  editor.startEditing(tab, tab.rows[0], "name", 0, 0);
  await nextTick();

  assert.equal(editor.editingCell.value.column, "name");
  assert.equal(input.focused, true);
  assert.deepEqual(input.selection, [5, 5]);
});

test("F2 enters edit mode for the selected cell at the end", async () => {
  const { editor, tab, input } = createEditor();
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await nextTick();

  await editor.handleGridKeydown({
    key: "F2",
    preventDefault() {},
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  });
  await nextTick();

  assert.equal(editor.editingCell.value.column, "name");
  assert.equal(input.focused, true);
  assert.deepEqual(input.selection, [5, 5]);
});

test("drag range starts from the anchor cell and selects a single-cell range", () => {
  const { editor, tab } = createEditor();

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });

  const rowKey = buildRowKey(tab, tab.rows[0]);
  assert.equal(editor.isSelectingRange.value, true);
  assert.deepEqual(editor.selectedCell.value, { tabId: tab.id, rowKey, column: "name" });
  assert.equal(editor.isCellInSelectedRange(tab, rowKey, "name", 0, 0), true);
  assert.deepEqual(editor.getCellRangeClasses(tab, rowKey, "name", 0, 0), {
    "range-selected": true,
    "range-top": true,
    "range-bottom": true,
    "range-left": true,
    "range-right": true,
    "range-anchor": true,
  });
});

test("drag range extends to a rectangular set of cells", () => {
  const { editor, tab } = createEditor();

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[2], "guild", 2, 2);

  const insideKey = buildRowKey(tab, tab.rows[1]);
  const outsideKey = buildRowKey(tab, tab.rows[0]);
  assert.equal(editor.isCellInSelectedRange(tab, insideKey, "level", 1, 1), true);
  assert.equal(editor.isCellInSelectedRange(tab, outsideKey, "name", 0, 0), true);
  assert.equal(editor.isCellInSelectedRange(tab, outsideKey, "guild", 0, 2), true);
  assert.equal(editor.isCellInSelectedRange(tab, outsideKey, "missing", 0, 3), false);
  assert.equal(editor.selectedCell.value.column, "guild");

  assert.deepEqual(editor.getCellRangeClasses(tab, insideKey, "level", 1, 1), {
    "range-selected": true,
    "range-top": false,
    "range-bottom": false,
    "range-left": false,
    "range-right": false,
    "range-anchor": false,
  });
  assert.deepEqual(editor.getCellRangeClasses(tab, outsideKey, "guild", 0, 2), {
    "range-selected": true,
    "range-top": true,
    "range-bottom": false,
    "range-left": false,
    "range-right": true,
    "range-anchor": false,
  });
});

test("finishing a drag range keeps the selected range", () => {
  const { editor, tab } = createEditor();

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();

  assert.equal(editor.isSelectingRange.value, false);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[1]), "level", 1, 1), true);
});

test("plain cell selection collapses a previous drag range", async () => {
  const { editor, tab } = createEditor();

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[2], "guild", 2, 2);
  editor.finishRangeSelection();
  editor.selectCell(tab, tab.rows[1], "level", 1, 1);
  await nextTick();

  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[1]), "level", 1, 1), true);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[0]), "name", 0, 0), false);
});

test("pointer range extension can target rows outside the rendered cells", () => {
  const cells = [
    { dataset: { columnIndex: "0" }, getBoundingClientRect: () => ({ left: 38, right: 164 }) },
    { dataset: { columnIndex: "1" }, getBoundingClientRect: () => ({ left: 164, right: 290 }) },
    { dataset: { columnIndex: "2" }, getBoundingClientRect: () => ({ left: 290, right: 416 }) },
  ];
  const { editor, tab, gridWrapRef } = createEditor({ cells, scrollTop: 26, wrapRect: { top: 0, bottom: 106, left: 0, right: 300 } });

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelectionFromPointer({ clientX: 350, clientY: 102 });
  editor.finishRangeSelection();

  assert.equal(editor.selectedRange.value.focus.rowIndex, 3 - 1);
  assert.equal(editor.selectedRange.value.focus.columnIndex, 2);
  assert.ok(gridWrapRef.value.scrollTop >= 26);
});

test("keyboard navigation scrolls the focused cell horizontally and vertically", () => {
  const { editor, tab, scrollCalls } = createEditor();

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  editor.navigateCell(0, 1);

  assert.deepEqual(scrollCalls.at(-1), [0, 1]);
  assert.equal(editor.selectedCell.value.column, "level");
});

test("Shift+Arrow extends the selected range while plain Arrow collapses it", async () => {
  const { editor, tab } = createEditor();
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await nextTick();

  await editor.handleGridKeydown({ key: "ArrowRight", shiftKey: true, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.equal(editor.selectedRange.value.anchor.columnIndex, 0);
  assert.equal(editor.selectedRange.value.focus.columnIndex, 1);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[0]), "name", 0, 0), true);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[0]), "level", 0, 1), true);

  await editor.handleGridKeydown({ key: "ArrowRight", shiftKey: false, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.equal(editor.selectedRange.value.anchor.columnIndex, 2);
  assert.equal(editor.selectedRange.value.focus.columnIndex, 2);
});

test("ArrowDown from the last data row focuses the insert row", async () => {
  const { editor, tab, insertInput, scrollCalls } = createEditor();

  editor.selectCell(tab, tab.rows[2], "level", 2, 1);
  await editor.handleGridKeydown({ key: "ArrowDown", shiftKey: false, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });
  await nextTick();

  assert.equal(editor.selectedCell.value, null);
  assert.deepEqual(editor.selectedInsertCell.value, { tabId: tab.id, columnIndex: 1, column: "level" });
  assert.deepEqual(scrollCalls.at(-1), ["insert", 1]);
  assert.equal(insertInput.focused, true);
});

test("ArrowUp from the insert row returns to the last data row and refocuses the grid", async () => {
  const { editor, tab, focused, scrollCalls } = createEditor();

  editor.selectInsertCell(tab, 2);
  editor.handleInsertKeydown(tab, 2, { key: "ArrowUp" });
  await nextTick();

  assert.equal(editor.selectedInsertCell.value, null);
  assert.equal(editor.selectedCell.value.rowKey, buildRowKey(tab, tab.rows[2]));
  assert.equal(editor.selectedCell.value.column, "guild");
  assert.deepEqual(scrollCalls.at(-1), [2, 2]);
  assert.equal(focused.count > 0, true);
});

test("insert row keyboard navigation moves between insert inputs", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 1);
  editor.handleInsertKeydown(tab, 1, { key: "Tab", shiftKey: false });
  assert.equal(editor.selectedInsertCell.value.columnIndex, 2);

  editor.handleInsertKeydown(tab, 2, { key: "ArrowLeft" });
  assert.equal(editor.selectedInsertCell.value.columnIndex, 1);

  editor.handleInsertKeydown(tab, 1, { key: "Tab", shiftKey: true });
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);
});

test("empty insert draft does not invoke insert_row", async () => {
  const { editor, tab, invokeCalls } = createEditor();

  const inserted = await editor.commitInsertRow(tab);

  assert.equal(inserted, false);
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
});

test("successful insert commits draft and clears it", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor();

  editor.updateInsertDraft(tab, "name", "Dana");
  const inserted = await editor.commitInsertRow(tab);

  assert.equal(inserted, true);
  assert.deepEqual(invokeCalls.at(-1), {
    command: "insert_row",
    payload: { request: { sessionId: "session-1", draft: { name: "Dana" } } },
  });
  assert.deepEqual(editor.getInsertDraft(tab), {});
  assert.equal(statusText.value, "已插入 1 行");
});

test("copying selected rows writes header and row TSV", async () => {
  const { editor, tab, clipboard } = createEditor();

  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[2]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(clipboard.text, "name\tlevel\tguild\nAlice\t10\tRed\nCara\t14\tGreen");
});

test("copying a selected range writes TSV to the clipboard", async () => {
  const { editor, tab, clipboard } = createEditor();

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();

  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(clipboard.text, "Alice\t10\nBob\t12");
});

test("pasting TSV commits multiple cells from the selected range anchor", async () => {
  const clipboard = { text: "Ann\t20\nBen\t21", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls, statusText } = createEditor({ clipboard });

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(invokeCalls.filter((call) => call.command === "update_cell").length, 4);
  assert.equal(tab.rows[0].name, "Ann");
  assert.equal(tab.rows[1].level, "21");
  assert.equal(statusText.value, "已粘贴 4 个单元格");
});
