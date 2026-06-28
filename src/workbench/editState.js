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
    redoStack: [],
    mutationVersion: 0,
  };
}

function bumpMutationVersion(edit) {
  if (!edit) return;
  edit.mutationVersion = Math.max(0, Math.floor(Number(edit.mutationVersion) || 0)) + 1;
}

export function getEditMutationVersion(edit) {
  return Math.max(0, Math.floor(Number(edit?.mutationVersion) || 0));
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
  bumpMutationVersion(edit);
  return key;
}

export function finishCellCommit(edit, key) {
  const entry = edit.pendingCells.get(key);
  if (!entry) return false;
  edit.pendingCells.delete(key);
  edit.optimisticValues.delete(key);
  edit.cellErrors.delete(key);
  edit.undoStack.push({ ...entry });
  // 新提交使 redo 历史失效。
  if (edit.redoStack) edit.redoStack.length = 0;
  bumpMutationVersion(edit);
  return true;
}

export function failCellCommit(edit, key, message = "") {
  const entry = edit.pendingCells.get(key);
  if (!entry) return false;
  edit.pendingCells.delete(key);
  edit.optimisticValues.delete(key);
  edit.cellErrors.set(key, String(message || "保存失败"));
  bumpMutationVersion(edit);
  return true;
}

export function isCellPending(edit, tableName, rowKey, columnName) {
  return Boolean(edit?.pendingCells?.has(cellKey(tableName, rowKey, columnName)));
}

export function getCellError(edit, tableName, rowKey, columnName) {
  return edit?.cellErrors?.get(cellKey(tableName, rowKey, columnName)) || "";
}

export function clearCellError(edit, tableName, rowKey, columnName) {
  const cleared = Boolean(edit?.cellErrors?.delete(cellKey(tableName, rowKey, columnName)));
  if (cleared) bumpMutationVersion(edit);
  return cleared;
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
  if (cleared > 0) bumpMutationVersion(edit);
  return cleared;
}

export function getOptimisticCellValue(edit, tableName, rowKey, columnName) {
  const key = cellKey(tableName, rowKey, columnName);
  return edit?.optimisticValues?.has(key) ? edit.optimisticValues.get(key) : null;
}

export function popUndo(edit) {
  if (!edit?.undoStack?.length) return null;
  const entry = edit.undoStack.pop();
  bumpMutationVersion(edit);
  return entry;
}

export function popRedo(edit) {
  if (!edit?.redoStack?.length) return null;
  const entry = edit.redoStack.pop();
  bumpMutationVersion(edit);
  return entry;
}

// 新的编辑提交会清空 redo 栈：一旦在撤销后做了新操作，旧的 redo 历史作废。
export function clearRedoStack(edit) {
  if (!edit?.redoStack?.length) return;
  edit.redoStack.length = 0;
  bumpMutationVersion(edit);
}
