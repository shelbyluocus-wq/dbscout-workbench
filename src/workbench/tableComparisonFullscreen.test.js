import test from "node:test";
import assert from "node:assert/strict";
import {
  applyExitFullscreen,
  applyTableSelectionToFullscreen,
  createTableComparisonFullscreen,
  isTableFullscreenFocused,
  isTableStage,
  resetTableComparisonFullscreen,
  toggleGlobalFullscreen,
  toggleTableFullscreen,
} from "./composables/tableComparisonFullscreen.js";

test("table fullscreen isolates a table and restores the previous filter", () => {
  const start = createTableComparisonFullscreen();
  const entered = toggleTableFullscreen(start, "skillprop", "");
  assert.equal(entered.state.isFullscreen, true);
  assert.equal(entered.state.focusedSheet, "skillprop");
  assert.equal(entered.state.restoreTable, "");
  assert.equal(entered.restoreTable, null);
  assert.equal(isTableStage(entered.state), true);
  assert.equal(isTableFullscreenFocused(entered.state, "skillprop"), true);
  assert.equal(isTableFullscreenFocused(entered.state, "skilldecprop"), false);
  assert.equal(isTableStage(toggleGlobalFullscreen(createTableComparisonFullscreen()).state), false);

  const exited = toggleTableFullscreen(entered.state, "skillprop", "skillprop");
  assert.deepEqual(exited.state, resetTableComparisonFullscreen());
  assert.equal(exited.restoreTable, "");
});

test("toolbar fullscreen does not change the current table filter", () => {
  const entered = toggleGlobalFullscreen(createTableComparisonFullscreen());
  assert.equal(entered.state.isFullscreen, true);
  assert.equal(entered.state.focusedSheet, "");
  assert.equal(entered.restoreTable, null);

  const exited = toggleGlobalFullscreen(entered.state);
  assert.equal(exited.state.isFullscreen, false);
  assert.equal(exited.restoreTable, null);
});

test("focusing a table from an existing fullscreen view still restores the prior filter", () => {
  const fullscreen = toggleGlobalFullscreen(createTableComparisonFullscreen()).state;
  const focused = toggleTableFullscreen(fullscreen, "skilldataprop", "");
  assert.equal(focused.state.isFullscreen, true);
  assert.equal(focused.state.focusedSheet, "skilldataprop");
  assert.equal(focused.state.restoreTable, "");

  const exited = applyExitFullscreen(focused.state);
  assert.equal(exited.state.isFullscreen, false);
  assert.equal(exited.restoreTable, "");
});

test("switching tables while focused keeps fullscreen and remembers the original filter", () => {
  const focused = toggleTableFullscreen(createTableComparisonFullscreen(), "skillprop", "").state;
  const switched = applyTableSelectionToFullscreen(focused, "skilldecprop");
  assert.equal(switched.isFullscreen, true);
  assert.equal(switched.focusedSheet, "skilldecprop");
  assert.equal(switched.restoreTable, "");

  const allTables = applyTableSelectionToFullscreen(switched, "");
  assert.equal(allTables.isFullscreen, true);
  assert.equal(allTables.focusedSheet, "");
  assert.equal(allTables.restoreTable, null);
});
