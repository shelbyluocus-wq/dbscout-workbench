import { markRaw, toRaw } from "vue";
import { columnName } from "./utils/normalize.js";

const tabBindingsByStore = new WeakMap();

function rawRowArray(value) {
  return Array.isArray(value) ? toRaw(value) : [];
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function absoluteInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

export class DenseRowStore {
  constructor(rows = [], {
    absoluteStart = 0,
    totalLength,
    generation = 0,
  } = {}) {
    this._rows = rawRowArray(rows);
    this._absoluteStart = nonNegativeInteger(absoluteStart);
    this._totalLength = Math.max(
      this._absoluteStart + this._rows.length,
      nonNegativeInteger(totalLength, this._absoluteStart + this._rows.length),
    );
    this.generation = nonNegativeInteger(generation);
    this.identityGeneration = this.generation;
    this._rowVersions = new Map();
    this._listeners = new Set();
  }

  get length() {
    return this._totalLength;
  }

  get loadedLength() {
    return this._rows.length;
  }

  get absoluteStart() {
    return this._absoluteStart;
  }

  get(absoluteIndex) {
    const normalizedIndex = absoluteInteger(absoluteIndex);
    if (normalizedIndex == null) return undefined;
    const loadedIndex = normalizedIndex - this._absoluteStart;
    return loadedIndex >= 0 && loadedIndex < this._rows.length
      ? this._rows[loadedIndex]
      : undefined;
  }

  toArray() {
    return this._rows;
  }

  replacePage(rows = [], { absoluteStart = 0, totalLength } = {}) {
    this._rowVersions.clear();
    this._rows = rawRowArray(rows);
    this._absoluteStart = nonNegativeInteger(absoluteStart);
    this._totalLength = Math.max(
      this._absoluteStart + this._rows.length,
      nonNegativeInteger(totalLength, this._absoluteStart + this._rows.length),
    );
    this._notify();
    return this;
  }

  appendPage(rows = [], { totalLength } = {}) {
    const nextRows = rawRowArray(rows);
    for (const row of nextRows) this._rows.push(row);
    this._totalLength = Math.max(
      this._absoluteStart + this._rows.length,
      nonNegativeInteger(totalLength, this._totalLength),
    );
    this._notify();
    return this;
  }

  prependPage(rows = []) {
    const nextRows = rawRowArray(rows);
    this._rowVersions = new Map([...this._rowVersions].map(([index, version]) => [index + nextRows.length, version]));
    if (nextRows.length > 0) this._rows.unshift(...nextRows);
    this._notify();
    return this;
  }

  *iterateLoadedRange(loadedStart = 0, loadedEnd = this._rows.length) {
    const start = Math.min(this._rows.length, nonNegativeInteger(loadedStart));
    const end = Math.min(
      this._rows.length,
      Math.max(start, nonNegativeInteger(loadedEnd, this._rows.length)),
    );
    for (let loadedIndex = start; loadedIndex < end; loadedIndex += 1) {
      yield {
        absoluteIndex: this._absoluteStart + loadedIndex,
        loadedIndex,
        row: this._rows[loadedIndex],
      };
    }
  }

  indexOfKey(rowKey, keyOf) {
    if (typeof keyOf !== "function") return -1;
    for (const { absoluteIndex, row } of this.iterateLoadedRange()) {
      if (keyOf(row) === rowKey) return absoluteIndex;
    }
    return -1;
  }

  rowForKey(rowKey, keyOf) {
    const absoluteIndex = this.indexOfKey(rowKey, keyOf);
    return absoluteIndex >= 0 ? this.get(absoluteIndex) || null : null;
  }

  mutateRow(absoluteIndex, mutation) {
    const normalizedIndex = absoluteInteger(absoluteIndex);
    if (normalizedIndex == null) return false;
    const loadedIndex = normalizedIndex - this._absoluteStart;
    if (loadedIndex < 0 || loadedIndex >= this._rows.length || typeof mutation !== "function") {
      return false;
    }
    const current = this._rows[loadedIndex];
    const before = { ...current };
    const next = mutation(current, normalizedIndex);
    if (next !== undefined) this._rows[loadedIndex] = next;
    const target = this._rows[loadedIndex];
    const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(target || {})])]
      .filter((key) => !Object.is(before[key], target?.[key]));
    if (target === current && !changedKeys.length) return true;
    this._rowVersions.set(loadedIndex, this.rowVersion(normalizedIndex) + 1);
    const owners = tabBindingsByStore.get(this)?.owners;
    const identityChanged = !owners?.size || [...owners].some((tab) => {
      const keys = tab.primaryKeys?.length ? tab.primaryKeys : (tab.columns || []).map(columnName);
      return changedKeys.some((key) => keys.includes(key));
    });
    if (identityChanged) this.identityGeneration += 1;
    this._notify(false);
    return true;
  }

  rowVersion(absoluteIndex) {
    return this._rowVersions.get(Number(absoluteIndex) - this._absoluteStart) || 0;
  }

  invalidate() {
    for (let index = 0; index < this._rows.length; index += 1) {
      this._rowVersions.set(index, (this._rowVersions.get(index) || 0) + 1);
    }
    this._notify();
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify(structureChanged = true) {
    this.generation += 1;
    if (structureChanged) this.identityGeneration += 1;
    for (const listener of this._listeners) listener(this.generation, this);
  }
}

function isRowStore(value) {
  return Boolean(
    value
    && typeof value.get === "function"
    && typeof value.iterateLoadedRange === "function"
    && typeof value.subscribe === "function",
  );
}

function bindTabToStore(tab, store) {
  let binding = tabBindingsByStore.get(store);
  if (!binding) {
    const owners = new Set();
    store.subscribe((nextGeneration) => {
      for (const owner of [...owners].reverse()) {
        owner.dataVersion = nextGeneration;
        owner.rowKeyCacheVersion = store.identityGeneration ?? nextGeneration;
      }
    });
    binding = { owners };
    tabBindingsByStore.set(store, binding);
  }
  binding.owners.add(tab);
  tab.dataVersion = store.generation;
  tab.rowKeyCacheVersion = store.identityGeneration ?? store.generation;
}

export function ensureTabRowStore(tab) {
  if (!tab) return null;
  if (isRowStore(tab.rowStore)) {
    bindTabToStore(tab, tab.rowStore);
    return tab.rowStore;
  }
  const rows = rawRowArray(tab.rows);
  const generation = nonNegativeInteger(tab.dataVersion, nonNegativeInteger(tab.rowKeyCacheVersion));
  const store = markRaw(new DenseRowStore(rows, { generation }));
  tab.rowStore = store;
  bindTabToStore(tab, store);
  Object.defineProperty(tab, "rows", {
    configurable: true,
    enumerable: true,
    get() {
      return this.rowStore.toArray();
    },
    set(nextRows) {
      this.rowStore.replacePage(rawRowArray(nextRows));
    },
  });
  return store;
}

export function tabRows(tab) {
  const store = ensureTabRowStore(tab);
  void tab?.dataVersion;
  return store?.toArray() || [];
}

export function tabRowCount(tab) {
  const store = ensureTabRowStore(tab);
  void tab?.dataVersion;
  return store?.loadedLength || 0;
}

export function tabRowAt(tab, absoluteIndex) {
  const store = ensureTabRowStore(tab);
  void tab?.dataVersion;
  return store?.get(absoluteIndex);
}

export function replaceTabRows(tab, rows, options) {
  const store = ensureTabRowStore(tab);
  store?.replacePage(rows, options);
  return store;
}

export function appendTabRows(tab, rows, options) {
  const store = ensureTabRowStore(tab);
  store?.appendPage(rows, options);
  return store;
}

export function prependTabRows(tab, rows) {
  const store = ensureTabRowStore(tab);
  store?.prependPage(rows);
  return store;
}

export function mutateTabRow(tab, absoluteIndex, mutation) {
  return ensureTabRowStore(tab)?.mutateRow(absoluteIndex, mutation) || false;
}

export function invalidateTabRows(tab) {
  ensureTabRowStore(tab)?.invalidate();
}
