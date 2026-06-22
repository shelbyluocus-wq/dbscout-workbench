import test from "node:test";
import assert from "node:assert/strict";

import {
  clampBackupNumber,
  parseBackupNumberInput,
  stepBackupNumberValue,
} from "./backupNumberInput.js";

test("parseBackupNumberInput preserves empty values and clamps finite input", () => {
  assert.equal(parseBackupNumberInput("", 12, { min: 1 }), null);
  assert.equal(parseBackupNumberInput("0", 12, { min: 1 }), 1);
  assert.equal(parseBackupNumberInput("12", 4, { min: 1, max: 10 }), 10);
  assert.equal(parseBackupNumberInput("8", 4, { min: 1, max: 10 }), 8);
});

test("parseBackupNumberInput falls back to the current value for non-finite input", () => {
  assert.equal(parseBackupNumberInput("not-a-number", 7, { min: 1 }), 7);
});

test("stepBackupNumberValue starts from min when the current value is empty", () => {
  assert.equal(stepBackupNumberValue(null, 1, { min: 1, step: 5 }), 6);
  assert.equal(stepBackupNumberValue(undefined, -1, { min: 1, step: 5 }), 1);
});

test("stepBackupNumberValue respects step size and min/max bounds", () => {
  assert.equal(stepBackupNumberValue(8, 1, { min: 1, max: 10, step: 5 }), 10);
  assert.equal(stepBackupNumberValue(3, -1, { min: 1, max: 10, step: 5 }), 1);
  assert.equal(stepBackupNumberValue(3, 1, { min: 1, max: 10, step: 2 }), 5);
});

test("clampBackupNumber ignores non-finite values", () => {
  assert.equal(clampBackupNumber(Number.NaN, { min: 1, max: 10 }), Number.NaN);
});
