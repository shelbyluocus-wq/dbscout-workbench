import test from "node:test";
import assert from "node:assert/strict";
import {
  clampFieldCommentHeight,
  clampGridRowHeight,
  resolveFieldCommentHeight,
  resolveGridRowHeight,
} from "./utils/gridRowHeight.js";

test("grid row heights use readable defaults and clamp user drag values", () => {
  assert.equal(resolveGridRowHeight({}), 28);
  assert.equal(clampGridRowHeight(8), 24);
  assert.equal(clampGridRowHeight(200), 72);
  assert.equal(resolveGridRowHeight({ rowHeight: 41 }), 41);

  assert.equal(resolveFieldCommentHeight({}), 32);
  assert.equal(clampFieldCommentHeight(8), 24);
  assert.equal(clampFieldCommentHeight(200), 96);
  assert.equal(resolveFieldCommentHeight({ fieldCommentHeight: 48 }), 48);
});
