import assert from "node:assert/strict";
import { test } from "node:test";
import { splitMiddleEllipsis, splitTabLabel } from "./middleEllipsis.js";

test("splitMiddleEllipsis leaves short names unsplit", () => {
  assert.deepEqual(splitMiddleEllipsis("users"), { head: "users", tail: "" });
  assert.deepEqual(splitMiddleEllipsis("goodsprop"), { head: "goodsprop", tail: "" });
  assert.deepEqual(splitMiddleEllipsis("heroprop_v1234"), { head: "heroprop_v1234", tail: "" });
});

test("splitMiddleEllipsis preserves full text while keeping differentiating game-table suffixes intact", () => {
  const cases = [
    "actcontinuercencmodelprop",
    "actcontinuercencmodelprop_en",
    "actcontinuercencmodelprop_en2",
    "actcontinuercencmodelprop_kr",
    "actcontinuercencmodelprop_tw",
    "actcontinuercencmodelprop_special",
  ];
  for (const name of cases) {
    const { head, tail } = splitMiddleEllipsis(name);
    assert.equal(head + tail, name);
    assert.ok(head.length > 4, `${name} should keep a readable prefix`);
    assert.ok(tail.length >= 6, `${name} should keep a readable tail`);
  }

  assert.ok(splitMiddleEllipsis("actcontinuercencmodelprop_en2").tail.endsWith("_en2"));
  assert.ok(splitMiddleEllipsis("actcontinuercencmodelprop_tw").tail.endsWith("_tw"));
  assert.equal(splitMiddleEllipsis("actcontinuercencmodelprop_special").tail, "_special");
});

test("splitMiddleEllipsis handles CJK and empty/nullish inputs safely", () => {
  assert.deepEqual(splitMiddleEllipsis(""), { head: "", tail: "" });
  assert.deepEqual(splitMiddleEllipsis(null), { head: "", tail: "" });
  const cjk = "这是一个非常长的游戏活动奖励配置表_双层星匣";
  const { head, tail } = splitMiddleEllipsis(cjk);
  assert.equal(head + tail, cjk);
  assert.ok(tail.length > 0);
});

test("splitTabLabel distinguishes colliding sibling game tables sharing *modelprop suffix", () => {
  const siblings = [
    "actbilayerdrawboxencmodelprop",
    "actartifactdisplacemodelprop",
    "actbilayerdrawboxmodelprop",
    "actcontinuercencmodelprop",
  ];
  const enc = splitTabLabel("actbilayerdrawboxencmodelprop", siblings);
  const base = splitTabLabel("actbilayerdrawboxmodelprop", siblings);
  assert.equal(enc.head + enc.tail, "actbilayerdrawboxencmodelprop");
  assert.equal(base.head + base.tail, "actbilayerdrawboxmodelprop");
  assert.equal(enc.tail, "encmodelprop");
  assert.equal(base.tail, "modelprop");
  assert.notEqual(enc.tail, base.tail);

  // Non-colliding long tables keep normal end-ellipsis instead of wasting space on `elprop`.
  assert.deepEqual(
    splitTabLabel("actartifactdisplacemodelprop", siblings),
    { head: "actartifactdisplacemodelprop", tail: "" },
  );
  assert.deepEqual(
    splitTabLabel("actcontinuercencmodelprop", siblings),
    { head: "actcontinuercencmodelprop", tail: "" },
  );

  // Explicit delimiter suffixes still stay pinned on the right.
  const tw = splitTabLabel("actcontinuercencmodelprop_tw", siblings);
  assert.equal(tw.head + tw.tail, "actcontinuercencmodelprop_tw");
  assert.ok(tw.tail.endsWith("_tw"));
});
