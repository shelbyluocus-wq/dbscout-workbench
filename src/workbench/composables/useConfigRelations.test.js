import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG_RELATIONS_UPDATED_EVENT, configRelationsScopeKey, useConfigRelations } from "./useConfigRelations.js";

const SCOPE = { connectionId: "c1", database: "Game_Config" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a late relation response cannot restore an older graph or field link after a refresh", async () => {
  for (const [method, command] of [["tableRelations", "config_relations_table"], ["relationGraph", "config_relations_graph"]]) {
    let resolveOld;
    let revision = 1;
    let reads = 0;
    const relations = useConfigRelations({ listen: null, invoke: async (name) => {
      if (name === "config_relations_overview") return { revision };
      if (name === command) {
        if (++reads === 1) return new Promise((resolve) => { resolveOld = resolve; });
        return { revision, target: "conditionopencondprop" };
      }
    } });
    await relations.loadOverview(SCOPE);
    const old = relations[method](SCOPE, "shopprop");
    revision = 2;
    await relations.loadOverview(SCOPE);
    const fresh = await relations[method](SCOPE, "shopprop");
    resolveOld({ revision: 1, target: "conditionplatprop" });
    assert.equal((await old).target, fresh.target);
    assert.equal((await relations[method](SCOPE, "shopprop")).target, fresh.target);
    assert.equal(reads, 2);
    relations.dispose();
  }
});

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
      case "config_relations_graph":
        if (state.failGraph) throw new Error("graph offline");
        return { revision: state.revision, edges: [], tables: {} };
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

test("the inspector badge and the relation page share one table request", async () => {
  const backend = fakeBackend();
  const relations = useConfigRelations({ invoke: backend.invoke, listen: null, debounceMs: 0 });
  await relations.loadOverview(SCOPE);

  const [badge, page] = await Promise.all([
    relations.tableRelations(SCOPE, "HeroProp"),
    relations.tableRelations(SCOPE, "heroprop"),
  ]);
  assert.equal(badge, page);
  assert.equal(backend.count("config_relations_table"), 1);

  // A failed request is not cached; the next caller asks again.
  const failing = useConfigRelations({
    invoke: async (command, payload) => {
      if (command === "config_relations_table") {
        backend.calls.push({ command, request: payload.request });
        throw new Error("table offline");
      }
      return backend.invoke(command, payload);
    },
    listen: null,
    debounceMs: 0,
  });
  await assert.rejects(failing.tableRelations(SCOPE, "HeroProp"), /table offline/);
  await assert.rejects(failing.tableRelations(SCOPE, "HeroProp"), /table offline/);
  assert.equal(backend.count("config_relations_table"), 3);
});

test("the relation graph is shared by concurrent callers and cached per revision", async () => {
  const backend = fakeBackend();
  const relations = useConfigRelations({ invoke: backend.invoke, listen: null, debounceMs: 0 });
  await relations.loadOverview(SCOPE);

  const [first, second] = await Promise.all([relations.relationGraph(SCOPE), relations.relationGraph(SCOPE)]);
  assert.equal(first, second);
  assert.equal(backend.count("config_relations_graph"), 1);
  await relations.relationGraph({ connectionId: "c1", database: "game_config" });
  assert.equal(backend.count("config_relations_graph"), 1);

  await relations.submitReview(SCOPE, ["a>b"], "confirmed");
  await relations.relationGraph(SCOPE);
  assert.equal(backend.count("config_relations_graph"), 2);

  backend.state.revision += 1;
  await relations.loadOverview(SCOPE, { force: true });
  backend.state.failGraph = true;
  await assert.rejects(relations.relationGraph(SCOPE), /graph offline/);
  backend.state.failGraph = false;
  await relations.relationGraph(SCOPE);
  assert.equal(backend.count("config_relations_graph"), 4, "a failed request is not cached");
  assert.equal(await relations.relationGraph({ connectionId: "", database: "x" }), null);
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

test("the recommended folder is bound on its own", async () => {
  const invoke = async (command, payload = {}) => {
    if (command === "config_relations_overview") {
      return { revision: 1, reviewCount: 0, client: null, clientDeclined: false };
    }
    if (command === "config_relations_discover_clients") {
      return [{ path: "D:\\client\\jswz", recommended: true, matchedTables: 10, totalTables: 12 }];
    }
    if (command === "config_relations_bind_client") {
      return { revision: 2, reviewCount: 0, client: { path: payload.request.path }, clientDeclined: false };
    }
    return null;
  };
  const relations = useConfigRelations({ invoke, listen: null, debounceMs: 0 });
  const entry = relations.entryFor(SCOPE);
  const overview = await relations.loadOverview(SCOPE);
  assert.equal(overview.client, null, "opening the database does not wait for the folder scan");
  await sleep(20);
  assert.equal(entry.overview.client.path, "D:\\client\\jswz");
  assert.equal(entry.autoBinding, false);
});

test("an unbound database adopts the recommended client without asking first", async () => {
  let releaseDiscover;
  const discoverGate = new Promise((resolve) => {
    releaseDiscover = resolve;
  });
  const binds = [];
  const invoke = async (command, payload = {}) => {
    if (command === "config_relations_overview") {
      return { revision: 1, reviewCount: 0, client: null, clientDeclined: false };
    }
    if (command === "config_relations_discover_clients") {
      await discoverGate;
      return [
        { path: "D:\\other", recommended: false },
        { path: "D:\\client\\jswz", recommended: true },
      ];
    }
    if (command === "config_relations_bind_client") {
      binds.push(payload.request.path);
      return {
        revision: 2,
        reviewCount: 0,
        client: { path: payload.request.path },
        clientDeclined: false,
      };
    }
    return null;
  };
  const relations = useConfigRelations({ invoke, listen: null, debounceMs: 0 });
  const entry = relations.entryFor(SCOPE);
  await relations.loadOverview(SCOPE);
  assert.equal(entry.autoBinding, true, "the overview is back before the folder is chosen");
  assert.deepEqual(binds, []);

  await relations.bindClient(SCOPE, "D:\\manual");
  releaseDiscover();
  await sleep(20);
  assert.deepEqual(binds, ["D:\\manual"], "a manual folder wins over the recommendation still being looked up");
  assert.equal(entry.autoBinding, false);
  assert.equal(entry.overview.client.path, "D:\\manual");
});

test("a removed client is not replaced by the recommendation", async () => {
  const commands = [];
  const invoke = async (command) => {
    commands.push(command);
    if (command === "config_relations_overview") {
      return { revision: 1, reviewCount: 0, client: null, clientDeclined: true };
    }
    return null;
  };
  const relations = useConfigRelations({ invoke, listen: null, debounceMs: 0 });
  await relations.loadOverview(SCOPE);
  await sleep(20);
  assert.deepEqual(commands, ["config_relations_overview"]);
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
