import assert from "node:assert/strict";
import { test } from "node:test";
import { ref } from "vue";
import {
  RAIL_SORT_SETTLE_MS,
  clampRailSortOffset,
  railSortSiblingShift,
  railSortTargetIndex,
  useActivityRailSort,
} from "./composables/useActivityRailSort.js";

// Four 30px entries with a 4px gap, matching the rail layout.
const SLOTS = [0, 34, 68, 102].map((top) => ({ top, height: 30 }));

test("rail sort target follows the lifted entry's center to the nearest slot", () => {
  assert.equal(railSortTargetIndex(SLOTS, 0, 0), 0);
  assert.equal(railSortTargetIndex(SLOTS, 0, 16), 0);
  assert.equal(railSortTargetIndex(SLOTS, 0, 18), 1);
  assert.equal(railSortTargetIndex(SLOTS, 0, 102), 3);
  assert.equal(railSortTargetIndex(SLOTS, 3, -70), 1);
});

test("rail sort offset stays inside the group with a short rubber band", () => {
  assert.equal(clampRailSortOffset(SLOTS, 1, 20), 20);
  assert.equal(clampRailSortOffset(SLOTS, 1, -34), -34);
  const over = clampRailSortOffset(SLOTS, 1, -134);
  assert.ok(over < -34 && over >= -44, `rubber band overshoot ${over}`);
  const under = clampRailSortOffset(SLOTS, 1, 400);
  assert.ok(under > 68 && under <= 78, `rubber band overshoot ${under}`);
});

test("rail sort siblings between source and target slide one slot toward the source", () => {
  // Dragging entry 0 down to slot 2: entries 1 and 2 move up, entry 3 stays.
  assert.deepEqual([0, 1, 2, 3].map((i) => railSortSiblingShift(SLOTS, 0, 2, i)), [0, -34, -34, 0]);
  // Dragging entry 3 up to slot 1: entries 1 and 2 move down, entry 0 stays.
  assert.deepEqual([0, 1, 2, 3].map((i) => railSortSiblingShift(SLOTS, 3, 1, i)), [0, 34, 34, 0]);
});

function withFakeWindow(run) {
  const listeners = new Map();
  const saved = {
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    matchMedia: globalThis.matchMedia,
  };
  globalThis.addEventListener = (type, handler) => listeners.set(type, handler);
  globalThis.removeEventListener = (type, handler) => {
    if (listeners.get(type) === handler) listeners.delete(type);
  };
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.matchMedia = () => ({ matches: false });
  const fire = (type, event) => listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event });
  return Promise.resolve(run({ fire, listeners })).finally(() => Object.assign(globalThis, saved));
}

function createRail(ids) {
  const items = ref(ids.map((id) => ({ id })));
  const nodes = ids.map((id, index) => ({
    dataset: { wbRailSortId: id },
    getBoundingClientRect: () => ({ top: index * 34, height: 30 }),
  }));
  const container = ref({ querySelectorAll: () => nodes });
  const button = { setPointerCapture() {}, releasePointerCapture() {} };
  const reorders = [];
  const sort = useActivityRailSort({ items, container, onReorder: (payload) => reorders.push(payload) });
  return { items, sort, reorders, button };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("rail sort commits the drop slot after the entry settles and swallows the trailing click", () =>
  withFakeWindow(async ({ fire }) => {
    const { items, sort, reorders, button } = createRail(["a", "b", "c", "d"]);
    sort.onPointerDown(items.value[0], { button: 0, pointerId: 1, clientY: 10, currentTarget: button });
    assert.equal(sort.phase.value, "pending");

    fire("pointermove", { pointerId: 1, clientY: 12 });
    assert.equal(sort.phase.value, "pending", "small jitter stays a click");

    fire("pointermove", { pointerId: 1, clientY: 10 + 70 });
    assert.equal(sort.phase.value, "dragging");
    assert.equal(sort.isLifted(items.value[0]), true);
    assert.equal(sort.shiftFor(items.value[0], 0), 70);
    assert.equal(sort.shiftFor(items.value[1], 1), -34);
    assert.equal(sort.shiftFor(items.value[2], 2), -34);
    assert.equal(sort.shiftFor(items.value[3], 3), 0);

    fire("pointerup", { pointerId: 1, clientY: 80 });
    assert.equal(sort.phase.value, "settling");
    assert.equal(sort.shiftFor(items.value[0], 0), 68, "entry glides to the exact slot");
    assert.equal(sort.consumeClick(), true, "the release click does not open the entry");
    assert.deepEqual(reorders, []);

    await wait(RAIL_SORT_SETTLE_MS + 20);
    assert.deepEqual(reorders, [{ sourceId: "a", targetId: "c", position: "after" }]);
    await wait(20);
    assert.equal(sort.phase.value, "idle");
    assert.equal(sort.consumeClick(), false);
  }));

test("rail sort leaves a plain press as a click and Escape cancels a drag", () =>
  withFakeWindow(async ({ fire }) => {
    const { items, sort, reorders, button } = createRail(["a", "b", "c"]);
    sort.onPointerDown(items.value[1], { button: 0, pointerId: 2, clientY: 40, currentTarget: button });
    fire("pointerup", { pointerId: 2, clientY: 41 });
    assert.equal(sort.phase.value, "idle");
    assert.equal(sort.consumeClick(), false);

    sort.onPointerDown(items.value[2], { button: 0, pointerId: 3, clientY: 80, currentTarget: button });
    fire("pointermove", { pointerId: 3, clientY: 10 });
    assert.equal(sort.phase.value, "dragging");
    fire("keydown", { key: "Escape" });
    assert.equal(sort.phase.value, "settling");
    assert.equal(sort.shiftFor(items.value[2], 2), 0, "cancel glides back home");
    await wait(RAIL_SORT_SETTLE_MS + 40);
    assert.deepEqual(reorders, []);
    assert.equal(sort.phase.value, "idle");
  }));

test("rail sort ignores secondary buttons and supports Alt+Arrow keyboard moves", () =>
  withFakeWindow(async () => {
    const { items, sort, reorders, button } = createRail(["a", "b", "c"]);
    sort.onPointerDown(items.value[0], { button: 2, pointerId: 4, clientY: 0, currentTarget: button });
    assert.equal(sort.phase.value, "idle");

    sort.moveByKeyboard(items.value[1], -1);
    sort.moveByKeyboard(items.value[2], 1);
    assert.deepEqual(reorders, [{ sourceId: "b", targetId: "a", position: "before" }]);
  }));
