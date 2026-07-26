import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TABLE_FILTER_MODE, normalizeTableFilterMode } from "./tableFilterMode.js";

test("table search defaults to continuous matching", () => {
  assert.equal(DEFAULT_TABLE_FILTER_MODE, "continuous");
  assert.equal(normalizeTableFilterMode(), "continuous");
  assert.equal(normalizeTableFilterMode(""), "continuous");
});

test("table search preserves every supported mode", () => {
  assert.equal(normalizeTableFilterMode("fuzzy"), "fuzzy");
  assert.equal(normalizeTableFilterMode("continuous"), "continuous");
  assert.equal(normalizeTableFilterMode("exact"), "exact");
});

test("table search falls back to continuous for unknown persisted modes", () => {
  assert.equal(normalizeTableFilterMode("contains"), "continuous");
  assert.equal(normalizeTableFilterMode("unknown"), "continuous");
});
