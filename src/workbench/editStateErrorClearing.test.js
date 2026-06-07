import test from "node:test";
import assert from "node:assert/strict";

import {
  clearCellError,
  clearCellErrorsForTable,
  createEditState,
  failCellCommit,
  getCellError,
  startCellCommit,
} from "./editState.js";

test("clearCellError removes one stored cell error without touching neighbors", () => {
  const edit = createEditState();
  const firstKey = startCellCommit(edit, {
    tableName: "mysql-1\u001fdev_game\u001fplayer",
    rowKey: "id=1",
    columnName: "level",
  });
  const secondKey = startCellCommit(edit, {
    tableName: "mysql-1\u001fdev_game\u001fplayer",
    rowKey: "id=1",
    columnName: "nickname",
  });
  failCellCommit(edit, firstKey, "invalid integer");
  failCellCommit(edit, secondKey, "required");

  const cleared = clearCellError(edit, "mysql-1\u001fdev_game\u001fplayer", "id=1", "level");

  assert.equal(cleared, true);
  assert.equal(getCellError(edit, "mysql-1\u001fdev_game\u001fplayer", "id=1", "level"), "");
  assert.equal(getCellError(edit, "mysql-1\u001fdev_game\u001fplayer", "id=1", "nickname"), "required");
});

test("clearCellErrorsForTable clears stale validation errors for one table scope", () => {
  const edit = createEditState();
  const playerKey = startCellCommit(edit, {
    tableName: "mysql-1\u001fdev_game\u001fplayer",
    rowKey: "id=1",
    columnName: "level",
  });
  const playerTwoKey = startCellCommit(edit, {
    tableName: "mysql-1\u001fdev_game\u001fplayer_2",
    rowKey: "id=1",
    columnName: "level",
  });
  const livePlayerKey = startCellCommit(edit, {
    tableName: "mysql-1\u001flive_game\u001fplayer",
    rowKey: "id=1",
    columnName: "level",
  });
  failCellCommit(edit, playerKey, "invalid integer");
  failCellCommit(edit, playerTwoKey, "other table");
  failCellCommit(edit, livePlayerKey, "other database");

  const cleared = clearCellErrorsForTable(edit, "mysql-1\u001fdev_game\u001fplayer");

  assert.equal(cleared, 1);
  assert.equal(getCellError(edit, "mysql-1\u001fdev_game\u001fplayer", "id=1", "level"), "");
  assert.equal(getCellError(edit, "mysql-1\u001fdev_game\u001fplayer_2", "id=1", "level"), "other table");
  assert.equal(getCellError(edit, "mysql-1\u001flive_game\u001fplayer", "id=1", "level"), "other database");
});
