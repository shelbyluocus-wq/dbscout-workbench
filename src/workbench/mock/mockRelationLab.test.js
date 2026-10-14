import test from "node:test";
import assert from "node:assert/strict";

// The lab is chosen by the page address; this test file runs in its own process.
globalThis.location = { search: "?relationLab=300" };

const lab = await import("./mockRelationLab.js");
const { createMockConfigRelations } = await import("./mockConfigRelations.js");
const { resolveMockSchema } = await import("./mockSchema.js");
const { getOrInitRows } = await import("./mockRows.js");
const { databaseRelationGraph, localRelationGraph } = await import("../utils/relationGraph.js");

test("the lab size comes from the address, within limits", () => {
  assert.equal(lab.requestedRelationLabSize("?relationLab=300"), 300);
  assert.equal(lab.requestedRelationLabSize("?relationLab=9"), lab.RELATION_LAB_SIZE.min);
  assert.equal(lab.requestedRelationLabSize("?relationLab=99999"), lab.RELATION_LAB_SIZE.max);
  assert.equal(lab.requestedRelationLabSize("?relationLab=abc"), 0);
  assert.equal(lab.requestedRelationLabSize(""), 0);
});

test("the same size always generates the same database, with real columns and rows", () => {
  const schema = lab.relationLabSchema(300);
  assert.equal(schema.length, 300);
  assert.equal(new Set(schema.map((table) => table.table_name)).size, 300, "unique names");
  assert.deepEqual(lab.relationLabRelations(300), lab.relationLabRelations(300));
  const tables = new Map(schema.map((table) => [table.table_name, table]));
  for (const relation of lab.relationLabRelations(300)) {
    const [source, column] = relation.from.split(".");
    const [target] = relation.to.split(".");
    assert.ok(tables.get(source)?.columns.some((item) => item.column_name === column), relation.from);
    assert.ok(tables.has(target), relation.to);
  }
  const rows = lab.relationLabRows("item_level", 300);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => Number(row.item_id) >= 1 && Number(row.item_id) <= 4), "references point at rows that exist");
  assert.equal(lab.isRelationLabTable("ITEM", 300), true);
  assert.equal(lab.isRelationLabTable("nothing", 300), false);
});

test("the demo server shows the lab database with hubs, conflicts and stale relations", async () => {
  assert.equal(resolveMockSchema("demo", lab.RELATION_LAB_DATABASE).length, 300);
  assert.equal(getOrInitRows("demo", lab.RELATION_LAB_DATABASE, "item_level").length, 4);
  const relations = createMockConfigRelations({
    connectionFor: (id) => (id === "demo" ? { id: "demo", kind: "mysql", host: "demo", port: 3306 } : null),
    schemaFor: (connectionId, database) => resolveMockSchema(connectionId, database, { tableCount: 0 }),
    rowsFor: (connectionId, database, table) => getOrInitRows(connectionId, database, table),
    delayMs: 0,
    emit: () => {},
  });
  const request = { connectionId: "demo", database: lab.RELATION_LAB_DATABASE };
  const graph = await relations.invoke("config_relations_graph", { request });
  const statuses = new Set(graph.edges.map((edge) => edge.status));
  assert.ok(statuses.has("confirmed") && statuses.has("stale"), [...statuses].join());
  assert.ok(graph.edges.length > 300);
  const whole = databaseRelationGraph(graph, "item");
  assert.ok(whole.nodes.length > 250);
  const one = localRelationGraph(graph, "item", { depth: 1 });
  const two = localRelationGraph(graph, "item", { depth: 2 });
  assert.ok(one.nodes.length > 60, "item is a hub");
  assert.ok(two.nodes.length > one.nodes.length, "depth 2 adds tables");
  const table = await relations.invoke("config_relations_table", { request: { ...request, table: "item_level" } });
  assert.ok(!table.coverage.gaps.some((gap) => gap.code === "notUsedByClient"), "the bound client reads lab tables");
});
