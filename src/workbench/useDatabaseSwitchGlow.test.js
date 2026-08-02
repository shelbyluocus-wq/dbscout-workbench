import test from "node:test";
import assert from "node:assert/strict";

import {
  GLOW_COLOR_PRESETS,
  createDatabaseSwitchGlow,
  createGlowColorController,
  glowEngineLabel,
  resolveGlowColorCss,
  resolveSwitchGlow,
} from "./composables/useDatabaseSwitchGlow.js";

function createStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem(key) {
      return Object.hasOwn(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
    removeItem(key) {
      delete store[key];
    },
  };
}

function createRoot() {
  const styles = {};
  return {
    styles,
    style: {
      setProperty(name, value) {
        styles[name] = value;
      },
      removeProperty(name) {
        delete styles[name];
      },
    },
  };
}

function dataTab(id, connectionId, database, kind = "data") {
  return { id, kind, connectionId, database };
}

// ── resolveSwitchGlow ──────────────────────────────────────────────────────

test("switch glow plays when switching to a tab of a different database", () => {
  const tabs = [dataTab("1", "conn-a", "shop"), dataTab("2", "conn-a", "crm")];
  assert.deepEqual(
    resolveSwitchGlow({ tabs, prevTabId: "1", nextTabId: "2" }),
    { connectionId: "conn-a", database: "crm" },
  );
});

test("switch glow treats same database name on another connection as different", () => {
  const tabs = [dataTab("1", "conn-a", "shop"), dataTab("2", "conn-b", "shop")];
  assert.deepEqual(
    resolveSwitchGlow({ tabs, prevTabId: "1", nextTabId: "2" }),
    { connectionId: "conn-b", database: "shop" },
  );
});

test("switch glow joins connectionId and database without ambiguity", () => {
  // "ab"+"c" 与 "a"+"bc" 必须视为两个不同的库
  const tabs = [dataTab("1", "ab", "c"), dataTab("2", "a", "bc")];
  assert.deepEqual(
    resolveSwitchGlow({ tabs, prevTabId: "1", nextTabId: "2" }),
    { connectionId: "a", database: "bc" },
  );
});

test("switch glow does not play between tabs of the same database", () => {
  const tabs = [
    dataTab("1", "conn-a", "shop"),
    dataTab("2", "conn-a", "shop"),
    dataTab("3", "conn-a", "crm"),
  ];
  assert.equal(resolveSwitchGlow({ tabs, prevTabId: "1", nextTabId: "2" }), null);
  assert.equal(resolveSwitchGlow({ tabs, prevTabId: "1", nextTabId: "1" }), null);
});

test("switch glow does not play for the first activated tab", () => {
  const tabs = [dataTab("1", "conn-a", "shop"), dataTab("2", "conn-a", "crm")];
  assert.equal(resolveSwitchGlow({ tabs, prevTabId: "", nextTabId: "1" }), null);
  assert.equal(resolveSwitchGlow({ tabs, prevTabId: "missing", nextTabId: "1" }), null);
});

test("switch glow skips tabs without a database on either side", () => {
  const tabs = [
    dataTab("1", "conn-a", "shop"),
    dataTab("2", "conn-a", "crm"),
    dataTab("lib", "", "", "sql-library"),
  ];
  assert.equal(resolveSwitchGlow({ tabs, prevTabId: "1", nextTabId: "lib" }), null);
  assert.equal(resolveSwitchGlow({ tabs, prevTabId: "lib", nextTabId: "2" }), null);
});

test("switch glow participates for home, design and sql tabs", () => {
  const tabs = [
    dataTab("1", "conn-a", "shop", "home"),
    dataTab("2", "conn-a", "crm", "design"),
    dataTab("3", "conn-a", "crm", "sql"),
  ];
  assert.deepEqual(resolveSwitchGlow({ tabs, prevTabId: "1", nextTabId: "2" }), {
    connectionId: "conn-a",
    database: "crm",
  });
  assert.equal(resolveSwitchGlow({ tabs, prevTabId: "2", nextTabId: "3" }), null);
});

test("switch glow requires the next tab to exist", () => {
  const tabs = [dataTab("1", "conn-a", "shop"), dataTab("2", "conn-a", "crm")];
  assert.equal(resolveSwitchGlow({ tabs, prevTabId: "1", nextTabId: "gone" }), null);
});

// ── createDatabaseSwitchGlow ───────────────────────────────────────────────

test("switch glow play publishes a playback record and auto-clears it", async () => {
  const glow = createDatabaseSwitchGlow({ duration: 10 });
  glow.play({ engine: "MySQL", label: "商城库", markerColor: "#0d9488" });
  assert.equal(glow.playback.value?.engine, "MySQL");
  assert.equal(glow.playback.value?.label, "商城库");
  assert.equal(glow.playback.value?.markerColor, "#0d9488");

  const firstId = glow.playback.value.id;
  glow.play({ engine: "MySQL", label: "另一个库" });
  assert.ok(glow.playback.value.id > firstId, "重播应分配递增 id");
  assert.equal(glow.playback.value.label, "另一个库");

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(glow.playback.value, null);
});

test("switch glow stop clears playback immediately", () => {
  const glow = createDatabaseSwitchGlow({ duration: 1000 });
  glow.play({ engine: "ClickHouse", label: "日志库" });
  glow.stop();
  assert.equal(glow.playback.value, null);
});

// ── glowEngineLabel ────────────────────────────────────────────────────────

test("glow engine label maps connection kinds", () => {
  assert.equal(glowEngineLabel("mysql"), "MySQL");
  assert.equal(glowEngineLabel("clickhouse"), "ClickHouse");
  assert.equal(glowEngineLabel(undefined), "MySQL");
  assert.equal(glowEngineLabel("MySQL"), "MySQL");
});

// ── resolveGlowColorCss ────────────────────────────────────────────────────

test("glow color presets resolve per theme", () => {
  const teal = GLOW_COLOR_PRESETS.find((preset) => preset.value === "preset:teal");
  assert.equal(resolveGlowColorCss("preset:teal", "light"), teal.light);
  assert.equal(resolveGlowColorCss("preset:teal", "dark"), teal.dark);
  assert.equal(resolveGlowColorCss("PRESET:TEAL", "light"), teal.light);
});

test("glow color accepts hex and rejects invalid values", () => {
  assert.equal(resolveGlowColorCss("#A1B2C3", "light"), "#a1b2c3");
  assert.equal(resolveGlowColorCss("", "light"), "");
  assert.equal(resolveGlowColorCss("preset:unknown", "light"), "");
  assert.equal(resolveGlowColorCss("red", "dark"), "");
});

// ── createGlowColorController ──────────────────────────────────────────────

test("glow color writes a user override token that dark theme can inherit", () => {
  const storage = createStorage();
  const root = createRoot();
  const glow = createGlowColorController({ storage, root });

  glow.setColor("#ff3366");
  assert.equal(root.styles["--wb-glow-custom"], "#ff3366");

  glow.clear();
  assert.equal(root.styles["--wb-glow-custom"], undefined);
});

test("glow color stores independent colors for light and dark themes", () => {
  const storage = createStorage();
  const root = createRoot();
  let theme = "dark";
  const glow = createGlowColorController({ storage, root, getTheme: () => theme });

  glow.setColor("preset:teal");
  assert.equal(root.styles["--wb-glow-custom"], "#2dd4bf");
  assert.equal(storage.store["dbscout_glow_color_dark"], "preset:teal");

  theme = "light";
  glow.syncTheme();
  assert.equal(glow.color.value, "");
  assert.equal(root.styles["--wb-glow-custom"], undefined);

  glow.setColor("preset:amber");
  assert.equal(root.styles["--wb-glow-custom"], "#d97706");
  assert.equal(storage.store["dbscout_glow_color_light"], "preset:amber");

  theme = "dark";
  glow.syncTheme();
  assert.equal(glow.color.value, "preset:teal");
  assert.equal(root.styles["--wb-glow-custom"], "#2dd4bf");
});

test("glow color migrates the legacy single-key value into the active theme", () => {
  const storage = createStorage({ dbscout_glow_color: "#123abc" });
  const root = createRoot();
  const glow = createGlowColorController({ storage, root, getTheme: () => "light" });

  assert.equal(glow.color.value, "#123abc");
  assert.equal(storage.store["dbscout_glow_color_light"], "#123abc");
  assert.equal(storage.store.dbscout_glow_color, undefined);
  glow.syncTheme();
  assert.equal(root.styles["--wb-glow-custom"], "#123abc");
});
