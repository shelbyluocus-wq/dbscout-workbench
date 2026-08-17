import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { computed, nextTick, reactive } from "vue";
import { createEditState, getCellError } from "./editState.js";
import { useGridEditor } from "./composables/useGridEditor.js";
import { useUndo } from "./composables/useUndo.js";
import { clearGridClipboardPayload } from "./utils/gridClipboardStore.js";
import { buildRowKey } from "./utils/rowIdentity.js";

const initialNavigator = globalThis.navigator;
const initialRequestAnimationFrame = globalThis.requestAnimationFrame;
const initialCancelAnimationFrame = globalThis.cancelAnimationFrame;

afterEach(() => {
  clearGridClipboardPayload();
  Object.defineProperty(globalThis, "navigator", {
    value: initialNavigator,
    configurable: true,
  });
  globalThis.requestAnimationFrame = initialRequestAnimationFrame;
  globalThis.cancelAnimationFrame = initialCancelAnimationFrame;
});

function createEditor(options = {}) {
  const clipboard = options.clipboard || { text: "", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  Object.defineProperty(globalThis, "navigator", {
    value: { ...(globalThis.navigator || {}), clipboard },
    configurable: true,
  });
  const tab = options.tab || reactive({
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
  const editState = options.editState || reactive(createEditState());
  const invokeWorkbench = options.invokeWorkbench || ((command, payload) => (
    command === "update_cells"
      ? { updated: payload?.request?.rows?.length || 0, conflict: false }
      : {}
  ));
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

function pointerSelect(editor, tab, rowIndex, columnIndex, modifiers = {}) {
  const column = tab.columns[columnIndex]?.column_name || tab.columns[columnIndex]?.columnName;
  editor.startRangeSelection(tab, tab.rows[rowIndex], column, rowIndex, columnIndex, {
    button: 0,
    preventDefault() {},
    ...modifiers,
  });
  editor.finishRangeSelection();
}

function selectedCoordinates(editor, tab) {
  const selected = [];
  for (let rowIndex = 0; rowIndex < tab.rows.length; rowIndex++) {
    for (let columnIndex = 0; columnIndex < tab.columns.length; columnIndex++) {
      const column = tab.columns[columnIndex]?.column_name || tab.columns[columnIndex]?.columnName;
      if (editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[rowIndex]), column, rowIndex, columnIndex)) {
        selected.push(`${rowIndex}:${columnIndex}`);
      }
    }
  }
  return selected;
}

function updatedCellCount(calls) {
  return calls.reduce((count, call) => {
    if (call.command === "update_cell") return count + 1;
    if (call.command !== "update_cells") return count;
    return count + (call.payload?.request?.rows || []).reduce(
      (rowCount, row) => rowCount + (row.changes?.length || 0),
      0,
    );
  }, 0);
}

async function waitForTestCondition(predicate, message, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(predicate(), message);
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

test("focusTextCell keeps the original JSON text instead of pretty-printing it", () => {
  const { editor, tab } = createEditor({
    columns: [{ column_name: "id", column_type: "int", is_primary_key: true }, { column_name: "payload", column_type: "text" }],
    tab: undefined,
  });
  tab.rows[0].payload = '{"enabled":true,"count":3}';

  editor.focusTextCell(tab, tab.rows[0], "payload");

  assert.equal(editor.textDraft.value, '{"enabled":true,"count":3}');
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

test("blur commits the detail draft even when textDraft was overwritten by a cell selection (#detail-blur-save)", async () => {
  // 回归：在详细输入框里编辑后，点击网格切到另一个单元格时，watch 会先用新单元
  // 格的值覆盖组件本地的 editorDraft/loadedCell，等 textarea blur 触发时已读不到
  // 用户输入（表现为"失焦后还原成修改前的样子"）。组件在 watch 覆盖前先用原单元
  // 格身份 + 本地 editorDraft 触发 commitDetailDraft，按原单元格提交；@blur 再兜底
  // 处理点击非网格区域（selectedCell 不变）的情况。本测试直接验证编辑器侧的提交。
  const { editor, tab, invokeCalls } = createEditor();
  const row = tab.rows[0];
  const rowKey = buildRowKey(tab, row);
  editor.focusTextCell(tab, row, "name");
  assert.equal(editor.textDraft.value, "Alice");

  // 模拟用户在 textarea 里输入新值（组件内 editorDraft 与 textDraft 同步更新）
  editor.textDraft.value = "Alicia";

  // 模拟点击另一个单元格：setSelectedCellFromPosition 把 selectedCell/textDraft 切走
  editor.selectCell(tab, tab.rows[1], "name", 1, 0);
  assert.equal(editor.textDraft.value, "Bob");

  // 组件在 watch 覆盖本地草稿前，用原单元格身份 + editorDraft 触发 commitDetailDraft
  await editor.commitDetailDraft({ tabId: tab.id, rowKey, column: "name", draft: "Alicia" });

  assert.equal(tab.rows[0].name, "Alicia");
  assert.equal(updatedCellCount(invokeCalls), 1);
  assert.equal(invokeCalls[0].payload.request.newValue, "Alicia");
});

test("commitDetailDraft is a no-op when the draft matches the committed value", async () => {
  const { editor, tab, invokeCalls } = createEditor();
  const row = tab.rows[0];
  const rowKey = buildRowKey(tab, row);
  editor.focusTextCell(tab, row, "name");

  await editor.commitDetailDraft({ tabId: tab.id, rowKey, column: "name", draft: "Alice" });

  assert.equal(updatedCellCount(invokeCalls), 0);
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

test("cell save failures show the concrete backend reason", async () => {
  const { editor, tab, statusText, saveFeedback } = createEditor({
    invokeWorkbench: async () => {
      throw new Error("JSON 文档与数据库字段约束不匹配");
    },
  });

  await editor.commitCellValue(tab, tab.rows[0], "name", "Changed");

  assert.equal(tab.rows[0].name, "Alice");
  assert.equal(statusText.value, "保存失败：JSON 文档与数据库字段约束不匹配");
  assert.equal(saveFeedback.at(-1).message, "保存失败：JSON 文档与数据库字段约束不匹配");
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
  assert.equal(updatedCellCount(invokeCalls), 1);
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

test("single click with a rendered row index does not scan all loaded row keys", () => {
  const { editor, tab } = createEditor({
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }],
  });
  let keyReads = 0;
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    get id() {
      keyReads += 1;
      return String(index + 1);
    },
    name: `row-${index + 1}`,
  }));
  tab.rows = rows;
  keyReads = 0;

  editor.selectCell(tab, rows.at(-1), "id", rows.length - 1, 0);

  assert.ok(keyReads <= 8, `single click read ${keyReads} row keys`);
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

test("typing into a multi-cell range saves the value to every selected cell with one success reminder", async () => {
  const { editor, tab, invokeCalls, saveFeedback } = createEditor();

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();

  await editor.handleGridKeydown({
    key: "x",
    preventDefault() {},
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  });
  await editor.finishEditing();

  assert.equal(tab.rows[0].name, "x");
  assert.equal(tab.rows[0].level, "x");
  assert.equal(tab.rows[1].name, "x");
  assert.equal(tab.rows[1].level, "x");
  assert.equal(updatedCellCount(invokeCalls), 4);
  assert.deepEqual(saveFeedback, [{
    kind: "success",
    tabId: tab.id,
    rowKey: editor.selectedCell.value.rowKey,
    column: editor.selectedCell.value.column,
    message: "已保存 4 个单元格",
  }]);
});

test("multi-cell save emits only one failure reminder when some cells fail", async () => {
  const { editor, tab, saveFeedback } = createEditor({
    invokeWorkbench(command) {
      if (command === "update_cells") throw new Error("数据库拒绝了该值");
      return {};
    },
  });

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();
  await editor.handleGridKeydown({
    key: "x",
    preventDefault() {},
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  });
  await editor.finishEditing();

  assert.equal(tab.rows[0].name, "Alice");
  assert.equal(tab.rows[0].level, "10");
  assert.equal(tab.rows[1].name, "Bob");
  assert.equal(tab.rows[1].level, "12");
  assert.equal(saveFeedback.length, 1);
  assert.equal(saveFeedback[0].kind, "error");
  assert.match(saveFeedback[0].message, /成功 0 个，失败 4 个/);
  assert.match(saveFeedback[0].message, /数据库拒绝了该值/);
});

test("editing the detail panel applies its value to the active multi-cell range", async () => {
  const { editor, tab, invokeCalls, saveFeedback } = createEditor();

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();
  const activeCell = { ...editor.selectedCell.value };

  await editor.commitDetailDraft({ ...activeCell, draft: "detail" });

  assert.equal(tab.rows[0].name, "detail");
  assert.equal(tab.rows[0].level, "detail");
  assert.equal(tab.rows[1].name, "detail");
  assert.equal(tab.rows[1].level, "detail");
  assert.equal(updatedCellCount(invokeCalls), 4);
  assert.equal(saveFeedback.length, 1);
  assert.equal(saveFeedback[0].kind, "success");
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

test("Ctrl+C while inline editing shows copy feedback without blocking native copy", async () => {
  const clipboard = {
    writes: 0,
    async writeText() {
      this.writes += 1;
    },
    async readText() {
      return "";
    },
  };
  const { editor, tab, clipboard: observedClipboard, saveFeedback, statusText } = createEditor({ clipboard });
  let prevented = false;
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await nextTick();
  editor.startEditing(tab, tab.rows[0], "name", 0, 0);
  await nextTick();

  await editor.handleGridKeydown({
    key: "c",
    preventDefault() {
      prevented = true;
    },
    ctrlKey: true,
    metaKey: false,
    altKey: false,
  });

  assert.equal(prevented, false, "native input copy must not be blocked");
  assert.equal(observedClipboard.writes, 0, "grid copy must not overwrite the clipboard while editing");
  assert.equal(statusText.value, "复制成功");
  assert.deepEqual(saveFeedback.at(-1), {
    kind: "copy",
    tabId: tab.id,
    rowKey: buildRowKey(tab, tab.rows[0]),
    column: "name",
    message: "复制成功",
  });
  assert.equal(editor.editingCell.value?.column, "name");
});

test("Ctrl+V while inline editing is left to the cell input and shows paste feedback", async () => {
  const clipboard = {
    text: "Pasted Alice",
    reads: 0,
    async writeText(text) {
      this.text = text;
    },
    async readText() {
      this.reads += 1;
      return this.text;
    },
  };
  const { editor, tab, invokeCalls, saveFeedback, statusText } = createEditor({ clipboard });
  let prevented = false;
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await nextTick();
  editor.startEditing(tab, tab.rows[0], "name", 0, 0);
  await nextTick();

  await editor.handleGridKeydown({
    key: "v",
    preventDefault() {
      prevented = true;
    },
    ctrlKey: true,
    metaKey: false,
    altKey: false,
  });

  assert.equal(prevented, false, "native input paste must not be blocked");
  assert.equal(clipboard.reads, 0, "grid paste must not consume the clipboard while editing");
  assert.equal(statusText.value, "粘贴成功");
  assert.deepEqual(saveFeedback.at(-1), {
    kind: "copy",
    tabId: tab.id,
    rowKey: buildRowKey(tab, tab.rows[0]),
    column: "name",
    message: "粘贴成功",
  });
  assert.equal(tab.rows[0].name, "Alice");
  assert.equal(editor.editDraft.value, "Alice");
  assert.equal(editor.editingCell.value?.column, "name");
  assert.equal(invokeCalls.some((call) => call.command === "update_cell"), false);
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

test("drag range can start from an anchored insert cell and extend into saved rows", () => {
  const { editor, tab } = createEditor();
  const insertRow = editor.insertDraftAbove(tab, 1);
  const insertVisualIndex = editor.visualRowEntries(tab).visualIndexOfInsert(insertRow.id);
  const insertRowObject = { ...insertRow.draft, __insertRowId: insertRow.id };
  const targetVisualIndex = editor.insertAwareVisualRowIndex(tab, 2);

  editor.startRangeSelection(
    tab,
    insertRowObject,
    "name",
    insertVisualIndex,
    0,
    { button: 0, preventDefault() {} },
  );
  assert.equal(editor.isSelectingRange.value, true);

  editor.extendRangeSelection(tab, tab.rows[2], "guild", targetVisualIndex, 2);
  editor.finishRangeSelection();

  assert.equal(editor.selectedRange.value.anchor.rowIndex, insertVisualIndex);
  assert.equal(editor.selectedRange.value.focus.rowIndex, targetVisualIndex);
  assert.equal(editor.isCellInSelectedRange(
    tab,
    editor.getInsertRowKey(tab, insertRow.id),
    "name",
    insertVisualIndex,
    0,
  ), true);
  assert.equal(editor.isCellInSelectedRange(
    tab,
    buildRowKey(tab, tab.rows[2]),
    "guild",
    targetVisualIndex,
    2,
  ), true);
});

test("pointer drag from a trailing insert cell uses rendered visual coordinates and survives mouseup click", () => {
  const { editor, tab, gridWrapRef } = createEditor();
  const insertRow = editor.insertDraftBelow(tab, 2);
  const insertVisualIndex = editor.visualRowEntries(tab).visualIndexOfInsert(insertRow.id);
  const insertRowObject = { ...insertRow.draft, __insertRowId: insertRow.id };
  const renderedCell = {
    getAttribute(name) {
      if (name === "data-visual-row-index") return "1";
      if (name === "data-column-index") return "2";
      return null;
    },
  };
  const pointerTarget = {
    closest(selector) {
      return selector.includes("data-visual-row-index") ? renderedCell : null;
    },
  };
  gridWrapRef.value.contains = (element) => element === renderedCell;

  editor.startRangeSelection(
    tab,
    insertRowObject,
    "name",
    insertVisualIndex,
    0,
    { button: 0, preventDefault() {} },
  );
  editor.extendRangeSelectionFromPointer({
    clientX: -100,
    clientY: -100,
    target: pointerTarget,
  });
  editor.finishRangeSelection();

  assert.equal(editor.selectedRange.value.anchor.rowIndex, insertVisualIndex);
  assert.equal(editor.selectedRange.value.focus.rowIndex, 1);
  assert.equal(editor.selectedRange.value.focus.columnIndex, 2);
  assert.deepEqual(editor.selectedCell.value, {
    tabId: tab.id,
    rowKey: buildRowKey(tab, tab.rows[1]),
    column: "guild",
  });
  assert.equal(editor.selectedInsertCell.value, null);
  assert.equal(editor.consumeCellPointerClick(), true);
  assert.equal(editor.selectedRange.value.anchor.rowIndex, insertVisualIndex);
  assert.equal(editor.selectedRange.value.focus.rowIndex, 1);
});

test("pointer drag does not refresh or animate while staying inside the same non-edge cell", () => {
  let animationRequests = 0;
  globalThis.requestAnimationFrame = () => {
    animationRequests += 1;
    return animationRequests;
  };
  globalThis.cancelAnimationFrame = () => {};
  const { editor, tab } = createEditor();

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  const initialSelection = editor.selectedRange.value;
  editor.extendRangeSelectionFromPointer({ clientX: 100, clientY: 74 });

  assert.strictEqual(editor.selectedRange.value, initialSelection);
  assert.equal(animationRequests, 0);
  editor.finishRangeSelection();
});

test("pointer drag animates only at an edge and stops when the pointer returns inside", () => {
  let nextFrameId = 1;
  const scheduledFrames = new Map();
  const cancelledFrames = [];
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextFrameId++;
    scheduledFrames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    cancelledFrames.push(id);
    scheduledFrames.delete(id);
  };
  const { editor, tab, gridWrapRef } = createEditor();

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelectionFromPointer({ clientX: 295, clientY: 74 });

  assert.equal(scheduledFrames.size, 1);
  const [firstFrameId, firstFrame] = scheduledFrames.entries().next().value;
  scheduledFrames.delete(firstFrameId);
  firstFrame();
  assert.ok(gridWrapRef.value.scrollLeft > 0);
  assert.equal(scheduledFrames.size, 1);

  const activeFrameId = scheduledFrames.keys().next().value;
  editor.extendRangeSelectionFromPointer({ clientX: 100, clientY: 74 });

  assert.deepEqual(cancelledFrames, [activeFrameId]);
  assert.equal(scheduledFrames.size, 0);
  editor.finishRangeSelection();
});

test("an empty table's first insert row can drag horizontally", () => {
  const emptyTab = reactive({
    id: "tab-empty",
    tableName: "empty_table",
    sessionId: "session-empty",
    columns: [{ column_name: "name" }, { column_name: "level" }, { column_name: "guild" }],
    rows: [],
    selectedRowKeys: new Set(),
  });
  const cells = [
    { dataset: { columnIndex: "0" }, getBoundingClientRect: () => ({ left: 38, right: 164 }) },
    { dataset: { columnIndex: "1" }, getBoundingClientRect: () => ({ left: 164, right: 290 }) },
    { dataset: { columnIndex: "2" }, getBoundingClientRect: () => ({ left: 290, right: 416 }) },
  ];
  const { editor, tab } = createEditor({ tab: emptyTab, cells });
  const insertRow = editor.insertDraftBelow(tab, null);
  const insertRowObject = { ...insertRow.draft, __insertRowId: insertRow.id };

  editor.startRangeSelection(
    tab,
    insertRowObject,
    "name",
    0,
    0,
    { button: 0, preventDefault() {} },
  );
  editor.extendRangeSelectionFromPointer({ clientX: 350, clientY: 74 });
  editor.finishRangeSelection();

  assert.equal(editor.selectedRange.value.anchor.rowIndex, 0);
  assert.equal(editor.selectedRange.value.focus.rowIndex, 0);
  assert.equal(editor.selectedRange.value.focus.columnIndex, 2);
  assert.equal(editor.isCellInSelectedRange(
    tab,
    editor.getInsertRowKey(tab, insertRow.id),
    "guild",
    0,
    2,
  ), true);
});

test("insert cells share Shift and Ctrl range modifiers with saved cells", () => {
  {
    const { editor, tab } = createEditor();
    const insertRow = editor.insertDraftAbove(tab, 1);
    const insertVisualIndex = editor.visualRowEntries(tab).visualIndexOfInsert(insertRow.id);
    const insertRowObject = { ...insertRow.draft, __insertRowId: insertRow.id };
    pointerSelect(editor, tab, 0, 0);

    editor.startRangeSelection(
      tab,
      insertRowObject,
      "level",
      insertVisualIndex,
      1,
      { button: 0, shiftKey: true, preventDefault() {} },
    );
    editor.finishRangeSelection();

    assert.equal(editor.selectedRange.value.anchor.rowIndex, 0);
    assert.equal(editor.selectedRange.value.focus.rowIndex, insertVisualIndex);
    assert.equal(editor.selectedRange.value.focus.columnIndex, 1);
  }

  {
    const { editor, tab } = createEditor();
    const insertRow = editor.insertDraftAbove(tab, 1);
    const insertVisualIndex = editor.visualRowEntries(tab).visualIndexOfInsert(insertRow.id);
    const insertRowObject = { ...insertRow.draft, __insertRowId: insertRow.id };
    pointerSelect(editor, tab, 0, 0);

    editor.startRangeSelection(
      tab,
      insertRowObject,
      "level",
      insertVisualIndex,
      1,
      { button: 0, ctrlKey: true, preventDefault() {} },
    );
    editor.finishRangeSelection();

    assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[0]), "name", 0, 0), true);
    assert.equal(editor.isCellInSelectedRange(
      tab,
      editor.getInsertRowKey(tab, insertRow.id),
      "level",
      insertVisualIndex,
      1,
    ), true);
  }
});

test("Shift+click extends a rectangle from the latest anchor in every direction", () => {
  const cases = [
    { target: [0, 0], expected: ["0:0", "0:1", "1:0", "1:1"] },
    { target: [0, 2], expected: ["0:1", "0:2", "1:1", "1:2"] },
    { target: [2, 0], expected: ["1:0", "1:1", "2:0", "2:1"] },
    { target: [2, 2], expected: ["1:1", "1:2", "2:1", "2:2"] },
  ];

  for (const { target, expected } of cases) {
    const { editor, tab } = createEditor();
    pointerSelect(editor, tab, 1, 1);
    pointerSelect(editor, tab, target[0], target[1], { shiftKey: true });
    assert.deepEqual(selectedCoordinates(editor, tab), expected);
  }
});

test("Ctrl and Cmd clicks independently add and remove cells", () => {
  const { editor, tab } = createEditor();

  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 1, 1, { ctrlKey: true });
  pointerSelect(editor, tab, 2, 2, { metaKey: true });
  assert.deepEqual(selectedCoordinates(editor, tab), ["0:0", "1:1", "2:2"]);

  pointerSelect(editor, tab, 1, 1, { ctrlKey: true });
  assert.deepEqual(selectedCoordinates(editor, tab), ["0:0", "2:2"]);
  assert.equal(editor.selectedCell.value.column, "guild");
  assert.equal(editor.selectedCell.value.rowKey, buildRowKey(tab, tab.rows[2]));
});

test("Ctrl-added standalone cells use discrete range styling", () => {
  const { editor, tab } = createEditor();
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });

  assert.equal(editor.getCellRangeClasses(tab, buildRowKey(tab, tab.rows[0]), "name", 0, 0)["range-discrete"], true);
  assert.equal(editor.getCellRangeClasses(tab, buildRowKey(tab, tab.rows[2]), "guild", 2, 2)["range-discrete"], true);
});

test("Ctrl+click can carve a hole out of a rectangular selection", () => {
  const { editor, tab } = createEditor();

  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 2, 2, { shiftKey: true });
  pointerSelect(editor, tab, 1, 1, { ctrlKey: true });

  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[1]), "level", 1, 1), false);
  assert.equal(editor.getCellRangeClasses(tab, buildRowKey(tab, tab.rows[1]), "level", 1, 1)["range-selected"], false);
  assert.equal(selectedCoordinates(editor, tab).length, 8);
});

test("Ctrl+Shift+click follows Shift semantics and clears sparse toggles", () => {
  const { editor, tab } = createEditor();

  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });
  pointerSelect(editor, tab, 0, 1, { ctrlKey: true, shiftKey: true });

  assert.deepEqual(selectedCoordinates(editor, tab), ["0:1", "0:2", "1:1", "1:2", "2:1", "2:2"]);
  assert.deepEqual(editor.selectedRange.value.toggledCells, []);
});

test("deselecting the active cell focuses the top-left remainder while removing another cell keeps focus", () => {
  const { editor, tab } = createEditor();

  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });
  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });
  assert.deepEqual(editor.selectedCell.value, {
    tabId: tab.id,
    rowKey: buildRowKey(tab, tab.rows[0]),
    column: "name",
  });

  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });
  pointerSelect(editor, tab, 0, 0, { ctrlKey: true });
  assert.deepEqual(editor.selectedCell.value, {
    tabId: tab.id,
    rowKey: buildRowKey(tab, tab.rows[2]),
    column: "guild",
  });
});

test("Ctrl+clicking the final selected cell clears the selection", () => {
  const { editor, tab } = createEditor();

  pointerSelect(editor, tab, 1, 1);
  pointerSelect(editor, tab, 1, 1, { ctrlKey: true });

  assert.equal(editor.selectedRange.value, null);
  assert.equal(editor.selectedCell.value, null);
  assert.equal(editor.textDraft.value, "");
});

test("Ctrl+click selection cost does not scale with loaded row count", () => {
  const { editor, tab } = createEditor({
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }],
  });
  let keyReads = 0;
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    get id() {
      keyReads += 1;
      return String(index + 1);
    },
    name: `row-${index + 1}`,
  }));
  tab.rows = rows;
  keyReads = 0;

  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, rows.length - 1, 1, { ctrlKey: true });

  assert.ok(keyReads <= 16, `Ctrl+click read ${keyReads} row keys`);
  assert.deepEqual(selectedCoordinates(editor, { ...tab, rows: [rows[0], rows.at(-1)] }).length, 1);
});

test("pointer click suppression expires when mouseup produces no cell click", async () => {
  const { editor, tab } = createEditor();

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.finishRangeSelection();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(editor.consumeCellPointerClick(), false);
});

test("capturing and restoring a table view preserves sparse membership and active focus", () => {
  const { editor, tab } = createEditor();
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 1, 1, { ctrlKey: true });
  const snapshot = editor.captureTableViewSelection();

  editor.clearSelection();
  editor.restoreTableViewSelection(snapshot);

  assert.deepEqual(selectedCoordinates(editor, tab), ["0:0", "1:1"]);
  assert.deepEqual(editor.selectedCell.value, {
    tabId: tab.id,
    rowKey: buildRowKey(tab, tab.rows[1]),
    column: "level",
  });
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

test("pointer range extension accounts for the field comment header band", () => {
  const { editor, tab } = createEditor({
    wrapRect: { top: 0, bottom: 144, left: 0, right: 300 },
  });

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  // 28px column header + 32px field-comment band + the middle of data row 2.
  editor.extendRangeSelectionFromPointer({ clientX: 100, clientY: 102 });
  editor.finishRangeSelection();

  assert.equal(editor.selectedRange.value.focus.rowIndex, 1);
  assert.equal(editor.isCellInSelectedRange(tab, buildRowKey(tab, tab.rows[2]), "name", 2, 0), false);
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

test("Delete on a nullable non-text cell writes an empty string instead of creating NULL", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true },
      { column_name: "level", column_type: "int", is_nullable: true },
    ],
  });

  editor.selectCell(tab, tab.rows[0], "level", 0, 1);
  await editor.handleGridKeydown(navEvent("Delete"));

  assert.equal(tab.rows[0].level, "");
  assert.equal(invokeCalls.at(-1).payload.request.newValue, "");
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
  const { editor, tab, saveFeedback } = createEditor({
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
  assert.equal(saveFeedback.length, 1);
  assert.equal(saveFeedback[0].message, "已清空 4 个单元格");
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

test("Escape on a selected insert cell keeps the unsaved row", async () => {
  const { editor, tab, focused } = createEditor();

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "name", "Dana");
  editor.handleInsertKeydown(tab, rowId, 0, { key: "Escape" });
  await nextTick();

  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.equal(editor.selectedInsertCell.value.rowId, rowId);
  assert.deepEqual(editor.getInsertDraft(tab, rowId), { name: "Dana" });
  assert.equal(focused.count, 0);
});

test("grid Escape on a selected insert cell does not remove that unsaved row", async () => {
  const { editor, tab } = createEditor();

  editor.insertDraftAbove(tab, 2);
  const rowId = editor.selectedInsertCell.value.rowId;

  await editor.handleGridKeydown({ key: "Escape", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.equal(editor.getInsertRows(tab).some((row) => row.id === rowId), true);
  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.equal(editor.selectedCell.value.rowKey, editor.getInsertRowKey(tab, rowId));
  assert.deepEqual(
    tab.rows.map((_, index) => editor.insertAwareVisualRowIndex(tab, index) + 1),
    [1, 2, 4],
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

test("Escape from an editing insert cell cancels editing but keeps the row", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 1);
  await editor.handleGridKeydown({ key: "D", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });
  const rowId = editor.selectedInsertCell.value.rowId;

  editor.handleInsertKeydown(tab, rowId, 1, { key: "Escape" });

  assert.equal(editor.editingCell.value, null);
  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.equal(editor.getInsertRows(tab).some((row) => row.id === rowId), true);
});

test("editing the last insert row keeps only the current temporary insert row", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");

  assert.equal(editor.getInsertRows(tab).length, 1);
  assert.equal(editor.getInsertDraft(tab, firstRowId).name, "Dana");
});

test("ArrowDown from a filled insert row stops at the table boundary", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  editor.handleInsertKeydown(tab, firstRowId, 0, { key: "ArrowDown" });

  assert.equal(editor.selectedInsertCell.value.rowId, firstRowId);
  assert.equal(editor.getInsertRows(tab).length, 1);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);
});

test("ArrowDown from the final empty insert row stops at the table boundary", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  assert.equal(editor.getInsertRows(tab).length, 1);

  editor.handleInsertKeydown(tab, firstRowId, 0, { key: "ArrowDown" });
  assert.equal(editor.selectedInsertCell.value.rowId, firstRowId);
  assert.equal(editor.getInsertRows(tab).length, 1);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);
});

test("ArrowDown from a selected trailing insert cell stops at the table boundary", async () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  assert.equal(editor.editingCell.value, null);

  await editor.handleGridKeydown({ key: "ArrowDown", shiftKey: false, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.equal(editor.getVisibleInsertRows(tab).length, 1);
  assert.equal(editor.selectedInsertCell.value.rowId, firstRowId);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);
});

test("removing one empty trailing insert row keeps the other temporary insert rows", () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.insertDraftBelow(tab, null);
  const secondRowId = editor.selectedInsertCell.value.rowId;
  editor.insertDraftBelow(tab, null);
  const thirdRowId = editor.selectedInsertCell.value.rowId;

  editor.removeInsertDraftRow(tab, secondRowId);

  assert.deepEqual(editor.getVisibleInsertRows(tab).map((row) => row.id), [firstRowId, thirdRowId]);
});

test("ArrowDown from the last data row enters the first existing trailing insert row", () => {
  const { editor, tab, scrollCalls } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  editor.insertDraftBelow(tab, null);
  const secondRowId = editor.selectedInsertCell.value.rowId;
  editor.insertDraftBelow(tab, null);
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

test("clearing an insert draft prunes it from composite undo and redo history", () => {
  const { editor, tab, editState } = createEditor();
  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  const draftEntry = {
    kind: "insert-draft-batch",
    tableName: "player",
    tabId: tab.id,
    changes: [{ rowId, before: null, after: { id: rowId, draft: { name: "Draft" } } }],
  };
  const cellEntry = {
    tableName: "player",
    rowKey: "id=1",
    columnName: "name",
    oldValue: "Alice",
    newValue: "Saved",
  };
  editState.undoStack.push({
    kind: "history-composite",
    tableName: "player",
    entries: [draftEntry, cellEntry],
  });
  editState.redoStack.push({
    kind: "history-composite",
    tableName: "player",
    entries: [{ ...draftEntry, changes: [...draftEntry.changes] }, { ...cellEntry }],
  });

  editor.clearInsertDraft(tab, rowId);

  assert.deepEqual(editState.undoStack, [cellEntry]);
  assert.equal(editState.redoStack.length, 1);
  assert.equal(editState.redoStack[0].kind, undefined);
  assert.equal(editState.redoStack[0].columnName, "name");
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
  editor.insertDraftBelow(tab, null);
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
  editor.insertDraftBelow(tab, null);
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
  assert.equal(updatedCellCount(invokeCalls), 1);
  assert.deepEqual(saveFeedback.at(-1), {
    kind: "success",
    tabId: "tab-1",
    rowKey: "name=Axel&level=10&guild=Red",
    column: "name",
    message: saveFeedback.at(-1).message,
  });
});

test("Delete on a selected insert cell clears the cell without removing the draft row", async () => {
  const { editor, tab } = createEditor();

  editor.insertDraftAbove(tab, 1);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "name", "Dana");

  await editor.handleGridKeydown({
    key: "Delete",
    preventDefault() {},
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  });

  assert.equal(editor.getInsertRows(tab).some((row) => row.id === rowId), true);
  assert.deepEqual(editor.getInsertDraft(tab, rowId), {});
  assert.equal(editor.selectedCell.value.rowKey, editor.getInsertRowKey(tab, rowId));
});

test("saving composite primary-key cells targets feedback at the updated row identity", async () => {
  const { editor, tab, saveFeedback } = createEditor({
    columns: [
      { column_name: "ModelID", is_primary_key: true },
      { column_name: "Idx", is_primary_key: true },
      { column_name: "MinNum" },
    ],
  });
  tab.primaryKeys = ["ModelID", "Idx"];
  tab.rows = [{ ModelID: "1", Idx: "1", MinNum: "1" }];

  editor.selectCell(tab, tab.rows[0], "ModelID", 0, 0);
  await editor.commitCellValue(tab, tab.rows[0], "ModelID", "12");

  assert.equal(editor.selectedCell.value.rowKey, "ModelID=12&Idx=1");
  assert.deepEqual(saveFeedback.at(-1), {
    kind: "success",
    tabId: tab.id,
    rowKey: "ModelID=12&Idx=1",
    column: "ModelID",
    message: "已保存",
  });

  editor.selectCell(tab, tab.rows[0], "Idx", 0, 1);
  await editor.commitCellValue(tab, tab.rows[0], "Idx", "422");

  assert.equal(editor.selectedCell.value.rowKey, "ModelID=12&Idx=422");
  assert.deepEqual(saveFeedback.at(-1), {
    kind: "success",
    tabId: tab.id,
    rowKey: "ModelID=12&Idx=422",
    column: "Idx",
    message: "已保存",
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
  editor.insertDraftBelow(tab, null);
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

test("count-aware insertion creates ordered drafts with one undo entry", () => {
  const { editor, tab, editState } = createEditor();

  const inserted = editor.insertDraftsAbove(tab, { row: tab.rows[1], rowIndex: 1 }, 3);

  assert.equal(inserted.length, 3);
  assert.deepEqual(editor.visualRowEntries(tab).map((entry) => (
    entry.type === "insert" ? entry.rowId : entry.row.id
  )), ["1", ...inserted.map((row) => row.id), "2", "3"]);
  assert.equal(editState.undoStack.length, 1);
  assert.equal(editState.undoStack[0].label, "新增 3 行");
});

test("whole-row copy can be inserted above a target in source order", async () => {
  const { editor, tab, clipboard, editState, statusText } = createEditor();
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[1]));

  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  assert.equal(editor.canInsertCopiedRows(tab), true);
  editState.undoStack.length = 0;

  const result = editor.insertCopiedRowsAbove(
    tab,
    { row: tab.rows[2], rowIndex: 2 },
    clipboard.text,
  );

  assert.equal(result.ok, true);
  const copiedDrafts = editor.getVisibleInsertRows(tab).map((row) => row.draft);
  assert.deepEqual(copiedDrafts, [
    { name: "Alice", level: "10", guild: "Red" },
    { name: "Bob", level: "12", guild: "Blue" },
  ]);
  assert.deepEqual(editor.visualRowEntries(tab).map((entry) => (
    entry.type === "insert" ? entry.insertRow.draft.name : entry.row.name
  )), ["Alice", "Bob", "Alice", "Bob", "Cara"]);
  assert.equal(editState.undoStack.length, 1);
  assert.equal(editState.undoStack[0].label, "粘贴整行到当前行上方");
  assert.match(statusText.value, /插入 2 条复制行/);
});

test("whole-row copy can be inserted from the internal clipboard cache in browser mode", async () => {
  const { editor, tab } = createEditor();
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[1]));

  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  const result = editor.insertCopiedRowsAbove(tab, { row: tab.rows[2], rowIndex: 2 });

  assert.equal(result.ok, true);
  assert.deepEqual(editor.getVisibleInsertRows(tab).map((row) => row.draft.name), ["Alice", "Bob"]);
});

test("row insertion action hides for cell copy and rejects changed clipboard text", async () => {
  const { editor, tab, clipboard } = createEditor();
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  assert.equal(editor.canInsertCopiedRows(tab), false);

  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  assert.equal(editor.canInsertCopiedRows(tab), true);
  clipboard.text = "changed externally";

  const result = editor.insertCopiedRowsAbove(tab, { row: tab.rows[1], rowIndex: 1 }, clipboard.text);
  assert.equal(result.ok, false);
  assert.match(result.message, /重新复制整行/);
  assert.equal(editor.getVisibleInsertRows(tab).length, 0);
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
  // 普通复合主键需要手填，因此从第一列开始录入。
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);
  // 视觉行号定位到 anchor（1），不再误定位到末尾追加区
  assert.deepEqual(scrollCalls.at(-1), ["insert", 0, 1]);
});

test("insertDraftAbove skips generated columns but not a required primary key", () => {
  const { editor, tab } = createEditor({
    columns: [
      { column_name: "checksum", is_generated: true },
      { column_name: "external_id", column_type: "varchar", is_primary_key: true },
      { column_name: "name", column_type: "varchar" },
    ],
  });

  editor.insertDraftAbove(tab, 0);

  assert.equal(editor.selectedInsertCell.value.columnIndex, 1);
  assert.equal(editor.selectedInsertCell.value.column, "external_id");
});

test("full-row TSV paste from a new non-generated primary key draft keeps every column", async () => {
  const clipboard = {
    text: "9001\tDana\t20",
    async writeText(text) { this.text = text; },
    async readText() { return this.text; },
  };
  const { editor, tab, invokeCalls } = createEditor({
    clipboard,
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true },
      { column_name: "name", column_type: "varchar" },
      { column_name: "level", column_type: "int" },
    ],
    invokeWorkbench(command) {
      return command === "insert_row" ? { affected: 1 } : {};
    },
  });

  editor.insertDraftAbove(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });
  const inserted = await editor.commitInsertRow(tab, rowId);

  assert.equal(inserted, true);
  assert.deepEqual(invokeCalls.find((call) => call.command === "insert_row"), {
    command: "insert_row",
    payload: { request: { sessionId: "session-1", draft: { id: "9001", name: "Dana", level: "20" } } },
  });
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

test("multi-row insert selections paste and copy by visual bounds in either drag direction", async () => {
  for (const reverse of [false, true]) {
    const clipboard = { text: "Dana\t20\nEli\t21", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
    const { editor, tab, editState } = createEditor({ clipboard });
    const first = editor.insertDraftAbove(tab, { row: tab.rows[1], rowIndex: 1 });
    const second = editor.insertDraftBelow(tab, { row: { __insertRowId: first.id }, rowIndex: 1 });
    editState.undoStack.length = 0;
    const model = editor.visualRowEntries(tab);
    const firstIndex = model.findIndex((entry) => entry.rowId === first.id);
    const secondIndex = model.findIndex((entry) => entry.rowId === second.id);
    const start = reverse
      ? { row: { __insertRowId: second.id }, column: "level", rowIndex: secondIndex, columnIndex: 1 }
      : { row: { __insertRowId: first.id }, column: "name", rowIndex: firstIndex, columnIndex: 0 };
    const end = reverse
      ? { row: { __insertRowId: first.id }, column: "name", rowIndex: firstIndex, columnIndex: 0 }
      : { row: { __insertRowId: second.id }, column: "level", rowIndex: secondIndex, columnIndex: 1 };

    editor.startRangeSelection(tab, start.row, start.column, start.rowIndex, start.columnIndex, { button: 0, preventDefault() {} });
    editor.extendRangeSelection(tab, end.row, end.column, end.rowIndex, end.columnIndex);
    editor.finishRangeSelection();
    await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

    assert.deepEqual([first.draft.name, first.draft.level], ["Dana", "20"]);
    assert.deepEqual([second.draft.name, second.draft.level], ["Eli", "21"]);
    assert.equal(editor.getVisibleInsertRows(tab).length, 2, "a bounded paste must not create an overflow draft row");
    assert.equal(editState.undoStack.length, 1);

    await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
    assert.equal(clipboard.text, "Dana\t20\nEli\t21");
  }
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

test("input paste event intercepts TSV and fills multiple insert rows without a stale blur overwrite", async () => {
  const { editor, tab } = createEditor({
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }, { column_name: "level" }],
  });

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.startEditing(tab, { __insertRowId: rowId }, "id", tab.rows.length, 0);
  let prevented = false;
  let stopped = false;
  const handled = await editor.pasteIntoInsertInput(tab, rowId, 0, {
    clipboardData: { getData: () => "9\tDana\t20\n10\tEli\t21" },
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  });
  const rows = editor.getInsertRows(tab);

  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(editor.editingCell.value, null);
  assert.deepEqual(editor.getInsertDraft(tab, rows[0].id), { id: "9", name: "Dana", level: "20" });
  assert.deepEqual(editor.getInsertDraft(tab, rows[1].id), { id: "10", name: "Eli", level: "21" });
});

test("single-value paste in an insert input remains a native caret edit", async () => {
  const { editor, tab } = createEditor();
  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  let prevented = false;

  const handled = await editor.pasteIntoInsertInput(tab, rowId, 0, {
    clipboardData: { getData: () => "native text" },
    preventDefault() { prevented = true; },
  });

  assert.equal(handled, false);
  assert.equal(prevented, false);
  assert.deepEqual(editor.getInsertDraft(tab, rowId), {});
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
  editor.insertDraftBelow(tab, null);
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

test("pasting rows copied from row headers fills unsaved rows and supports one undo", async () => {
  const { editor, tab, editState, invokeCalls, statusText } = createEditor();

  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[1]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  tab.selectedRowKeys.clear();
  editor.selectInsertRow(tab);
  const result = await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
  assert.deepEqual(result, { ok: true, draftRows: 2, insertedRows: 0 });
  assert.deepEqual(editor.getInsertRows(tab).map((row) => row.draft), [
    { name: "Alice", level: "10", guild: "Red" },
    { name: "Bob", level: "12", guild: "Blue" },
  ]);
  assert.match(statusText.value, /保存后写入数据库/);

  const undo = useUndo(editState, async () => {
    throw new Error("draft undo must stay local");
  }, computed(() => tab), {
    statusText,
    applyLocalHistoryEntry: editor.applyInsertDraftHistoryEntry,
  });
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => editor.getInsertRows(tab).length === 1, "undo should restore the original empty draft");
  assert.deepEqual(editor.getInsertRows(tab)[0].draft, {});

  undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => editor.getInsertRows(tab).length === 2, "redo should restore both pasted drafts");
  assert.deepEqual(editor.getInsertRows(tab).map((row) => row.draft.name), ["Alice", "Bob"]);
});

test("pasting copied rows targets insert rows selected by row-header drag state", async () => {
  const { editor, tab, invokeCalls } = createEditor();
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[1]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true });
  tab.selectedRowKeys.clear();

  const first = editor.insertDraftAbove(tab, { row: tab.rows[1], rowIndex: 1 });
  const second = editor.insertDraftBelow(tab, { row: { __insertRowId: first.id }, rowIndex: 1 });
  editor.clearSelection();
  tab.selectedRowKeys.add(editor.getInsertRowKey(tab, first.id));
  tab.selectedRowKeys.add(editor.getInsertRowKey(tab, second.id));
  assert.equal(editor.selectedInsertRow.value, null);

  const result = await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.deepEqual(result, { ok: true, draftRows: 2, insertedRows: 0 });
  assert.deepEqual([first.draft, second.draft], [
    { name: "Alice", level: "10", guild: "Red" },
    { name: "Bob", level: "12", guild: "Blue" },
  ]);
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
});

test("full-row paste maps mixed row-header targets in visual order with one undo and redo", async () => {
  const { editor, tab, editState, invokeCalls } = createEditor();
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[2]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true });
  tab.selectedRowKeys.clear();

  const insertRow = editor.insertDraftAbove(tab, { row: tab.rows[1], rowIndex: 1 });
  const savedRow = tab.rows[1];
  const originalSavedRow = { ...savedRow };
  editState.undoStack.length = 0;
  tab.selectedRowKeys.add(editor.getInsertRowKey(tab, insertRow.id));
  tab.selectedRowKeys.add(buildRowKey(tab, savedRow));

  const result = await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.equal(result.ok, true);
  assert.deepEqual(insertRow.draft, { name: "Alice", level: "10", guild: "Red" });
  assert.deepEqual(savedRow, { ...originalSavedRow, name: "Cara", level: "14", guild: "Green" });
  assert.equal(editor.getInsertRows(tab).length, 1, "mixed paste must not create an overflow draft");
  assert.equal(invokeCalls.filter((call) => call.command === "update_cells").length, 1);
  assert.equal(editState.undoStack.length, 1);
  assert.equal(editState.undoStack[0].kind, "history-composite");

  const undo = useUndo(editState, async () => ({ updated: 1 }), computed(() => tab), {
    statusText: { value: "" },
    applyLocalHistoryEntry: editor.applyInsertDraftHistoryEntry,
  });
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => editState.redoStack.length === 1, "mixed paste undo should settle");
  assert.deepEqual(insertRow.draft, {});
  assert.deepEqual(savedRow, originalSavedRow);

  undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => editState.undoStack.length === 1, "mixed paste redo should settle");
  assert.deepEqual(insertRow.draft, { name: "Alice", level: "10", guild: "Red" });
  assert.deepEqual(savedRow, { ...originalSavedRow, name: "Cara", level: "14", guild: "Green" });
});

test("full-row paste maps saved row-header targets in visual order with strict row counts and one undo", async () => {
  const clipboard = {
    text: "",
    async writeText(text) { this.text = text; },
    async readText() { return this.text; },
  };
  const columns = [
    { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
    { column_name: "name", column_type: "varchar(32)" },
    { column_name: "level", column_type: "int" },
    { column_name: "guild", column_type: "varchar(32)" },
  ];
  const source = createEditor({ clipboard, columns });
  source.tab.primaryKeys = ["id"];
  source.tab.rows = [
    { id: "10", name: "Dora", level: "20", guild: "Gold" },
    { id: "11", name: "Evan", level: "21", guild: "Silver" },
  ];
  source.tab.selectedRowKeys.add(buildRowKey(source.tab, source.tab.rows[0]));
  source.tab.selectedRowKeys.add(buildRowKey(source.tab, source.tab.rows[1]));
  await source.editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true });

  const target = createEditor({ clipboard, columns });
  target.tab.primaryKeys = ["id"];
  const beforeRows = target.tab.rows.map((row) => ({ ...row }));
  target.tab.selectedRowKeys.add(buildRowKey(target.tab, target.tab.rows[0]));

  const mismatch = await target.editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.equal(mismatch.ok, false);
  assert.deepEqual(target.tab.rows, beforeRows);
  assert.equal(target.invokeCalls.length, 0);
  assert.match(target.statusText.value, /复制了 2 行.*目标行头选区包含 1 行/);

  target.tab.selectedRowKeys.add(buildRowKey(target.tab, target.tab.rows[1]));
  const result = await target.editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.equal(result.ok, true);
  assert.deepEqual(target.tab.rows.slice(0, 2), source.tab.rows);
  assert.equal(target.invokeCalls.filter((call) => call.command === "update_cells").length, 1);
  assert.equal(target.editState.undoStack.length, 1);

  const undo = useUndo(target.editState, async (command, payload) => {
    assert.equal(command, "update_cells");
    return { updated: payload.request.rows.length, conflict: false };
  }, computed(() => target.tab), {
    statusText: target.statusText,
    applyLocalHistoryEntry: target.editor.applyInsertDraftHistoryEntry,
  });
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => target.editState.redoStack.length === 1, "saved-row paste undo should settle");
  assert.deepEqual(target.tab.rows, beforeRows);

  undo.handleRedoKeydown({ key: "y", ctrlKey: true, preventDefault() {} });
  await waitForTestCondition(() => target.editState.undoStack.length === 1, "saved-row paste redo should settle");
  assert.deepEqual(target.tab.rows.slice(0, 2), source.tab.rows);
});

test("mixed full-row paste counts draft successes and moves validation errors with a changed primary key", async () => {
  const clipboard = {
    text: "",
    async writeText(text) { this.text = text; },
    async readText() { return this.text; },
  };
  const source = createEditor({
    clipboard,
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true },
      { column_name: "name", column_type: "varchar(32)" },
      { column_name: "level", column_type: "varchar(32)" },
    ],
  });
  source.tab.primaryKeys = ["id"];
  source.tab.rows = [
    { id: "3", name: "Draft", level: "30" },
    { id: "4", name: "Changed", level: "bad" },
  ];
  source.tab.selectedRowKeys.add(buildRowKey(source.tab, source.tab.rows[0]));
  source.tab.selectedRowKeys.add(buildRowKey(source.tab, source.tab.rows[1]));
  await source.editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true });

  const target = createEditor({
    clipboard,
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "name", column_type: "varchar(32)" },
      { column_name: "level", column_type: "int" },
    ],
  });
  target.tab.primaryKeys = ["id"];
  target.tab.rows = [
    { id: "1", name: "One", level: "10" },
    { id: "2", name: "Two", level: "20" },
  ];
  const insertRow = target.editor.insertDraftAbove(target.tab, { row: target.tab.rows[1], rowIndex: 1 });
  const savedRow = target.tab.rows[1];
  const originalSavedRow = { ...savedRow };
  const oldRowKey = buildRowKey(target.tab, savedRow);
  target.editState.undoStack.length = 0;
  target.tab.selectedRowKeys.add(target.editor.getInsertRowKey(target.tab, insertRow.id));
  target.tab.selectedRowKeys.add(oldRowKey);

  const result = await target.editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  const newRowKey = buildRowKey(target.tab, savedRow);
  assert.equal(result.ok, false);
  assert.equal(result.successCount, 5);
  assert.equal(result.failureCount, 1);
  assert.match(target.statusText.value, /成功 5 个，失败 1 个/);
  assert.deepEqual(insertRow.draft, { id: "3", name: "Draft", level: "30" });
  assert.deepEqual(savedRow, { id: "4", name: "Changed", level: "20" });
  assert.equal(getCellError(target.editState, target.tab.tableName, oldRowKey, "level"), "");
  assert.match(getCellError(target.editState, target.tab.tableName, newRowKey, "level"), /需要整数/);
  assert.equal(target.editState.undoStack[0]?.kind, "history-composite");

  const undo = useUndo(target.editState, async (command, payload) => {
    assert.equal(command, "update_cells");
    return { updated: payload.request.rows.length, conflict: false };
  }, computed(() => target.tab), {
    statusText: target.statusText,
    applyLocalHistoryEntry: target.editor.applyInsertDraftHistoryEntry,
  });
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => target.editState.redoStack.length === 1, "partial mixed paste undo should settle");
  assert.deepEqual(savedRow, originalSavedRow);
  assert.deepEqual(insertRow.draft, {});
  assert.equal(getCellError(target.editState, target.tab.tableName, oldRowKey, "level"), "");
});

test("failed mixed full-row paste restores saved and insert rows without history", async () => {
  const { editor, tab, editState, invokeCalls, statusText } = createEditor({
    invokeWorkbench(command) {
      if (command === "update_cells") throw new Error("atomic save failed");
      return {};
    },
  });
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[2]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true });
  tab.selectedRowKeys.clear();

  const insertRow = editor.insertDraftAbove(tab, { row: tab.rows[1], rowIndex: 1 });
  editor.updateInsertDraft(tab, insertRow.id, "name", "Draft before paste");
  const originalDraft = { ...insertRow.draft };
  const savedRow = tab.rows[1];
  const originalSavedRow = { ...savedRow };
  editState.undoStack.length = 0;
  tab.selectedRowKeys.add(editor.getInsertRowKey(tab, insertRow.id));
  tab.selectedRowKeys.add(buildRowKey(tab, savedRow));

  const result = await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.equal(result.ok, false);
  assert.deepEqual(insertRow.draft, originalDraft);
  assert.deepEqual(savedRow, originalSavedRow);
  assert.equal(editor.getInsertRows(tab).length, 1);
  assert.equal(invokeCalls.filter((call) => call.command === "update_cells").length, 1);
  assert.equal(editState.undoStack.length, 0);
  assert.match(statusText.value, /atomic save failed/);
});

test("failed pending mixed paste rebases a later draft edit before undo", async () => {
  let rejectPaste;
  const { editor, tab, editState, statusText } = createEditor({
    invokeWorkbench(command) {
      if (command !== "update_cells") return {};
      return new Promise((_resolve, reject) => { rejectPaste = reject; });
    },
  });
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[2]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true });
  tab.selectedRowKeys.clear();

  const insertRow = editor.insertDraftAbove(tab, { row: tab.rows[1], rowIndex: 1 });
  editor.updateInsertDraft(tab, insertRow.id, "name", "Before");
  editState.undoStack.length = 0;
  tab.selectedRowKeys.add(editor.getInsertRowKey(tab, insertRow.id));
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[1]));

  const failedPaste = editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });
  await waitForTestCondition(() => typeof rejectPaste === "function", "mixed paste should reach the backend");
  tab.selectedRowKeys.clear();
  editor.selectInsertCell(tab, insertRow.id, 0);
  await editor.pasteGridText("Later");

  rejectPaste(new Error("backend failed"));
  const failedResult = await failedPaste;
  assert.equal(failedResult.ok, false);
  assert.deepEqual(insertRow.draft, { name: "Later" });
  assert.equal(editState.undoStack.length, 1);

  const undo = useUndo(editState, async () => {
    throw new Error("later draft undo must stay local");
  }, computed(() => tab), {
    statusText,
    applyLocalHistoryEntry: editor.applyInsertDraftHistoryEntry,
  });
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => editState.redoStack.length === 1, "later draft undo should settle");
  assert.deepEqual(insertRow.draft, { name: "Before" });
});

test("insert drafts stay with the tab when a different pane editor takes over", () => {
  const firstPane = createEditor();

  firstPane.editor.insertDraftAbove(firstPane.tab, 1);
  const rowId = firstPane.editor.selectedInsertCell.value.rowId;
  firstPane.editor.updateInsertDraft(firstPane.tab, rowId, "name", "Dana");

  const secondPane = createEditor({ tab: firstPane.tab });

  assert.deepEqual(secondPane.editor.getInsertDraft(firstPane.tab, rowId), { name: "Dana" });
  assert.equal(secondPane.editor.getInsertRows(firstPane.tab), firstPane.tab.insertDrafts);
  secondPane.editor.updateInsertDraft(firstPane.tab, rowId, "level", "20");
  assert.deepEqual(firstPane.editor.getInsertDraft(firstPane.tab, rowId), { name: "Dana", level: "20" });
});

test("insert save reservations remain shared when another pane editor takes over", async () => {
  let releaseInsert;
  const firstPane = createEditor({
    invokeWorkbench(command) {
      if (command !== "insert_row") return {};
      return new Promise((resolve) => { releaseInsert = resolve; });
    },
  });
  firstPane.editor.selectInsertCell(firstPane.tab, 0);
  const rowId = firstPane.editor.selectedInsertCell.value.rowId;
  firstPane.editor.updateInsertDraft(firstPane.tab, rowId, "name", "Dana");

  const firstSave = firstPane.editor.commitInsertRows(firstPane.tab, { rowIds: [rowId] });
  const secondPane = createEditor({
    tab: firstPane.tab,
    editState: firstPane.editState,
    invokeWorkbench(command) {
      throw new Error(`second pane must not invoke ${command}`);
    },
  });

  assert.equal(secondPane.editor.isInsertRowSaving(firstPane.tab, rowId), true);
  secondPane.editor.updateInsertDraft(firstPane.tab, rowId, "name", "duplicate");
  assert.deepEqual(secondPane.editor.getInsertDraft(firstPane.tab, rowId), { name: "Dana" });
  assert.equal(secondPane.editor.clearInsertDraft(firstPane.tab, rowId), false);
  assert.deepEqual(secondPane.editor.getInsertDraft(firstPane.tab, rowId), { name: "Dana" });
  const secondSave = secondPane.editor.commitInsertRows(firstPane.tab, { rowIds: [rowId] });

  await waitForTestCondition(() => typeof releaseInsert === "function", "the shared insert request should start");
  releaseInsert({ affected: 1 });
  assert.deepEqual(await firstSave, { insertedRows: 1, failedRowId: null });
  assert.deepEqual(await secondSave, { insertedRows: 1, failedRowId: null });
  assert.equal(firstPane.invokeCalls.filter((call) => call.command === "insert_row").length, 1);
  assert.equal(secondPane.invokeCalls.filter((call) => call.command === "insert_row").length, 0);
});

test("pasting a copied row maps by column name and skips generated values", async () => {
  const { editor, tab } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, extra: "auto_increment" },
      { column_name: "name", column_type: "varchar" },
      { column_name: "slug", column_type: "varchar", is_generated: true },
      { column_name: "status", column_type: "varchar" },
    ],
  });
  tab.rows = [{ id: "7", name: "Alice", slug: "alice", status: "active" }];
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  tab.selectedRowKeys.clear();
  tab.columns = [tab.columns[3], tab.columns[2], tab.columns[1], tab.columns[0]];
  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(editor.getInsertDraft(tab, rowId), { name: "Alice", status: "active" });
});

test("positional pastes skip auto-increment and generated columns for saved and insert rows", async () => {
  const columns = [
    { column_name: "id", column_type: "int", is_primary_key: true, extra: "auto_increment" },
    { column_name: "name", column_type: "varchar" },
    { column_name: "slug", column_type: "varchar", is_generated: true },
    { column_name: "updated_at", column_type: "timestamp", is_generated: false, extra: "DEFAULT_GENERATED" },
    { column_name: "status", column_type: "varchar" },
  ];
  const saved = createEditor({ columns });
  saved.tab.rows = [{
    id: "7",
    name: "Alice",
    slug: "alice",
    updated_at: "2025-01-01 00:00:00",
    status: "old",
  }];
  saved.editor.selectCell(saved.tab, saved.tab.rows[0], "id", 0, 0);

  const savedResult = await saved.editor.pasteGridText("999\tDana\tblocked\t2026-07-19 12:34:56\tactive");

  assert.equal(savedResult.ok, true);
  assert.deepEqual(saved.tab.rows[0], {
    id: "7",
    name: "Dana",
    slug: "alice",
    updated_at: "2026-07-19 12:34:56",
    status: "active",
  });
  assert.deepEqual(
    saved.invokeCalls[0].payload.request.rows[0].changes.map((change) => change.columnName),
    ["name", "updated_at", "status"],
  );

  const inserted = createEditor({ columns });
  inserted.editor.selectInsertCell(inserted.tab, 0);
  const rowId = inserted.editor.selectedInsertCell.value.rowId;

  const insertResult = await inserted.editor.pasteGridText("999\tDana\tblocked\t2026-07-19 12:34:56\tactive");

  assert.equal(insertResult.ok, true);
  assert.deepEqual(inserted.editor.getInsertDraft(inserted.tab, rowId), {
    name: "Dana",
    updated_at: "2026-07-19 12:34:56",
    status: "active",
  });
  assert.equal(inserted.invokeCalls.length, 0);
});

test("a generated-only range paste is rejected with zero saved or draft writes", async () => {
  const { editor, tab, editState, invokeCalls, statusText } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true },
      { column_name: "slug", column_type: "varchar", extra: "VIRTUAL GENERATED" },
    ],
  });
  tab.rows = [
    { id: "1", slug: "alice" },
    { id: "2", slug: "bob" },
  ];
  const insertRow = editor.insertDraftAbove(tab, { row: tab.rows[1], rowIndex: 1 });
  editState.undoStack.length = 0;
  const model = editor.visualRowEntries(tab);
  const insertIndex = model.findIndex((entry) => entry.rowId === insertRow.id);
  const savedIndex = model.findIndex((entry) => entry.type === "data" && entry.dataIndex === 1);
  editor.startRangeSelection(tab, { __insertRowId: insertRow.id }, "slug", insertIndex, 1, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "slug", savedIndex, 1);
  editor.finishRangeSelection();

  const result = await editor.pasteGridText("draft-slug\nsaved-slug");

  assert.equal(result.ok, false);
  assert.deepEqual(insertRow.draft, {});
  assert.equal(tab.rows[1].slug, "bob");
  assert.equal(invokeCalls.length, 0);
  assert.equal(editState.undoStack.length, 0);
  assert.equal(statusText.value, "无法粘贴：目标只包含数据库生成字段");
});

test("saved insert uses the database-returned row with generated values", async () => {
  const { editor, tab } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_auto_increment: true },
      { column_name: "name", column_type: "varchar" },
      { column_name: "status", column_type: "varchar", default_value: "active" },
    ],
    invokeWorkbench(command) {
      if (command !== "insert_row") return {};
      return {
        affected: 1,
        row: { id: "42", name: "Dana", status: "active" },
        rowIdentity: { id: "42" },
        nullColumns: [],
      };
    },
  });
  tab.primaryKeys = ["id"];
  tab.rows = [{ id: "1", name: "Alice", status: "active" }];

  editor.selectInsertCell(tab, 1);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "name", "Dana");

  const inserted = await editor.commitInsertRow(tab, rowId);

  assert.equal(inserted, true);
  assert.deepEqual(tab.rows.at(-1), { id: "42", name: "Dana", status: "active" });
  assert.equal(editor.getInsertRows(tab).length, 0);
});

test("saving all drafts preserves an explicitly entered empty string", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [{ column_name: "note", column_type: "varchar", is_nullable: false }],
  });
  tab.rows = [{ note: "existing" }];

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "note", "");

  const result = await editor.commitInsertRows(tab);

  assert.equal(result.insertedRows, 1);
  assert.deepEqual(invokeCalls.filter((call) => call.command === "insert_row"), [
    { command: "insert_row", payload: { request: { sessionId: "session-1", draft: { note: "" } } } },
  ]);
});

test("saving a selected empty insert row creates a database-default row", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_auto_increment: true },
      { column_name: "created_at", column_type: "timestamp", default_mode: "expression" },
    ],
    invokeWorkbench(command) {
      if (command !== "insert_row") return {};
      return {
        affected: 1,
        row: { id: "4", created_at: "2026-07-18 12:00:00" },
        rowIdentity: { id: "4" },
        nullColumns: [],
      };
    },
  });
  tab.primaryKeys = ["id"];
  tab.rows = [{ id: "1", created_at: "2026-07-17 12:00:00" }];

  editor.selectInsertCell(tab, 1);
  const rowId = editor.selectedInsertCell.value.rowId;

  const inserted = await editor.commitInsertRow(tab, rowId);

  assert.equal(inserted, true);
  assert.deepEqual(invokeCalls.filter((call) => call.command === "insert_row"), [
    { command: "insert_row", payload: { request: { sessionId: "session-1", draft: {} } } },
  ]);
  assert.deepEqual(tab.rows.at(-1), { id: "4", created_at: "2026-07-18 12:00:00" });
});

test("detail save commits only the selected insert row", async () => {
  const { editor, tab, invokeCalls } = createEditor();

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  editor.insertDraftBelow(tab, null);
  const secondRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, secondRowId, "name", "Eli");
  editor.selectInsertCell(tab, firstRowId, 0);
  editor.textDraft.value = "Dana";

  const result = await editor.saveTextPanel();

  assert.equal(result.insertedRows, 1);
  assert.equal(invokeCalls.filter((call) => call.command === "insert_row").length, 1);
  assert.equal(editor.getInsertRows(tab).some((row) => row.id === firstRowId), false);
  assert.deepEqual(editor.getInsertDraft(tab, secondRowId), { name: "Eli" });
});

test("repeated save while inserts are pending does not submit the same draft twice", async () => {
  let releaseInsert;
  const pendingInsert = new Promise((resolve) => {
    releaseInsert = resolve;
  });
  const { editor, tab, invokeCalls } = createEditor({
    invokeWorkbench(command) {
      return command === "insert_row" ? pendingInsert : {};
    },
  });
  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "name", "Dana");

  const firstSave = editor.commitInsertRows(tab);
  const secondSave = editor.commitInsertRows(tab);
  await waitForTestCondition(
    () => invokeCalls.filter((call) => call.command === "insert_row").length === 1,
    "the shared insert request should start",
  );

  assert.equal(invokeCalls.filter((call) => call.command === "insert_row").length, 1);
  releaseInsert({ affected: 1 });
  assert.deepEqual(await firstSave, { insertedRows: 1, failedRowId: null });
  assert.deepEqual(await secondSave, { insertedRows: 1, failedRowId: null });
});

test("saving one insert row cannot duplicate an overlapping save-all request", async () => {
  let releaseInsert;
  const pendingInsert = new Promise((resolve) => { releaseInsert = resolve; });
  const { editor, tab, invokeCalls } = createEditor({
    invokeWorkbench(command) {
      return command === "insert_row" ? pendingInsert : {};
    },
  });
  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "name", "Dana");

  const saveAll = editor.commitInsertRows(tab);
  const saveRow = editor.commitInsertRow(tab, rowId);
  await waitForTestCondition(
    () => invokeCalls.filter((call) => call.command === "insert_row").length === 1,
    "the save-all insert request should start",
  );

  assert.equal(invokeCalls.filter((call) => call.command === "insert_row").length, 1);
  assert.equal(editor.isInsertRowSaving(tab, rowId), true);
  assert.equal(editor.removeInsertDraftRow(tab, rowId), false);
  assert.equal(editor.getInsertRows(tab).some((row) => row.id === rowId), true);
  releaseInsert({ affected: 1 });
  assert.deepEqual(await saveAll, { insertedRows: 1, failedRowId: null });
  assert.equal(await saveRow, true);
});

test("queued insert save freezes the active input value and locks the draft immediately", async () => {
  let releaseCellSave;
  const { editor, tab, invokeCalls } = createEditor({
    invokeWorkbench(command) {
      if (command === "update_cell") {
        return new Promise((resolve) => { releaseCellSave = resolve; });
      }
      if (command === "insert_row") return { affected: 1 };
      return {};
    },
  });
  const cellSave = editor.commitCellValue(tab, tab.rows[0], "name", "Queued");
  await waitForTestCondition(() => typeof releaseCellSave === "function", "the cell save should block the mutation queue");

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.startEditing(tab, { __insertRowId: rowId }, "name", 3, 0);
  editor.editDraft.value = "Dana at click";
  const insertSave = editor.commitInsertRows(tab, { rowIds: [rowId] });

  assert.equal(editor.isInsertRowSaving(tab, rowId), true);
  assert.deepEqual(editor.getInsertDraft(tab, rowId), { name: "Dana at click" });
  editor.updateInsertDraft(tab, rowId, "name", "changed after click");
  assert.deepEqual(editor.getInsertDraft(tab, rowId), { name: "Dana at click" });
  assert.equal(invokeCalls.filter((call) => call.command === "insert_row").length, 0);

  releaseCellSave({ updated: true, conflict: false, value: "Queued" });
  await cellSave;
  assert.deepEqual(await insertSave, { insertedRows: 1, failedRowId: null });
  assert.deepEqual(invokeCalls.find((call) => call.command === "insert_row")?.payload.request.draft, {
    name: "Dana at click",
  });
});

test("save-all freezes its row set and leaves drafts created after the click unsaved", async () => {
  let releaseCellSave;
  const { editor, tab, invokeCalls } = createEditor({
    invokeWorkbench(command) {
      if (command === "update_cell") {
        return new Promise((resolve) => { releaseCellSave = resolve; });
      }
      if (command === "insert_row") return { affected: 1 };
      return {};
    },
  });
  const cellSave = editor.commitCellValue(tab, tab.rows[0], "name", "Queued");
  await waitForTestCondition(() => typeof releaseCellSave === "function", "the cell save should block the mutation queue");

  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  const saveAll = editor.commitInsertRows(tab);
  editor.insertDraftBelow(tab, null);
  const laterRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, laterRowId, "name", "Eli later");

  assert.equal(editor.isInsertRowSaving(tab, firstRowId), true);
  assert.equal(editor.isInsertRowSaving(tab, laterRowId), false);
  releaseCellSave({ updated: true, conflict: false, value: "Queued" });
  await cellSave;
  assert.deepEqual(await saveAll, { insertedRows: 1, failedRowId: null });
  assert.deepEqual(
    invokeCalls.filter((call) => call.command === "insert_row").map((call) => call.payload.request.draft),
    [{ name: "Dana" }],
  );
  assert.deepEqual(editor.getInsertDraft(tab, laterRowId), { name: "Eli later" });
});

test("single-row save followed by save-all reuses the row reservation in both directions", async () => {
  let releaseDana;
  const { editor, tab, invokeCalls } = createEditor({
    invokeWorkbench(command, payload) {
      if (command !== "insert_row") return {};
      if (payload.request.draft.name === "Dana") {
        return new Promise((resolve) => { releaseDana = resolve; });
      }
      return { affected: 1 };
    },
  });
  editor.selectInsertCell(tab, 0);
  const danaId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, danaId, "name", "Dana");
  editor.insertDraftBelow(tab, null);
  const eliId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, eliId, "name", "Eli");

  const saveDana = editor.commitInsertRow(tab, danaId);
  await waitForTestCondition(() => typeof releaseDana === "function", "the first row save should start");
  const saveAll = editor.commitInsertRows(tab);
  assert.equal(editor.isInsertRowSaving(tab, danaId), true);
  assert.equal(editor.isInsertRowSaving(tab, eliId), true);

  releaseDana({ affected: 1 });
  assert.equal(await saveDana, true);
  assert.deepEqual(await saveAll, { insertedRows: 2, failedRowId: null });
  assert.deepEqual(
    invokeCalls.filter((call) => call.command === "insert_row").map((call) => call.payload.request.draft.name),
    ["Dana", "Eli"],
  );
});

test("a failed multi-row insert request unlocks every reserved draft", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    invokeWorkbench(command) {
      if (command === "insert_row") throw new Error("database unavailable");
      return {};
    },
  });
  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, firstRowId, "name", "Dana");
  editor.insertDraftBelow(tab, null);
  const secondRowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, secondRowId, "name", "Eli");

  const save = editor.commitInsertRows(tab);
  assert.equal(editor.isInsertRowSaving(tab, firstRowId), true);
  assert.equal(editor.isInsertRowSaving(tab, secondRowId), true);
  const result = await save;

  assert.equal(result.insertedRows, 0);
  assert.equal(result.failedRowId, firstRowId);
  assert.equal(editor.isInsertRowSaving(tab, firstRowId), false);
  assert.equal(editor.isInsertRowSaving(tab, secondRowId), false);
  assert.deepEqual(editor.getInsertDraft(tab, firstRowId), { name: "Dana" });
  assert.deepEqual(editor.getInsertDraft(tab, secondRowId), { name: "Eli" });
  assert.equal(invokeCalls.filter((call) => call.command === "insert_row").length, 1);
});

test("pasting a copied single cell into the selected insert row is rejected", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor();

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  editor.selectInsertRow(tab);
  const result = await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(result, {
    ok: false,
    insertedRows: 0,
    message: "请先通过行号复制整行，再粘贴到新增行",
  });
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
  assert.match(statusText.value, /行号复制整行/);
});

test("multi-cell insert paste scans loaded primary keys once", async () => {
  const clipboard = { text: "9001\tDana\t20\n9002\tEli\t21", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab } = createEditor({
    clipboard,
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
      { column_name: "level" },
    ],
  });
  let primaryKeyReads = 0;
  tab.rows = Array.from({ length: 1_000 }, (_, index) => ({
    get id() {
      primaryKeyReads += 1;
      return String(index + 1);
    },
    name: `row-${index + 1}`,
    level: String(index),
  }));
  editor.selectInsertCell(tab, 0);
  primaryKeyReads = 0;

  await editor.handleGridKeydown({ key: "v", ctrlKey: true, preventDefault() {} });

  assert.ok(primaryKeyReads <= 1_005, `expected one loaded-row scan, saw ${primaryKeyReads} primary-key reads`);
});

test("pasting a row copied from a row header keeps primary key values in the unsaved draft", async () => {
  const clipboard = { text: "", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls } = createEditor({
    clipboard,
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }, { column_name: "level" }],
  });
  tab.rows = [{ id: "9", name: "Dana", level: "20" }];

  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  tab.selectedRowKeys.clear();
  tab.rows = [];
  editor.selectInsertRow(tab);
  const result = await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(result, { ok: true, draftRows: 1, insertedRows: 0 });
  assert.equal(invokeCalls.some((call) => call.command === "insert_row"), false);
  assert.deepEqual(editor.getInsertRows(tab)[0].draft, { id: "9", name: "Dana", level: "20" });
});

test("pasting TSV commits multiple cells from the selected range anchor", async () => {
  const clipboard = { text: "Ann\t20\nBen\t21", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, editState, invokeCalls, statusText } = createEditor({ clipboard });

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(updatedCellCount(invokeCalls), 4);
  assert.equal(tab.rows[0].name, "Ann");
  assert.equal(tab.rows[1].level, "21");
  assert.match(statusText.value, /4/);
  assert.equal(editState.undoStack.length, 1);
  assert.equal(editState.undoStack[0].kind, "cell-batch");
  assert.equal(editState.undoStack[0].entries.length, 4);
});

test("pasting a copied multiline cell preserves the whole value in one target cell", async () => {
  const { editor, tab, clipboard, invokeCalls } = createEditor();
  const multilineValue = "first line\nsecond line\nthird line";
  tab.rows[0].name = multilineValue;

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  assert.equal(clipboard.text, `"${multilineValue}"`);

  editor.selectCell(tab, tab.rows[1], "name", 1, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(tab.rows[1].name, multilineValue);
  assert.equal(tab.rows[2].name, "Cara");
  assert.equal(updatedCellCount(invokeCalls), 1);
});

test("pasting a copied multiline cell into SQL NULL sends null as the old value", async () => {
  const { editor, tab, clipboard, invokeCalls } = createEditor();
  const multilineValue = "function(curLvl) {\n  return curLvl - 1;\n}";
  tab.rows[0].name = multilineValue;
  tab.rows[1].name = null;

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  assert.equal(clipboard.text, `"${multilineValue}"`);

  editor.selectCell(tab, tab.rows[1], "name", 1, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  const update = invokeCalls.find((call) => call.command === "update_cell");
  assert.equal(update?.payload.request.oldValue, null);
  assert.equal(update?.payload.request.newValue, multilineValue);
  assert.equal(tab.rows[1].name, multilineValue);
});

test("pasting one copied cell fills every cell in the selected range", async () => {
  const { editor, tab, invokeCalls, statusText, saveFeedback } = createEditor();

  editor.selectCell(tab, tab.rows[2], "guild", 2, 2);
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();

  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(updatedCellCount(invokeCalls), 4);
  assert.equal(tab.rows[0].name, "Green");
  assert.equal(tab.rows[0].level, "Green");
  assert.equal(tab.rows[1].name, "Green");
  assert.equal(tab.rows[1].level, "Green");
  assert.equal(statusText.value, "已粘贴 4 个单元格");
  assert.equal(saveFeedback.length, 2, "copy feedback plus one aggregate paste feedback");
  assert.equal(saveFeedback.at(-1).kind, "success");
  assert.equal(saveFeedback.at(-1).message, "已粘贴 4 个单元格");
});

test("pasting a copied row pattern fills every selected row from the top-left", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor();
  tab.rows.push(
    { id: "4", name: "Dora", level: "16", guild: "Yellow" },
    { id: "5", name: "1", level: "100", guild: "Source" },
  );

  editor.startRangeSelection(tab, tab.rows[4], "name", 4, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[4], "level", 4, 1);
  editor.finishRangeSelection();
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  // Select bottom-right to top-left to verify paste is independent of drag direction.
  editor.startRangeSelection(tab, tab.rows[3], "level", 3, 1, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[0], "name", 0, 0);
  editor.finishRangeSelection();
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(
    tab.rows.slice(0, 4).map((row) => [row.name, row.level]),
    [["1", "100"], ["1", "100"], ["1", "100"], ["1", "100"]],
  );
  assert.equal(updatedCellCount(invokeCalls), 8);
  assert.equal(statusText.value, "已粘贴 8 个单元格");
});

test("pasting a copied row pattern expands a multi-row single-column selection", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor();
  tab.rows.push(
    { id: "4", name: "Dora", level: "16", guild: "Yellow" },
    { id: "5", name: "1", level: "100", guild: "Source" },
  );

  editor.startRangeSelection(tab, tab.rows[4], "name", 4, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[4], "level", 4, 1);
  editor.finishRangeSelection();
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  editor.startRangeSelection(tab, tab.rows[3], "name", 3, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[0], "name", 0, 0);
  editor.finishRangeSelection();
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(
    tab.rows.slice(0, 4).map((row) => [row.name, row.level]),
    [["1", "100"], ["1", "100"], ["1", "100"], ["1", "100"]],
  );
  assert.equal(updatedCellCount(invokeCalls), 8);
  assert.equal(statusText.value, "已粘贴 8 个单元格");
});

test("pasting an exact-size matrix maps one-to-one into the selected range", async () => {
  const clipboard = { text: "Ann\t20\nBen\t21", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls, statusText } = createEditor({ clipboard });

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(
    tab.rows.slice(0, 2).map((row) => [row.name, row.level]),
    [["Ann", "20"], ["Ben", "21"]],
  );
  assert.equal(updatedCellCount(invokeCalls), 4);
  assert.equal(statusText.value, "已粘贴 4 个单元格");
});

test("pasting into an incompatible selected range is rejected before any write", async () => {
  const clipboard = { text: "1\t100", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls, statusText } = createEditor({ clipboard });
  const before = tab.rows.slice(0, 2).map((row) => [row.name, row.level, row.guild]);

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "guild", 1, 2);
  editor.finishRangeSelection();
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(tab.rows.slice(0, 2).map((row) => [row.name, row.level, row.guild]), before);
  assert.equal(updatedCellCount(invokeCalls), 0);
  assert.equal(statusText.value, "无法粘贴：剪贴板为 1×2，目标选区为 2×3；目标行列必须分别是剪贴板的整数倍");
});

test("pasting an irregular clipboard matrix is rejected before any write", async () => {
  const clipboard = { text: "A\tB\nC", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls, statusText } = createEditor({ clipboard });
  const before = tab.rows.slice(0, 2).map((row) => [row.name, row.level]);

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(tab.rows.slice(0, 2).map((row) => [row.name, row.level]), before);
  assert.equal(updatedCellCount(invokeCalls), 0);
  assert.equal(statusText.value, "无法粘贴：剪贴板数据不是规则矩形（2 行，各行 2/1 列），目标选区为 2×2");
});

test("sparse copy preserves a selected empty string and its mask across panes", async () => {
  const clipboard = { text: "", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const source = createEditor({ clipboard });
  source.tab.rows[0].name = "";
  pointerSelect(source.editor, source.tab, 0, 0);
  pointerSelect(source.editor, source.tab, 1, 1, { ctrlKey: true });

  await source.editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  assert.equal(clipboard.text, "\t\n\t12");

  const target = createEditor({ clipboard });
  pointerSelect(target.editor, target.tab, 1, 1);
  await target.editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(target.tab.rows[1].level, "", "selected empty string must overwrite its target");
  assert.equal(target.tab.rows[1].guild, "Blue", "source hole must not overwrite its target");
  assert.equal(target.tab.rows[2].level, "14", "source hole must not overwrite its target");
  assert.equal(target.tab.rows[2].guild, "12");
  assert.equal(updatedCellCount(target.invokeCalls), 2);
});

test("sparse clipboard holes do not clear existing insert-draft values", async () => {
  const { editor, tab, clipboard } = createEditor();
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 0, 2, { ctrlKey: true });
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true });
  assert.equal(clipboard.text, "Alice\t\tRed");

  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "level", "keep-me");
  const result = await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.deepEqual(result, { ok: true, draftRows: 1, pastedCells: 2, insertedRows: 0 });
  assert.deepEqual(editor.getInsertDraft(tab, rowId), {
    name: "Alice",
    level: "keep-me",
    guild: "Red",
  });
});

test("sparse clipboard masks tile over an integer-multiple rectangular target", async () => {
  const { editor, tab, invokeCalls } = createEditor();
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 0, 2, { ctrlKey: true });
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  pointerSelect(editor, tab, 1, 0);
  pointerSelect(editor, tab, 2, 2, { shiftKey: true });
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(
    tab.rows.slice(1).map((row) => [row.name, row.level, row.guild]),
    [["Alice", "12", "Red"], ["Alice", "14", "Red"]],
  );
  assert.equal(updatedCellCount(invokeCalls), 4);
});

test("sparse clipboard rejects an incompatible rectangular target before writing", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor();
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 0, 2, { ctrlKey: true });
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  const before = tab.rows.slice(1).map((row) => [row.name, row.level]);

  pointerSelect(editor, tab, 1, 0);
  pointerSelect(editor, tab, 2, 1, { shiftKey: true });
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(tab.rows.slice(1).map((row) => [row.name, row.level]), before);
  assert.equal(updatedCellCount(invokeCalls), 0);
  assert.match(statusText.value, /目标行列必须分别是剪贴板的整数倍/);
});

test("one clipboard value fills every member of a sparse target", async () => {
  const { editor, tab, invokeCalls } = createEditor();
  pointerSelect(editor, tab, 0, 0);
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  pointerSelect(editor, tab, 1, 0);
  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(tab.rows[1].name, "Alice");
  assert.equal(tab.rows[2].guild, "Alice");
  assert.equal(tab.rows[1].level, "12");
  assert.equal(tab.rows[2].level, "14");
  assert.equal(updatedCellCount(invokeCalls), 2);
});

test("multi-value paste into a sparse target requires the same internal mask", async () => {
  const { editor, tab, invokeCalls } = createEditor();
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 1, 1, { ctrlKey: true });
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  pointerSelect(editor, tab, 1, 1);
  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(tab.rows[1].level, "Alice");
  assert.equal(tab.rows[2].guild, "12");
  assert.equal(tab.rows[1].guild, "Blue");
  assert.equal(tab.rows[2].level, "14");
  assert.equal(updatedCellCount(invokeCalls), 2);
});

test("multi-value paste into a different sparse mask is rejected before writing", async () => {
  const { editor, tab, invokeCalls, statusText } = createEditor();
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 1, 1, { ctrlKey: true });
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  const before = tab.rows.slice(1).map((row) => [row.level, row.guild]);

  pointerSelect(editor, tab, 1, 2);
  pointerSelect(editor, tab, 2, 1, { ctrlKey: true });
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(tab.rows.slice(1).map((row) => [row.level, row.guild]), before);
  assert.equal(updatedCellCount(invokeCalls), 0);
  assert.match(statusText.value, /离散剪贴板布局 2×2 与目标选区 2×2 不匹配/);
});

test("external multi-value text is rejected for a sparse target", async () => {
  const clipboard = { text: "left\tright", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls, statusText } = createEditor({ clipboard });
  const before = tab.rows.map((row) => ({ ...row }));
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 0, 2, { ctrlKey: true });

  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(tab.rows, before);
  assert.equal(updatedCellCount(invokeCalls), 0);
  assert.match(statusText.value, /离散剪贴板布局 1×2 与目标选区 1×3 不匹配/);
});

test("paste preflights every target and performs zero writes when the range overflows", async () => {
  const clipboard = { text: "A\tB\nC\tD", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls, statusText } = createEditor({ clipboard });
  const before = tab.rows.map((row) => ({ ...row }));
  pointerSelect(editor, tab, 2, 2);

  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(tab.rows, before);
  assert.equal(updatedCellCount(invokeCalls), 0);
  assert.equal(statusText.value, "无法粘贴：目标范围超出已加载的可编辑区域");
});

test("sparse copy rejects a bounding area larger than 100,000 cells", async () => {
  const clipboard = { text: "unchanged", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, statusText } = createEditor({
    clipboard,
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }],
  });
  tab.rows = Array.from({ length: 50_001 }, (_, index) => ({ id: String(index + 1), name: `row-${index + 1}` }));
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 50_000, 1, { ctrlKey: true });

  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(clipboard.text, "unchanged");
  assert.equal(statusText.value, "无法复制：离散选区跨度为 50001×2，请缩小范围");
});

test("Ctrl+X copies and clears only sparse selection members", async () => {
  const { editor, tab, clipboard, invokeCalls } = createEditor({
    columns: [
      { column_name: "name", column_type: "varchar(50)", is_nullable: false },
      { column_name: "level", column_type: "int", is_nullable: false },
      { column_name: "guild", column_type: "varchar(50)", is_nullable: true },
    ],
  });
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });

  await editor.handleGridKeydown({ key: "x", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(clipboard.text, "Alice\t\t\n\t\t\n\t\tGreen");
  assert.equal(tab.rows[0].name, "");
  assert.equal(tab.rows[2].guild, "");
  assert.equal(tab.rows[1].name, "Bob");
  assert.equal(tab.rows[1].guild, "Blue");
  assert.equal(updatedCellCount(invokeCalls), 2);
});

test("Ctrl+X never clears cells when writing the clipboard fails", async () => {
  const clipboard = {
    text: "",
    async writeText() { throw new Error("clipboard denied"); },
    async readText() { return this.text; },
  };
  const { editor, tab, invokeCalls, statusText } = createEditor({
    clipboard,
    columns: [
      { column_name: "name", column_type: "varchar(50)", is_nullable: false },
      { column_name: "level", column_type: "int", is_nullable: false },
      { column_name: "guild", column_type: "varchar(50)", is_nullable: true },
    ],
  });
  const before = tab.rows.map((row) => ({ ...row }));
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });

  await editor.handleGridKeydown({ key: "x", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.deepEqual(tab.rows, before);
  assert.equal(updatedCellCount(invokeCalls), 0);
  assert.equal(statusText.value, "写入剪贴板失败，未剪切");
});

test("read-only Ctrl+X copies a sparse selection without clearing it", async () => {
  const { editor, tab, clipboard, invokeCalls } = createEditor({
    readOnly: true,
    columns: [
      { column_name: "name", column_type: "varchar(50)" },
      { column_name: "level", column_type: "int" },
      { column_name: "guild", column_type: "varchar(50)" },
    ],
  });
  const before = tab.rows.map((row) => ({ ...row }));
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });

  await editor.handleGridKeydown({ key: "x", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(clipboard.text, "Alice\t\t\n\t\t\n\t\tGreen");
  assert.deepEqual(tab.rows, before);
  assert.equal(updatedCellCount(invokeCalls), 0);
});

test("Delete clears sparse members while preserving primary-key cells and holes", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "name", column_type: "varchar(50)", is_nullable: false },
      { column_name: "guild", column_type: "varchar(50)", is_nullable: true },
    ],
  });
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });

  await editor.handleGridKeydown({ key: "Delete", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

  assert.equal(tab.rows[0].id, "1");
  assert.equal(tab.rows[2].guild, "");
  assert.equal(tab.rows[1].name, "Bob");
  assert.equal(updatedCellCount(invokeCalls), 1);
});

test("sparse paste validates each field and saves only valid targets", async () => {
  const clipboard = { text: "not-an-integer", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls, saveFeedback } = createEditor({
    clipboard,
    columns: [
      { column_name: "name", column_type: "varchar(50)", is_nullable: false },
      { column_name: "level", column_type: "int", is_nullable: false },
      { column_name: "guild", column_type: "varchar(50)", is_nullable: true },
    ],
  });
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 1, 1, { ctrlKey: true });

  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });

  assert.equal(tab.rows[0].name, "not-an-integer");
  assert.equal(tab.rows[1].level, "12");
  assert.equal(updatedCellCount(invokeCalls), 1);
  assert.equal(saveFeedback.length, 1);
  assert.equal(saveFeedback[0].kind, "error");
  assert.match(saveFeedback[0].message, /成功 1 个，失败 1 个/);
});

test("direct typing reports one aggregate failure for a sparse selection", async () => {
  const { editor, tab, saveFeedback } = createEditor({
    columns: [
      { column_name: "name", column_type: "varchar(50)" },
      { column_name: "level", column_type: "int" },
      { column_name: "guild", column_type: "varchar(50)" },
    ],
    invokeWorkbench(command) {
      if (command === "update_cells") throw new Error("数据库拒绝了该值");
      return {};
    },
  });
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });

  await editor.handleGridKeydown({ key: "x", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });
  await editor.finishEditing();

  assert.equal(tab.rows[0].name, "Alice");
  assert.equal(tab.rows[2].guild, "Green");
  assert.equal(tab.rows[1].name, "Bob");
  assert.equal(saveFeedback.length, 1);
  assert.equal(saveFeedback[0].kind, "error");
  assert.match(saveFeedback[0].message, /成功 0 个，失败 2 个/);
});

test("detail-panel save applies only to sparse selection members", async () => {
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "name", column_type: "varchar(50)" },
      { column_name: "level", column_type: "int" },
      { column_name: "guild", column_type: "varchar(50)" },
    ],
  });
  pointerSelect(editor, tab, 0, 0);
  pointerSelect(editor, tab, 2, 2, { ctrlKey: true });

  await editor.commitDetailDraft({ ...editor.selectedCell.value, draft: "detail" });

  assert.equal(tab.rows[0].name, "detail");
  assert.equal(tab.rows[2].guild, "detail");
  assert.equal(tab.rows[1].name, "Bob");
  assert.equal(tab.rows[1].guild, "Blue");
  assert.equal(updatedCellCount(invokeCalls), 2);
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

test("cell selection clears column-selection state before the next Ctrl+column click", () => {
  const { editor, tab } = createEditor();
  editor.selectColumn(tab, "level", { button: 0, ctrlKey: false, metaKey: false, shiftKey: false });

  pointerSelect(editor, tab, 1, 0);

  assert.equal(editor.isColumnSelected(tab, 0), false);
  assert.equal(editor.isColumnSelected(tab, 1), false);
  assert.equal(editor.isColumnSelected(tab, 2), false);

  editor.selectColumn(tab, "guild", { button: 0, ctrlKey: true, metaKey: false, shiftKey: false });
  assert.equal(editor.isColumnSelected(tab, 1), false);
  assert.equal(editor.isColumnSelected(tab, 2), true);
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


test("insertDraftBelow anchors the draft under the clicked row", () => {
  const { editor, tab } = createEditor();

  editor.insertDraftBelow(tab, 1);
  const rowId = editor.selectedInsertCell.value.rowId;

  assert.equal(editor.getVisibleInsertRows(tab)[0].anchorIndex, 2);
  assert.deepEqual(editor.visualRowEntries(tab).map((entry) => entry.type === "insert" ? `insert:${entry.rowId}` : entry.row.id), [
    "1",
    "2",
    `insert:${rowId}`,
    "3",
  ]);
});

test("insertDraftBelow on the last row appends at the trailing edge", () => {
  const { editor, tab } = createEditor();

  editor.insertDraftBelow(tab, 2);
  const rowId = editor.selectedInsertCell.value.rowId;

  assert.deepEqual(editor.visualRowEntries(tab).map((entry) => entry.type === "insert" ? `insert:${entry.rowId}` : entry.row.id), [
    "1",
    "2",
    "3",
    `insert:${rowId}`,
  ]);
});

test("insertDraftBelow keeps trailing-anchor semantics for a null anchor", () => {
  const { editor, tab } = createEditor();

  editor.insertDraftBelow(tab, null);

  assert.equal(editor.getVisibleInsertRows(tab).at(-1).anchorIndex, null);
});

test("insert below resolves the clicked row identity after earlier drafts shift visual indexes", () => {
  const { editor, tab } = createEditor();
  const existing = editor.insertDraftAbove(tab, { row: tab.rows[1], rowIndex: 1 });

  const inserted = editor.insertDraftBelow(tab, { row: tab.rows[0], rowIndex: 0 });

  assert.deepEqual(editor.visualRowEntries(tab).map((entry) => (
    entry.type === "insert" ? entry.rowId : entry.row.id
  )), ["1", inserted.id, existing.id, "2", "3"]);
});

test("insert below an unsaved row places the new draft immediately after that row", () => {
  const { editor, tab } = createEditor();
  const first = editor.insertDraftAbove(tab, { row: tab.rows[1], rowIndex: 1 });
  const second = editor.insertDraftBelow(tab, { row: { __insertRowId: first.id }, rowIndex: 1 });

  assert.deepEqual(editor.visualRowEntries(tab).map((entry) => (
    entry.type === "insert" ? entry.rowId : entry.row.id
  )), ["1", first.id, second.id, "2", "3"]);
});

test("undo and redo restore one multi-row paste into unsaved insert drafts", async () => {
  const { editor, tab, editState } = createEditor();
  editor.selectInsertCell(tab, 0);
  const firstRowId = editor.selectedInsertCell.value.rowId;

  await editor.pasteGridText("Dana\t20\nEli\t30");
  assert.equal(editor.getVisibleInsertRows(tab).length, 2);
  assert.equal(editState.undoStack.at(-1).kind, "insert-draft-batch");

  const undo = useUndo(editState, async () => {
    throw new Error("local draft undo must not call the backend");
  }, computed(() => tab), {
    statusText: { value: "" },
    applyLocalHistoryEntry: editor.applyInsertDraftHistoryEntry,
  });
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(editor.getVisibleInsertRows(tab).length, 1);
  assert.equal(editor.getInsertDraft(tab, firstRowId).name, undefined);

  undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(editor.getVisibleInsertRows(tab).map((row) => [row.draft.name, row.draft.level]), [
    ["Dana", "20"],
    ["Eli", "30"],
  ]);
});

test("one undo and redo covers a paste spanning an insert draft and a saved row", async () => {
  const clipboard = { text: "Draft\t20\nSaved\t30", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, editState } = createEditor({ clipboard });
  const insertRow = editor.insertDraftAbove(tab, { row: tab.rows[1], rowIndex: 1 });
  editState.undoStack.length = 0;
  const model = editor.visualRowEntries(tab);
  const insertIndex = model.findIndex((entry) => entry.rowId === insertRow.id);
  const savedIndex = model.findIndex((entry) => entry.type === "data" && entry.dataIndex === 1);
  const originalSaved = [tab.rows[1].name, tab.rows[1].level];

  editor.startRangeSelection(tab, { __insertRowId: insertRow.id }, "name", insertIndex, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", savedIndex, 1);
  editor.finishRangeSelection();
  await editor.pasteGridText(clipboard.text);

  assert.deepEqual([insertRow.draft.name, insertRow.draft.level], ["Draft", "20"]);
  assert.deepEqual([tab.rows[1].name, tab.rows[1].level], ["Saved", "30"]);
  assert.equal(editState.undoStack.length, 1);
  assert.equal(editState.undoStack[0].kind, "history-composite");

  const undo = useUndo(editState, async () => ({ updated: 1 }), computed(() => tab), {
    statusText: { value: "" },
    applyLocalHistoryEntry: editor.applyInsertDraftHistoryEntry,
  });
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual([
    editor.getInsertDraft(tab, insertRow.id).name,
    editor.getInsertDraft(tab, insertRow.id).level,
  ], [undefined, undefined]);
  assert.deepEqual([tab.rows[1].name, tab.rows[1].level], originalSaved);
  assert.equal(editState.undoStack.length, 0);
  assert.equal(editState.redoStack.length, 1);

  undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual([
    editor.getInsertDraft(tab, insertRow.id).name,
    editor.getInsertDraft(tab, insertRow.id).level,
  ], ["Draft", "20"]);
  assert.deepEqual([tab.rows[1].name, tab.rows[1].level], ["Saved", "30"]);
});

for (const action of ["Delete", "Ctrl+X"]) {
  test(`${action} restores insert drafts when a mixed saved-row clear fails`, async () => {
    const { editor, tab, editState, invokeCalls } = createEditor({
      invokeWorkbench(command) {
        if (command === "update_cells") throw new Error("clear transaction failed");
        return {};
      },
    });
    const insertRow = editor.insertDraftAbove(tab, { row: tab.rows[1], rowIndex: 1 });
    editor.updateInsertDraft(tab, insertRow.id, "name", "Draft");
    editor.updateInsertDraft(tab, insertRow.id, "level", "20");
    const originalDraft = { ...insertRow.draft };
    const savedRow = tab.rows[1];
    const originalSavedRow = { ...savedRow };
    editState.undoStack.length = 0;
    const model = editor.visualRowEntries(tab);
    const insertIndex = model.findIndex((entry) => entry.rowId === insertRow.id);
    const savedIndex = model.findIndex((entry) => entry.type === "data" && entry.dataIndex === 1);

    editor.startRangeSelection(tab, { __insertRowId: insertRow.id }, "name", insertIndex, 0, { button: 0, preventDefault() {} });
    editor.extendRangeSelection(tab, savedRow, "level", savedIndex, 1);
    editor.finishRangeSelection();
    await editor.handleGridKeydown(action === "Delete"
      ? navEvent("Delete")
      : navEvent("x", { ctrlKey: true }));

    assert.deepEqual(insertRow.draft, originalDraft);
    assert.deepEqual(savedRow, originalSavedRow);
    assert.equal(invokeCalls.filter((call) => call.command === "update_cells").length, 1);
    assert.equal(editState.undoStack.length, 0);
  });
}

test("Ctrl+S does not resave a selected range while a multi-cell paste is pending", async () => {
  let releasePasteSave;
  let updateCallCount = 0;
  const backend = async (command, payload) => {
    if (command !== "update_cells") return { updated: true };
    updateCallCount += 1;
    if (updateCallCount === 1) {
      return await new Promise((resolve) => { releasePasteSave = resolve; });
    }
    return { updated: payload?.request?.rows?.length || 0, conflict: false };
  };
  const clipboard = {
    text: "Ann\t20\nBeth\t30",
    async writeText(text) { this.text = text; },
    async readText() { return this.text; },
  };
  const { editor, tab } = createEditor({ clipboard, invokeWorkbench: backend });

  editor.startRangeSelection(tab, tab.rows[0], "name", 0, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "level", 1, 1);
  editor.finishRangeSelection();

  const pastePromise = editor.handleGridKeydown({
    key: "v",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    preventDefault() {},
  });
  await waitForTestCondition(
    () => typeof releasePasteSave === "function",
    "the paste should reach the backend while its optimistic values are visible",
  );

  let savePrevented = false;
  const savePromise = editor.handleGridKeydown({
    key: "s",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    preventDefault() { savePrevented = true; },
  });

  try {
    releasePasteSave({ updated: 2, conflict: false });
    releasePasteSave = null;
    await Promise.all([pastePromise, savePromise]);
  } finally {
    if (typeof releasePasteSave === "function") releasePasteSave({ updated: 2, conflict: false });
  }

  assert.equal(savePrevented, true);
  assert.equal(updateCallCount, 1);
  assert.deepEqual([
    [tab.rows[0].name, tab.rows[0].level],
    [tab.rows[1].name, tab.rows[1].level],
  ], [
    ["Ann", "20"],
    ["Beth", "30"],
  ]);

  await editor.handleGridKeydown({
    key: "s",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    preventDefault() {},
  });
  assert.equal(updateCallCount, 1, "Ctrl+S after the paste settles should also be a no-op");
});

test("undo pressed during a pending multi-cell paste runs after the whole user operation settles", async () => {
  let releaseFirstSave;
  let updateCallCount = 0;
  const backend = async (command) => {
    if (command !== "update_cells") return { updated: true };
    updateCallCount += 1;
    if (updateCallCount === 1) {
      return await new Promise((resolve) => { releaseFirstSave = resolve; });
    }
    return { updated: true };
  };
  const clipboard = { text: "Ann\t20", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, editState, statusText } = createEditor({ clipboard, invokeWorkbench: backend });
  const original = [tab.rows[0].name, tab.rows[0].level];
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);

  const pastePromise = editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true, metaKey: false, altKey: false });
  for (let attempt = 0; attempt < 20 && typeof releaseFirstSave !== "function"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(typeof releaseFirstSave, "function", "the first paste save should reach the backend");
  assert.deepEqual([tab.rows[0].name, tab.rows[0].level], ["Ann", "20"]);

  const undo = useUndo(editState, backend, computed(() => tab), {
    statusText,
    applyLocalHistoryEntry: editor.applyInsertDraftHistoryEntry,
  });
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  assert.match(statusText.value, /保存.*撤销|撤销.*保存/);

  try {
    releaseFirstSave({ updated: true });
    releaseFirstSave = null;
    await pastePromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    if (typeof releaseFirstSave === "function") releaseFirstSave({ updated: true });
  }

  assert.deepEqual([tab.rows[0].name, tab.rows[0].level], original);
  assert.equal(editState.undoStack.length, 0);
  assert.equal(editState.redoStack.length, 1);
});

test("copying SQL NULL produces blank text and an in-app paste writes an empty string", async () => {
  const { editor, tab, clipboard, invokeCalls } = createEditor();
  tab.rows[0].name = null;

  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true });

  assert.equal(clipboard.text, "");

  editor.selectCell(tab, tab.rows[1], "name", 1, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.equal(tab.rows[1].name, "");
  assert.equal(invokeCalls.at(-1).payload.request.newValue, "");
});

test("an empty external clipboard is a no-op instead of clearing the selected cell", async () => {
  const clipboard = { text: "", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, invokeCalls, statusText } = createEditor({ clipboard });
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);

  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.equal(tab.rows[0].name, "Alice");
  assert.equal(invokeCalls.length, 0);
  assert.equal(statusText.value, "剪贴板为空，未修改数据");
});

test("native paste-event text bypasses programmatic clipboard reads", async () => {
  const clipboard = {
    async writeText() {},
    async readText() { throw new Error("programmatic clipboard read must not run"); },
  };
  const { editor, tab, invokeCalls } = createEditor({ clipboard });
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);

  await editor.pasteGridText("Alicia");

  assert.equal(tab.rows[0].name, "Alicia");
  assert.equal(invokeCalls.at(-1).payload.request.newValue, "Alicia");
});

test("pasting into the selected cell refreshes the detail-panel draft", async () => {
  const clipboard = { text: "Alicia", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab } = createEditor({ clipboard });
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  assert.equal(editor.textDraft.value, "Alice");

  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.equal(tab.rows[0].name, "Alicia");
  assert.equal(editor.textDraft.value, "Alicia");
});

test("undo and redo refresh the detail-panel draft for the selected saved cell", async () => {
  const clipboard = { text: "Alicia", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, editState, statusText } = createEditor({ clipboard });
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });
  assert.equal(editor.textDraft.value, "Alicia");

  const undo = useUndo(editState, async () => ({ updated: 1 }), computed(() => tab), {
    statusText,
    applyLocalHistoryEntry: editor.applyInsertDraftHistoryEntry,
    captureHistoryView: editor.captureHistoryViewState,
    onHistoryApplied: editor.syncSelectionAfterHistory,
  });
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => editState.redoStack.length === 1, "undo should settle");

  assert.equal(tab.rows[0].name, "Alice");
  assert.equal(editor.textDraft.value, "Alice");

  undo.handleRedoKeydown({ key: "y", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => editState.activeHistoryEntries.size === 0, "redo should settle");

  assert.equal(tab.rows[0].name, "Alicia");
  assert.equal(editor.textDraft.value, "Alicia");
});

test("an async undo does not overwrite a newer unsaved detail-panel draft", async () => {
  let releaseUndo;
  let mutationCount = 0;
  const clipboard = { text: "Alicia", async writeText(text) { this.text = text; }, async readText() { return this.text; } };
  const { editor, tab, editState, statusText } = createEditor({
    clipboard,
    invokeWorkbench(command, payload) {
      if (command !== "update_cell" && command !== "update_cells") return {};
      mutationCount += 1;
      if (mutationCount === 1) {
        return { updated: command === "update_cells" ? payload.request.rows.length : true };
      }
      return new Promise((resolve) => { releaseUndo = resolve; });
    },
  });
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  const undo = useUndo(editState, async (command, payload) => {
    if (command !== "update_cell" && command !== "update_cells") return {};
    mutationCount += 1;
    return await new Promise((resolve) => { releaseUndo = (result) => resolve(result || {
      updated: command === "update_cells" ? payload.request.rows.length : true,
    }); });
  }, computed(() => tab), {
    statusText,
    applyLocalHistoryEntry: editor.applyInsertDraftHistoryEntry,
    captureHistoryView: editor.captureHistoryViewState,
    onHistoryApplied: editor.syncSelectionAfterHistory,
  });
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => typeof releaseUndo === "function", "undo should reach the backend");
  editor.updateTextDraft("正在输入的新内容");
  releaseUndo({ updated: 1 });
  await waitForTestCondition(() => editState.activeHistoryEntries.size === 0, "undo should settle");

  assert.equal(tab.rows[0].name, "Alice");
  assert.equal(editor.textDraft.value, "正在输入的新内容");
});

test("history sync remaps a selected primary-key row and its range", () => {
  const tab = reactive({
    id: "tab-primary-key",
    tableName: "player",
    sessionId: "session-primary-key",
    primaryKeys: ["id"],
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
    ],
    rows: [{ id: "2", name: "Alice" }],
    selectedRowKeys: new Set(["id=2"]),
  });
  const { editor } = createEditor({ tab });
  editor.selectCell(tab, tab.rows[0], "id", 0, 0);
  assert.equal(editor.textDraft.value, "2");
  tab.rows[0].id = "1";

  editor.syncSelectionAfterHistory({
    tableName: "player",
    rowKey: "id=2",
    beforeRowKey: "id=1",
    afterRowKey: "id=2",
    columnName: "id",
    oldValue: "1",
    newValue: "2",
  }, "undo", tab);

  assert.equal(editor.selectedCell.value.rowKey, "id=1");
  assert.equal(editor.selectedRange.value.anchor.rowKey, "id=1");
  assert.equal(editor.selectedRange.value.focus.rowKey, "id=1");
  assert.equal(editor.textDraft.value, "1");
  assert.deepEqual([...tab.selectedRowKeys], ["id=1"]);
});

test("opening and closing a SQL NULL editor without input does not convert it to empty text", async () => {
  const { editor, tab, invokeCalls } = createEditor();
  tab.rows[0].name = null;
  editor.startEditing(tab, tab.rows[0], "name", 0, 0);

  await editor.finishEditing();

  assert.equal(tab.rows[0].name, null);
  assert.equal(invokeCalls.length, 0);
});

test("a failed older save rebases the queued newer save onto confirmed data", async () => {
  let rejectFirst;
  let updateCount = 0;
  const requests = [];
  const { editor, tab, editState } = createEditor({
    invokeWorkbench(command, payload) {
      if (command !== "update_cell") return {};
      requests.push(payload.request);
      updateCount += 1;
      if (updateCount === 1) {
        return new Promise((resolve, reject) => { rejectFirst = reject; });
      }
      return { updated: true, conflict: false, value: "second" };
    },
  });

  const first = editor.commitCellValue(tab, tab.rows[0], "name", "first");
  const second = editor.commitCellValue(tab, tab.rows[0], "name", "second");
  await waitForTestCondition(() => typeof rejectFirst === "function", "the first save should start");
  assert.equal(updateCount, 1, "the newer save must wait for the older transaction");
  rejectFirst(new Error("older request failed"));
  await first;
  await second;

  assert.equal(tab.rows[0].name, "second");
  assert.equal(updateCount, 2);
  assert.equal(requests[1].oldValue, "Alice");
  assert.equal(requests[1].newValue, "second");
  assert.equal(editState.pendingCells.size, 0);
  assert.equal(editState.undoStack.length, 1);
  assert.equal(editState.undoStack[0].oldValue, "Alice");
  assert.equal(editState.undoStack.at(-1).newValue, "second");
});

test("different insert rows save in table order without sharing one promise", async () => {
  let releaseDana;
  const danaPending = new Promise((resolve) => { releaseDana = resolve; });
  const { editor, tab, invokeCalls } = createEditor({
    invokeWorkbench(command, payload) {
      if (command !== "insert_row") return {};
      return payload.request.draft.name === "Dana" ? danaPending : { affected: 1 };
    },
  });
  editor.selectInsertCell(tab, 0);
  const danaId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, danaId, "name", "Dana");
  editor.insertDraftBelow(tab, null);
  const eliId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, eliId, "name", "Eli");

  const danaSave = editor.commitInsertRow(tab, danaId);
  const eliSave = editor.commitInsertRow(tab, eliId);
  await waitForTestCondition(
    () => invokeCalls.filter((call) => call.command === "insert_row").length === 1,
    "the first insert row should start saving",
  );

  assert.equal(invokeCalls.filter((call) => call.command === "insert_row").length, 1);
  releaseDana({ affected: 1 });
  assert.equal(await danaSave, true);
  assert.equal(await eliSave, true);
  assert.equal(invokeCalls.filter((call) => call.command === "insert_row").length, 2);
  assert.equal(editor.getInsertRows(tab).some((row) => row.id === eliId), false);
});

test("Ctrl+A selects data rows only when an anchored insert draft is visible", async () => {
  const { editor, tab } = createEditor();
  editor.insertDraftAbove(tab, 0);

  await editor.handleGridKeydown({ key: "a", preventDefault() {}, ctrlKey: true });

  const range = editor.selectedRange.value;
  assert.equal(range.anchor.rowIndex, editor.insertAwareVisualRowIndex(tab, 0));
  assert.equal(range.focus.rowIndex, editor.insertAwareVisualRowIndex(tab, tab.rows.length - 1));
  assert.equal(range.anchor.rowKey, buildRowKey(tab, tab.rows[0]));
  assert.equal(range.focus.rowKey, buildRowKey(tab, tab.rows.at(-1)));
});

test("external quoted TSV keeps a multiline cell in one target", async () => {
  const clipboard = {
    text: '"first line\nsecond line"\tBlue',
    async writeText(text) { this.text = text; },
    async readText() { return this.text; },
  };
  const { editor, tab } = createEditor({ clipboard });
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);

  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.equal(tab.rows[0].name, "first line\nsecond line");
  assert.equal(tab.rows[0].level, "Blue");
  assert.equal(tab.rows[1].name, "Bob");
});

test("two composite primary-key cells paste as one final-state atomic update", async () => {
  const clipboard = {
    text: "2\t2",
    async writeText(text) { this.text = text; },
    async readText() { return this.text; },
  };
  const { editor, tab, invokeCalls } = createEditor({
    clipboard,
    columns: [
      { column_name: "realm", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "player_id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "name", column_type: "varchar(32)" },
    ],
    invokeWorkbench(command) {
      if (command === "update_cells") return { updated: 1, conflict: false };
      throw new Error(`unexpected command: ${command}`);
    },
  });
  tab.primaryKeys = ["realm", "player_id"];
  tab.rows = [
    { realm: "1", player_id: "1", name: "first" },
    { realm: "2", player_id: "1", name: "second" },
  ];
  editor.selectCell(tab, tab.rows[0], "realm", 0, 0);

  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.deepEqual(tab.rows[0], { realm: "2", player_id: "2", name: "first" });
  assert.equal(invokeCalls.filter((call) => call.command === "update_cells").length, 1);
  assert.equal(invokeCalls.filter((call) => call.command === "update_cell").length, 0);
  assert.deepEqual(invokeCalls[0].payload.request.rows, [{
    rowIdentity: { realm: "1", player_id: "1" },
    changes: [
      { columnName: "realm", oldValue: "1", newValue: "2" },
      { columnName: "player_id", oldValue: "1", newValue: "2" },
    ],
  }]);
});

test("a batch changing a primary key emits sequential sibling-sync row keys", async () => {
  const clipboard = {
    text: "2\tAlicia",
    async writeText(text) { this.text = text; },
    async readText() { return this.text; },
  };
  const { editor, tab, committedCells } = createEditor({
    clipboard,
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "name", column_type: "varchar(32)" },
    ],
    invokeWorkbench(command) {
      if (command === "update_cells") return { updated: 1, conflict: false };
      throw new Error(`unexpected command: ${command}`);
    },
  });
  tab.primaryKeys = ["id"];
  tab.rows = [{ id: "1", name: "Alice" }];
  editor.selectCell(tab, tab.rows[0], "id", 0, 0);

  await editor.pasteGridText(clipboard.text);

  assert.deepEqual(committedCells.map(({ rowKey, beforeRowKey, afterRowKey, column, oldValue, newValue }) => ({
    rowKey,
    beforeRowKey,
    afterRowKey,
    column,
    oldValue,
    newValue,
  })), [
    {
      rowKey: "id=1",
      beforeRowKey: "id=1",
      afterRowKey: "id=2",
      column: "id",
      oldValue: "1",
      newValue: "2",
    },
    {
      rowKey: "id=2",
      beforeRowKey: "id=2",
      afterRowKey: "id=2",
      column: "name",
      oldValue: "Alice",
      newValue: "Alicia",
    },
  ]);
});

test("a failed two-cell composite-key paste restores both cells and records no undo", async () => {
  const clipboard = {
    text: "2\t2",
    async writeText(text) { this.text = text; },
    async readText() { return this.text; },
  };
  const { editor, tab, editState, invokeCalls } = createEditor({
    clipboard,
    columns: [
      { column_name: "realm", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "player_id", column_type: "int", is_primary_key: true, is_nullable: false },
    ],
    invokeWorkbench(command) {
      if (command === "update_cells") throw new Error("transaction failed");
      throw new Error(`unexpected command: ${command}`);
    },
  });
  tab.primaryKeys = ["realm", "player_id"];
  tab.rows = [
    { realm: "1", player_id: "1" },
    { realm: "2", player_id: "1" },
  ];
  editor.selectCell(tab, tab.rows[0], "realm", 0, 0);

  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.deepEqual(tab.rows[0], { realm: "1", player_id: "1" });
  assert.equal(invokeCalls.filter((call) => call.command === "update_cells").length, 1);
  assert.equal(editState.pendingCells.size, 0);
  assert.equal(editState.undoStack.length, 0);
});

test("a final duplicate composite key rejects every edited cell before backend save", async () => {
  const clipboard = {
    text: "2\t2\trenamed",
    async writeText(text) { this.text = text; },
    async readText() { return this.text; },
  };
  const { editor, tab, invokeCalls, statusText } = createEditor({
    clipboard,
    columns: [
      { column_name: "realm", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "player_id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "name", column_type: "varchar(32)" },
    ],
  });
  tab.primaryKeys = ["realm", "player_id"];
  tab.rows = [
    { realm: "1", player_id: "1", name: "first" },
    { realm: "2", player_id: "2", name: "second" },
  ];
  editor.selectCell(tab, tab.rows[0], "realm", 0, 0);

  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.deepEqual(tab.rows[0], { realm: "1", player_id: "1", name: "first" });
  assert.equal(invokeCalls.length, 0);
  assert.match(statusText.value, /失败 3 个.*主键重复/);
});

test("a large rectangular paste uses one atomic batch command grouped by row", async () => {
  const clipboard = {
    text: "A\t1\tRed\nB\t2\tBlue\nC\t3\tGreen",
    async writeText(text) { this.text = text; },
    async readText() { return this.text; },
  };
  const { editor, tab, editState, invokeCalls } = createEditor({
    clipboard,
    invokeWorkbench(command) {
      if (command === "update_cells") return { updated: 3 };
      throw new Error(`unexpected command: ${command}`);
    },
  });
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);

  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.equal(invokeCalls.filter((call) => call.command === "update_cells").length, 1);
  assert.equal(updatedCellCount(invokeCalls), 6);
  assert.equal(invokeCalls[0].payload.request.rows.length, 3);
  assert.deepEqual(invokeCalls[0].payload.request.rows.map((row) => row.changes.length), [2, 2, 2]);
  assert.deepEqual(tab.rows.map((row) => [row.name, row.level, row.guild]), [
    ["A", "1", "Red"],
    ["B", "2", "Blue"],
    ["C", "3", "Green"],
  ]);
  assert.equal(editState.undoStack.length, 1);
  assert.equal(editState.undoStack[0].kind, "cell-batch");
  assert.equal(editState.undoStack[0].entries.length, 6);
});

test("a failed atomic paste restores every optimistic cell and leaves no undo entry", async () => {
  const clipboard = {
    text: "A\t1\tRed\nB\t2\tBlue\nC\t3\tGreen",
    async writeText(text) { this.text = text; },
    async readText() { return this.text; },
  };
  const { editor, tab, editState, statusText } = createEditor({
    clipboard,
    invokeWorkbench(command) {
      if (command === "update_cells") throw new Error("audit unavailable");
      throw new Error(`unexpected command: ${command}`);
    },
  });
  const before = tab.rows.map((row) => ({ ...row }));
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);

  await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });

  assert.deepEqual(tab.rows, before);
  assert.equal(editState.pendingCells.size, 0);
  assert.equal(editState.undoStack.length, 0);
  assert.match(statusText.value, /成功 0 个，失败 6 个.*audit unavailable/);
});

test("full-row paste stays unsaved until an explicit save reports row failures", async () => {
  let inserts = 0;
  const { editor, tab, statusText } = createEditor({
    invokeWorkbench(command) {
      if (command !== "insert_row") return {};
      inserts += 1;
      if (inserts === 2) throw new Error("duplicate key");
      return { affected: 1 };
    },
  });
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[0]));
  tab.selectedRowKeys.add(buildRowKey(tab, tab.rows[1]));
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true });
  tab.selectedRowKeys.clear();
  editor.selectInsertRow(tab);

  const pasteResult = await editor.handleGridKeydown({ key: "v", preventDefault() {}, ctrlKey: true });
  assert.deepEqual(pasteResult, { ok: true, draftRows: 2, insertedRows: 0 });
  assert.equal(inserts, 0);

  const result = await editor.commitInsertRows(tab);

  assert.equal(result.insertedRows, 1);
  assert.ok(result.failedRowId);
  assert.match(statusText.value, /duplicate key/);
  assert.ok(editor.getInsertRows(tab).some((row) => row.draft.name === "Bob"));
});

test("saving a whole-row-selected insert draft removes its stale row-selection key", async () => {
  const { editor, tab, clipboard } = createEditor();
  editor.selectInsertRow(tab);
  const rowId = editor.selectedInsertRow.value.rowId;
  const rowKey = editor.getInsertRowKey(tab, rowId);
  editor.updateInsertDraft(tab, rowId, "name", "Dana");
  tab.selectedRowKeys.add(rowKey);

  assert.equal(await editor.commitInsertRow(tab, rowId), true);

  assert.equal(tab.selectedRowKeys.has(rowKey), false);
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);
  await editor.handleGridKeydown({ key: "c", preventDefault() {}, ctrlKey: true });
  assert.equal(clipboard.text, "Alice");
});

test("a primary-key change cannot make a new row reuse the old row's save lane", async () => {
  let releaseRenamedRowSave;
  const requests = [];
  const { editor, tab } = createEditor({
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
    ],
    invokeWorkbench(command, payload) {
      if (command !== "update_cell") return {};
      requests.push(payload.request);
      if (payload.request.rowIdentity.id === "2" && payload.request.columnName === "name") {
        return new Promise((resolve) => { releaseRenamedRowSave = resolve; });
      }
      return { updated: true, conflict: false };
    },
  });
  tab.rows = [{ id: "1", name: "original" }];
  const renamedRow = tab.rows[0];

  await editor.commitCellValue(tab, renamedRow, "id", "2");
  const renamedRowSave = editor.commitCellValue(tab, renamedRow, "name", "row-two");
  await waitForTestCondition(() => typeof releaseRenamedRowSave === "function", "renamed row save should start");

  const replacementRow = { id: "1", name: "replacement" };
  tab.rows.push(replacementRow);
  const replacementSave = editor.commitCellValue(tab, replacementRow, "name", "row-one");
  assert.equal(requests.length, 2, "replacement row must wait for the table turn");

  releaseRenamedRowSave({ updated: true, conflict: false });
  await renamedRowSave;
  await replacementSave;

  assert.deepEqual(requests.map((request) => ({
    identity: request.rowIdentity.id,
    column: request.columnName,
    oldValue: request.oldValue,
    newValue: request.newValue,
  })), [
    { identity: "1", column: "id", oldValue: "1", newValue: "2" },
    { identity: "2", column: "name", oldValue: "original", newValue: "row-two" },
    { identity: "1", column: "name", oldValue: "replacement", newValue: "row-one" },
  ]);
});

test("an edit queued behind an in-flight undo saves against the undone value", async () => {
  let releaseUndo;
  const requests = [];
  const { editor, tab, editState, statusText } = createEditor({
    invokeWorkbench(command, payload) {
      if (command !== "update_cell") return {};
      requests.push(payload.request);
      if (payload.request.oldValue === "B" && payload.request.newValue === "Alice") {
        return new Promise((resolve) => { releaseUndo = resolve; });
      }
      return { updated: true, conflict: false };
    },
  });
  const row = tab.rows[0];
  await editor.commitCellValue(tab, row, "name", "B");
  const undo = useUndo(editState, async (command, payload) => {
    if (command !== "update_cell") return {};
    requests.push(payload.request);
    if (payload.request.oldValue === "B" && payload.request.newValue === "Alice") {
      return new Promise((resolve) => { releaseUndo = resolve; });
    }
    return { updated: true, conflict: false };
  }, computed(() => tab), { statusText });

  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => typeof releaseUndo === "function", "undo should start");
  const laterEdit = editor.commitCellValue(tab, row, "name", "D");
  assert.equal(requests.length, 2);

  releaseUndo({ updated: true, conflict: false });
  await laterEdit;

  assert.deepEqual(requests.map(({ oldValue, newValue }) => [oldValue, newValue]), [
    ["Alice", "B"],
    ["B", "Alice"],
    ["Alice", "D"],
  ]);
  assert.equal(row.name, "D");
});

test("two queued undos followed by an edit remain deadlock-free and ordered", async () => {
  let releaseFirstUndo;
  const requests = [];
  const backend = async (command, payload) => {
    if (command !== "update_cell") return {};
    requests.push(payload.request);
    if (payload.request.oldValue === "C" && payload.request.newValue === "B") {
      return await new Promise((resolve) => { releaseFirstUndo = resolve; });
    }
    return { updated: true, conflict: false };
  };
  const { editor, tab, editState, statusText } = createEditor({ invokeWorkbench: backend });
  const row = tab.rows[0];
  await editor.commitCellValue(tab, row, "name", "B");
  await editor.commitCellValue(tab, row, "name", "C");
  const undo = useUndo(editState, backend, computed(() => tab), { statusText });

  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => typeof releaseFirstUndo === "function", "first undo should start");
  const laterEdit = editor.commitCellValue(tab, row, "name", "D");
  assert.equal(requests.length, 3);

  releaseFirstUndo({ updated: true, conflict: false });
  await laterEdit;

  assert.deepEqual(requests.map(({ oldValue, newValue }) => [oldValue, newValue]), [
    ["Alice", "B"],
    ["B", "C"],
    ["C", "B"],
    ["B", "Alice"],
    ["Alice", "D"],
  ]);
  assert.equal(row.name, "D");
});

test("a local insert-draft edit queued behind undo invalidates the resulting redo", async () => {
  let releaseUndo;
  const requests = [];
  const backend = async (command, payload) => {
    if (command !== "update_cell") return {};
    requests.push(payload.request);
    if (payload.request.oldValue === "B" && payload.request.newValue === "Alice") {
      return await new Promise((resolve) => { releaseUndo = resolve; });
    }
    return { updated: true, conflict: false };
  };
  const { editor, tab, editState, statusText } = createEditor({ invokeWorkbench: backend });
  const row = tab.rows[0];
  await editor.commitCellValue(tab, row, "name", "B");
  const undo = useUndo(editState, backend, computed(() => tab), {
    statusText,
    applyLocalHistoryEntry: editor.applyInsertDraftHistoryEntry,
  });

  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => typeof releaseUndo === "function", "undo should start");
  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  await editor.pasteGridText("Dana");
  assert.equal(editor.getInsertDraft(tab, rowId).name, "Dana");

  releaseUndo({ updated: true, conflict: false });
  await waitForTestCondition(
    () => editState.activeHistoryEntries.size === 0 && editState.mutationQueues.size === 0,
    "undo and the later local edit should settle",
  );

  assert.equal(row.name, "Alice");
  assert.equal(editState.redoStack.length, 0);
  undo.handleRedoKeydown({ key: "y", ctrlKey: true, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(editor.getInsertDraft(tab, rowId).name, "Dana");
  assert.equal(requests.length, 2);
  assert.equal(statusText.value, "无可重做操作");
});

test("a second atomic paste rebases onto confirmed rows after the first atomic paste fails", async () => {
  let rejectFirstPaste;
  let batchCallCount = 0;
  const batchRequests = [];
  const { editor, tab } = createEditor({
    invokeWorkbench(command, payload) {
      if (command !== "update_cells") throw new Error(`unexpected command: ${command}`);
      batchCallCount += 1;
      batchRequests.push(payload.request);
      if (batchCallCount === 1) {
        return new Promise((_resolve, reject) => { rejectFirstPaste = reject; });
      }
      return { updated: 3, conflict: false };
    },
  });
  editor.selectCell(tab, tab.rows[0], "name", 0, 0);

  const firstPaste = editor.pasteGridText("A\t1\tX\nB\t2\tY\nC\t3\tZ");
  await waitForTestCondition(() => typeof rejectFirstPaste === "function", "first atomic paste should start");
  const secondPaste = editor.pasteGridText("D\t4\tU\nE\t5\tV\nF\t6\tW");
  assert.equal(batchRequests.length, 1);

  rejectFirstPaste(new Error("first batch failed"));
  await firstPaste;
  await secondPaste;

  assert.equal(batchRequests.length, 2);
  assert.deepEqual(batchRequests[1].rows.map((row) => row.changes.map((change) => (
    [change.columnName, change.oldValue, change.newValue]
  ))), [
    [["name", "Alice", "D"], ["level", "10", "4"], ["guild", "Red", "U"]],
    [["name", "Bob", "E"], ["level", "12", "5"], ["guild", "Blue", "V"]],
    [["name", "Cara", "F"], ["level", "14", "6"], ["guild", "Green", "W"]],
  ]);
  assert.deepEqual(tab.rows.map((row) => [row.name, row.level, row.guild]), [
    ["D", "4", "U"],
    ["E", "5", "V"],
    ["F", "6", "W"],
  ]);
});

test("pending mixed history rebases a later draft edit before its next undo", async () => {
  let releaseFirstUndo;
  const requests = [];
  const backend = async (command, payload) => {
    if (command !== "update_cell") return { updated: true, conflict: false };
    requests.push(payload.request);
    if (payload.request.oldValue === "saved_user" && payload.request.newValue === "Bob") {
      return await new Promise((resolve) => { releaseFirstUndo = resolve; });
    }
    return { updated: true, conflict: false };
  };
  const { editor, tab, editState, statusText } = createEditor({ invokeWorkbench: backend });
  editor.insertDraftBelow(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.updateInsertDraft(tab, rowId, "name", "A");
  const insertRowObject = { ...editor.getInsertDraft(tab, rowId), __insertRowId: rowId };
  editor.startRangeSelection(tab, insertRowObject, "name", 1, 0, { button: 0, preventDefault() {} });
  editor.extendRangeSelection(tab, tab.rows[1], "name", 2, 0);
  editor.finishRangeSelection();
  await editor.pasteGridText("B\nsaved_user");

  const undo = useUndo(editState, backend, computed(() => tab), {
    statusText,
    applyLocalHistoryEntry: editor.applyInsertDraftHistoryEntry,
  });
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(() => typeof releaseFirstUndo === "function", "mixed undo should reach the saved row");

  const laterPaste = editor.pasteGridText("D\nfuture_user");
  assert.equal(editor.getInsertDraft(tab, rowId).name, "D");
  releaseFirstUndo({ updated: true, conflict: false });
  await laterPaste;
  await waitForTestCondition(() => editState.activeHistoryEntries.size === 0, "first undo should finish");

  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(
    () => editor.getInsertDraft(tab, rowId).name === "A" && tab.rows[1].name === "Bob",
    "undoing the later paste should return to the state before the older undo",
  );
  assert.equal(editor.getInsertDraft(tab, rowId).name, "A");
  assert.equal(tab.rows[1].name, "Bob");
});

test("insert-draft history rebasing never crosses tab or table scope", async () => {
  const sharedEditState = reactive(createEditState());
  const first = createEditor({ editState: sharedEditState });
  first.tab.id = "tab-first";
  first.tab.tableName = "first_table";
  const sharedRowId = "insert-shared";
  first.tab.insertDrafts = [{
    id: sharedRowId,
    draft: { name: "shared-after" },
    anchorIndex: null,
    visible: true,
  }];
  first.editor.selectInsertCell(first.tab, sharedRowId, 0);
  first.editor.updateInsertDraft(first.tab, sharedRowId, "name", "shared-before");
  await first.editor.pasteGridText("shared-after");

  const secondTab = reactive({
    id: "tab-second",
    tableName: "second_table",
    sessionId: "session-2",
    columns: [{ column_name: "name" }, { column_name: "level" }, { column_name: "guild" }],
    rows: [{ name: "Other", level: "1", guild: "Blue" }],
    selectedRowKeys: new Set(),
    insertDrafts: [{
      id: sharedRowId,
      draft: { name: "shared-after" },
      anchorIndex: null,
      visible: true,
    }],
  });
  const second = createEditor({ tab: secondTab, editState: sharedEditState });
  second.editor.selectInsertCell(second.tab, sharedRowId, 0);
  const firstUndo = useUndo(sharedEditState, async () => {
    throw new Error("draft history must stay local");
  }, computed(() => first.tab), {
    statusText: first.statusText,
    applyLocalHistoryEntry: first.editor.applyInsertDraftHistoryEntry,
  });

  firstUndo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  const secondPaste = second.editor.pasteGridText("second-future");
  await secondPaste;
  await waitForTestCondition(
    () => sharedEditState.activeHistoryEntries.size === 0,
    "first-tab undo should settle",
  );
  assert.equal(first.editor.getInsertDraft(first.tab, sharedRowId).name, "shared-before");
  assert.equal(second.editor.getInsertDraft(second.tab, sharedRowId).name, "second-future");

  const secondUndo = useUndo(sharedEditState, async () => {
    throw new Error("draft history must stay local");
  }, computed(() => second.tab), {
    statusText: second.statusText,
    applyLocalHistoryEntry: second.editor.applyInsertDraftHistoryEntry,
  });
  secondUndo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(
    () => second.editor.getInsertDraft(second.tab, sharedRowId).name === "shared-after",
    "second-tab undo should restore only its own prior draft",
  );
});

test("undo queued behind insert_row cannot resurrect a draft after the row is saved", async () => {
  let releaseInsert;
  const calls = [];
  const backend = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "insert_row") return await new Promise((resolve) => { releaseInsert = resolve; });
    throw new Error(`unexpected history write: ${command}`);
  };
  const { editor, tab, editState, statusText } = createEditor({ invokeWorkbench: backend });
  editor.selectInsertCell(tab, 0);
  const rowId = editor.selectedInsertCell.value.rowId;
  editor.pasteGridText("Dana");
  const save = editor.commitInsertRow(tab, rowId);
  await waitForTestCondition(() => typeof releaseInsert === "function", "insert should reach the backend");
  const undo = useUndo(editState, backend, computed(() => tab), {
    statusText,
    applyLocalHistoryEntry: editor.applyInsertDraftHistoryEntry,
  });

  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  assert.equal(editor.getInsertDraft(tab, rowId).name, "Dana");
  releaseInsert({ affected: 1, row: { name: "Dana" } });
  assert.equal(await save, true);
  await waitForTestCondition(() => editState.activeHistoryEntries.size === 0, "queued undo should settle");

  assert.equal(editor.getInsertRows(tab).some((row) => row.id === rowId), false);
  assert.ok(tab.rows.some((row) => row.name === "Dana"));
  assert.deepEqual(calls.map((call) => call.command), ["insert_row"]);
  assert.equal(editState.undoStack.length, 0);
  assert.equal(editState.redoStack.length, 0);
});

test("a successful cell save updates a reloaded clone and freezes its session", async () => {
  let releaseSave;
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
    ],
    invokeWorkbench(command) {
      if (command !== "update_cell") throw new Error(`unexpected command: ${command}`);
      return new Promise((resolve) => { releaseSave = resolve; });
    },
  });
  tab.primaryKeys = ["id"];
  const save = editor.commitCellValue(tab, tab.rows[0], "name", "Ann");
  tab.sessionId = "session-refreshed";
  await waitForTestCondition(() => typeof releaseSave === "function", "cell save should reach the backend");
  tab.rows = tab.rows.map((row) => ({ ...row, name: row.id === "1" ? "Alice" : row.name }));

  releaseSave({ updated: true, conflict: false });
  await save;

  assert.equal(tab.rows.find((row) => row.id === "1").name, "Ann");
  assert.equal(invokeCalls[0].payload.request.sessionId, "session-1");
});

test("a failed cell save never rolls back a different row loaded at the old index", async () => {
  let rejectSave;
  const { editor, tab, editState } = createEditor({
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
    ],
    invokeWorkbench(command) {
      if (command !== "update_cell") throw new Error(`unexpected command: ${command}`);
      return new Promise((_resolve, reject) => { rejectSave = reject; });
    },
  });
  tab.primaryKeys = ["id"];
  const save = editor.commitCellValue(tab, tab.rows[0], "name", "Ann");
  await waitForTestCondition(() => typeof rejectSave === "function", "cell save should reach the backend");
  tab.rows = [{ id: "9", name: "Ann" }];

  rejectSave(new Error("save failed"));
  await save;

  assert.deepEqual(tab.rows, [{ id: "9", name: "Ann" }]);
  assert.equal(editState.undoStack.length, 0);
});

test("a failed cell save preserves a refreshed same-identity row with newer sibling values", async () => {
  let rejectSave;
  const { editor, tab, editState } = createEditor({
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
      { column_name: "guild" },
    ],
    invokeWorkbench(command) {
      if (command !== "update_cell") throw new Error(`unexpected command: ${command}`);
      return new Promise((_resolve, reject) => { rejectSave = reject; });
    },
  });
  tab.primaryKeys = ["id"];
  const save = editor.commitCellValue(tab, tab.rows[0], "name", "Ann");
  await waitForTestCondition(() => typeof rejectSave === "function", "cell save should reach the backend");
  tab.rows = tab.rows.map((row) => (
    row.id === "1" ? { ...row, name: "Ann", guild: "Newer guild" } : { ...row }
  ));

  rejectSave(new Error("save failed"));
  await save;

  assert.deepEqual(tab.rows.find((row) => row.id === "1"), {
    id: "1",
    name: "Ann",
    level: "10",
    guild: "Newer guild",
  });
  assert.equal(editState.undoStack.length, 0);
});

test("a successful primary-key save relocates a reloaded source clone and remaps selection", async () => {
  let releaseSave;
  const { editor, tab } = createEditor({
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
    ],
    invokeWorkbench(command) {
      if (command !== "update_cell") throw new Error(`unexpected command: ${command}`);
      return new Promise((resolve) => { releaseSave = resolve; });
    },
  });
  tab.primaryKeys = ["id"];
  editor.selectCell(tab, tab.rows[0], "id", 0, 0);
  const save = editor.commitCellValue(tab, tab.rows[0], "id", "9");
  await waitForTestCondition(() => typeof releaseSave === "function", "primary-key save should reach the backend");
  tab.rows = tab.rows.map((row) => ({ ...row, id: row.id === "9" ? "1" : row.id }));

  releaseSave({ updated: true, conflict: false });
  await save;

  assert.equal(tab.rows[0].id, "9");
  assert.equal(editor.selectedCell.value.rowKey, "id=9");
});

test("a failed primary-key save restores a reloaded optimistic clone by its after key", async () => {
  let rejectSave;
  const { editor, tab, editState } = createEditor({
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
    ],
    invokeWorkbench(command) {
      if (command !== "update_cell") throw new Error(`unexpected command: ${command}`);
      return new Promise((_resolve, reject) => { rejectSave = reject; });
    },
  });
  tab.primaryKeys = ["id"];
  const save = editor.commitCellValue(tab, tab.rows[0], "id", "9");
  await waitForTestCondition(() => typeof rejectSave === "function", "primary-key save should reach the backend");
  tab.rows = tab.rows.map((row) => ({ ...row }));

  rejectSave(new Error("save failed"));
  await save;

  assert.equal(tab.rows[0].id, "1");
  assert.equal(editState.undoStack.length, 0);
});

test("a successful atomic paste updates reordered row clones and freezes its session", async () => {
  let releaseSave;
  const { editor, tab, invokeCalls } = createEditor({
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
      { column_name: "level" },
    ],
    invokeWorkbench(command) {
      if (command !== "update_cells") throw new Error(`unexpected command: ${command}`);
      return new Promise((resolve) => { releaseSave = resolve; });
    },
  });
  tab.primaryKeys = ["id"];
  editor.selectCell(tab, tab.rows[0], "name", 0, 1);
  const paste = editor.pasteGridText("Ann\t21\nBee\t22");
  tab.sessionId = "session-refreshed";
  await waitForTestCondition(() => typeof releaseSave === "function", "atomic paste should reach the backend");
  tab.rows = [
    { ...tab.rows[1], name: "Bob", level: "12" },
    { ...tab.rows[2] },
    { ...tab.rows[0], name: "Alice", level: "10" },
  ];

  releaseSave({ updated: 2, conflict: false });
  await paste;

  assert.deepEqual(tab.rows.map((row) => [row.id, row.name, row.level]), [
    ["2", "Bee", "22"],
    ["3", "Cara", "14"],
    ["1", "Ann", "21"],
  ]);
  assert.equal(invokeCalls[0].payload.request.sessionId, "session-1");
});

test("a failed atomic paste never rolls back different rows loaded at old indexes", async () => {
  let rejectSave;
  const { editor, tab, editState } = createEditor({
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
      { column_name: "level" },
    ],
    invokeWorkbench(command) {
      if (command !== "update_cells") throw new Error(`unexpected command: ${command}`);
      return new Promise((_resolve, reject) => { rejectSave = reject; });
    },
  });
  tab.primaryKeys = ["id"];
  editor.selectCell(tab, tab.rows[0], "name", 0, 1);
  const paste = editor.pasteGridText("Ann\t21\nBee\t22");
  await waitForTestCondition(() => typeof rejectSave === "function", "atomic paste should reach the backend");
  tab.rows = [
    { id: "8", name: "Ann", level: "21" },
    { id: "9", name: "Bee", level: "22" },
  ];

  rejectSave(new Error("batch failed"));
  await paste;

  assert.deepEqual(tab.rows, [
    { id: "8", name: "Ann", level: "21" },
    { id: "9", name: "Bee", level: "22" },
  ]);
  assert.equal(editState.undoStack.length, 0);
});

test("a failed atomic paste preserves refreshed same-identity rows with newer sibling values", async () => {
  let rejectSave;
  const { editor, tab, editState } = createEditor({
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
      { column_name: "level" },
      { column_name: "guild" },
    ],
    invokeWorkbench(command) {
      if (command !== "update_cells") throw new Error(`unexpected command: ${command}`);
      return new Promise((_resolve, reject) => { rejectSave = reject; });
    },
  });
  tab.primaryKeys = ["id"];
  editor.selectCell(tab, tab.rows[0], "name", 0, 1);
  const paste = editor.pasteGridText("Ann\t21\nBee\t22");
  await waitForTestCondition(() => typeof rejectSave === "function", "atomic paste should reach the backend");
  tab.rows = [
    { ...tab.rows[1], name: "Bee", level: "22", guild: "Newer blue" },
    { ...tab.rows[0], name: "Ann", level: "21", guild: "Newer red" },
    { ...tab.rows[2] },
  ];

  rejectSave(new Error("batch failed"));
  await paste;

  assert.deepEqual(tab.rows.map((row) => [row.id, row.name, row.level, row.guild]), [
    ["2", "Bee", "22", "Newer blue"],
    ["1", "Ann", "21", "Newer red"],
    ["3", "Cara", "14", "Green"],
  ]);
  assert.equal(editState.undoStack.length, 0);
});

test("a failed atomic paste restores reordered clones by row identity", async () => {
  let rejectSave;
  const { editor, tab, editState } = createEditor({
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
      { column_name: "level" },
    ],
    invokeWorkbench(command) {
      if (command !== "update_cells") throw new Error(`unexpected command: ${command}`);
      return new Promise((_resolve, reject) => { rejectSave = reject; });
    },
  });
  tab.primaryKeys = ["id"];
  editor.selectCell(tab, tab.rows[0], "name", 0, 1);
  const paste = editor.pasteGridText("Ann\t21\nBee\t22");
  await waitForTestCondition(() => typeof rejectSave === "function", "atomic paste should reach the backend");
  tab.rows = [
    { ...tab.rows[1] },
    { ...tab.rows[2] },
    { ...tab.rows[0] },
  ];

  rejectSave(new Error("batch failed"));
  await paste;

  assert.deepEqual(tab.rows.map((row) => [row.id, row.name, row.level]), [
    ["2", "Bob", "12"],
    ["3", "Cara", "14"],
    ["1", "Alice", "10"],
  ]);
  assert.equal(editState.undoStack.length, 0);
});

test("a successful atomic composite-key paste updates a reloaded source clone", async () => {
  let releaseSave;
  const { editor, tab } = createEditor({
    columns: [
      { column_name: "realm", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "player_id", column_type: "int", is_primary_key: true, is_nullable: false },
      { column_name: "name" },
    ],
    invokeWorkbench(command) {
      if (command !== "update_cells") throw new Error(`unexpected command: ${command}`);
      return new Promise((resolve) => { releaseSave = resolve; });
    },
  });
  tab.primaryKeys = ["realm", "player_id"];
  tab.rows = [{ realm: "1", player_id: "1", name: "first" }];
  editor.selectCell(tab, tab.rows[0], "realm", 0, 0);
  const paste = editor.pasteGridText("2\t2");
  await waitForTestCondition(() => typeof releaseSave === "function", "composite-key paste should reach the backend");
  tab.rows = [{ realm: "1", player_id: "1", name: "first" }];

  releaseSave({ updated: 1, conflict: false });
  await paste;

  assert.deepEqual(tab.rows, [{ realm: "2", player_id: "2", name: "first" }]);
  assert.equal(editor.selectedCell.value.rowKey, "realm=2&player_id=2");
});

test("replaceSelectionCells replaces data and insert-draft cells with one shared undo", async () => {
  const { editor, tab, editState } = createEditor({
    invokeWorkbench: (command, payload) => (
      command === "update_cell"
        ? { updated: true, conflict: false, value: payload?.request?.newValue ?? null }
        : command === "update_cells"
          ? { updated: payload?.request?.rows?.length || 0, conflict: false }
          : {}
    ),
  });
  const insertRow = editor.insertDraftAbove(tab, 1);
  editor.updateInsertDraft(tab, insertRow.id, "name", "草稿Alice");
  const insertVisualIndex = editor.visualRowEntries(tab).visualIndexOfInsert(insertRow.id);
  const insertRowObject = { ...insertRow.draft, __insertRowId: insertRow.id };

  pointerSelect(editor, tab, 0, 0);
  editor.startRangeSelection(tab, insertRowObject, "name", insertVisualIndex, 0, {
    button: 0,
    ctrlKey: true,
    preventDefault() {},
  });
  editor.finishRangeSelection();

  const result = await editor.replaceSelectionCells(tab, editor.selectedRange.value, {
    query: "alice",
    replacement: "X",
  });
  assert.equal(result.ok, true);
  assert.equal(result.cells, 2);
  assert.equal(tab.rows[0].name, "X");
  assert.equal(editor.getInsertDraft(tab, insertRow.id).name, "草稿X");

  // 数据行与新增行草稿共享同一个撤销事务：一条组合历史项，Ctrl+Z 一次撤回。
  const entry = editState.undoStack.at(-1);
  assert.equal(entry.kind, "history-composite");
  assert.equal(entry.entries.length, 2);
  assert.ok(entry.entries.some((child) => child.kind === "insert-draft-batch"));

  const undoStatus = { value: "" };
  const undo = useUndo(
    editState,
    async (command, payload) => (
      command === "update_cell"
        ? { updated: true, conflict: false, value: payload?.request?.newValue ?? null }
        : { updated: payload?.request?.rows?.length || 0, conflict: false }
    ),
    computed(() => tab),
    { statusText: undoStatus, applyLocalHistoryEntry: editor.applyInsertDraftHistoryEntry },
  );
  undo.handleUndoKeydown({ key: "z", ctrlKey: true, shiftKey: false, preventDefault() {} });
  await waitForTestCondition(
    () => undoStatus.value.includes("已撤销") && editState.activeHistoryEntries.size === 0,
    "selection replace undo should finish",
  );
  assert.equal(tab.rows[0].name, "Alice");
  assert.equal(editor.getInsertDraft(tab, insertRow.id).name, "草稿Alice");
});
