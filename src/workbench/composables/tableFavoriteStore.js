import { ref } from "vue";

export const TABLE_FAVORITES_STORAGE_KEY = "dbscout.table-favorites.v1";

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function normalizeName(value) {
  return String(value || "").trim();
}

function sameScope(entry, connectionId, database) {
  return (
    String(entry?.connectionId || "") === String(connectionId || "") &&
    String(entry?.database || "") === String(database || "")
  );
}

export function normalizeTableFavoriteEntries(value) {
  const source = Array.isArray(value?.entries) ? value.entries : Array.isArray(value) ? value : [];
  const normalized = [];

  source.forEach((entry) => {
    const connectionId = String(entry?.connectionId || "");
    const database = String(entry?.database || "");
    if (!database) return;

    const names = [...new Set((Array.isArray(entry?.tableNames) ? entry.tableNames : [])
      .map(normalizeName)
      .filter(Boolean))];
    if (!names.length) return;

    const existing = normalized.find((item) => sameScope(item, connectionId, database));
    if (existing) {
      existing.tableNames = [...new Set([...existing.tableNames, ...names])];
      return;
    }
    normalized.push({ connectionId, database, tableNames: names });
  });

  return normalized;
}

export function loadTableFavoriteEntries(storage = defaultStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(TABLE_FAVORITES_STORAGE_KEY) || "null");
    if (parsed?.version !== 1) return [];
    return normalizeTableFavoriteEntries(parsed);
  } catch {
    return [];
  }
}

export function saveTableFavoriteEntries(entries, storage = defaultStorage()) {
  try {
    storage?.setItem?.(TABLE_FAVORITES_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: normalizeTableFavoriteEntries(entries),
    }));
  } catch {
    // Favorites are a convenience; table browsing must keep working without storage.
  }
}

export function createTableFavoriteStore({ storage = defaultStorage(), initialEntries } = {}) {
  const entries = ref(initialEntries === undefined
    ? loadTableFavoriteEntries(storage)
    : normalizeTableFavoriteEntries(initialEntries));

  function favoriteNames(connectionId, database) {
    return entries.value.find((entry) => sameScope(entry, connectionId, database))?.tableNames || [];
  }

  function isFavorite(connectionId, database, tableName) {
    const name = normalizeName(tableName);
    return Boolean(name && favoriteNames(connectionId, database).includes(name));
  }

  function replaceScope(connectionId, database, tableNames) {
    const next = entries.value
      .filter((entry) => !sameScope(entry, connectionId, database))
      .map((entry) => ({ ...entry, tableNames: [...entry.tableNames] }));
    const names = [...new Set(tableNames.map(normalizeName).filter(Boolean))];
    if (names.length) {
      next.push({
        connectionId: String(connectionId || ""),
        database: String(database || ""),
        tableNames: names,
      });
    }
    entries.value = next;
    saveTableFavoriteEntries(next, storage);
  }

  function toggleFavorite(connectionId, database, tableName) {
    const name = normalizeName(tableName);
    if (!database || !name) return false;
    const names = [...favoriteNames(connectionId, database)];
    const index = names.indexOf(name);
    if (index >= 0) names.splice(index, 1);
    else names.push(name);
    replaceScope(connectionId, database, names);
    return index < 0;
  }

  function renameFavorite(connectionId, database, oldName, newName) {
    const previous = normalizeName(oldName);
    const nextName = normalizeName(newName);
    const names = [...favoriteNames(connectionId, database)];
    const index = names.indexOf(previous);
    if (index < 0 || !nextName) return false;
    names.splice(index, 1, nextName);
    replaceScope(connectionId, database, names);
    return true;
  }

  return {
    entries,
    favoriteNames,
    isFavorite,
    toggleFavorite,
    renameFavorite,
  };
}

const sharedTableFavoriteStore = createTableFavoriteStore();

export function useTableFavoriteStore() {
  return sharedTableFavoriteStore;
}
