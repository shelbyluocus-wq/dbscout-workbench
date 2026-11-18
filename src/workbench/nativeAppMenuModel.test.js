import test from "node:test";
import assert from "node:assert/strict";

import {
  acceleratorFromCombo,
  buildNativeAppMenuModel,
  nativeAppMenuSignature,
} from "./utils/nativeAppMenuModel.js";
import { translateIn } from "./i18n/index.js";
import { useNativeAppMenu } from "./composables/useNativeAppMenu.js";
import { noteShortcutKeydownMatch } from "./utils/menuShortcutDedup.js";

const zhCN = (key, params) => translateIn("zh-CN", key, params);
const en = (key, params) => translateIn("en", key, params);

const MAC_BINDINGS = {
  openSqlQuery: "Cmd+T",
  searchDatabase: "Ctrl+P",
  closeTab: "Ctrl+W",
  searchTable: "Ctrl+F",
  replaceInTable: "Cmd+Alt+F",
  openDesign: "Ctrl+D",
  editTableComment: "F3",
  openTableTransfer: "Ctrl+Shift+T",
  refresh: "F5",
  nextTab: "Cmd+Shift+]",
  previousTab: "Cmd+Shift+[",
  pinWindow: "F8",
};

function findItem(model, id) {
  for (const submenu of model) {
    const hit = (submenu.items || []).find((entry) => entry.id === id);
    if (hit) return hit;
  }
  return null;
}

test("acceleratorFromCombo converts combos to muda accelerator syntax", () => {
  assert.equal(acceleratorFromCombo("Cmd+T"), "CmdOrCtrl+T");
  assert.equal(acceleratorFromCombo("Ctrl+P"), "CmdOrCtrl+P");
  assert.equal(acceleratorFromCombo("Cmd+Alt+F"), "CmdOrCtrl+Alt+F");
  assert.equal(acceleratorFromCombo("Cmd+Shift+]"), "CmdOrCtrl+Shift+]");
  assert.equal(acceleratorFromCombo("Cmd+Shift+["), "CmdOrCtrl+Shift+[");
  assert.equal(acceleratorFromCombo("Ctrl+Shift+T"), "CmdOrCtrl+Shift+T");
  assert.equal(acceleratorFromCombo("Ctrl+`"), "CmdOrCtrl+`");
  assert.equal(acceleratorFromCombo("F8"), "F8");
  assert.equal(acceleratorFromCombo("Alt+Shift+F"), "Alt+Shift+F");
  assert.equal(acceleratorFromCombo(""), "");
});

test("menu model has localized labels, submenu structure and native roles", () => {
  const model = buildNativeAppMenuModel({ t: zhCN, bindings: MAC_BINDINGS, state: { hasDataTab: true } });
  assert.deepEqual(model.map((sub) => sub.id), ["app", "file", "edit", "table", "tools", "view", "window", "help"]);
  assert.equal(model.find((sub) => sub.id === "window").role, "windowMenu");
  assert.equal(model.find((sub) => sub.id === "help").role, "helpMenu");
  assert.equal(findItem(model, "app.quit").label, "退出黑猫");
  assert.equal(findItem(model, "app.hide").predefined, "Hide");
  assert.equal(findItem(model, "app.services").predefined, "Services");
  assert.equal(findItem(model, "app.about").kind, "about");
  assert.equal(findItem(model, "app.about").about.version, "");
  assert.equal(findItem(model, "view.fullscreen").predefined, "Fullscreen");
  assert.equal(findItem(model, "window.zoom").predefined, "Maximize");
  assert.equal(findItem(model, "window.bringAllToFront").predefined, "BringAllToFront");
  assert.equal(findItem(model, "file.closeTab").label, "关闭标签");

  const enModel = buildNativeAppMenuModel({ t: en, bindings: MAC_BINDINGS, state: { hasDataTab: true } });
  assert.equal(findItem(enModel, "app.quit").label, "Quit 黑猫");
  assert.equal(findItem(enModel, "edit.replace").label, "Replace…");
});

test("menu accelerators come from the live bindings", () => {
  const model = buildNativeAppMenuModel({ t: zhCN, bindings: MAC_BINDINGS, state: {} });
  assert.equal(findItem(model, "file.openSqlQuery").accelerator, "CmdOrCtrl+T");
  assert.equal(findItem(model, "edit.replace").accelerator, "CmdOrCtrl+Alt+F");
  assert.equal(findItem(model, "window.nextTab").accelerator, "CmdOrCtrl+Shift+]");
  assert.equal(findItem(model, "table.refresh").accelerator, "F5");
  // A cleared binding drops the accelerator and disables the item.
  const unbound = buildNativeAppMenuModel({ t: zhCN, bindings: { ...MAC_BINDINGS, openSqlQuery: "" }, state: {} });
  const sqlItem = findItem(unbound, "file.openSqlQuery");
  assert.equal(sqlItem.accelerator, "");
  assert.equal(sqlItem.enabled, false);
});

test("Close shows the live binding without registering a competing native accelerator", () => {
  const modelFor = (closeTab) => buildNativeAppMenuModel({ t: en, bindings: { closeTab } });
  const original = modelFor("Ctrl+W");
  const rebound = modelFor("Cmd+Shift+K");
  for (const [model, hint] of [[original, "⌘W"], [rebound, "⇧⌘K"], [modelFor(""), ""]]) {
    const close = findItem(model, "file.closeTab");
    assert.equal(close.shortcutHint, hint);
    assert.equal(close.enabled, Boolean(hint));
    assert.equal(close.accelerator, undefined);
    assert.equal(close.shortcutAction, undefined);
  }
  assert.notEqual(nativeAppMenuSignature(original), nativeAppMenuSignature(rebound));
});

test("explicit Close clicks ignore recent key matches and only act in the focused native window", async (ctx) => {
  let close;
  let onForwarded;
  let mainFocused = true;
  let forward = () => false;
  const calls = [];
  const item = { new: async (options) => {
    if (options?.text === "menu.closeTab  ⌘W") close = options;
    return {};
  } };
  const menuApi = { MenuItem: item, PredefinedMenuItem: item, CheckMenuItem: item, Submenu: item,
    Menu: { new: async () => ({ setAsAppMenu: async () => {} }) } };
  useNativeAppMenu({ enabled: () => true, secondaryWindow: true,
    listenForwarded: (fn) => { onForwarded = fn; }, actions: { closeTabOrHide: () => calls.push("folder") } });
  const menu = useNativeAppMenu({ enabled: () => true, menuApi, translate: (key) => key, bindings: MAC_BINDINGS,
    hasFocus: () => !mainFocused, nativeWindowHasFocus: async () => mainFocused,
    forwardAction: (entry) => forward(entry), actions: { closeTabOrHide: () => calls.push("main") } });
  ctx.after(menu.stop);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(close);
  assert.equal(close.accelerator, undefined);
  noteShortcutKeydownMatch("closeTab");
  await close.action();
  await close.action();
  mainFocused = false;
  forward = (entry) => { onForwarded(entry); return true; };
  await close.action();
  await close.action();
  forward = () => false;
  await close.action();
  forward = () => { throw new Error("window closed"); };
  await close.action();
  assert.deepEqual(calls, ["main", "main", "folder", "folder"]);
});

test("enabled gates mirror the handlers", () => {
  const noData = buildNativeAppMenuModel({ t: zhCN, bindings: MAC_BINDINGS, state: { hasDataTab: false } });
  assert.equal(findItem(noData, "edit.find").enabled, false);
  assert.equal(findItem(noData, "edit.replace").enabled, false);
  const withData = buildNativeAppMenuModel({ t: zhCN, bindings: MAC_BINDINGS, state: { hasDataTab: true, canOpenDesign: true, canEditTableComment: true, canRefresh: true, hasNextTab: true } });
  assert.equal(findItem(withData, "edit.find").enabled, true);
  assert.equal(findItem(withData, "table.openDesign").enabled, true);
  assert.equal(findItem(withData, "table.editTableComment").enabled, true);
  assert.equal(findItem(withData, "window.nextTab").enabled, true);
  assert.equal(findItem(withData, "window.pinWindow").kind, "check");
  assert.equal(findItem(withData, "window.pinWindow").checked, false);
  const pinned = buildNativeAppMenuModel({ t: zhCN, bindings: MAC_BINDINGS, state: { windowPinned: true } });
  assert.equal(findItem(pinned, "window.pinWindow").checked, true);
});

test("tools submenu lists rail tools then more-actions with a separator", () => {
  const tools = [
    { id: "backupCenter", label: "备份中心", action: "backupCenter" },
    { id: "tableTransfer", label: "一键转表", action: "tableTransfer", shortcutAction: "openTableTransfer" },
    { id: "moreSync", label: "覆盖同步…", action: "moreSync", group: "more", enabled: false },
    { id: "moreExport", label: "批量导出", action: "moreExport", group: "more", enabled: true },
  ];
  const model = buildNativeAppMenuModel({ t: zhCN, bindings: MAC_BINDINGS, state: { tools } });
  const submenu = model.find((sub) => sub.id === "tools");
  const ids = submenu.items.map((entry) => entry.id);
  assert.deepEqual(ids, ["tools.backupCenter", "tools.tableTransfer", "tools.sep.moreSync", "tools.moreSync", "tools.moreExport"]);
  assert.equal(findItem(model, "tools.tableTransfer").accelerator, "CmdOrCtrl+Shift+T");
  assert.equal(findItem(model, "tools.moreSync").enabled, false);
  assert.equal(findItem(model, "tools.moreExport").enabled, true);
});

test("appearance submenu offers three exclusive check items", () => {
  const model = buildNativeAppMenuModel({ t: zhCN, bindings: MAC_BINDINGS, state: { themePreference: "system" } });
  const appearance = findItem(model, "view.appearance");
  assert.equal(appearance.kind, "submenu");
  assert.equal(appearance.label, "外观");
  assert.deepEqual(appearance.items.map((e) => e.action), ["appearanceLight", "appearanceDark", "appearanceSystem"]);
  assert.equal(appearance.items[0].checked, false);
  assert.equal(appearance.items[1].checked, false);
  assert.equal(appearance.items[2].checked, true);
  const light = buildNativeAppMenuModel({ t: zhCN, bindings: MAC_BINDINGS, state: { themePreference: "light" } });
  assert.equal(findItem(light, "view.appearance").items[0].checked, true);
  assert.equal(findItem(light, "view.appearance").items[2].checked, false);
});

test("signature changes on labels/bindings but not on dynamic state", () => {
  const base = { hasDataTab: false, windowPinned: false, sidebarCollapsed: false, inspectorCollapsed: false };
  const a = buildNativeAppMenuModel({ t: zhCN, bindings: MAC_BINDINGS, state: base });
  const b = buildNativeAppMenuModel({ t: zhCN, bindings: MAC_BINDINGS, state: { ...base, hasDataTab: true, windowPinned: true, sidebarCollapsed: true } });
  // Enabled/checked/dynamic-label differences stay in-place updates.
  assert.equal(nativeAppMenuSignature(a), nativeAppMenuSignature(b));
  // Binding change → rebuild.
  const c = buildNativeAppMenuModel({ t: zhCN, bindings: { ...MAC_BINDINGS, nextTab: "Cmd+Shift+." }, state: base });
  assert.notEqual(nativeAppMenuSignature(a), nativeAppMenuSignature(c));
  // Language change → rebuild.
  const d = buildNativeAppMenuModel({ t: en, bindings: MAC_BINDINGS, state: base });
  assert.notEqual(nativeAppMenuSignature(a), nativeAppMenuSignature(d));
});
