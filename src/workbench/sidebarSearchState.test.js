import test from "node:test";
import assert from "node:assert/strict";

import {
  beginValueSearch,
  buildVisibleSidebarSearchItems,
  cancelValueSearch,
  clearValueSearchResults,
  createSidebarSearchState,
  finishValueSearch,
  moveSidebarSearchSelection,
  setSidebarSearchQuery,
  sidebarValueResultsAreFresh,
  updateValueSearchProgress,
  valueSearchProgressPercent,
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

  const token = beginValueSearch(state, "alice", "job-1");
  updateValueSearchProgress(state, {
    jobId: "job-1",
    done: 3,
    total: 12,
    matches: 1,
    currentTable: "player",
    status: "running",
  });
  finishValueSearch(state, "alice", [{ tableName: "player" }], token);

  assert.equal(state.valueLoading, false);
  assert.equal(state.valueError, "");
  assert.equal(sidebarValueResultsAreFresh(state), true);
  assert.equal(state.valueResults.length, 1);
  assert.equal(state.valueProgress.status, "completed");
  assert.equal(state.valueProgress.matches, 1);
});

test("value search progress only updates the active job", () => {
  const state = createSidebarSearchState();
  beginValueSearch(state, "alice", "job-active");

  assert.equal(
    updateValueSearchProgress(state, {
      jobId: "job-stale",
      done: 7,
      total: 10,
      matches: 4,
      currentTable: "stale_table",
    }),
    false,
  );
  assert.equal(state.valueProgress.done, 0);

  assert.equal(
    updateValueSearchProgress(state, {
      jobId: "job-active",
      done: 4,
      total: 10,
      matches: 2,
      currentTable: "player",
      message: "Scanning player",
    }),
    true,
  );

  assert.equal(state.valueProgress.done, 4);
  assert.equal(state.valueProgress.total, 10);
  assert.equal(state.valueProgress.matches, 2);
  assert.equal(state.valueProgress.currentTable, "player");
  assert.equal(valueSearchProgressPercent(state), 40);
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

test("cancelValueSearch stops an in-flight value search and ignores late results", () => {
  const state = createSidebarSearchState();
  const token = beginValueSearch(state, "alice", "job-1");

  assert.equal(cancelValueSearch(state), true);
  assert.equal(state.valueLoading, false);
  assert.equal(state.valueSearchJobId, "");
  assert.equal(finishValueSearch(state, "alice", [{ tableName: "player" }], token), false);
  assert.deepEqual(state.valueResults, []);

  assert.equal(cancelValueSearch(state), false);
});

test("cancelValueSearch ignores stale progress updates after cancellation", () => {
  const state = createSidebarSearchState();
  beginValueSearch(state, "alice", "job-1");
  cancelValueSearch(state);

  assert.equal(
    updateValueSearchProgress(state, {
      jobId: "job-1",
      done: 4,
      total: 10,
      matches: 2,
      currentTable: "player",
      status: "running",
    }),
    false,
  );
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
