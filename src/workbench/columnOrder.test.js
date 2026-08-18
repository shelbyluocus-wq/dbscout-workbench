import test from "node:test";
import assert from "node:assert/strict";
import {
  applyColumnOrder,
  clearTableColumnOrder,
  columnNamesOf,
  columnReorderExceededThreshold,
  columnReorderScrollDelta,
  columnReorderSurfaceState,
  isCustomColumnOrder,
  loadTableColumnOrder,
  migrateColumnOrder,
  moveColumn,
  moveTableColumnOrderKey,
  normalizeColumnOrder,
  preferredColumnOrder,
  remapColumnIndex,
  remapColumnIndexSet,
  remapSelectionPosition,
  resolveColumnDrop,
  resolveColumnDropFromPoint,
  sameColumnOrder,
  sameFreezeZone,
  saveTableColumnOrder,
  shouldIgnoreColumnReorderPointer,
} from "./utils/columnOrder.js";

function cols(...names) {
  return names.map((column_name) => ({ column_name }));
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

test("applyColumnOrder keeps known fields and appends new ones", () => {
  const incoming = cols("id", "name", "level", "guild");
  const ordered = applyColumnOrder(incoming, ["guild", "id", "missing"]);
  assert.deepEqual(columnNamesOf(ordered), ["guild", "id", "name", "level"]);
});

test("applyColumnOrder drops removed fields and ignores empty preferences", () => {
  assert.deepEqual(columnNamesOf(applyColumnOrder(cols("id", "name"), ["name", "gone"])), ["name", "id"]);
  assert.deepEqual(columnNamesOf(applyColumnOrder(cols("id", "name"), [])), ["id", "name"]);
});

test("migrateColumnOrder follows rename maps without duplicating names", () => {
  const renamed = migrateColumnOrder(["username", "id"], new Map([["username", "login_name"]]));
  assert.deepEqual(renamed, ["login_name", "id"]);
});

test("moveColumn reorders within a freeze zone and rejects crossing it", () => {
  const columns = cols("id", "name", "level", "guild");
  assert.deepEqual(columnNamesOf(moveColumn(columns, "name", "id", "before", { frozenCount: 2 })), ["name", "id", "level", "guild"]);
  assert.deepEqual(columnNamesOf(moveColumn(columns, "guild", "level", "before", { frozenCount: 2 })), ["id", "name", "guild", "level"]);
  assert.equal(moveColumn(columns, "guild", "id", "before", { frozenCount: 2 }), columns);
  assert.equal(moveColumn(columns, "id", "level", "after", { frozenCount: 2 }), columns);
});

test("moveColumn is free when nothing is frozen and no-ops adjacent drops", () => {
  const columns = cols("id", "name", "level");
  assert.deepEqual(columnNamesOf(moveColumn(columns, "level", "id", "before")), ["level", "id", "name"]);
  assert.equal(moveColumn(columns, "id", "name", "before"), columns);
  assert.equal(resolveColumnDrop({ sourceIndex: 0, targetIndex: 1, position: "before", frozenCount: 0 }), null);
});

test("sameFreezeZone treats a zero freeze count as one open band", () => {
  assert.equal(sameFreezeZone(0, 4, 0), true);
  assert.equal(sameFreezeZone(0, 1, 2), true);
  assert.equal(sameFreezeZone(0, 2, 2), false);
});

test("isCustomColumnOrder compares against the schema field list", () => {
  assert.equal(isCustomColumnOrder(cols("name", "id"), ["id", "name"]), true);
  assert.equal(isCustomColumnOrder(cols("id", "name"), ["id", "name"]), false);
});

test("remap helpers follow field names after a reorder", () => {
  const previous = ["id", "name", "level"];
  const next = ["level", "id", "name"];
  assert.equal(remapColumnIndex(previous, next, 1), 2);
  assert.deepEqual([...remapColumnIndexSet(previous, next, [0, 2])].sort(), [0, 1]);
  assert.equal(remapSelectionPosition({ column: "name", columnIndex: 1 }, previous, next).columnIndex, 2);
});

test("table column order memory stores, clears, and migrates keys", () => {
  const storage = memoryStorage();
  const tab = { connectionId: "mysql-1", database: "game", tableName: "hero" };
  saveTableColumnOrder(tab, ["guild", "id"], storage);
  assert.deepEqual(loadTableColumnOrder(tab, storage), ["guild", "id"]);
  moveTableColumnOrderKey(tab, { ...tab, tableName: "hero_v2" }, storage);
  assert.deepEqual(loadTableColumnOrder({ ...tab, tableName: "hero_v2" }, storage), ["guild", "id"]);
  assert.deepEqual(loadTableColumnOrder(tab, storage), []);
  clearTableColumnOrder({ ...tab, tableName: "hero_v2" }, storage);
  assert.deepEqual(loadTableColumnOrder({ ...tab, tableName: "hero_v2" }, storage), []);
});

test("preferredColumnOrder prefers the open tab, then the remembered table order", () => {
  const storage = memoryStorage();
  const tab = { connectionId: "c", database: "d", tableName: "t", columnOrder: ["b", "a"] };
  saveTableColumnOrder(tab, ["a", "b"], storage);
  assert.deepEqual(preferredColumnOrder(tab, storage), ["b", "a"]);
  assert.deepEqual(preferredColumnOrder({ ...tab, columnOrder: [] }, storage), ["a", "b"]);
});

test("idle reorder surface stays selectable and hides drag chrome", () => {
  assert.deepEqual(columnReorderSurfaceState({}), {
    reordering: false,
    forbidden: false,
    showDropLine: false,
    showGhost: false,
  });
  assert.deepEqual(columnReorderSurfaceState({
    dragging: true,
    drop: { allowed: true, left: 80 },
    ghost: { x: 90, y: 12, width: 80, label: "id" },
  }), {
    reordering: true,
    forbidden: false,
    showDropLine: true,
    showGhost: true,
  });
  assert.deepEqual(columnReorderSurfaceState({
    dragging: true,
    drop: { allowed: false },
    ghost: { x: 90, y: 12 },
  }), {
    reordering: true,
    forbidden: true,
    showDropLine: false,
    showGhost: true,
  });
});

test("header pointer helpers ignore resize or modifier clicks and require a drag threshold", () => {
  assert.equal(shouldIgnoreColumnReorderPointer({ button: 0, ctrlKey: true, target: { closest: () => null } }), true);
  assert.equal(shouldIgnoreColumnReorderPointer({
    button: 0,
    target: { closest: (selector) => selector.includes(".wb-col-resize") ? {} : null },
  }), true);
  assert.equal(shouldIgnoreColumnReorderPointer({ button: 0, target: { closest: () => null } }), false);
  assert.equal(columnReorderExceededThreshold(3, 1), false);
  assert.equal(columnReorderExceededThreshold(5, 0), true);
});

test("drop-from-point keeps the freeze divider closed and reports a visual edge", () => {
  const headers = [
    { index: 0, left: 38, right: 120, top: 10, height: 28 },
    { index: 1, left: 120, right: 220, top: 10, height: 28 },
    { index: 2, left: 220, right: 320, top: 10, height: 28 },
  ];
  const allowed = resolveColumnDropFromPoint(headers, 50, { sourceIndex: 1, frozenCount: 2 });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.targetIndex, 0);
  assert.equal(allowed.position, "before");
  const blocked = resolveColumnDropFromPoint(headers, 280, { sourceIndex: 1, frozenCount: 2 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.targetIndex, 2);
});

test("sameColumnOrder compares normalized field lists", () => {
  assert.equal(sameColumnOrder(["id", "name"], [{ column_name: "id" }, { column_name: "name" }]), true);
  assert.equal(sameColumnOrder(["name", "id"], ["id", "name"]), false);
});

test("edge scrolling starts after the frozen band", () => {
  assert.equal(columnReorderScrollDelta({
    clientX: 430,
    wrapLeft: 0,
    wrapRight: 400,
    frozenRight: 160,
  }), 28);
  assert.equal(columnReorderScrollDelta({
    clientX: 220,
    wrapLeft: 0,
    wrapRight: 400,
    frozenRight: 160,
  }), 0);
  assert.equal(columnReorderScrollDelta({
    clientX: 170,
    wrapLeft: 0,
    wrapRight: 400,
    frozenRight: 160,
    edge: 20,
  }), -28);
  assert.equal(columnReorderScrollDelta({
    clientX: 80,
    wrapLeft: 0,
    wrapRight: 400,
    frozenRight: 160,
    sourceIndex: 0,
    frozenCount: 2,
  }), 0);
  assert.equal(columnReorderScrollDelta({
    clientX: 170,
    wrapLeft: 0,
    wrapRight: 400,
    frozenRight: 160,
    sourceIndex: 3,
    frozenCount: 2,
    edge: 20,
  }), -28);
});

test("normalizeColumnOrder de-duplicates blank and object names", () => {
  assert.deepEqual(normalizeColumnOrder(["id", "", "id", { column_name: "name" }]), ["id", "name"]);
});
