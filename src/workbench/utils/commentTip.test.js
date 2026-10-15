import test from "node:test";
import assert from "node:assert/strict";
import {
  TIP_GAP,
  TIP_MARGIN,
  TIP_SHOW_DELAY,
  TIP_WARM_MS,
  createTipWarmth,
  placeCommentTip,
} from "./commentTip.js";

const viewport = { width: 1000, height: 700 };
const tip = { width: 220, height: 48 };

test("the comment card sits above the table name, aligned with it", () => {
  const anchor = { left: 300, top: 200, bottom: 218 };
  assert.deepEqual(placeCommentTip(anchor, tip, viewport), {
    side: "above",
    left: 300,
    top: 200 - TIP_GAP - tip.height,
  });
});

test("the comment card drops below a name near the top edge", () => {
  const anchor = { left: 300, top: 20, bottom: 38 };
  assert.deepEqual(placeCommentTip(anchor, tip, viewport), { side: "below", left: 300, top: 38 + TIP_GAP });
});

test("the comment card stays inside the window horizontally", () => {
  const right = placeCommentTip({ left: 940, top: 300, bottom: 318 }, tip, viewport);
  assert.equal(right.left, viewport.width - tip.width - TIP_MARGIN);
  const left = placeCommentTip({ left: -20, top: 300, bottom: 318 }, tip, viewport);
  assert.equal(left.left, TIP_MARGIN);
});

test("the first card waits; the next one right after shows at once", () => {
  let now = 1000;
  const warmth = createTipWarmth(() => now);
  assert.equal(warmth.delay(), TIP_SHOW_DELAY);
  warmth.cool();
  now += TIP_WARM_MS - 1;
  assert.equal(warmth.delay(), 0);
  now += 2;
  assert.equal(warmth.delay(), TIP_SHOW_DELAY);
});
