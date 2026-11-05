import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { COLOR_THEMES, DEFAULT_COLOR_THEME, getColorTheme, isColorThemeAvailable, isColorThemeId } from "./colorThemes.js";
import { createColorThemeController, renderColorThemeCss, COLOR_THEME_STORAGE_KEY } from "./colorThemeController.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseCss = readFileSync(join(__dirname, "workbench.css"), "utf8");

function definedTokenNames() {
  return new Set([...baseCss.matchAll(/--wb-[a-z0-9-]+(?=\s*:)/g)].map((match) => match[0]));
}

test("registry exposes the default theme first with unique ids and swatches", () => {
  assert.ok(COLOR_THEMES.length >= 3);
  assert.equal(COLOR_THEMES[0].id, DEFAULT_COLOR_THEME);
  const ids = new Set(COLOR_THEMES.map((theme) => theme.id));
  assert.equal(ids.size, COLOR_THEMES.length);
  for (const theme of COLOR_THEMES) {
    assert.ok(theme.label, theme.id);
    assert.equal(theme.swatch.length, 3, theme.id);
    assert.equal(typeof theme.light, "object", theme.id);
    assert.equal(typeof theme.dark, "object", theme.id);
  }
  assert.ok(isColorThemeId("teal"));
  assert.ok(!isColorThemeId("bogus"));
  assert.equal(getColorTheme("bogus"), null);
});

test("every theme override references tokens that exist in the base stylesheet", () => {
  const defined = definedTokenNames();
  for (const theme of COLOR_THEMES) {
    for (const variant of ["light", "dark"]) {
      for (const tokenName of Object.keys(theme[variant])) {
        assert.ok(defined.has(tokenName), `${theme.id}.${variant} references unknown ${tokenName}`);
      }
    }
  }
});

test("non-default themes override the accent family in both variants", () => {
  for (const theme of COLOR_THEMES.filter((item) => item.id !== DEFAULT_COLOR_THEME)) {
    for (const variant of ["light", "dark"]) {
      assert.ok(theme[variant]["--wb-accent"], `${theme.id}.${variant} missing --wb-accent`);
      assert.ok(theme[variant]["--wb-accent-control"], `${theme.id}.${variant} missing --wb-accent-control`);
      assert.ok(theme[variant]["--wb-accent-control-busy"], `${theme.id}.${variant} missing --wb-accent-control-busy`);
    }
  }
});

test("renderColorThemeCss renders base selectors so floating surfaces inherit", () => {
  assert.equal(renderColorThemeCss(getColorTheme(DEFAULT_COLOR_THEME)), "");
  const css = renderColorThemeCss(getColorTheme("teal"));
  assert.match(css, /:root\{[^}]*--wb-accent:#0f766e/);
  assert.match(css, /\.mysql-workbench\[data-theme="dark"\], \.wb-floating-themed\[data-theme="dark"\]\{/);
  assert.match(css, /--wb-accent:#2dd4bf/);
});

function createFakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    get data() { return data; },
  };
}

function createFakeDocument() {
  const tags = [];
  return {
    tags,
    head: {
      appendChild(tag) { tags.push(tag); },
    },
    createElement() {
      const tag = {
        id: "",
        textContent: "",
        remove() {
          const index = tags.indexOf(tag);
          if (index >= 0) tags.splice(index, 1);
        },
      };
      return tag;
    },
    getElementById(id) {
      return tags.find((tag) => tag.id === id) || null;
    },
  };
}

test("controller starts on the default theme without injecting a style tag", () => {
  const storage = createFakeStorage();
  const documentRef = createFakeDocument();
  const controller = createColorThemeController({ storage, documentRef });

  assert.equal(controller.currentTheme.value, DEFAULT_COLOR_THEME);
  controller.start();
  assert.equal(documentRef.tags.length, 0);
});

test("setColorTheme persists, injects overrides, and switching back removes them", () => {
  const storage = createFakeStorage();
  const documentRef = createFakeDocument();
  const controller = createColorThemeController({ storage, documentRef });
  controller.start();

  controller.setColorTheme("teal");
  assert.equal(controller.currentTheme.value, "teal");
  assert.equal(storage.data.get(COLOR_THEME_STORAGE_KEY), "teal");
  assert.equal(documentRef.tags.length, 1);
  assert.match(documentRef.tags[0].textContent, /--wb-accent:#0f766e/);

  controller.setColorTheme("azure");
  assert.equal(documentRef.tags.length, 1);
  assert.match(documentRef.tags[0].textContent, /--wb-accent:#2563eb/);

  controller.setColorTheme(DEFAULT_COLOR_THEME);
  assert.equal(documentRef.tags.length, 0);

  controller.setColorTheme("bogus");
  assert.equal(controller.currentTheme.value, DEFAULT_COLOR_THEME);
});

test("controller restores the persisted theme on start", () => {
  const storage = createFakeStorage({ [COLOR_THEME_STORAGE_KEY]: "azure" });
  const documentRef = createFakeDocument();
  const controller = createColorThemeController({ storage, documentRef });

  assert.equal(controller.currentTheme.value, "azure");
  controller.start();
  assert.equal(documentRef.tags.length, 1);
  assert.match(documentRef.tags[0].textContent, /--wb-accent:#2563eb/);
});

test("system accent preset derives tokens from the accent color", () => {
  const theme = getColorTheme("system");
  assert.equal(typeof theme.tokens, "function");
  const css = renderColorThemeCss(theme, { accent: "#FFC600" });
  assert.match(css, /--wb-accent:#FFC600/);
  assert.match(css, /--wb-accent-control-text:#1a1c20/); // yellow → dark text
});

test("system preset is unavailable outside the macOS runtime and falls back to slate", () => {
  assert.equal(isColorThemeAvailable("system", { systemAccentSupported: false }), false);
  assert.equal(isColorThemeAvailable("system", { systemAccentSupported: true }), true);
  const storage = { getItem: () => "system", setItem() {}, removeItem() {} };
  const documentRef = { head: null };
  const c1 = createColorThemeController({ storage, documentRef, systemAccentSupported: false });
  assert.equal(c1.currentTheme.value, "slate");
  assert.equal(c1.themes.some((t) => t.id === "system"), false);
  const c2 = createColorThemeController({ storage, documentRef, systemAccentSupported: true });
  assert.equal(c2.currentTheme.value, "system");
  assert.equal(c2.themes.some((t) => t.id === "system"), true);
});
