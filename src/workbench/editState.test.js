import test from "node:test";
import assert from "node:assert/strict";

import {
  beginHistoryOperation,
  commitUndoTransaction,
  createUndoTransaction,
  createEditState,
  failCellCommit,
  finishCellCommit,
  finishHistoryOperation,
  getCellError,
  getEditMutationVersion,
  hasPendingHistoryOperations,
  isCellPending,
  recordUndoEntry,
  startCellCommit,
  startUndoGroup,
  waitForHistoryOperations,
} from "./editState.js";

test("startCellCommit marks a cell as pending with optimistic value", () => {
  const edit = createEditState();

  startCellCommit(edit, {
    tableName: "items",
    rowKey: "id=1",
    columnName: "name",
    oldValue: "Potion",
    newValue: "Mega Potion",
  });

  assert.equal(isCellPending(edit, "items", "id=1", "name"), true);
  assert.equal(edit.optimisticValues.get("itemsid=1name"), "Mega Potion");
});

test("edit mutation version changes when optimistic values change", () => {
  const edit = createEditState();
  const initialVersion = getEditMutationVersion(edit);

  const key = startCellCommit(edit, {
    tableName: "items",
    rowKey: "id=1",
    columnName: "name",
    oldValue: "Potion",
    newValue: "Mega Potion",
  });
  const pendingVersion = getEditMutationVersion(edit);
  finishCellCommit(edit, key);

  assert.equal(initialVersion, 0);
  assert.ok(pendingVersion > initialVersion);
  assert.ok(getEditMutationVersion(edit) > pendingVersion);
});

test("finishCellCommit clears pending state and records undo history", () => {
  const edit = createEditState();
  const key = startCellCommit(edit, {
    tableName: "items",
    rowKey: "id=1",
    columnName: "name",
    oldValue: "Potion",
    newValue: "Mega Potion",
  });

  finishCellCommit(edit, key);

  assert.equal(isCellPending(edit, "items", "id=1", "name"), false);
  assert.deepEqual(edit.undoStack, [
    {
      tableName: "items",
      rowKey: "id=1",
      beforeRowKey: "id=1",
      afterRowKey: "id=1",
      beforeIdentity: null,
      afterIdentity: null,
      columnName: "name",
      oldValue: "Potion",
      newValue: "Mega Potion",
    },
  ]);
});

test("cell commits in one undo group create a single batch history entry", () => {
  const edit = createEditState();
  const undoGroupId = startUndoGroup(edit);
  const firstKey = startCellCommit(edit, {
    tableName: "items",
    rowKey: "id=1",
    columnName: "name",
    oldValue: "Potion",
    newValue: "Elixir",
    undoGroupId,
    undoRowId: 1,
  });
  const secondKey = startCellCommit(edit, {
    tableName: "items",
    rowKey: "id=1",
    columnName: "price",
    oldValue: "10",
    newValue: "12",
    undoGroupId,
    undoRowId: 1,
  });

  finishCellCommit(edit, firstKey);
  finishCellCommit(edit, secondKey);

  assert.equal(edit.undoStack.length, 1);
  assert.equal(edit.undoStack[0].kind, "cell-batch");
  assert.equal(edit.undoStack[0].entries.length, 2);
  assert.deepEqual(edit.undoStack[0].entries.map((entry) => entry.columnName), ["name", "price"]);
});

test("failCellCommit restores the old value and stores a cell-level error", () => {
  const edit = createEditState();
  const key = startCellCommit(edit, {
    tableName: "items",
    rowKey: "id=1",
    columnName: "name",
    oldValue: "Potion",
    newValue: "Mega Potion",
  });

  failCellCommit(edit, key, "保存失败");

  assert.equal(isCellPending(edit, "items", "id=1", "name"), false);
  assert.equal(edit.optimisticValues.has("itemsid=1name"), false);
  assert.equal(getCellError(edit, "items", "id=1", "name"), "保存失败");
});

test("undo transaction keeps mixed history private until one composite commit", () => {
  const edit = createEditState();
  edit.redoStack.push({ tableName: "items", columnName: "stale" });
  const transaction = createUndoTransaction({
    tableName: "items",
    tabId: "tab-1",
    label: "批量粘贴",
  });
  const undoGroupId = startUndoGroup(edit);
  recordUndoEntry(edit, {
    kind: "insert-draft-batch",
    tableName: "items",
    changes: [{ rowId: "draft-1", before: null, after: { draft: { name: "A" } } }],
  }, transaction);
  const nameKey = startCellCommit(edit, {
    tableName: "items",
    rowKey: "id=1",
    columnName: "name",
    oldValue: "Potion",
    newValue: "Elixir",
    undoGroupId,
    undoRowId: 1,
  });
  const priceKey = startCellCommit(edit, {
    tableName: "items",
    rowKey: "id=1",
    columnName: "price",
    oldValue: "10",
    newValue: "12",
    undoGroupId,
    undoRowId: 1,
  });

  finishCellCommit(edit, nameKey, null, { undoTransaction: transaction });
  finishCellCommit(edit, priceKey, null, { undoTransaction: transaction });

  assert.equal(edit.undoStack.length, 0);
  assert.equal(edit.redoStack.length, 1);
  assert.equal(transaction.entries.length, 2);
  assert.equal(transaction.entries[1].kind, "cell-batch");
  assert.deepEqual(transaction.entries[1].entries.map((entry) => entry.columnName), ["name", "price"]);

  assert.equal(commitUndoTransaction(edit, transaction), true);
  assert.equal(edit.redoStack.length, 0);
  assert.equal(edit.undoStack.length, 1);
  assert.equal(edit.undoStack[0].kind, "history-composite");
  assert.equal(edit.undoStack[0].label, "批量粘贴");
  assert.deepEqual(edit.undoStack[0].entries, transaction.entries);
  assert.equal(commitUndoTransaction(edit, transaction), false);
});

test("a transaction with one entry preserves the original history shape", () => {
  const edit = createEditState();
  const transaction = createUndoTransaction({ tableName: "items" });
  const entry = { tableName: "items", columnName: "name", oldValue: "A", newValue: "B" };

  recordUndoEntry(edit, entry, transaction);
  commitUndoTransaction(edit, transaction);

  assert.equal(edit.undoStack.length, 1);
  assert.equal(edit.undoStack[0], entry);
});

test("history operation waiters resolve only after every pending operation finishes", async () => {
  const edit = createEditState();
  const first = beginHistoryOperation(edit);
  const second = beginHistoryOperation(edit);
  let resolved = false;
  const waiting = waitForHistoryOperations(edit).then(() => {
    resolved = true;
  });

  assert.equal(hasPendingHistoryOperations(edit), true);
  assert.equal(finishHistoryOperation(edit, first), true);
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(hasPendingHistoryOperations(edit), true);

  assert.equal(finishHistoryOperation(edit, second), true);
  await waiting;
  assert.equal(resolved, true);
  assert.equal(hasPendingHistoryOperations(edit), false);
  assert.equal(finishHistoryOperation(edit, second), false);
});
