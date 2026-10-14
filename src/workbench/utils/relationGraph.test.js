import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GRAPH_OPTIONS,
  GRAPH_MAX_NODES,
  GRAPH_OPTIONS_STORAGE_KEY,
  RING_GRAPH_MAX_NODES,
  databaseRelationGraph,
  depthChangeNotice,
  graphLabel,
  graphNeighbors,
  graphNodeRelations,
  graphStatuses,
  groupByOtherTable,
  layoutRelationGraph,
  loadGraphOptions,
  localRelationGraph,
  nodeRadius,
  saveGraphOptions,
  worseStatus,
} from "./relationGraph.js";

function edge(source, target, { column = "id", status = "confirmed" } = {}) {
  return {
    id: `${source}.${column}>${target}.id`,
    sourceTable: source,
    sourceColumn: column,
    targetTable: target,
    targetColumn: "id",
    kind: "value",
    status,
  };
}

// hero -> skill, hero -> item (two columns), quest -> hero, shop -> item,
// skill -> buff, item <-> equip, hero -> hero, monster -> skill (rejected).
const GRAPH = {
  edges: [
    edge("hero", "skill", { column: "skill_id" }),
    edge("hero", "item", { column: "drop_id", status: "stale" }),
    edge("hero", "item", { column: "cost_id" }),
    edge("Quest", "hero", { column: "hero_id", status: "unconfirmed" }),
    edge("shop", "item", { column: "item_id", status: "conflict" }),
    edge("skill", "buff", { column: "buff_id" }),
    edge("item", "equip", { column: "equip_id" }),
    edge("equip", "item", { column: "item_id" }),
    edge("hero", "hero", { column: "parent_id", status: "stale" }),
    edge("monster", "skill", { column: "skill_id", status: "rejected" }),
  ],
  tables: {},
};

const ids = (local) => local.nodes.map((node) => node.id).sort();
const node = (local, id) => local.nodes.find((item) => item.id === id);

test("depth 1 shows direct neighbours in both directions and drops rejected relations", () => {
  const local = localRelationGraph(GRAPH, "HERO");
  assert.equal(local.center, "hero");
  assert.deepEqual(ids(local), ["hero", "item", "quest", "skill"]);
  assert.equal(node(local, "skill").side, "out");
  assert.equal(node(local, "quest").side, "in");
  assert.equal(local.hidden, 0);
});

test("relations between the same two tables merge into one line with the worst status", () => {
  const local = localRelationGraph(GRAPH, "hero");
  const heroItem = local.links.find((link) => link.id === "hero\u001fitem");
  assert.equal(heroItem.relations.length, 2);
  assert.equal(heroItem.status, "stale");
  assert.equal(heroItem.forward, true);
  assert.equal(heroItem.backward, false);
  const questHero = local.links.find((link) => link.id === "hero\u001fquest");
  assert.equal(questHero.forward, false, "quest -> hero runs from the second table to the first");
  assert.equal(questHero.backward, true);
});

test("self references mark the node instead of drawing a line", () => {
  const local = localRelationGraph(GRAPH, "hero");
  assert.equal(local.links.some((link) => link.source === link.target), false);
  assert.equal(node(local, "hero").selfStatus, "stale");
  assert.equal(node(local, "hero").issue, "stale");
  assert.equal(node(local, "skill").issue, "");
});

test("direction toggles choose which neighbours are reached", () => {
  assert.deepEqual(ids(localRelationGraph(GRAPH, "hero", { incoming: false })), ["hero", "item", "skill"]);
  assert.deepEqual(ids(localRelationGraph(GRAPH, "hero", { outgoing: false })), ["hero", "quest"]);
  const both = localRelationGraph(GRAPH, "hero", { outgoing: false, incoming: false });
  assert.deepEqual(both.options, { depth: 1, outgoing: true, incoming: true, maxNodes: GRAPH_MAX_NODES }, "turning both off falls back to both on");
});

test("depth 2 reaches neighbours of neighbours and keeps their parent's side", () => {
  const local = localRelationGraph(GRAPH, "hero", { depth: 2 });
  assert.deepEqual(ids(local), ["buff", "equip", "hero", "item", "quest", "shop", "skill"]);
  assert.equal(node(local, "buff").depth, 2);
  assert.equal(node(local, "buff").parent, "skill");
  assert.equal(node(local, "buff").side, "out");
  assert.equal(node(local, "shop").issue, "conflict");
  assert.equal(localRelationGraph(GRAPH, "hero", { depth: 9 }).options.depth, 2);
});

test("a table both referencing and referenced by the center is on both sides", () => {
  const local = localRelationGraph(GRAPH, "item");
  assert.equal(node(local, "equip").side, "both");
  const link = local.links.find((item) => item.id === "equip\u001fitem");
  assert.equal(link.forward && link.backward, true);
});

test("the node cap hides the rest and reports how many", () => {
  const local = localRelationGraph(GRAPH, "hero", { depth: 2, maxNodes: 3 });
  assert.equal(local.nodes.length, 3);
  assert.equal(local.hidden, 4);
});

test("node size follows how many other tables reference it", () => {
  const local = localRelationGraph(GRAPH, "hero", { depth: 2 });
  assert.equal(node(local, "item").referencedBy, 3, "hero, shop and equip");
  assert.equal(node(local, "hero").referencedBy, 1, "its self reference does not count");
  assert.ok(node(local, "item").radius > node(local, "buff").radius);
  assert.equal(nodeRadius(0), 6);
  assert.equal(nodeRadius(10_000), 16);
  assert.equal(nodeRadius(0, { center: true }), 11);
});

test("an unknown center still shows itself alone", () => {
  const local = localRelationGraph(GRAPH, "nowhere");
  assert.deepEqual(ids(local), ["nowhere"]);
  assert.deepEqual(local.links, []);
  assert.equal(localRelationGraph(GRAPH, " "), null);
  assert.deepEqual(ids(localRelationGraph(null, "hero")), ["hero"]);
});

test("the layout puts referenced tables on the right and referencing ones on the left", () => {
  const local = localRelationGraph(GRAPH, "hero");
  const layout = layoutRelationGraph(local);
  assert.deepEqual(layout.positions.get("hero"), { x: 0, y: 0, label: "hero" });
  const outgoing = ["item", "skill"].map((id) => layout.positions.get(id).x);
  assert.ok(outgoing.every((x) => x > 0), "outgoing tables sit right of the center");
  assert.ok(layout.positions.get("quest").x < 0, "incoming tables sit left of the center");
  for (const position of layout.positions.values()) {
    assert.ok(position.x >= layout.bounds.x && position.x <= layout.bounds.x + layout.bounds.width);
    assert.ok(position.y >= layout.bounds.y && position.y <= layout.bounds.y + layout.bounds.height);
  }
});

test("the layout is the same every time and the outer ring sits further out", () => {
  const local = localRelationGraph(GRAPH, "hero", { depth: 2 });
  const first = layoutRelationGraph(local);
  const second = layoutRelationGraph(localRelationGraph(GRAPH, "hero", { depth: 2 }));
  assert.deepEqual([...first.positions], [...second.positions]);
  const distance = (id) => Math.hypot(first.positions.get(id).x, first.positions.get(id).y);
  assert.ok(distance("buff") > distance("skill"));
  assert.equal(layoutRelationGraph(null), null);
});

test("an incoming-only first ring is centred on the left", () => {
  const layout = layoutRelationGraph(localRelationGraph(GRAPH, "hero", { outgoing: false }));
  const quest = layout.positions.get("quest");
  assert.ok(quest.x < 0 && Math.abs(quest.y) < 1e-9);
});

test("a table's drawn relations split into made, received and self, with their columns", () => {
  const local = localRelationGraph({
    edges: [
      edge("item", "drop", { column: "drop_id" }),
      edge("activity", "item", { column: "reward_pool", status: "unconfirmed" }),
      edge("mail", "item", { column: "item_id" }),
      edge("mail", "item", { column: "extra_item" }),
      edge("item", "item", { column: "upgrade_to" }),
      edge("item", "hidden", { column: "x", status: "rejected" }),
    ],
  }, "item");
  const relations = graphNodeRelations(local, "item");
  assert.deepEqual(relations.references.map((r) => `${r.sourceColumn}>${r.targetTable}`), ["drop_id>drop"]);
  assert.deepEqual(
    relations.referencedBy.map((r) => `${r.sourceTable}.${r.sourceColumn}:${r.status}`),
    ["activity.reward_pool:unconfirmed", "mail.extra_item:confirmed", "mail.item_id:confirmed"],
  );
  assert.deepEqual(relations.self.map((r) => r.sourceColumn), ["upgrade_to"]);
  // From a neighbour's side only its own lines count.
  const mail = graphNodeRelations(local, "mail");
  assert.equal(mail.references.length, 2);
  assert.equal(mail.referencedBy.length, 0);
  assert.deepEqual(graphNodeRelations(null, "item"), { references: [], referencedBy: [], self: [] });
});

test("a large view stretches the rings but not the center", () => {
  const local = localRelationGraph(GRAPH, "hero", { depth: 2 });
  const compact = layoutRelationGraph(local);
  const stretched = layoutRelationGraph(local, undefined, { spread: { x: 2.5, y: 1.5 } });
  assert.deepEqual(stretched.positions.get("hero"), compact.positions.get("hero"));
  for (const id of ["skill", "buff", "quest"]) {
    assert.ok(Math.abs(stretched.positions.get(id).x - compact.positions.get(id).x * 2.5) < 1e-9);
    assert.ok(Math.abs(stretched.positions.get(id).y - compact.positions.get(id).y * 1.5) < 1e-9);
  }
  assert.ok(stretched.bounds.width > compact.bounds.width);
  assert.deepEqual(stretched.extent, compact.extent, "the extent describes the compact rings");
  assert.ok(compact.extent.width > 0 && compact.extent.height > 0);
});

test("the info card lists each other table once with its fields", () => {
  const relations = [
    edge("hero", "skill", { column: "skill_id" }),
    edge("hero", "skill", { column: "passive_id", status: "stale" }),
    edge("hero", "item", { column: "cost_id" }),
  ];
  const groups = groupByOtherTable(relations, "hero");
  assert.deepEqual(groups.map((group) => group.table), ["item", "skill"]);
  assert.equal(groups[1].relations.length, 2);
  assert.equal(groups[1].status, "stale");
  const incoming = groupByOtherTable([edge("quest", "hero", { column: "hero_id" })], "hero");
  assert.deepEqual(incoming.map((group) => group.table), ["quest"]);
  assert.deepEqual(groupByOtherTable(null, "hero"), []);
});

test("neighbours, statuses and labels", () => {
  const local = localRelationGraph(GRAPH, "hero");
  assert.deepEqual([...graphNeighbors(local, "skill")].sort(), ["hero", "skill"]);
  assert.equal(graphNeighbors(local, "").size, 0);

  assert.deepEqual(graphStatuses(local), ["confirmed", "unconfirmed", "stale"]);
  assert.equal(worseStatus("confirmed", "conflict"), "conflict");
  assert.equal(worseStatus("", "stale"), "stale");
  assert.equal(graphLabel("short"), "short");
  assert.equal(graphLabel("a_really_long_config_table_name"), "a_really_long_con…");
});

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
    data,
  };
}

test("view options persist and bad saved values fall back to defaults", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadGraphOptions(storage), DEFAULT_GRAPH_OPTIONS);
  saveGraphOptions({ collapsed: true, depth: 2, outgoing: false, incoming: true, height: 400 }, storage);
  assert.deepEqual(loadGraphOptions(storage), { collapsed: true, depth: 2, outgoing: false, incoming: true, height: 400 });
  storage.data.set(GRAPH_OPTIONS_STORAGE_KEY, "{broken");
  assert.deepEqual(loadGraphOptions(storage), DEFAULT_GRAPH_OPTIONS);
  storage.data.set(GRAPH_OPTIONS_STORAGE_KEY, JSON.stringify({ depth: 7, outgoing: false, incoming: false, height: 9000 }));
  assert.deepEqual(loadGraphOptions(storage), { collapsed: false, depth: 2, outgoing: true, incoming: true, height: 640 });
  storage.data.set(GRAPH_OPTIONS_STORAGE_KEY, JSON.stringify({ height: "tall" }));
  assert.equal(loadGraphOptions(storage).height, DEFAULT_GRAPH_OPTIONS.height);
  storage.data.set(GRAPH_OPTIONS_STORAGE_KEY, JSON.stringify({ height: 20 }));
  assert.equal(loadGraphOptions(storage).height, 180);
  assert.deepEqual(loadGraphOptions(null), DEFAULT_GRAPH_OPTIONS);
});

test("second-ring tables gather beside the table that brought them in", () => {
  // item has four referencing tables beyond it; activity sees item alone in its first ring.
  const graph = {
    edges: [
      edge("activity", "item", { column: "reward" }),
      edge("drop", "item", { column: "item_id" }),
      edge("mail", "item", { column: "item_id" }),
      edge("quest", "item", { column: "item_id" }),
      edge("shop", "item", { column: "item_id" }),
    ],
  };
  const local = localRelationGraph(graph, "activity", { depth: 2 });
  const layout = layoutRelationGraph(local);
  const item = layout.positions.get("item");
  assert.ok(item.x > 0, "item sits right of activity");
  for (const id of ["drop", "mail", "quest", "shop"]) {
    const point = layout.positions.get(id);
    assert.ok(point.x > 0, `${id} stays on item's side`);
    assert.ok(Math.hypot(point.x - item.x, point.y - item.y) < Math.hypot(point.x, point.y), `${id} is nearer item than the center`);
  }
  // Neighbours on the ring keep their spacing.
  const ring = ["drop", "mail", "quest", "shop"].map((id) => layout.positions.get(id)).sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
  for (let index = 1; index < ring.length; index += 1) {
    assert.ok(Math.hypot(ring[index].x - ring[index - 1].x, ring[index].y - ring[index - 1].y) >= 40, "no two tables touch");
  }
});

test("a hub's neighbourhood is no longer cut at sixty tables, so both depths differ", () => {
  const edges = [];
  for (let index = 0; index < 150; index += 1) {
    edges.push(edge(`user_${index}`, "hub", { column: "hub_id" }));
    edges.push(edge(`detail_${index}`, `user_${index}`, { column: "user_id" }));
  }
  const data = { edges, tables: {} };
  const one = localRelationGraph(data, "hub", { depth: 1 });
  const two = localRelationGraph(data, "hub", { depth: 2 });
  assert.equal(one.nodes.length, 151);
  assert.equal(two.nodes.length, 301);
  assert.equal(one.hidden, 0);
  assert.ok(one.nodes.length > RING_GRAPH_MAX_NODES, "drawn by the large-graph view");
  assert.equal(one.scope, "local");
});

test("the whole database: every related table, the current one's reach marked", () => {
  const whole = databaseRelationGraph(GRAPH, "skill");
  assert.equal(whole.scope, "database");
  assert.deepEqual(ids(whole), ["buff", "equip", "hero", "item", "quest", "shop", "skill"], "rejected relations bring no table");
  const byId = new Map(whole.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("skill").depth, 0);
  assert.equal(byId.get("buff").side, "out");
  assert.equal(byId.get("hero").side, "in");
  assert.equal(byId.get("shop").depth, 3, "reached through hero and item");
  assert.equal(whole.links.length, 6, "one line per pair of tables");
  // A table without relations is no center; every table is still drawn.
  const nowhere = databaseRelationGraph(GRAPH, "mail");
  assert.equal(nowhere.nodes.length, 7);
  assert.ok(nowhere.nodes.every((node) => node.depth === -1 && node.side === "none"));
  // Past the limit the busiest tables stay.
  const limited = databaseRelationGraph(GRAPH, "", { maxNodes: 2 });
  assert.equal(limited.nodes.length, 2);
  assert.equal(limited.hidden, 5);
  assert.ok(limited.nodes.some((node) => node.id === "item"), "item is referenced most");
});

test("a depth switch always says what changed", () => {
  const say = (key, values) => `${key}:${JSON.stringify(values)}`;
  assert.equal(depthChangeNotice({ depth: 2, previousDepth: 1, before: 5, after: 9 }, say), 'relations.graph.depthGrew:{"depth":2,"count":4,"total":8}');
  assert.equal(depthChangeNotice({ depth: 2, previousDepth: 1, before: 5, after: 5 }, say), 'relations.graph.depthSame:{"depth":2}');
  assert.equal(depthChangeNotice({ depth: 1, previousDepth: 2, before: 9, after: 5 }, say), 'relations.graph.depthShrank:{"depth":1,"total":4}');
  assert.equal(depthChangeNotice({ depth: 1, previousDepth: 2, before: 5, after: 5 }, say), 'relations.graph.depthShrank:{"depth":1,"total":4}');
});
