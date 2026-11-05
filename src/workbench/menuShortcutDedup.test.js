import test from "node:test";
import assert from "node:assert/strict";

import {
  isRecentShortcutKeydown,
  noteShortcutKeydownMatch,
  _resetMenuShortcutDedupForTests,
} from "./utils/menuShortcutDedup.js";

test("menu dedup window covers a keydown recorded within 300 ms", () => {
  _resetMenuShortcutDedupForTests();
  noteShortcutKeydownMatch("openSqlQuery", 1000);
  assert.equal(isRecentShortcutKeydown("openSqlQuery", 1000), true);
  assert.equal(isRecentShortcutKeydown("openSqlQuery", 1299), true);
  assert.equal(isRecentShortcutKeydown("openSqlQuery", 1300), false);
  // A different action is unaffected.
  assert.equal(isRecentShortcutKeydown("closeTab", 1001), false);
  // A later keydown re-arms the window.
  noteShortcutKeydownMatch("openSqlQuery", 5000);
  assert.equal(isRecentShortcutKeydown("openSqlQuery", 5100), true);
});
