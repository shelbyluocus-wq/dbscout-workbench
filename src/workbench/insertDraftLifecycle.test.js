import test from "node:test";
import assert from "node:assert/strict";

import {
  closableRelativeTabsInPane,
  closableTabsInPane,
  INSERT_DRAFT_CLOSE_DECISION,
  guardInsertDraftTabs,
} from "./utils/insertDraftLifecycle.js";

function tab(id, drafts = []) {
  return { id, tableName: id, insertDrafts: drafts.map((draft, index) => ({ id: `${id}-${index}`, draft })) };
}

test("insert draft close guard saves every dirty tab before allowing close", async () => {
  const first = tab("player", [{ name: "Dana" }]);
  const second = tab("guild", [{ name: "Gold" }, {}]);
  const saved = [];

  const result = await guardInsertDraftTabs([first, second], {
    decide: async ({ rowCount }) => {
      assert.equal(rowCount, 3);
      return INSERT_DRAFT_CLOSE_DECISION.SAVE;
    },
    saveDrafts: async (target, rowIds) => {
      saved.push([target.id, rowIds]);
      target.insertDrafts.splice(0);
      return { insertedRows: rowIds.length, failedRowId: null };
    },
  });

  assert.equal(result.proceed, true);
  assert.deepEqual(saved, [
    ["player", ["player-0"]],
    ["guild", ["guild-0", "guild-1"]],
  ]);
});

test("insert draft close guard can discard all drafts or cancel without changing them", async () => {
  const discarded = tab("player", [{ name: "Dana" }]);
  const discardResult = await guardInsertDraftTabs([discarded], {
    decide: async () => INSERT_DRAFT_CLOSE_DECISION.DISCARD,
  });
  assert.equal(discardResult.proceed, true);
  assert.deepEqual(discarded.insertDrafts, []);

  const kept = tab("guild", [{ name: "Gold" }]);
  const cancelResult = await guardInsertDraftTabs([kept], {
    decide: async () => INSERT_DRAFT_CLOSE_DECISION.CANCEL,
  });
  assert.equal(cancelResult.proceed, false);
  assert.equal(kept.insertDrafts.length, 1);
});

test("insert draft close guard stops on the first save failure", async () => {
  const first = tab("player", [{ name: "Dana" }]);
  const second = tab("guild", [{ name: "Gold" }]);
  const result = await guardInsertDraftTabs([first, second], {
    decide: async () => INSERT_DRAFT_CLOSE_DECISION.SAVE,
    saveDrafts: async (target, rowIds) => target === first
      ? { insertedRows: 0, failedRowId: rowIds[0], failedReason: "invalid" }
      : { insertedRows: 1, failedRowId: null },
  });

  assert.equal(result.proceed, false);
  assert.equal(result.failedTab, first);
  assert.equal(second.insertDrafts.length, 1);
});

test("pane close candidates preserve pane order and exclude the pinned homepage", () => {
  const tabs = [
    { id: "home", kind: "home" },
    { id: "player", kind: "data" },
    { id: "query", kind: "sql" },
    { id: "guild", kind: "data" },
  ];

  assert.deepEqual(
    closableTabsInPane(tabs, ["home", "guild", "missing", "player", "query"]),
    [tabs[3], tabs[1], tabs[2]],
  );
});

test("relative pane close candidates only include the requested side", () => {
  const tabs = [
    { id: "home", kind: "home" },
    { id: "left", kind: "data" },
    { id: "context", kind: "data" },
    { id: "right-query", kind: "sql" },
    { id: "right-data", kind: "data" },
  ];
  const ids = tabs.map((item) => item.id);

  assert.deepEqual(
    closableRelativeTabsInPane(tabs, ids, "context", "left"),
    [tabs[1]],
  );
  assert.deepEqual(
    closableRelativeTabsInPane(tabs, ids, "context", "right"),
    [tabs[3], tabs[4]],
  );
});
