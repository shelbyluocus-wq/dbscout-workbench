import { popUndo, popRedo } from "../editState.js";
import { buildRowKey, buildRowIdentity } from "../utils/rowIdentity.js";
import { mutateTabRow } from "../rowStore.js";
import { createRowIndex } from "../utils/rowIndex.js";

export function useUndo(editState, invokeWorkbench, activeTab, { statusText }) {
  function ensureSaved(result) {
    if (result?.conflict) throw new Error("数据已被别人修改，请刷新后再试");
  }

  function ensureBatchSaved(result, expectedRows) {
    ensureSaved(result);
    const updatedRows = Number(result?.updated);
    if (Number.isFinite(updatedRows) && updatedRows !== expectedRows) {
      throw new Error(`保存结果不完整：预期 ${expectedRows} 行，实际 ${updatedRows} 行`);
    }
  }

  function cloneHistoryEntry(entry) {
    if (entry?.kind !== "cell-batch") return { ...entry };
    return { ...entry, entries: entry.entries.map((item) => ({ ...item })) };
  }

  function batchRowGroups(entry) {
    const groups = new Map();
    for (const item of entry?.entries || []) {
      const fallbackIdentity = item.beforeIdentity || item.afterIdentity || {};
      const key = item.undoRowId != null
        ? `row:${item.undoRowId}`
        : `identity:${JSON.stringify(fallbackIdentity)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.values()];
  }

  function currentCellValue(row, columnName) {
    return row?.[columnName] == null ? null : String(row[columnName]);
  }

  async function applyBatchEntry(entry, direction) {
    const undoing = direction === "undo";
    const sourceStack = undoing ? editState.undoStack : editState.redoStack;
    const targetStack = undoing ? editState.redoStack : editState.undoStack;
    const actionLabel = undoing ? "撤销" : "重做";
    const tab = activeTab.value;
    if (!tab || (tab.tableKey || tab.tableName) !== entry.tableName) {
      sourceStack.push(entry);
      statusText.value = `无可${actionLabel}操作（当前表不匹配）`;
      return;
    }

    const rows = [];
    for (const entries of batchRowGroups(entry)) {
      const first = entries[0];
      const last = entries.at(-1);
      const currentRowKey = undoing
        ? last.afterRowKey || last.rowKey
        : first.beforeRowKey || first.rowKey;
      const index = createRowIndex(tab, { buildRowKey });
      const rowIndex = index.indexOfKey(currentRowKey);
      const row = index.rowForKey(currentRowKey);
      if (!row) {
        sourceStack.push(entry);
        statusText.value = `无可${actionLabel}操作（行不存在）`;
        return;
      }
      rows.push({ entries, first, last, row, rowIndex });
    }

    try {
      const result = await invokeWorkbench("update_cells", {
        request: {
          sessionId: tab.sessionId,
          rows: rows.map(({ entries, first, last, row }) => ({
            rowIdentity: undoing
              ? last.afterIdentity || buildRowIdentity(tab, row)
              : first.beforeIdentity || buildRowIdentity(tab, row),
            changes: entries.map((item) => ({
              columnName: item.columnName,
              oldValue: currentCellValue(row, item.columnName),
              newValue: undoing ? item.oldValue : item.newValue,
            })),
          })),
        },
      });
      ensureBatchSaved(result, rows.length);
      for (const { entries, rowIndex } of rows) {
        mutateTabRow(tab, rowIndex, (current) => {
          for (const item of entries) {
            current[item.columnName] = undoing ? item.oldValue : item.newValue;
          }
          return current;
        });
      }
      targetStack.push(cloneHistoryEntry(entry));
      statusText.value = `已${actionLabel} ${entry.entries.length} 个单元格`;
    } catch (error) {
      sourceStack.push(entry);
      statusText.value = `${actionLabel}失败：${String(error)}`;
    }
  }

  // 把一个 undo entry 反向应用：把单元格恢复为 oldValue，并把该 entry 推入 redo 栈。
  async function applyUndoEntry(entry) {
    if (entry?.kind === "cell-batch") {
      await applyBatchEntry(entry, "undo");
      return;
    }
    const tab = activeTab.value;
    if (!tab || (tab.tableKey || tab.tableName) !== entry.tableName) {
      editState.undoStack.push(entry);
      statusText.value = "无可撤销操作（当前表不匹配）";
      return;
    }
    const index = createRowIndex(tab, { buildRowKey });
    const currentRowKey = entry.afterRowKey || entry.rowKey;
    const rowIndex = index.indexOfKey(currentRowKey);
    const row = index.rowForKey(currentRowKey);
    if (!row) {
      editState.undoStack.push(entry);
      statusText.value = "无可撤销操作（行不存在）";
      return;
    }
    try {
      const result = await invokeWorkbench("update_cell", {
        request: {
          sessionId: tab.sessionId,
          rowIdentity: entry.afterIdentity || buildRowIdentity(tab, row),
          columnName: entry.columnName,
          oldValue: row[entry.columnName] == null ? null : String(row[entry.columnName]),
          newValue: entry.oldValue,
        },
      });
      ensureSaved(result);
      mutateTabRow(tab, rowIndex, (current) => ({ ...current, [entry.columnName]: entry.oldValue }));
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
    if (entry?.kind === "cell-batch") {
      await applyBatchEntry(entry, "redo");
      return;
    }
    const tab = activeTab.value;
    if (!tab || (tab.tableKey || tab.tableName) !== entry.tableName) {
      editState.redoStack.push(entry);
      statusText.value = "无可重做操作（当前表不匹配）";
      return;
    }
    const index = createRowIndex(tab, { buildRowKey });
    const currentRowKey = entry.beforeRowKey || entry.rowKey;
    const rowIndex = index.indexOfKey(currentRowKey);
    const row = index.rowForKey(currentRowKey);
    if (!row) {
      editState.redoStack.push(entry);
      statusText.value = "无可重做操作（行不存在）";
      return;
    }
    try {
      const result = await invokeWorkbench("update_cell", {
        request: {
          sessionId: tab.sessionId,
          rowIdentity: entry.beforeIdentity || buildRowIdentity(tab, row),
          columnName: entry.columnName,
          oldValue: row[entry.columnName] == null ? null : String(row[entry.columnName]),
          newValue: entry.newValue,
        },
      });
      ensureSaved(result);
      mutateTabRow(tab, rowIndex, (current) => ({ ...current, [entry.columnName]: entry.newValue }));
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
