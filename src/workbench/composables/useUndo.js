import { popUndo, popRedo } from "../editState.js";
import { buildRowKey, buildRowIdentity } from "../utils/rowIdentity.js";

export function useUndo(editState, invokeWorkbench, activeTab, { statusText }) {
  // 把一个 undo entry 反向应用：把单元格恢复为 oldValue，并把该 entry 推入 redo 栈。
  async function applyUndoEntry(entry) {
    const tab = activeTab.value;
    if (!tab || (tab.tableKey || tab.tableName) !== entry.tableName) {
      editState.undoStack.push(entry);
      statusText.value = "无可撤销操作（当前表不匹配）";
      return;
    }
    const row = tab.rows.find((r) => buildRowKey(tab, r) === entry.rowKey);
    if (!row) {
      editState.undoStack.push(entry);
      statusText.value = "无可撤销操作（行不存在）";
      return;
    }
    try {
      await invokeWorkbench("update_cell", {
        request: {
          sessionId: tab.sessionId,
          rowIdentity: buildRowIdentity(tab, { ...row, [entry.columnName]: row[entry.columnName] }),
          columnName: entry.columnName,
          oldValue: row[entry.columnName] ?? "",
          newValue: entry.oldValue ?? "",
        },
      });
      row[entry.columnName] = entry.oldValue;
      // 撤销成功后把这条记录压入 redo 栈，供 Ctrl+Y 恢复。
      if (!editState.redoStack) editState.redoStack = [];
      editState.redoStack.push({ ...entry });
      statusText.value = "已撤销";
    } catch (error) {
      editState.undoStack.push(entry);
      statusText.value = `撤销失败：${String(error)}`;
    }
  }

  // 把一个 redo entry 正向重新应用：把单元格设回 newValue，并把该 entry 推回 undo 栈。
  async function applyRedoEntry(entry) {
    const tab = activeTab.value;
    if (!tab || (tab.tableKey || tab.tableName) !== entry.tableName) {
      editState.redoStack.push(entry);
      statusText.value = "无可重做操作（当前表不匹配）";
      return;
    }
    const row = tab.rows.find((r) => buildRowKey(tab, r) === entry.rowKey);
    if (!row) {
      editState.redoStack.push(entry);
      statusText.value = "无可重做操作（行不存在）";
      return;
    }
    try {
      await invokeWorkbench("update_cell", {
        request: {
          sessionId: tab.sessionId,
          rowIdentity: buildRowIdentity(tab, { ...row, [entry.columnName]: row[entry.columnName] }),
          columnName: entry.columnName,
          oldValue: row[entry.columnName] ?? "",
          newValue: entry.newValue ?? "",
        },
      });
      row[entry.columnName] = entry.newValue;
      editState.undoStack.push({ ...entry });
      statusText.value = "已重做";
    } catch (error) {
      editState.redoStack.push(entry);
      statusText.value = `重做失败：${String(error)}`;
    }
  }

  function handleUndoKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.key !== "z" || event.shiftKey) return false;
    event.preventDefault();
    const entry = popUndo(editState);
    if (!entry) {
      statusText.value = "无可撤销操作";
      return true;
    }
    void applyUndoEntry(entry);
    return true;
  }

  // Ctrl+Y 或 Ctrl+Shift+Z 重做。
  function handleRedoKeydown(event) {
    const isRedo =
      ((event.ctrlKey || event.metaKey) && event.key === "y") ||
      ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "z" || event.key === "Z"));
    if (!isRedo) return false;
    event.preventDefault();
    const entry = popRedo(editState);
    if (!entry) {
      statusText.value = "无可重做操作";
      return true;
    }
    void applyRedoEntry(entry);
    return true;
  }

  return { handleUndoKeydown, handleRedoKeydown };
}
