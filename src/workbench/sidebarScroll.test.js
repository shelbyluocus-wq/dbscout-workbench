import test from "node:test";
import assert from "node:assert/strict";

import { createSidebarRowFollower, revealSidebarNavigationRow, revealSidebarSearchResults } from "./sidebarScroll.js";

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

function makeFollowerHarness({ containerRect = { top: 0, bottom: 300 }, scrollTop = 0 } = {}) {
  const frames = [];
  const listeners = new Map();
  const state = { clock: 0, rowTop: 0, rowHeight: 28, animating: false, rect: containerRect, hasRow: true };
  const container = {
    scrollTop,
    getBoundingClientRect: () => state.rect,
    scrollTo({ top }) {
      this.scrollTop = top;
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  };
  // rowTop is the row's place in the scrolled content; its viewport rect follows the scroll offset.
  const row = {
    getBoundingClientRect: () => ({
      top: state.rect.top + state.rowTop - container.scrollTop,
      bottom: state.rect.top + state.rowTop - container.scrollTop + state.rowHeight,
    }),
  };
  const follower = createSidebarRowFollower({
    getContainer: () => container,
    getRow: () => (state.hasRow ? row : null),
    isAnimating: () => state.animating,
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: (handle) => {
      frames[handle - 1] = null;
    },
    now: () => state.clock,
  });
  const runFrame = () => {
    const callback = frames.pop();
    frames.length = 0;
    state.clock += 16;
    if (!callback) return false;
    callback();
    return true;
  };
  const rowVisible = () => {
    const rect = row.getBoundingClientRect();
    return rect.top >= state.rect.top && rect.bottom <= state.rect.bottom;
  };
  return { container, follower, listeners, state, runFrame, rowVisible, pending: () => frames.some(Boolean) };
}

test("follower keeps the row in view while the branches around it settle", () => {
  const harness = makeFollowerHarness({ scrollTop: 400 });
  const { state, follower, container } = harness;
  // Measured at the start of the switch the row sits far below the viewport...
  state.rowTop = 1700;
  state.animating = true;
  assert.equal(follower.follow(), true);
  assert.equal(harness.rowVisible(), true);
  // ...and the branch above it then closes, carrying the row up to the top of the list.
  for (let frame = 0; frame < 18; frame += 1) {
    state.rowTop = Math.max(40, state.rowTop - 100);
    assert.equal(harness.runFrame(), true);
    assert.equal(harness.rowVisible(), true, `frame ${frame}`);
  }
  state.animating = false;
  while (harness.runFrame());
  assert.equal(harness.pending(), false);
  assert.equal(container.scrollTop, 40);
  assert.equal(harness.listeners.size, 0);
});

test("follower waits for running branch transitions even when the row holds still", () => {
  const harness = makeFollowerHarness();
  harness.state.rowTop = 100;
  harness.state.animating = true;
  harness.follower.follow();
  for (let frame = 0; frame < 10; frame += 1) assert.equal(harness.runFrame(), true);
  assert.equal(harness.pending(), true);
  harness.state.rowTop = 900;
  harness.runFrame();
  assert.equal(harness.rowVisible(), true);
  harness.state.animating = false;
  while (harness.runFrame());
  assert.equal(harness.rowVisible(), true);
});

test("follower picks up a row that mounts after the switch", () => {
  const harness = makeFollowerHarness();
  harness.state.hasRow = false;
  harness.state.rowTop = 1200;
  harness.follower.follow();
  harness.runFrame();
  assert.equal(harness.container.scrollTop, 0);
  harness.state.hasRow = true;
  harness.runFrame();
  assert.equal(harness.rowVisible(), true);
});

test("follower lets go as soon as the user scrolls", () => {
  const harness = makeFollowerHarness();
  harness.state.rowTop = 100;
  harness.state.animating = true;
  harness.follower.follow();
  harness.runFrame();
  harness.listeners.get("wheel")();
  assert.equal(harness.pending(), false);
  assert.equal(harness.listeners.size, 0);
  harness.container.scrollTop = 800;
  assert.equal(harness.runFrame(), false);
  assert.equal(harness.container.scrollTop, 800);
});

test("follower never runs past its time limit", () => {
  const harness = makeFollowerHarness();
  harness.state.rowTop = 100;
  harness.state.animating = true;
  harness.follower.follow();
  let frames = 0;
  while (harness.runFrame()) frames += 1;
  assert.ok(frames > 10 && frames <= 1500 / 16 + 1, `stopped after ${frames} frames`);
  assert.equal(harness.listeners.size, 0);
});

test("a newer follow request replaces the one in flight", () => {
  const harness = makeFollowerHarness();
  harness.state.rowTop = 100;
  harness.state.animating = true;
  harness.follower.follow();
  harness.follower.follow();
  assert.equal(harness.listeners.size, 2);
  harness.state.animating = false;
  while (harness.runFrame());
  assert.equal(harness.pending(), false);
  assert.equal(harness.listeners.size, 0);
});

test("a request made while the tree is hidden is carried out once it is shown", () => {
  const harness = makeFollowerHarness({ containerRect: { top: 0, bottom: 0 } });
  harness.state.rowTop = 1200;
  assert.equal(harness.follower.follow(), false);
  assert.equal(harness.pending(), false);
  assert.equal(harness.container.scrollTop, 0);

  harness.state.rect = { top: 0, bottom: 300 };
  assert.equal(harness.follower.resume(), true);
  assert.equal(harness.rowVisible(), true);
  while (harness.runFrame());
  // Nothing is left to resume once the request has been served.
  assert.equal(harness.follower.resume(), false);
});

test("hiding the tree mid-follow keeps the request for when it returns", () => {
  const harness = makeFollowerHarness();
  harness.state.rowTop = 100;
  harness.state.animating = true;
  harness.follower.follow();
  harness.state.rect = { top: 0, bottom: 0 };
  harness.runFrame();
  assert.equal(harness.pending(), false);
  harness.state.rect = { top: 0, bottom: 300 };
  harness.state.rowTop = 2000;
  harness.state.animating = false;
  assert.equal(harness.follower.resume(), true);
  assert.equal(harness.rowVisible(), true);
});

test("follower does not mistake a slow easing tail for a row at rest", () => {
  const harness = makeFollowerHarness();
  harness.state.rowTop = 280;
  harness.follower.follow();
  // The row creeps down a fraction of a pixel per frame until it is clipped.
  for (let frame = 0; frame < 12; frame += 1) {
    harness.state.rowTop += 0.3;
    assert.equal(harness.runFrame(), true, `still following at frame ${frame}`);
  }
  while (harness.runFrame());
  assert.equal(harness.rowVisible(), true);
});

test("database navigation reveal honors optional context margin when clipped without moving visible rows", () => {
  const calls = [];
  const container = {
    scrollTop: 200,
    getBoundingClientRect: () => ({ top: 20, bottom: 320 }),
    scrollTo(options) {
      calls.push(options);
    },
  };

  // Clipped below: lands 36px above bottom edge.
  assert.equal(
    revealSidebarNavigationRow(container, makeElement({ top: 340, bottom: 368 }), { margin: 36 }),
    true,
  );
  assert.deepEqual(calls, [{ top: 284, behavior: "auto" }]);

  // Clipped above: lands 36px below top edge.
  calls.length = 0;
  assert.equal(
    revealSidebarNavigationRow(container, makeElement({ top: -12, bottom: 16 }), { margin: 36 }),
    true,
  );
  assert.deepEqual(calls, [{ top: 132, behavior: "auto" }]);

  // Already fully visible inside viewport: does not jitter even if closer than margin.
  calls.length = 0;
  assert.equal(
    revealSidebarNavigationRow(container, makeElement({ top: 24, bottom: 52 }), { margin: 36 }),
    false,
  );
  assert.deepEqual(calls, []);
});

test("follower supports explicit target getRow, context margin, callbacks, and single-pass DOM reads", () => {
  let rowReads = 0;
  let containerReads = 0;
  let foundCount = 0;
  let abortedCount = 0;
  const frames = [];
  const listeners = new Map();
  const state = { clock: 0, targetTop: 900, otherTop: 100, rect: { top: 0, bottom: 300 } };
  const container = {
    scrollTop: 0,
    getBoundingClientRect() {
      containerReads += 1;
      return state.rect;
    },
    scrollTo({ top }) {
      this.scrollTop = top;
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  };
  const makeRow = (getTop) => ({
    getBoundingClientRect() {
      rowReads += 1;
      const top = state.rect.top + getTop() - container.scrollTop;
      return { top, bottom: top + 28 };
    },
  });
  const staleRow = makeRow(() => state.otherTop);
  const clickedRow = makeRow(() => state.targetTop);

  const follower = createSidebarRowFollower({
    getContainer: () => container,
    getRow: () => staleRow,
    isAnimating: () => false,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: (handle) => { frames[handle - 1] = null; },
    now: () => state.clock,
  });

  // Explicit target getRow + margin overrides stale default getRow and reads DOM once.
  assert.equal(
    follower.follow({
      getRow: () => clickedRow,
      margin: 36,
      onRowFound: () => { foundCount += 1; },
      onUserScroll: () => { abortedCount += 1; },
    }),
    true,
  );
  assert.equal(foundCount, 1);
  assert.equal(containerReads, 2); // 1 in isLaidOut + 1 in step read pass
  assert.equal(rowReads, 1); // single read pass (no read-write-read thrash)
  assert.equal(container.scrollTop, 900 + 28 - 300 + 36);

  // User wheel aborts and fires onUserScroll callback.
  listeners.get("wheel")();
  assert.equal(abortedCount, 1);
  assert.equal(listeners.size, 0);
});

test("follower resume preserves explicit target getRow and margin after sidebar reopens", () => {
  const frames = [];
  const state = { clock: 0, rowTop: 1100, rect: { top: 0, bottom: 0 } };
  const container = {
    scrollTop: 0,
    getBoundingClientRect: () => state.rect,
    scrollTo({ top }) { this.scrollTop = top; },
    addEventListener() {},
    removeEventListener() {},
  };
  const targetRow = {
    getBoundingClientRect: () => ({
      top: state.rect.top + state.rowTop - container.scrollTop,
      bottom: state.rect.top + state.rowTop - container.scrollTop + 28,
    }),
  };
  const follower = createSidebarRowFollower({
    getContainer: () => container,
    getRow: () => null,
    isAnimating: () => false,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => {},
    now: () => state.clock,
  });

  assert.equal(follower.follow({ getRow: () => targetRow, margin: 36 }), false);
  state.rect = { top: 0, bottom: 300 };
  assert.equal(follower.resume(), true);
  assert.equal(container.scrollTop, 1100 + 28 - 300 + 36);
});
