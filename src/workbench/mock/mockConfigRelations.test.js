import test from "node:test";
import assert from "node:assert/strict";

import { createMockConfigRelations, mockRelationId, relationRowMatches } from "./mockConfigRelations.js";
import { resolveMockSchema } from "./mockSchema.js";

const NOW = "2026-02-01 09:00";
const UPDATED_EVENT = "config-relations-updated";

const CONNECTIONS = {
  demo: { id: "demo", kind: "mysql", host: "demo", port: 3306 },
  staging: { id: "staging", kind: "mysql", host: "staging.local", port: 3306 },
  "demo-test": { id: "demo-test", kind: "mysql", host: "test.local", port: 3307 },
  fixture: { id: "fixture", kind: "mysql", host: "fixture", port: 3306, sampleData: true },
  mongo: { id: "mongo", kind: "mongodb", host: "127.0.0.1", port: 27017 },
};

function fixtureRows() {
  return {
    skill: [{ id: "101", name: "Fireball" }, { id: "102", name: "" }],
    quest: [
      { id: "1", reward_item_id: "1001" },
      { id: "2", reward_item_id: "1002" },
      { id: "3", reward_item_id: null },
    ],
    activity: [
      { id: "1", reward_pool: '[{"ID":1001,"Num":2},{"ID":1003,"Num":1}]' },
      { id: "2", reward_pool: '[{"id":"1001"}]' },
      { id: "3", reward_pool: "[]" },
    ],
  };
}

function setup({ delayMs = 0 } = {}) {
  const rows = fixtureRows();
  const events = [];
  const relations = createMockConfigRelations({
    connectionFor: (id) => CONNECTIONS[id] || null,
    schemaFor: (connectionId, database) => resolveMockSchema(connectionId, database, { tableCount: 0 }),
    rowsFor: (_connectionId, _database, table) => rows[table] || [],
    delayMs,
    emit: (name, payload) => events.push({ name, payload }),
    now: () => NOW,
  });
  const call = (command, request = {}) =>
    relations.invoke(command, { request: { connectionId: "demo", database: "game_db", ...request } });
  return { relations, events, call, rows };
}

const byId = (views, id) => views.find((view) => view.id === id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the demo server opens bound to the jswz client with a little history to review", async () => {
  const { call } = setup();
  const overview = await call("config_relations_overview");
  assert.equal(overview.codeStatus, "ready");
  assert.deepEqual(overview.client, {
    path: "D:\\client\\jswz",
    dialect: "jswz",
    confirmedAt: "2026-01-05 10:12",
    exists: true,
  });
  assert.equal(overview.codeFiles, 1286);
  assert.equal(overview.codeScannedAt, NOW);
  assert.equal(overview.reviewCount, 2);
  assert.equal(overview.totals.stale, 1);
  assert.equal(overview.totals.conflict, 1);
  assert.equal(overview.totals.newUnconfirmed, 0);

  const monster = await call("config_relations_table", { table: "monster" });
  assert.equal(byId(monster.outgoing, "monster.skill_id_2>skill.id").reason, "codeChanged");
  const shop = await call("config_relations_table", { table: "shop" });
  const conflict = byId(shop.outgoing, "shop.item_id>item.id");
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.codeTarget, "equip.id");
  const codeOnly = byId(shop.outgoing, "shop.item_id>equip.id");
  assert.equal(codeOnly.status, "confirmed");
  assert.equal(codeOnly.reason, "codeOnly");
  const hero = await call("config_relations_table", { table: "hero" });
  const passive = byId(hero.outgoing, "hero.passive_id>skill.id");
  assert.equal(passive.status, "confirmed");
  assert.equal(passive.reason, "codeOnly");
  assert.equal(passive.isNew, false);
  assert.equal(byId(hero.outgoing, "hero.skill_id>skill.id").reason, "matchesCode");
  assert.deepEqual(hero.tables.skill, { name: "skill", comment: "技能配置表", columns: { id: "技能ID" } });

  const item = await call("config_relations_table", { table: "item" });
  assert.deepEqual(item.coverage.gaps.map((gap) => gap.code), ["untracedLookups"]);
  assert.equal(item.coverage.gaps[0].samples[0].file, "assets/scripts/bag/BagModel.ts");
  const player = await call("config_relations_table", { table: "player" });
  assert.deepEqual(player.coverage, { complete: false, gaps: [{ code: "notUsedByClient" }] });
});

test("confirming a conflict or a stale relation clears its reminder", async () => {
  const { call, events } = setup();
  await call("config_relations_overview");
  let overview = await call("config_relations_review", { relationIds: ["shop.item_id>item.id"], verdict: "confirmed" });
  assert.equal(overview.reviewCount, 1);
  const settled = byId((await call("config_relations_table", { table: "shop" })).outgoing, "shop.item_id>item.id");
  assert.equal(settled.status, "confirmed");
  assert.equal(settled.reason, "manual");
  assert.equal(settled.codeTarget, undefined);
  assert.equal(settled.decidedAt, NOW);

  overview = await call("config_relations_review", { relationIds: ["monster.skill_id_2>skill.id"], verdict: "confirmed" });
  assert.equal(overview.reviewCount, 0);
  const monster = await call("config_relations_table", { table: "monster" });
  assert.equal(byId(monster.outgoing, "monster.skill_id_2>skill.id").reason, "manual");

  const last = events.filter((event) => event.name === UPDATED_EVENT).at(-1);
  assert.deepEqual(last.payload, {
    connectionId: "demo",
    database: "game_db",
    revision: overview.revision,
    reviewCount: 0,
  });
  const list = await call("config_relations_review_list");
  assert.equal(list.items.length, 0);
  assert.equal(list.overview.reviewCount, 0);
});

test("a rejected relation leaves the row lookups until it is restored", async () => {
  const { call } = setup();
  const id = "quest.reward_item_id>item.id";
  await call("config_relations_review", { relationIds: [id], verdict: "rejected" });
  assert.equal(byId((await call("config_relations_table", { table: "quest" })).outgoing, id).status, "rejected");
  const targets = await call("config_relations_row_targets", {
    table: "quest",
    row: { id: "1", reward_item_id: "1001", pre_quest: "2" },
  });
  assert.equal(targets.outgoing.some((item) => item.relationId === id), false);
  assert.equal(targets.outgoing.some((item) => item.relationId === "quest.pre_quest>quest.id"), true);

  await call("config_relations_review", { relationIds: [id], verdict: null });
  assert.equal(byId((await call("config_relations_table", { table: "quest" })).outgoing, id).reason, "matchesCode");
  await assert.rejects(call("config_relations_review", { relationIds: [id], verdict: "maybe" }), /未知的复核结论/);
});

test("row lookups label found targets, flag missing ones and count references", async () => {
  const { call } = setup();
  const targets = await call("config_relations_row_targets", {
    table: "hero",
    row: { id: "1", skill_id: 101, passive_id: "999" },
  });
  assert.deepEqual(
    targets.outgoing.find((item) => item.relationId === "hero.skill_id>skill.id").targets,
    [{ value: "101", state: "found", label: "Fireball" }],
  );
  assert.deepEqual(
    targets.outgoing.find((item) => item.relationId === "hero.passive_id>skill.id").targets,
    [{ value: "999", state: "missing" }],
  );
  const unlabeled = await call("config_relations_row_targets", { table: "hero", row: { skill_id: "102", passive_id: "0" } });
  assert.deepEqual(
    unlabeled.outgoing.find((item) => item.relationId === "hero.skill_id>skill.id").targets,
    [{ value: "102", state: "found" }],
  );
  assert.deepEqual(unlabeled.outgoing.find((item) => item.relationId === "hero.passive_id>skill.id").targets, []);

  const references = await call("config_relations_row_references", { table: "item", row: { id: "1001", name: "Potion" } });
  const counts = Object.fromEntries(references.incoming.map((item) => [item.relationId, item.count]));
  assert.equal(counts["quest.reward_item_id>item.id"], 1);
  assert.equal(counts["activity.reward_pool[]>item.id"], 2);
  assert.equal(counts["shop.item_id>item.id"], 0);
  assert.deepEqual((await call("config_relations_row_references", { table: "item", row: { id: "0" } })).incoming, []);
});

test("the graph lists every relation of the database without evidence", async () => {
  const { call } = setup();
  const graph = await call("config_relations_graph");
  const table = await call("config_relations_table", { table: "hero" });
  assert.equal(graph.revision, table.revision);
  const passive = byId(graph.edges, "hero.passive_id>skill.id");
  assert.deepEqual(Object.keys(passive).sort(), ["id", "kind", "sourceColumn", "sourceTable", "status", "targetColumn", "targetTable"]);
  assert.equal(passive.status, "confirmed");
  for (const relation of [...table.outgoing, ...table.incoming]) {
    assert.equal(byId(graph.edges, relation.id)?.status, relation.status);
  }
  assert.deepEqual(graph.tables.skill, { name: "skill", comment: "技能配置表", columns: { id: "技能ID" } });
});

test("list relations carry their data format as evidence", async () => {
  const { call, rows } = setup();
  const activity = await call("config_relations_table", { table: "activity" });
  const pool = byId(activity.outgoing, "activity.reward_pool[]>item.id");
  assert.equal(pool.kind, "list");
  assert.deepEqual(pool.evidence.find((evidence) => evidence.type === "format"), {
    type: "format",
    sample: rows.activity[0].reward_pool,
  });
  assert.equal(pool.reason, "manual");
});

test("every database of a server shares the client binding and the decisions", async () => {
  const { call, events } = setup();
  await call("config_relations_overview");
  const config = await call("config_relations_overview", { database: "game_config" });
  assert.equal(config.client.path, "D:\\client\\jswz");
  await call("config_relations_review", { relationIds: ["hero.passive_id>skill.id"], verdict: "confirmed" });
  const hero = await call("config_relations_table", { database: "game_config", table: "hero" });
  assert.equal(byId(hero.outgoing, "hero.passive_id>skill.id").reason, "manual");
  assert.ok(events.some((event) => event.name === UPDATED_EVENT && event.payload.database === "game_config"));

  const staging = await call("config_relations_overview", { connectionId: "staging" });
  assert.equal(staging.client, null);
  assert.equal(staging.codeStatus, "noClient");
  const shop = await call("config_relations_table", { connectionId: "staging", table: "shop" });
  const commentOnly = byId(shop.outgoing, "shop.item_id>item.id");
  assert.equal(commentOnly.status, "confirmed");
  assert.equal(commentOnly.reason, "commentWithoutClient");
});

test("switching clients rechecks what the new client no longer reads", async () => {
  const { call } = setup();
  await call("config_relations_overview");
  let overview = await call("config_relations_unbind_client");
  assert.equal(overview.client, null);
  assert.equal(overview.clientDeclined, true);
  assert.equal(overview.codeStatus, "noClient");
  assert.equal(overview.reviewCount, 0, "without code nothing can be judged stale");
  const shop = await call("config_relations_table", { table: "shop" });
  assert.equal(byId(shop.outgoing, "shop.item_id>item.id").reason, "commentWithoutClient");
  assert.deepEqual(shop.coverage.gaps, [{ code: "noClient" }]);

  overview = await call("config_relations_bind_client", { path: "D:/Versions/nzg/" });
  assert.equal(overview.client.path, "D:\\Versions\\nzg");
  assert.equal(overview.clientDeclined, false);
  assert.equal(overview.client.dialect, "nzg");
  assert.equal(overview.codeStatus, "ready");
  assert.ok(overview.reviewCount > 2);
  assert.equal(byId((await call("config_relations_table", { table: "quest" })).outgoing, "quest.reward_item_id>item.id").reason, "codeRemoved");
  assert.equal(byId((await call("config_relations_table", { table: "hero" })).outgoing, "hero.skill_id>skill.id").reason, "matchesCode");

  overview = await call("config_relations_bind_client", { path: "D:\\client\\jswz" });
  assert.equal(overview.reviewCount, 2, "the matching client settles them again");
});

test("client discovery ranks folders by matching tables and refuses other games", async () => {
  const { call } = setup();
  const candidates = await call("config_relations_discover_clients");
  assert.deepEqual(
    candidates.map((candidate) => [candidate.path, candidate.matchedTables, candidate.recommended]),
    [["D:\\client\\jswz", 14, true], ["D:\\Versions\\nzg", 3, false]],
  );
  assert.equal(candidates[0].totalTables, 24);
  assert.equal((await call("config_relations_inspect_client", { path: "d:\\versions\\NZG" })).dialect, "nzg");
  await assert.rejects(call("config_relations_inspect_client", { path: "E:\\nowhere" }), /找不到这个目录/);

  const archive = { connectionId: "demo-test", database: "game_db_archive" };
  assert.deepEqual(await call("config_relations_discover_clients", archive), []);
  await assert.rejects(
    call("config_relations_bind_client", { ...archive, path: "D:\\client\\jswz" }),
    /没有当前数据库的任何配置表/,
  );
});

test("only real MySQL databases are supported", async () => {
  const { call, relations } = setup();
  await assert.rejects(call("config_relations_overview", { connectionId: "mongo" }), /只支持 MySQL/);
  await assert.rejects(call("config_relations_overview", { connectionId: "fixture" }), /只支持 MySQL/);
  await assert.rejects(call("config_relations_overview", { connectionId: "missing" }), /连接不存在/);
  await assert.rejects(call("config_relations_overview", { database: " " }), /请先选择数据库/);
  await assert.rejects(call("config_relations_unknown"), /not implemented/);
  assert.equal(await relations.invoke("config_relations_pick_client_dir"), null);
  assert.equal(relations.handles("config_relations_overview"), true);
  assert.equal(relations.handles("fetch_table_page"), false);
});

test("code analysis and refreshes run in the background", async () => {
  const { call, relations } = setup({ delayMs: 15 });
  try {
    const pending = await call("config_relations_overview");
    assert.equal(pending.codeStatus, "pending");
    assert.equal(pending.analyzing, true);
    assert.equal(pending.reviewCount, 0, "staleness waits for the code");
    const hero = await call("config_relations_table", { table: "hero" });
    assert.deepEqual(hero.coverage.gaps.map((gap) => gap.code), ["analyzing"]);
    await sleep(40);
    const ready = await call("config_relations_overview");
    assert.equal(ready.codeStatus, "ready");
    assert.equal(ready.reviewCount, 2);

    const beforeRefresh = (await call("config_relations_overview")).revision;
    assert.equal(await call("config_relations_refresh"), null);
    assert.equal((await call("config_relations_overview")).refreshing, true);
    await sleep(40);
    assert.equal((await call("config_relations_overview")).refreshing, false);
    assert.ok((await call("config_relations_overview")).revision > beforeRefresh);
  } finally {
    relations.reset();
  }
});

test("reset brings back the seeded history", async () => {
  const { call, relations } = setup();
  await call("config_relations_review", { relationIds: ["shop.item_id>item.id"], verdict: "confirmed" });
  assert.equal((await call("config_relations_overview")).reviewCount, 1);
  relations.reset();
  assert.equal((await call("config_relations_overview")).reviewCount, 2);
});

test("in-memory row matching follows the backend relation filter", () => {
  const columns = [{ column_name: "skill_id" }, { column_name: "reward_pool" }];
  const list = (values) => ({ column: "reward_pool", kind: "listContains", values });
  assert.equal(relationRowMatches({ skill_id: " 7 " }, columns, { column: "SKILL_ID", values: ["7"] }), true);
  assert.equal(relationRowMatches({ skill_id: "8" }, columns, { column: "skill_id", values: ["7"] }), false);
  assert.equal(relationRowMatches({ skill_id: null }, columns, { column: "skill_id", values: ["7"] }), false);
  assert.equal(relationRowMatches({ skill_id: "7" }, columns, { column: "missing", values: ["7"] }), false);
  assert.equal(relationRowMatches({ skill_id: "8" }, columns, { column: "skill_id", values: [] }), true);
  assert.equal(relationRowMatches({ reward_pool: '[{"ID":7,"Num":1}]' }, columns, list(["7"])), true);
  assert.equal(relationRowMatches({ reward_pool: '[{"ID":17}]' }, columns, list(["7"])), false);
  assert.equal(relationRowMatches({ reward_pool: "7" }, columns, list(["7"])), false);
  assert.equal(
    mockRelationId({ sourceTable: "activity", sourceColumn: "Reward_Pool", targetTable: "item", targetColumn: "ID", kind: "list" }),
    "activity.reward_pool[]>item.id",
  );
});

test("explicit comment directives override mock catalog relations", async () => {
  const schema = structuredClone(resolveMockSchema("demo", "game_db", { tableCount: 0 }));
  const rows = fixtureRows();
  const relations = createMockConfigRelations({
    connectionFor: (id) => CONNECTIONS[id] || null,
    schemaFor: () => schema,
    rowsFor: (_connectionId, _database, table) => rows[table] || [],
    delayMs: 0,
    emit: () => {},
    now: () => NOW,
  });
  const call = (command, request = {}) =>
    relations.invoke(command, { request: { connectionId: "demo", database: "game_db", ...request } });
  const shop = schema.find((table) => table.table_name === "shop");
  const itemCol = shop.columns.find((col) => col.column_name === "item_id");

  itemCol.column_comment = "商店商品 [无关联]";
  let tableRes = await call("config_relations_table", { table: "shop" });
  assert.equal(tableRes.outgoing.filter((rel) => rel.sourceColumn === "item_id").length, 0);

  itemCol.column_comment = "品质档位 [枚举: 1=蓝, 2=紫, 3=橙]";
  tableRes = await call("config_relations_table", { table: "shop" });
  assert.equal(tableRes.outgoing.filter((rel) => rel.sourceColumn === "item_id").length, 0);

  itemCol.column_comment = "强制指向道具 [关联: item.id]";
  tableRes = await call("config_relations_table", { table: "shop" });
  const outgoing = tableRes.outgoing.filter((rel) => rel.sourceColumn === "item_id");
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].targetTable, "item");
  assert.equal(outgoing[0].status, "confirmed");
});
