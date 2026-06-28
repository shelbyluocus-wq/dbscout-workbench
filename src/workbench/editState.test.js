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
      columnName: "name",
      oldValue: "Potion",
      newValue: "Mega Potion",
    },
  ]);
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
