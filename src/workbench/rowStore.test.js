import test from "node:test";
import assert from "node:assert/strict";
import { effect, isReactive, reactive } from "vue";

const rowStoreModule = await import("./rowStore.js").catch(() => ({}));
const { DenseRowStore, ensureTabRowStore } = rowStoreModule;

test("DenseRowStore exposes logical and loaded lengths with absolute reads", () => {
  assert.equal(typeof DenseRowStore, "function", "rowStore module is unavailable");
  const store = new DenseRowStore([{ id: "10" }, { id: "11" }], {
    absoluteStart: 10,
    totalLength: 25,
  });

  assert.equal(store.length, 25);
  assert.equal(store.loadedLength, 2);
  assert.deepEqual(store.get(10), { id: "10" });
  assert.deepEqual(store.get(11), { id: "11" });
  assert.equal(store.get(9), undefined);
  assert.equal(store.get(12), undefined);
});

test("DenseRowStore rejects negative and fractional absolute indexes", () => {
  assert.equal(typeof DenseRowStore, "function", "rowStore module is unavailable");
  const store = new DenseRowStore([{ id: "0" }, { id: "1" }]);

  assert.equal(store.get(-1), undefined);
  assert.equal(store.get(-0.5), undefined);
  assert.equal(store.get(0.5), undefined);
  assert.equal(store.mutateRow(-1, () => ({ id: "changed" })), false);
  assert.deepEqual(store.toArray(), [{ id: "0" }, { id: "1" }]);
});

test("DenseRowStore replaces and appends pages without replacing appended storage", () => {
  assert.equal(typeof DenseRowStore, "function", "rowStore module is unavailable");
  const firstRows = [{ id: "1" }];
  const store = new DenseRowStore(firstRows);

  store.appendPage([{ id: "2" }, { id: "3" }]);
  assert.equal(store.toArray(), firstRows);
  assert.deepEqual(store.toArray(), [{ id: "1" }, { id: "2" }, { id: "3" }]);
  assert.equal(store.length, 3);

  const replacement = [{ id: "20" }];
  store.replacePage(replacement, { absoluteStart: 20, totalLength: 40 });
  assert.equal(store.toArray(), replacement);
  assert.equal(store.length, 40);
  assert.deepEqual(store.get(20), { id: "20" });
});

test("DenseRowStore iterates loaded offsets while reporting absolute positions", () => {
  assert.equal(typeof DenseRowStore, "function", "rowStore module is unavailable");
  const store = new DenseRowStore([{ id: "5" }, { id: "6" }, { id: "7" }], {
    absoluteStart: 5,
    totalLength: 20,
  });

  assert.deepEqual([...store.iterateLoadedRange(1, 3)], [
    { absoluteIndex: 6, loadedIndex: 1, row: { id: "6" } },
    { absoluteIndex: 7, loadedIndex: 2, row: { id: "7" } },
  ]);
});

test("DenseRowStore resolves rows and absolute indexes by a supplied key builder", () => {
  assert.equal(typeof DenseRowStore, "function", "rowStore module is unavailable");
  const store = new DenseRowStore([{ id: "40" }, { id: "41" }], {
    absoluteStart: 40,
    totalLength: 100,
  });
  const keyOf = (row) => `id=${row.id}`;

  assert.equal(store.indexOfKey("id=41", keyOf), 41);
  assert.deepEqual(store.rowForKey("id=40", keyOf), { id: "40" });
  assert.equal(store.indexOfKey("id=99", keyOf), -1);
  assert.equal(store.rowForKey("id=99", keyOf), null);
});

test("DenseRowStore mutation methods emit one generation notification each", () => {
  assert.equal(typeof DenseRowStore, "function", "rowStore module is unavailable");
  const store = new DenseRowStore([{ id: "1", name: "Ada" }]);
  const generations = [];
  const unsubscribe = store.subscribe((generation) => generations.push(generation));

  store.mutateRow(0, (row) => ({ ...row, name: "Grace" }));
  store.appendPage([{ id: "2", name: "Lin" }]);
  store.replacePage([{ id: "3", name: "Ken" }]);
  unsubscribe();
  store.invalidate();

  assert.deepEqual(store.get(0), { id: "3", name: "Ken" });
  assert.equal(store.generation, 4);
  assert.deepEqual(generations, [1, 2, 3]);
});

test("tab RowStore unwraps Vue proxies before retaining dense row storage", () => {
  assert.equal(typeof ensureTabRowStore, "function", "rowStore module is unavailable");
  const sourceRows = [{ id: "1" }, { id: "2" }];
  const tab = reactive({ rows: sourceRows });

  const store = ensureTabRowStore(tab);

  assert.equal(isReactive(store.toArray()), false);
  assert.equal(store.toArray(), sourceRows);
});

test("RowStore generation notifies a Vue proxy created after raw tab initialization", () => {
  assert.equal(typeof ensureTabRowStore, "function", "rowStore module is unavailable");
  const rawTab = { rows: [] };
  ensureTabRowStore(rawTab);
  const tab = reactive(rawTab);
  ensureTabRowStore(tab);
  const observed = [];
  effect(() => observed.push(tab.dataVersion));

  tab.rowStore.appendPage([{ id: "1" }]);

  assert.deepEqual(observed, [0, 1]);
});
