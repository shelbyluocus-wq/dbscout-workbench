import test from "node:test";
import assert from "node:assert/strict";
import { computed, ref } from "vue";

import { useTableSearch, cellMatchesSearch } from "./composables/useTableSearch.js";

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
  assert.equal(cellMatchesSearch("Needle value", "needle", "exact"), false);
  assert.equal(cellMatchesSearch("Needle value", "Needle value", "exact"), true);
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
