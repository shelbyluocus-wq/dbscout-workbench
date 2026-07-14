export const SQL_RECENT_FILES_KEY = "dbscout.sqlRecentFiles.v1";
export const MAX_RECENT_SQL_FILES = 12;

function defaultStorage() {
  try { return globalThis.localStorage || null; }
  catch { return null; }
}

function normalizeEntry(value) {
  const path = String(value?.path || "").trim();
  if (!path) return null;
  const inferredName = path.split(/[\\/]/).filter(Boolean).at(-1) || "query.sql";
  return {
    path,
    fileName: String(value?.fileName || inferredName),
    openedAt: String(value?.openedAt || new Date().toISOString()),
  };
}

export function loadRecentSqlFiles(storage = defaultStorage()) {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(SQL_RECENT_FILES_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeEntry).filter(Boolean).slice(0, MAX_RECENT_SQL_FILES);
  } catch { return []; }
}

function writeRecentSqlFiles(entries, storage) {
  if (!storage) return entries;
  try { storage.setItem(SQL_RECENT_FILES_KEY, JSON.stringify(entries)); }
  catch { /* Recent files should never block opening or saving SQL. */ }
  return entries;
}

export function rememberRecentSqlFile(file, storage = defaultStorage()) {
  const entry = normalizeEntry({ ...file, openedAt: new Date().toISOString() });
  if (!entry) return loadRecentSqlFiles(storage);
  const pathKey = entry.path.toLocaleLowerCase();
  const next = [entry, ...loadRecentSqlFiles(storage).filter((item) => item.path.toLocaleLowerCase() !== pathKey)]
    .slice(0, MAX_RECENT_SQL_FILES);
  return writeRecentSqlFiles(next, storage);
}

export function forgetRecentSqlFile(path, storage = defaultStorage()) {
  const pathKey = String(path || "").toLocaleLowerCase();
  const next = loadRecentSqlFiles(storage).filter((item) => item.path.toLocaleLowerCase() !== pathKey);
  return writeRecentSqlFiles(next, storage);
}
