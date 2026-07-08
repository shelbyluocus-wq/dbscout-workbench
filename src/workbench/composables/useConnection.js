import { computed, reactive, ref } from "vue";
import { normalizeTableName } from "../utils/normalize.js";
import { loadWorkspaceSnapshot } from "../utils/workspacePersistence.js";
import { markPerf, measureAsync } from "../utils/performanceMarks.js";
import { filterVisibleConnections } from "../utils/connectionDisplay.js";
import { useAliases } from "./aliasStore.js";

export { normalizeAliasInput, resolveDatabaseAlias, resolveConnectionAlias } from "./aliasStore.js";

const SAVED_CONNECTIONS_KEY = "dbscout_connections";
const CONNECTION_ORDER_KEY = "dbscout_connection_order";
const DATABASE_ORDER_KEY = "dbscout_database_order";
const SCHEMA_LOAD_CONCURRENCY = 4;
const EAGER_SCHEMA_LOAD_TABLE_LIMIT = 80;
const CONNECTION_TEST_TIMEOUT_MS = 4000;
const CONNECTION_KINDS = {
  mysql: { kind: "mysql", defaultPort: "3306", defaultUser: "root", scheme: "mysql" },
  clickhouse: { kind: "clickhouse", defaultPort: "8123", defaultUser: "default", scheme: "http" },
};

function normalizeConnectionKind(kind) {
  return String(kind || CONNECTION_KINDS.mysql.kind).trim().toLowerCase() === CONNECTION_KINDS.clickhouse.kind
    ? CONNECTION_KINDS.clickhouse.kind
    : CONNECTION_KINDS.mysql.kind;
}

function isReadOnlyKind(kind) {
  return normalizeConnectionKind(kind) === CONNECTION_KINDS.clickhouse.kind;
}

function savedConnectionKey(connection) {
  const kind = normalizeConnectionKind(connection?.kind);
  const defaultUser = CONNECTION_KINDS[kind].defaultUser;
  return [kind, connection.host, connection.port, connection.username || defaultUser].map((part) => String(part ?? "").trim()).join(":");
}

function readSavedConnections() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_CONNECTIONS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJsonStorage(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function applyStoredOrder(items, order, identity) {
  const byId = new Map(items.map((item) => [identity(item), item]));
  const ordered = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (!byId.has(id)) continue;
    ordered.push(byId.get(id));
    byId.delete(id);
  }
  return [...ordered, ...byId.values()];
}

function moveItem(items, sourceId, targetId, identity, position = "before") {
  if (!sourceId || !targetId || sourceId === targetId) return items;
  const next = [...items];
  const sourceIndex = next.findIndex((item) => identity(item) === sourceId);
  if (sourceIndex < 0) return items;
  const [source] = next.splice(sourceIndex, 1);
  const targetIndex = next.findIndex((item) => identity(item) === targetId);
  if (targetIndex < 0) return items;
  const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
  next.splice(insertIndex, 0, source);
  return next;
}

function writeSavedConnection(connection) {
  const next = { ...connection, host: String(connection.host || "").trim(), port: String(connection.port || "").trim() };
  const existing = readSavedConnections().filter((item) => savedConnectionKey(item) !== savedConnectionKey(next));
  localStorage.setItem(SAVED_CONNECTIONS_KEY, JSON.stringify([...existing, next]));
}

function removeSavedConnection(connection) {
  const next = readSavedConnections().filter((item) => !savedConnectionMatches(connection, item) && savedConnectionKey(item) !== savedConnectionKey(connection));
  writeJsonStorage(SAVED_CONNECTIONS_KEY, next);
}

function savedConnectionMatches(connection, saved) {
  if (!connection?.host || connection.host === "configured") return false;
  return savedConnectionKey(connection) === savedConnectionKey(saved);
}

function applySavedMetadata(connection, saved) {
  const kind = normalizeConnectionKind(saved.kind || connection.kind);
  const defaultUser = CONNECTION_KINDS[kind].defaultUser;
  connection.kind = kind;
  connection.readOnly = Boolean(saved.readOnly ?? connection.readOnly ?? isReadOnlyKind(kind));
  connection.label = saved.label || `${saved.username || defaultUser}@${saved.host}:${saved.port}`;
  connection.host = saved.host;
  connection.port = saved.port;
  connection.username = saved.username || defaultUser;
  connection.url = saved.url || connection.url;
  connection.saved = true;
  return connection;
}

function sameSource(leftConnectionId, leftDatabase, rightConnectionId, rightDatabase) {
  return String(leftConnectionId || "") === String(rightConnectionId || "") && String(leftDatabase || "") === String(rightDatabase || "");
}

function databaseOrderKey(connectionId) {
  return String(connectionId || "default");
}

function schemaPlaceholder(table, connectionId, database, readOnly = false) {
  return {
    ...table,
    table_name: table?.table_name || table?.tableName || "",
    table_comment: table?.table_comment || table?.tableComment || "",
    connectionId: connectionId || "",
    database: database || "",
    readOnly: Boolean(readOnly || table?.readOnly),
    column_count: table?.column_count ?? table?.columnCount ?? null,
    columnCount: table?.columnCount ?? table?.column_count ?? null,
    schemaLoaded: false,
    columns: [],
  };
}

function sourcedSchema(schema, connectionId, database, readOnly = false) {
  const columnCount = Array.isArray(schema?.columns) ? schema.columns.length : (schema?.columnCount ?? schema?.column_count ?? null);
  return {
    ...schema,
    connectionId: connectionId || "",
    database: database || "",
    readOnly: Boolean(readOnly || schema?.readOnly),
    column_count: columnCount,
    columnCount,
    schemaLoaded: true,
  };
}

function withConnectionTestTimeout(promise) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("连接超时：请检查网络或防火墙设置")),
      CONNECTION_TEST_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function formatConnectionTestError(error) {
  const message = String(error?.message || error || "").trim();
  if (!message) return "连接测试失败：请检查连接参数后重试";
  if (/^认证失败|^权限不足|^无法连接|^连接超时|^无法解析|^数据库不存在|^安全连接失败|^连接失败|^连接测试失败/.test(message)) {
    return message;
  }
  if (/command\s+test_connection\s+not\s+found/i.test(message)) {
    return "测试连接功能不可用，请重启应用后重试";
  }
  const lower = message.toLowerCase();
  if (lower.includes("access denied") || lower.includes("authentication")) {
    return "认证失败：用户名或密码错误";
  }
  if (lower.includes("connection refused") || lower.includes("failed to connect")) {
    return "无法连接到服务器：请检查主机和端口是否正确";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "连接超时：请检查网络或防火墙设置";
  }
  if (lower.includes("unknown host") || lower.includes("dns")) {
    return "无法解析主机名：请检查主机地址是否正确";
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized")) {
    return "认证失败：用户名或密码错误";
  }
  return "连接测试失败：请检查连接参数后重试";
}

function isConnFormComplete(dialog) {
  return Boolean(dialog.host?.trim() && dialog.port?.trim() && dialog.username?.trim());
}

function isConnTestReady(dialog) {
  return isConnFormComplete(dialog) && Boolean(String(dialog.password ?? "").length > 0);
}

function buildConnectionUrl({ kind = "mysql", host, port, username, password }) {
  if (!host || !port) return "";
  const normalizedKind = normalizeConnectionKind(kind);
  const { defaultUser, scheme } = CONNECTION_KINDS[normalizedKind];
  return `${scheme}://${encodeURIComponent(username || defaultUser)}:${encodeURIComponent(password || "")}@${String(host).trim()}:${String(port).trim()}`;
}

export function useConnection(workspace, invokeWorkbench) {
  const connections = ref([]);
  const visibleConnections = computed(() => filterVisibleConnections(connections.value));
  const databases = ref([]);
  const aliases = useAliases();
  const {
    databaseAliases,
    connectionAliases,
    getDatabaseAlias,
    databaseLabel,
    setDatabaseAlias,
    getConnectionAlias,
    connectionLabel,
    setConnectionAlias,
  } = aliases;
  const selectedConnectionId = ref("");
  const selectedDatabase = ref("");
  const connDialog = reactive({
    open: false,
    kind: CONNECTION_KINDS.mysql.kind,
    host: "127.0.0.1",
    port: CONNECTION_KINDS.mysql.defaultPort,
    username: CONNECTION_KINDS.mysql.defaultUser,
    password: "",
    importedDatabase: "",
    error: "",
    testPassed: false,
  });
  const busy = ref(false);
  const connTestBusy = ref(false);
  let connTestSuccessTimer = null;
  const statusText = ref("");
  // 结构化错误标志：与 statusText 配合使用。调用 setStatus(text, { error: true })
  // 时置为 true，成功/中性消息置为 false。比纯正则判断更可靠，逐步替换历史赋值点。
  const statusError = ref(false);
  let tableLoadToken = 0;
  let connectionSelectionToken = 0;

  // 统一状态写入入口：同时设置文案与错误标志。鼓励新代码用这个替代直接赋值。
  function setStatus(text, { error = false } = {}) {
    statusText.value = text ?? "";
    statusError.value = Boolean(error);
  }

  function applyConnectionOrder(list) {
    return applyStoredOrder(list, readJsonStorage(CONNECTION_ORDER_KEY, []), (connection) => connection.id);
  }

  function applyDatabaseOrder(connectionId, list) {
    const orderMap = readJsonStorage(DATABASE_ORDER_KEY, {});
    return applyStoredOrder(list, orderMap[databaseOrderKey(connectionId)] || [], (database) => database);
  }

  function reorderConnections(sourceId, targetId, { position = "before" } = {}) {
    connections.value = moveItem(connections.value, sourceId, targetId, (connection) => connection.id, position);
    writeJsonStorage(CONNECTION_ORDER_KEY, connections.value.map((connection) => connection.id));
  }

  function reorderDatabases(sourceDatabase, targetDatabase, { connectionId = selectedConnectionId.value, position = "before" } = {}) {
    databases.value = moveItem(databases.value, sourceDatabase, targetDatabase, (database) => database, position);
    const orderMap = readJsonStorage(DATABASE_ORDER_KEY, {});
    orderMap[databaseOrderKey(connectionId)] = [...databases.value];
    writeJsonStorage(DATABASE_ORDER_KEY, orderMap);
  }

  function pruneStoredDatabaseOrder(connectionId, databaseNames) {
    const orderMap = readJsonStorage(DATABASE_ORDER_KEY, {});
    const key = databaseOrderKey(connectionId);
    const allowed = new Set(databaseNames);
    if (!Array.isArray(orderMap[key])) return;
    orderMap[key] = orderMap[key].filter((name) => allowed.has(name));
    writeJsonStorage(DATABASE_ORDER_KEY, orderMap);
  }

  async function refreshDatabases({ connectionId } = {}) {
    const resolvedConnectionId = String(connectionId || selectedConnectionId.value || "").trim();
    if (!resolvedConnectionId) return [];
    const dbList = await measureAsync(
      "database.list",
      () => invokeWorkbench("list_databases", { connectionId: resolvedConnectionId }),
      { connectionId: resolvedConnectionId },
    );
    const ordered = applyDatabaseOrder(resolvedConnectionId, Array.isArray(dbList) ? dbList : []);
    databases.value = ordered;
    pruneStoredDatabaseOrder(resolvedConnectionId, ordered);
    aliases.pruneDatabaseAliases(resolvedConnectionId, ordered);
    markPerf("database.refreshed", { connectionId: resolvedConnectionId, count: ordered.length });

    if (selectedConnectionId.value === resolvedConnectionId && selectedDatabase.value && !ordered.includes(selectedDatabase.value)) {
      const nextDatabase = ordered[0] || "";
      if (nextDatabase) {
        await selectDatabase({ connectionId: resolvedConnectionId, database: nextDatabase });
      } else {
        selectedDatabase.value = "";
        workspace.connectionId = resolvedConnectionId;
        workspace.database = "";
        workspace.tables = [];
        workspace.schema = [];
        statusText.value = "当前连接下没有可用数据库";
      }
    }

    return ordered;
  }

  // ── 跨连接数据库缓存（供 Ctrl+P 浮层「连接 → 库」级联使用）──────────────
  // databases.value 只承载当前连接的库列表；这里另立一份按 connectionId 索引的
  // 缓存，供浮层在不停留切换连接的前提下预览/切换其它连接的库。
  const databasesByConnection = reactive({});
  // 失败连接的错误信息：{ [connectionId]: { message, needsReconnect } }
  // needsReconnect=true 表示该连接是未恢复的 saved 连接，需要走 prefillConnDialog。
  const databaseFetchErrors = reactive({});
  // 进行中的请求 token，避免同一连接并发重复拉取。
  const inFlightConnections = new Set();

  async function fetchDatabasesForConnection(connectionId) {
    const resolvedId = String(connectionId || "").trim();
    if (!resolvedId) return [];
    if (inFlightConnections.has(resolvedId)) return databasesByConnection[resolvedId] || [];
    inFlightConnections.add(resolvedId);
    try {
      const connection = connections.value.find((item) => item.id === resolvedId);
      let runtimeId = resolvedId;
      // 未连接的 saved 连接：尝试恢复 runtime，失败则标记需要重新连接。
      if (connection && !connection.connected && connection.saved) {
        const saved = readSavedConnections().find((item) => savedConnectionMatches(connection, item));
        const runtime = saved ? await ensureSavedConnectionRuntime(saved) : null;
        if (!runtime?.connected) {
          databaseFetchErrors[resolvedId] = {
            message: "需重新输入密码",
            needsReconnect: true,
          };
          delete databasesByConnection[resolvedId];
          return [];
        }
        runtimeId = runtime.id;
      }
      const list = await invokeWorkbench("list_databases", { connectionId: runtimeId });
      const ordered = applyDatabaseOrder(runtimeId, Array.isArray(list) ? list : []);
      databasesByConnection[resolvedId] = ordered;
      delete databaseFetchErrors[resolvedId];
      markPerf("database.cached", { connectionId: resolvedId, count: ordered.length });
      return ordered;
    } catch (error) {
      databaseFetchErrors[resolvedId] = {
        message: String(error?.message || error || "加载失败"),
        needsReconnect: false,
      };
      delete databasesByConnection[resolvedId];
      return [];
    } finally {
      inFlightConnections.delete(resolvedId);
    }
  }

  async function fetchAllConnectionsDatabases() {
    const targets = visibleConnections.value
      .map((connection) => connection?.id)
      .filter(Boolean)
      .filter((id) => !inFlightConnections.has(String(id)));
    if (!targets.length) return;
    await Promise.allSettled(targets.map((id) => fetchDatabasesForConnection(id)));
  }

  function connectionById(connectionId) {
    return connections.value.find((connection) => connection.id === connectionId);
  }

  function isReadOnlyConnection(connectionId) {
    const connection = connectionById(connectionId);
    return Boolean(connection?.readOnly || isReadOnlyKind(connection?.kind));
  }

  async function loadConnections() {
    connections.value = applyConnectionOrder(await measureAsync("connection.list", () => invokeWorkbench("list_connections")));
    const saved = readSavedConnections();
    for (const savedConn of saved) {
      await ensureSavedConnectionRuntime(savedConn);
    }
    connections.value = applyConnectionOrder(connections.value);
    markPerf("connection.loaded", { count: connections.value.length });
    const snapshot = loadWorkspaceSnapshot();
    let selectedConnection;

    if (snapshot?.connectionId) {
      selectedConnection =
        connections.value.find((item) => item.id === snapshot.connectionId && item.connected) ||
        connections.value.find((item) => item.id === snapshot.connectionId) ||
        null;
    }
    if (!selectedConnection) {
      selectedConnection = chooseInitialConnection();
    }

    if (!selectedConnection) {
      statusText.value = "请先新建 MySQL 连接";
      return;
    }
    selectedConnectionId.value = selectedConnection.id;
    try {
      databases.value = applyDatabaseOrder(
        selectedConnection.id,
        await measureAsync(
          "database.list",
          () => invokeWorkbench("list_databases", { connectionId: selectedConnection.id }),
          { connectionId: selectedConnection.id },
        ),
      );
      markPerf("database.loaded", { connectionId: selectedConnection.id, count: databases.value.length });
    } catch {
      databases.value = [];
    }

    let targetDatabase;
    if (snapshot?.database && snapshot.connectionId === selectedConnection.id) {
      const dbExists = databases.value.some(
        (db) => String(db) === String(snapshot.database),
      );
      if (dbExists) targetDatabase = snapshot.database;
    }
    if (!targetDatabase) {
      targetDatabase = selectedConnection.database || databases.value[0] || "";
    }
    if (targetDatabase) await selectDatabase({ connectionId: selectedConnection.id, database: targetDatabase });
    else statusText.value = "请选择数据库";
  }

  function chooseInitialConnection() {
    return (
      connections.value.find((item) => item.connected && item.host && item.host !== "demo") ||
      connections.value.find((item) => item.database) ||
      connections.value[0]
    );
  }

  async function ensureSavedConnectionRuntime(savedConn) {
    const existing = connections.value.find((connection) => savedConnectionMatches(connection, savedConn));
    if (existing?.connected) {
      applySavedMetadata(existing, savedConn);
      return existing;
    }
    const kind = normalizeConnectionKind(savedConn.kind);
    const url = savedConn.url || buildConnectionUrl({ ...savedConn, kind });
    if (!url) {
      upsertSavedConnectionPlaceholder(savedConn, false);
      return null;
    }
    const previousIds = new Set(connections.value.map((connection) => connection.id));
    try {
      await invokeWorkbench("restore_connection", { kind, url });
      const previousConnections = connections.value;
      connections.value = applyConnectionOrder(mergeConnections(previousConnections, await invokeWorkbench("list_connections")));
      const restored =
        connections.value.find((connection) => savedConnectionMatches(connection, savedConn)) ||
        connections.value.find((connection) => !previousIds.has(connection.id));
      if (restored) {
        applySavedMetadata(restored, savedConn);
        restored.connected = true;
        return restored;
      }
      return upsertSavedConnectionPlaceholder(savedConn, true);
    } catch {
      return upsertSavedConnectionPlaceholder(savedConn, false);
    }
  }

  function mergeConnections(previousConnections, nextConnections) {
    const byId = new Map(nextConnections.map((connection) => [connection.id, connection]));
    for (const connection of previousConnections) {
      if (!connection.saved) continue;
      if (byId.has(connection.id)) Object.assign(byId.get(connection.id), connection, { connected: byId.get(connection.id).connected });
      else byId.set(connection.id, connection);
    }
    return [...byId.values()];
  }

  function upsertSavedConnectionPlaceholder(savedConn, connected) {
    const id = `saved-${savedConnectionKey(savedConn)}`;
    const existing = connections.value.find((connection) => connection.id === id || savedConnectionMatches(connection, savedConn));
    const placeholder = applySavedMetadata(existing || { id, database: savedConn.database || null }, savedConn);
    placeholder.connected = connected;
    if (!existing) connections.value.push(placeholder);
    return placeholder;
  }

  async function selectConnection(connectionId) {
    if (!connectionId) return;
    const connection = connections.value.find((item) => item.id === connectionId);
    if (!connection) return;
    const selectionToken = ++connectionSelectionToken;
    busy.value = true;
    try {
      let runtimeConnection = connection;
      if (!connection.connected && connection.saved) {
        const saved = readSavedConnections().find((item) => savedConnectionMatches(connection, item));
        runtimeConnection = saved ? await ensureSavedConnectionRuntime(saved) : null;
        if (!runtimeConnection?.connected) {
          prefillConnDialog(connection, "请重新输入密码以恢复连接");
          return;
        }
        connectionId = runtimeConnection.id;
      }
      if (selectionToken !== connectionSelectionToken) return;
      selectedConnectionId.value = connectionId;
      selectedDatabase.value = "";
      databases.value = [];
      workspace.connectionId = connectionId || "";
      workspace.database = "";
      workspace.tables = [];
      workspace.schema = [];
      ++tableLoadToken;
      const nextDatabases = applyDatabaseOrder(
        connectionId,
        await measureAsync(
          "database.list",
          () => invokeWorkbench("list_databases", { connectionId }),
          { connectionId },
        ),
      );
      if (selectionToken !== connectionSelectionToken) return;
      databases.value = nextDatabases;
      markPerf("database.loaded", { connectionId, count: databases.value.length });
      const database = runtimeConnection?.database || databases.value[0] || "";
      if (database) await selectDatabase({ connectionId, database }, { connectionSelectionToken: selectionToken });
      else selectedDatabase.value = "";
    } catch (error) {
      if (selectionToken !== connectionSelectionToken) return;
      prefillConnDialog(connection, "连接已失效，请重新输入密码");
      statusText.value = `切换连接失败：${String(error)}`;
    } finally {
      if (selectionToken === connectionSelectionToken) busy.value = false;
    }
  }

  function prefillConnDialog(connection, message) {
    resetConnTestState();
    const kind = normalizeConnectionKind(connection.kind);
    const defaults = CONNECTION_KINDS[kind];
    connDialog.kind = kind;
    connDialog.host = String(connection.host || "127.0.0.1");
    connDialog.port = String(connection.port || defaults.defaultPort);
    connDialog.username = connection.username || defaults.defaultUser;
    connDialog.password = "";
    connDialog.importedDatabase = "";
    connDialog.error = message;
    connDialog.open = true;
  }

  function isCurrentTableLoad(token, connectionId, database) {
    return token === tableLoadToken && sameSource(selectedConnectionId.value, selectedDatabase.value, connectionId, database);
  }

  async function selectDatabase(selection, { connectionSelectionToken: owningConnectionToken = null } = {}) {
    const database = typeof selection === "string" ? selection : selection?.database;
    const connectionId =
      typeof selection === "string"
        ? selectedConnectionId.value
        : selection?.connectionId || selectedConnectionId.value;
    if (!database) return;
    if (owningConnectionToken === null) connectionSelectionToken += 1;
    else if (owningConnectionToken !== connectionSelectionToken) return;
    const previousSource = {
      selectedConnectionId: selectedConnectionId.value,
      selectedDatabase: selectedDatabase.value,
      workspaceConnectionId: workspace.connectionId,
      workspaceDatabase: workspace.database,
      tables: workspace.tables,
      schema: workspace.schema,
    };
    const token = ++tableLoadToken;
    busy.value = true;
    selectedConnectionId.value = connectionId || "";
    selectedDatabase.value = database;
    try {
      await invokeWorkbench("select_database", { connectionId, database });
      if (!isCurrentTableLoad(token, connectionId, database)) return;
      workspace.connectionId = connectionId || "";
      workspace.database = database;
      await loadTables({ connectionId, database, token });
      if (isCurrentTableLoad(token, connectionId, database)) statusText.value = `已连接数据库：${databaseLabel(connectionId, database)}`;
    } catch (error) {
      if (isCurrentTableLoad(token, connectionId, database)) {
        selectedConnectionId.value = previousSource.selectedConnectionId;
        selectedDatabase.value = previousSource.selectedDatabase;
        workspace.connectionId = previousSource.workspaceConnectionId;
        workspace.database = previousSource.workspaceDatabase;
        workspace.tables = previousSource.tables;
        workspace.schema = previousSource.schema;
        statusText.value = `切换数据库失败：${String(error)}`;
      }
    } finally {
      if (
        token === tableLoadToken &&
        (isCurrentTableLoad(token, connectionId, database) ||
          sameSource(selectedConnectionId.value, selectedDatabase.value, previousSource.selectedConnectionId, previousSource.selectedDatabase))
      ) {
        busy.value = false;
      }
    }
  }

  async function loadTables({ connectionId = selectedConnectionId.value || null, database = selectedDatabase.value || null, token = ++tableLoadToken } = {}) {
    const tables = await invokeWorkbench("list_tables", {
      connectionId,
      database,
    });
    if (!isCurrentTableLoad(token, connectionId, database)) return [];
    workspace.tables = tables;
    markPerf("tables.loaded", { connectionId, database, count: workspace.tables.length });
    const readOnly = isReadOnlyConnection(connectionId);
    workspace.schema = tables.map((table) => schemaPlaceholder(table, connectionId, database, readOnly));
    loadTableSchemasInBackground(tables, { connectionId, database, token });
    return tables;
  }

  async function loadTableSchemasInBackground(tables, { connectionId, database, token }) {
    const eagerTables = tables.length > EAGER_SCHEMA_LOAD_TABLE_LIMIT
      ? tables.slice(0, EAGER_SCHEMA_LOAD_TABLE_LIMIT)
      : tables;
    let nextIndex = 0;
    const loadedSchemas = new Map();
    const workers = Array.from({ length: Math.min(SCHEMA_LOAD_CONCURRENCY, eagerTables.length) }, async () => {
      while (nextIndex < eagerTables.length && isCurrentTableLoad(token, connectionId, database)) {
        const table = eagerTables[nextIndex++];
        const tableName = normalizeTableName(table);
        if (!tableName) continue;
        try {
          const schema = await invokeWorkbench("get_table_schema", {
            connectionId,
            database,
            tableName,
          });
          if (!isCurrentTableLoad(token, connectionId, database)) return;
          loadedSchemas.set(tableName, sourcedSchema(schema, connectionId, database, isReadOnlyConnection(connectionId)));
        } catch {
          // Keep the placeholder visible when a table schema cannot be read.
        }
      }
    });
    await Promise.all(workers);
    if (!loadedSchemas.size || !isCurrentTableLoad(token, connectionId, database)) return;
    workspace.schema = workspace.schema.map((table) => loadedSchemas.get(normalizeTableName(table)) || table);
  }

  async function ensureTableSchema(
    tableName,
    {
      connectionId = selectedConnectionId.value || null,
      database = selectedDatabase.value || null,
    } = {},
  ) {
    const schema = await invokeWorkbench("get_table_schema", {
      connectionId,
      database,
      tableName,
    });
    if (sameSource(workspace.connectionId, workspace.database, connectionId, database)) {
      const index = workspace.schema.findIndex(
        (item) => normalizeTableName(item) === tableName,
      );
      const nextSchema = sourcedSchema(schema, connectionId, database, isReadOnlyConnection(connectionId));
      if (index >= 0) workspace.schema[index] = nextSchema;
      else workspace.schema.push(nextSchema);
    }
    return schema;
  }

  function clearConnTestSuccessTimer() {
    if (connTestSuccessTimer) {
      clearTimeout(connTestSuccessTimer);
      connTestSuccessTimer = null;
    }
  }

  function resetConnTestState() {
    clearConnTestSuccessTimer();
    connDialog.testPassed = false;
  }

  function openConnDialog() {
    resetConnTestState();
    connDialog.error = "";
    connDialog.kind = connDialog.kind || CONNECTION_KINDS.mysql.kind;
    connDialog.importedDatabase = "";
    connDialog.open = true;
  }

  function cancelConnDialog() {
    connDialog.open = false;
    resetConnTestState();
    connDialog.error = "";
    connDialog.importedDatabase = "";
  }

  function applyConnConfigImport(config = {}) {
    resetConnTestState();
    const kind = normalizeConnectionKind(config.kind);
    const defaults = CONNECTION_KINDS[kind];
    connDialog.kind = kind;
    if (config.host) connDialog.host = String(config.host);
    connDialog.port = String(config.port || defaults.defaultPort);
    connDialog.username = String(config.username || defaults.defaultUser);
    connDialog.password = String(config.password ?? "");
    connDialog.importedDatabase = String(config.database || "").trim();
    connDialog.error = "";
    connDialog.open = true;
  }

  function rejectConnConfigImport(error) {
    resetConnTestState();
    connDialog.error = String(error?.message || error || "导入配置失败");
    connDialog.open = true;
  }

  async function testConnDialog() {
    if (!isConnFormComplete(connDialog)) {
      connDialog.error = "请填写主机、端口和用户名";
      return;
    }
    if (!String(connDialog.password ?? "").length) {
      connDialog.error = "请输入密码后再测试连接";
      return;
    }
    const normalizedKind = normalizeConnectionKind(connDialog.kind);
    const url = buildConnectionUrl({
      kind: normalizedKind,
      host: connDialog.host,
      port: connDialog.port,
      username: connDialog.username,
      password: connDialog.password,
    });
    connTestBusy.value = true;
    connDialog.error = "";
    resetConnTestState();
    try {
      await withConnectionTestTimeout(
        invokeWorkbench("test_connection", { kind: normalizedKind, url }),
      );
      connDialog.testPassed = true;
      connTestSuccessTimer = setTimeout(() => {
        if (connDialog.testPassed) connDialog.testPassed = false;
        connTestSuccessTimer = null;
      }, 2000);
    } catch (error) {
      connDialog.testPassed = false;
      connDialog.error = formatConnectionTestError(error);
    } finally {
      connTestBusy.value = false;
    }
  }

  function onConnDialogFieldChange() {
    resetConnTestState();
  }

  async function removeConnection(connectionId) {
    if (!connectionId) return false;
    const connection = connectionById(connectionId);
    if (!connection) return false;
    try {
      await invokeWorkbench("remove_connection", { connectionId });
    } catch (error) {
      statusText.value = `移除连接失败：${String(error)}`;
      return false;
    }
    removeSavedConnection(connection);
    aliases.removeConnectionAliases(connectionId);
    connections.value = connections.value.filter((item) => item.id !== connectionId);
    writeJsonStorage(CONNECTION_ORDER_KEY, connections.value.map((item) => item.id));
    const orderMap = readJsonStorage(DATABASE_ORDER_KEY, {});
    delete orderMap[databaseOrderKey(connectionId)];
    writeJsonStorage(DATABASE_ORDER_KEY, orderMap);
    if (selectedConnectionId.value === connectionId) {
      const next = chooseInitialConnection();
      if (next) {
        await selectConnection(next.id);
      } else {
        selectedConnectionId.value = "";
        selectedDatabase.value = "";
        databases.value = [];
        workspace.connectionId = "";
        workspace.database = "";
        workspace.tables = [];
        workspace.schema = [];
        statusText.value = "请先新建 MySQL 连接";
      }
    }
    statusText.value = `已移除连接 ${connectionLabel(connectionId, connection.label || connectionId)}`;
    return true;
  }

  async function submitConnDialog() {
    const { kind, host, port, username, password } = connDialog;
    if (!host.trim() || !port.trim()) {
      connDialog.error = "请填写主机和端口";
      return;
    }
    const normalizedKind = normalizeConnectionKind(kind);
    const url = buildConnectionUrl({ kind: normalizedKind, host, port, username, password });
    busy.value = true;
    connDialog.error = "";
    try {
      const previousIds = new Set(connections.value.map((connection) => connection.id));
      const dbList = await invokeWorkbench("add_connection", { kind: normalizedKind, url });
      connections.value = applyConnectionOrder(await invokeWorkbench("list_connections"));
      const newConnection =
        connections.value.find((connection) => !previousIds.has(connection.id)) ||
        connections.value[connections.value.length - 1];
      if (newConnection) selectedConnectionId.value = newConnection.id;
      databases.value = applyDatabaseOrder(newConnection?.id || selectedConnectionId.value, dbList);
      connDialog.open = false;
      if (newConnection) {
        applySavedMetadata(newConnection, {
          host: connDialog.host.trim(),
          port: connDialog.port.trim(),
          username: connDialog.username,
          kind: normalizedKind,
          readOnly: isReadOnlyKind(normalizedKind),
          url,
        });
        newConnection.connected = true;
      }
      writeSavedConnection({
        kind: normalizedKind,
        host: connDialog.host.trim(),
        port: connDialog.port.trim(),
        username: connDialog.username,
        password: connDialog.password,
        readOnly: isReadOnlyKind(normalizedKind),
        url,
      });
      const importedDatabase = String(connDialog.importedDatabase || "").trim();
      const database =
        (importedDatabase && dbList.includes(importedDatabase) ? importedDatabase : "") ||
        newConnection?.database ||
        dbList[0] ||
        "";
      if (newConnection && database) await selectDatabase({ connectionId: newConnection.id, database });
      statusText.value = `已连接 ${normalizedKind === CONNECTION_KINDS.clickhouse.kind ? "ClickHouse" : "MySQL"}，共 ${dbList.length} 个数据库`;
    } catch (error) {
      connDialog.error = String(error);
      statusText.value = `连接失败：${String(error)}`;
    } finally {
      busy.value = false;
    }
  }

  return {
    connections,
    visibleConnections,
    databases,
    databasesByConnection,
    databaseFetchErrors,
    fetchDatabasesForConnection,
    fetchAllConnectionsDatabases,
    databaseAliases,
    connectionAliases,
    getDatabaseAlias,
    setDatabaseAlias,
    databaseLabel,
    getConnectionAlias,
    setConnectionAlias,
    connectionLabel,
    selectedConnectionId,
    selectedDatabase,
    connDialog,
    busy,
    connTestBusy,
    statusText,
    statusError,
    setStatus,
    loadConnections,
    selectConnection,
    selectDatabase,
    reorderConnections,
    reorderDatabases,
    refreshDatabases,
    loadTables,
    ensureTableSchema,
    buildConnectionUrl,
    isReadOnlyConnection,
    isConnFormComplete,
    isConnTestReady,
    openConnDialog,
    cancelConnDialog,
    applyConnConfigImport,
    rejectConnConfigImport,
    testConnDialog,
    onConnDialogFieldChange,
    submitConnDialog,
    removeConnection,
  };
}
