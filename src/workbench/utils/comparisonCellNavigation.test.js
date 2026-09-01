import test from "node:test";
import assert from "node:assert/strict";
import {
  claimComparisonGridIfIdle,
  clearActiveComparisonGrid,
  comparisonArrowDelta,
  comparisonColumnNames,
  isActiveComparisonGrid,
  isComparisonCellNavigationBlocked,
  moveComparisonCell,
  nearestScrollStart,
  setActiveComparisonGrid,
  shouldHandleComparisonCellNavigation,
} from "./comparisonCellNavigation.js";

function row(id, status = "updated") {
  return { id, status };
}

function columns() {
  return [
    { name: "id", primaryKey: true },
    { name: "name", primaryKey: false },
    { name: "score", primaryKey: false },
  ];
}

test("nearest scroll only moves when the cell leaves the viewport", () => {
  assert.equal(nearestScrollStart(0, 100, 0, 29), 0);
  assert.equal(nearestScrollStart(0, 100, 80, 29), 9);
  assert.equal(nearestScrollStart(50, 100, 20, 29), 20);
  assert.equal(nearestScrollStart(50, 100, 60, 29), 50);
});

test("comparison columns stay in frozen-then-scroll visual order", () => {
  assert.deepEqual(comparisonColumnNames(columns(), true), ["id", "name", "score"]);
  assert.deepEqual(comparisonColumnNames(columns(), false), ["name", "score"]);
  assert.deepEqual(comparisonColumnNames(["alpha", "beta"], true), ["alpha", "beta"]);
});

test("arrow keys move one cell and clamp at the edges", () => {
  const rows = [row("r1"), row("r2"), row("r3")];
  const columnNames = comparisonColumnNames(columns(), true);
  const start = { rowId: "r2", column: "name" };

  assert.equal(moveComparisonCell({ rows, columnNames, selected: start, deltaRow: 0, deltaCol: 1 }).column, "score");
  assert.equal(moveComparisonCell({ rows, columnNames, selected: start, deltaRow: 0, deltaCol: -1 }).column, "id");
  assert.equal(moveComparisonCell({ rows, columnNames, selected: start, deltaRow: 1, deltaCol: 0 }).row.id, "r3");
  assert.equal(moveComparisonCell({ rows, columnNames, selected: start, deltaRow: -1, deltaCol: 0 }).row.id, "r1");

  const last = moveComparisonCell({
    rows,
    columnNames,
    selected: { rowId: "r3", column: "score" },
    deltaRow: 1,
    deltaCol: 1,
  });
  assert.equal(last.row.id, "r3");
  assert.equal(last.column, "score");
  assert.equal(last.rowIndex, 2);
});

test("vertical movement skips error rows that have no selectable cells", () => {
  const rows = [row("ok-1"), row("bad", "error"), row("ok-2")];
  const columnNames = ["id", "name"];
  const next = moveComparisonCell({
    rows,
    columnNames,
    selected: { rowId: "ok-1", column: "name" },
    deltaRow: 1,
    deltaCol: 0,
  });
  assert.equal(next.row.id, "ok-2");
  assert.equal(next.rowIndex, 2);
  assert.equal(next.column, "name");
});

test("inserted and deleted rows stay navigable", () => {
  const rows = [row("ins", "inserted"), row("del", "deleted")];
  const columnNames = ["id"];
  const next = moveComparisonCell({
    rows,
    columnNames,
    selected: { rowId: "ins", column: "id" },
    deltaRow: 1,
    deltaCol: 0,
  });
  assert.equal(next.row.id, "del");
});

test("a first arrow with no selection lands on the starting corner", () => {
  const rows = [row("r1"), row("r2")];
  const columnNames = ["id", "name"];
  const first = moveComparisonCell({ rows, columnNames, selected: null, deltaRow: 1, deltaCol: 0 });
  assert.equal(first.row.id, "r1");
  assert.equal(first.column, "id");
  assert.equal(first.rowIndex, 0);

  const last = moveComparisonCell({ rows, columnNames, selected: null, deltaRow: -1, deltaCol: 0 });
  assert.equal(last.row.id, "r2");
  assert.equal(last.column, "name");
});

test("ctrl/meta arrows jump to the row or column edge", () => {
  const delta = comparisonArrowDelta({ key: "ArrowRight", ctrlKey: true, metaKey: false });
  assert.equal(delta.deltaRow, 0);
  assert.ok(delta.deltaCol > 1);

  const rows = [row("r1"), row("r2"), row("r3")];
  const columnNames = ["id", "name", "score"];
  const jumped = moveComparisonCell({
    rows,
    columnNames,
    selected: { rowId: "r2", column: "id" },
    ...comparisonArrowDelta({ key: "ArrowRight", ctrlKey: true }),
  });
  assert.equal(jumped.column, "score");
  assert.equal(jumped.row.id, "r2");
});

test("hiding primary keys snaps off a selected key column", () => {
  const rows = [row("r1")];
  const next = moveComparisonCell({
    rows,
    columnNames: ["name", "score"],
    selected: { rowId: "r1", column: "id" },
    deltaRow: 0,
    deltaCol: 1,
  });
  assert.equal(next.column, "score");
});

test("empty tables and error-only tables have no cell to move to", () => {
  assert.equal(moveComparisonCell({ rows: [], columnNames: ["id"], selected: null, deltaRow: 1, deltaCol: 0 }), null);
  assert.equal(moveComparisonCell({
    rows: [row("bad", "error")],
    columnNames: ["id"],
    selected: null,
    deltaRow: 1,
    deltaCol: 0,
  }), null);
  assert.equal(comparisonArrowDelta({ key: "Enter" }), null);
  assert.deepEqual(comparisonArrowDelta({ key: "ArrowUp" }), { deltaRow: -1, deltaCol: 0 });
});

function target(options = {}) {
  const {
    tagName = "DIV",
    type,
    value = "",
    role,
    contentEditable = false,
  } = options;
  const node = {
    tagName,
    type,
    value,
    isContentEditable: contentEditable,
    getAttribute(name) {
      return name === "role" ? role : null;
    },
    closest(selector) {
      if (selector === '[role="separator"]') return role === "separator" ? node : null;
      if (selector.includes("input") || selector.includes("textarea") || selector.includes("select") || selector.includes("contenteditable")) {
        if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || contentEditable) return node;
        return null;
      }
      return null;
    },
  };
  return node;
}

test("arrow keys stay with editors and resizers, but empty search yields to the grid", () => {
  assert.equal(isComparisonCellNavigationBlocked(target({ tagName: "INPUT", type: "search", value: "hero" })), true);
  assert.equal(isComparisonCellNavigationBlocked(target({ tagName: "INPUT", type: "search", value: "" })), false);
  assert.equal(isComparisonCellNavigationBlocked(target({ tagName: "INPUT", type: "checkbox" })), false);
  assert.equal(isComparisonCellNavigationBlocked(target({ tagName: "TEXTAREA", value: "" })), true);
  assert.equal(isComparisonCellNavigationBlocked(target({ role: "separator" })), true);
  assert.equal(isComparisonCellNavigationBlocked(target()), false);
});

test("only the active comparison grid claims page-level arrows", () => {
  const first = { id: "first" };
  const second = { id: "second" };
  clearActiveComparisonGrid();
  assert.equal(isActiveComparisonGrid(first), false);
  claimComparisonGridIfIdle(first);
  claimComparisonGridIfIdle(second);
  assert.equal(isActiveComparisonGrid(first), true);
  assert.equal(isActiveComparisonGrid(second), false);
  setActiveComparisonGrid(second);
  assert.equal(isActiveComparisonGrid(second), true);
  assert.equal(isActiveComparisonGrid(first), false);
  clearActiveComparisonGrid(first);
  assert.equal(isActiveComparisonGrid(second), true);
  clearActiveComparisonGrid(second);
  assert.equal(isActiveComparisonGrid(first), false);
});

test("keydown inside a comparison grid claims it; other grids ignore that event", () => {
  clearActiveComparisonGrid();
  const root = {
    contains(node) {
      return node === inside;
    },
  };
  const other = {
    contains() {
      return false;
    },
  };
  const inside = {
    closest(selector) {
      return selector === ".wb-batch-diff" ? root : null;
    },
  };
  const toolbar = { closest() { return null; } };

  assert.equal(shouldHandleComparisonCellNavigation({ key: "ArrowDown", target: inside }, root), true);
  assert.equal(isActiveComparisonGrid(root), true);
  assert.equal(shouldHandleComparisonCellNavigation({ key: "ArrowDown", target: inside }, other), false);
  assert.equal(shouldHandleComparisonCellNavigation({ key: "ArrowRight", target: toolbar }, root), true);
  assert.equal(shouldHandleComparisonCellNavigation({ key: "ArrowRight", altKey: true, target: toolbar }, root), false);
  assert.equal(shouldHandleComparisonCellNavigation({ key: "Enter", target: toolbar }, root), false);
});
