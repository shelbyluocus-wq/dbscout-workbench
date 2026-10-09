import assert from "node:assert/strict";
import { test } from "node:test";
import { isStrandedKeyboardFocus } from "./keyboardFocus.js";

test("keyboard focus is stranded when the focused control was removed", () => {
  const body = { isConnected: true };
  const documentElement = { isConnected: true };
  const root = { body, documentElement };
  const input = { isConnected: true };
  const detached = { isConnected: false };

  assert.equal(isStrandedKeyboardFocus(null, root), true);
  assert.equal(isStrandedKeyboardFocus(undefined, root), true);
  assert.equal(isStrandedKeyboardFocus(root, root), true);
  assert.equal(isStrandedKeyboardFocus(body, root), true);
  assert.equal(isStrandedKeyboardFocus(documentElement, root), true);
  assert.equal(isStrandedKeyboardFocus(detached, root), true);
  assert.equal(isStrandedKeyboardFocus(input, root), false);
});
