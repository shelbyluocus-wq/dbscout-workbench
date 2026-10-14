import test from "node:test";
import assert from "node:assert/strict";

import { databaseRelationGraph, localRelationGraph } from "./relationGraph.js";
import {
  SEED_CELL,
  SIDE,
  STATUS,
  buildGraphModel,
  canvasNodeRadius,
  neighborMask,
  positionsBox,
  seedPositions,
} from "./relationGraphModel.js";

function edge(source, target, status = "confirmed", column = `${target}_id`) {
  return { id: `${source}.${column}>${target}.id`, sourceTable: source, sourceColumn: column, targetTable: target, targetColumn: "id", kind: "value", status };
}

// item is referenced by four tables; reward by two of them; two tables form an island.
const DATA = {
  edges: [
    edge("hero", "item"),
    edge("quest", "item"),
    edge("shop", "item", "conflict"),
    edge("mail", "item"),
    edge("quest", "reward"),
    edge("mail", "reward", "stale"),
    edge("item", "attr"),
    edge("npc", "dialog"),
    edge("dialog", "dialog", "confirmed", "next_id"),
  ],
  tables: {},
};

function point(xy, at) {
  return { x: xy[at * 2], y: xy[at * 2 + 1] };
}

test("circles grow with references on a log scale, within limits", () => {
  assert.equal(canvasNodeRadius(0), 4);
  assert.ok(canvasNodeRadius(10) > canvasNodeRadius(1));
  assert.ok(canvasNodeRadius(1000) - canvasNodeRadius(100) > 2, "a thousand still stands out from a hundred");
  assert.equal(canvasNodeRadius(1e9), 30);
  assert.equal(canvasNodeRadius(0, { center: true }), 10);
});

test("the model holds the graph as typed arrays with neighbours in compressed rows", () => {
  const model = buildGraphModel(databaseRelationGraph(DATA, "item"));
  assert.equal(model.count, 9);
  assert.equal(model.ids[model.centerIndex], "item");
  assert.ok(model.radius instanceof Float32Array);
  assert.equal(model.side[model.centerIndex], SIDE.center);
  assert.equal(model.side[model.index.get("hero")], SIDE.in);
  assert.equal(model.side[model.index.get("attr")], SIDE.out);
  assert.equal(model.side[model.index.get("npc")], SIDE.none, "out of reach");
  assert.equal(model.depth[model.index.get("npc")], -1);
  assert.equal(model.issue[model.index.get("shop")], 2, "conflict");
  assert.equal(model.issue[model.index.get("mail")], 1, "stale");
  assert.equal(model.loop[model.index.get("dialog")], STATUS.confirmed + 1, "self reference");
  const item = model.index.get("item");
  const around = [];
  for (let cursor = model.offsets[item]; cursor < model.offsets[item + 1]; cursor += 1) around.push(model.ids[model.neighbors[cursor]]);
  assert.deepEqual(around.sort(), ["attr", "hero", "mail", "quest", "shop"]);
  assert.equal(model.maxRadius, Math.max(...model.radius));
  const mask = neighborMask(model, item);
  assert.equal(mask.reduce((sum, value) => sum + value, 0), 6);
  assert.equal(mask[model.index.get("npc")], 0);
  assert.equal(neighborMask(model, -1).reduce((sum, value) => sum + value, 0), 0);
});

test("a fresh picture starts in rings around the current table, the same every time", () => {
  const model = buildGraphModel(localRelationGraph(DATA, "item", { depth: 2 }));
  const first = seedPositions(model);
  assert.deepEqual([...first], [...seedPositions(model)], "deterministic");
  assert.deepEqual(point(first, model.centerIndex), { x: 0, y: 0 });
  const distance = (id) => Math.hypot(...Object.values(point(first, model.index.get(id))));
  assert.ok(distance("hero") < distance("reward"), "the second ring lies outside the first");
  // Tables the current one references start on the right.
  assert.ok(point(first, model.index.get("attr")).x > 0);
});

test("known tables keep their place and new ones grow out of their neighbours", () => {
  const before = buildGraphModel(localRelationGraph(DATA, "item", { depth: 1 }));
  const known = new Map(before.ids.map((id, at) => [id, [at * 100, 50]]));
  const after = buildGraphModel(localRelationGraph(DATA, "item", { depth: 2 }));
  const xy = seedPositions(after, known);
  for (const [id, [x, y]] of known) assert.deepEqual(point(xy, after.index.get(id)), { x, y }, id);
  const reward = point(xy, after.index.get("reward"));
  const quest = known.get("quest");
  const mail = known.get("mail");
  const middle = { x: (quest[0] + mail[0]) / 2, y: (quest[1] + mail[1]) / 2 };
  assert.ok(Math.hypot(reward.x - middle.x, reward.y - middle.y) <= SEED_CELL * 2, "beside the tables that reference it");
});

test("islands with nothing placed start outside the drawing", () => {
  const model = buildGraphModel(databaseRelationGraph(DATA, "item"));
  const known = new Map(["item", "hero", "quest", "shop", "mail", "reward", "attr"].map((id, at) => [id, [Math.cos(at) * 80, Math.sin(at) * 80]]));
  const xy = seedPositions(model, known);
  const box = positionsBox(Float32Array.from([...known.values()].flat()), known.size);
  const npc = point(xy, model.index.get("npc"));
  const inside = npc.x >= box.x && npc.x <= box.x + box.width && npc.y >= box.y && npc.y <= box.y + box.height;
  assert.equal(inside, false);
  const dialog = point(xy, model.index.get("dialog"));
  assert.ok(Math.hypot(dialog.x - npc.x, dialog.y - npc.y) <= SEED_CELL * 2, "the island stays together");
  assert.equal(positionsBox(new Float32Array(0), 0), null);
});
