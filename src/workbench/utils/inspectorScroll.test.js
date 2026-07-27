import test from "node:test";
import assert from "node:assert/strict";

import { visibleTargetScrollDelta } from "./inspectorScroll.js";

test("visible inspector field does not move", () => {
  assert.equal(visibleTargetScrollDelta({
    containerTop: 100,
    containerBottom: 600,
    targetTop: 220,
    targetBottom: 300,
  }), 0);
});

test("field hidden behind the current-cell chip scrolls above it", () => {
  assert.equal(visibleTargetScrollDelta({
    containerTop: 100,
    containerBottom: 600,
    targetTop: 450,
    targetBottom: 560,
    occluderTop: 520,
    gap: 8,
  }), 48);
});

test("field above the inspector viewport scrolls back to the top", () => {
  assert.equal(visibleTargetScrollDelta({
    containerTop: 100,
    containerBottom: 600,
    targetTop: 72,
    targetBottom: 142,
    occluderTop: 520,
    gap: 8,
  }), -28);
});

test("field taller than the unobscured area aligns its heading to the top", () => {
  assert.equal(visibleTargetScrollDelta({
    containerTop: 100,
    containerBottom: 600,
    targetTop: 180,
    targetBottom: 650,
    occluderTop: 520,
    gap: 8,
  }), 80);
});
