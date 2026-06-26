import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { useShortcuts, DEFAULT_BINDINGS, _resetSingletonForTests } from "./composables/useShortcuts.js";

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

function keyEvent(key, { ctrl = false, shift = false, alt = false, meta = false } = {}) {
  return { key, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta };
}

beforeEach(() => {
  // Each test starts from a clean singleton + empty storage.
  _resetSingletonForTests();
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
});

test("useShortcuts exposes the default bindings", () => {
  const { get } = useShortcuts(fakeInvoke());
  assert.equal(get("openWindow"), "Shift+F");
  assert.equal(get("searchDatabase"), "Ctrl+P");
});

test("matchesBinding compares modifier+key case-insensitively and treats Ctrl/Cmd alike", () => {
  const { matchesBinding } = useShortcuts(fakeInvoke());
  assert.equal(matchesBinding("searchDatabase", keyEvent("p", { ctrl: true })), true);
  assert.equal(matchesBinding("searchDatabase", keyEvent("P", { ctrl: true })), true);
  // Cmd counts as the Ctrl modifier.
  assert.equal(matchesBinding("searchDatabase", keyEvent("p", { meta: true })), true);
  assert.equal(matchesBinding("openWindow", keyEvent("F", { shift: true })), true);
  assert.equal(matchesBinding("openWindow", keyEvent("F")), false);
  assert.equal(matchesBinding("openWindow", keyEvent("F", { shift: true, ctrl: true })), false);
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
