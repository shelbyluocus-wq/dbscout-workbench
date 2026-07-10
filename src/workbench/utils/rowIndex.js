import { ensureTabRowStore } from "../rowStore.js";
import { columnName } from "./normalize.js";

const cacheByStore = new WeakMap();

function identityShape(tab) {
  const primaryKeys = Array.isArray(tab?.primaryKeys) ? tab.primaryKeys.filter(Boolean) : [];
  const keys = primaryKeys.length > 0
    ? primaryKeys
    : (Array.isArray(tab?.columns) ? tab.columns.map(columnName).filter(Boolean) : []);
  return keys.join("\u001f");
}

function cacheFor(store, buildRowKey) {
  let caches = cacheByStore.get(store);
  if (!caches) {
    caches = new Map();
    cacheByStore.set(store, caches);
  }
  return { caches, cached: caches.get(buildRowKey) };
}

function buildIndex(tab, store, buildRowKey) {
  const keys = [];
  const indexByKey = new Map();
  const rowByKey = new Map();
  const primaryKeySignatures = new Set();
  for (const { absoluteIndex, loadedIndex, row } of store.iterateLoadedRange()) {
    const key = buildRowKey(tab, row);
    keys[loadedIndex] = key;
    if (!indexByKey.has(key)) {
      indexByKey.set(key, absoluteIndex);
      rowByKey.set(key, row);
    }
    primaryKeySignatures.add(key);
  }
  return {
    generation: Number(tab?.dataVersion ?? store.generation),
    loadedLength: store.loadedLength,
    identityShape: identityShape(tab),
    absoluteStart: store.absoluteStart,
    keys,
    indexByKey,
    rowByKey,
    primaryKeySignatures,
  };
}

function currentIndex(tab, buildRowKey) {
  if (typeof buildRowKey !== "function") {
    throw new TypeError("createRowIndex requires a buildRowKey function");
  }
  const store = ensureTabRowStore(tab);
  const { caches, cached } = cacheFor(store, buildRowKey);
  const shape = identityShape(tab);
  if (
    cached
    && cached.generation === Number(tab?.dataVersion ?? store.generation)
    && cached.loadedLength === store.loadedLength
    && cached.identityShape === shape
    && cached.absoluteStart === store.absoluteStart
  ) {
    return { store, index: cached };
  }
  const index = buildIndex(tab, store, buildRowKey);
  caches.set(buildRowKey, index);
  return { store, index };
}

export function createRowIndex(tab, { buildRowKey } = {}) {
  return {
    indexOfKey(rowKey) {
      return currentIndex(tab, buildRowKey).index.indexByKey.get(rowKey) ?? -1;
    },
    rowForKey(rowKey) {
      return currentIndex(tab, buildRowKey).index.rowByKey.get(rowKey) || null;
    },
    keyAt(absoluteIndex) {
      const { store, index } = currentIndex(tab, buildRowKey);
      const loadedIndex = Number(absoluteIndex) - store.absoluteStart;
      return Number.isInteger(loadedIndex) && loadedIndex >= 0
        ? index.keys[loadedIndex] ?? null
        : null;
    },
    rowAt(absoluteIndex) {
      return currentIndex(tab, buildRowKey).store.get(absoluteIndex) || null;
    },
    keys() {
      return [...currentIndex(tab, buildRowKey).index.keys];
    },
    primaryKeySignatures() {
      return new Set(currentIndex(tab, buildRowKey).index.primaryKeySignatures);
    },
    hasPrimaryKeySignature(signature) {
      return currentIndex(tab, buildRowKey).index.primaryKeySignatures.has(signature);
    },
  };
}

export function clearRowIndexCache(tab) {
  const store = ensureTabRowStore(tab);
  if (store) cacheByStore.delete(store);
}
