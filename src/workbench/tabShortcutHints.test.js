import test from "node:test";
import assert from "node:assert/strict";

import {
  assignTabShortcutHints,
  isReservedTabShortcutCombo,
  isTabShortcutEvent,
  resolveTabShortcutEvent,
} from "./utils/tabShortcutHints.js";

function hintEvent(code, {
  key = "",
  ctrl = true,
  meta = false,
  shift = false,
  alt = false,
  composing = false,
} = {}) {
  return {
    code,
    key,
    ctrlKey: ctrl,
    metaKey: meta,
    shiftKey: shift,
    altKey: alt,
    isComposing: composing,
  };
}

const tabs = [
  { id: "orders", kind: "data" },
  { id: "home", kind: "home" },
  { id: "opening", kind: "data", opening: true },
  { id: "sql", kind: "sql" },
  { id: "design", kind: "design" },
];

test("assignTabShortcutHints pins home first and numbers the remaining published tabs", () => {
  assert.deepEqual(assignTabShortcutHints(tabs), [
    { tabId: "home", combo: "Ctrl+`", code: "Backquote" },
    { tabId: "orders", combo: "Ctrl+1", code: "Digit1" },
    { tabId: "sql", combo: "Ctrl+2", code: "Digit2" },
    { tabId: "design", combo: "Ctrl+3", code: "Digit3" },
  ]);
});

test("assignTabShortcutHints skips opening tabs and stops after nine numbered tabs", () => {
  const many = [
    { id: "home", kind: "home" },
    ...Array.from({ length: 11 }, (_, index) => ({ id: `tab-${index + 1}`, kind: "data" })),
  ];
  const hints = assignTabShortcutHints(many);
  assert.equal(hints[0].combo, "Ctrl+`");
  assert.equal(hints.at(-1).combo, "Ctrl+9");
  assert.equal(hints.length, 10);
  assert.equal(hints.some((hint) => hint.tabId === "tab-10"), false);
});

test("Windows tab shortcuts accept physical Backquote and Digit keys with Ctrl or Command", () => {
  assert.equal(isTabShortcutEvent(hintEvent("Backquote", { key: "·" }), "windows"), true);
  assert.equal(isTabShortcutEvent(hintEvent("Digit2", { key: "2" }), "windows"), true);
  assert.equal(isTabShortcutEvent(hintEvent("Digit2", { key: "2", ctrl: false, meta: true }), "windows"), true);
  assert.equal(isTabShortcutEvent(hintEvent("Digit2", { key: "2", shift: true }), "windows"), false);
  assert.equal(isTabShortcutEvent(hintEvent("Digit2", { key: "2", alt: true }), "windows"), false);
  assert.equal(isTabShortcutEvent(hintEvent("Numpad1", { key: "1" }), "windows"), false);
  assert.equal(isTabShortcutEvent(hintEvent("Backquote", { key: "`", composing: true }), "windows"), false);
});

test("resolveTabShortcutEvent maps Backquote to home even when event.key is not a backtick", () => {
  const home = resolveTabShortcutEvent(hintEvent("Backquote", { key: "·" }), tabs, "windows");
  assert.equal(home?.tabId, "home");
  assert.equal(home?.combo, "Ctrl+`");

  const second = resolveTabShortcutEvent(hintEvent("Digit2", { key: "2" }), tabs, "windows");
  assert.equal(second?.tabId, "sql");

  assert.equal(resolveTabShortcutEvent(hintEvent("Digit8", { key: "8" }), tabs, "windows"), null);
  assert.equal(resolveTabShortcutEvent(hintEvent("Numpad1", { key: "1" }), tabs, "windows"), null);
});

test("macOS tab shortcuts require Command and reject physical Control", () => {
  const numberedTabs = Array.from({ length: 9 }, (_, index) => ({ id: `tab-${index + 1}`, kind: "data" }));
  for (const code of ["Backquote", ...numberedTabs.map((_, index) => `Digit${index + 1}`)]) {
    const commandEvent = hintEvent(code, { ctrl: false, meta: true });
    assert.equal(isTabShortcutEvent(commandEvent, "macos"), true);
    assert.ok(resolveTabShortcutEvent(commandEvent, numberedTabs, "macos"));
    for (const meta of [false, true]) {
      const controlEvent = hintEvent(code, { ctrl: true, meta });
      assert.equal(isTabShortcutEvent(controlEvent, "macos"), false);
      assert.equal(resolveTabShortcutEvent(controlEvent, numberedTabs, "macos"), null);
    }
    assert.equal(isTabShortcutEvent(hintEvent(code), "windows"), true);
    assert.equal(isTabShortcutEvent(hintEvent(code, { ctrl: false }), "macos"), false);
    assert.equal(isTabShortcutEvent({ ...commandEvent, shiftKey: true }, "macos"), false);
    assert.equal(isTabShortcutEvent({ ...commandEvent, altKey: true }, "macos"), false);
  }
});

test("resolveTabShortcutEvent still names the home action when no home tab is open", () => {
  const result = resolveTabShortcutEvent(hintEvent("Backquote", { key: "`" }), [
    { id: "orders", kind: "data" },
  ], "windows");
  assert.deepEqual(result, { tabId: "", combo: "Ctrl+`", code: "Backquote" });
});

test("isReservedTabShortcutCombo blocks tab-switch combos from favorite databases", () => {
  assert.equal(isReservedTabShortcutCombo("Ctrl+1"), true);
  assert.equal(isReservedTabShortcutCombo("Cmd+9"), true);
  assert.equal(isReservedTabShortcutCombo("Ctrl+`"), true);
  assert.equal(isReservedTabShortcutCombo("Ctrl+Backquote"), true);
  assert.equal(isReservedTabShortcutCombo("Ctrl+Shift+1"), false);
  assert.equal(isReservedTabShortcutCombo("Alt+1"), false);
  assert.equal(isReservedTabShortcutCombo("Ctrl+0"), false);
});
