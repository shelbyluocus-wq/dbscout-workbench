import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG_RELATIONS_UPDATED_EVENT, configRelationsScopeKey, useConfigRelations } from "./useConfigRelations.js";

const SCOPE = { connectionId: "c1", database: "Game_Config" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeBackend() {
  const state = { revision: 1, reviewCount: 2, failOverview: false };
  const calls = [];
  const listeners = new Map();
  let unlistened = 0;
  const invoke = async (command, payload = {}) => {
    calls.push({ command, request: payload.request });
    switch (command) {
      case "config_relations_overview":
        if (state.failOverview) throw new Error("offline");
        return { revision: state.revision, reviewCount: state.reviewCount };
      case "config_relations_table":
        return { revision: state.revision, outgoing: [], incoming: [], table: payload.request.table };
      case "config_relations_review":
        state.revision += 1;
        state.reviewCount -= payload.request.relationIds.length;
        return { revision: state.revision, reviewCount: state.reviewCount };
      case "config_relations_review_list":
        return { items: [], tables: {}, overview: { revision: state.revision, reviewCount: state.reviewCount } };
      case "config_relations_refresh":
        return null;
      case "config_relations_bind_client":
      case "config_relations_unbind_client":
        state.revision += 1;
        return { revision: state.revision, reviewCount: state.reviewCount, client: payload.request.path || null };
      default:
        return null;
    }
  };
  const listen = async (event, handler) => {
    listeners.set(event, handler);
    return () => {
      unlistened += 1;
      listeners.delete(event);
    };
  };
  const emit = (payload) => listeners.get(CONFIG_RELATIONS_UPDATED_EVENT)?.({ payload });
  const count = (command) => calls.filter((call) => call.command === command).length;
  return { state, calls, invoke, listen, emit, count, unlistenCount: () => unlistened };
}

test("scope keys ignore database case and need both a connection and a database", () => {
  assert.equal(configRelationsScopeKey({ connectionId: "c1", database: " Game " }), "c1\u001fgame");
  assert.equal(configRelationsScopeKey({ connectionId: "c1", database: "" }), "");
  assert.equal(configRelationsScopeKey({ connectionId: "", database: "game" }), "");
  assert.equal(configRelationsScopeKey(null), "");
});

test("one entry per scope holds the latest overview and overlapping loads share a request", async () => {
  const backend = fakeBackend();
  const relations = useConfigRelations({ invoke: backend.invoke, listen: null, debounceMs: 0 });
  const entry = relations.entryFor(SCOPE);
  assert.equal(relations.entryFor({ connectionId: "c1", database: "game_config" }), entry);
  assert.equal(relations.entryFor({ connectionId: "c1", database: "" }), null);

  const first = relations.loadOverview(SCOPE);
  const second = relations.loadOverview(SCOPE);
  await Promise.all([first, second]);
  assert.equal(backend.count("config_relations_overview"), 1);
  assert.deepEqual(backend.calls[0].request, { connectionId: "c1", database: "Game_Config" });
  assert.equal(entry.revision, 1);
  assert.equal(entry.overview.reviewCount, 2);
  assert.equal(entry.loading, false);
});

test("a failed overview keeps the last good one and reports the error", async () => {
  const backend = fakeBackend();
  const relations = useConfigRelations({ invoke: backend.invoke, listen: null });
  const entry = relations.entryFor(SCOPE);
  await relations.loadOverview(SCOPE);
  backend.state.failOverview = true;
  assert.equal(await relations.loadOverview(SCOPE, { force: true }), null);
  assert.equal(entry.overview.reviewCount, 2);
  assert.equal(entry.error, "offline");
  backend.state.failOverview = false;
  await relations.loadOverview(SCOPE, { force: true });
  assert.equal(entry.error, "");
});

test("update events move the badge at once and reload the overview once per burst", async () => {
  const backend = fakeBackend();
  const relations = useConfigRelations({ invoke: backend.invoke, listen: backend.listen, debounceMs: 5 });
  assert.equal(await relations.attach(), true);
  assert.equal(await relations.attach(), true, "attaching twice keeps one listener");
  const entry = relations.entryFor(SCOPE);
  await relations.loadOverview(SCOPE);

  backend.state.revision = 4;
  backend.state.reviewCount = 0;
  backend.emit({ connectionId: "c1", database: "game_config", revision: 3, reviewCount: 1 });
  assert.equal(entry.overview.reviewCount, 1, "the event's count shows before the reload");
  backend.emit({ connectionId: "c1", database: "game_config", revision: 4, reviewCount: 0 });
  backend.emit({ connectionId: "other", database: "game_config", reviewCount: 9 });
  await sleep(25);
  assert.equal(backend.count("config_relations_overview"), 2);
  assert.equal(entry.revision, 4);
  assert.equal(entry.overview.reviewCount, 0);

  relations.dispose();
  assert.equal(backend.unlistenCount(), 1);
  backend.emit({ connectionId: "c1", database: "game_config", reviewCount: 5 });
  assert.equal(entry.overview.reviewCount, 0);
});

test("table relations are cached until the index revision moves", async () => {
  const backend = fakeBackend();
  const relations = useConfigRelations({ invoke: backend.invoke, listen: null, debounceMs: 0 });
  const entry = relations.entryFor(SCOPE);
  await relations.loadOverview(SCOPE);

  const first = await relations.tableRelations(SCOPE, "HeroProp");
  assert.equal(first.table, "HeroProp");
  await relations.tableRelations(SCOPE, "heroprop");
  assert.equal(backend.count("config_relations_table"), 1);

  await relations.submitReview(SCOPE, ["a>b"], "confirmed");
  assert.equal(entry.revision, 2);
  assert.equal(entry.overview.reviewCount, 1);
  assert.deepEqual(backend.calls.at(-1).request, {
    connectionId: "c1",
    database: "Game_Config",
    relationIds: ["a>b"],
    verdict: "confirmed",
  });
  await relations.tableRelations(SCOPE, "HeroProp");
  assert.equal(backend.count("config_relations_table"), 2);
  assert.equal(await relations.tableRelations(SCOPE, " "), null);
});

test("refresh, review lists and client changes keep the overview current", async () => {
  const backend = fakeBackend();
  const relations = useConfigRelations({ invoke: backend.invoke, listen: null, debounceMs: 0 });
  const entry = relations.entryFor(SCOPE);

  await relations.refresh(SCOPE);
  assert.deepEqual(backend.calls.map((call) => call.command), ["config_relations_refresh", "config_relations_overview"]);
  assert.equal(entry.overview.reviewCount, 2);

  backend.state.reviewCount = 1;
  await relations.reviewList(SCOPE);
  assert.equal(entry.overview.reviewCount, 1);

  await relations.bindClient(SCOPE, "D:\\client\\jswz");
  assert.equal(entry.overview.client, "D:\\client\\jswz");
  assert.equal(entry.revision, 2);
  await relations.unbindClient(SCOPE);
  assert.equal(entry.overview.client, null);

  await relations.submitReview(SCOPE, "not-a-list", undefined);
  assert.deepEqual(backend.calls.at(-1).request.relationIds, []);
  assert.equal(backend.calls.at(-1).request.verdict, null, "a missing verdict restores the relation");
});

test("lookups without a usable scope resolve quietly", async () => {
  const backend = fakeBackend();
  const relations = useConfigRelations({ invoke: backend.invoke, listen: null });
  const none = { connectionId: "c1", database: "" };
  assert.equal(await relations.loadOverview(none), null);
  assert.equal(await relations.rowTargets(none, "hero", {}), null);
  assert.equal(await relations.rowReferences(none, "hero", {}), null);
  assert.deepEqual(await relations.discoverClients(none), []);
  assert.equal(await relations.submitReview(none, ["x"], "confirmed"), null);
  assert.equal(backend.calls.length, 0);

  await relations.rowTargets(SCOPE, "hero", { ID: 1 }, "grid");
  assert.deepEqual(backend.calls.at(-1), {
    command: "config_relations_row_targets",
    request: { connectionId: "c1", database: "Game_Config", table: "hero", row: { ID: 1 }, channel: "grid" },
  });
});
