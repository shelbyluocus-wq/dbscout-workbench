import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RELATION_PANEL_SECTIONS,
  RELATION_PANEL_STORAGE_KEY,
  loadRelationPanelSections,
  saveRelationPanelSections,
} from "./relationPanelPrefs.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

test("sections start open except the rejected group", () => {
  assert.deepEqual(loadRelationPanelSections(memoryStorage()), { row: true, table: true, rejected: false });
  assert.deepEqual(DEFAULT_RELATION_PANEL_SECTIONS, { row: true, table: true, rejected: false });
});

test("saved sections round-trip and unknown or malformed values fall back", () => {
  const storage = memoryStorage();
  saveRelationPanelSections({ row: false, table: true, rejected: true, extra: "ignored" }, storage);
  assert.deepEqual(JSON.parse(storage.data.get(RELATION_PANEL_STORAGE_KEY)), { row: false, table: true, rejected: true });
  assert.deepEqual(loadRelationPanelSections(storage), { row: false, table: true, rejected: true });

  assert.deepEqual(
    loadRelationPanelSections(memoryStorage({ [RELATION_PANEL_STORAGE_KEY]: '{"row":"no","table":false}' })),
    { row: true, table: false, rejected: false },
  );
  assert.deepEqual(loadRelationPanelSections(memoryStorage({ [RELATION_PANEL_STORAGE_KEY]: "{oops" })), DEFAULT_RELATION_PANEL_SECTIONS);
  assert.deepEqual(loadRelationPanelSections(memoryStorage({ [RELATION_PANEL_STORAGE_KEY]: "[1]" })), DEFAULT_RELATION_PANEL_SECTIONS);
});

test("blocked storage never breaks the panel", () => {
  const blocked = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  assert.deepEqual(loadRelationPanelSections(blocked), DEFAULT_RELATION_PANEL_SECTIONS);
  assert.doesNotThrow(() => saveRelationPanelSections({ row: false }, blocked));
  assert.deepEqual(loadRelationPanelSections(null), DEFAULT_RELATION_PANEL_SECTIONS);
});
