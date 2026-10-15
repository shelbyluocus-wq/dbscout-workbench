import { toRaw } from "vue";
import {
  beginHistoryAction,
  beginMutationTurn,
  enqueueMutationTask,
  finishHistoryAction,
  finishMutationTurn,
  getRowSaveLane,
  popRedo,
  popUndo,
  rebaseRowSaveLane,
  waitForUndoTransaction,
} from "../editState.js";
import { buildRowKey, buildRowIdentity, buildRowKeyFromIdentity } from "../utils/rowIdentity.js";
import { ensureTabRowStore, mutateTabRow, tabRows } from "../rowStore.js";
import { createRowIndex } from "../utils/rowIndex.js";

export function useUndo(
  editState,
  invokeWorkbench,
  activeTab,
  {
    statusText,
    applyLocalHistoryEntry = null,
    captureHistoryView = null,
    onCellCommitted = null,
    onHistoryApplied = null,
  },
) {
  function ensureSaved(result) {
    if (result?.conflict) throw new Error("数据已被别人修改，请刷新后再试");
    if (result?.updated === false) throw new Error("保存未影响任何数据，请刷新后再试");
  }

  function ensureBatchSaved(result, expectedRows) {
    ensureSaved(result);
    const updatedRows = Number(result?.updated);
    if (Number.isFinite(updatedRows) && updatedRows !== expectedRows) {
      throw new Error(`保存结果不完整：预期 ${expectedRows} 行，实际 ${updatedRows} 行`);
    }
  }

  function cloneHistoryEntry(entry) {
    if (!entry) return entry;
    if (entry.kind === "history-composite") {
      return { ...entry, entries: entry.entries.map(cloneHistoryEntry) };
    }
    if (entry.kind === "insert-draft-batch") {
      return {
        ...entry,
        changes: entry.changes.map((change) => ({
          ...change,
          before: change.before ? { ...change.before, draft: { ...change.before.draft } } : null,
          after: change.after ? { ...change.after, draft: { ...change.after.draft } } : null,
        })),
      };
    }
    if (entry.kind === "cell-batch") {
      return { ...entry, entries: entry.entries.map(cloneHistoryEntry) };
    }
    if (entry.kind === "table-replace") {
      return {
        ...entry,
        patches: (entry.patches || []).map((patch) => ({
          rowIdentity: { ...(patch?.rowIdentity || {}) },
          changes: (patch?.changes || []).map((change) => ({ ...change })),
        })),
      };
    }
    return {
      ...entry,
      beforeIdentity: entry.beforeIdentity ? { ...entry.beforeIdentity } : null,
      afterIdentity: entry.afterIdentity ? { ...entry.afterIdentity } : null,
    };
  }

  function captureHistoryContext() {
    const tab = activeTab.value;
    const scope = String(tab?.tableKey || tab?.tableName || "");
    return tab && scope ? { tab, scope, tabId: tab.id, sessionId: tab.sessionId } : null;
  }

  function historyEntryMatchesContext(entry, context) {
    if (!entry || !context?.scope) return false;
    if (String(entry.tableName || "") !== context.scope) return false;
    if (entry.tabId != null && entry.tabId !== context.tabId) return false;
    if (entry.kind === "history-composite") {
      return Array.isArray(entry.entries)
        && entry.entries.length > 0
        && entry.entries.every((child) => historyEntryMatchesContext(child, context));
    }
    if (entry.kind === "history-slot" && entry.tabScoped) return entry.tabId === context.tabId;
    if (entry.kind === "insert-draft-batch") return entry.tabId === context.tabId;
    return true;
  }

  function sameHistoryOwner(left, right) {
    return left?.scope === right?.scope && left?.tabId === right?.tabId;
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

  function loadedHistoryRow(tab, row) {
    const referencedRow = row ? toRaw(row) : null;
    if (!referencedRow) return null;
    const loadedRows = tabRows(tab);
    const loadedIndex = loadedRows.indexOf(referencedRow);
    if (loadedIndex < 0) return null;
    const absoluteStart = ensureTabRowStore(tab)?.absoluteStart || 0;
    return { row: loadedRows[loadedIndex], rowIndex: absoluteStart + loadedIndex };
  }

  function historyRow(tab, index, rowKey, entry) {
    const referenced = entry?.rowRef?.deref?.() || null;
    const loaded = loadedHistoryRow(tab, referenced);
    if (loaded) return loaded;
    return { row: index.rowForKey(rowKey), rowIndex: index.indexOfKey(rowKey) };
  }

  function historyRowAfterMutation(tab, originalRow, rowKeys) {
    const loaded = loadedHistoryRow(tab, originalRow);
    if (loaded) return loaded;
    const index = createRowIndex(tab, { buildRowKey });
    for (const rowKey of new Set(rowKeys.filter(Boolean))) {
      const row = index.rowForKey(rowKey);
      const rowIndex = index.indexOfKey(rowKey);
      if (row && rowIndex >= 0) return { row, rowIndex };
    }
    return { row: null, rowIndex: -1 };
  }

  function expectedCellValue(entry, direction) {
    return direction === "undo" ? entry.newValue : entry.oldValue;
  }

  function targetCellValue(entry, direction) {
    return direction === "undo" ? entry.oldValue : entry.newValue;
  }

  function frozenRowIdentity(entry, direction) {
    const identity = direction === "undo" ? entry?.afterIdentity : entry?.beforeIdentity;
    return identity && typeof identity === "object" && Object.keys(identity).length > 0
      ? identity
      : null;
  }

  function committedCellEvent(tab, entry, direction) {
    return {
      tab,
      rowKey: direction === "undo"
        ? entry.afterRowKey || entry.rowKey
        : entry.beforeRowKey || entry.rowKey,
      column: entry.columnName,
      oldValue: expectedCellValue(entry, direction),
      newValue: targetCellValue(entry, direction),
    };
  }

  function rebaseConfirmedRow(row, changes) {
    const lane = getRowSaveLane(editState, row);
    if (!lane) return;
    const confirmed = { ...lane.confirmedRow };
    for (const { columnName, value } of changes) confirmed[columnName] = value;
    rebaseRowSaveLane(editState, row, confirmed);
  }

  function rebaseHistoryRows(originalRow, currentRow, changes) {
    rebaseConfirmedRow(originalRow, changes);
    if (currentRow && toRaw(currentRow) !== toRaw(originalRow)) {
      rebaseConfirmedRow(currentRow, changes);
    }
  }

  function requireMatchingTab(entry, context) {
    const tab = context?.tab;
    if (!tab || !historyEntryMatchesContext(entry, context)) {
      throw new Error("当前表不匹配");
    }
    return tab;
  }

  async function applyLocalEntry(entry, direction, context) {
    if (entry?.invalidated) return { count: 0, label: entry.label || "", kind: "local" };
    requireMatchingTab(entry, context);
    if (typeof applyLocalHistoryEntry !== "function") {
      throw new Error("本地编辑器不可用");
    }
    const result = await applyLocalHistoryEntry(entry, direction, context.tab, context);
    if (!result?.ok) throw new Error(result?.reason || "新增行已不存在");
    return {
      count: Math.max(0, Number(result.count) || 0),
      label: result.label || entry.label || "",
      kind: "local",
      committedCells: [],
    };
  }

  async function applyBatchEntry(entry, direction, context) {
    const undoing = direction === "undo";
    const tab = requireMatchingTab(entry, context);
    const index = createRowIndex(tab, { buildRowKey });
    const rows = [];
    for (const entries of batchRowGroups(entry)) {
      const first = entries[0];
      const last = entries.at(-1);
      const currentRowKey = undoing
        ? last.afterRowKey || last.rowKey
        : first.beforeRowKey || first.rowKey;
      const targetRowKey = undoing
        ? first.beforeRowKey || first.rowKey
        : last.afterRowKey || last.rowKey;
      const resolved = historyRow(tab, index, currentRowKey, first);
      const { row } = resolved;
      const rowIdentity = frozenRowIdentity(undoing ? last : first, direction);
      if (!row && !rowIdentity) throw new Error("行不存在");
      rows.push({ entries, row, rowIdentity, currentRowKey, targetRowKey });
    }

    const result = await invokeWorkbench("update_cells", {
      request: {
        sessionId: context.sessionId,
        rows: rows.map(({ entries, row, rowIdentity }) => ({
          rowIdentity: rowIdentity || buildRowIdentity(tab, row),
          changes: entries.map((item) => ({
            columnName: item.columnName,
            oldValue: expectedCellValue(item, direction),
            newValue: targetCellValue(item, direction),
          })),
        })),
      },
    });
    ensureBatchSaved(result, rows.length);
    const committedCells = [];
    for (const { entries, row, currentRowKey, targetRowKey } of rows) {
      const current = historyRowAfterMutation(tab, row, [targetRowKey, currentRowKey]);
      if (current.row) {
        mutateTabRow(tab, current.rowIndex, (loadedRow) => {
          for (const item of entries) {
            if (currentCellValue(loadedRow, item.columnName) === expectedCellValue(item, direction)) {
              loadedRow[item.columnName] = targetCellValue(item, direction);
            }
          }
          return loadedRow;
        });
      }
      const changes = entries.map((item) => ({
        columnName: item.columnName,
        value: targetCellValue(item, direction),
      }));
      rebaseHistoryRows(row, current.row, changes);
      const orderedEntries = undoing ? [...entries].reverse() : entries;
      committedCells.push(...orderedEntries.map((item) => committedCellEvent(tab, item, direction)));
    }
    return { count: entry.entries.length, kind: "cell-batch", committedCells };
  }

  async function applyCellEntry(entry, direction, context) {
    const undoing = direction === "undo";
    const tab = requireMatchingTab(entry, context);
    const index = createRowIndex(tab, { buildRowKey });
    const currentRowKey = undoing
      ? entry.afterRowKey || entry.rowKey
      : entry.beforeRowKey || entry.rowKey;
    const targetRowKey = undoing
      ? entry.beforeRowKey || entry.rowKey
      : entry.afterRowKey || entry.rowKey;
    const { row } = historyRow(tab, index, currentRowKey, entry);
    const rowIdentity = frozenRowIdentity(entry, direction);
    if (!row && !rowIdentity) throw new Error("行不存在");
    const result = await invokeWorkbench("update_cell", {
      request: {
        sessionId: context.sessionId,
        rowIdentity: rowIdentity || buildRowIdentity(tab, row),
        columnName: entry.columnName,
        oldValue: expectedCellValue(entry, direction),
        newValue: targetCellValue(entry, direction),
      },
    });
    ensureSaved(result);
    const current = historyRowAfterMutation(tab, row, [targetRowKey, currentRowKey]);
    if (current.row) {
      mutateTabRow(tab, current.rowIndex, (loadedRow) => {
        if (currentCellValue(loadedRow, entry.columnName) === expectedCellValue(entry, direction)) {
          loadedRow[entry.columnName] = targetCellValue(entry, direction);
        }
        return loadedRow;
      });
    }
    rebaseHistoryRows(row, current.row, [{
      columnName: entry.columnName,
      value: targetCellValue(entry, direction),
    }]);
    return {
      count: 1,
      kind: "cell",
      committedCells: [committedCellEvent(tab, entry, direction)],
    };
  }

  // 整表替换历史项：patches 为正向变更（替换前 → 替换后）。撤销时逐行反转
  // oldValue/newValue，并把行标识推进到替换后的值（替换可能改了主键列）。
  // 分块调用 update_cells（每块原子提交），通过 editState.historyProgress
  // 暴露进度；中途失败时把历史项裁剪为未处理部分，允许直接重试。
  const TABLE_REPLACE_CHUNK_SIZE = 500;

  function identityAfterChanges(rowIdentity, changes) {
    const next = { ...(rowIdentity || {}) };
    for (const change of changes || []) {
      if (change.columnName in next) next[change.columnName] = change.newValue ?? null;
    }
    return next;
  }

  async function applyTableReplaceEntry(entry, direction, context) {
    const undoing = direction === "undo";
    requireMatchingTab(entry, context);
    const tab = context.tab;
    const patches = Array.isArray(entry.patches) ? entry.patches : [];
    const total = patches.length;
    const label = undoing ? "正在撤销整表替换" : "正在重做整表替换";
    let processed = 0;
    editState.historyProgress = { label, done: 0, total };
    try {
      while (processed < total) {
        const chunk = patches.slice(processed, processed + TABLE_REPLACE_CHUNK_SIZE);
        const rows = chunk.map((patch) => ({
          rowIdentity: undoing
            ? identityAfterChanges(patch.rowIdentity, patch.changes)
            : { ...(patch?.rowIdentity || {}) },
          changes: (patch?.changes || []).map((change) => ({
            columnName: change.columnName,
            oldValue: undoing ? change.newValue : change.oldValue,
            newValue: undoing ? change.oldValue : change.newValue,
          })),
        }));
        const result = await invokeWorkbench("update_cells", {
          request: { sessionId: context.sessionId, rows },
        });
        ensureBatchSaved(result, rows.length);
        // 同步已加载行的显示值（未加载的行无需处理，刷新后自然一致）。
        const index = createRowIndex(tab, { buildRowKey });
        for (const { rowIdentity, changes } of rows) {
          const rowIndex = index.indexOfKey(buildRowKeyFromIdentity(tab, rowIdentity));
          if (rowIndex < 0) continue;
          mutateTabRow(tab, rowIndex, (loadedRow) => {
            for (const change of changes) {
              const expected = change.oldValue == null ? null : String(change.oldValue);
              if (currentCellValue(loadedRow, change.columnName) === expected) {
                loadedRow[change.columnName] = change.newValue;
              }
            }
            return loadedRow;
          });
        }
        processed += chunk.length;
        editState.historyProgress = { label, done: processed, total };
      }
    } catch (error) {
      if (processed > 0) {
        entry.patches = patches.slice(processed);
        entry.cellCount = entry.patches.reduce((sum, patch) => sum + (patch?.changes?.length || 0), 0);
      }
      throw error;
    } finally {
      editState.historyProgress = null;
    }
    return { count: entry.cellCount, kind: "table-replace", committedCells: [] };
  }

  async function applyCompositeEntry(entry, direction, context) {
    requireMatchingTab(entry, context);
    const ordered = direction === "undo" ? [...entry.entries].reverse() : [...entry.entries];
    const applied = [];
    const committedCells = [];
    let count = 0;
    try {
      for (const child of ordered) {
        const result = await applyHistoryEntry(child, direction, context);
        applied.push(child);
        count += Math.max(0, Number(result?.count) || 0);
        committedCells.push(...(result?.committedCells || []));
      }
    } catch (error) {
      const recoveryDirection = direction === "undo" ? "redo" : "undo";
      let recoveryFailed = false;
      for (const child of [...applied].reverse()) {
        try {
          await applyHistoryEntry(child, recoveryDirection, context);
        } catch {
          recoveryFailed = true;
        }
      }
      if (recoveryFailed) {
        throw new Error(`${String(error)}；部分已执行操作未能自动恢复`);
      }
      throw error;
    }
    return { count, label: entry.label || "", kind: "history-composite", committedCells };
  }

  async function applyHistoryEntry(entry, direction, context) {
    if (entry?.kind === "history-composite") return applyCompositeEntry(entry, direction, context);
    if (entry?.kind === "insert-draft-batch") return applyLocalEntry(entry, direction, context);
    if (entry?.kind === "cell-batch") return applyBatchEntry(entry, direction, context);
    if (entry?.kind === "table-replace") return applyTableReplaceEntry(entry, direction, context);
    return applyCellEntry(entry, direction, context);
  }

  function successStatus(entry, result, direction) {
    const actionLabel = direction === "undo" ? "撤销" : "重做";
    if (entry.kind === "cell-batch") {
      statusText.value = `已${actionLabel} ${entry.entries.length} 个单元格`;
      return;
    }
    if (entry.kind === "insert-draft-batch") {
      statusText.value = result.count > 1
        ? `已${actionLabel} ${result.count} 个新增行单元格`
        : `已${actionLabel}${result.label ? `：${result.label}` : ""}`;
      return;
    }
    if (entry.kind === "history-composite") {
      statusText.value = result.label
        ? `已${actionLabel}：${result.label}`
        : `已${actionLabel} ${result.count} 项修改`;
      return;
    }
    if (entry.kind === "table-replace") {
      statusText.value = `已${actionLabel}整表替换（${entry.cellCount ?? result.count} 个单元格）`;
      return;
    }
    statusText.value = `已${actionLabel}`;
  }

  function latestHistoryEntry(direction, context, allowedEntries = null) {
    const stack = direction === "undo" ? editState.undoStack : editState.redoStack;
    for (let cursor = stack.length - 1; cursor >= 0; cursor -= 1) {
      const candidate = stack[cursor];
      if (!historyEntryMatchesContext(candidate, context)) continue;
      if (allowedEntries && !allowedEntries(candidate)) continue;
      return { entry: candidate, index: cursor };
    }
    return null;
  }

  function ensureHistoryEntryId(entry) {
    if (!entry) return null;
    if (entry.historyEntryId != null) return entry.historyEntryId;
    const id = Math.max(1, Math.floor(Number(editState.nextHistoryEntryId) || 1));
    editState.nextHistoryEntryId = id + 1;
    entry.historyEntryId = id;
    return id;
  }

  function historyEntryIsReserved(entry, direction, context) {
    if (!(editState.activeHistoryEntries instanceof Map)) return false;
    for (const action of editState.activeHistoryEntries.values()) {
      if (action?.direction !== direction || !sameHistoryOwner(action?.context, context)) continue;
      if (action.transactionId != null) {
        if (entry?.kind === "history-slot" && entry.transactionId === action.transactionId) return true;
        if (entry?.historyTransactionId === action.transactionId) return true;
      }
      if (action.historyEntryId != null && entry?.historyEntryId === action.historyEntryId) return true;
      if (action.entry === entry) return true;
    }
    return false;
  }

  function pendingOppositeHistoryAction(direction, context) {
    if (!(editState.activeHistoryEntries instanceof Map)) return null;
    const oppositeDirection = direction === "undo" ? "redo" : "undo";
    const actions = [...editState.activeHistoryEntries.values()];
    for (let index = actions.length - 1; index >= 0; index--) {
      const candidate = actions[index];
      if (candidate?.direction !== oppositeDirection || !sameHistoryOwner(candidate?.context, context)) continue;
      const alreadyReserved = actions.some((action) => (
        action?.direction === direction && action?.oppositeActionId === candidate.id
      ));
      if (!alreadyReserved) return candidate;
    }
    return null;
  }

  function pendingPreviousHistoryAction(direction, context) {
    if (!(editState.activeHistoryEntries instanceof Map)) return null;
    const actions = [...editState.activeHistoryEntries.values()];
    for (let index = actions.length - 1; index >= 0; index--) {
      const candidate = actions[index];
      if (candidate?.direction === direction && sameHistoryOwner(candidate?.context, context)) {
        return candidate;
      }
    }
    return null;
  }

  function takeHistoryEntry(direction, context, allowedEntries = null) {
    const selected = latestHistoryEntry(direction, context, allowedEntries);
    if (!selected || selected.entry?.kind === "history-slot") return null;
    const entry = direction === "undo"
      ? popUndo(editState, (candidate) => candidate === selected.entry)
      : popRedo(editState, (candidate) => candidate === selected.entry);
    return entry ? { entry, index: selected.index } : null;
  }

  async function runHistoryAction(direction, context, action, allowedEntries = null) {
    const sourceStack = direction === "undo" ? editState.undoStack : editState.redoStack;
    const targetStack = direction === "undo" ? editState.redoStack : editState.undoStack;
    const actionLabel = direction === "undo" ? "撤销" : "重做";
    const selected = takeHistoryEntry(direction, context, allowedEntries);
    if (!selected) {
      statusText.value = `无可${actionLabel}操作`;
      return false;
    }
    try {
      action.entry = selected.entry;
      const result = await applyHistoryEntry(action.entry, direction, context);
      if (action.entry) targetStack.push(cloneHistoryEntry(action.entry));
      if (typeof onCellCommitted === "function") {
        for (const event of result?.committedCells || []) {
          try {
            await onCellCommitted(event);
          } catch {
            // Sibling-view synchronization cannot roll back a committed history action.
          }
        }
      }
      if (typeof onHistoryApplied === "function") {
        try {
          await onHistoryApplied(
            action.entry || selected.entry,
            direction,
            context.tab,
            result,
            action.historyView,
          );
        } catch {
          // The database mutation and history transfer already succeeded. A
          // view-sync failure must not put the same entry back on the source stack.
        }
      }
      successStatus(action.entry || selected.entry, result, direction);
      return true;
    } catch (error) {
      if (action.entry) sourceStack.splice(Math.min(selected.index, sourceStack.length), 0, action.entry);
      statusText.value = `${actionLabel}失败：${String(error)}`;
      return false;
    }
  }

  function isNativeUndoTarget(event) {
    const path = typeof event?.composedPath === "function"
      ? event.composedPath()
      : [event?.target];
    return path.some((target) => {
      if (!target) return false;
      // The hidden IME input holds grid focus without an active text edit.
      if (target.matches?.("input.wb-cell-ime-hold")) return false;
      const tagName = String(target.tagName || "").toLowerCase();
      if (tagName === "input" || tagName === "textarea" || tagName === "select") return true;
      if (target.isContentEditable) return true;
      const contentEditable = target.getAttribute?.("contenteditable");
      return contentEditable != null && String(contentEditable).toLowerCase() !== "false";
    });
  }

  function queueHistoryAction(direction) {
    const context = captureHistoryContext();
    if (!context) return;
    // A key pressed while the opposite action is still running belongs to that
    // action. For example, redo immediately after an in-flight undo must redo
    // the pending undo, even when an older redo entry is already on the stack.
    const oppositeAction = pendingOppositeHistoryAction(direction, context);
    const previousAction = pendingPreviousHistoryAction(direction, context);
    const initialCandidate = oppositeAction
      ? null
      : latestHistoryEntry(
          direction,
          context,
          (entry) => !historyEntryIsReserved(entry, direction, context),
        );
    if (!initialCandidate && !oppositeAction) {
      statusText.value = direction === "undo" ? "无可撤销操作" : "无可重做操作";
      return;
    }
    const targetEntry = initialCandidate?.entry || oppositeAction?.entry;
    const transactionId = targetEntry?.kind === "history-slot"
      ? targetEntry.transactionId
      : oppositeAction?.transactionId ?? targetEntry?.historyTransactionId ?? null;
    const historyEntryId = ensureHistoryEntryId(targetEntry);
    const action = beginHistoryAction(editState, targetEntry, direction, context);
    if (typeof captureHistoryView === "function") {
      try {
        action.historyView = captureHistoryView(context.tab);
      } catch {
        action.historyView = null;
      }
    }
    action.transactionId = transactionId;
    action.historyEntryId = historyEntryId;
    action.oppositeActionId = oppositeAction?.id ?? null;
    action.previousAction = previousAction;
    action.mutationTurn = beginMutationTurn(editState, context.scope, {
      kind: direction,
      historyActionId: action.id,
    });
    context.mutationTurnId = action.mutationTurn.id;
    if (initialCandidate?.entry?.kind === "history-slot") {
      statusText.value = direction === "undo"
        ? "正在保存，完成后将自动撤销"
        : "正在保存，完成后将自动重做";
    } else if (oppositeAction) {
      statusText.value = direction === "undo"
        ? "重做完成后将自动撤销"
        : "撤销完成后将自动重做";
    }
    const queued = enqueueMutationTask(action.mutationTurn, async () => {
      if (action.previousAction && action.previousAction.result !== true) {
        return false;
      }
      if (initialCandidate?.entry?.kind === "history-slot") {
        await waitForUndoTransaction(editState, transactionId);
      }
      if (!action.entry && transactionId == null) {
        statusText.value = direction === "undo" ? "无可撤销操作" : "无可重做操作";
        return false;
      }
      return await runHistoryAction(
        direction,
        context,
        action,
        transactionId != null
          ? (entry) => entry?.historyTransactionId === transactionId
          : (entry) => entry?.historyEntryId === historyEntryId,
      );
    });
    const cleanup = (result) => {
      action.result = result === true;
      finishHistoryAction(editState, action);
      finishMutationTurn(editState, action.mutationTurn);
    };
    void queued.then(cleanup, () => cleanup(false));
  }

  function handleUndoKeydown(event) {
    const key = String(event?.key || "").toLowerCase();
    if (!(event?.ctrlKey || event?.metaKey) || key !== "z" || event?.shiftKey) return false;
    if (isNativeUndoTarget(event)) return false;
    event.preventDefault();
    queueHistoryAction("undo");
    return true;
  }

  function handleRedoKeydown(event) {
    const key = String(event?.key || "").toLowerCase();
    const isRedo = ((event?.ctrlKey || event?.metaKey) && key === "y")
      || ((event?.ctrlKey || event?.metaKey) && event?.shiftKey && key === "z");
    if (!isRedo) return false;
    if (isNativeUndoTarget(event)) return false;
    event.preventDefault();
    queueHistoryAction("redo");
    return true;
  }

  return { handleUndoKeydown, handleRedoKeydown };
}
