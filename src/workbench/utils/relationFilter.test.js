import test from "node:test";
import assert from "node:assert/strict";

import {
  RELATION_LIST_ITEM_KEY,
  listItemValues,
  normalizeRelationFilter,
  normalizeRelationKind,
  normalizeRelationOrigin,
  relationFilterKey,
} from "./relationFilter.js";

test("relation filters keep trimmed distinct values and need a column and a value", () => {
  assert.equal(normalizeRelationFilter(null), null);
  assert.equal(normalizeRelationFilter("ID=1"), null);
  assert.equal(normalizeRelationFilter({ column: " ", values: ["1"] }), null);
  assert.equal(normalizeRelationFilter({ column: "ID", values: ["", "  ", null, undefined] }), null);
  assert.deepEqual(
    normalizeRelationFilter({ column: " ID ", kind: "EQUALS", values: [" 1001", 1001, "1002", 0] }),
    { column: "ID", kind: "equals", values: ["1001", "1002", "0"] },
  );
});

test("list filters match whole list members and default the member key to ID", () => {
  assert.deepEqual(
    normalizeRelationFilter({ column: "Items", kind: "listcontains", values: ["7"] }),
    { column: "Items", kind: "listContains", values: ["7"], itemKey: RELATION_LIST_ITEM_KEY },
  );
  assert.equal(
    normalizeRelationFilter({ column: "Items", kind: "listContains", values: ["7"], itemKey: " GoodsID " }).itemKey,
    "GoodsID",
  );
  assert.equal(normalizeRelationFilter({ column: "ID", values: ["7"], itemKey: "GoodsID" }).itemKey, undefined);
  assert.equal(normalizeRelationKind("unknown"), "equals");
  assert.equal(normalizeRelationKind(undefined), "equals");
});

test("equal jumps share one filter key regardless of value order or column case", () => {
  const key = relationFilterKey({ column: "id", values: ["2", "1"] });
  assert.equal(key, relationFilterKey({ column: "ID", kind: "equals", values: ["1", "2", "1"] }));
  assert.notEqual(key, relationFilterKey({ column: "ID", kind: "listContains", values: ["1", "2"] }));
  assert.notEqual(key, relationFilterKey({ column: "ID", values: ["1"] }));
  assert.notEqual(key, relationFilterKey({ column: "SkillID", values: ["1", "2"] }));
  assert.equal(relationFilterKey({ column: "ID", values: [] }), "");
  assert.equal(relationFilterKey(null), "");
});

test("list cells yield their member keys case-insensitively and reject other shapes", () => {
  assert.deepEqual(
    listItemValues('[{"ID":1001,"Num":2},{"id":"1002"},{"Id":"  "},{"Num":3}]'),
    ["1001", "1002"],
  );
  assert.deepEqual(listItemValues("  []  "), []);
  assert.deepEqual(listItemValues('[{"GoodsID":5,"ID":9}]', "goodsid"), ["5"]);
  assert.equal(listItemValues("1001"), null);
  assert.equal(listItemValues("[1001, 1002]"), null);
  assert.equal(listItemValues('[{"ID":1}, [2]]'), null);
  assert.equal(listItemValues('[{"ID":1}, null]'), null);
  assert.equal(listItemValues("[not json"), null);
  assert.equal(listItemValues(null), null);
});

test("relation origins need both ends and default to the outgoing direction", () => {
  assert.equal(normalizeRelationOrigin(null), null);
  assert.equal(normalizeRelationOrigin({ sourceTable: "hero", sourceColumn: "skill_id", targetTable: "skill" }), null);
  assert.deepEqual(
    normalizeRelationOrigin({
      direction: "sideways",
      sourceTable: " hero ",
      sourceColumn: "skill_id",
      targetTable: "skill",
      targetColumn: "id",
      extra: "dropped",
    }),
    { direction: "outgoing", sourceTable: "hero", sourceColumn: "skill_id", targetTable: "skill", targetColumn: "id" },
  );
  assert.equal(
    normalizeRelationOrigin({ direction: "incoming", sourceTable: "a", sourceColumn: "b", targetTable: "c", targetColumn: "d" }).direction,
    "incoming",
  );
});
