import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPageZoom, pageZoomAction } from "./utils/pageZoom.js";
import { buildNativeAppMenuModel } from "./utils/nativeAppMenuModel.js";
import { translateIn } from "./i18n/index.js";

test("page zoom follows the platform modifier and accepts plus, equals and keypad", () => {
  for (const platform of ["macos", "windows"]) {
    const modifier = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
    for (const event of [{ key: "+", shiftKey: true }, { key: "=" }, { code: "NumpadAdd" }]) {
      assert.equal(pageZoomAction({ ...modifier, ...event }, platform), "zoomIn");
    }
    for (const event of [{ key: "-" }, { code: "NumpadSubtract" }]) {
      assert.equal(pageZoomAction({ ...modifier, ...event }, platform), "zoomOut");
    }
    for (const event of [{ key: "0" }, { code: "Numpad0" }]) {
      assert.equal(pageZoomAction({ ...modifier, ...event }, platform), "zoomReset");
    }
    for (const extra of [{ altKey: true }, { isComposing: true }, { defaultPrevented: true }, { key: "a" }]) {
      assert.equal(pageZoomAction({ ...modifier, key: "+", ...extra }, platform), null);
    }
    assert.equal(pageZoomAction({ key: "+" }, platform), null);
  }
  assert.equal(pageZoomAction({ key: "+", ctrlKey: true }, "macos"), null);
  assert.equal(pageZoomAction({ key: "+", metaKey: true }, "windows"), null);
});

test("zoom steps are exact, bounded and resettable", async () => {
  const changes = [];
  const zoom = createPageZoom({ applyZoom: async () => {}, onChange: (value) => changes.push(value) });
  await zoom.run("zoomIn");
  assert.equal(zoom.scale, 1.1);
  assert.deepEqual(changes, [110]);
  for (let count = 0; count < 30; count += 1) await zoom.run("zoomIn");
  assert.equal(zoom.scale, 2);
  for (let count = 0; count < 30; count += 1) await zoom.run("zoomOut");
  assert.equal(zoom.scale, 0.5);
  await zoom.run("zoomReset");
  assert.equal(zoom.scale, 1);
  await zoom.run("not-an-action");
  assert.equal(zoom.scale, 1);
});

test("rapid shortcuts serialize native writes and retain the latest intent", async () => {
  const calls = [];
  let finishFirst;
  const zoom = createPageZoom({ applyZoom: async (scale) => {
    calls.push(scale);
    if (calls.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
  } });
  const pending = zoom.run("zoomIn");
  await Promise.resolve();
  zoom.run("zoomIn");
  zoom.run("zoomIn");
  assert.deepEqual(calls, [1.1]);
  finishFirst();
  await pending;
  assert.deepEqual(calls, [1.1, 1.3]);
  assert.equal(zoom.scale, 1.3);
});

test("native failure does not advance the scale and the next shortcut can retry", async () => {
  let fail = true;
  const errors = [];
  const zoom = createPageZoom({
    applyZoom: async () => { if (fail) throw new Error("denied"); },
    onError: (error) => errors.push(error.message),
  });
  await zoom.run("zoomIn");
  assert.equal(zoom.scale, 1);
  assert.deepEqual(errors, ["denied"]);
  fail = false;
  await zoom.run("zoomIn");
  assert.equal(zoom.scale, 1.1);
});

test("native menu exposes localized, deduplicated zoom actions", () => {
  for (const locale of ["zh-CN", "zh-TW", "en"]) {
    const model = buildNativeAppMenuModel({ t: (key) => translateIn(locale, key) });
    const entries = model.find((entry) => entry.id === "view").items;
    for (const [action, accelerator] of [["zoomIn", "CmdOrCtrl+="], ["zoomOut", "CmdOrCtrl+-"], ["zoomReset", "CmdOrCtrl+0"]]) {
      const entry = entries.find((candidate) => candidate.action === action);
      assert.equal(entry.shortcutAction, action);
      assert.equal(entry.accelerator, accelerator);
      assert.ok(!entry.label.startsWith("pageZoom."));
    }
  }
});

test("desktop grants zoom permission and routes zoom before modal shortcut blocking", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const capability = JSON.parse(read("../../src-tauri/capabilities/main.json"));
  assert.ok(capability.permissions.includes("core:webview:allow-set-webview-zoom"));
  const source = read("./MySqlWorkbench.vue");
  const handler = source.slice(source.indexOf("function handleGlobalShortcutKeydown(event)"));
  assert.ok(handler.indexOf("pageZoomAction(event") < handler.indexOf("dialogLayerManager.hasActiveModalLayer()"));
  assert.match(handler, /zoomAction && isTauriRuntime\(\)/);
  assert.match(source, /getCurrentWebview\(\).setZoom\(scale\)/);
});
