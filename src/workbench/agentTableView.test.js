import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAgentTableViewState } from "./utils/agentTableView.js";

test("non-empty filter goes through loadSearchResultPage and honors filterMode", async () => {
  const tab = { filter: "", searchQuery: "", filterMode: "exact" };
  const calls = [];
  await applyAgentTableViewState(tab, { filter: "alice", filterMode: "fuzzy" }, {
    loadSearchResultPage: async (t, text) => {
      calls.push(["search", t === tab, text]);
      return { ok: true };
    },
    applySort: async (...a) => calls.push(["sort", ...a]),
    fetchPage: async () => calls.push("page"),
  });
  assert.equal(tab.filterMode, "fuzzy");
  assert.deepEqual(calls, [["search", true, "alice"]]);
});

test("explicit empty filter clears via loadSearchResultPage", async () => {
  const tab = { filter: "x", searchQuery: "x", searchResultMode: true };
  const calls = [];
  await applyAgentTableViewState(tab, { filter: "" }, {
    loadSearchResultPage: async (t, text) => {
      calls.push(["search", text]);
      return { ok: true, restored: true };
    },
    applySort: async () => calls.push("sort"),
    fetchPage: async () => calls.push("page"),
  });
  assert.deepEqual(calls, [["search", ""]]);
});

test("missing filter string leaves the current view untouched", async () => {
  const tab = { filter: "keep" };
  const calls = [];
  await applyAgentTableViewState(tab, { filterMode: "continuous" }, {
    loadSearchResultPage: async () => calls.push("search"),
    applySort: async () => calls.push("sort"),
    fetchPage: async () => calls.push("page"),
  });
  assert.equal(tab.filter, "keep");
  assert.equal(tab.filterMode, "continuous");
  assert.deepEqual(calls, []);
});

test("search windows keep loading until the first match or scan end", async () => {
  const tab = {
    searchResultMode: true,
    searchResultComplete: false,
    rowStore: { rows: [] },
  };
  const calls = [];
  await applyAgentTableViewState(tab, { filter: "tail" }, {
    loadSearchResultPage: async () => { calls.push("search"); return { ok: true, complete: false }; },
    loadNextSearchResultPage: async (t) => {
      calls.push("next");
      if (calls.filter((c) => c === "next").length >= 3) {
        t.searchResultComplete = true;
        return { ok: true, complete: true, addedRows: 0 };
      }
      return { ok: true, complete: false, addedRows: 0 };
    },
    applySort: async () => calls.push("sort"),
    fetchPage: async () => calls.push("page"),
  });
  assert.deepEqual(calls, ["search", "next", "next", "next"]);
});

test("the fill loop stops as soon as a match row arrives", async () => {
  const tab = {
    searchResultMode: true,
    searchResultComplete: false,
    rowStore: { rows: [] },
  };
  const calls = [];
  await applyAgentTableViewState(tab, { filter: "x" }, {
    loadSearchResultPage: async () => { calls.push("search"); return { ok: true, complete: false }; },
    loadNextSearchResultPage: async (t) => {
      calls.push("next");
      if (calls.filter((c) => c === "next").length === 2) {
        t.rowStore.replacePage([{ id: "1" }]);
      }
      return { ok: true, complete: false, addedRows: 0 };
    },
    applySort: async () => calls.push("sort"),
    fetchPage: async () => calls.push("page"),
  });
  assert.deepEqual(calls, ["search", "next", "next"]);
});

test("sort applies after the filter so applySort refetches inside search mode", async () => {
  const tab = { filter: "" };
  const calls = [];
  await applyAgentTableViewState(tab, { filter: "alice", sort: { column: "id", descending: true } }, {
    loadSearchResultPage: async (t, text) => {
      calls.push(["search", text]);
      t.searchResultMode = true;
      return { ok: true };
    },
    applySort: async (t, column, direction) => {
      calls.push(["sort", column, direction, t.searchResultMode === true]);
      return { ok: true };
    },
    fetchPage: async () => calls.push("page"),
  });
  assert.deepEqual(calls, [
    ["search", "alice"],
    ["sort", "id", "descending", true],
  ]);
});

test("sort accepts columnName and defaults to ascending", async () => {
  const calls = [];
  await applyAgentTableViewState({}, { sort: { columnName: "name" } }, {
    loadSearchResultPage: async () => calls.push("search"),
    applySort: async (t, column, direction) => {
      calls.push(["sort", column, direction]);
      return { ok: true };
    },
    fetchPage: async () => calls.push("page"),
  });
  assert.deepEqual(calls, [["sort", "name", "ascending"]]);
});

test("a failed search propagates and sort is not attempted", async () => {
  const calls = [];
  await assert.rejects(
    applyAgentTableViewState({}, { filter: "x", sort: { column: "id" } }, {
      loadSearchResultPage: async () => ({ ok: false, error: new Error("boom") }),
      applySort: async () => calls.push("sort"),
      fetchPage: async () => calls.push("page"),
    }),
    /boom/,
  );
  assert.deepEqual(calls, []);
});

test("a stale search result is not treated as a failure", async () => {
  const calls = [];
  await applyAgentTableViewState({}, { filter: "x", sort: { column: "id" } }, {
    loadSearchResultPage: async () => ({ ok: false, stale: true }),
    applySort: async (t, column, direction) => {
      calls.push(["sort", column, direction]);
      return { ok: true };
    },
    fetchPage: async () => calls.push("page"),
  });
  assert.deepEqual(calls, [["sort", "id", "ascending"]]);
});

test("a failed sort propagates", async () => {
  await assert.rejects(
    applyAgentTableViewState({}, { sort: { column: "id" } }, {
      loadSearchResultPage: async () => ({ ok: true }),
      applySort: async () => ({ ok: false, error: new Error("排序炸了") }),
      fetchPage: async () => ({}),
    }),
    /排序炸了/,
  );
});
