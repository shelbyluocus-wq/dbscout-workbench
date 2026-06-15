const KEY_SEPARATOR = "\u001f";

function cellKey(tableName, rowKey, columnName) {
  return [tableName, rowKey, columnName].map((value) => String(value ?? "")).join(KEY_SEPARATOR);
}

export function createEditState() {
  return {
    pendingCells: new Map(),
    optimisticValues: new Map(),
    cellErrors: new Map(),
    undoStack: [],
  };
}

export function startCellCommit(
  edit,
  { tableName = "", rowKey = "", columnName = "", oldValue = "", newValue = "" } = {},
) {
  const key = cellKey(tableName, rowKey, columnName);
  const entry = {
    tableName: String(tableName),
    rowKey: String(rowKey),
    columnName: String(columnName),
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
  };
  edit.pendingCells.set(key, entry);
  edit.optimisticValues.set(key, entry.newValue);
  edit.cellErrors.delete(key);
  return key;
}

export function finishCellCommit(edit, key) {
  const entry = edit.pendingCells.get(key);
  if (!entry) return false;
  edit.pendingCells.delete(key);
  edit.optimisticValues.delete(key);
  edit.cellErrors.delete(key);
  edit.undoStack.push({ ...entry });
  return true;
}

export function failCellCommit(edit, key, message = "") {
  const entry = edit.pendingCells.get(key);
  if (!entry) return false;
  edit.pendingCells.delete(key);
  edit.optimisticValues.delete(key);
  edit.cellErrors.set(key, String(message || "保存失败"));
  return true;
}

export function isCellPending(edit, tableName, rowKey, columnName) {
  return Boolean(edit?.pendingCells?.has(cellKey(tableName, rowKey, columnName)));
}

export function getCellError(edit, tableName, rowKey, columnName) {
  return edit?.cellErrors?.get(cellKey(tableName, rowKey, columnName)) || "";
}

export function clearCellError(edit, tableName, rowKey, columnName) {
  return Boolean(edit?.cellErrors?.delete(cellKey(tableName, rowKey, columnName)));
}

export function clearCellErrorsForTable(edit, tableName) {
  if (!edit?.cellErrors || !tableName) return 0;
  const scopePrefix = `${String(tableName)}${KEY_SEPARATOR}`;
  let cleared = 0;
  for (const key of [...edit.cellErrors.keys()]) {
    if (key.startsWith(scopePrefix)) {
      edit.cellErrors.delete(key);
      cleared++;
    }
  }
  return cleared;
}

export function getOptimisticCellValue(edit, tableName, rowKey, columnName) {
  const key = cellKey(tableName, rowKey, columnName);
  return edit?.optimisticValues?.has(key) ? edit.optimisticValues.get(key) : null;
}

export function popUndo(edit) {
  if (!edit?.undoStack?.length) return null;
  return edit.undoStack.pop();
}
