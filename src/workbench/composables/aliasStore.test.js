import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAliasInput, resolveDatabaseAlias, resolveConnectionAlias } from "./aliasStore.js";

test("normalizeAliasInput trims whitespace", () => {
  assert.equal(normalizeAliasInput("  订单库  "), "订单库");
  assert.equal(normalizeAliasInput(""), "");
  assert.equal(normalizeAliasInput(null), "");
  assert.equal(normalizeAliasInput(undefined), "");
});

test("normalizeAliasInput caps length at 60 chars", () => {
  const long = "x".repeat(80);
  assert.equal(normalizeAliasInput(long).length, 60);
});

test("resolveDatabaseAlias reads alias scoped by connection id", () => {
  const map = { conn1: { game_db: "游戏库" }, conn2: { game_db: "另一个库" } };
  assert.equal(resolveDatabaseAlias(map, "conn1", "game_db"), "游戏库");
  assert.equal(resolveDatabaseAlias(map, "conn2", "game_db"), "另一个库");
});

test("resolveDatabaseAlias returns empty string when missing", () => {
  const map = { conn1: { game_db: "游戏库" } };
  assert.equal(resolveDatabaseAlias(map, "conn1", "unknown"), "");
  assert.equal(resolveDatabaseAlias(map, "missing", "game_db"), "");
  assert.equal(resolveDatabaseAlias(null, "conn1", "game_db"), "");
  assert.equal(resolveDatabaseAlias({}, "conn1", "game_db"), "");
});

test("resolveDatabaseAlias falls back to 'default' connection key", () => {
  const map = { default: { game_db: "默认库" } };
  assert.equal(resolveDatabaseAlias(map, "", "game_db"), "默认库");
  assert.equal(resolveDatabaseAlias(map, null, "game_db"), "默认库");
});

test("resolveConnectionAlias reads alias keyed by connection id", () => {
  const map = { conn1: "生产库", conn2: "测试库" };
  assert.equal(resolveConnectionAlias(map, "conn1"), "生产库");
  assert.equal(resolveConnectionAlias(map, "conn2"), "测试库");
});

test("resolveConnectionAlias returns empty string when missing", () => {
  assert.equal(resolveConnectionAlias({ conn1: "生产库" }, "missing"), "");
  assert.equal(resolveConnectionAlias(null, "conn1"), "");
  assert.equal(resolveConnectionAlias({}, "conn1"), "");
});

test("resolveConnectionAlias falls back to 'default' key", () => {
  assert.equal(resolveConnectionAlias({ default: "本地库" }, ""), "本地库");
  assert.equal(resolveConnectionAlias({ default: "本地库" }, null), "本地库");
});
