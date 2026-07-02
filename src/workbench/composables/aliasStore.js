import { ref } from "vue";

// 本地别名存储（连接 + 数据库）：仅用于展示，真实的连接/库名依旧是后端调用的唯一标识。
// 数据库别名结构：{ [connectionId]: { [databaseName]: alias } }
// 连接别名结构：  { [connectionId]: alias }
const DATABASE_ALIAS_KEY = "dbscout_database_aliases";
const CONNECTION_ALIAS_KEY = "dbscout_connection_aliases";
const ALIAS_MAX_LENGTH = 60;

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

function scopeKey(connectionId) {
  return String(connectionId || "default");
}

// 规范化用户输入的别名：去空白并限制长度；空串表示清除别名。纯函数，便于测试。
export function normalizeAliasInput(value) {
  const text = String(value ?? "").trim();
  return text.length > ALIAS_MAX_LENGTH ? text.slice(0, ALIAS_MAX_LENGTH) : text;
}

// 从数据库别名映射里解析别名，找不到返回空串。纯函数。
export function resolveDatabaseAlias(map, connectionId, database) {
  if (!map || typeof map !== "object") return "";
  const scope = map[scopeKey(connectionId)];
  if (!scope || typeof scope !== "object") return "";
  const alias = scope[String(database ?? "")];
  return typeof alias === "string" ? alias : "";
}

// 从连接别名映射里解析别名，找不到返回空串。纯函数。
export function resolveConnectionAlias(map, connectionId) {
  if (!map || typeof map !== "object") return "";
  const alias = map[scopeKey(connectionId)];
  return typeof alias === "string" ? alias : "";
}

// 模块级单例响应式状态：所有组件共享同一份别名，改动后各处即时更新。
const databaseAliases = ref(readJsonStorage(DATABASE_ALIAS_KEY, {}));
const connectionAliases = ref(readJsonStorage(CONNECTION_ALIAS_KEY, {}));

function getDatabaseAlias(connectionId, database) {
  return resolveDatabaseAlias(databaseAliases.value, connectionId, database);
}

// 数据库展示名：有别名用别名，否则回退真实库名。
function databaseLabel(connectionId, database) {
  return getDatabaseAlias(connectionId, database) || String(database ?? "");
}

// 写入或清除数据库别名：alias 为空则删除该条并恢复真实库名。
function setDatabaseAlias(connectionId, database, alias) {
  const name = String(database ?? "");
  if (!name) return;
  const key = scopeKey(connectionId);
  const next = { ...(databaseAliases.value || {}) };
  const scope = { ...(next[key] || {}) };
  const normalized = normalizeAliasInput(alias);
  if (normalized) {
    scope[name] = normalized;
  } else {
    delete scope[name];
  }
  if (Object.keys(scope).length > 0) {
    next[key] = scope;
  } else {
    delete next[key];
  }
  databaseAliases.value = next;
  writeJsonStorage(DATABASE_ALIAS_KEY, next);
}

// 清理某连接下已不存在的库的陈旧别名。
function pruneDatabaseAliases(connectionId, databaseNames) {
  const key = scopeKey(connectionId);
  const scope = databaseAliases.value?.[key];
  if (!scope || typeof scope !== "object") return;
  const allowed = new Set(databaseNames);
  const nextScope = {};
  for (const [name, alias] of Object.entries(scope)) {
    if (allowed.has(name)) nextScope[name] = alias;
  }
  const next = { ...(databaseAliases.value || {}) };
  if (Object.keys(nextScope).length > 0) {
    next[key] = nextScope;
  } else {
    delete next[key];
  }
  databaseAliases.value = next;
  writeJsonStorage(DATABASE_ALIAS_KEY, next);
}

function getConnectionAlias(connectionId) {
  return resolveConnectionAlias(connectionAliases.value, connectionId);
}

// 连接展示名：有别名用别名，否则回退传入的真实标签（通常是 user@host:port）。
function connectionLabel(connectionId, fallback = "") {
  return getConnectionAlias(connectionId) || String(fallback ?? "");
}

// 写入或清除连接别名：alias 为空则删除并恢复真实标签。
function setConnectionAlias(connectionId, alias) {
  if (!connectionId) return;
  const key = scopeKey(connectionId);
  const next = { ...(connectionAliases.value || {}) };
  const normalized = normalizeAliasInput(alias);
  if (normalized) {
    next[key] = normalized;
  } else {
    delete next[key];
  }
  connectionAliases.value = next;
  writeJsonStorage(CONNECTION_ALIAS_KEY, next);
}

// 移除连接时一并清理其连接别名与该连接下的所有库别名。
function removeConnectionAliases(connectionId) {
  const key = scopeKey(connectionId);
  if (connectionAliases.value?.[key] != null) {
    const nextConn = { ...connectionAliases.value };
    delete nextConn[key];
    connectionAliases.value = nextConn;
    writeJsonStorage(CONNECTION_ALIAS_KEY, nextConn);
  }
  if (databaseAliases.value?.[key] != null) {
    const nextDb = { ...databaseAliases.value };
    delete nextDb[key];
    databaseAliases.value = nextDb;
    writeJsonStorage(DATABASE_ALIAS_KEY, nextDb);
  }
}

export function useAliases() {
  return {
    databaseAliases,
    connectionAliases,
    getDatabaseAlias,
    databaseLabel,
    setDatabaseAlias,
    pruneDatabaseAliases,
    getConnectionAlias,
    connectionLabel,
    setConnectionAlias,
    removeConnectionAliases,
  };
}
