import test from "node:test";
import assert from "node:assert/strict";

import { shouldResetGridForTabActivation } from "./tabActivation.js";

test("activating the current tab preserves the grid scroll position", () => {
  assert.equal(shouldResetGridForTabActivation("tab-1", "tab-1"), false);
});

test("activating another tab resets grid selection and scroll", () => {
  assert.equal(shouldResetGridForTabActivation("tab-1", "tab-2"), true);
});

