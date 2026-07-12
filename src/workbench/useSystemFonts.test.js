import test from "node:test";
import assert from "node:assert/strict";

import {
  createSystemFontsController,
  normalizeSystemFontList,
} from "./composables/useSystemFonts.js";

test("system font responses are normalized, sorted, and deduplicated", () => {
  assert.deepEqual(
    normalizeSystemFontList({
      fonts: [
        { family: " Microsoft YaHei ", weights: [300, 400, 700] },
        { family: "Arial", weights: [400, 700] },
        { family: "arial", weights: [900, 700] },
        { family: "", weights: [400] },
        { family: "Bad\nFont", weights: [400] },
      ],
    }),
    [
      { family: "Arial", weights: [400, 700, 900] },
      { family: "Microsoft YaHei", weights: [300, 400, 700] },
    ],
  );
});

test("system fonts load once and reuse the cached result", async () => {
  let calls = 0;
  const controller = createSystemFontsController(async (command) => {
    calls += 1;
    assert.equal(command, "list_system_fonts");
    return {
      fonts: [
        { family: "Segoe UI", weights: [300, 400, 600, 700] },
        { family: "Arial", weights: [400, 700, 900] },
      ],
    };
  });

  await controller.load();
  await controller.load();

  assert.equal(calls, 1);
  assert.deepEqual(controller.fonts.value, [
    { family: "Arial", weights: [400, 700, 900] },
    { family: "Segoe UI", weights: [300, 400, 600, 700] },
  ]);
  assert.equal(controller.error.value, "");
});

test("system font loading exposes errors and supports retry", async () => {
  let calls = 0;
  const controller = createSystemFontsController(async () => {
    calls += 1;
    if (calls === 1) throw new Error("字体服务不可用");
    return { fonts: [{ family: "Arial", weights: [400, 700, 900] }] };
  });

  await assert.rejects(controller.load(), /字体服务不可用/);
  assert.equal(controller.error.value, "字体服务不可用");

  await controller.refresh();
  assert.deepEqual(controller.fonts.value, [{ family: "Arial", weights: [400, 700, 900] }]);
  assert.equal(controller.error.value, "");
});
