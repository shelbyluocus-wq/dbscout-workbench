import test from "node:test";
import assert from "node:assert/strict";

import {
  assignTabShortcutHints,
  isReservedTabShortcutCombo,
  isTabShortcutEvent,
} from "./utils/tabShortcutHints.js";

test("only published home tabs display a shortcut hint", () => {
  assert.deepEqual(assignTabShortcutHints([
    { id: "orders", kind: "data" },
    { id: "home", kind: "home" },
    { id: "opening-home", kind: "home", opening: true },
    { id: "sql", kind: "sql" },
    { id: "design", kind: "design" },
  ]), [{ tabId: "home", combo: "Ctrl+`", code: "Backquote" }]);
});

test("the home shortcut uses physical Backquote and the platform modifier", () => {
  const home = { code: "Backquote", key: "·" };
  assert.equal(isTabShortcutEvent({ ...home, ctrlKey: true }, "windows"), true);
  assert.equal(isTabShortcutEvent({ ...home, metaKey: true }, "windows"), true);
  assert.equal(isTabShortcutEvent({ ...home, metaKey: true }, "macos"), true);
  assert.equal(isTabShortcutEvent({ ...home, ctrlKey: true }, "macos"), false);
  assert.equal(isTabShortcutEvent({ ...home, ctrlKey: true, metaKey: true }, "macos"), false);
  assert.equal(isTabShortcutEvent(home, "macos"), false);
  for (const flag of ["shiftKey", "altKey", "isComposing"]) {
    assert.equal(isTabShortcutEvent({ ...home, metaKey: true, [flag]: true }, "macos"), false);
  }
});

test("number shortcuts no longer navigate tabs or conflict with favorite databases", () => {
  for (let digit = 0; digit <= 9; digit++) {
    for (const code of [`Digit${digit}`, `Numpad${digit}`]) {
      assert.equal(isTabShortcutEvent({ code, ctrlKey: true }, "windows"), false);
      assert.equal(isTabShortcutEvent({ code, metaKey: true }, "macos"), false);
    }
    assert.equal(isReservedTabShortcutCombo(`Ctrl+${digit}`), false);
    assert.equal(isReservedTabShortcutCombo(`Cmd+${digit}`), false);
  }
  assert.equal(isReservedTabShortcutCombo("Ctrl+`"), true);
  assert.equal(isReservedTabShortcutCombo("Cmd+Backquote"), true);
  assert.equal(isReservedTabShortcutCombo("Ctrl+Shift+Backquote"), false);
});
