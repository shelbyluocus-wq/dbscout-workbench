export const SIDEBAR_SEARCH_HISTORY_KEY = "dbscout_sidebar_search_history";
export const SIDEBAR_SEARCH_HISTORY_LIMIT = 10;

function normalizeQuery(value) {
  return String(value ?? "").trim();
}

function normalizeScope(scope) {
  return String(scope ?? "").trim();
}

function readStore(storage) {
  try {
    const raw = storage?.getItem?.(SIDEBAR_SEARCH_HISTORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(storage, store) {
  storage?.setItem?.(SIDEBAR_SEARCH_HISTORY_KEY, JSON.stringify(store));
}

export function buildSidebarSearchHistoryScope(connectionId, database) {
  const connection = String(connectionId ?? "").trim();
  const db = String(database ?? "").trim();
  if (!connection || !db) return "";
  return `${connection}\u001f${db}`;
}

export function readSidebarSearchHistory(storage, scope, limit = SIDEBAR_SEARCH_HISTORY_LIMIT) {
  const key = normalizeScope(scope);
  if (!key) return [];
  const entries = readStore(storage)[key];
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => ({
      query: normalizeQuery(entry?.query),
      ts: String(entry?.ts || ""),
    }))
    .filter((entry) => entry.query)
    .slice(0, limit);
}

export function recordSidebarSearchHistory(
  storage,
  scope,
  query,
  limit = SIDEBAR_SEARCH_HISTORY_LIMIT,
) {
  const key = normalizeScope(scope);
  const normalizedQuery = normalizeQuery(query);
  if (!key || !normalizedQuery) {
    return readSidebarSearchHistory(storage, key, limit);
  }

  const store = readStore(storage);
  const existing = readSidebarSearchHistory(storage, key, limit);
  const next = [
    { query: normalizedQuery, ts: new Date().toISOString() },
    ...existing.filter((entry) => entry.query !== normalizedQuery),
  ].slice(0, limit);
  store[key] = next;
  writeStore(storage, store);
  return next;
}

export function removeSidebarSearchHistoryEntry(storage, scope, query) {
  const key = normalizeScope(scope);
  const normalizedQuery = normalizeQuery(query);
  if (!key || !normalizedQuery) return readSidebarSearchHistory(storage, key);

  const store = readStore(storage);
  const next = readSidebarSearchHistory(storage, key).filter((entry) => entry.query !== normalizedQuery);
  if (next.length) store[key] = next;
  else delete store[key];
  writeStore(storage, store);
  return next;
}

export function clearSidebarSearchHistory(storage, scope) {
  const key = normalizeScope(scope);
  if (!key) return [];
  const store = readStore(storage);
  delete store[key];
  writeStore(storage, store);
  return [];
}