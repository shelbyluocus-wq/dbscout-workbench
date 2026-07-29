import test from "node:test";
import assert from "node:assert/strict";

import {
  DATABASE_TEXT_COLOR_PRESETS,
  createDatabaseDecorationStore,
  databaseTextColorCss,
  normalizeDatabaseDecoration,
  resolveDatabaseDecoration,
} from "./composables/databaseDecorationStore.js";

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); },
    values,
  };
}

test("database decorations normalize invalid values and persist by connection and database", () => {
  const storage = memoryStorage();
  const store = createDatabaseDecorationStore({ storage });

  store.setDatabaseDecoration("mysql-1", "analytics", { icon: "rocket", color: "#F97316", textColor: "preset:blue" });

  assert.deepEqual(store.getDatabaseDecoration("mysql-1", "analytics"), { icon: "rocket", color: "#f97316", textColor: "preset:blue" });
  assert.equal(databaseTextColorCss("preset:blue"), "var(--wb-database-name-blue)");
  assert.equal(databaseTextColorCss("#2563EB"), "#2563eb");
  assert.equal(resolveDatabaseDecoration(store.decorations.value, "mysql-2", "analytics"), null);
  assert.deepEqual(normalizeDatabaseDecoration({ icon: "unknown", color: "red", textColor: "blue" }), { icon: "database", color: "", textColor: "" });
  assert.match(storage.values.dbscout_database_decorations, /analytics/);
});

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16) / 255);
  const [red, green, blue] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(first, second) {
  const light = Math.max(relativeLuminance(first), relativeLuminance(second));
  const dark = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (light + 0.05) / (dark + 0.05);
}

test("database name presets remain readable on both sidebar themes", () => {
  for (const preset of DATABASE_TEXT_COLOR_PRESETS) {
    assert.ok(contrastRatio(preset.light, "#f6f6f4") >= 4.5, `${preset.value} light contrast`);
    assert.ok(contrastRatio(preset.dark, "#19191b") >= 4.5, `${preset.value} dark contrast`);
  }
});

test("database decorations reset, prune missing databases, and remove connection scope", () => {
  const store = createDatabaseDecorationStore({ storage: memoryStorage() });
  store.setDatabaseDecoration("mysql-1", "keep", { icon: "star", color: "#2563eb" });
  store.setDatabaseDecoration("mysql-1", "drop", { icon: "cloud", color: "#15803d" });
  store.setDatabaseDecoration("mysql-2", "other", { icon: "archive", color: "#64748b" });

  store.pruneDatabaseDecorations("mysql-1", ["keep"]);
  assert.ok(store.getDatabaseDecoration("mysql-1", "keep"));
  assert.equal(store.getDatabaseDecoration("mysql-1", "drop"), null);

  store.setDatabaseDecoration("mysql-1", "keep", { icon: "database", color: "", textColor: "" });
  assert.equal(store.getDatabaseDecoration("mysql-1", "keep"), null);

  store.removeConnectionDecorations("mysql-2");
  assert.equal(store.getDatabaseDecoration("mysql-2", "other"), null);
});
