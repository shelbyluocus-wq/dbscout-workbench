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

test("isTabShortcutEvent accepts physical Backquote and Digit keys with Ctrl or Command", () => {
  assert.equal(isTabShortcutEvent(hintEvent("Backquote", { key: "·" })), true);
  assert.equal(isTabShortcutEvent(hintEvent("Digit2", { key: "2" })), true);
  assert.equal(isTabShortcutEvent(hintEvent("Digit2", { key: "2", ctrl: false, meta: true })), true);
  assert.equal(isTabShortcutEvent(hintEvent("Digit2", { key: "2", shift: true })), false);
  assert.equal(isTabShortcutEvent(hintEvent("Digit2", { key: "2", alt: true })), false);
  assert.equal(isTabShortcutEvent(hintEvent("Numpad1", { key: "1" })), false);
  assert.equal(isTabShortcutEvent(hintEvent("Backquote", { key: "`", composing: true })), false);
});

test("resolveTabShortcutEvent maps Backquote to home even when event.key is not a backtick", () => {
  const home = resolveTabShortcutEvent(hintEvent("Backquote", { key: "·" }), tabs);
  assert.equal(home?.tabId, "home");
  assert.equal(home?.combo, "Ctrl+`");

  const second = resolveTabShortcutEvent(hintEvent("Digit2", { key: "2" }), tabs);
  assert.equal(second?.tabId, "sql");

  assert.equal(resolveTabShortcutEvent(hintEvent("Digit8", { key: "8" }), tabs), null);
  assert.equal(resolveTabShortcutEvent(hintEvent("Numpad1", { key: "1" }), tabs), null);
});

test("resolveTabShortcutEvent still names the home action when no home tab is open", () => {
  const result = resolveTabShortcutEvent(hintEvent("Backquote", { key: "`" }), [
    { id: "orders", kind: "data" },
  ]);
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
