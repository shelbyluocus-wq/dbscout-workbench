import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import en from "./i18n/en.js";
import zhCN from "./i18n/zhCN.js";
import zhTW from "./i18n/zhTW.js";
import {
  useShortcuts,
  DEFAULT_BINDINGS,
  MACOS_DEFAULT_BINDINGS,
  defaultBindingsFor,
  migrateMacosDefaultBindings,
  shortcutLabel,
  _resetSingletonForTests,
  isSafeInAppShortcut,
  matchesShortcutCombo,
  sameShortcutCombo,
  shortcutComboFromEvent,
} from "./composables/useShortcuts.js";
import { _resetMenuShortcutDedupForTests, isRecentShortcutKeydown, noteShortcutKeydownMatch } from "./utils/menuShortcutDedup.js";

function fakeInvoke() {
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return {};
  };
  invoke.calls = calls;
  return invoke;
}

function failingInvoke(failingCommand) {
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === failingCommand) throw new Error("系统已占用该快捷键");
    return {};
  };
  invoke.calls = calls;
  return invoke;
}

function keyEvent(key, { ctrl = false, shift = false, alt = false, meta = false, code = "" } = {}) {
  return { key, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta, code };
}

// Node's navigator reports the host platform ("MacIntel" here); most tests
// assume the Windows/default binding set, so pin a Windows-like navigator and
// let macOS-specific tests override it.
function pinNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}

beforeEach(() => {
  // Each test starts from a clean singleton + empty storage.
  _resetSingletonForTests();
  _resetMenuShortcutDedupForTests();
  pinNavigator({ platform: "Win32" });
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
});

test("useShortcuts exposes the default bindings", () => {
  const { get } = useShortcuts(fakeInvoke());
  assert.equal(get("openWindow"), "Alt+Shift+F");
  assert.equal(get("pinWindow"), "F8");
  assert.equal(get("searchDatabase"), "Ctrl+P");
  assert.equal(get("closeTab"), "Ctrl+W");
  assert.equal(get("nextTab"), "Ctrl+Tab");
  assert.equal(get("previousTab"), "Ctrl+Shift+Tab");
});

test("editing a home table comment defaults to F3 and supports rebinding and clearing", async () => {
  const shortcuts = useShortcuts(fakeInvoke());
  assert.equal(shortcuts.get("editTableComment"), "F3");
  assert.equal(shortcuts.matchesBinding("editTableComment", keyEvent("F3")), true);
  assert.equal(shortcuts.matchesBinding("editTableComment", keyEvent("F3", { shift: true })), false);
  await shortcuts.rebind("editTableComment", "Ctrl+E");
  assert.equal(shortcuts.matchesBinding("editTableComment", keyEvent("F3")), false);
  assert.equal(shortcuts.matchesBinding("editTableComment", keyEvent("e", { meta: true })), true);
  await shortcuts.rebind("editTableComment", "");
  assert.equal(shortcuts.matchesBinding("editTableComment", keyEvent("e", { ctrl: true })), false);
});

test("matchesBinding compares modifier+key case-insensitively and treats Ctrl/Cmd alike", () => {
  const { matchesBinding } = useShortcuts(fakeInvoke());
  assert.equal(matchesBinding("searchDatabase", keyEvent("p", { ctrl: true })), true);
  assert.equal(matchesBinding("searchDatabase", keyEvent("P", { ctrl: true })), true);
  // Cmd counts as the Ctrl modifier.
  assert.equal(matchesBinding("searchDatabase", keyEvent("p", { meta: true })), true);
  assert.equal(matchesBinding("openWindow", keyEvent("F", { shift: true, alt: true })), true);
  assert.equal(matchesBinding("openWindow", keyEvent("F", { shift: true })), false);
  assert.equal(matchesBinding("openWindow", keyEvent("F", { shift: true, ctrl: true })), false);
  assert.equal(matchesBinding("pinWindow", keyEvent("F8")), true);
  assert.equal(matchesBinding("pinWindow", keyEvent("F8", { ctrl: true })), false);
  assert.equal(matchesBinding("closeTab", keyEvent("w", { ctrl: true })), true);
  assert.equal(matchesBinding("nextTab", keyEvent("Tab", { ctrl: true })), true);
  assert.equal(matchesBinding("previousTab", keyEvent("Tab", { ctrl: true, shift: true })), true);
  assert.equal(matchesBinding("previousTab", keyEvent("Tab", { ctrl: true })), false);
});

test("F5 refreshes by default and every action has a localized label", () => {
  const { get, matchesBinding } = useShortcuts(fakeInvoke());
  assert.equal(get("refresh"), "F5");
  assert.equal(matchesBinding("refresh", keyEvent("F5")), true);
  assert.equal(matchesBinding("refresh", keyEvent("F5", { ctrl: true })), false);
  for (const action of Object.keys(DEFAULT_BINDINGS)) {
    const key = `shortcut.${action}`;
    for (const catalog of [en, zhCN, zhTW]) assert.ok(catalog[key], `${key} is missing`);
    assert.notEqual(shortcutLabel(action), action);
  }
});

test("shortcut helpers capture, compare, and validate favorite database bindings", () => {
  assert.equal(shortcutComboFromEvent(keyEvent("1", { ctrl: true, shift: true })), "Ctrl+Shift+1");
  assert.equal(shortcutComboFromEvent(keyEvent("Meta", { meta: true })), null);
  assert.equal(shortcutComboFromEvent(keyEvent(" ", { alt: true })), "Alt+Space");
  assert.equal(matchesShortcutCombo("Ctrl+1", keyEvent("1", { meta: true })), true);
  assert.equal(sameShortcutCombo("Cmd+Shift+K", "Ctrl+Shift+k"), true);
  assert.equal(sameShortcutCombo("Ctrl+K", "Ctrl+Shift+K"), false);
  assert.equal(isSafeInAppShortcut("Ctrl+1"), true);
  assert.equal(isSafeInAppShortcut("F9"), true);
  assert.equal(isSafeInAppShortcut("K"), false);
});

test("rebind updates, persists, and registers global shortcuts via the backend", async () => {
  const store = {};
  globalThis.localStorage = {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: () => {},
  };
  const invoke = fakeInvoke();
  const { get, rebind } = useShortcuts(invoke);

  await rebind("openWindow", "Ctrl+Shift+O");
  assert.equal(get("openWindow"), "Ctrl+Shift+O");
  assert.deepEqual(invoke.calls, [{ command: "register_global_shortcut", payload: { binding: "Ctrl+Shift+O" } }]);

  // Clearing a global action unregisters.
  await rebind("openWindow", "");
  assert.equal(get("openWindow"), "");
  assert.equal(invoke.calls.at(-1).command, "unregister_global_shortcut");
});

test("rebind for a non-global action does not touch the backend", async () => {
  const invoke = fakeInvoke();
  const { get, rebind } = useShortcuts(invoke);

  await rebind("searchTable", "Ctrl+H");
  assert.equal(get("searchTable"), "Ctrl+H");
  assert.deepEqual(invoke.calls, []);
});

test("reset restores all default bindings and re-registers the global shortcut", async () => {
  const invoke = fakeInvoke();
  const { get, rebind, reset } = useShortcuts(invoke);

  await rebind("save", "Ctrl+Q");
  assert.equal(get("save"), "Ctrl+Q");
  await reset();
  assert.equal(get("save"), DEFAULT_BINDINGS.save);
  assert.equal(get("openWindow"), DEFAULT_BINDINGS.openWindow);
  // reset() re-registers the global openWindow binding (#2).
  assert.deepEqual(invoke.calls.at(-1), { command: "register_global_shortcut", payload: { binding: DEFAULT_BINDINGS.openWindow } });
});

test("stored bindings override defaults on load", () => {
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ searchDatabase: "Ctrl+K" }),
    setItem: () => {},
    removeItem: () => {},
  };
  const { get } = useShortcuts(fakeInvoke());
  assert.equal(get("searchDatabase"), "Ctrl+K");
  assert.equal(get("openWindow"), DEFAULT_BINDINGS.openWindow);
});

test("refresh keeps edits from different windows and restores cleared bindings", async () => {
  const key = "dbscout-shortcut-bindings";
  const store = new Map();
  globalThis.localStorage = {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => store.set(name, value),
  };
  const firstWindow = useShortcuts(fakeInvoke());
  await firstWindow.rebind("save", "Ctrl+Shift+K");

  // Another window updates its own binding after this window has loaded.
  store.set(key, JSON.stringify({ ...JSON.parse(store.get(key)), searchDatabase: "" }));
  await firstWindow.rebind("undo", "Ctrl+Shift+J");

  await firstWindow.rebind("openWindow", "");
  _resetSingletonForTests();
  const invoke = fakeInvoke();
  const refreshed = useShortcuts(invoke);
  assert.equal(refreshed.get("save"), "Ctrl+Shift+K");
  assert.equal(refreshed.get("undo"), "Ctrl+Shift+J");
  assert.equal(refreshed.get("searchDatabase"), "");
  assert.equal(refreshed.get("openWindow"), "");
  await refreshed.restoreGlobalBinding();
  assert.deepEqual(invoke.calls, [{ command: "unregister_global_shortcut", payload: undefined }]);
});

test("a storage write failure leaves the current binding in place and reports the error", async () => {
  const shortcuts = useShortcuts(fakeInvoke());
  globalThis.localStorage.setItem = () => { throw new Error("Storage is full"); };

  await assert.rejects(() => shortcuts.rebind("save", "Ctrl+Shift+K"), /Storage is full/);
  assert.equal(shortcuts.get("save"), DEFAULT_BINDINGS.save);
});

test("all useShortcuts callers share one reactive bindings instance (#1)", async () => {
  // The orchestrator and the settings dialog must observe the same state, so
  // rebinding in one is immediately visible to the other's keydown handler.
  const store = {};
  globalThis.localStorage = {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: () => {},
  };
  const orchestrator = useShortcuts(fakeInvoke());
  const dialog = useShortcuts(fakeInvoke());

  assert.equal(orchestrator.get("searchDatabase"), "Ctrl+P");
  await dialog.rebind("searchDatabase", "Ctrl+K");
  // The orchestrator's view updates live without a reload.
  assert.equal(orchestrator.get("searchDatabase"), "Ctrl+K");
  assert.equal(orchestrator.matchesBinding("searchDatabase", keyEvent("k", { ctrl: true })), true);
});

test("defaultBindingsFor gives macOS overrides without changing the Windows set", () => {
  const mac = defaultBindingsFor("macos");
  assert.equal(mac.replaceInTable, "Cmd+Alt+F");
  assert.equal(mac.openSqlQuery, "Cmd+T");
  assert.equal(mac.nextTab, "Cmd+Shift+]");
  assert.equal(mac.previousTab, "Cmd+Shift+[");
  // Everything else identical to the Windows defaults.
  for (const action of Object.keys(DEFAULT_BINDINGS)) {
    if (!(action in MACOS_DEFAULT_BINDINGS)) assert.equal(mac[action], DEFAULT_BINDINGS[action]);
  }
  const windows = defaultBindingsFor("windows");
  assert.deepEqual(windows, { ...DEFAULT_BINDINGS });
  assert.equal(defaultBindingsFor("windows").nextTab, "Ctrl+Tab");
});

test("migrateMacosDefaultBindings rewrites stored old defaults once", () => {
  const stored = {
    ...DEFAULT_BINDINGS,
    replaceInTable: "Ctrl+H",
    openSqlQuery: "Ctrl+Q",
    nextTab: "Ctrl+Tab",
    previousTab: "Ctrl+Shift+Tab",
    // A user-customized binding is left alone even though it is stored.
    searchTable: "Ctrl+K",
  };
  const { bindings, changed } = migrateMacosDefaultBindings(stored);
  assert.equal(changed, true);
  assert.equal(bindings.replaceInTable, "Cmd+Alt+F");
  assert.equal(bindings.openSqlQuery, "Cmd+T");
  assert.equal(bindings.nextTab, "Cmd+Shift+]");
  assert.equal(bindings.previousTab, "Cmd+Shift+[");
  assert.equal(bindings.searchTable, "Ctrl+K");
  // A second run finds no old defaults left and is a no-op.
  assert.equal(migrateMacosDefaultBindings(bindings).changed, false);
});

test("migrateMacosDefaultBindings keeps the old binding when the new combo is taken", () => {
  const stored = {
    ...DEFAULT_BINDINGS,
    searchTable: "Cmd+Alt+F", // user already claimed the new combo
  };
  const { bindings } = migrateMacosDefaultBindings(stored);
  assert.equal(bindings.replaceInTable, "Ctrl+H");
  assert.equal(bindings.searchTable, "Cmd+Alt+F");
  // The other three actions still migrate.
  assert.equal(bindings.openSqlQuery, "Cmd+T");
  assert.equal(bindings.nextTab, "Cmd+Shift+]");
});

test("matchesShortcutCombo falls back to event.code when modifiers rewrite event.key", () => {
  // macOS Option+F reports event.key "ƒ"; Shift+] reports "}".
  assert.equal(matchesShortcutCombo("Cmd+Alt+F", keyEvent("ƒ", { meta: true, alt: true, code: "KeyF" })), true);
  assert.equal(matchesShortcutCombo("Cmd+Shift+]", keyEvent("}", { meta: true, shift: true, code: "BracketRight" })), true);
  assert.equal(matchesShortcutCombo("Cmd+Shift+[", keyEvent("{", { meta: true, shift: true, code: "BracketLeft" })), true);
  assert.equal(matchesShortcutCombo("Cmd+`", keyEvent("~", { meta: true, shift: true, code: "Backquote" })), false); // extra Shift still rejected
  assert.equal(matchesShortcutCombo("Cmd+Alt+F", keyEvent("ƒ", { meta: true, code: "KeyF" })), false); // missing Alt
  // Without a modifier held the code fallback does not apply.
  assert.equal(matchesShortcutCombo("F", keyEvent("ƒ", { code: "KeyF" })), false);
});

test("matchesBinding records matched keydowns for the menu dedup gate", () => {
  _resetMenuShortcutDedupForTests();
  const { matchesBinding } = useShortcuts(fakeInvoke());
  assert.equal(isRecentShortcutKeydown("openWindow"), false);
  assert.equal(matchesBinding("openWindow", keyEvent("F", { shift: true, alt: true })), true);
  assert.equal(isRecentShortcutKeydown("openWindow"), true);
  // A non-matching keydown does not extend the window.
  noteShortcutKeydownMatch("pinWindow", -100000);
  assert.equal(matchesBinding("pinWindow", keyEvent("F9")), false);
  assert.equal(isRecentShortcutKeydown("pinWindow"), false);
});

test("singleton applies macOS defaults and migrates a stored Windows set once", () => {
  pinNavigator({ platform: "MacIntel" });
  const store = { "dbscout-shortcut-bindings": JSON.stringify({ ...DEFAULT_BINDINGS }) };
  globalThis.localStorage = {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: () => {},
  };
  const { get, matchesBinding } = useShortcuts(fakeInvoke());
  assert.equal(get("openSqlQuery"), "Cmd+T");
  assert.equal(get("replaceInTable"), "Cmd+Alt+F");
  assert.equal(get("nextTab"), "Cmd+Shift+]");
  assert.equal(get("previousTab"), "Cmd+Shift+[");
  assert.equal(store["dbscout-shortcut-bindings-mac-v1"], "1");
  // The persisted map was rewritten too.
  assert.equal(JSON.parse(store["dbscout-shortcut-bindings"]).openSqlQuery, "Cmd+T");
  // ⌘T matches via the code fallback (macOS turns ⌥ keys into "ƒ"-style chars).
  assert.equal(matchesBinding("openSqlQuery", keyEvent("t", { meta: true, code: "KeyT" })), true);
});

test("shortcutComboFromEvent records the physical key when Option is held on macOS", () => {
  pinNavigator({ platform: "MacIntel" });
  assert.equal(shortcutComboFromEvent(keyEvent("ƒ", { meta: true, alt: true, code: "KeyF" })), "Cmd+Alt+F");
  // Without Alt, event.key stays authoritative.
  assert.equal(shortcutComboFromEvent(keyEvent("}", { meta: true, shift: true, code: "BracketRight" })), "Cmd+Shift+}");
  pinNavigator({ platform: "Win32" });
  assert.equal(shortcutComboFromEvent(keyEvent("ƒ", { ctrl: true, alt: true, code: "KeyF" })), "Ctrl+Alt+Ƒ");
});

test("rebind reverts and throws when the backend rejects a global binding (#3)", async () => {
  const store = {};
  globalThis.localStorage = {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
  };
  const { get, rebind } = useShortcuts(failingInvoke("register_global_shortcut"));

  await assert.rejects(
    () => rebind("openWindow", "Ctrl+Alt+Del"),
    /系统已占用该快捷键/,
  );
  // Reverted to the previous (default) value — UI must not show the bad combo.
  assert.equal(get("openWindow"), DEFAULT_BINDINGS.openWindow);
});
