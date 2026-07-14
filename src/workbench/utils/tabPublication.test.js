import test from "node:test";
import assert from "node:assert/strict";

import {
  adjacentPublishedTabId,
  publishedActiveTabForPane,
  publishedTabsForPane,
  visibleTabsForPane,
} from "./tabPublication.js";

const tabs = [
  { id: "home", kind: "home" },
  { id: "opening", kind: "data", opening: true },
  { id: "ready", kind: "data", opening: false },
];
const pane = {
  id: "pane-1",
  tabIds: ["home", "opening", "ready"],
  activeTabId: "opening",
};

test("publishedTabsForPane excludes provisional tabs", () => {
  assert.deepEqual(publishedTabsForPane(tabs, pane).map((tab) => tab.id), ["home", "ready"]);
});

test("visibleTabsForPane exposes an opening tab without making it activatable", () => {
  assert.deepEqual(visibleTabsForPane(tabs, pane).map((tab) => tab.id), ["home", "opening", "ready"]);
  assert.equal(publishedActiveTabForPane(tabs, pane), null);
});

test("publishedActiveTabForPane rejects a provisional active tab", () => {
  assert.equal(publishedActiveTabForPane(tabs, pane), null);
});

test("adjacentPublishedTabId skips provisional tabs", () => {
  assert.equal(adjacentPublishedTabId(tabs, { ...pane, activeTabId: "home" }, "next"), "ready");
  assert.equal(adjacentPublishedTabId(tabs, { ...pane, activeTabId: "home" }, "previous"), "ready");
});
