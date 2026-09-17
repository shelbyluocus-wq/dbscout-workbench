import test from "node:test";
import assert from "node:assert/strict";

import {
  BORDER_TOKEN,
  CANVAS_TOKENS,
  DEBUG_COLOR_FIELDS,
  FILL_HANDLE_LEFT_TOKEN,
  FILL_HANDLE_SIZE_TOKEN,
  FILL_HANDLE_TOP_TOKEN,
  FRAME_SHADOW_TOKEN,
  RADIUS_TOKEN,
  applyBorderAlpha,
  applyColorField,
  applyFillHandle,
  applyFrameShadow,
  applyRadius,
  buildExportCss,
  clearAllOverrides,
  colorToHex,
  fillHandleDeltaFromKey,
  managedTokens,
  nudgeFillHandle,
  oklchToHex,
} from "./designDebug.js";

function createFakeElement() {
  const store = new Map();
  return {
    store,
    style: {
      setProperty(name, value) { store.set(name, String(value)); },
      removeProperty(name) { store.delete(name); },
      getPropertyValue(name) { return store.get(name) ?? ""; },
    },
  };
}

test("canvas color field fans out to every canvas token", () => {
  assert.deepEqual(CANVAS_TOKENS, [
    "--wb-workspace-mist",
    "--wb-workspace-mist-raised",
    "--wb-workspace-mist-canvas",
    "--wb-grid-row",
  ]);
  const canvasField = DEBUG_COLOR_FIELDS.find((field) => field.key === "canvas");
  assert.equal(canvasField.tokens.length, CANVAS_TOKENS.length);

  const target = createFakeElement();
  applyColorField(target, canvasField, "#101013");
  for (const token of CANVAS_TOKENS) assert.equal(target.store.get(token), "#101013");
});

test("radius clamps into range and lands on the document element", () => {
  const documentElement = createFakeElement();
  const doc = { documentElement };
  assert.equal(applyRadius(doc, 12), 12);
  assert.equal(documentElement.store.get(RADIUS_TOKEN), "12px");
  assert.equal(applyRadius(doc, 99), 32);
  assert.equal(documentElement.store.get(RADIUS_TOKEN), "32px");
  assert.equal(applyRadius(doc, -4), 0);
  assert.equal(documentElement.store.get(RADIUS_TOKEN), "0px");
});

test("border alpha uses the mode's ink base and clamps", () => {
  const target = createFakeElement();
  applyBorderAlpha(target, "light", 0.12);
  assert.equal(target.store.get(BORDER_TOKEN), "rgba(45, 55, 72, 0.12)");
  applyBorderAlpha(target, "dark", 0.2);
  assert.equal(target.store.get(BORDER_TOKEN), "rgba(255, 255, 255, 0.2)");
  assert.equal(applyBorderAlpha(target, "light", 1), 0.4);
});

test("frame shadow is none at zero and a soft drop otherwise", () => {
  const target = createFakeElement();
  applyFrameShadow(target, 0);
  assert.equal(target.store.get(FRAME_SHADOW_TOKEN), "none");
  applyFrameShadow(target, 0.18);
  assert.equal(target.store.get(FRAME_SHADOW_TOKEN), "0 5px 8px -5px rgba(0, 0, 0, 0.18)");
});

test("clearAllOverrides strips inline overrides from both mode targets", () => {
  const documentElement = createFakeElement();
  const workbench = createFakeElement();
  const doc = { documentElement, querySelector: () => workbench };

  const chromeField = DEBUG_COLOR_FIELDS.find((field) => field.key === "chrome");
  applyColorField(workbench, chromeField, "#1b1b1f");
  applyRadius(doc, 20);
  for (const token of managedTokens()) {
    documentElement.style.setProperty(token, "x");
    workbench.style.setProperty(token, "x");
  }

  clearAllOverrides("dark", doc);
  for (const token of managedTokens()) {
    assert.equal(documentElement.store.has(token), false, `documentElement ${token}`);
    assert.equal(workbench.store.has(token), false, `workbench ${token}`);
  }
});

test("fill handle geometry clamps and writes document tokens", () => {
  const documentElement = createFakeElement();
  const applied = applyFillHandle({ documentElement }, { left: -3, top: -5, size: 8 });
  assert.deepEqual(applied, { left: -3, top: -5, size: 8 });
  assert.equal(documentElement.store.get(FILL_HANDLE_LEFT_TOKEN), "-3px");
  assert.equal(documentElement.store.get(FILL_HANDLE_TOP_TOKEN), "-5px");
  assert.equal(documentElement.store.get(FILL_HANDLE_SIZE_TOKEN), "8px");
  assert.deepEqual(applyFillHandle({ documentElement }, { left: -99, top: 40, size: 1 }), {
    left: -32,
    top: 16,
    size: 2,
  });
});

test("arrow keys nudge fill handle coordinates one pixel", () => {
  assert.deepEqual(fillHandleDeltaFromKey("ArrowLeft"), { axis: "x", delta: -1 });
  assert.deepEqual(fillHandleDeltaFromKey("ArrowRight"), { axis: "x", delta: 1 });
  assert.deepEqual(fillHandleDeltaFromKey("ArrowUp"), { axis: "y", delta: -1 });
  assert.deepEqual(fillHandleDeltaFromKey("ArrowDown"), { axis: "y", delta: 1 });
  assert.equal(fillHandleDeltaFromKey("Escape"), null);
  assert.deepEqual(
    nudgeFillHandle({ left: -4, top: -4, size: 6 }, "x", 1),
    { left: -3, top: -4, size: 6 },
  );
  assert.deepEqual(
    nudgeFillHandle({ left: -4, top: -4, size: 6 }, "y", -1),
    { left: -4, top: -5, size: 6 },
  );
});

test("buildExportCss targets :root in light and the dark selector in dark", () => {
  const values = { chrome: "#e8ebef", canvas: "#ffffff", header: "#f0f2f6", index: "#f2f4f7", altRow: "#f6f7f9", radius: 12, borderAlpha: 0.12, shadowStrength: 0, fillLeft: -4, fillTop: -4, fillSize: 6 };
  const light = buildExportCss("light", values);
  assert.match(light, /^\/\* 设计调试导出（浅色 模式） \*\/\n:root \{/);
  assert.match(light, /--wb-chrome-surface: #e8ebef;/);
  assert.match(light, /--wb-grid-row: #ffffff;/);
  assert.match(light, /--wb-frame-shadow: none;/);
  assert.match(light, /--wb-fill-handle-left: -4px;/);
  assert.match(light, /--wb-fill-handle-top: -4px;/);
  assert.match(light, /--wb-fill-handle-size: 6px;/);

  const dark = buildExportCss("dark", { ...values, shadowStrength: 0.2 });
  assert.match(dark, /\.mysql-workbench\[data-theme="dark"\], \.wb-floating-themed\[data-theme="dark"\] \{/);
  assert.match(dark, /--wb-frame-shadow: 0 5px 8px -5px rgba\(0, 0, 0, 0.2\);/);
});

test("colorToHex normalizes hex and rgb() without needing a canvas", () => {
  assert.equal(colorToHex("#E8EBEF"), "#e8ebef");
  assert.equal(colorToHex("rgb(27, 27, 31)"), "#1b1b1f");
  assert.equal(colorToHex("rgba(45, 55, 72, 0.12)"), "#2d3748");
  assert.equal(colorToHex(""), "#000000");
});

test("colorToHex converts oklch tokens (number and percent lightness)", () => {
  assert.equal(oklchToHex(1, 0, 0), "#ffffff");
  assert.equal(oklchToHex(0, 0, 0), "#000000");

  const fromNumber = colorToHex("oklch(0.958 0.004 255)");
  const fromPercent = colorToHex("oklch(95.8% 0.004 255)");
  assert.equal(fromPercent, fromNumber);
  assert.match(fromNumber, /^#[0-9a-f]{6}$/);
  // oklch(0.958 0.004 255) ≈ sRGB (240, 241, 244)
  const channels = [1, 3, 5].map((i) => Number.parseInt(fromNumber.slice(i, i + 2), 16));
  const expected = [240, 241, 244];
  channels.forEach((value, i) => {
    assert.ok(Math.abs(value - expected[i]) <= 2, `channel ${i}: ${value} vs ${expected[i]}`);
  });
});
