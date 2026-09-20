const KEY_SEPARATOR = "\u001f";

export function collectCellStatesForTable(edit, tableName) {
  const states = new Map();
  const prefix = `${tableName ?? ""}${KEY_SEPARATOR}`;
  function bucket(key) {
    const split = key.lastIndexOf(KEY_SEPARATOR);
    const rowKey = key.slice(prefix.length, split);
    if (!states.has(rowKey)) states.set(rowKey, { pending: new Set(), errors: new Map() });
    return [states.get(rowKey), key.slice(split + 1)];
  }
  for (const key of edit.pendingCells.keys()) {
    if (!key.startsWith(prefix)) continue;
    const [state, column] = bucket(key);
    state.pending.add(column);
  }
  for (const [key, message] of edit.cellErrors) {
    if (!key.startsWith(prefix)) continue;
    const [state, column] = bucket(key);
    state.errors.set(column, message);
  }
  return states;
}

function cellKey(tableName, rowKey, columnName) {
  return [tableName, rowKey, columnName].map((value) => String(value ?? "")).join(KEY_SEPARATOR);
}

export function createEditState() {
  return {
    pendingCells: new Map(),
    pendingCellCommits: new Map(),
    optimisticValues: new Map(),
    cellErrors: new Map(),
    undoStack: [],
    redoStack: [],
    mutationVersion: 0,
    nextCommitId: 1,
    nextUndoGroupId: 1,
    nextUndoTransactionId: 1,
    pendingUndoTransactions: new Map(),
    historyTransactionWaiters: new Map(),
    nextHistoryOperationId: 1,
    pendingHistoryOperations: new Map(),
    historyOperationWaiters: [],
    nextHistoryActionId: 1,
    nextHistoryEntryId: 1,
    activeHistoryEntries: new Map(),
    nextMutationTurnId: 1,
    mutationQueues: new Map(),
    rowSaveLanes: new Map(),
    rowSaveTokens: new WeakMap(),
    pendingInsertRows: new Set(),
    insertRowReservations: new Map(),
    // 整表替换撤销/重做的分块进度（{ label, done, total }），null 表示空闲。
    historyProgress: null,
  };
}

export function beginMutationTurn(edit, scope = "", metadata = {}) {
  if (!edit) return null;
  if (!(edit.mutationQueues instanceof Map)) edit.mutationQueues = new Map();
  const normalizedScope = String(scope || "");
  let queue = edit.mutationQueues.get(normalizedScope);
  if (!queue) {
    queue = { tail: Promise.resolve(), turns: new Set() };
    edit.mutationQueues.set(normalizedScope, queue);
  }
  const id = Math.max(1, Math.floor(Number(edit.nextMutationTurnId) || 1));
  edit.nextMutationTurnId = id + 1;
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  const turn = {
    id,
    scope: normalizedScope,
    ready: Promise.resolve(queue.tail),
    done,
    release,
    metadata,
    finished: false,
    taskTail: Promise.resolve(),
    queue,
  };
  queue.turns.add(turn);
  queue.tail = done;
  return turn;
}

export function enqueueMutationTask(turn, task) {
  if (!turn || typeof task !== "function") return Promise.resolve();
  const ready = Promise.all([
    Promise.resolve(turn.ready),
    Promise.resolve(turn.taskTail),
  ]);
  const run = ready.then(task, task);
  turn.taskTail = run.catch(() => {});
  return run;
}

export function finishMutationTurn(edit, turn) {
  if (!edit || !turn || turn.finished) return false;
  turn.finished = true;
  void Promise.all([
    Promise.resolve(turn.ready),
    Promise.resolve(turn.taskTail).catch(() => {}),
  ]).finally(() => {
    turn.queue?.turns?.delete?.(turn);
    turn.release?.();
    if (turn.queue?.turns?.size === 0 && edit.mutationQueues?.get?.(turn.scope) === turn.queue) {
      edit.mutationQueues.delete(turn.scope);
    }
  });
  return true;
}

export function createUndoTransaction(editOrOptions = {}, maybeOptions = {}) {
  const edit = editOrOptions?.undoStack ? editOrOptions : null;
  const options = edit ? maybeOptions : editOrOptions;
  const transaction = {
    kind: "undo-transaction",
    id: null,
    tableName: String(options?.tableName || ""),
    tabId: options?.tabId ?? null,
    label: String(options?.label || ""),
    entries: [],
    committed: false,
  };
  if (edit) {
    if (!(edit.pendingUndoTransactions instanceof Map)) edit.pendingUndoTransactions = new Map();
    const id = Math.max(1, Math.floor(Number(edit.nextUndoTransactionId) || 1));
    edit.nextUndoTransactionId = id + 1;
    transaction.id = id;
    transaction.slot = {
      kind: "history-slot",
      transactionId: id,
      tableName: transaction.tableName,
      tabId: transaction.tabId,
      tabScoped: transaction.tabId != null,
    };
    edit.pendingUndoTransactions.set(id, transaction);
    edit.undoStack.push(transaction.slot);
    transaction.mutationTurn = beginMutationTurn(edit, transaction.tableName, {
      kind: "forward",
      transactionId: id,
    });
    bumpMutationVersion(edit);
  }
  return transaction;
}

function clearRedoForNewHistory(edit, scope = "") {
  if (!edit?.redoStack?.length) return;
  const normalizedScope = String(scope || "");
  if (!normalizedScope) {
    edit.redoStack.length = 0;
    return;
  }
  for (let index = edit.redoStack.length - 1; index >= 0; index--) {
    if (String(edit.redoStack[index]?.tableName || "") === normalizedScope) {
      edit.redoStack.splice(index, 1);
    }
  }
}

function isOpenUndoTransaction(transaction) {
  return transaction?.kind === "undo-transaction" && !transaction.committed;
}

function appendUndoEntry(edit, entry, transaction = null, { notify = true } = {}) {
  if (transaction) {
    if (!isOpenUndoTransaction(transaction)) return false;
    if (entry.tabId == null && transaction.tabId != null) entry.tabId = transaction.tabId;
    transaction.entries.push(entry);
    return true;
  }
  edit.undoStack.push(entry);
  if (notify) {
    clearRedoForNewHistory(edit, entry?.tableName);
    bumpMutationVersion(edit);
  }
  return true;
}

export function commitUndoTransaction(edit, transaction) {
  if (!edit || transaction?.kind !== "undo-transaction" || transaction.committed) return false;
  transaction.committed = true;
  if (transaction.id != null && edit.pendingUndoTransactions instanceof Map) {
    edit.pendingUndoTransactions.delete(transaction.id);
  }
  const entries = Array.isArray(transaction.entries) ? transaction.entries.filter(Boolean) : [];
  const entry = entries.length === 1
    ? entries[0]
    : entries.length > 1 ? {
        kind: "history-composite",
        tableName: transaction.tableName || entries[0]?.tableName || "",
        tabId: transaction.tabId,
        label: transaction.label,
        entries: [...entries],
      } : null;
  if (entry) {
    entry.historyTransactionId = transaction.id;
    entry.mutationTurnId = transaction.mutationTurn?.id ?? entry.mutationTurnId ?? null;
    if (entry.tabId == null && transaction.tabId != null) entry.tabId = transaction.tabId;
  }
  transaction.finalEntry = entry;
  const slotIndex = edit.undoStack.findIndex(
    (candidate) => candidate?.kind === "history-slot" && candidate.transactionId === transaction.id,
  );
  if (slotIndex >= 0) {
    if (entry) edit.undoStack.splice(slotIndex, 1, entry);
    else edit.undoStack.splice(slotIndex, 1);
  } else if (entry) {
    edit.undoStack.push(entry);
  }
  if (entry) {
    clearRedoForNewHistory(edit, entry.tableName);
    // Local draft edits publish their history immediately, while their table
    // turn may still be waiting behind an undo. Clear again inside that turn so
    // redo entries produced by the older action cannot survive the new edit.
    enqueueMutationTask(transaction.mutationTurn, () => {
      clearRedoForNewHistory(edit, entry.tableName);
    });
  }
  const waiters = edit.historyTransactionWaiters instanceof Map
    ? edit.historyTransactionWaiters.get(transaction.id) || []
    : [];
  edit.historyTransactionWaiters?.delete?.(transaction.id);
  for (const resolve of waiters) resolve(entry);
  finishMutationTurn(edit, transaction.mutationTurn);
  bumpMutationVersion(edit);
  return Boolean(entry);
}

export function waitForUndoTransaction(edit, transactionId) {
  const id = Math.floor(Number(transactionId));
  if (!edit || !Number.isFinite(id)) return Promise.resolve(null);
  const pending = edit.pendingUndoTransactions instanceof Map
    ? edit.pendingUndoTransactions.get(id)
    : null;
  if (!pending) return Promise.resolve(null);
  if (!(edit.historyTransactionWaiters instanceof Map)) edit.historyTransactionWaiters = new Map();
  return new Promise((resolve) => {
    const waiters = edit.historyTransactionWaiters.get(id) || [];
    waiters.push(resolve);
    edit.historyTransactionWaiters.set(id, waiters);
  });
}

export function startUndoGroup(edit) {
  const groupId = Math.max(1, Math.floor(Number(edit?.nextUndoGroupId) || 1));
  if (edit) edit.nextUndoGroupId = groupId + 1;
  return groupId;
}

export function recordUndoEntry(edit, entry, transaction = null) {
  if (!edit || !entry) return false;
  return appendUndoEntry(edit, entry, transaction);
}

// 登记一条"整表替换"历史项：patches 为后端 replace_in_table 返回的逐行变更
// （正向：oldValue 替换前、newValue 替换后），撤销/重做由 useUndo 分块反向
// 重放。与普通单元格历史不同，它不要求行已加载到前端。
export function recordTableReplaceHistory(edit, { tableName, tabId = null, label = "整表替换", patches = [] } = {}) {
  if (!edit?.undoStack || !Array.isArray(patches) || !patches.length) return false;
  const cellCount = patches.reduce((total, patch) => total + (patch?.changes?.length || 0), 0);
  return appendUndoEntry(edit, {
    kind: "table-replace",
    tableName: String(tableName || ""),
    tabId,
    label,
    cellCount,
    patches,
  });
}

export function beginHistoryAction(edit, entry, direction, context = null) {
  if (!edit || !entry) return null;
  if (!(edit.activeHistoryEntries instanceof Map)) edit.activeHistoryEntries = new Map();
  const id = Math.max(1, Math.floor(Number(edit.nextHistoryActionId) || 1));
  edit.nextHistoryActionId = id + 1;
  const action = { id, entry, direction, context };
  edit.activeHistoryEntries.set(id, action);
  return action;
}

export function finishHistoryAction(edit, action) {
  if (!edit || !action || !(edit.activeHistoryEntries instanceof Map)) return false;
  return edit.activeHistoryEntries.delete(action.id);
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
  {
    tableName = "",
    rowKey = "",
    columnName = "",
    oldValue = "",
    newValue = "",
    beforeRowKey = rowKey,
    afterRowKey = rowKey,
    beforeIdentity = null,
    afterIdentity = null,
    undoGroupId = null,
    undoRowId = null,
    rowRef = null,
    tabId = null,
  } = {},
) {
  const key = cellKey(tableName, rowKey, columnName);
  const commitId = Math.max(1, Math.floor(Number(edit.nextCommitId) || 1));
  edit.nextCommitId = commitId + 1;
  const entry = {
    commitId,
    tableName: String(tableName),
    rowKey: String(rowKey),
    beforeRowKey: String(beforeRowKey),
    afterRowKey: String(afterRowKey),
    beforeIdentity: beforeIdentity ? { ...beforeIdentity } : null,
    afterIdentity: afterIdentity ? { ...afterIdentity } : null,
    columnName: String(columnName),
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    undoGroupId,
    undoRowId,
  };
  if (tabId != null) entry.tabId = tabId;
  if (rowRef && typeof WeakRef === "function") entry.rowRef = new WeakRef(rowRef);
  if (!(edit.pendingCellCommits instanceof Map)) edit.pendingCellCommits = new Map();
  edit.pendingCellCommits.set(commitId, { key, entry });
  edit.pendingCells.set(key, entry);
  edit.optimisticValues.set(key, entry.newValue);
  edit.cellErrors.delete(key);
  bumpMutationVersion(edit);
  return key;
}

function pendingCellCommit(edit, key, commitId = null) {
  if (commitId != null && edit?.pendingCellCommits instanceof Map) {
    const pending = edit.pendingCellCommits.get(commitId);
    return pending?.key === key ? pending.entry : null;
  }
  return edit?.pendingCells?.get(key) || null;
}

function settlePendingCellCommit(edit, key, entry) {
  if (!edit || !entry) return;
  edit.pendingCellCommits?.delete?.(entry.commitId);
  const latest = edit.pendingCells.get(key);
  if (latest?.commitId !== entry.commitId) return;
  let replacement = null;
  if (edit.pendingCellCommits instanceof Map) {
    for (const pending of edit.pendingCellCommits.values()) {
      if (pending?.key !== key) continue;
      if (!replacement || pending.entry.commitId > replacement.commitId) replacement = pending.entry;
    }
  }
  if (replacement) {
    edit.pendingCells.set(key, replacement);
    edit.optimisticValues.set(key, replacement.newValue);
  } else {
    edit.pendingCells.delete(key);
    edit.optimisticValues.delete(key);
  }
}

export function finishCellCommit(edit, key, commitId = null, overrides = {}) {
  const entry = pendingCellCommit(edit, key, commitId);
  if (!entry) return false;
  const mergedEntry = { ...entry, ...overrides };
  if (mergedEntry.undoTransaction && !isOpenUndoTransaction(mergedEntry.undoTransaction)) return false;
  settlePendingCellCommit(edit, key, entry);
  edit.cellErrors.delete(key);
  const {
    commitId: _commitId,
    undoGroupId,
    undoRowId,
    undoTransaction,
    ...undoEntry
  } = mergedEntry;
  if (undoGroupId != null) {
    const historyEntries = undoTransaction?.kind === "undo-transaction"
      ? undoTransaction.entries
      : edit.undoStack;
    let group = historyEntries.find(
      (item) => item?.kind === "cell-batch" && item.groupId === undoGroupId,
    );
    if (!group) {
      group = {
        kind: "cell-batch",
        groupId: undoGroupId,
        tableName: undoEntry.tableName,
        entries: [],
      };
      if (undoEntry.tabId != null) group.tabId = undoEntry.tabId;
      if (!appendUndoEntry(edit, group, undoTransaction, { notify: false })) return false;
    }
    group.entries.push({ ...undoEntry, undoRowId });
  } else {
    if (!appendUndoEntry(edit, undoEntry, undoTransaction, { notify: false })) return false;
  }
  if (!undoTransaction) clearRedoForNewHistory(edit, undoEntry.tableName);
  bumpMutationVersion(edit);
  return true;
}

export function beginHistoryOperation(edit, scope = "") {
  if (!edit) return null;
  if (!(edit.pendingHistoryOperations instanceof Map)) edit.pendingHistoryOperations = new Map();
  const id = Math.max(1, Math.floor(Number(edit.nextHistoryOperationId) || 1));
  edit.nextHistoryOperationId = id + 1;
  const operation = { id, scope: String(scope || "") };
  edit.pendingHistoryOperations.set(id, operation);
  return operation;
}

export function finishHistoryOperation(edit, operation) {
  const id = Math.floor(Number(operation?.id));
  if (!edit || !Number.isFinite(id) || !(edit.pendingHistoryOperations instanceof Map)) return false;
  if (!edit.pendingHistoryOperations.delete(id)) return false;
  if (Array.isArray(edit.historyOperationWaiters)) {
    for (let index = edit.historyOperationWaiters.length - 1; index >= 0; index--) {
      const waiter = edit.historyOperationWaiters[index];
      const waiterScope = typeof waiter === "function" ? "" : String(waiter?.scope || "");
      if (hasPendingHistoryOperations(edit, waiterScope)) continue;
      edit.historyOperationWaiters.splice(index, 1);
      if (typeof waiter === "function") waiter();
      else waiter?.resolve?.();
    }
  }
  return true;
}

export function hasPendingHistoryOperations(edit, scope = "") {
  if (!(edit?.pendingHistoryOperations instanceof Map)) return false;
  const normalizedScope = String(scope || "");
  if (!normalizedScope) return edit.pendingHistoryOperations.size > 0;
  for (const operation of edit.pendingHistoryOperations.values()) {
    if (!operation?.scope || operation.scope === normalizedScope) return true;
  }
  return false;
}

export function waitForHistoryOperations(edit, scope = "") {
  const normalizedScope = String(scope || "");
  if (!hasPendingHistoryOperations(edit, normalizedScope)) return Promise.resolve();
  if (!Array.isArray(edit.historyOperationWaiters)) edit.historyOperationWaiters = [];
  return new Promise((resolve) => edit.historyOperationWaiters.push({ scope: normalizedScope, resolve }));
}

export function getRowSaveLane(edit, row) {
  if (!edit || !row || !(edit.rowSaveTokens instanceof WeakMap)) {
    return null;
  }
  const lane = edit.rowSaveTokens.get(row);
  if (lane && typeof lane === "object") return lane;
  return lane && edit.rowSaveLanes instanceof Map ? edit.rowSaveLanes.get(lane) || null : null;
}

export function rebaseRowSaveLane(edit, row, confirmedRow) {
  const lane = getRowSaveLane(edit, row);
  if (!lane || !confirmedRow) return false;
  lane.confirmedRow = { ...confirmedRow };
  const nextToken = lane.tokenForRow?.(confirmedRow);
  if (nextToken && nextToken !== lane.token) {
    if (edit.rowSaveLanes?.get?.(lane.token) === lane) edit.rowSaveLanes.delete(lane.token);
    lane.token = nextToken;
    if (lane.pendingCount > 0) edit.rowSaveLanes?.set?.(nextToken, lane);
  }
  return true;
}

export function failCellCommit(edit, key, message = "", commitId = null) {
  const entry = pendingCellCommit(edit, key, commitId);
  if (!entry) return false;
  settlePendingCellCommit(edit, key, entry);
  edit.cellErrors.set(key, String(message || "保存失败"));
  bumpMutationVersion(edit);
  return true;
}

export function discardCellCommit(edit, key, commitId = null) {
  const entry = pendingCellCommit(edit, key, commitId);
  if (!entry) return false;
  settlePendingCellCommit(edit, key, entry);
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

function popHistoryEntry(edit, stackName, matcher = null) {
  const stack = edit?.[stackName];
  if (!stack?.length) return null;
  let index = stack.length - 1;
  if (typeof matcher === "function") {
    while (index >= 0 && !matcher(stack[index])) index -= 1;
  }
  if (index < 0) return null;
  const [entry] = stack.splice(index, 1);
  bumpMutationVersion(edit);
  return entry;
}

export function popUndo(edit, matcher = null) {
  if (!edit?.undoStack?.length) return null;
  return popHistoryEntry(edit, "undoStack", matcher);
}

export function popRedo(edit, matcher = null) {
  if (!edit?.redoStack?.length) return null;
  return popHistoryEntry(edit, "redoStack", matcher);
}

// 新的编辑提交会清空 redo 栈：一旦在撤销后做了新操作，旧的 redo 历史作废。
export function clearRedoStack(edit) {
  if (!edit?.redoStack?.length) return;
  edit.redoStack.length = 0;
  bumpMutationVersion(edit);
}
