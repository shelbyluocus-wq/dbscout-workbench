import test from "node:test";
import assert from "node:assert/strict";
import {
  QUICK_OPEN_DEFAULT_SIZE,
  clampQuickOpenSize,
  createQuickOpenScopeState,
  loadQuickOpenSize,
  quickOpenIncludedTables,
  quickOpenValueSearchDisabled,
  resetQuickOpenScopeToResults,
  saveQuickOpenSize,
  scaleQuickOpenSize,
  syncQuickOpenScopeResults,
  toggleQuickOpenScopeTable,
} from "./quickOpenState.js";

test("quick open automatically selects all structure hits", () => {
  const state = createQuickOpenScopeState();
  syncQuickOpenScopeResults(state, ["vip_user", "vip_order"], true);
  assert.deepEqual(state.selectedTables, ["vip_user", "vip_order"]);
  assert.equal(state.mode, "auto");
});

test("manual scope becomes custom and later queries preserve the explicit selection", () => {
  const state = createQuickOpenScopeState();
  syncQuickOpenScopeResults(state, ["vip_user", "vip_order"], true);
  toggleQuickOpenScopeTable(state, "vip_order", false);
  syncQuickOpenScopeResults(state, ["vip_user", "vip_order", "vip_log"], true);
  assert.equal(state.mode, "custom");
  assert.deepEqual(state.selectedTables, ["vip_user"]);

  resetQuickOpenScopeToResults(state, ["vip_order", "vip_log"], true);
  assert.equal(state.mode, "auto");
  assert.deepEqual(state.selectedTables, ["vip_order", "vip_log"]);
});

test("empty structure query keeps all-database search compatibility", () => {
  const state = createQuickOpenScopeState();
  syncQuickOpenScopeResults(state, ["player"], false);
  assert.deepEqual(quickOpenIncludedTables(state, false), []);
  assert.equal(quickOpenValueSearchDisabled(state, false), false);
  assert.equal(quickOpenValueSearchDisabled(state, true), true);
});

test("quick open size preference validates and clamps to the safe viewport", () => {
  assert.deepEqual(clampQuickOpenSize({ width: 5000, height: 1 }, { width: 1000, height: 700 }), {
    width: 976,
    height: 360,
  });
  const storage = { getItem: () => "not-json" };
  assert.deepEqual(loadQuickOpenSize(storage, { width: 1200, height: 900 }), QUICK_OPEN_DEFAULT_SIZE);
});

test("quick open stores viewport ratios and scales down with the app window", () => {
  let value = "";
  const storage = {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
  };
  saveQuickOpenSize({ width: 1200, height: 720 }, storage, { width: 1920, height: 1080 });
  assert.deepEqual(loadQuickOpenSize(storage, { width: 1280, height: 720 }), {
    width: 800,
    height: 480,
  });
  assert.deepEqual(
    scaleQuickOpenSize({ width: 960, height: 600 }, { width: 1600, height: 1000 }, { width: 1000, height: 700 }),
    { width: 600, height: 420 },
  );
});
