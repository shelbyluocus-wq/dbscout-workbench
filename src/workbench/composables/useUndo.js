import { popUndo } from "../editState.js";
import { buildRowKey, buildRowIdentity } from "../utils/rowIdentity.js";

export function useUndo(editState, invokeWorkbench, activeTab, { statusText }) {
  async function handleUndoKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.key !== "z") return;
    event.preventDefault();
    const entry = popUndo(editState);
    if (!entry) {
      statusText.value = "无可撤销操作";
      return;
    }
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
      statusText.value = "已撤销";
    } catch (error) {
      editState.undoStack.push(entry);
      statusText.value = `撤销失败：${String(error)}`;
    }
  }

  return { handleUndoKeydown };
}
