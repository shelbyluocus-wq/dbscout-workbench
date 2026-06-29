import test from "node:test";
import assert from "node:assert/strict";

import { scrollSidebarSearchResultsToTop } from "./sidebarScroll.js";

function makeElement(rect = {}, height = 0) {
  return {
    getBoundingClientRect: () => ({ top: 0, bottom: 0, ...rect }),
    offsetHeight: height,
  };
}

test("scrollSidebarSearchResultsToTop aligns the first result below the sticky search box", () => {
  const calls = [];
  const searchBox = makeElement({ top: 0, bottom: 34 }, 34);
  const firstResult = makeElement({ top: -120, bottom: -92 });
  const container = {
    scrollTop: 420,
    getBoundingClientRect: () => ({ top: 10, bottom: 620 }),
    querySelector(selector) {
      if (selector === ".wb-table-search-wrap") return searchBox;
      if (selector === ".wb-search-result") return firstResult;
      if (selector === ".wb-search-result, .wb-tree-empty, .wb-search-hint") return firstResult;
      return null;
    },
    scrollTo(options) {
      calls.push(options);
    },
  };

  assert.equal(scrollSidebarSearchResultsToTop(container), true);
  assert.deepEqual(calls, [{ top: 252, behavior: "auto" }]);
});

test("scrollSidebarSearchResultsToTop prefers real results over the search hint", () => {
  const calls = [];
  const searchBox = makeElement({ top: 0, bottom: 34 }, 34);
  const hint = makeElement({ top: -150, bottom: -132 });
  const firstResult = makeElement({ top: -120, bottom: -92 });
  const container = {
    scrollTop: 420,
    getBoundingClientRect: () => ({ top: 10, bottom: 620 }),
    querySelector(selector) {
      if (selector === ".wb-table-search-wrap") return searchBox;
      if (selector === ".wb-search-result, .wb-tree-empty, .wb-search-hint") return hint;
      if (selector === ".wb-search-result") return firstResult;
      return null;
    },
    scrollTo(options) {
      calls.push(options);
    },
  };

  assert.equal(scrollSidebarSearchResultsToTop(container), true);
  assert.deepEqual(calls, [{ top: 252, behavior: "auto" }]);
});

test("scrollSidebarSearchResultsToTop resets to the top when no result anchor exists", () => {
  const calls = [];
  const container = {
    scrollTop: 260,
    getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    querySelector: () => null,
    scrollTo(options) {
      calls.push(options);
    },
  };

  assert.equal(scrollSidebarSearchResultsToTop(container), true);
  assert.deepEqual(calls, [{ top: 0, behavior: "auto" }]);
});
