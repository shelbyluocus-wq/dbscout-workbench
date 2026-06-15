import test from "node:test";
import assert from "node:assert/strict";

import {
  closePaneInLayout,
  createPaneLayoutState,
  createPaneRecord,
  listPaneIds,
  pruneEmptyPanesInLayout,
  resizeSplitInLayout,
  splitPaneInLayout,
} from "./paneLayoutState.js";

test("createPaneLayoutState starts with one focused pane", () => {
  const state = createPaneLayoutState();

  assert.equal(state.focusedPaneId, "pane-1");
  assert.deepEqual(state.layout, { type: "pane", paneId: "pane-1" });
  assert.deepEqual(Object.keys(state.panes), ["pane-1"]);
  assert.deepEqual(state.panes["pane-1"], createPaneRecord("pane-1"));
});

test("splitPaneInLayout recursively splits the focused pane and creates a sibling pane", () => {
  const state = createPaneLayoutState();

  const rightPane = splitPaneInLayout(state, "pane-1", "right");
  const bottomPane = splitPaneInLayout(state, "pane-1", "down");

  assert.equal(rightPane.id, "pane-2");
  assert.equal(bottomPane.id, "pane-3");
  assert.equal(state.focusedPaneId, "pane-3");
  assert.deepEqual(state.layout, {
    type: "split",
    id: "split-1",
    direction: "horizontal",
    ratio: 0.5,
    first: {
      type: "split",
      id: "split-2",
      direction: "vertical",
      ratio: 0.5,
      first: { type: "pane", paneId: "pane-1" },
      second: { type: "pane", paneId: "pane-3" },
    },
    second: { type: "pane", paneId: "pane-2" },
  });
  assert.deepEqual(listPaneIds(state.layout), ["pane-1", "pane-3", "pane-2"]);
});

test("splitPaneInLayout splits the requested pane after a four-pane layout exists", () => {
  const state = createPaneLayoutState();

  splitPaneInLayout(state, "pane-1", "right");
  splitPaneInLayout(state, "pane-1", "down");
  splitPaneInLayout(state, "pane-2", "down");
  const created = splitPaneInLayout(state, "pane-3", "right");

  assert.equal(created.id, "pane-5");
  assert.equal(state.focusedPaneId, "pane-5");
  assert.deepEqual(listPaneIds(state.layout), ["pane-1", "pane-3", "pane-5", "pane-2", "pane-4"]);
  assert.deepEqual(state.layout.first.second, {
    type: "split",
    id: "split-4",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "pane", paneId: "pane-3" },
    second: { type: "pane", paneId: "pane-5" },
  });
  assert.deepEqual(state.layout.second.first, { type: "pane", paneId: "pane-2" });
});

test("closePaneInLayout merges the sibling branch and moves tabs to a remaining pane", () => {
  const state = createPaneLayoutState();
  splitPaneInLayout(state, "pane-1", "right");
  state.panes["pane-1"].tabIds.push("tab-a");
  state.panes["pane-2"].tabIds.push("tab-b");

  const result = closePaneInLayout(state, "pane-1");

  assert.equal(result.closedPaneId, "pane-1");
  assert.equal(result.targetPaneId, "pane-2");
  assert.deepEqual(state.layout, { type: "pane", paneId: "pane-2" });
  assert.deepEqual(Object.keys(state.panes), ["pane-2"]);
  assert.deepEqual(state.panes["pane-2"].tabIds, ["tab-b", "tab-a"]);
  assert.equal(state.focusedPaneId, "pane-2");
});

test("closePaneInLayout refuses to close the final pane", () => {
  const state = createPaneLayoutState();

  const result = closePaneInLayout(state, "pane-1");

  assert.equal(result, null);
  assert.deepEqual(Object.keys(state.panes), ["pane-1"]);
  assert.equal(state.focusedPaneId, "pane-1");
});

test("pruneEmptyPanesInLayout collapses empty split panes after their last tab closes", () => {
  const state = createPaneLayoutState();
  splitPaneInLayout(state, "pane-1", "right");
  state.panes["pane-1"].tabIds.push("tab-a");
  state.panes["pane-1"].activeTabId = "tab-a";
  state.panes["pane-2"].tabIds.push("tab-b");
  state.panes["pane-2"].activeTabId = "tab-b";
  state.focusedPaneId = "pane-2";

  state.panes["pane-2"].tabIds = [];
  state.panes["pane-2"].activeTabId = "";
  const result = pruneEmptyPanesInLayout(state);

  assert.deepEqual(result.closedPaneIds, ["pane-2"]);
  assert.deepEqual(state.layout, { type: "pane", paneId: "pane-1" });
  assert.deepEqual(Object.keys(state.panes), ["pane-1"]);
  assert.equal(state.focusedPaneId, "pane-1");
});

test("pruneEmptyPanesInLayout keeps a single empty pane when all tabs are closed", () => {
  const state = createPaneLayoutState();
  splitPaneInLayout(state, "pane-1", "right");
  state.panes["pane-1"].tabIds = [];
  state.panes["pane-1"].activeTabId = "";
  state.panes["pane-2"].tabIds = [];
  state.panes["pane-2"].activeTabId = "";
  state.focusedPaneId = "pane-2";

  const result = pruneEmptyPanesInLayout(state);

  assert.deepEqual(result.closedPaneIds, ["pane-2"]);
  assert.deepEqual(state.layout, { type: "pane", paneId: "pane-1" });
  assert.deepEqual(Object.keys(state.panes), ["pane-1"]);
  assert.equal(state.focusedPaneId, "pane-1");
  assert.deepEqual(state.panes["pane-1"].tabIds, []);
});

test("resizeSplitInLayout clamps ratios to keep both panes usable", () => {
  const state = createPaneLayoutState();
  splitPaneInLayout(state, "pane-1", "right");

  assert.equal(resizeSplitInLayout(state.layout, "split-1", 0.05), true);
  assert.equal(state.layout.ratio, 0.18);

  assert.equal(resizeSplitInLayout(state.layout, "split-1", 0.95), true);
  assert.equal(state.layout.ratio, 0.82);
});
