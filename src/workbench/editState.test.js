import test from "node:test";
import assert from "node:assert/strict";

import {
  createEditState,
  failCellCommit,
  finishCellCommit,
  getCellError,
  getEditMutationVersion,
  isCellPending,
  startCellCommit,
  startUndoGroup,
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
