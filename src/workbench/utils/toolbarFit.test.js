import assert from "node:assert/strict";
import { test } from "node:test";
import { fitToolbar } from "./toolbarFit.js";

// A toolbar whose content width depends on the applied fit level.
function fakeToolbar(clientWidth, contentByLevel) {
  const dataset = {};
  return {
    dataset,
    clientWidth,
    get scrollWidth() {
      return Math.max(clientWidth, contentByLevel[Number(dataset.fit ?? 0)]);
    },
  };
}

test("fitToolbar keeps the fullest layout that fits", () => {
  const toolbar = fakeToolbar(800, [760, 640, 520, 300]);
  assert.equal(fitToolbar(toolbar, 3), 0);
  assert.equal(toolbar.dataset.fit, "0");
});

test("fitToolbar steps down only as far as the content needs", () => {
  const toolbar = fakeToolbar(600, [900, 640, 520, 300]);
  assert.equal(fitToolbar(toolbar, 3), 2);
  assert.equal(toolbar.dataset.fit, "2");
  assert.equal("fitMeasuring" in toolbar.dataset, false, "transitions come back after measuring");
});

test("fitToolbar returns to a fuller layout once room comes back", () => {
  const content = [900, 640, 520, 300];
  const narrow = fakeToolbar(500, content);
  assert.equal(fitToolbar(narrow, 3), 3);
  narrow.clientWidth = 950;
  assert.equal(fitToolbar(narrow, 3), 0);
});

test("fitToolbar settles on the last level when nothing fits", () => {
  const toolbar = fakeToolbar(200, [900, 640, 520, 300]);
  assert.equal(fitToolbar(toolbar, 3), 3);
  assert.equal(toolbar.dataset.fit, "3");
  assert.equal(fitToolbar(null, 3), 0);
});

test("fitToolbar counts a row that only runs into the end padding", (t) => {
  // A non-scrolling toolbar 400px wide with 10px padding: scrollWidth stays at
  // clientWidth, but the actions end 6px into the padding at level 0.
  const dataset = {};
  const actionsRight = [396, 380];
  const toolbar = {
    dataset,
    clientWidth: 400,
    scrollWidth: 400,
    getBoundingClientRect: () => ({ right: 400 }),
    children: [{ getBoundingClientRect: () => ({ right: actionsRight[Number(dataset.fit ?? 0)] }) }],
  };
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ paddingRight: "10px", borderRightWidth: "0px" });
  t.after(() => { globalThis.getComputedStyle = original; });
  assert.equal(fitToolbar(toolbar, 1), 1);
});
