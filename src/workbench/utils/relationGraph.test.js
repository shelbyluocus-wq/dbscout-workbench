import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GRAPH_OPTIONS,
  GRAPH_OPTIONS_STORAGE_KEY,
  graphLabel,
  graphNeighbors,
  graphNodeRelations,
  graphStatuses,
  layoutRelationGraph,
  linkSegment,
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
  assert.deepEqual(both.options, { depth: 1, outgoing: true, incoming: true, maxNodes: 60 }, "turning both off falls back to both on");
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
  assert.deepEqual(layout.positions.get("hero"), { x: 0, y: 0, label: "hero", labelY: node(local, "hero").radius + 12 });
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

test("neighbours, segments, statuses and labels", () => {
  const local = localRelationGraph(GRAPH, "hero");
  assert.deepEqual([...graphNeighbors(local, "skill")].sort(), ["hero", "skill"]);
  assert.equal(graphNeighbors(local, "").size, 0);

  const positions = new Map([["a", { x: 0, y: 0 }], ["b", { x: 100, y: 0 }]]);
  const radii = new Map([["a", 8], ["b", 10]]);
  assert.deepEqual(linkSegment({ source: "a", target: "b" }, positions, radii), { x1: 10, y1: 0, x2: 88, y2: 0 });
  assert.equal(linkSegment({ source: "a", target: "z" }, positions, radii), null);

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
