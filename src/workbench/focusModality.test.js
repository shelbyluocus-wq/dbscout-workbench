import assert from "node:assert/strict";
import { test } from "node:test";
import {
  interactionShowsFocusRing,
  noteKeyboardInteraction,
  notePointerInteraction,
} from "./focusModality.js";

test("a pointer press hides the keyboard focus ring until the next real key", () => {
  noteKeyboardInteraction({ key: "Tab" });
  assert.equal(interactionShowsFocusRing(), true);

  notePointerInteraction();
  assert.equal(interactionShowsFocusRing(), false);

  noteKeyboardInteraction({ key: "Control" });
  assert.equal(interactionShowsFocusRing(), false);

  noteKeyboardInteraction({ key: "Enter" });
  assert.equal(interactionShowsFocusRing(), true);
});
