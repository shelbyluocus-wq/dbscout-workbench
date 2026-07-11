import test from "node:test";
import assert from "node:assert/strict";
import { computed, ref } from "vue";

import { cellMatchesSearch, findSearchMatches, useTableSearch } from "./composables/useTableSearch.js";
import { createEditState, startCellCommit } from "./editState.js";

function makeTab() {
  return {
    id: "tab-1",
    tableName: "hero",
    sessionId: "session-1",
    rows: [
      { id: "1", name: "Alpha", note: "first" },
      { id: "2", name: "Beta", note: "Needle value" },
    ],
    columns: [{ column_name: "id" }, { column_name: "name" }, { column_name: "note" }],
    primaryKeys: ["id"],
    filter: "",
    searchQuery: "",
    filterMode: "fuzzy",
    totalRows: 2,
    fullyLoaded: true,
    searchResultMode: false,
    searchResultComplete: true,
    searchResultMatches: [],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function manualScheduler() {
  let nextId = 0;
  const callbacks = new Map();
  return {
    schedule(callback, delay) {
      const id = ++nextId;
      callbacks.set(id, { callback, delay });
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
    delays() {
      return [...callbacks.values()].map((entry) => entry.delay);
    },
    flushLatest() {
      const latest = [...callbacks.entries()].at(-1);
      if (!latest) return false;
      callbacks.delete(latest[0]);
      latest[1].callback();
      return true;
    },
    size() {
      return callbacks.size;
    },
  };
}

function backendPage(tab, {
  rows = [{ id: "9", name: "Remote", note: "Needle remote" }],
  matches = [{ rowIndex: 0, sourceRowIndex: 8, columnIndex: 2, columnName: "note", kind: "contains", rank: 2, score: 0, ranges: [{ start: 0, end: 6 }] }],
  complete = false,
  jobId = "job-1",
} = {}) {
  tab.rows = rows;
  tab.searchResultMode = true;
  tab.searchResultQuery = tab.searchQuery || tab.filter;
  tab.searchResultJobId = jobId;
  tab.searchResultMatches = matches;
  tab.searchResultComplete = complete;
  tab.fullyLoaded = complete;
  return { ok: true, jobId, complete };
}

function createSearch(tab, overrides = {}) {
  const scheduler = overrides.scheduler || manualScheduler();
  const selected = overrides.selected || [];
  const loadSearchResultPage = overrides.loadSearchResultPage || (async (targetTab) => backendPage(targetTab));
  const searched = useTableSearch(overrides.activeTab || computed(() => tab), {
    editState: overrides.editState || {},
    loadNextPage: overrides.loadNextPage || (() => {
      throw new Error("ordinary table paging must not be used by table search");
    }),
    loadSearchResultPage,
    loadNextSearchResultPage: overrides.loadNextSearchResultPage || (async () => ({ ok: false })),
    cancelSearchResultPage: overrides.cancelSearchResultPage || (async () => false),
    selectCellAt: overrides.selectCellAt || ((targetTab, rowIndex, columnIndex) => {
      selected.push({ targetTab, rowIndex, columnIndex });
    }),
    statusText: overrides.statusText || ref(""),
    isEditing: overrides.isEditing || (() => false),
    getSelectedPosition: overrides.getSelectedPosition || (() => null),
    searchDebounceMs: 150,
    scheduleSearch: scheduler.schedule.bind(scheduler),
    cancelScheduledSearch: scheduler.cancel.bind(scheduler),
  });
  return { searched, scheduler, selected };
}

test("cellMatchesSearch supports fuzzy and exact modes", () => {
  assert.equal(cellMatchesSearch("Needle value", "needle", "fuzzy"), true);
  assert.equal(cellMatchesSearch("HeroProp", "hrp", "fuzzy"), true);
  assert.equal(cellMatchesSearch("Needle value", "needle", "exact"), false);
  assert.equal(cellMatchesSearch("Needle value", "Needle value", "exact"), true);
});

test("findSearchMatches caches unchanged rows and scans only appended rows", () => {
  const tab = makeTab();
  let displayCalls = 0;
  const displayCellValue = (_edit, _tab, row, column) => {
    displayCalls += 1;
    return row[column];
  };

  const first = findSearchMatches({}, tab, { query: "needle", displayCellValue });
  const second = findSearchMatches({}, tab, { query: "needle", displayCellValue });
  tab.rows.push({ id: "3", name: "Gamma", note: "Needle later" });
  const appended = findSearchMatches({}, tab, { query: "needle", displayCellValue });

  assert.deepEqual(first, [{ rowIndex: 1, columnIndex: 2 }]);
  assert.deepEqual(second, first);
  assert.deepEqual(appended, [
    { rowIndex: 1, columnIndex: 2 },
    { rowIndex: 2, columnIndex: 2 },
  ]);
  assert.equal(displayCalls, 9);
});

test("findSearchMatches resets replaced rows and invalidates optimistic edits", () => {
  const tab = makeTab();
  const editState = createEditState();
  findSearchMatches(editState, tab, { query: "changed" });
  tab.rows = [{ id: "1", name: "Alpha", note: "first" }];
  startCellCommit(editState, {
    tableName: "hero",
    rowKey: "id=1",
    columnName: "note",
    oldValue: "first",
    newValue: "Changed value",
  });

  assert.deepEqual(findSearchMatches(editState, tab, { query: "changed" }), [
    { rowIndex: 0, columnIndex: 2 },
  ]);
});

test("runTableSearch debounces input before starting one backend search page", async () => {
  const tab = makeTab();
  const calls = [];
  const { searched, scheduler } = createSearch(tab, {
    loadSearchResultPage: async (targetTab, query) => {
      calls.push(query);
      return backendPage(targetTab, { complete: true });
    },
  });

  const pending = searched.runTableSearch("needle");

  assert.deepEqual(calls, []);
  assert.equal(tab.filter, "");
  assert.equal(tab.searchQuery, "");
  assert.deepEqual(scheduler.delays(), [150]);
  scheduler.flushLatest();
  await pending;
  assert.deepEqual(calls, ["needle"]);
  assert.equal(tab.filter, "needle");
  assert.equal(tab.searchQuery, "needle");
});

test("rapid typing cancels the prior search and only applies the latest query", async () => {
  const tab = makeTab();
  const calls = [];
  const cancellations = [];
  const { searched, scheduler } = createSearch(tab, {
    loadSearchResultPage: async (targetTab, query) => {
      calls.push(query);
      return backendPage(targetTab, { jobId: `job-${query}`, complete: true });
    },
    cancelSearchResultPage: async (targetTab) => cancellations.push(targetTab.searchResultJobId || "pending"),
  });

  const oldSearch = searched.runTableSearch("old");
  const newSearch = searched.runTableSearch("new");

  assert.equal(scheduler.size(), 1);
  scheduler.flushLatest();
  await Promise.all([oldSearch, newSearch]);
  assert.deepEqual(calls, ["new"]);
  assert.deepEqual(cancellations, ["pending"]);
  assert.equal(tab.searchQuery, "new");
});

test("backend cell metadata drives selection without rescanning the ordinary table", async () => {
  const tab = makeTab();
  const { searched, scheduler, selected } = createSearch(tab);

  const pending = searched.runTableSearch("needle");
  scheduler.flushLatest();
  await pending;

  assert.deepEqual(searched.searchMatches.value, [{ rowIndex: 0, columnIndex: 2 }]);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 0, columnIndex: 2 }]);
  assert.deepEqual(searched.searchHitSummary.value, { current: 1, total: 1, label: "1/1+" });
});

test("search preserves a matching selected cell and never moves selection while editing", async () => {
  const tab = makeTab();
  const selected = [];
  const { searched, scheduler } = createSearch(tab, {
    selected,
    getSelectedPosition: () => ({ rowIndex: 0, columnIndex: 2, rowKey: "id=9" }),
    isEditing: () => true,
  });

  const pending = searched.runTableSearch("needle");
  scheduler.flushLatest();
  await pending;

  assert.deepEqual(selected, []);
  assert.equal(searched.searchHitSummary.value.current, 1);
});

test("next navigation requests another result page instead of loading ordinary rows", async () => {
  const tab = makeTab();
  const selected = [];
  let nextCalls = 0;
  const { searched, scheduler } = createSearch(tab, {
    selected,
    loadNextSearchResultPage: async (targetTab) => {
      nextCalls += 1;
      targetTab.rows.push({ id: "10", name: "Later", note: "Needle later" });
      targetTab.searchResultMatches = [
        ...targetTab.searchResultMatches,
        { rowIndex: 1, sourceRowIndex: 9, columnIndex: 2, columnName: "note", kind: "contains", rank: 2, score: 0, ranges: [{ start: 0, end: 6 }] },
      ];
      targetTab.searchResultComplete = true;
      targetTab.fullyLoaded = true;
      return { ok: true, complete: true };
    },
  });
  const pending = searched.runTableSearch("needle");
  scheduler.flushLatest();
  await pending;

  await searched.goToNextSearchMatch();

  assert.equal(nextCalls, 1);
  assert.deepEqual(selected.map(({ rowIndex, columnIndex }) => ({ rowIndex, columnIndex })), [
    { rowIndex: 0, columnIndex: 2 },
    { rowIndex: 1, columnIndex: 2 },
  ]);
});

test("previous navigation scans remaining result pages before wrapping to the true last hit", async () => {
  const tab = makeTab();
  const selected = [];
  let nextCalls = 0;
  const { searched, scheduler } = createSearch(tab, {
    selected,
    loadNextSearchResultPage: async (targetTab) => {
      nextCalls += 1;
      targetTab.rows = [{ id: "99", name: "Last", note: "Needle final" }];
      targetTab.searchResultMatches = [
        { rowIndex: 0, sourceRowIndex: 98, columnIndex: 2, columnName: "note", kind: "contains", rank: 2, score: 0, ranges: [{ start: 0, end: 6 }] },
      ];
      targetTab.searchResultComplete = true;
      targetTab.fullyLoaded = true;
      return { ok: true, complete: true };
    },
  });
  const pending = searched.runTableSearch("needle");
  scheduler.flushLatest();
  await pending;

  await searched.goToPreviousSearchMatch();

  assert.equal(nextCalls, 1);
  assert.deepEqual(selected.at(-1), { targetTab: tab, rowIndex: 0, columnIndex: 2 });
});

test("clearing search cancels the job, restores the original selection, and hides navigation", async () => {
  const tab = makeTab();
  const selected = [];
  const cancellations = [];
  const scheduler = manualScheduler();
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: () => {
      throw new Error("ordinary paging is forbidden");
    },
    loadSearchResultPage: async (targetTab, query) => {
      if (query) return backendPage(targetTab);
      targetTab.rows = [
        { id: "1", name: "Alpha", note: "first" },
        { id: "2", name: "Beta", note: "Needle value" },
      ];
      targetTab.searchResultMode = false;
      targetTab.searchResultMatches = [];
      targetTab.searchResultComplete = true;
      return { ok: true, restored: true };
    },
    loadNextSearchResultPage: async () => ({ ok: false }),
    cancelSearchResultPage: async (targetTab) => cancellations.push(targetTab.searchResultJobId),
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    getSelectedPosition: () => ({ rowIndex: 1, columnIndex: 2, rowKey: "id=2" }),
    statusText: ref(""),
    searchDebounceMs: 150,
    scheduleSearch: scheduler.schedule.bind(scheduler),
    cancelScheduledSearch: scheduler.cancel.bind(scheduler),
  });
  const pending = searched.runTableSearch("needle");
  scheduler.flushLatest();
  await pending;

  await searched.runTableSearch("");

  assert.deepEqual(cancellations, ["job-1"]);
  assert.equal(tab.searchResultMode, false);
  assert.equal(searched.hasSearchMatches.value, false);
  assert.deepEqual(selected.at(-1), { targetTab: tab, rowIndex: 1, columnIndex: 2 });
});

test("a stale backend response cannot select cells after the active tab changes", async () => {
  const firstTab = makeTab();
  const secondTab = { ...makeTab(), id: "tab-2", sessionId: "session-2" };
  const activeTab = ref(firstTab);
  const gate = deferred();
  const selected = [];
  const { searched, scheduler } = createSearch(firstTab, {
    activeTab,
    selected,
    loadSearchResultPage: async (tab) => {
      await gate.promise;
      return backendPage(tab, { complete: true });
    },
  });
  const pending = searched.runTableSearch("needle");
  scheduler.flushLatest();
  activeTab.value = secondTab;
  gate.resolve();

  await pending;

  assert.deepEqual(selected, []);
});

test("refreshCurrentSearchMatches uses backend metadata while in result mode", () => {
  const tab = makeTab();
  tab.searchQuery = "needle";
  backendPage(tab, { complete: true });
  const { searched } = createSearch(tab);

  const matches = searched.refreshCurrentSearchMatches();

  assert.deepEqual(matches, [{ rowIndex: 0, columnIndex: 2 }]);
  assert.deepEqual(searched.searchHitSummary.value, { current: 1, total: 1, label: "1/1" });
});

test("refreshCurrentSearchMatches can reselect a hit after an external sorted reload", () => {
  const tab = makeTab();
  tab.searchQuery = "needle";
  backendPage(tab, {
    rows: [{ id: "10", name: "Needle", note: "Needle" }],
    matches: [
      { rowIndex: 0, sourceRowIndex: 9, columnIndex: 1, columnName: "name" },
      { rowIndex: 0, sourceRowIndex: 9, columnIndex: 2, columnName: "note" },
    ],
    complete: false,
  });
  const selected = [];
  const { searched } = createSearch(tab, { selected });

  searched.refreshCurrentSearchMatches({ select: true });

  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 0, columnIndex: 1 }]);
  assert.deepEqual(searched.searchHitSummary.value, { current: 1, total: 2, label: "1/2+" });
});

test("resumeCurrentSearchResults continues an empty sorted page before selecting", async () => {
  const tab = makeTab();
  tab.searchQuery = "needle";
  tab.searchResultMode = true;
  tab.searchResultComplete = false;
  tab.searchResultMatches = [];
  const selected = [];
  let continuationCalls = 0;
  const { searched } = createSearch(tab, {
    selected,
    loadNextSearchResultPage: async (targetTab) => {
      continuationCalls += 1;
      return backendPage(targetTab, {
        rows: [{ id: "10", name: "Needle", note: "Needle" }],
        matches: [
          { rowIndex: 0, sourceRowIndex: 9, columnIndex: 1, columnName: "name" },
          { rowIndex: 0, sourceRowIndex: 9, columnIndex: 2, columnName: "note" },
        ],
        complete: false,
      });
    },
  });

  const matches = await searched.resumeCurrentSearchResults({ select: true });

  assert.equal(continuationCalls, 1);
  assert.equal(matches.length, 2);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 0, columnIndex: 1 }]);
});

test("dispose cancels scheduled input and the active backend job", async () => {
  const tab = makeTab();
  tab.searchResultJobId = "job-active";
  const cancellations = [];
  const { searched, scheduler } = createSearch(tab, {
    cancelSearchResultPage: async (targetTab) => {
      if (!targetTab.searchResultJobId) return false;
      cancellations.push(targetTab.searchResultJobId);
      targetTab.searchResultJobId = "";
      return true;
    },
  });
  const pending = searched.runTableSearch("needle");

  await searched.dispose();
  await pending;

  assert.equal(scheduler.size(), 0);
  assert.deepEqual(cancellations, ["job-active"]);
});

test("handleTableFindKeydown prevents native find and focuses the table search input", () => {
  const tab = makeTab();
  const { searched } = createSearch(tab);
  const calls = [];
  searched.searchInputRef.value = {
    focus: () => calls.push("focus"),
    select: () => calls.push("select"),
  };
  const event = {
    key: "f",
    ctrlKey: true,
    metaKey: false,
    preventDefault: () => calls.push("preventDefault"),
    stopPropagation: () => calls.push("stopPropagation"),
  };

  assert.equal(searched.handleTableFindKeydown(event), true);
  assert.deepEqual(calls, ["preventDefault", "stopPropagation", "focus", "select"]);
});
