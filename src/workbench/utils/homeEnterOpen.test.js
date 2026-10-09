import test from "node:test";
import assert from "node:assert/strict";

import { homeEnterOpenNames } from "./homeEnterOpen.js";

test("Enter on a row inside a ctrl or shift selection opens every selected table", () => {
  assert.deepEqual(homeEnterOpenNames("hero", ["player", "hero", "item"]), ["player", "hero", "item"]);
  assert.deepEqual(homeEnterOpenNames("player", ["player", "hero", "item"]), ["player", "hero", "item"]);
});

test("Enter on the list itself opens the current selection", () => {
  assert.deepEqual(homeEnterOpenNames("", ["guild", "mail"]), ["guild", "mail"]);
});

test("Enter on a row outside the selection opens only that row", () => {
  assert.deepEqual(homeEnterOpenNames("quest", ["player", "hero"]), ["quest"]);
});

test("Enter with a single selected row opens that row", () => {
  assert.deepEqual(homeEnterOpenNames("player", ["player"]), ["player"]);
  assert.deepEqual(homeEnterOpenNames("", ["player"]), ["player"]);
});

test("Enter with no selection opens the focused row or nothing", () => {
  assert.deepEqual(homeEnterOpenNames("player", []), ["player"]);
  assert.deepEqual(homeEnterOpenNames("", []), []);
  assert.deepEqual(homeEnterOpenNames("player", null), ["player"]);
});

test("duplicate selected names are opened once, in selection order", () => {
  assert.deepEqual(homeEnterOpenNames("hero", ["player", "hero", "player"]), ["player", "hero"]);
});
