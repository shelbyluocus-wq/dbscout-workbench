// 常驻数据库（pinned databases）持久化：用户在 Ctrl+P 浮层里把某些数据库
// 标记为"常驻显示"，跨连接混合展示，方便快速切换。
//
// 结构：[{ connectionId, database }]，顺序即展示顺序。
// 真实的 connectionId / database 仍是后端调用的唯一标识，这里只存选择意向。

const PINNED_DATABASES_KEY = "dbscout_pinned_databases";

function readJsonStorage(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

function sameEntry(left, right) {
  return (
    String(left?.connectionId || "") === String(right?.connectionId || "") &&
    String(left?.database || "") === String(right?.database || "")
  );
}

export function readPinnedDatabases() {
  const list = readJsonStorage(PINNED_DATABASES_KEY, []);
  return Array.isArray(list) ? list.filter((e) => e && e.database) : [];
}

export function writePinnedDatabases(list) {
  writeJsonStorage(
    PINNED_DATABASES_KEY,
    Array.isArray(list) ? list.filter((e) => e && e.database) : [],
  );
}

export function isPinnedDatabase(connectionId, database, list = null) {
  const entries = list || readPinnedDatabases();
  return entries.some((e) => sameEntry(e, { connectionId, database }));
}

export function togglePinnedDatabase(connectionId, database, list = null) {
  const entries = list ? [...list] : readPinnedDatabases();
  const idx = entries.findIndex((e) => sameEntry(e, { connectionId, database }));
  if (idx >= 0) {
    entries.splice(idx, 1);
  } else {
    entries.push({ connectionId: String(connectionId || ""), database: String(database || "") });
  }
  writePinnedDatabases(entries);
  return entries;
}

// 删除连接时清理该连接下的所有常驻条目。
export function removePinnedDatabasesForConnection(connectionId, list = null) {
  const entries = list ? [...list] : readPinnedDatabases();
  const next = entries.filter((e) => String(e.connectionId || "") !== String(connectionId || ""));
  if (next.length !== entries.length) writePinnedDatabases(next);
  return next;
}
