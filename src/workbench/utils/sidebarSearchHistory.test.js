import test from "node:test";
import assert from "node:assert/strict";

import {
  SIDEBAR_SEARCH_HISTORY_LIMIT,
  buildSidebarSearchHistoryScope,
  clearSidebarSearchHistory,
  readSidebarSearchHistory,
  recordSidebarSearchHistory,
  removeSidebarSearchHistoryEntry,
} from "./sidebarSearchHistory.js";

function createStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
  };
}

test("buildSidebarSearchHistoryScope requires connection and database", () => {
  assert.equal(buildSidebarSearchHistoryScope("conn-1", "game_db"), "conn-1\u001fgame_db");
  assert.equal(buildSidebarSearchHistoryScope("", "game_db"), "");
});

test("recordSidebarSearchHistory deduplicates, prepends, and caps at ten entries", () => {
  const storage = createStorage();
  const scope = buildSidebarSearchHistoryScope("conn-1", "game_db");

  recordSidebarSearchHistory(storage, scope, "goodsprop");
  recordSidebarSearchHistory(storage, scope, "status");
  recordSidebarSearchHistory(storage, scope, "copy");
  recordSidebarSearchHistory(storage, scope, "goodsprop");

  const history = readSidebarSearchHistory(storage, scope);
  assert.deepEqual(history.map((entry) => entry.query), ["goodsprop", "copy", "status"]);

  for (let index = 0; index < 12; index += 1) {
    recordSidebarSearchHistory(storage, scope, `query-${index}`);
  }

  const capped = readSidebarSearchHistory(storage, scope);
  assert.equal(capped.length, SIDEBAR_SEARCH_HISTORY_LIMIT);
  assert.equal(capped[0].query, "query-11");
  assert.equal(capped[9].query, "query-2");
});

test("remove and clear sidebar search history stay scoped", () => {
  const storage = createStorage();
  const scopeA = buildSidebarSearchHistoryScope("conn-1", "game_db");
  const scopeB = buildSidebarSearchHistoryScope("conn-2", "analytics");

  recordSidebarSearchHistory(storage, scopeA, "alpha");
  recordSidebarSearchHistory(storage, scopeA, "beta");
  recordSidebarSearchHistory(storage, scopeB, "gamma");

  removeSidebarSearchHistoryEntry(storage, scopeA, "alpha");
  assert.deepEqual(readSidebarSearchHistory(storage, scopeA).map((entry) => entry.query), ["beta"]);
  assert.deepEqual(readSidebarSearchHistory(storage, scopeB).map((entry) => entry.query), ["gamma"]);

  clearSidebarSearchHistory(storage, scopeA);
  assert.deepEqual(readSidebarSearchHistory(storage, scopeA), []);
  assert.deepEqual(readSidebarSearchHistory(storage, scopeB).map((entry) => entry.query), ["gamma"]);
});