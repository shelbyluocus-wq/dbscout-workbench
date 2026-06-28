import test from "node:test";
import assert from "node:assert/strict";
import { computed, ref } from "vue";

import { findSearchMatches, useTableSearch, cellMatchesSearch } from "./composables/useTableSearch.js";
import { createEditState, startCellCommit } from "./editState.js";

function makeTab() {
  return {
    id: "tab-1",
    tableName: "hero",
    rows: [
      { id: "1", name: "Alpha", note: "first" },
      { id: "2", name: "Beta", note: "Needle value" },
    ],
    columns: [{ column_name: "id" }, { column_name: "name" }, { column_name: "note" }],
    primaryKeys: ["id"],
    filter: "",
    filterMode: "fuzzy",
    totalRows: 2,
    fullyLoaded: true,
  };
}

test("cellMatchesSearch supports fuzzy and exact modes", () => {
  assert.equal(cellMatchesSearch("Needle value", "needle", "fuzzy"), true);
  assert.equal(cellMatchesSearch("HeroProp", "hrp", "fuzzy"), true);
  assert.equal(cellMatchesSearch("Needle value", "needle", "exact"), false);
  assert.equal(cellMatchesSearch("Needle value", "Needle value", "exact"), true);
});

test("runTableSearch prefers continuous fuzzy matches before subsequence matches", async () => {
  const tab = makeTab();
  tab.rows = [
    { id: "1", name: "HeroProp", note: "subsequence match" },
    { id: "2", name: "HRP Pack", note: "prefix match" },
  ];
  tab.totalRows = 2;
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => false,
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("hrp");

  assert.deepEqual(searched.searchMatches.value, [
    { rowIndex: 1, columnIndex: 1 },
    { rowIndex: 0, columnIndex: 1 },
  ]);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 1, columnIndex: 1 }]);
});

test("findSearchMatches reuses scanned matches for an unchanged query", () => {
  const tab = makeTab();
  let displayCallCount = 0;
  const displayCellValue = (_edit, _tab, row, column) => {
    displayCallCount += 1;
    return row[column];
  };

  const first = findSearchMatches({}, tab, { query: "needle", displayCellValue });
  const second = findSearchMatches({}, tab, { query: "needle", displayCellValue });

  assert.deepEqual(first, [{ rowIndex: 1, columnIndex: 2 }]);
  assert.deepEqual(second, first);
  assert.equal(displayCallCount, 6);
});

test("findSearchMatches scans only appended rows for an unchanged query", () => {
  const tab = makeTab();
  let displayCallCount = 0;
  const displayCellValue = (_edit, _tab, row, column) => {
    displayCallCount += 1;
    return row[column];
  };

  findSearchMatches({}, tab, { query: "needle", displayCellValue });
  tab.rows.push({ id: "3", name: "Gamma", note: "Needle later" });
  tab.totalRows = 3;
  const matches = findSearchMatches({}, tab, { query: "needle", displayCellValue });

  assert.deepEqual(matches, [
    { rowIndex: 1, columnIndex: 2 },
    { rowIndex: 2, columnIndex: 2 },
  ]);
  assert.equal(displayCallCount, 9);
});

test("findSearchMatches invalidates cached rows when edit state mutates", () => {
  const tab = makeTab();
  const editState = createEditState();
  findSearchMatches(editState, tab, { query: "changed" });

  startCellCommit(editState, {
    tableName: "hero",
    rowKey: "id=1",
    columnName: "note",
    oldValue: "first",
    newValue: "Changed value",
  });
  const matches = findSearchMatches(editState, tab, { query: "changed" });

  assert.deepEqual(matches, [{ rowIndex: 0, columnIndex: 2 }]);
});

test("runTableSearch selects the first matching loaded cell without removing rows", async () => {
  const tab = makeTab();
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => false,
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");

  assert.equal(tab.filter, "needle");
  assert.equal(tab.searchQuery, "needle");
  assert.equal(tab.rows.length, 2);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 1, columnIndex: 2 }]);
});

test("runTableSearch loads more rows until it finds the first table match", async () => {
  const tab = makeTab();
  tab.rows = [{ id: "1", name: "Alpha", note: "first" }];
  tab.totalRows = 2;
  tab.fullyLoaded = false;
  let loads = 0;
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => {
      loads++;
      tab.rows.push({ id: "2", name: "Beta", note: "Needle value" });
      tab.fullyLoaded = true;
      return true;
    },
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");

  assert.equal(loads, 1);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 1, columnIndex: 2 }]);
});

test("runTableSearch continues the latest query after an existing page load resolves", async () => {
  const tab = makeTab();
  tab.rows = [{ id: "1", name: "Alpha", note: "first" }];
  tab.totalRows = 2;
  tab.fullyLoaded = false;
  let loads = 0;
  let resolveLoad;
  const selected = [];
  const loadPromise = new Promise((resolve) => {
    resolveLoad = resolve;
  });
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => {
      if (tab.loadingMore) return false;
      tab.loadingMore = true;
      loads++;
      await loadPromise;
      tab.rows.push({ id: "2", name: "Beta", note: "New query match" });
      tab.fullyLoaded = true;
      tab.loadingMore = false;
      return true;
    },
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  const oldSearch = searched.runTableSearch("old");
  const newSearch = searched.runTableSearch("new");

  assert.equal(loads, 1);
  assert.deepEqual(selected, []);

  resolveLoad();
  await Promise.all([oldSearch, newSearch]);

  assert.equal(loads, 1);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 1, columnIndex: 2 }]);
});

test("runTableSearch loads the active tab while a stale tab search load is pending", async () => {
  const firstTab = makeTab();
  firstTab.rows = [{ id: "1", name: "Alpha", note: "first" }];
  firstTab.totalRows = 2;
  firstTab.fullyLoaded = false;
  const secondTab = {
    ...makeTab(),
    id: "tab-2",
    tableName: "items",
    rows: [{ id: "1", name: "Gamma", note: "second" }],
    totalRows: 2,
    fullyLoaded: false,
  };
  const currentTab = ref(firstTab);
  const selected = [];
  const loadCalls = [];
  let resolveFirstLoad;
  let resolveSecondLoad;
  const firstLoad = new Promise((resolve) => {
    resolveFirstLoad = resolve;
  });
  const secondLoad = new Promise((resolve) => {
    resolveSecondLoad = resolve;
  });
  const searched = useTableSearch(currentTab, {
    loadNextPage: async (tab) => {
      loadCalls.push(tab.id);
      if (tab.id === firstTab.id) {
        await firstLoad;
        firstTab.fullyLoaded = true;
        return false;
      }
      await secondLoad;
      secondTab.rows.push({ id: "2", name: "Delta", note: "Needle value" });
      secondTab.fullyLoaded = true;
      return true;
    },
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  const oldSearch = searched.runTableSearch("old");
  assert.deepEqual(loadCalls, [firstTab.id]);

  currentTab.value = secondTab;
  const newSearch = searched.runTableSearch("needle");

  assert.deepEqual(loadCalls, [firstTab.id, secondTab.id]);

  resolveFirstLoad();
  await oldSearch;
  assert.deepEqual(selected, []);

  resolveSecondLoad();
  await newSearch;

  assert.deepEqual(selected, [{ targetTab: secondTab, rowIndex: 1, columnIndex: 2 }]);
});

test("runTableSearch does not select stale tab matches after active tab changes during load", async () => {
  const firstTab = makeTab();
  firstTab.rows = [{ id: "1", name: "Alpha", note: "first" }];
  firstTab.totalRows = 2;
  firstTab.fullyLoaded = false;
  const secondTab = {
    ...makeTab(),
    id: "tab-2",
    tableName: "items",
  };
  const currentTab = ref(firstTab);
  let resolveLoad;
  const selected = [];
  const loadPromise = new Promise((resolve) => {
    resolveLoad = resolve;
  });
  const searched = useTableSearch(currentTab, {
    loadNextPage: async (tab) => {
      await loadPromise;
      tab.rows.push({ id: "2", name: "Beta", note: "Needle value" });
      tab.fullyLoaded = true;
      return true;
    },
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  const search = searched.runTableSearch("needle");
  currentTab.value = secondTab;
  resolveLoad();
  await search;

  assert.deepEqual(selected, []);
});

test("runTableSearch exposes match availability when loaded matches exist", async () => {
  const tab = makeTab();
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => false,
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");

  assert.equal(searched.hasSearchMatches.value, true);
  assert.deepEqual(searched.searchMatches.value, [{ rowIndex: 1, columnIndex: 2 }]);
  assert.deepEqual(selected, [{ targetTab: tab, rowIndex: 1, columnIndex: 2 }]);
});

test("goToNextSearchMatch moves through matches and wraps to the first match", async () => {
  const tab = makeTab();
  tab.rows.push({ id: "3", name: "Needle hero", note: "third" });
  tab.totalRows = 3;
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => false,
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");
  await searched.goToNextSearchMatch();
  await searched.goToNextSearchMatch();

  assert.deepEqual(selected, [
    { targetTab: tab, rowIndex: 1, columnIndex: 2 },
    { targetTab: tab, rowIndex: 2, columnIndex: 1 },
    { targetTab: tab, rowIndex: 1, columnIndex: 2 },
  ]);
});

test("goToNextSearchMatch loads later pages before wrapping from the last loaded match", async () => {
  const tab = makeTab();
  tab.rows = [{ id: "1", name: "Alpha", note: "Needle first" }];
  tab.totalRows = 2;
  tab.fullyLoaded = false;
  let loads = 0;
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => {
      loads++;
      tab.rows.push({ id: "2", name: "Beta", note: "Needle later" });
      tab.fullyLoaded = true;
      return true;
    },
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");
  await searched.goToNextSearchMatch();

  assert.equal(loads, 1);
  assert.deepEqual(selected, [
    { targetTab: tab, rowIndex: 0, columnIndex: 2 },
    { targetTab: tab, rowIndex: 1, columnIndex: 2 },
  ]);
});

test("goToNextSearchMatch does not select stale tab matches after active tab changes during load", async () => {
  const firstTab = makeTab();
  firstTab.rows = [{ id: "1", name: "Alpha", note: "Needle first" }];
  firstTab.totalRows = 2;
  firstTab.fullyLoaded = false;
  const secondTab = {
    ...makeTab(),
    id: "tab-2",
    tableName: "items",
  };
  const currentTab = ref(firstTab);
  let resolveLoad;
  const selected = [];
  const loadPromise = new Promise((resolve) => {
    resolveLoad = resolve;
  });
  const searched = useTableSearch(currentTab, {
    loadNextPage: async (tab) => {
      await loadPromise;
      tab.rows.push({ id: "2", name: "Beta", note: "Needle later" });
      tab.fullyLoaded = true;
      return true;
    },
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");
  const nextSearch = searched.goToNextSearchMatch();
  currentTab.value = secondTab;
  resolveLoad();
  await nextSearch;

  assert.deepEqual(selected, [{ targetTab: firstTab, rowIndex: 0, columnIndex: 2 }]);
});

test("goToPreviousSearchMatch moves backward through matches and wraps to the last match", async () => {
  const tab = makeTab();
  tab.rows.push({ id: "3", name: "Needle hero", note: "third" });
  tab.totalRows = 3;
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => false,
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");
  await searched.goToPreviousSearchMatch();
  await searched.goToPreviousSearchMatch();

  assert.deepEqual(selected, [
    { targetTab: tab, rowIndex: 1, columnIndex: 2 },
    { targetTab: tab, rowIndex: 2, columnIndex: 1 },
    { targetTab: tab, rowIndex: 1, columnIndex: 2 },
  ]);
});

test("goToPreviousSearchMatch loads later pages before wrapping from the first loaded match", async () => {
  const tab = makeTab();
  tab.rows = [{ id: "1", name: "Alpha", note: "Needle first" }];
  tab.totalRows = 2;
  tab.fullyLoaded = false;
  let loads = 0;
  const selected = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => {
      loads++;
      tab.rows.push({ id: "2", name: "Beta", note: "Needle later" });
      tab.fullyLoaded = true;
      return true;
    },
    selectCellAt: (targetTab, rowIndex, columnIndex) => selected.push({ targetTab, rowIndex, columnIndex }),
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");
  await searched.goToPreviousSearchMatch();

  assert.equal(loads, 1);
  assert.deepEqual(selected, [
    { targetTab: tab, rowIndex: 0, columnIndex: 2 },
    { targetTab: tab, rowIndex: 1, columnIndex: 2 },
  ]);
});

test("clearing table search hides search navigation", async () => {
  const tab = makeTab();
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => false,
    selectCellAt: () => {},
    statusText: ref(""),
  });

  await searched.runTableSearch("needle");
  await searched.runTableSearch("");

  assert.equal(searched.hasSearchMatches.value, false);
  assert.deepEqual(searched.searchMatches.value, []);
});

test("handleTableFindKeydown prevents native find and focuses the table search input", () => {
  const tab = makeTab();
  const calls = [];
  const searched = useTableSearch(computed(() => tab), {
    loadNextPage: async () => false,
    selectCellAt: () => {},
    statusText: ref(""),
  });
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

  const handled = searched.handleTableFindKeydown(event);

  assert.equal(handled, true);
  assert.deepEqual(calls, ["preventDefault", "stopPropagation", "focus", "select"]);
});
