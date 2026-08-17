import test from "node:test";
import assert from "node:assert/strict";

import { compareSortValues } from "./naturalSort.js";

test("compareSortValues keeps whole numbers in numeric order", () => {
  assert.equal(compareSortValues("9", "10"), -1);
  assert.equal(compareSortValues("10", "9"), 1);
  assert.equal(compareSortValues("2", "2"), 0);
});

test("compareSortValues orders letter-plus-number ids by the number, not dictionary order", () => {
  const values = ["C20028", "C111", "C10", "C12", "C11"];
  values.sort(compareSortValues);
  assert.deepEqual(values, ["C10", "C11", "C12", "C111", "C20028"]);
});

test("compareSortValues still sorts plain text alphabetically", () => {
  assert.equal(compareSortValues("apple", "banana"), -1);
  assert.ok(compareSortValues("10", "apple") < 0);
});
