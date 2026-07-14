import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";

import {
  createHomepageTypeahead,
  findHomepageTypeaheadMatch,
  isHomepageTypeaheadKey,
} from "./composables/useHomepageTypeahead.js";

const tables = [
  { tableName: "player_archive" },
  { tableName: "player" },
  { tableName: "audit_log" },
];

function keyboardEvent(key, options = {}) {
  return {
    key,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...options,
  };
}

test("homepage typeahead prioritizes exact, prefix, then partial table-name matches", () => {
  assert.equal(findHomepageTypeaheadMatch(tables, "player")?.tableName, "player");
  assert.equal(findHomepageTypeaheadMatch(tables, "play")?.tableName, "player_archive");
  assert.equal(findHomepageTypeaheadMatch(tables, "log")?.tableName, "audit_log");
  assert.equal(findHomepageTypeaheadMatch(tables, "missing"), null);
});

test("homepage typeahead uses ordered fuzzy table-name matching", () => {
  const fuzzyTables = [
    { tableName: "doogsprop" },
    { tableName: "goodsprop" },
  ];

  assert.equal(findHomepageTypeaheadMatch(fuzzyTables, "gdp")?.tableName, "goodsprop");
});

test("homepage typeahead exposes fuzzy match ranges for result highlighting", () => {
  const typeahead = createHomepageTypeahead({
    tables: [
      { tableName: "doogsprop" },
      { tableName: "goodsprop" },
    ],
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  typeahead.handleKeydown(keyboardEvent("g"));
  typeahead.handleKeydown(keyboardEvent("d"));
  typeahead.handleKeydown(keyboardEvent("p"));

  assert.equal(typeahead.matchedTableName.value, "goodsprop");
  assert.deepEqual(typeahead.matchRanges.value, [
    { start: 0, end: 1 },
    { start: 3, end: 4 },
    { start: 5, end: 6 },
  ]);
});

test("homepage typeahead selects while typing and opens the current match with Enter", () => {
  const matches = [];
  const opened = [];
  const typeahead = createHomepageTypeahead({
    tables: ref(tables),
    onMatch: (table) => matches.push(table.tableName),
    onOpen: (table) => opened.push(table.tableName),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  const first = keyboardEvent("p");
  const second = keyboardEvent("l");
  assert.equal(typeahead.handleKeydown(first), true);
  assert.equal(typeahead.handleKeydown(second), true);
  assert.equal(first.prevented, true);
  assert.equal(typeahead.query.value, "pl");
  assert.equal(typeahead.matchedTableName.value, "player_archive");
  assert.deepEqual(matches, ["player_archive", "player_archive"]);

  typeahead.handleKeydown(keyboardEvent("Enter"));
  assert.deepEqual(opened, ["player_archive"]);
  assert.equal(typeahead.active.value, false);
});

test("homepage typeahead supports correction, no-match state, escape, and timeout cleanup", () => {
  let timeoutCallback = null;
  const typeahead = createHomepageTypeahead({
    tables,
    setTimeoutFn: (callback) => {
      timeoutCallback = callback;
      return 1;
    },
    clearTimeoutFn: () => {},
  });

  typeahead.handleKeydown(keyboardEvent("z"));
  assert.equal(typeahead.match.value, null);
  typeahead.handleKeydown(keyboardEvent("Backspace"));
  assert.equal(typeahead.active.value, false);

  typeahead.handleKeydown(keyboardEvent("a"));
  typeahead.handleKeydown(keyboardEvent("Escape"));
  assert.equal(typeahead.active.value, false);

  typeahead.handleKeydown(keyboardEvent("p"));
  timeoutCallback();
  assert.equal(typeahead.query.value, "");
  assert.equal(typeahead.match.value, null);
});

test("homepage typeahead ignores modified, composing, and leading whitespace keys", () => {
  assert.equal(isHomepageTypeaheadKey(keyboardEvent("p", { ctrlKey: true }), false), false);
  assert.equal(isHomepageTypeaheadKey(keyboardEvent("Process", { isComposing: true }), false), false);
  assert.equal(isHomepageTypeaheadKey(keyboardEvent(" "), false), false);
  assert.equal(isHomepageTypeaheadKey(keyboardEvent("Backspace"), false), false);
  assert.equal(isHomepageTypeaheadKey(keyboardEvent("p"), false), true);
});
