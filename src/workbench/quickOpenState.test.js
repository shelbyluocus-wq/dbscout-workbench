import test from "node:test";
import assert from "node:assert/strict";
import {
  QUICK_OPEN_DEFAULT_SIZE,
  QUICK_OPEN_MAX_MOUNTED_RESULTS,
  advanceQuickOpenResultWindow,
  clampQuickOpenSize,
  createQuickOpenResultWindow,
  createQuickOpenScopeState,
  ensureQuickOpenResultMounted,
  loadQuickOpenSize,
  quickOpenIncludedTables,
  quickOpenResultRange,
  quickOpenScopeTableSelected,
  quickOpenValueSearchDisabled,
  resetQuickOpenScopeToResults,
  resetQuickOpenResultWindow,
  saveQuickOpenSize,
  scaleQuickOpenSize,
  syncQuickOpenScopeResults,
  toggleQuickOpenScopeTable,
} from "./quickOpenState.js";

test("quick open automatically selects all structure hits", () => {
  const state = createQuickOpenScopeState();
  syncQuickOpenScopeResults(state, ["vip_user", "vip_order"], true);
  assert.deepEqual(state.excludedTables, []);
  assert.deepEqual(quickOpenIncludedTables(state, ["vip_user", "vip_order"], true), ["vip_user", "vip_order"]);
  assert.equal(state.mode, "auto");
});

test("manual scope records only exclusions while later queries include new matches", () => {
  const state = createQuickOpenScopeState();
  syncQuickOpenScopeResults(state, ["vip_user", "vip_order"], true);
  toggleQuickOpenScopeTable(state, "vip_order", false);
  syncQuickOpenScopeResults(state, ["vip_user", "vip_order", "vip_log"], true);
  assert.equal(state.mode, "custom");
  assert.deepEqual(state.excludedTables, ["vip_order"]);
  assert.deepEqual(
    quickOpenIncludedTables(state, ["vip_user", "vip_order", "vip_log"], true),
    ["vip_user", "vip_log"],
  );
  assert.equal(quickOpenScopeTableSelected(state, "vip_order", true), false);
  assert.equal(quickOpenScopeTableSelected(state, "vip_log", true), true);

  resetQuickOpenScopeToResults(state, ["vip_order", "vip_log"], true);
  assert.equal(state.mode, "auto");
  assert.deepEqual(state.excludedTables, []);
});

test("empty structure query keeps all-database search compatibility", () => {
  const state = createQuickOpenScopeState();
  syncQuickOpenScopeResults(state, ["player"], false);
  assert.deepEqual(quickOpenIncludedTables(state, ["player"], false), []);
  assert.equal(quickOpenValueSearchDisabled(state, ["player"], false), false);
  assert.equal(quickOpenValueSearchDisabled(state, [], true), true);
});

test("quick open result window grows by 60 and never mounts more than 120 results", () => {
  const state = createQuickOpenResultWindow(800);
  assert.deepEqual(quickOpenResultRange(state, 800), { start: 0, end: 60 });

  assert.equal(advanceQuickOpenResultWindow(state, 800, "down"), true);
  assert.deepEqual(quickOpenResultRange(state, 800), { start: 0, end: 120 });
  assert.equal(advanceQuickOpenResultWindow(state, 800, "down"), true);
  assert.deepEqual(quickOpenResultRange(state, 800), { start: 60, end: 180 });
  assert.equal(quickOpenResultRange(state, 800).end - quickOpenResultRange(state, 800).start, QUICK_OPEN_MAX_MOUNTED_RESULTS);

  assert.equal(advanceQuickOpenResultWindow(state, 800, "up"), true);
  assert.deepEqual(quickOpenResultRange(state, 800), { start: 0, end: 120 });
});

test("keyboard navigation mounts wrapped boundary results without exceeding the cap", () => {
  const state = createQuickOpenResultWindow(800);
  ensureQuickOpenResultMounted(state, 799, 800);
  const lastRange = quickOpenResultRange(state, 800);
  assert.equal(lastRange.end, 800);
  assert.ok(lastRange.start <= 799);
  assert.ok(lastRange.end - lastRange.start <= QUICK_OPEN_MAX_MOUNTED_RESULTS);

  ensureQuickOpenResultMounted(state, 0, 800);
  assert.equal(quickOpenResultRange(state, 800).start, 0);
  resetQuickOpenResultWindow(state, 10);
  assert.deepEqual(quickOpenResultRange(state, 10), { start: 0, end: 10 });
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
