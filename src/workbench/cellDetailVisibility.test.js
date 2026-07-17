import test from "node:test";
import assert from "node:assert/strict";
import {
  CELL_DETAIL_AUTO_EXPAND_LENGTH,
  createCellDetailVisibility,
  loadCellDetailCollapsed,
  saveCellDetailCollapsed,
  shouldAutoExpandCellDetail,
} from "./cellDetailVisibility.js";

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

test("shouldAutoExpandCellDetail triggers on text longer than 80 chars", () => {
  assert.equal(shouldAutoExpandCellDetail("x".repeat(CELL_DETAIL_AUTO_EXPAND_LENGTH + 1)), true);
  assert.equal(shouldAutoExpandCellDetail("中".repeat(CELL_DETAIL_AUTO_EXPAND_LENGTH + 1)), true);
});

test("shouldAutoExpandCellDetail ignores text at or under 80 chars", () => {
  assert.equal(shouldAutoExpandCellDetail("x".repeat(CELL_DETAIL_AUTO_EXPAND_LENGTH)), false);
  assert.equal(shouldAutoExpandCellDetail("short"), false);
  assert.equal(shouldAutoExpandCellDetail(""), false);
});

test("shouldAutoExpandCellDetail triggers on any newline regardless of length", () => {
  assert.equal(shouldAutoExpandCellDetail("a\nb"), true);
  assert.equal(shouldAutoExpandCellDetail("a\r\nb"), true);
  assert.equal(shouldAutoExpandCellDetail("\n"), true);
});

test("shouldAutoExpandCellDetail treats nullish values as no trigger", () => {
  assert.equal(shouldAutoExpandCellDetail(null), false);
  assert.equal(shouldAutoExpandCellDetail(undefined), false);
});

test("shouldAutoExpandCellDetail coerces non-string values", () => {
  assert.equal(shouldAutoExpandCellDetail(42), false);
  assert.equal(shouldAutoExpandCellDetail(Number("1".padEnd(90, "0"))), false);
});

test("loadCellDetailCollapsed defaults to collapsed when nothing stored", () => {
  assert.equal(loadCellDetailCollapsed(createMemoryStorage()), true);
  assert.equal(loadCellDetailCollapsed(undefined), true);
  assert.equal(loadCellDetailCollapsed({ getItem: () => { throw new Error("denied"); } }), true);
});

test("collapsed state persists with the pane '1'/'0' storage pattern", () => {
  const storage = createMemoryStorage();
  saveCellDetailCollapsed(false, storage);
  assert.equal(loadCellDetailCollapsed(storage), false);
  saveCellDetailCollapsed(true, storage);
  assert.equal(loadCellDetailCollapsed(storage), true);
  assert.equal(storage.dump().dbscout_cell_detail_collapsed, "1");
});

test("createCellDetailVisibility starts collapsed by default and toggles with persistence", () => {
  const storage = createMemoryStorage();
  const visibility = createCellDetailVisibility({ storage });
  assert.equal(visibility.state.collapsed, true);

  visibility.toggleCollapsed();
  assert.equal(visibility.state.collapsed, false);
  assert.equal(loadCellDetailCollapsed(storage), false);

  visibility.toggleCollapsed();
  assert.equal(visibility.state.collapsed, true);
  assert.equal(loadCellDetailCollapsed(storage), true);
});

test("createCellDetailVisibility restores the persisted expanded state", () => {
  const storage = createMemoryStorage({ dbscout_cell_detail_collapsed: "0" });
  const visibility = createCellDetailVisibility({ storage });
  assert.equal(visibility.state.collapsed, false);
});

test("notifySelectedText auto-expands only for long or multiline selections", () => {
  const visibility = createCellDetailVisibility({ storage: createMemoryStorage() });
  assert.equal(visibility.state.collapsed, true);

  visibility.notifySelectedText("short value");
  assert.equal(visibility.state.collapsed, true, "short text must not auto-expand");

  visibility.notifySelectedText(`line1\nline2`);
  assert.equal(visibility.state.collapsed, false, "multiline text auto-expands");
});

test("notifySelectedText never auto-collapses on short text", () => {
  const visibility = createCellDetailVisibility({ storage: createMemoryStorage() });
  visibility.notifySelectedText("x".repeat(CELL_DETAIL_AUTO_EXPAND_LENGTH + 1));
  assert.equal(visibility.state.collapsed, false);

  visibility.notifySelectedText("tiny");
  assert.equal(visibility.state.collapsed, false, "short text must not auto-collapse");

  visibility.notifySelectedText(null);
  assert.equal(visibility.state.collapsed, false, "clearing the selection must not auto-collapse");
});
