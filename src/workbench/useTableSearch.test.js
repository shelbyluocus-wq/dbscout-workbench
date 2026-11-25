import test from "node:test";
import assert from "node:assert/strict";
import { computed, ref } from "vue";

import { cellMatchesSearch, findSearchMatches, resolveSearchMatchColumnIndex, useTableSearch } from "./composables/useTableSearch.js";
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

test("resolveSearchMatchColumnIndex prefers the field name after columns are reordered", () => {
  const tab = makeTab();
  tab.columns = [{ column_name: "note" }, { column_name: "id" }, { column_name: "name" }];
  assert.equal(resolveSearchMatchColumnIndex(tab, { columnIndex: 2, columnName: "note" }), 0);
  assert.equal(resolveSearchMatchColumnIndex(tab, { columnIndex: 0, column: "name" }), 2);
});

test("cellMatchesSearch keeps exact, continuous, and fuzzy semantics distinct", () => {
  assert.equal(cellMatchesSearch("Needle value", "needle", "fuzzy"), true);
  assert.equal(cellMatchesSearch("HeroProp", "hrp", "fuzzy"), true);
  assert.equal(cellMatchesSearch("Needle value", "needle", "continuous"), true);
  assert.equal(cellMatchesSearch("HeroProp", "hrp", "continuous"), false);
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

test("normal table search debounces input, keeps ordinary rows, and automatically scans every page", async () => {
  const tab = makeTab();
  tab.fullyLoaded = false;
  const originalRows = [...tab.rows];
  let ordinaryPageCalls = 0;
  let backendResultCalls = 0;
  const { searched, scheduler } = createSearch(tab, {
    loadNextPage: async (targetTab) => {
      ordinaryPageCalls += 1;
      targetTab.rows.push({ id: "3", name: "Gamma", note: "Needle later" });
      targetTab.fullyLoaded = true;
      return { ok: true };
    },
    loadSearchResultPage: async () => {
      backendResultCalls += 1;
      throw new Error("normal table search must not open a hit-only result page");
    },
  });

  const pending = searched.runTableSearch("needle");

  assert.deepEqual(scheduler.delays(), [150]);
  scheduler.flushLatest();
  await pending;

  assert.equal(backendResultCalls, 0);
  assert.equal(ordinaryPageCalls, 1);
  assert.deepEqual(tab.rows, [...originalRows, { id: "3", name: "Gamma", note: "Needle later" }]);
  assert.equal(tab.searchResultMode, false);
  assert.equal(tab.filter, "needle");
  assert.equal(tab.searchQuery, "needle");
  assert.deepEqual(searched.searchMatches.value, [
    { rowIndex: 1, columnIndex: 2 },
    { rowIndex: 2, columnIndex: 2 },
  ]);
  assert.deepEqual(searched.searchHitSummary.value, { current: 1, total: 2, label: "1/2" });
});

test("normal table search publishes no partial count while ordinary pages are still loading", async () => {
  const tab = makeTab();
  tab.fullyLoaded = false;
  const intermediateStates = [];
  let page = 0;
  let searched;
  const created = createSearch(tab, {
    loadNextPage: async (targetTab) => {
      page += 1;
      targetTab.rows.push({ id: String(page + 2), name: "Later", note: `Needle page ${page}` });
      targetTab.fullyLoaded = page === 2;
      searched.refreshCurrentSearchMatches();
      intermediateStates.push({
        matches: searched.searchMatches.value.length,
        label: searched.searchHitSummary.value.label,
      });
      return { ok: true };
    },
  });
  searched = created.searched;

  const pending = searched.runTableSearch("needle");
  created.scheduler.flushLatest();
  await pending;

  assert.deepEqual(intermediateStates, [
    { matches: 0, label: "" },
    { matches: 0, label: "" },
  ]);
  assert.deepEqual(searched.searchHitSummary.value, { current: 1, total: 3, label: "1/3" });
});

test("rapid typing only scans the latest normal-table query", async () => {
  const tab = makeTab();
  let backendResultCalls = 0;
  const { searched, scheduler } = createSearch(tab, {
    loadSearchResultPage: async () => {
      backendResultCalls += 1;
      throw new Error("normal table search must stay local");
    },
  });

  const oldSearch = searched.runTableSearch("old");
  const newSearch = searched.runTableSearch("new");

  assert.equal(scheduler.size(), 1);
  scheduler.flushLatest();
  await Promise.all([oldSearch, newSearch]);

  assert.equal(backendResultCalls, 0);
  assert.equal(tab.searchQuery, "new");
  assert.deepEqual(searched.searchMatches.value, []);
});

test("search preserves a matching selected cell and never moves selection while editing", async () => {
  const tab = makeTab();
  const originalRows = [...tab.rows];
  const selected = [];
  const { searched, scheduler } = createSearch(tab, {
    selected,
    getSelectedPosition: () => ({ rowIndex: 1, columnIndex: 2, rowKey: "id=2" }),
    isEditing: () => true,
    loadSearchResultPage: async () => {
      throw new Error("normal table search must not replace rows");
    },
  });

  const pending = searched.runTableSearch("needle");
  scheduler.flushLatest();
  await pending;

  assert.deepEqual(selected, []);
  assert.deepEqual(tab.rows, originalRows);
  assert.equal(searched.searchHitSummary.value.current, 1);
});

test("next and previous navigation only move through the complete result set", async () => {
  const tab = makeTab();
  tab.fullyLoaded = false;
  const selected = [];
  let ordinaryPageCalls = 0;
  let resultPageCalls = 0;
  const { searched, scheduler } = createSearch(tab, {
    selected,
    loadNextPage: async (targetTab) => {
      ordinaryPageCalls += 1;
      targetTab.rows.push({ id: "10", name: "Later", note: "Needle later" });
      targetTab.fullyLoaded = true;
      return { ok: true };
    },
    loadSearchResultPage: async () => {
      throw new Error("normal search must not use backend result rows");
    },
    loadNextSearchResultPage: async () => {
      resultPageCalls += 1;
      throw new Error("navigation must not continue a completed normal search");
    },
  });
  const pending = searched.runTableSearch("needle");
  scheduler.flushLatest();
  await pending;

  await searched.goToNextSearchMatch();
  await searched.goToPreviousSearchMatch();

  assert.equal(ordinaryPageCalls, 1);
  assert.equal(resultPageCalls, 0);
  assert.deepEqual(selected.map(({ rowIndex, columnIndex }) => ({ rowIndex, columnIndex })), [
    { rowIndex: 1, columnIndex: 2 },
    { rowIndex: 2, columnIndex: 2 },
    { rowIndex: 1, columnIndex: 2 },
  ]);
});

test("clearing normal search keeps rows, performs no refetch, and restores the original selection", async () => {
  const tab = makeTab();
  const originalRows = [...tab.rows];
  const selected = [];
  let ordinaryPageCalls = 0;
  let backendResultCalls = 0;
  const scheduler = manualScheduler();
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => {
      ordinaryPageCalls += 1;
      return { ok: false };
    },
    loadSearchResultPage: async () => {
      backendResultCalls += 1;
      throw new Error("normal search clear must not refetch or restore a result page");
    },
    loadNextSearchResultPage: async () => ({ ok: false }),
    cancelSearchResultPage: async () => false,
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

  assert.equal(ordinaryPageCalls, 0);
  assert.equal(backendResultCalls, 0);
  assert.deepEqual(tab.rows, originalRows);
  assert.equal(tab.searchResultMode, false);
  assert.equal(tab.filter, "");
  assert.equal(tab.searchQuery, "");
  assert.equal(searched.hasSearchMatches.value, false);
  assert.deepEqual(selected.at(-1), { targetTab: tab, rowIndex: 1, columnIndex: 2 });
});

test("a stale ordinary-page response cannot select cells after the active tab changes", async () => {
  const firstTab = makeTab();
  firstTab.fullyLoaded = false;
  const secondTab = { ...makeTab(), id: "tab-2", sessionId: "session-2" };
  const activeTab = ref(firstTab);
  const gate = deferred();
  const selected = [];
  const { searched, scheduler } = createSearch(firstTab, {
    activeTab,
    selected,
    loadNextPage: async (tab) => {
      await gate.promise;
      tab.rows.push({ id: "3", name: "Needle", note: "late" });
      tab.fullyLoaded = true;
      return { ok: true };
    },
    loadSearchResultPage: async () => {
      throw new Error("normal search must not start a backend result job");
    },
  });
  const pending = searched.runTableSearch("needle");
  scheduler.flushLatest();
  activeTab.value = secondTab;
  gate.resolve();

  await pending;

  assert.deepEqual(selected, []);
});

test("explicit hit-result activation still uses the isolated backend result mode", async () => {
  const tab = makeTab();
  const backendQueries = [];
  const { searched, scheduler } = createSearch(tab, {
    loadSearchResultPage: async (targetTab, query) => {
      backendQueries.push(query);
      return backendPage(targetTab, { complete: true });
    },
  });

  const pending = searched.runTableSearch("needle", { preferBackendResultPage: true });
  scheduler.flushLatest();
  await pending;

  assert.deepEqual(backendQueries, ["needle"]);
  assert.equal(tab.searchResultMode, true);
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

test("resumeCurrentSearchResults rebuilds an ordinary search after a first-page refresh", async () => {
  const tab = makeTab();
  tab.rows = [{ id: "1", name: "Alpha", note: "first page" }];
  tab.searchQuery = "needle";
  tab.filter = "needle";
  tab.fullyLoaded = false;
  const selected = [];
  let pageLoads = 0;
  const { searched } = createSearch(tab, {
    selected,
    loadNextPage: async (targetTab) => {
      pageLoads += 1;
      targetTab.rows.push({ id: "7101", name: "Needle", note: "refreshed match" });
      targetTab.fullyLoaded = true;
      return { ok: true };
    },
  });

  const matches = await searched.resumeCurrentSearchResults({ select: true });

  assert.equal(pageLoads, 1);
  assert.deepEqual(matches, [{ rowIndex: 1, columnIndex: 1 }]);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 1, columnIndex: 1 }]);
  assert.deepEqual(searched.searchHitSummary.value, { current: 1, total: 1, label: "1/1" });
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

test("ordinary search waits for an in-flight table reload before scanning all pages", async () => {
  const tab = makeTab();
  tab.rows = [{ id: "1", name: "Filtered", note: "only row" }];
  tab.loading = true;
  tab.fullyLoaded = false;
  const reloadGate = deferred();
  const selected = [];
  let pageCalls = 0;
  const { searched, scheduler } = createSearch(tab, {
    selected,
    loadNextPage: async (targetTab) => {
      pageCalls += 1;
      if (pageCalls === 1) {
        await reloadGate.promise;
        targetTab.rows = [{ id: "1", name: "Page 1", note: "first" }];
        targetTab.loading = false;
        targetTab.fullyLoaded = false;
        return true;
      }
      targetTab.rows.push({ id: "1728", name: "Page 2", note: "572001" });
      targetTab.fullyLoaded = true;
      return true;
    },
  });

  const pending = searched.runTableSearch("572001");
  scheduler.flushLatest();
  reloadGate.resolve();
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(pageCalls, 2);
  assert.deepEqual(searched.searchMatches.value, [{ rowIndex: 1, columnIndex: 2 }]);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 1, columnIndex: 2 }]);
});

test("resumeCurrentSearchResults skips redundant search-filter reload and preserves pending empty-tab typing", async () => {
  const tab = makeTab();
  tab.fullyLoaded = false;
  let filterReloads = 0;
  const { searched, scheduler } = createSearch(tab, {
    loadNextPage: async (targetTab) => {
      targetTab.rows.push({ id: "3", name: "Later", note: "Needle later" });
      targetTab.fullyLoaded = true;
      return true;
    },
  });

  // When tab.filter is still empty during debounce, resume must not cancel the scheduled search.
  const pending = searched.runTableSearch("needle");
  assert.deepEqual(await searched.resumeCurrentSearchResults({ select: true }), []);
  assert.equal(scheduler.size(), 1);
  scheduler.flushLatest();
  await pending;
  assert.equal(searched.searchMatches.value.length, 2);

  // When searchFilterActive is already applied by the caller, resume scans without refetching page 1.
  const filteredTab = makeTab();
  filteredTab.filter = "needle";
  filteredTab.searchQuery = "needle";
  filteredTab.searchFilterActive = true;
  filteredTab.fullyLoaded = true;
  const filteredSearch = useTableSearch(computed(() => filteredTab), {
    onSearchFilterChange: async () => {
      filterReloads += 1;
      return { ok: true };
    },
    loadNextPage: async () => false,
    selectCellAt: () => {},
    statusText: ref(""),
  });
  const resumed = await filteredSearch.resumeCurrentSearchResults({ select: true });
  assert.equal(filterReloads, 0);
  assert.equal(resumed.length, 1);
});

test("next and previous navigation resume an incomplete ordinary search instead of sticking at 0/0", async () => {
  const tab = makeTab();
  tab.rows = [{ id: "1", name: "Alpha", note: "page 1" }];
  tab.filter = "572001";
  tab.searchQuery = "572001";
  tab.fullyLoaded = false;
  const selected = [];
  const { searched } = createSearch(tab, {
    selected,
    loadNextPage: async (targetTab) => {
      targetTab.rows.push({ id: "1728", name: "Target", note: "572001" });
      targetTab.fullyLoaded = true;
      return true;
    },
  });

  assert.equal(await searched.goToNextSearchMatch(), true);
  assert.deepEqual(searched.searchMatches.value, [{ rowIndex: 1, columnIndex: 2 }]);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 1, columnIndex: 2 }]);
});
