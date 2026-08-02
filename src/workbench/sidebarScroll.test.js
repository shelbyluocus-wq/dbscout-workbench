import test from "node:test";
import assert from "node:assert/strict";

import { revealSidebarNavigationRow, revealSidebarSearchResults } from "./sidebarScroll.js";

function makeElement(rect = {}, height = 0) {
  return {
    getBoundingClientRect: () => ({ top: 0, bottom: 0, ...rect }),
    offsetHeight: height,
  };
}

test("database navigation reveal uses nearest-edge positioning without pinning", () => {
  const calls = [];
  const container = {
    scrollTop: 180,
    getBoundingClientRect: () => ({ top: 20, bottom: 220 }),
    scrollTo(options) {
      calls.push(options);
    },
  };

  assert.equal(
    revealSidebarNavigationRow(container, makeElement({ top: 196, bottom: 248 }), { behavior: "smooth" }),
    true,
  );
  assert.deepEqual(calls, [{ top: 208, behavior: "smooth" }]);

  calls.length = 0;
  assert.equal(revealSidebarNavigationRow(container, makeElement({ top: 80, bottom: 108 })), false);
  assert.deepEqual(calls, []);
});

test("does not scroll when the sticky search box is already in view", () => {
  const calls = [];
  // Search box sits inside the container viewport (top 10..bottom 620).
  const searchBox = makeElement({ top: 60, bottom: 94 }, 34);
  const firstResult = makeElement({ top: 98, bottom: 126 });
  const container = {
    scrollTop: 420,
    getBoundingClientRect: () => ({ top: 10, bottom: 620 }),
    querySelector(selector) {
      if (selector === ".wb-table-search-wrap") return searchBox;
      if (selector === ".wb-search-result") return firstResult;
      return null;
    },
    scrollTo(options) {
      calls.push(options);
    },
  };

  // Search box visible => no scroll, view stays put.
  assert.equal(revealSidebarSearchResults(container), false);
  assert.deepEqual(calls, []);
});

test("scrolls the first result into view even when the sticky search box is visible", () => {
  const calls = [];
  const searchBox = makeElement({ top: 10, bottom: 44 }, 34);
  const firstResult = makeElement({ top: 680, bottom: 708 });
  const container = {
    scrollTop: 420,
    getBoundingClientRect: () => ({ top: 10, bottom: 620 }),
    querySelector(selector) {
      if (selector === ".wb-table-search-wrap") return searchBox;
      if (selector === ".wb-search-result") return firstResult;
      return null;
    },
    scrollTo(options) {
      calls.push(options);
    },
  };

  assert.equal(revealSidebarSearchResults(container), true);
  assert.deepEqual(calls, [{ top: 1052, behavior: "smooth" }]);
});

test("smoothly aligns the first result below the search box when the box is off-screen", () => {
  const calls = [];
  // Search box scrolled above the viewport (bottom above container top).
  const searchBox = makeElement({ top: -40, bottom: -6 }, 34);
  const firstResult = makeElement({ top: -120, bottom: -92 });
  const container = {
    scrollTop: 420,
    getBoundingClientRect: () => ({ top: 10, bottom: 620 }),
    querySelector(selector) {
      if (selector === ".wb-table-search-wrap") return searchBox;
      if (selector === ".wb-search-result") return firstResult;
      return null;
    },
    scrollTo(options) {
      calls.push(options);
    },
  };

  assert.equal(revealSidebarSearchResults(container), true);
  // targetViewportTop = 10 + 34 + 4 = 48; delta = 420 + (-120) - 48 = 252
  assert.deepEqual(calls, [{ top: 252, behavior: "smooth" }]);
});

test("prefers real results over the search hint when scrolling into view", () => {
  const calls = [];
  const searchBox = makeElement({ top: -40, bottom: -6 }, 34);
  const hint = makeElement({ top: -150, bottom: -132 });
  const firstResult = makeElement({ top: -120, bottom: -92 });
  const container = {
    scrollTop: 420,
    getBoundingClientRect: () => ({ top: 10, bottom: 620 }),
    querySelector(selector) {
      if (selector === ".wb-table-search-wrap") return searchBox;
      if (selector === ".wb-search-result") return firstResult;
      if (selector === ".wb-tree-empty, .wb-search-hint") return hint;
      return null;
    },
    scrollTo(options) {
      calls.push(options);
    },
  };

  assert.equal(revealSidebarSearchResults(container), true);
  assert.deepEqual(calls, [{ top: 252, behavior: "smooth" }]);
});

test("honors smooth:false for an instant scroll when requested", () => {
  const calls = [];
  const searchBox = makeElement({ top: -40, bottom: -6 }, 34);
  const firstResult = makeElement({ top: -120, bottom: -92 });
  const container = {
    scrollTop: 420,
    getBoundingClientRect: () => ({ top: 10, bottom: 620 }),
    querySelector(selector) {
      if (selector === ".wb-table-search-wrap") return searchBox;
      if (selector === ".wb-search-result") return firstResult;
      return null;
    },
    scrollTo(options) {
      calls.push(options);
    },
  };

  assert.equal(revealSidebarSearchResults(container, { smooth: false }), true);
  assert.deepEqual(calls, [{ top: 252, behavior: "auto" }]);
});

test("resets to the top when off-screen and no anchor exists", () => {
  const calls = [];
  const container = {
    scrollTop: 260,
    getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    querySelector: () => null,
    scrollTo(options) {
      calls.push(options);
    },
  };

  assert.equal(revealSidebarSearchResults(container), true);
  assert.deepEqual(calls, [{ top: 0, behavior: "smooth" }]);
});

test("does nothing when there is no anchor and the table viewport is already at the top", () => {
  const calls = [];
  const container = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    querySelector: () => null,
    scrollTo(options) {
      calls.push(options);
    },
  };

  assert.equal(revealSidebarSearchResults(container), false);
  assert.deepEqual(calls, []);
});
