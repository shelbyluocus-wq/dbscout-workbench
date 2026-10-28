import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestionMatches } from "./suggestionList.js";

const platforms = ["android", "ios", "web-mobile", "web-desktop", "bytedance-mini-game"];

test("opening a filled choice still offers every other option", () => {
  assert.deepEqual(suggestionMatches(platforms, "android", { browsing: true }), platforms);
  assert.deepEqual(suggestionMatches(platforms, "", { browsing: true }), platforms);
});

test("typing narrows the list, including a complete name", () => {
  assert.deepEqual(suggestionMatches(platforms, "android"), ["android"]);
  assert.deepEqual(suggestionMatches(platforms, "web"), ["web-mobile", "web-desktop"]);
  assert.deepEqual(suggestionMatches(platforms, "byte"), ["bytedance-mini-game"]);
});

test("a build-panel name filters the same list as its platform id", () => {
  const choices = [
    { value: "win32", label: "Windows" },
    { value: "wechatgame", label: "微信小游戏" },
    { value: "web-mobile", label: "Web Mobile" },
  ];
  assert.deepEqual(suggestionMatches(choices, "微信", { browsing: false }), [choices[1]]);
  assert.deepEqual(suggestionMatches(choices, "win", { browsing: false }), [choices[0]]);
  assert.deepEqual(suggestionMatches(choices, "Windows", { browsing: true }), choices);
});

test("the list stops at the limit", () => {
  assert.deepEqual(suggestionMatches(platforms, "", { limit: 2 }), ["android", "ios"]);
});
