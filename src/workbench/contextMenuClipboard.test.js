import { readLocalizedContractSource } from "./test-support/localizedContractSource.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { useContextMenu } from "./composables/useContextMenu.js";

const read = (path) => readLocalizedContractSource(new URL(path, import.meta.url), "utf8");

function createMenu(statusText = { value: "" }) {
  return useContextMenu(
    { statusText },
    {
      loadTables: async () => {},
      ensureTableSchema: async () => {},
      fetchPage: async () => {},
    },
    { value: null },
  );
}

test("detail clipboard menu keeps its requested lower-right anchor when it fits", () => {
  const originalWidth = globalThis.innerWidth;
  const originalHeight = globalThis.innerHeight;
  Object.defineProperty(globalThis, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(globalThis, "innerHeight", { value: 820, configurable: true });
  const menu = createMenu();

  try {
    menu.openContextMenu(
      { clientX: 500, clientY: 620 },
      { tableName: "activity" },
      {
        surface: "detail",
        menuHeight: 112,
        clipboardActions: {
          canCopy: true,
          canPaste: true,
          copy: async () => {},
          paste: async () => {},
        },
      },
    );

    assert.equal(menu.contextMenu.x, 500);
    assert.equal(menu.contextMenu.y, 620);
    assert.equal(menu.contextMenu.surface, "detail");
    assert.equal(menu.contextMenu.showClipboardActions, true);
    assert.equal(menu.contextMenu.canCopy, true);
    assert.equal(menu.contextMenu.canPaste, true);
  } finally {
    Object.defineProperty(globalThis, "innerWidth", { value: originalWidth, configurable: true });
    Object.defineProperty(globalThis, "innerHeight", { value: originalHeight, configurable: true });
  }
});

test("context clipboard commands run the captured action and close the menu", async () => {
  const statusText = { value: "" };
  const menu = createMenu(statusText);
  const calls = [];
  const clipboardActions = {
    canCopy: true,
    canPaste: true,
    copy: async () => calls.push("copy"),
    paste: async () => calls.push("paste"),
  };

  menu.openContextMenu({ clientX: 20, clientY: 30 }, null, { surface: "detail", clipboardActions });
  await menu.copyFromContextMenu();
  assert.deepEqual(calls, ["copy"]);
  assert.equal(menu.contextMenu.open, false);
  assert.equal(statusText.value, "复制成功");

  menu.openContextMenu({ clientX: 20, clientY: 30 }, null, { surface: "detail", clipboardActions });
  await menu.pasteFromContextMenu();
  assert.deepEqual(calls, ["copy", "paste"]);
  assert.equal(menu.contextMenu.open, false);
  assert.equal(statusText.value, "粘贴成功");
});

test("context clipboard commands preserve an action failure instead of reporting success", async () => {
  const statusText = { value: "" };
  const menu = createMenu(statusText);
  const clipboardActions = {
    canCopy: true,
    canPaste: true,
    paste: async () => ({ ok: false, message: "读取剪贴板失败" }),
  };

  menu.openContextMenu({ clientX: 20, clientY: 30 }, null, { surface: "grid", clipboardActions });
  const result = await menu.pasteFromContextMenu();

  assert.equal(result, false);
  assert.equal(menu.contextMenu.open, false);
  assert.equal(statusText.value, "读取剪贴板失败");
});

test("grid and detail surfaces wire copy and paste into the shared menu", async () => {
  const [contextMenu, detailPanel, pane, splitLayout, workbench] = await Promise.all([
    read("./components/ContextMenu.vue"),
    read("./components/CellDetailPanel.vue"),
    read("./components/WorkbenchPane.vue"),
    read("./components/WorkbenchSplitLayout.vue"),
    read("./MySqlWorkbench.vue"),
  ]);

  assert.match(contextMenu, /showClipboardActions/);
  assert.match(contextMenu, /canCopy/);
  assert.match(contextMenu, /canPaste/);
  assert.match(contextMenu, /emit\(['"]copy['"]\)/);
  assert.match(contextMenu, /emit\(['"]paste['"]\)/);
  assert.match(contextMenu, />复制</);
  assert.match(contextMenu, />粘贴</);

  assert.match(detailPanel, /detail-contextmenu/);
  assert.match(detailPanel, /@contextmenu\.prevent\.stop="openDetailContextMenu"/);
  assert.match(detailPanel, /navigator\?\.clipboard|navigator\.clipboard/);
  assert.match(pane, /detail-contextmenu/);
  assert.match(pane, /copyGridSelection/);
  assert.match(pane, /pasteGridSelection/);
  assert.match(pane, /invokeWorkbench\("read_clipboard_text"\)/);
  assert.match(pane, /\.then\(\(text\) => pasteGridText\(text\)\)/);
  assert.match(splitLayout, /detail-contextmenu/);
  assert.match(workbench, /openDetailContextMenu/);
  assert.match(workbench, /menuHeight:\s*DETAIL_CONTEXT_MENU_HEIGHT/);
  assert.match(workbench, /@detail-contextmenu="openDetailContextMenu"/);
  assert.match(workbench, /@copy="copyFromContextMenu"/);
  assert.match(workbench, /@paste="pasteFromContextMenu"/);
});

test("grid context-menu paste uses the native desktop clipboard command", async () => {
  const [pane, mockBackend, rustClipboard, rustLib, cargo] = await Promise.all([
    read("./components/WorkbenchPane.vue"),
    read("./mock/mockBackend.js"),
    fs.promises.readFile(new URL("../../src-tauri/src/clipboard.rs", import.meta.url), "utf8"),
    fs.promises.readFile(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    fs.promises.readFile(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8"),
  ]);

  assert.match(pane, /invokeWorkbench\("read_clipboard_text"\)/);
  assert.match(mockBackend, /command === "read_clipboard_text"/);
  assert.match(rustClipboard, /pub fn read_clipboard_text/);
  assert.match(rustLib, /clipboard::read_clipboard_text/);
  assert.match(rustLib, /tauri_plugin_clipboard_manager::init\(\)/);
  assert.match(cargo, /tauri-plugin-clipboard-manager\s*=\s*"2"/);
});
