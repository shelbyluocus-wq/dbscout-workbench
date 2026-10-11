import test from "node:test";
import assert from "node:assert/strict";

import {
  OPEN_MANY_TABLES_THRESHOLD,
  confirmOpeningTables,
  createSelectionRecall,
  isContextMenuKey,
  isDeleteCommandKey,
  isPlainSelectionEvent,
  nextListSelection,
  selectionOpenPlan,
} from "./listSelection.js";

const order = ["a", "b", "c", "d", "e"];

test("a plain click selects one item and becomes the anchor", () => {
  assert.deepEqual(
    nextListSelection({ order, selected: ["a", "c"], anchor: "a", name: "d" }),
    { selected: ["d"], anchor: "d" },
  );
});

test("Ctrl or Cmd click toggles one item without touching the rest", () => {
  assert.deepEqual(
    nextListSelection({ order, selected: ["a"], anchor: "a", name: "c", event: { ctrlKey: true } }),
    { selected: ["a", "c"], anchor: "c" },
  );
  assert.deepEqual(
    nextListSelection({ order, selected: ["a", "c"], anchor: "a", name: "a", event: { metaKey: true } }),
    { selected: ["c"], anchor: "a" },
  );
});

test("Shift click selects the range from the anchor in list order and keeps the anchor", () => {
  assert.deepEqual(
    nextListSelection({ order, selected: ["d"], anchor: "d", name: "b", event: { shiftKey: true } }),
    { selected: ["b", "c", "d"], anchor: "d" },
  );
});

test("Ctrl+Shift click adds the range to the existing selection", () => {
  assert.deepEqual(
    nextListSelection({ order, selected: ["a"], anchor: "c", name: "e", event: { shiftKey: true, ctrlKey: true } }),
    { selected: ["a", "c", "d", "e"], anchor: "c" },
  );
});

test("Shift click without a usable anchor behaves like a plain click", () => {
  assert.deepEqual(
    nextListSelection({ order, selected: [], anchor: "", name: "b", event: { shiftKey: true } }),
    { selected: ["b"], anchor: "b" },
  );
  assert.deepEqual(
    nextListSelection({ order, selected: ["x"], anchor: "x", name: "b", event: { shiftKey: true } }),
    { selected: ["b"], anchor: "b" },
  );
});

test("plain selection events have no selection modifiers", () => {
  assert.equal(isPlainSelectionEvent({}), true);
  assert.equal(isPlainSelectionEvent({ ctrlKey: true }), false);
  assert.equal(isPlainSelectionEvent({ shiftKey: true }), false);
  assert.equal(isPlainSelectionEvent({ metaKey: true }), false);
});

test("a double-click recalls the multi-selection its first click collapsed", () => {
  let time = 0;
  const recall = createSelectionRecall({ now: () => time, windowMs: 1000 });
  recall.remember("b", ["a", "b", "c"]);
  time = 300;
  assert.deepEqual(recall.recall("b"), ["a", "b", "c"]);
  assert.equal(recall.recall("b"), null, "a recall is consumed once");

  recall.remember("b", ["a", "b"]);
  assert.equal(recall.recall("c"), null, "another row never restores the selection");

  recall.remember("b", ["b"]);
  assert.equal(recall.recall("b"), null, "a single selection has nothing to restore");

  recall.remember("z", ["a", "b"]);
  assert.equal(recall.recall("z"), null, "a row outside the selection has nothing to restore");

  recall.remember("a", ["a", "b"]);
  time = 2000;
  assert.equal(recall.recall("a"), null, "stale memories expire");
});

test("opening a selection keeps list order and activates the row the user acted on", () => {
  assert.deepEqual(selectionOpenPlan("c", ["d", "a", "c"], order), { names: ["a", "c", "d"], activeName: "c" });
  assert.deepEqual(selectionOpenPlan("e", ["a", "b"], order), { names: ["e"], activeName: "e" });
  assert.deepEqual(selectionOpenPlan("", ["b", "a"], order), { names: ["a", "b"], activeName: "b" });
  assert.deepEqual(selectionOpenPlan("", [], order), { names: [], activeName: "" });
  assert.deepEqual(selectionOpenPlan("b", ["b", "x"], order), { names: ["b", "x"], activeName: "b" });
  assert.ok(OPEN_MANY_TABLES_THRESHOLD >= 10);
});

test("opening many tables at once asks first", async () => {
  const asked = [];
  const ui = { confirm: async (options) => { asked.push(options); return false; }, t: (key, params) => `${key}:${params?.count ?? ""}` };
  assert.equal(await confirmOpeningTables(OPEN_MANY_TABLES_THRESHOLD, ui), true);
  assert.equal(asked.length, 0);
  assert.equal(await confirmOpeningTables(OPEN_MANY_TABLES_THRESHOLD + 1, ui), false);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, `home.openManyTitle:${OPEN_MANY_TABLES_THRESHOLD + 1}`);
  assert.equal(asked[0].confirmText, `home.openTables:${OPEN_MANY_TABLES_THRESHOLD + 1}`);
});

test("Delete removes the selection everywhere and Backspace only on macOS", () => {
  assert.equal(isDeleteCommandKey({ key: "Delete" }, { mac: false }), true);
  assert.equal(isDeleteCommandKey({ key: "Delete" }, { mac: true }), true);
  assert.equal(isDeleteCommandKey({ key: "Backspace" }, { mac: false }), false);
  assert.equal(isDeleteCommandKey({ key: "Backspace" }, { mac: true }), true);
  assert.equal(isDeleteCommandKey({ key: "Backspace", metaKey: true }, { mac: true }), true);
  assert.equal(isDeleteCommandKey({ key: "Delete", shiftKey: true }, { mac: false }), false);
  assert.equal(isDeleteCommandKey({ key: "Delete", ctrlKey: true }, { mac: false }), false);
  assert.equal(isDeleteCommandKey({ key: "Delete", altKey: true }, { mac: false }), false);
});

test("Shift+F10 and the Menu key open the keyboard context menu", () => {
  assert.equal(isContextMenuKey({ key: "ContextMenu" }), true);
  assert.equal(isContextMenuKey({ key: "F10", shiftKey: true }), true);
  assert.equal(isContextMenuKey({ key: "F10" }), false);
  assert.equal(isContextMenuKey({ key: "F10", shiftKey: true, ctrlKey: true }), false);
});
