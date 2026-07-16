import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TABLE_FILTER_MODE, normalizeTableFilterMode } from "./tableFilterMode.js";

test("table search defaults to exact matching", () => {
  assert.equal(DEFAULT_TABLE_FILTER_MODE, "exact");
  assert.equal(normalizeTableFilterMode(), "exact");
  assert.equal(normalizeTableFilterMode(""), "exact");
});

test("table search preserves an explicit fuzzy choice", () => {
  assert.equal(normalizeTableFilterMode("fuzzy"), "fuzzy");
  assert.equal(normalizeTableFilterMode("exact"), "exact");
});
