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
