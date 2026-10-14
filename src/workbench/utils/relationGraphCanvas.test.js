import test from "node:test";
import assert from "node:assert/strict";
import { quadtree } from "d3-quadtree";

import { databaseRelationGraph } from "./relationGraph.js";
import { buildGraphModel, neighborMask } from "./relationGraphModel.js";
import {
  arrowAlpha,
  cssColor,
  drawGraphFrame,
  graphPalette,
  labelAlpha,
  labelScale,
  lineAlpha,
  mixColors,
  nodeAtPoint,
  nodeScreenRadius,
  parseColor,
  screenX,
  shortLabel,
  viewRect,
} from "./relationGraphCanvas.js";

const RAW = {
  text: [20, 20, 20, 1], secondary: [80, 80, 80, 1], quiet: [120, 120, 120, 1], surface: [255, 255, 255, 0.92],
  accent: [70, 80, 100, 1], accentControl: [60, 70, 80, 1], warning: [210, 150, 40, 1], danger: [200, 50, 50, 1],
  out: [50, 90, 150, 1], outSoft: [230, 240, 250, 1], in: [100, 70, 150, 1], inSoft: [240, 235, 248, 1],
};

// A canvas context that records what is drawn.
function recorder() {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  const ctx = new Proxy({ calls }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      return record(key);
    },
    set(target, key, value) {
      calls.push([`set:${String(key)}`, value]);
      return true;
    },
  });
  return { ctx, calls, count: (name) => calls.filter((call) => call[0] === name).length };
}

function edge(source, target) {
  return { id: `${source}>${target}`, sourceTable: source, sourceColumn: `${target}_id`, targetTable: target, targetColumn: "id", kind: "value", status: "confirmed" };
}

function scene(extra = {}) {
  const data = { edges: ["a", "b", "c", "d"].map((name) => edge(name, "hub")).concat([edge("far", "hub")]), tables: {} };
  const model = buildGraphModel(databaseRelationGraph(data, "hub"));
  const xy = new Float32Array(model.count * 2);
  const place = { hub: [0, 0], a: [60, 0], b: [-60, 0], c: [0, 60], d: [0, -60], far: [5000, 5000] };
  model.ids.forEach((id, at) => {
    xy[at * 2] = place[id][0];
    xy[at * 2 + 1] = place[id][1];
  });
  const { ctx, calls, count } = recorder();
  const frame = {
    ctx,
    width: 400,
    height: 300,
    view: { scale: 1, x: 0, y: 0 },
    model,
    xy,
    palette: graphPalette(RAW),
    font: { family: "sans-serif", size: 11 },
    focus: -1,
    mask: null,
    fade: 0,
    pinned: -1,
    dragged: -1,
    labelOrder: Uint32Array.from(model.ids.keys()),
    labelText: (at) => model.ids[at],
    labelWidth: (at, size) => model.ids[at].length * size * 0.6,
    ...extra,
  };
  return { frame, model, xy, calls, count };
}

test("theme colours parse from computed styles and mix into a palette", () => {
  assert.deepEqual(parseColor("rgb(10, 20, 30)"), [10, 20, 30, 1]);
  assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), [10, 20, 30, 0.5]);
  assert.deepEqual(parseColor("rgb(10 20 30 / 0.25)"), [10, 20, 30, 0.25]);
  assert.deepEqual(parseColor("color(srgb 1 0.5 0 / 0.5)"), [255, 127.5, 0, 0.5]);
  assert.deepEqual(parseColor("#336699"), [51, 102, 153, 1]);
  assert.equal(parseColor("oklch(0.5 0.1 200)"), null);
  assert.deepEqual(mixColors([0, 0, 0, 1], [100, 200, 50, 1], 0.5), [50, 100, 25, 1]);
  assert.equal(cssColor([10.4, 20.6, 30, 1], 0.5), "rgba(10, 21, 30, 0.5)");
  const palette = graphPalette(RAW);
  assert.equal(palette.halo, "rgba(255, 255, 255, 1)", "names get an opaque halo");
  assert.equal(palette.fills.length, 5);
});

test("zoom decides circle sizes, names, line weight and arrowheads", () => {
  assert.equal(nodeScreenRadius(16, 1), 16);
  assert.equal(nodeScreenRadius(16, 4), 32, "circles grow slower than the zoom");
  assert.equal(nodeScreenRadius(4, 0.01), 1.6, "never below a dot");
  assert.ok(labelScale(30) < labelScale(4), "busier tables are named first");
  assert.equal(labelAlpha(labelScale(10), 10), 1);
  assert.equal(labelAlpha(labelScale(10) / 4, 10), 0);
  assert.ok(lineAlpha(0.05) < lineAlpha(1));
  assert.ok(lineAlpha(0.05, { issue: true }) > lineAlpha(0.05), "problem lines keep their colour");
  assert.equal(arrowAlpha(0.1), 0);
  assert.equal(arrowAlpha(1), 1);
  assert.equal(shortLabel("x".repeat(30)).length, 24);
});

test("graph points map to the screen around the view center", () => {
  const view = { scale: 2, x: 10, y: 0 };
  assert.equal(screenX(view, 400, 10), 200);
  assert.equal(screenX(view, 400, 20), 220);
  const rect = viewRect(view, 400, 300, 0);
  assert.deepEqual(rect, { x0: -90, y0: -75, x1: 110, y1: 75 });
});

test("a frame draws what is on screen: lines, circles, arrowheads and names", () => {
  const { frame, count } = scene();
  const stats = drawGraphFrame(frame);
  assert.equal(stats.nodes, 5, "the table far off screen is skipped");
  assert.equal(stats.links, 5, "its line still crosses the screen");
  assert.equal(stats.arrows, 5, "zoomed in, every visible line points");
  assert.equal(stats.labels, 5);
  assert.ok(count("stroke") >= 2);
  // Zoomed far out: no arrowheads, circles turn into dots.
  const far = scene({ view: { scale: 0.05, x: 0, y: 0 } });
  const zoomedOut = drawGraphFrame(far.frame);
  assert.equal(zoomedOut.arrows, 0);
  assert.ok(far.count("fillRect") >= 4, "tiny circles are dots");
});

test("while a table is active, its neighbourhood is lit and other names step back", () => {
  const base = scene();
  const a = base.model.index.get("a");
  const lit = scene({ focus: a, mask: neighborMask(base.model, a), fade: 1 });
  const stats = drawGraphFrame(lit.frame);
  assert.equal(stats.labels, 2, "only the active table and its neighbour keep their names");
  assert.ok(lit.calls.some((call) => call[0] === "set:globalAlpha" && call[1] < 0.2), "the rest is faded");
});

test("names never pile up: an overlapping name is skipped", () => {
  const { frame, model, xy } = scene();
  // Put two tables on top of each other.
  const a = model.index.get("a");
  const b = model.index.get("b");
  xy[b * 2] = xy[a * 2];
  xy[b * 2 + 1] = xy[a * 2 + 1];
  assert.equal(drawGraphFrame(frame).labels, 4);
});

test("the table under the pointer is found through the quadtree", () => {
  const { model, xy } = scene();
  const tree = quadtree().x((at) => xy[at * 2]).y((at) => xy[at * 2 + 1]).addAll(Array.from(model.ids.keys()));
  const view = { scale: 1, x: 0, y: 0 };
  const at = (x, y) => nodeAtPoint({ tree, model, xy, view, width: 400, height: 300 }, x, y);
  assert.equal(model.ids[at(260, 150)], "a");
  assert.equal(model.ids[at(200, 150)], "hub");
  assert.equal(at(230, 230), -1, "empty space");
  assert.equal(nodeAtPoint({ tree: null, model, xy, view, width: 400, height: 300 }, 200, 150), -1);
});
