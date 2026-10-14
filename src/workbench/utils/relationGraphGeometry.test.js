import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_LAYOUT_SPREAD,
  arrowZones,
  boxHitsSegment,
  cardPlacement,
  glideStarts,
  labelBox,
  layoutSpread,
  lineBend,
  linkGeometry,
  linkPieces,
  placeLabels,
  screenPoint,
  textWidth,
} from "./relationGraphGeometry.js";

const close = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);

test("small views keep the compact rings; large views stretch them in steps, within limits", () => {
  const extent = { width: 184, height: 184 };
  assert.deepEqual(layoutSpread({ width: 300, height: 260 }, extent), { x: 1, y: 1 });
  const wide = layoutSpread({ width: 1440, height: 820 }, extent);
  assert.ok(wide.x > 1 && wide.y > 1, "a full screen stretches both ways");
  assert.ok(wide.x <= MAX_LAYOUT_SPREAD && wide.y <= MAX_LAYOUT_SPREAD);
  assert.ok(wide.x >= wide.y, "a wide screen stretches more across");
  for (const value of [wide.x, wide.y]) assert.equal(value * 4, Math.round(value * 4), "quarter steps");
  // An extreme strip stays an ellipse, not a flat band.
  const strip = layoutSpread({ width: 4000, height: 400 }, extent);
  assert.ok(strip.x <= strip.y * 1.8 + 1e-9);
  // A one-neighbour graph has no height; it does not divide by zero.
  const flat = layoutSpread({ width: 1440, height: 820 }, { width: 92, height: 0 });
  assert.ok(Number.isFinite(flat.y) && flat.y >= 1);
  assert.deepEqual(layoutSpread({ width: 0, height: 0 }, extent), { x: 1, y: 1 });
  assert.deepEqual(layoutSpread({ width: 900, height: 900 }, null), { x: 1, y: 1 });
});

test("lines run straight between circle edges when nothing is in the way", () => {
  const positions = new Map([["a", { x: 0, y: 0 }], ["b", { x: 100, y: 0 }]]);
  const radii = new Map([["a", 8], ["b", 10]]);
  const geometry = linkGeometry({ source: "a", target: "b" }, positions, radii, []);
  assert.equal(geometry.bend, 0);
  assert.equal(geometry.d, "M 10 0 L 88 0");
  assert.deepEqual([geometry.mx, geometry.my], [49, 0]);
  assert.deepEqual(linkPieces(geometry), [[10, 0, 88, 0]]);
  assert.equal(linkGeometry({ source: "a", target: "z" }, positions, radii), null);
});

test("a line bows around a table in its way, toward the side that needs less detour", () => {
  const positions = new Map([["a", { x: 0, y: 0 }], ["b", { x: 200, y: 0 }]]);
  const radii = new Map([["a", 8], ["b", 8]]);
  // Slightly above the line (screen y up is negative): the line bows below it.
  const obstacle = { id: "c", x: 100, y: -3, radius: 12 };
  const bend = lineBend(positions.get("a"), positions.get("b"), [obstacle]);
  assert.ok(bend > 0, "the left normal of a rightward line points down the screen");
  const geometry = linkGeometry({ source: "a", target: "b" }, positions, radii, [obstacle, { id: "a", x: 0, y: 0, radius: 8 }]);
  assert.match(geometry.d, /^M [\d.-]+ [\d.-]+ Q /);
  const clearance = Math.hypot(geometry.mx - obstacle.x, geometry.my - obstacle.y);
  assert.ok(clearance >= obstacle.radius + 6, `the curve clears the table (${clearance})`);
  // Tables at the very ends, or beside the line, are no obstacle.
  assert.equal(lineBend({ x: 0, y: 0 }, { x: 200, y: 0 }, [{ x: 5, y: 0, radius: 10 }]), 0);
  assert.equal(lineBend({ x: 0, y: 0 }, { x: 200, y: 0 }, [{ x: 100, y: 40, radius: 10 }]), 0);
  assert.equal(lineBend({ x: 0, y: 0 }, { x: 0, y: 0 }, [obstacle]), 0);
});

test("arrowheads sit at the ends the relation points to", () => {
  const geometry = linkGeometry({ source: "a", target: "b" }, new Map([["a", { x: 0, y: 0 }], ["b", { x: 100, y: 0 }]]), new Map(), []);
  const [end] = arrowZones(geometry);
  assert.deepEqual(end.map((value) => Math.round(value)), [84, 0, 98, 0]);
  const both = arrowZones(geometry, { start: true, end: true });
  assert.equal(both.length, 2);
  assert.deepEqual(both[1].map((value) => Math.round(value)), [16, 0, 2, 0]);
  assert.deepEqual(arrowZones(null), []);
});

test("text width counts CJK as a full em", () => {
  assert.equal(textWidth("ab", 10), 11.6);
  assert.equal(textWidth("道具", 10), 20);
  assert.equal(textWidth("", 10), 0);
});

test("a name box hangs off the chosen side of its table", () => {
  const node = { x: 0, y: 0, radius: 10 };
  const size = { gap: 2, width: 40, height: 12 };
  const right = labelBox(node, { x: 1, y: 0 }, size);
  assert.equal(right.anchor, "start");
  assert.deepEqual([right.x0, right.y0, right.y1], [12, -6, 6]);
  const above = labelBox(node, { x: 0, y: -1 }, size);
  assert.equal(above.anchor, "middle");
  assert.deepEqual([above.x0, above.y1], [-20, -12]);
  const lowerLeft = labelBox(node, { x: -Math.SQRT1_2, y: Math.SQRT1_2 }, size);
  assert.equal(lowerLeft.anchor, "end");
  assert.ok(lowerLeft.x1 < 0 && lowerLeft.y0 > 0);
  assert.equal(boxHitsSegment({ x0: 0, y0: 0, x1: 10, y1: 10 }, [-5, 5, 15, 5]), true);
  assert.equal(boxHitsSegment({ x0: 0, y0: 0, x1: 10, y1: 10 }, [-5, 20, 15, 20]), false);
});

test("names take the side of their table that keeps lines and arrowheads clear", () => {
  const node = (id, x, y, radius = 8) => ({ id, x, y, radius, width: 36, height: 12 });
  const line = (source, target, from, to) => {
    const geometry = linkGeometry({ source, target }, new Map([[source, from], [target, to]]), new Map([[source, 8], [target, 8]]), []);
    return { source, target, pieces: linkPieces(geometry), arrows: arrowZones(geometry) };
  };
  const center = node("center", 0, 0, 11);
  const right = node("right", 100, 0);
  const left = node("left", -100, 0);
  const below = node("below", 0, 100);
  const lines = [
    line("left", "center", left, center),
    line("center", "right", center, right),
    line("below", "center", below, center),
  ];
  const sides = placeLabels([center, right, left, below], lines, { center: "center", gap: 3 });
  // The center has lines left, right and below: its name goes above.
  assert.ok(sides.get("center").y1 <= -11, "center name above the circle");
  // Ring tables put their names outward, away from the line to the center.
  assert.equal(sides.get("right").anchor, "start");
  assert.equal(sides.get("left").anchor, "end");
  assert.ok(sides.get("below").y0 >= 100, "the lower table names itself below");
  // No name sits on an arrowhead.
  for (const [, box] of sides) {
    for (const piece of lines.flatMap((item) => item.arrows)) assert.equal(boxHitsSegment(box, piece), false);
  }
});

test("a table keeps its side unless another is clearly better", () => {
  const lonely = { id: "a", x: 0, y: 0, radius: 8, width: 30, height: 12 };
  const fresh = placeLabels([lonely], [], {});
  assert.equal(fresh.get("a").anchor, "middle");
  assert.ok(fresh.get("a").y0 > 0, "with nothing around, below");
  const kept = placeLabels([lonely], [], { previous: new Map([["a", 0]]) });
  assert.equal(kept.get("a").direction, 0, "the previous side wins a near tie");
});

test("the info card goes to the half away from its table", () => {
  assert.deepEqual(cardPlacement({ x: 50, y: 200 }, { width: 300, height: 260 }), { vertical: "top", horizontal: "left", span: true });
  assert.deepEqual(cardPlacement({ x: 50, y: 40 }, { width: 300, height: 260 }), { vertical: "bottom", horizontal: "left", span: true });
  assert.deepEqual(cardPlacement({ x: 200, y: 600 }, { width: 1400, height: 800 }), { vertical: "top", horizontal: "right", span: false });
  assert.deepEqual(cardPlacement({ x: 1200, y: 100 }, { width: 1400, height: 800 }), { vertical: "bottom", horizontal: "left", span: false });
  assert.deepEqual(cardPlacement(null, { width: 300, height: 200 }), { vertical: "bottom", horizontal: "left", span: false });
});

test("graph points map to host pixels with the letterboxing of a fitted SVG", () => {
  const point = screenPoint({ x: 0, y: 0 }, { x: -100, y: -50, width: 200, height: 100 }, { width: 400, height: 400 });
  close(point.x, 200);
  close(point.y, 200);
  const corner = screenPoint({ x: -100, y: -50 }, { x: -100, y: -50, width: 200, height: 100 }, { width: 400, height: 400 });
  close(corner.x, 0);
  close(corner.y, 100);
  assert.equal(screenPoint(null, { x: 0, y: 0, width: 1, height: 1 }, { width: 1, height: 1 }), null);
});

test("a new picture grows out of the old one", () => {
  const nodes = [{ id: "center" }, { id: "kept" }, { id: "child", parent: "kept" }, { id: "new" }];
  const targets = new Map(nodes.map((node, index) => [node.id, { x: index * 10, y: 0 }]));
  const previous = new Map([["center", { x: 1, y: 1 }], ["kept", { x: 5, y: 5 }]]);
  const starts = glideStarts(nodes, targets, previous);
  assert.deepEqual(starts.get("kept"), { x: 5, y: 5 }, "drawn tables keep their place");
  assert.deepEqual(starts.get("child"), { x: 5, y: 5 }, "new tables start at the table that brought them");
  assert.deepEqual(starts.get("new"), { x: 1, y: 1 }, "others start at the center");
  assert.deepEqual(glideStarts(nodes, targets, new Map()).get("new"), { x: 30, y: 0 }, "nothing drawn: start in place");
});

test("placing names stays quick on the largest graph drawn", () => {
  const nodes = Array.from({ length: 60 }, (_, index) => {
    const angle = (index / 60) * 2 * Math.PI;
    const ring = index % 2 ? 260 : 150;
    return { id: `t${index}`, x: Math.cos(angle) * ring, y: Math.sin(angle) * ring, radius: 8, width: 60, height: 12 };
  });
  const lines = nodes.slice(1).map((node, index) => {
    const from = nodes[index];
    const geometry = linkGeometry({ source: from.id, target: node.id }, new Map([[from.id, from], [node.id, node]]), new Map(), nodes);
    return { source: from.id, target: node.id, pieces: linkPieces(geometry), arrows: arrowZones(geometry) };
  });
  const started = performance.now();
  for (let frame = 0; frame < 5; frame += 1) placeLabels(nodes, lines, { center: "t0", gap: 4 });
  const perFrame = (performance.now() - started) / 5;
  assert.ok(perFrame < 40, `one placement took ${perFrame.toFixed(1)}ms`);
});
