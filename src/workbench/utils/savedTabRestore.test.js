import test from "node:test";
import assert from "node:assert/strict";
import { applySavedTableTabState, savedTableTabMatchesSource } from "./savedTabRestore.js";

const source = { connectionId: "mysql-1", database: "game", availableTableNames: new Set(["hero", "item"]) };

test("saved table tabs restore only into their own connection and database", () => {
  assert.equal(savedTableTabMatchesSource({ tableName: "hero", connectionId: "mysql-1", database: "game" }, source), true);
  assert.equal(savedTableTabMatchesSource({ tableName: "hero", connectionId: "mysql-1", database: "other" }, source), false);
  assert.equal(savedTableTabMatchesSource({ tableName: "hero", connectionId: "mysql-2", database: "game" }, source), false);
  assert.equal(savedTableTabMatchesSource({ tableName: "missing", connectionId: "mysql-1", database: "game" }, source), false);
});

test("legacy saved tabs without a recorded source keep the table-name check", () => {
  assert.equal(savedTableTabMatchesSource({ tableName: "item" }, source), true);
  assert.equal(savedTableTabMatchesSource({ tableName: "pet" }, source), false);
});

test("saved view state is applied before the first load and bounded", () => {
  const tab = { columns: [] };
  applySavedTableTabState(tab, {
    filter: "abc",
    filterMode: "continuous",
    sort: { columnName: "id", descending: true },
    frozenRowStart: 2.7,
    frozenRowCount: 9999,
    frozenColumnCount: -1,
    columnOrder: ["name", "id"],
    fieldCommentsExpanded: false,
  });
  assert.equal(tab.filter, "abc");
  assert.equal(tab.filterMode, "continuous");
  assert.deepEqual(tab.sort, { columnName: "id", descending: true });
  assert.equal(tab.frozenRowStart, 2);
  assert.ok(tab.frozenRowCount > 0 && tab.frozenRowCount < 9999);
  assert.equal(tab.frozenColumnCount, 0);
  assert.deepEqual(tab.columnOrder, ["name", "id"]);
  assert.equal(tab.fieldCommentsExpanded, false);
  assert.ok(Number.isFinite(tab.rowHeight));
});

test("saved relation tabs restore their filtered view", () => {
  const tab = { columns: [] };
  applySavedTableTabState(tab, {
    relationFilter: { column: "id", kind: "listContains", values: ["1001"] },
    relationOrigin: {
      direction: "incoming",
      sourceTable: "activity",
      sourceColumn: "reward_pool",
      targetTable: "item",
      targetColumn: "id",
    },
  });
  assert.deepEqual(tab.relationFilter, { column: "id", kind: "listContains", values: ["1001"], itemKey: "ID" });
  assert.equal(tab.relationOrigin.direction, "incoming");
  assert.equal(tab.hitResultMode, true);

  const plain = { columns: [] };
  applySavedTableTabState(plain, { filter: "abc" });
  assert.equal(plain.relationFilter, null);
  assert.equal(plain.relationOrigin, null);
  assert.equal(plain.hitResultMode, undefined);
});
