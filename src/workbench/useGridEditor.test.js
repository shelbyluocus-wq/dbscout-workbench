import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { computed, nextTick, reactive } from "vue";
import { createEditState, getCellError } from "./editState.js";
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
    readOnly: Boolean(options.readOnly),
    columns: options.columns || [{ column_name: "name" }, { column_name: "level" }, { column_name: "guild" }],
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
  const saveFeedback = [];
  const committedCells = [];
  const editState = reactive(createEditState());
  const invokeWorkbench = options.invokeWorkbench || (() => ({}));
  const editor = useGridEditor(
    editState,
    async (command, payload) => {
      invokeCalls.push({ command, payload });
      return invokeWorkbench(command, payload);
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
      scrollInsertCellIntoView(columnIndex, rowIndex = null) {
        scrollCalls.push(["insert", columnIndex, rowIndex]);
      },
    },
    {
      busy: { value: false },
      statusText,
      onSaveFeedback: (feedback) => saveFeedback.push(feedback),
      onCellCommitted: (event) => committedCells.push(event),
    },
  );
  return { editor, tab, editState, focused, input, insertInput, clipboard, scrollCalls, invokeCalls, statusText, gridWrapRef, saveFeedback, committedCells };
}

test("editing an integer cell to text is rejected before backend save", async () => {
  const { editor, tab, invokeCalls, statusText, saveFeedback } = createEditor({
    columns: [{ column_name: "id", column_type: "int", is_primary_key: true }, { column_name: "level", column_type: "int" }],
  });

  await editor.commitCellValue(tab, tab.rows[0], "level", "abc");

  assert.equal(tab.rows[0].level, "10");
  assert.equal(invokeCalls.length, 0);
  assert.match(statusText.value, /level/);
  assert.equal(saveFeedback.at(-1).message, "整数格式错误");
});

test("committing null on a nullable column sends NULL and stores null (#5)", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true },
      { column_name: "guild", column_type: "varchar(32)", is_nullable: true },
    ],
  });

  await editor.commitCellValue(tab, tab.rows[0], "guild", null);

  // null is preserved in the row (not collapsed to "") and sent as JSON null.
  assert.equal(tab.rows[0].guild, null);
  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].command, "update_cell");
  assert.equal(invokeCalls[0].payload.request.newValue, null);
});

test("committing null on a NOT NULL column is rejected before backend save (#5)", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true },
      { column_name: "level", column_type: "int", is_nullable: false },
    ],
  });
  const original = tab.rows[0].level;

  await editor.commitCellValue(tab, tab.rows[0], "level", null);

  assert.equal(tab.rows[0].level, original);
  assert.equal(invokeCalls.length, 0);
});

test("committing an explicit empty string on a NOT NULL varchar column is allowed (#5)", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true },
      { column_name: "guild", column_type: "varchar(32)", is_nullable: false },
    ],
  });

  await editor.commitCellValue(tab, tab.rows[0], "guild", "");

  assert.equal(tab.rows[0].guild, "");
  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].payload.request.newValue, "");
});

test("focusing a cell with a validation error clears that stale error", async () => {
  const { editor, tab, editState } = createEditor({
    columns: [{ column_name: "id", column_type: "int", is_primary_key: true }, { column_name: "level", column_type: "int" }],
  });
  const row = tab.rows[0];
  const rowKey = buildRowKey(tab, row);

  await editor.commitCellValue(tab, row, "level", "abc");
  assert.ok(getCellError(editState, "player", rowKey, "level"));

  editor.focusTextCell(tab, row, "level");

  assert.equal(getCellError(editState, "player", rowKey, "level"), "");
});

test("starting to edit a cell with a validation error clears that stale error", async () => {
  const { editor, tab, editState } = createEditor({
    columns: [{ column_name: "id", column_type: "int", is_primary_key: true }, { column_name: "level", column_type: "int" }],
  });
  const row = tab.rows[0];
  const rowKey = buildRowKey(tab, row);

  await editor.commitCellValue(tab, row, "level", "abc");
  assert.ok(getCellError(editState, "player", rowKey, "level"));

  editor.startEditing(tab, row, "level", 0, 1);

  assert.equal(getCellError(editState, "player", rowKey, "level"), "");
});

test("inserting a row with an invalid integer keeps the draft and skips insert_row", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor({
    columns: [{ column_name: "id", column_type: "int", is_primary_key: true }, { column_name: "level", column_type: "int", is_nullable: false }],
  });
  editor.updateInsertDraft(tab, "id", "4");
  editor.updateInsertDraft(tab, "level", "abc");

  const result = await editor.commitInsertRows(tab);

  assert.equal(result.insertedRows, 0);
  assert.equal(invokeCalls.length, 0);
  assert.match(statusText.value, /level/);
  assert.equal(editor.getInsertRows(tab)[0].draft.level, "abc");
});

test("insert cells use the ordinary selected cell and range model", async () => {
  const { editor, tab, clipboard } = createEditor({
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }, { column_name: "level" }],
  });

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  const rowKey = editor.getInsertRowKey(tab, rowId);
  editor.updateInsertDraft(tab, rowId, "id", "9");
  editor.updateInsertDraft(tab, rowId, "name", "Dana");
  editor.handleInsertKeydown(tab, rowId, 0, { key: "ArrowRight", shiftKey: true });

  assert.deepEqual(editor.selectedCell.value, { tabId: tab.id, rowKey, column: "name" });
  assert.equal(editor.isCellInSelectedRange(tab, rowKey, "id", tab.rows.length, 0), true);
  assert.equal(editor.isCellInSelectedRange(tab, rowKey, "name", tab.rows.length, 1), true);

  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(clipboard.text, "9\tDana");
});

test("copying a selected cell emits visible copy feedback", async () => {
  const clipboard = { text: "", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, saveFeedback, statusText } = createEditor({ clipboard });

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(clipboard.text, "Alice");
  assert.equal(statusText.value, "复制成功");
  assert.deepEqual(saveFeedback.at(-1), {
    kind: "copy",
    tabId: tab.id,
    rowKey: buildRowKey(tab, tab.rows[0]),
    column: "name",
    message: "复制成功",
  });
});

test("insert row validation errors are anchored to the failing insert cell", async () => {
  const { editor, tab, editState, invokeCalls, statusText } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "name", column_type: "varchar(32)", is_nullable: false },
    ],
  });

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  const rowKey = editor.getInsertRowKey(tab, rowId);
  editor.updateInsertDraft(tab, rowId, "id", "9");

  const result = await editor.commitInsertRows(tab);

  assert.deepEqual(result, { insertedRows: 0, failedRowId: rowId, failedReason: "字段 name 不能为空" });
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
  assert.equal(statusText.value, "字段 name 不能为空");
  assert.equal(getCellError(editState, "player", rowKey, "name"), "字段 name 不能为空");
  assert.deepEqual(editor.selectedCell.value, { tabId: tab.id, rowKey, column: "name" });
});

test("inserting a row preserves explicit empty strings for non-null varchar columns", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "name", column_type: "varchar(32)", is_nullable: false },
      { column_name: "dsc", column_type: "varchar(255)", is_nullable: false },
    ],
  });

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "id", "9");
  editor.updateInsertDraft(tab, rowId, "name", "Dana");
  editor.updateInsertDraft(tab, rowId, "dsc", "");

  const result = await editor.commitInsertRows(tab);

  assert.deepEqual(result, { insertedRows: 1, failedRowId: null });
  const insertCall = invokeCalls.find((call) => call.command === "insert_row");
  assert.deepEqual(insertCall.payload.request.draft, { id: "9", name: "Dana", dsc: "" });
});

test("insert backend failures keep the draft and report the concrete reason", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "name", column_type: "varchar(32)", is_nullable: false },
    ],
    invokeWorkbench: async () => {
      throw new Error("Duplicate entry '9' for key 'PRIMARY'");
    },
  });

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "id", "9");
  editor.updateInsertDraft(tab, rowId, "name", "Dana");

  const result = await editor.commitInsertRows(tab);

  assert.deepEqual(result, {
    insertedRows: 0,
    failedRowId: rowId,
    failedReason: "Duplicate entry '9' for key 'PRIMARY'",
  });
  assert.deepEqual(editor.getInsertDraft(tab, rowId), { id: "9", name: "Dana" });
  assert.equal(invokeCalls.filter((call) => call.command === "insert_row").length, 1);
  assert.equal(statusText.value, "插入失败：Duplicate entry '9' for key 'PRIMARY'");
});

test("pasting invalid values into existing cells skips invalid cells and saves valid cells", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor({
    columns: [{ column_name: "id", column_type: "int", is_primary_key: true }, { column_name: "level", column_type: "int" }],
    clipboard: { text: "11\nbad", async writeText(text) { this.text = text; }, async readText() { return this.text; } },
  });
  editor.selectCell(tab, tab.rows[0], "level", 0, 1);

  await editor.handleGridKeydown({ key: "v", ctrlKey: true, preventDefault() {} });

  assert.equal(tab.rows[0].level, "11");
  assert.equal(tab.rows[1].level, "12");
  assert.equal(invokeCalls.filter((call) => call.command === "update_cell").length, 1);
  assert.match(statusText.value, /1/);
});

test("editing a primary key to an existing loaded row is rejected before backend save", async () => {
  const { editor, tab, invokeCalls, statusText, saveFeedback } = createEditor({
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
    ],
  });

  await editor.commitCellValue(tab, tab.rows[0], "id", "2");

  assert.equal(tab.rows[0].id, "1");
  assert.equal(invokeCalls.length, 0);
  assert.ok(statusText.value);
  assert.deepEqual(saveFeedback.at(-1), {
    kind: "error",
    tabId: tab.id,
    rowKey: buildRowKey(tab, tab.rows[0]),
    column: "id",
    message: "主键重复",
  });
});

test("single click selects a cell without entering edit mode", async () => {
  const { editor, tab } = createEditor();

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await nextTick();

  assert.equal(editor.selectedCell.value.column, "name");
  assert.equal(editor.editingCell.value, null);
});

test("read-only tabs do not enter editing mode or save updated cells", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor({ readOnly: true });

  editor.startEditing(tab, tab.rows[0], "name", 0, 0);
  await nextTick();
  await editor.commitCellValue(tab, tab.rows[0], "name", "Ava");

  assert.equal(editor.editingCell.value, null);
  assert.equal(tab.rows[0].name, "Alice");
  assert.equal(invokeCalls.some((call) => call.command === "update_cell"), false);
  assert.match(statusText.value, /只读|read-only/i);
});

test("read-only tabs do not expose insert drafts or call insert_row", async () => {
  const { editor, tab, invokeCalls } = createEditor({ readOnly: true });

  editor.selectInsertCell(tab, 0);
  editor.updateInsertDraft(tab, "insert-1", "name", "Dana");
  const result = await editor.commitInsertRows(tab);

  assert.equal(editor.isInsertRowVisible(tab), false);
  assert.equal(editor.selectedInsertCell.value, null);
  assert.deepEqual(result, { insertedRows: 0, failedRowId: null });
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
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

test("typing a printable key starts editing with a single initial character", async () => {
  const { editor, tab, input } = createEditor();
  let prevented = false;
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await nextTick();

  await editor.handleGridKeydown({
    key: "x",
    preventDefault() { prevented = true; },
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  });
  await nextTick();

  assert.equal(prevented, true);
  assert.equal(editor.editingCell.value.column, "name");
  assert.equal(editor.editDraft.value, "x");
  assert.equal(editor.textDraft.value, "x");
  assert.equal(input.focused, true);
});

test("ArrowLeft/ArrowRight move the caret instead of navigating while editing (#4)", async () => {
  const { editor, tab, scrollCalls } = createEditor();
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await nextTick();
  editor.startEditing(tab, tab.rows[0], "name", 0, 0);
  await nextTick();

  // Editing must still be active, and neither arrow should commit + navigate.
  await editor.handleGridKeydown({ key: "ArrowLeft", shiftKey: false, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });
  await editor.handleGridKeydown({ key: "ArrowRight", shiftKey: false, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.equal(editor.editingCell.value?.column, "name");
  assert.deepEqual(scrollCalls, []);
});

test("ArrowUp/ArrowDown still commit the edit and navigate while editing", async () => {
  const { editor, tab } = createEditor();
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await nextTick();
  editor.startEditing(tab, tab.rows[0], "name", 0, 0);
  await nextTick();

  await editor.handleGridKeydown({ key: "ArrowDown", shiftKey: false, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.equal(editor.editingCell.value, null);
  assert.equal(editor.selectedCell.value.rowKey, buildRowKey(tab, tab.rows[1]));
});

test("clicking the editing cell keeps edit mode so the caret can be repositioned", async () => {
  // 回归：双击进入编辑后，再点击同一个单元格应保持光标态（切换光标位置），
  // 而非把编辑态打回选中态。
  const { editor, tab, input } = createEditor();
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await nextTick();
  editor.startEditing(tab, tab.rows[0], "name", 0, 0);
  await nextTick();
  assert.equal(editor.editingCell.value?.column, "name");
  assert.equal(input.focused, true);

  // mousedown 落在编辑中的同一单元格：不应结束编辑、不应 preventDefault（输入框需拿焦点）。
  let prevented = false;
  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, "mousedown on the editing cell must not preventDefault");
  assert.equal(editor.editingCell.value?.column, "name", "edit mode must survive mousedown on the same cell");

  // 随后的 click 也不应结束编辑或抢走焦点。
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  assert.equal(editor.editingCell.value?.column, "name", "edit mode must survive click on the same cell");
  assert.equal(input.focused, true, "input must keep focus so the caret can be repositioned");
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

test("plain cell selection keeps an empty unsaved insert row visible", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.selectCell(tab, tab.rows[1], "level", 1, 1);
  await nextTick();

  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.equal(editor.selectedInsertCell.value, null);
  assert.equal(editor.selectedCell.value.column, "level");
  assert.equal(editor.getInsertRows(tab).some((row) => row.id === rowId), true);
  assert.deepEqual(editor.getInsertDraft(tab, rowId), {});
});

test("plain cell selection keeps insert drafts visible", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "name", "Dana");
  editor.selectCell(tab, tab.rows[1], "level", 1, 1);
  await nextTick();

  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.equal(editor.selectedInsertCell.value, null);
  assert.equal(editor.selectedCell.value.column, "level");
  assert.deepEqual(editor.getInsertDraft(tab, rowId), { name: "Dana" });
});

test("insert above does not reveal a hidden trailing insert draft", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const trailingRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, trailingRowId, "name", "Dana");
  editor.hideInsertRow(tab, { preserveDrafts: true });

  editor.insertDraftAbove(tab, 1);

  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.deepEqual(editor.getVisibleInsertRows(tab).map((row) => row.id), [editor.selectedInsertCell.value.rowId]);
  assert.equal(editor.getVisibleInsertRows(tab)[0].anchorIndex, 1);
  assert.equal(editor.getInsertRows(tab).some((row) => row.id === trailingRowId), true);
  assert.deepEqual(editor.getInsertDraft(tab, trailingRowId), { name: "Dana" });
});

test("selecting an anchored insert cell does not create a trailing insert row", async () => {
  const { editor, tab } = createEditor();

  editor.insertDraftAbove(tab, 1);
  const anchoredRowId = editor.selectedInsertCell.value.rowId;
  const anchoredRowObject = { name: "", level: "", guild: "", __insertRowId: anchoredRowId };

  editor.selectCell(tab, anchoredRowObject, "name", 1, 0);
  await nextTick();

  assert.deepEqual(editor.getVisibleInsertRows(tab).map((row) => row.id), [anchoredRowId]);
  assert.equal(editor.getInsertRows(tab).filter((row) => row.anchorIndex == null).length, 0);
});

test("removing an anchored insert draft compacts visual row indexes", async () => {
  const { editor, tab } = createEditor();

  editor.insertDraftAbove(tab, 2);
  const anchoredRowId = editor.selectedInsertCell.value.rowId;

  assert.deepEqual(editor.visualRowEntries(tab).map((entry) => entry.type === "insert" ? `insert:${entry.rowId}` : entry.row.id), [
    "1",
    "2",
    `insert:${anchoredRowId}`,
    "3",
  ]);

  editor.clearInsertDraft(tab, anchoredRowId);

  assert.deepEqual(editor.visualRowEntries(tab).map((entry) => entry.type === "insert" ? `insert:${entry.rowId}` : entry.row.id), [
    "1",
    "2",
    "3",
  ]);
  assert.deepEqual(
    tab.rows.map((_, index) => editor.insertAwareVisualRowIndex(tab, index) + 1),
    [1, 2, 3],
  );
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

test("arrow key navigation stops at horizontal cell boundaries", async () => {
  const { editor, tab, scrollCalls } = createEditor();
  const firstRowKey = buildRowKey(tab, tab.rows[0]);

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "ArrowLeft", shiftKey: false, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.deepEqual(editor.selectedCell.value, { tabId: tab.id, rowKey: firstRowKey, column: "name" });
  assert.deepEqual(scrollCalls, []);

  editor.selectCell(tab, tab.rows[0], "guild", 0, 2);
  await editor.handleGridKeydown({ key: "ArrowRight", shiftKey: false, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.deepEqual(editor.selectedCell.value, { tabId: tab.id, rowKey: firstRowKey, column: "guild" });
  assert.deepEqual(scrollCalls, []);
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

function navEvent(key, mods = {}) {
  return { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, ...mods };
}

test("Ctrl+ArrowRight/ArrowDown jump to the last column/row edge", async () => {
  const { editor, tab } = createEditor();

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown(navEvent("ArrowRight", { ctrlKey: true }));
  assert.equal(editor.selectedCell.value.column, "guild");
  assert.equal(editor.selectedCell.value.rowKey, buildRowKey(tab, tab.rows[0]));

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown(navEvent("ArrowDown", { ctrlKey: true }));
  assert.equal(editor.selectedCell.value.rowKey, buildRowKey(tab, tab.rows[2]));
  assert.equal(editor.selectedCell.value.column, "name");
});

test("Ctrl+Home/Ctrl+End jump to the top-left and bottom-right cells", async () => {
  const { editor, tab } = createEditor();

  editor.selectCell(tab, tab.rows[1], "level", 1, 1);
  await editor.handleGridKeydown(navEvent("Home", { ctrlKey: true }));
  assert.equal(editor.selectedCell.value.rowKey, buildRowKey(tab, tab.rows[0]));
  assert.equal(editor.selectedCell.value.column, "name");

  await editor.handleGridKeydown(navEvent("End", { ctrlKey: true }));
  assert.equal(editor.selectedCell.value.rowKey, buildRowKey(tab, tab.rows[2]));
  assert.equal(editor.selectedCell.value.column, "guild");
});

test("Home/End move to row start/end, and Shift+End extends the range", async () => {
  const { editor, tab } = createEditor();

  editor.selectCell(tab, tab.rows[0], "level", 0, 1);
  await editor.handleGridKeydown(navEvent("End"));
  assert.equal(editor.selectedCell.value.column, "guild");

  await editor.handleGridKeydown(navEvent("Home"));
  assert.equal(editor.selectedCell.value.column, "name");

  await editor.handleGridKeydown(navEvent("End", { shiftKey: true }));
  assert.equal(editor.selectedRange.value.anchor.columnIndex, 0);
  assert.equal(editor.selectedRange.value.focus.columnIndex, 2);
});

test("Ctrl+A selects the entire data region", async () => {
  const { editor, tab } = createEditor();

  editor.selectCell(tab, tab.rows[1], "level", 1, 1);
  await editor.handleGridKeydown(navEvent("a", { ctrlKey: true }));

  const range = editor.selectedRange.value;
  assert.equal(range.anchor.rowIndex, 0);
  assert.equal(range.anchor.columnIndex, 0);
  assert.equal(range.focus.rowIndex, 2);
  assert.equal(range.focus.columnIndex, 2);
});

test("Delete clears a text cell to an empty string, not NULL", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true },
      { column_name: "guild", column_type: "varchar(32)", is_nullable: true },
    ],
  });

  editor.selectCell(tab, tab.rows[0], "guild", 0, 1);
  await editor.handleGridKeydown(navEvent("Delete"));

  assert.equal(tab.rows[0].guild, "");
  assert.equal(invokeCalls.at(-1).payload.request.newValue, "");
});

test("Delete on a nullable non-text cell writes NULL", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true },
      { column_name: "level", column_type: "int", is_nullable: true },
    ],
  });

  editor.selectCell(tab, tab.rows[0], "level", 0, 1);
  await editor.handleGridKeydown(navEvent("Delete"));

  assert.equal(tab.rows[0].level, null);
  assert.equal(invokeCalls.at(-1).payload.request.newValue, null);
});

test("Delete on a NOT NULL non-text cell leaves the value untouched", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true },
      { column_name: "level", column_type: "int", is_nullable: false },
    ],
  });
  const original = tab.rows[0].level;

  editor.selectCell(tab, tab.rows[0], "level", 0, 1);
  await editor.handleGridKeydown(navEvent("Delete"));

  assert.equal(tab.rows[0].level, original);
  assert.equal(invokeCalls.length, 0);
});

test("Delete clears every cell in a multi-cell selection", async () => {
  const { editor, tab } = createEditor({
    columns: [
      { column_name: "name", column_type: "varchar(32)", is_nullable: true },
      { column_name: "level", column_type: "varchar(32)", is_nullable: true },
      { column_name: "guild", column_type: "varchar(32)", is_nullable: true },
    ],
  });

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();

  await editor.handleGridKeydown(navEvent("Delete"));

  assert.equal(tab.rows[0].name, "");
  assert.equal(tab.rows[0].level, "");
  assert.equal(tab.rows[1].name, "");
  assert.equal(tab.rows[1].level, "");
  assert.equal(tab.rows[0].guild, "Red");
});


test("selecting the insert row clears cell and range selection", async () => {
  const { editor, tab, focused } = createEditor();

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();
  editor.selectInsertRow(tab);
  await nextTick();

  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.equal(editor.selectedCell.value, null);
  assert.equal(editor.selectedRange.value, null);
  assert.equal(editor.selectedInsertCell.value, null);
  assert.equal(editor.selectedInsertRow.value.tabId, tab.id);
  assert.match(editor.selectedInsertRow.value.rowId, /^insert-/);
  assert.equal(focused.count > 0, true);
});

test("ArrowDown from the last data row reveals and focuses the insert row", async () => {
  const { editor, tab, insertInput, scrollCalls } = createEditor();

  assert.equal(editor.isInsertRowVisible(tab), false);

  editor.selectCell(tab, tab.rows[2], "level", 2, 1);
  await editor.handleGridKeydown({ key: "ArrowDown", shiftKey: false, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });
  await nextTick();

  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.equal(editor.selectedInsertRow.value, null);
  assert.equal(editor.selectedInsertCell.value.tabId, tab.id);
  assert.match(editor.selectedInsertCell.value.rowId, /^insert-/);
  assert.deepEqual(editor.selectedCell.value, {
    tabId: tab.id,
    rowKey: editor.getInsertRowKey(tab, editor.selectedInsertCell.value.rowId),
    column: "level",
  });
  assert.equal(editor.selectedInsertCell.value.columnIndex, 1);
  assert.equal(editor.selectedInsertCell.value.column, "level");
  assert.deepEqual(scrollCalls.at(-1), ["insert", 1, 3]);
  assert.equal(insertInput.focused, true);
});

test("ArrowUp from the first insert row returns to data without collapsing insert drafts", async () => {
  const { editor, tab, focused, scrollCalls } = createEditor();

  editor.selectInsertCell(tab, 2);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "guild", "Gold");
  editor.handleInsertKeydown(tab, rowId, 2, { key: "ArrowUp" });
  await nextTick();

  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.equal(editor.selectedInsertCell.value, null);
  assert.equal(editor.selectedCell.value.rowKey, buildRowKey(tab, tab.rows[2]));
  assert.equal(editor.selectedCell.value.column, "guild");
  assert.deepEqual(editor.getInsertDraft(tab, rowId), { guild: "Gold" });
  assert.deepEqual(scrollCalls.at(-1), [2, 2]);
  assert.equal(focused.count > 0, true);

  await editor.handleGridKeydown({ key: "ArrowUp", shiftKey: false, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.deepEqual(editor.getInsertDraft(tab, rowId), { guild: "Gold" });
});

test("Escape from the insert row hides it and clears the draft", async () => {
  const { editor, tab, focused } = createEditor();

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "name", "Dana");
  editor.handleInsertKeydown(tab, rowId, 0, { key: "Escape" });
  await nextTick();

  assert.equal(editor.isInsertRowVisible(tab), false);
  assert.equal(editor.selectedInsertCell.value, null);
  assert.deepEqual(editor.getInsertDraft(tab), {});
  assert.equal(focused.count > 0, true);
});

test("Escape on a selected insert cell removes that unsaved row", async () => {
  const { editor, tab } = createEditor();

  editor.insertDraftAbove(tab, 2);
  const rowId = editor.selectedInsertCell.value.rowId;

  await editor.handleGridKeydown({ key: "Escape", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.equal(editor.getInsertRows(tab).some((row) => row.id === rowId), false);
  assert.equal(editor.isInsertRowVisible(tab), false);
  assert.equal(editor.selectedCell.value, null);
  assert.deepEqual(
    tab.rows.map((_, index) => editor.insertAwareVisualRowIndex(tab, index) + 1),
    [1, 2, 3],
  );
});

test("Delete on a selected insert row removes that unsaved row", async () => {
  const { editor, tab } = createEditor();

  editor.insertDraftAbove(tab, 1);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.selectInsertRow(tab, rowId);

  await editor.handleGridKeydown({ key: "Delete", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.equal(editor.getInsertRows(tab).some((row) => row.id === rowId), false);
  assert.equal(editor.isInsertRowVisible(tab), false);
  assert.equal(editor.selectedInsertRow.value, null);
  assert.deepEqual(
    tab.rows.map((_, index) => editor.insertAwareVisualRowIndex(tab, index) + 1),
    [1, 2, 3],
  );
});

test("insert row keyboard navigation moves between insert inputs", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 1);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.handleInsertKeydown(tab, rowId, 1, { key: "Tab", shiftKey: false });
  assert.equal(editor.selectedInsertCell.value.rowId, rowId);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 2);

  editor.handleInsertKeydown(tab, rowId, 2, { key: "ArrowLeft" });
  assert.equal(editor.selectedInsertCell.value.rowId, rowId);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 1);

  editor.handleInsertKeydown(tab, rowId, 1, { key: "Tab", shiftKey: true });
  assert.equal(editor.selectedInsertCell.value.rowId, rowId);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);
});

test("Tab from a filled trailing insert row does not append another row", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.startEditing(tab, { __insertRowId: rowId }, "name", tab.rows.length, 0);
  editor.editDraft.value = "Dana";

  editor.handleInsertKeydown(tab, rowId, 0, { key: "Tab", shiftKey: false });

  assert.deepEqual(editor.getVisibleInsertRows(tab).map((row) => row.id), [rowId]);
  assert.deepEqual(editor.getInsertDraft(tab, rowId), { name: "Dana" });
  assert.equal(editor.selectedInsertCell.value.rowId, rowId);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 1);
});

test("typing on a selected insert cell starts ordinary inline editing", async () => {
  const { editor, tab, input } = createEditor();

  editor.selectInsertCell(tab, 1);
  await editor.handleGridKeydown({ key: "D", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });
  await nextTick();

  assert.deepEqual(editor.editingCell.value, {
    tabId: tab.id,
    rowKey: editor.getInsertRowKey(tab, editor.selectedInsertCell.value.rowId),
    column: "level",
  });
  assert.equal(editor.editDraft.value, "D");
  assert.equal(input.focused, true);
});

test("focusing the active insert input keeps insert editing open", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 1);
  await editor.handleGridKeydown({ key: "D", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });
  const rowId = editor.selectedInsertCell.value.rowId;

  editor.selectInsertCell(tab, rowId, 1);

  assert.deepEqual(editor.editingCell.value, {
    tabId: tab.id,
    rowKey: editor.getInsertRowKey(tab, rowId),
    column: "level",
  });
  assert.equal(editor.editDraft.value, "D");
  assert.deepEqual(editor.getInsertDraft(tab, rowId), {});
});

test("Enter in an anchored insert cell keeps the draft at its anchor", async () => {
  const { editor, tab, scrollCalls } = createEditor();

  editor.insertDraftAbove(tab, 1);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.startEditing(tab, { __insertRowId: rowId }, "level", 1, 1);
  editor.editDraft.value = "9";

  editor.finishEditing();
  editor.navigateCell(1, 0);

  assert.deepEqual(editor.getInsertDraft(tab, rowId), { level: "9" });
  assert.deepEqual(editor.selectedCell.value, {
    tabId: tab.id,
    rowKey: buildRowKey(tab, tab.rows[1]),
    column: "level",
  });
  assert.deepEqual(scrollCalls.at(-1), [2, 1]);
});

test("Escape from an editing insert cell clears the ordinary editing state", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 1);
  await editor.handleGridKeydown({ key: "D", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });
  const rowId = editor.selectedInsertCell.value.rowId;

  editor.handleInsertKeydown(tab, rowId, 1, { key: "Escape" });

  assert.equal(editor.editingCell.value, null);
  assert.equal(editor.isInsertRowVisible(tab), false);
});

test("editing the last insert row keeps only the current temporary insert row", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");

  assert.equal(editor.getInsertRows(tab).length, 1);
  assert.equal(editor.getInsertDraft(tab, firstRowId).name, "Dana");
});

test("ArrowDown from an insert row moves into the next temporary insert row", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  editor.handleInsertKeydown(tab, firstRowId, 0, { key: "ArrowDown" });

  assert.notEqual(editor.selectedInsertCell.value.rowId, firstRowId);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);
});

test("ArrowDown from an empty insert row appends another temporary insert row each time", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  assert.equal(editor.getInsertRows(tab).length, 1);

  editor.handleInsertKeydown(tab, firstRowId, 0, { key: "ArrowDown" });
  const secondRowId = editor.selectedInsertCell.value.rowId;

  assert.notEqual(secondRowId, firstRowId);
  assert.equal(editor.getInsertRows(tab).length, 2);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);

  editor.handleInsertKeydown(tab, secondRowId, 0, { key: "ArrowDown" });

  assert.equal(editor.getInsertRows(tab).length, 3);
  assert.equal(editor.selectedInsertCell.value.rowId, editor.getInsertRows(tab)[2].id);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);
});

test("ArrowDown from a selected trailing insert cell appends another temporary insert row", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  assert.equal(editor.editingCell.value, null);

  await editor.handleGridKeydown({ key: "ArrowDown", shiftKey: false, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.equal(editor.getVisibleInsertRows(tab).length, 2);
  assert.equal(editor.selectedInsertCell.value.rowId, editor.getVisibleInsertRows(tab)[1].id);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);
});

test("removing one empty trailing insert row keeps the other temporary insert rows", () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.handleInsertKeydown(tab, firstRowId, 0, { key: "ArrowDown" });
  const secondRowId = editor.selectedInsertCell.value.rowId;
  editor.handleInsertKeydown(tab, secondRowId, 0, { key: "ArrowDown" });
  const thirdRowId = editor.selectedInsertCell.value.rowId;

  editor.removeInsertDraftRow(tab, secondRowId);

  assert.deepEqual(editor.getVisibleInsertRows(tab).map((row) => row.id), [firstRowId, thirdRowId]);
});

test("ArrowDown from the last data row enters the first existing trailing insert row", () => {
  const { editor, tab, scrollCalls } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  editor.handleInsertKeydown(tab, firstRowId, 0, { key: "ArrowDown" });
  const secondRowId = editor.selectedInsertCell.value.rowId;
  editor.handleInsertKeydown(tab, secondRowId, 0, { key: "ArrowDown" });
  const thirdRowId = editor.selectedInsertCell.value.rowId;
  editor.selectCell(tab, tab.rows.at(-1), "name", 2, 0);

  editor.navigateCell(1, 0);

  assert.deepEqual(editor.getVisibleInsertRows(tab).map((row) => row.id), [firstRowId, secondRowId, thirdRowId]);
  assert.equal(editor.selectedInsertCell.value.rowId, firstRowId);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);
  assert.deepEqual(scrollCalls.at(-1), ["insert", 0, 3]);
});

test("clearing all insert drafts removes stale insert selection state", () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "name", "Dana");

  editor.clearInsertDraft(tab);

  assert.equal(editor.getVisibleInsertRows(tab).length, 0);
  assert.equal(editor.selectedInsertCell.value, null);
  assert.equal(editor.selectedInsertRow.value, null);
  assert.equal(editor.selectedCell.value, null);
  assert.equal(editor.selectedRange.value, null);
});

test("empty insert draft does not invoke insert_row", async () => {
  const { editor, tab, invokeCalls } = createEditor();

  const inserted = await editor.commitInsertRow(tab);

  assert.equal(inserted, false);
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
});

test("successful insert commits draft and clears it", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor();

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "name", "Dana");
  const inserted = await editor.commitInsertRow(tab, rowId);

  assert.equal(inserted, true);
  assert.deepEqual(invokeCalls.at(-1), {
    command: "insert_row",
    payload: { request: { sessionId: "session-1", draft: { name: "Dana" } } },
  });
  assert.deepEqual(editor.getInsertRows(tab), []);
  assert.equal(editor.isInsertRowVisible(tab), false);
  assert.match(statusText.value, /1/);
});

test("saving an anchored insert draft selected from insert above commits that draft", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, extra: "auto_increment" },
      { column_name: "name", column_type: "varchar" },
    ],
  });

  editor.insertDraftAbove(tab, 1);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.startEditing(tab, { __insertRowId: rowId }, "name", 1, 1);
  editor.editDraft.value = "Dana";

  const result = await editor.handleGridKeydown({ key: "s", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(result, { insertedRows: 1, failedRowId: null });
  assert.deepEqual(invokeCalls.filter((call) => call.command === "insert_row"), [
    { command: "insert_row", payload: { request: { sessionId: "session-1", draft: { name: "Dana" } } } },
  ]);
  assert.equal(editor.getVisibleInsertRows(tab).length, 0);
});

test("saving insert drafts commits all non-empty temporary rows", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  editor.updateInsertDraft(tab, firstRowId, "level", "20");
  editor.handleInsertKeydown(tab, firstRowId, 0, { key: "ArrowDown" });
  const secondRowId = editor.getInsertRows(tab)[1].id;
  editor.updateInsertDraft(tab, secondRowId, "name", "Eli");
  editor.updateInsertDraft(tab, secondRowId, "guild", "Silver");

  const result = await editor.commitInsertRows(tab);

  assert.deepEqual(result, { insertedRows: 2, failedRowId: null });
  assert.deepEqual(invokeCalls.filter((call) => call.command === "insert_row"), [
    { command: "insert_row", payload: { request: { sessionId: "session-1", draft: { name: "Dana", level: "20" } } } },
    { command: "insert_row", payload: { request: { sessionId: "session-1", draft: { name: "Eli", guild: "Silver" } } } },
  ]);
  assert.equal(editor.isInsertRowVisible(tab), false);
  assert.deepEqual(editor.getInsertRows(tab), []);
  assert.match(statusText.value, /2/);
});

test("Ctrl+S saves all visible insert drafts", async () => {
  const { editor, tab, invokeCalls } = createEditor();
  let prevented = false;

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  editor.handleInsertKeydown(tab, firstRowId, 0, { key: "ArrowDown" });
  const secondRowId = editor.getInsertRows(tab)[1].id;
  editor.updateInsertDraft(tab, secondRowId, "name", "Eli");

  const result = await editor.handleGridKeydown({
    key: "s",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(result, { insertedRows: 2, failedRowId: null });
  assert.equal(invokeCalls.filter((call) => call.command === "insert_row").length, 2);
});

test("Ctrl+S saves the editing cell and emits save feedback", async () => {
  const { editor, tab, invokeCalls, saveFeedback } = createEditor();
  let prevented = false;
  editor.startEditing(tab, tab.rows[0], "name", 0, 0);
  editor.editDraft.value = "Axel";
  editor.textDraft.value = "Axel";

  await editor.handleGridKeydown({
    key: "s",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    preventDefault() { prevented = true; },
  });

  assert.equal(prevented, true);
  assert.equal(editor.editingCell.value, null);
  assert.equal(tab.rows[0].name, "Axel");
  assert.equal(invokeCalls.filter((call) => call.command === "update_cell").length, 1);
  assert.deepEqual(saveFeedback.at(-1), {
    kind: "success",
    tabId: "tab-1",
    rowKey: "name=Alice&level=10&guild=Red",
    column: "name",
    message: saveFeedback.at(-1).message,
  });
});

test("successful cell commits notify callers with source tab and row identity", async () => {
  const { editor, tab, committedCells } = createEditor();

  await editor.commitCellValue(tab, tab.rows[0], "name", "Ava");

  assert.deepEqual(committedCells, [{
    tab,
    rowKey: "name=Alice&level=10&guild=Red",
    column: "name",
    oldValue: "Alice",
    newValue: "Ava",
  }]);
});

test("saving insert drafts stops at a duplicate primary key and keeps the failed draft", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor({
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }],
  });

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "id", "9");
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  editor.handleInsertKeydown(tab, firstRowId, 0, { key: "ArrowDown" });
  const secondRowId = editor.getInsertRows(tab)[1].id;
  editor.updateInsertDraft(tab, secondRowId, "id", "1");
  editor.updateInsertDraft(tab, secondRowId, "name", "Duplicate Alice");

  const result = await editor.commitInsertRows(tab);

  assert.deepEqual(result, { insertedRows: 1, failedRowId: secondRowId, failedReason: "主键重复，不能保存" });
  assert.deepEqual(invokeCalls.filter((call) => call.command === "insert_row"), [
    { command: "insert_row", payload: { request: { sessionId: "session-1", draft: { id: "9", name: "Dana" } } } },
  ]);
  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.deepEqual(editor.getInsertDraft(tab, secondRowId), { id: "1", name: "Duplicate Alice" });
  assert.ok(statusText.value);
});

test("saving insert drafts checks tab primary keys when column metadata is camelCase", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor({
    columns: [{ columnName: "id", isPrimaryKey: true }, { columnName: "name" }],
  });
  tab.primaryKeys = ["id"];

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "id", "1");
  editor.updateInsertDraft(tab, rowId, "name", "Duplicate Alice");
  const result = await editor.commitInsertRows(tab);

  assert.deepEqual(result, { insertedRows: 0, failedRowId: rowId, failedReason: "主键重复，不能保存" });
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
  assert.ok(statusText.value);
  assert.equal(editor.isInsertRowVisible(tab), true);
});

test("saving insert drafts promotes saved rows into ordinary table rows", async () => {
  const { editor, tab } = createEditor({
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }],
  });
  tab.primaryKeys = ["id"];

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "id", "9");
  editor.updateInsertDraft(tab, rowId, "name", "Dana");
  const result = await editor.commitInsertRows(tab);

  assert.deepEqual(result, { insertedRows: 1, failedRowId: null });
  assert.deepEqual(tab.rows.at(-1), { id: "9", name: "Dana" });
  assert.equal(editor.isInsertRowVisible(tab), false);
  assert.deepEqual(editor.getInsertRows(tab), []);
});

test("copying selected rows writes row TSV and emits visible copy feedback", async () => {
  const { editor, tab, clipboard, saveFeedback, statusText } = createEditor();

  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[2]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(clipboard.text, "Alice\t10\tRed\nCara\t14\tGreen");
  assert.equal(statusText.value, "已复制 2 行");
  assert.deepEqual(saveFeedback.at(-1), {
    kind: "copy",
    tabId: tab.id,
    rowKey: buildRowKey(tab, tab.rows[0]),
    column: "name",
    message: "已复制 2 行",
  });
});

test("copying a selected insert cell writes the draft value", async () => {
  const { editor, tab, clipboard } = createEditor();

  editor.selectInsertCell(tab, 0);
  editor.updateInsertDraft(tab, editor.selectedInsertCell.value.rowId, "name", "Dana");
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(clipboard.text, "Dana");
});

test("copying the selected insert row writes one TSV row", async () => {
  const { editor, tab, clipboard } = createEditor();

  editor.selectInsertRow(tab);
  const rowId = editor.selectedInsertRow.value.rowId;
  editor.updateInsertDraft(tab, rowId, "name", "Dana");
  editor.updateInsertDraft(tab, rowId, "level", "20");
  editor.updateInsertDraft(tab, rowId, "guild", "Gold");
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(clipboard.text, "Dana\t20\tGold");
});

test("insertDraftAbove creates an anchored draft at the given originalIndex and selects first editable column", () => {
  const { editor, tab } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, extra: "auto_increment" },
      { column_name: "name", column_type: "varchar" },
      { column_name: "level", column_type: "int" },
    ],
  });

  editor.insertDraftAbove(tab, 1);

  const rows = editor.getInsertRows(tab);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].anchorIndex, 1);
  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.equal(editor.selectedInsertCell.value.rowId, rows[0].id);
  // 首个可编辑列 = name（index 1），跳过主键自增 id
  assert.equal(editor.selectedInsertCell.value.columnIndex, 1);
});

test("insertDraftAbove keeps the horizontal position by disabling column scroll", () => {
  const { editor, tab, scrollCalls } = createEditor({
    columns: [
      { column_name: "model_id", is_primary_key: true },
      { column_name: "quality", is_primary_key: true },
      { column_name: "cost" },
    ],
  });

  editor.insertDraftAbove(tab, 1);

  const row = editor.getInsertRows(tab)[0];
  assert.equal(editor.selectedInsertCell.value.rowId, row.id);
  // 第一个可编辑列 = cost（index 2），跳过两个主键列
  assert.equal(editor.selectedInsertCell.value.columnIndex, 2);
  // 视觉行号定位到 anchor（1），不再误定位到末尾追加区
  assert.deepEqual(scrollCalls.at(-1), ["insert", 2, 1]);
});

test("insertDraftAbove scrolls the anchored draft into view instead of the trailing append area", () => {
  const { editor, tab, scrollCalls } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, extra: "auto_increment" },
      { column_name: "name", column_type: "varchar" },
    ],
  });

  editor.insertDraftAbove(tab, 1);

  // 第一个可编辑列 = name（index 1），视觉行号 = anchor（1）
  assert.deepEqual(scrollCalls.at(-1), ["insert", 1, 1]);
});

test("selecting the trailing insert row still scrolls to the append area", () => {
  const { editor, tab, scrollCalls } = createEditor();

  editor.selectInsertCell(tab, 0);

  assert.deepEqual(scrollCalls.at(-1), ["insert", 0, 3]);
});

test("ArrowDown from the last data row creates a trailing insert row even after an anchored draft exists", () => {
  const { editor, tab, scrollCalls } = createEditor();

  editor.insertDraftAbove(tab, 1);
  const anchoredRowId = editor.getInsertRows(tab)[0].id;
  editor.selectCell(tab, tab.rows.at(-1), "level", 3, 1);

  editor.navigateCell(1, 0);

  const rows = editor.getInsertRows(tab);
  const trailing = rows.find((row) => row.anchorIndex == null);
  assert.ok(trailing);
  assert.notEqual(trailing.id, anchoredRowId);
  assert.equal(editor.selectedInsertCell.value.rowId, trailing.id);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 1);
  assert.deepEqual(scrollCalls.at(-1), ["insert", 1, 4]);
});

test("insertDraftAbove on a read-only tab is rejected and reports status", () => {
  const { editor, tab, statusText } = createEditor({ readOnly: true });

  editor.insertDraftAbove(tab, 0);

  assert.equal(editor.getInsertRows(tab).length, 0);
  assert.match(statusText.value, /只读/);
});

test("insertDraftAbove with no primary-key column selects column index 0", () => {
  const { editor, tab } = createEditor();

  editor.insertDraftAbove(tab, 2);

  const rows = editor.getInsertRows(tab);
  assert.equal(rows[0].anchorIndex, 2);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);
});

test("insertPosition reports anchored draft's visual row index at its anchor", () => {
  const { editor, tab } = createEditor();

  editor.insertDraftAbove(tab, 1);
  const anchored = editor.getInsertRows(tab)[0];
  const position = editor.insertPosition(tab, anchored.id, 0);

  // anchorIndex=1 means the draft is visually inserted before data row 1.
  assert.equal(position.rowIndex, 1);
});

test("insertPosition reports trailing draft's visual row index after all data rows", () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const trailing = editor.getInsertRows(tab)[0];
  const position = editor.insertPosition(tab, trailing.id, 0);

  // With three data rows, the trailing draft is visual row 3.
  assert.equal(position.rowIndex, 3);
});

test("anchored draft falls back to the trailing append area when its anchor is out of range after a refresh", () => {
  const { editor, tab } = createEditor();

  editor.insertDraftAbove(tab, 2);
  const anchored = editor.getInsertRows(tab)[0];
  editor.updateInsertDraft(tab, anchored.id, "name", "Zoe");

  // Simulate a refresh (e.g. a delete) that shrank tab.rows so anchorIndex=2 is out of range.
  tab.rows = [{ id: "1", name: "Alice" }];

  // The draft must still be addressable as a trailing row (visual row 1 = tab.rows.length),
  // not silently disappear because no data row matches the stale anchorIndex.
  assert.equal(editor.insertPosition(tab, anchored.id, 0).rowIndex, 1);
  assert.deepEqual(editor.getInsertDraft(tab, anchored.id), { name: "Zoe" });
});

test("copying a selected range writes TSV to the clipboard and emits visible copy feedback", async () => {
  const { editor, tab, clipboard, saveFeedback, statusText } = createEditor();

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();

  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(clipboard.text, "Alice\t10\nBob\t12");
  assert.equal(statusText.value, "已复制 2×2 区域");
  assert.deepEqual(saveFeedback.at(-1), {
    kind: "copy",
    tabId: tab.id,
    rowKey: buildRowKey(tab, tab.rows[0]),
    column: "name",
    message: "已复制 2×2 区域",
  });
});

test("pasting TSV into a selected insert cell fills draft columns", async () => {
  const clipboard = { text: "Dana\t20", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls, statusText } = createEditor({ clipboard });

  editor.selectInsertCell(tab, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(editor.getInsertDraft(tab, editor.selectedInsertCell.value.rowId), { name: "Dana", level: "20" });
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
  assert.match(statusText.value, /2/);
});

test("pasting multiple TSV rows into a selected insert cell fills multiple temporary rows", async () => {
  const clipboard = { text: "Dana\t20\tGold\nEli\t21\tSilver", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls, statusText } = createEditor({ clipboard });

  editor.selectInsertCell(tab, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  const rows = editor.getInsertRows(tab);

  assert.deepEqual(editor.getInsertDraft(tab, rows[0].id), { name: "Dana", level: "20", guild: "Gold" });
  assert.deepEqual(editor.getInsertDraft(tab, rows[1].id), { name: "Eli", level: "21", guild: "Silver" });
  assert.equal(rows.length, 2);
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
  assert.equal(statusText.value, "已粘贴到 2 条新增行");
});

test("pasting copied full rows into an insert cell keeps primary key values", async () => {
  const clipboard = { text: "9\tDana\t20\n10\tEli\t21", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab } = createEditor({
    clipboard,
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }, { column_name: "level" }],
  });

  editor.selectInsertCell(tab, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  const rows = editor.getInsertRows(tab);

  assert.deepEqual(editor.getInsertDraft(tab, rows[0].id), { id: "9", name: "Dana", level: "20" });
  assert.deepEqual(editor.getInsertDraft(tab, rows[1].id), { id: "10", name: "Eli", level: "21" });
});

test("input paste event fills multiple insert rows without losing the first editable column", async () => {
  const { editor, tab } = createEditor({
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }, { column_name: "level" }],
  });

  editor.selectInsertCell(tab, 0);
  await editor.pasteIntoInsertInput(tab, editor.selectedInsertCell.value.rowId, 0, {
    clipboardData: { getData: () => "9\tDana\t20\n10\tEli\t21" },
  });
  const rows = editor.getInsertRows(tab);

  assert.deepEqual(editor.getInsertDraft(tab, rows[0].id), { id: "9", name: "Dana", level: "20" });
  assert.deepEqual(editor.getInsertDraft(tab, rows[1].id), { id: "10", name: "Eli", level: "21" });
});

test("duplicate primary keys are rejected when saving an insert row", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor({
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }],
  });

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "id", "1");
  editor.updateInsertDraft(tab, rowId, "name", "Duplicate Alice");
  const inserted = await editor.commitInsertRow(tab, rowId);

  assert.equal(inserted, false);
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
  assert.ok(statusText.value);
});

test("duplicate primary keys across insert drafts are rejected when saving", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor({
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }],
  });

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "id", "9");
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  editor.handleInsertKeydown(tab, firstRowId, 0, { key: "ArrowDown" });
  const secondRowId = editor.getInsertRows(tab)[1].id;
  editor.updateInsertDraft(tab, secondRowId, "id", "9");
  editor.updateInsertDraft(tab, secondRowId, "name", "Eli");
  const inserted = await editor.commitInsertRow(tab, secondRowId);

  assert.equal(inserted, false);
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
  assert.ok(statusText.value);
});

test("duplicate composite primary keys mark every primary-key cell in the duplicate draft", async () => {
  const { editor, tab, editState, invokeCalls } = createEditor({
    columns: [
      { column_name: "model_id", is_primary_key: true },
      { column_name: "quality", is_primary_key: true },
      { column_name: "name" },
    ],
  });
  tab.primaryKeys = ["model_id", "quality"];
  tab.rows = [{ model_id: "1", quality: "7", name: "Existing" }];

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  const rowKey = editor.getInsertRowKey(tab, rowId);
  editor.updateInsertDraft(tab, rowId, "model_id", "1");
  editor.updateInsertDraft(tab, rowId, "quality", "7");

  const inserted = await editor.commitInsertRow(tab, rowId);

  assert.equal(inserted, false);
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
  assert.ok(getCellError(editState, "player", rowKey, "model_id"));
  assert.ok(getCellError(editState, "player", rowKey, "quality"));
});

test("changing a duplicated insert primary key clears stale errors and saves immediately", async () => {
  const { editor, tab, editState, invokeCalls } = createEditor({
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }],
  });

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  const rowKey = editor.getInsertRowKey(tab, rowId);
  editor.updateInsertDraft(tab, rowId, "id", "1");
  editor.updateInsertDraft(tab, rowId, "name", "Duplicate Alice");
  assert.ok(getCellError(editState, "player", rowKey, "id"));

  editor.updateInsertDraft(tab, rowId, "id", "9");
  const result = await editor.commitInsertRows(tab);

  assert.deepEqual(result, { insertedRows: 1, failedRowId: null });
  assert.equal(getCellError(editState, "player", rowKey, "id"), "");
  assert.deepEqual(invokeCalls.filter((call) => call.command === "insert_row"), [
    { command: "insert_row", payload: { request: { sessionId: "session-1", draft: { id: "9", name: "Duplicate Alice" } } } },
  ]);
});

test("saving insert drafts flushes the active editing insert value before validation", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }],
  });

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  const rowKey = editor.getInsertRowKey(tab, rowId);
  editor.updateInsertDraft(tab, rowId, "id", "1");
  editor.updateInsertDraft(tab, rowId, "name", "Alice Copy");
  editor.startEditing(tab, { id: "1", name: "Alice Copy", __insertRowId: rowId }, "id", tab.rows.length, 0);
  editor.editDraft.value = "9";

  const result = await editor.commitInsertRows(tab);

  assert.deepEqual(result, { insertedRows: 1, failedRowId: null });
  assert.equal(editor.editingCell.value, null);
  assert.equal(editor.selectedCell.value, null);
  assert.deepEqual(invokeCalls.filter((call) => call.command === "insert_row"), [
    { command: "insert_row", payload: { request: { sessionId: "session-1", draft: { id: "9", name: "Alice Copy" } } } },
  ]);
});

test("finishing an insert edit resolves the duplicate primary key so a subsequent save commits", async () => {
  const { editor, tab, invokeCalls, editState } = createEditor({
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }],
  });

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  const rowKey = editor.getInsertRowKey(tab, rowId);
  editor.updateInsertDraft(tab, rowId, "id", "1");
  editor.updateInsertDraft(tab, rowId, "name", "Duplicate Alice");
  assert.ok(getCellError(editState, "player", rowKey, "id"));

  editor.startEditing(tab, { id: "1", name: "Duplicate Alice", __insertRowId: rowId }, "id", 1, 0);
  editor.editDraft.value = "9";
  // finishEditing 只把录入值写回草稿，不再自动提交；行与草稿都保留
  editor.finishEditing();
  await nextTick();
  assert.equal(getCellError(editState, "player", rowKey, "id"), "");
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
  assert.deepEqual(editor.getInsertDraft(tab, rowId), { id: "9", name: "Duplicate Alice" });

  // 显式保存才落库
  const result = await editor.commitInsertRows(tab);
  assert.deepEqual(result, { insertedRows: 1, failedRowId: null });
  assert.deepEqual(invokeCalls.filter((call) => call.command === "insert_row"), [
    { command: "insert_row", payload: { request: { sessionId: "session-1", draft: { id: "9", name: "Duplicate Alice" } } } },
  ]);
});

test("pasting TSV rows into the selected insert row commits one row per TSV row", async () => {
  const clipboard = { text: "Dana\t20\tGold\nEli\t21\tSilver", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls, statusText } = createEditor({ clipboard });

  editor.selectInsertRow(tab);
  const result = await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(invokeCalls.filter((call) => call.command === "insert_row"), [
    { command: "insert_row", payload: { request: { sessionId: "session-1", draft: { name: "Dana", level: "20", guild: "Gold" } } } },
    { command: "insert_row", payload: { request: { sessionId: "session-1", draft: { name: "Eli", level: "21", guild: "Silver" } } } },
  ]);
  assert.deepEqual(result, { insertedRows: 2 });
  assert.match(statusText.value, /2/);
});

test("pasting copied rows into the selected insert row keeps primary key values", async () => {
  const clipboard = { text: "9\tDana\t20", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls } = createEditor({
    clipboard,
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }, { column_name: "level" }],
  });

  editor.selectInsertRow(tab);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(invokeCalls.at(-1), {
    command: "insert_row",
    payload: { request: { sessionId: "session-1", draft: { id: "9", name: "Dana", level: "20" } } },
  });
});

test("pasting TSV commits multiple cells from the selected range anchor", async () => {
  const clipboard = { text: "Ann\t20\nBen\t21", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls, statusText } = createEditor({ clipboard });

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(invokeCalls.filter((call) => call.command === "update_cell").length, 4);
  assert.equal(tab.rows[0].name, "Ann");
  assert.equal(tab.rows[1].level, "21");
  assert.match(statusText.value, /4/);
});

test("selectColumn selects all cells in the clicked column", () => {
  const { editor, tab } = createEditor();

  editor.selectColumn(tab, "level", { button: 0, ctrlKey: false, metaKey: false, shiftKey: false });

  assert.equal(editor.isColumnSelected(tab, 1), true);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[0]), "level", 0, 1), true);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[1]), "level", 1, 1), true);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[2]), "level", 2, 1), true);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[0]), "name", 0, 0), false);
});

test("ctrl-click toggles columns into a multi-column selection", () => {
  const { editor, tab } = createEditor();

  editor.selectColumn(tab, "name", { button: 0, ctrlKey: true, metaKey: false, shiftKey: false });
  assert.equal(editor.isColumnSelected(tab, 0), true);
  assert.equal(editor.isColumnSelected(tab, 1), false);

  editor.selectColumn(tab, "level", { button: 0, ctrlKey: true, metaKey: false, shiftKey: false });
  assert.equal(editor.isColumnSelected(tab, 0), true);
  assert.equal(editor.isColumnSelected(tab, 1), true);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[0]), "name", 0, 0), true);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[0]), "level", 0, 1), true);

  editor.selectColumn(tab, "name", { button: 0, ctrlKey: true, metaKey: false, shiftKey: false });
  assert.equal(editor.isColumnSelected(tab, 0), false);
  assert.equal(editor.isColumnSelected(tab, 1), true);
});

test("shift-click extends column selection from the anchor", () => {
  const { editor, tab } = createEditor();

  editor.selectColumn(tab, "name", { button: 0, ctrlKey: false, metaKey: false, shiftKey: false });
  editor.selectColumn(tab, "guild", { button: 0, ctrlKey: false, metaKey: false, shiftKey: true });

  assert.equal(editor.isColumnSelected(tab, 0), true);
  assert.equal(editor.isColumnSelected(tab, 1), true);
  assert.equal(editor.isColumnSelected(tab, 2), true);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[0]), "name", 0, 0), true);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[2]), "guild", 2, 2), true);
});

test("clearSelection also clears column selection", () => {
  const { editor, tab } = createEditor();

  editor.selectColumn(tab, "level", { button: 0, ctrlKey: false, metaKey: false, shiftKey: false });
  assert.equal(editor.isColumnSelected(tab, 1), true);

  editor.clearSelection();

  assert.equal(editor.isColumnSelected(tab, 1), false);
  assert.equal(editor.selectedRange.value, null);
});

test("clearing selection after refresh drops unsaved insert drafts", () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "name", "Dana");
  tab.rows = [{ id: "1", name: "Alice" }];

  editor.clearSelection({ clearInsertDrafts: true });

  assert.equal(editor.getInsertRows(tab).length, 0);
  assert.equal(editor.getVisibleInsertRows(tab).length, 0);
  assert.equal(editor.selectedCell.value, null);
  assert.equal(editor.selectedRange.value, null);
  assert.equal(editor.selectedInsertCell.value, null);
});

test("createInsertRow defaults anchorIndex to null for trailing append", () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const row = editor.getInsertRows(tab)[0];

  assert.equal(row.anchorIndex, null);
});
