import test from "node:test";
import assert from "node:assert/strict";

import {
  beginValueSearch,
  buildVisibleSidebarSearchItems,
  clearValueSearchResults,
  createSidebarSearchState,
  finishValueSearch,
  moveSidebarSearchSelection,
  setSidebarSearchQuery,
  sidebarValueResultsAreFresh,
} from "./sidebarSearchState.js";

test("setSidebarSearchQuery clears previous value results when the query changes", () => {
  const state = createSidebarSearchState();
  state.query = "alice";
  finishValueSearch(state, "alice", [{ tableName: "player" }]);

  setSidebarSearchQuery(state, "bob");

  assert.equal(state.query, "bob");
  assert.deepEqual(state.valueResults, []);
  assert.equal(state.valueSearchedQuery, "");
  assert.equal(state.selectedIndex, 0);
});

test("beginValueSearch and finishValueSearch track fresh value results", () => {
  const state = createSidebarSearchState();

  const token = beginValueSearch(state, "alice");
  finishValueSearch(state, "alice", [{ tableName: "player" }], token);

  assert.equal(state.valueLoading, false);
  assert.equal(state.valueError, "");
  assert.equal(sidebarValueResultsAreFresh(state), true);
  assert.equal(state.valueResults.length, 1);
});

test("finishValueSearch ignores late results after the query changes", () => {
  const state = createSidebarSearchState();

  const token = beginValueSearch(state, "alice");
  setSidebarSearchQuery(state, "bob");
  const finished = finishValueSearch(state, "alice", [{ tableName: "player" }], token);

  assert.equal(finished, false);
  assert.deepEqual(state.valueResults, []);
  assert.equal(state.valueSearchedQuery, "");
});

test("clearValueSearchResults removes stale value result state", () => {
  const state = createSidebarSearchState();
  finishValueSearch(state, "alice", [{ tableName: "player" }]);

  clearValueSearchResults(state);

  assert.deepEqual(state.valueResults, []);
  assert.equal(state.valueSearchedQuery, "");
  assert.equal(state.valueError, "");
});

test("keyboard selection moves through grouped visible result items", () => {
  const state = createSidebarSearchState();
  state.query = "player";
  const schemaResults = [{ key: "schema:player", table: { tableName: "player" } }];
  finishValueSearch(state, "player", [{ tableName: "player", columnName: "nickname" }]);
  const items = buildVisibleSidebarSearchItems(schemaResults, state.valueResults);

  moveSidebarSearchSelection(state, items, 1);
  assert.equal(state.selectedIndex, 1);

  moveSidebarSearchSelection(state, items, 1);
  assert.equal(state.selectedIndex, 0);

  moveSidebarSearchSelection(state, items, -1);
  assert.equal(state.selectedIndex, 1);
});

test("keyboard movement marks the sidebar result selection as explicit", () => {
  const state = createSidebarSearchState();
  const items = [
    { key: "schema:player", kind: "schema", result: { tableName: "player" } },
    { key: "schema:hero", kind: "schema", result: { tableName: "hero" } },
  ];

  assert.equal(state.selectionTouched, false);

  moveSidebarSearchSelection(state, items, 1);

  assert.equal(state.selectedIndex, 1);
  assert.equal(state.selectionTouched, true);

  setSidebarSearchQuery(state, "new-query");

  assert.equal(state.selectionTouched, false);
});
