import assert from "node:assert/strict";
import { test } from "node:test";
import { useAiActivityGlow } from "./composables/useAiActivityGlow.js";

function makeGlow() {
  let now = 0;
  let scheduled = null;
  const glow = useAiActivityGlow({
    now: () => now,
    schedule: (fn) => { scheduled = fn; return 1; },
    cancel: () => {},
  });
  return { glow, tick: (ms) => { now += ms; scheduled?.(); scheduled = null; }, setNow: (v) => { now = v; } };
}

test("activity glow stays active during linger and elevates on write", () => {
  const { glow, tick, setNow } = makeGlow();
  assert.equal(glow.active.value, false);
  glow.onEvent({ phase: "start", kind: "read", id: "1" });
  assert.equal(glow.active.value, true);
  assert.equal(glow.level.value, "calm");
  assert.equal(glow.label.value, "AI 正在读取");
  glow.onEvent({ phase: "end", kind: "read", id: "1" });
  // Still in the 1200ms linger window.
  assert.equal(glow.active.value, true);
  tick(1300);
  assert.equal(glow.active.value, false);

  // Write in flight elevates the level and label.
  glow.onEvent({ phase: "start", kind: "write", id: "2" });
  assert.equal(glow.level.value, "write");
  assert.equal(glow.label.value, "AI 正在修改数据");
  glow.onEvent({ phase: "end", kind: "write", id: "2" });
  assert.equal(glow.level.value, "write");

  // Back-to-back requests never drop the glow (no flicker).
  glow.onEvent({ phase: "start", kind: "read", id: "3" });
  glow.onEvent({ phase: "end", kind: "read", id: "3" });
  glow.onEvent({ phase: "start", kind: "read", id: "4" });
  assert.equal(glow.active.value, true);
});

test("unknown kinds and phases are ignored", () => {
  const { glow } = makeGlow();
  glow.onEvent({ phase: "start", kind: "bogus", id: "x" });
  glow.onEvent({ phase: "bogus", kind: "read", id: "x" });
  assert.equal(glow.active.value, false);
});
