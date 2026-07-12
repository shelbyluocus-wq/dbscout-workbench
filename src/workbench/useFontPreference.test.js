import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FONT_PREFERENCE,
  DEFAULT_FONT_WEIGHT,
  FONT_STORAGE_KEY,
  FONT_WEIGHT_STORAGE_KEY,
  createFontPreferenceController,
  customFontPreference,
  fontPreferenceLabel,
  fontStackForPreference,
  fontWeightLabel,
  normalizeCustomFontFamily,
  normalizeFontWeight,
} from "./composables/useFontPreference.js";

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
  const properties = {};
  return {
    properties,
    style: {
      setProperty(name, value) {
        properties[name] = value;
      },
      removeProperty(name) {
        delete properties[name];
      },
    },
  };
}

test("saved font family and weight are applied when the controller starts", () => {
  const storage = createStorage({
    [FONT_STORAGE_KEY]: "dengxian",
    [FONT_WEIGHT_STORAGE_KEY]: "300",
  });
  const root = createRoot();
  const font = createFontPreferenceController({ storage, rootElement: root });

  font.start();

  assert.equal(font.preference.value, "dengxian");
  assert.equal(font.weight.value, 300);
  assert.equal(font.label.value, "等线");
  assert.equal(font.weightLabel.value, "细体 Light 300");
  assert.match(root.properties["--wb-font-ui"], /^DengXian,/);
  assert.equal(root.properties["--wb-font-weight-ui"], "300");
});

test("custom fonts are normalized, persisted, and receive a readable fallback stack", () => {
  const storage = createStorage();
  const root = createRoot();
  const font = createFontPreferenceController({ storage, rootElement: root });

  font.setPreference(customFontPreference("  HarmonyOS   Sans SC  "));

  assert.equal(font.preference.value, "custom:HarmonyOS Sans SC");
  assert.equal(storage.store[FONT_STORAGE_KEY], "custom:HarmonyOS Sans SC");
  assert.equal(fontPreferenceLabel(font.preference.value), "HarmonyOS Sans SC");
  assert.match(root.properties["--wb-font-ui"], /^"HarmonyOS Sans SC",/);
  assert.match(fontStackForPreference(font.preference.value), /Microsoft YaHei UI/);
});

test("restoring the system font clears the stored override and root token", () => {
  const storage = createStorage({
    [FONT_STORAGE_KEY]: "microsoft-yahei",
    [FONT_WEIGHT_STORAGE_KEY]: "500",
  });
  const root = createRoot();
  const font = createFontPreferenceController({ storage, rootElement: root });

  font.start();
  font.setPreference(DEFAULT_FONT_PREFERENCE);
  font.setWeight(DEFAULT_FONT_WEIGHT);

  assert.equal(font.preference.value, DEFAULT_FONT_PREFERENCE);
  assert.equal(storage.store[FONT_STORAGE_KEY], undefined);
  assert.equal(storage.store[FONT_WEIGHT_STORAGE_KEY], undefined);
  assert.equal(root.properties["--wb-font-ui"], undefined);
  assert.equal(root.properties["--wb-font-weight-ui"], undefined);
});

test("invalid stored and custom values fall back to the system font", () => {
  const storage = createStorage({ [FONT_STORAGE_KEY]: "custom:Bad, fallback" });
  const root = createRoot();
  const font = createFontPreferenceController({ storage, rootElement: root });

  font.start();

  assert.equal(font.preference.value, DEFAULT_FONT_PREFERENCE);
  assert.equal(root.properties["--wb-font-ui"], undefined);
  assert.equal(normalizeCustomFontFamily('Bad"Font'), "");
  assert.equal(normalizeCustomFontFamily("A".repeat(81)), "");
  assert.equal(normalizeFontWeight(0), DEFAULT_FONT_WEIGHT);
  assert.equal(normalizeFontWeight(350), 350);
  assert.equal(fontWeightLabel(500), "中等 Medium 500");
  assert.equal(fontWeightLabel(350), "半细 SemiLight 350");
});

test("font weights persist independently from the selected family", () => {
  const storage = createStorage();
  const root = createRoot();
  const font = createFontPreferenceController({ storage, rootElement: root });

  font.setPreference(customFontPreference("Arial"));
  font.setWeight(600);

  assert.equal(storage.store[FONT_STORAGE_KEY], "custom:Arial");
  assert.equal(storage.store[FONT_WEIGHT_STORAGE_KEY], "600");
  assert.equal(root.properties["--wb-font-weight-ui"], "600");
});
