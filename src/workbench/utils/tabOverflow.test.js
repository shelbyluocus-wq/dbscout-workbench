import test from "node:test";
import assert from "node:assert/strict";
import { partitionTabs } from "./tabOverflow.js";
import { createWorkspaceState, openTableTab, activateTableTab } from "../workspaceState.js";
import { buildWorkspaceSnapshot, parseWorkspaceSnapshot } from "./workspacePersistence.js";

const tabs = [{ id: "home", kind: "home" }, ...Array.from({ length: 30 }, (_, index) => ({ id: `tab-${index}`, kind: "data" }))];

test("thirty tables remain open, individually selectable and persisted", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "game" });
  const opened = Array.from({ length: 30 }, (_, index) => openTableTab(state, { tableName: `table_${index}` }));
  assert.equal(state.tabs.filter((tab) => tab.kind === "data").length, 30);
  for (const tab of opened) {
    activateTableTab(state, tab.id);
    assert.equal(state.activeTabId, tab.id);
  }
  const restored = parseWorkspaceSnapshot(buildWorkspaceSnapshot(state));
  assert.equal(restored.tabs.filter((tab) => tab.kind === "data").length, 30);
  assert.equal(restored.activeTabId, opened.at(-1).id);
});

test("overflow preserves home, active table, original order and every tab", () => {
  for (const width of [0, 180, 360, 800, 1400]) {
    const { visible, overflow } = partitionTabs(tabs, "tab-29", width);
    assert.ok(visible.includes(tabs[0]));
    assert.ok(visible.includes(tabs.at(-1)));
    assert.equal(new Set([...visible, ...overflow]).size, tabs.length);
    assert.equal(visible.length + overflow.length, tabs.length);
    assert.deepEqual(visible, tabs.filter((tab) => visible.includes(tab)));
    assert.ok(overflow.length > 0);
  }
});

test("wide panes show all tabs and empty panes have no overflow", () => {
  assert.deepEqual(partitionTabs(tabs, "tab-29", 4000), { visible: tabs, overflow: [] });
  assert.deepEqual(partitionTabs([], "", 0), { visible: [], overflow: [] });
});

test("switching to an overflow tab swaps visibility without reordering tabs", () => {
  const original = [...tabs];
  const first = partitionTabs(tabs, "tab-0", 600);
  const target = first.overflow.at(-1);
  const next = partitionTabs(tabs, target.id, 600);
  assert.ok(next.visible.includes(target));
  assert.ok(!next.overflow.includes(target));
  assert.deepEqual(tabs, original);
});
