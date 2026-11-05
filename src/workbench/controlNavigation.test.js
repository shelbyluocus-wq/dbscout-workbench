import assert from "node:assert/strict";
import { test } from "node:test";
import { primaryKeyFilter, scrollControlGrid, gridViewportSnapshot } from "./utils/controlNavigation.js";

test("exact jump requires all primary keys without lossy numeric coercion", () => {
  const tab = { primaryKeys: ["group", "id"] };
  assert.deepEqual(primaryKeyFilter(tab, { group: 1, id: "9007199254740993" }), {
    column: "group", values: ["1"], kind: "equals", sourceConstraints: [{ column: "id", values: ["9007199254740993"] }],
  });
  for (const identity of [null, { id: 1 }, { group: 1, id: null }, { group: 1, id: " 1" }, { group: 1, id: 9007199254740992 }, { group: 1, id: 2, extra: 3 }]) {
    assert.throws(() => primaryKeyFilter(tab, identity));
  }
  assert.throws(() => primaryKeyFilter({ primaryKeys: [] }, { id: 1 }), /没有主键/);
});

function fixture(overrides = {}) {
  const calls = [];
  const wrap = { scrollTop: 0, scrollLeft: 0, scrollHeight: 100000, scrollWidth: 2000, clientHeight: 600, clientWidth: 800 };
  const tab = { rowWindowOffset: 0, pageSize: 100, sort: { column: "id" }, filter: "kept" };
  const options = {
    tab, direction: "down", getWrap: () => wrap, restore: (position) => { wrap.scrollTop = position.top; wrap.scrollLeft = position.left; },
    nextTick: async () => {}, rowHeight: 25, rowCount: () => 100,
    fetchPage: async (target, page) => { calls.push(page); return { ok: true }; },
    jumpToTableBoundary: async () => ({ ok: true }),
    ...overrides,
  };
  return { options, wrap, calls, tab };
}

test("warm scrolling stays local and clamps horizontal boundaries", async () => {
  const { options, wrap, calls } = fixture();
  await scrollControlGrid(options);
  assert.equal(wrap.scrollTop, 500);
  assert.deepEqual(calls, []);
  await scrollControlGrid({ ...options, direction: "right", screens: 5 });
  assert.equal(wrap.scrollLeft, 1200);
});

test("cold viewport loads directly with fixed backend page size, preserving filters", async () => {
  const { options, wrap, calls, tab } = fixture();
  wrap.scrollTop = 26000;
  await scrollControlGrid(options);
  assert.deepEqual(calls, [2]);
  assert.equal(tab.filter, "kept");
  assert.deepEqual(tab.sort, { column: "id" });
});

test("failed boundary, invalid input, and loading do not claim success", async () => {
  const { options, wrap } = fixture();
  await assert.rejects(() => scrollControlGrid({ ...options, direction: "bottom", jumpToTableBoundary: async () => ({ ok: false }) }));
  assert.equal(wrap.scrollTop, 0);
  await assert.rejects(() => scrollControlGrid({ ...options, direction: "diagonal" }));
  await assert.rejects(() => scrollControlGrid({ ...options, screens: 6 }));
  options.tab.loading = true;
  await assert.rejects(() => scrollControlGrid(options), /正在加载/);
});

test("viewport snapshot excludes virtual overscan and reports no hidden grid", () => {
  const cell = (rowKey, columnName, top) => ({ dataset: { rowKey, columnName }, getBoundingClientRect: () => ({ top, bottom: top + 20, left: 0, right: 100 }) });
  const wrap = {
    scrollTop: 40, scrollLeft: 0, clientWidth: 500, clientHeight: 200,
    getBoundingClientRect: () => ({ top: 0, bottom: 200, left: 0, right: 500, width: 500, height: 200 }),
    querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 50 }) }),
    querySelectorAll: () => [cell("id=1", "id", 0), cell("id=2", "id", 60), cell("id=2", "name", 60), cell("id=9", "id", 250)],
  };
  assert.deepEqual(gridViewportSnapshot(wrap, {}).visibleRowKeys, ["id=2"]);
  assert.deepEqual(gridViewportSnapshot(wrap, {}).visibleColumns, ["id", "name"]);
  assert.equal(gridViewportSnapshot(null, {}), null);
});
