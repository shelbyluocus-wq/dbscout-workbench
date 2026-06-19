import { reactive, ref } from "vue";
import { normalizeTableName } from "../utils/normalize.js";
import { loadWorkspaceSnapshot } from "../utils/workspacePersistence.js";
import { markPerf, measureAsync } from "../utils/performanceMarks.js";

const SAVED_CONNECTIONS_KEY = "dbscout_connections";
const CONNECTION_ORDER_KEY = "dbscout_connection_order";
const DATABASE_ORDER_KEY = "dbscout_database_order";
const SCHEMA_LOAD_CONCURRENCY = 4;
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
    columns: [],
  };
}

function sourcedSchema(schema, connectionId, database, readOnly = false) {
  return { ...schema, connectionId: connectionId || "", database: database || "", readOnly: Boolean(readOnly || schema?.readOnly) };
}

export function useConnection(workspace, invokeWorkbench) {
  const connections = ref([]);
  const databases = ref([]);
  const selectedConnectionId = ref("");
  const selectedDatabase = ref("");
  const connDialog = reactive({
    open: false,
    kind: CONNECTION_KINDS.mysql.kind,
    host: "127.0.0.1",
    port: CONNECTION_KINDS.mysql.defaultPort,
    username: CONNECTION_KINDS.mysql.defaultUser,
    password: "",
    error: "",
  });
  const busy = ref(false);
  const statusText = ref("");
  let tableLoadToken = 0;
  let connectionSelectionToken = 0;

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

  function buildConnectionUrl({ kind = "mysql", host, port, username, password }) {
    if (!host || !port) return "";
    const normalizedKind = normalizeConnectionKind(kind);
    const { defaultUser, scheme } = CONNECTION_KINDS[normalizedKind];
    return `${scheme}://${encodeURIComponent(username || defaultUser)}:${encodeURIComponent(password || "")}@${String(host).trim()}:${String(port).trim()}`;
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
    const kind = normalizeConnectionKind(connection.kind);
    const defaults = CONNECTION_KINDS[kind];
    connDialog.kind = kind;
    connDialog.host = String(connection.host || "127.0.0.1");
    connDialog.port = String(connection.port || defaults.defaultPort);
    connDialog.username = connection.username || defaults.defaultUser;
    connDialog.password = "";
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
      if (isCurrentTableLoad(token, connectionId, database)) statusText.value = `已连接数据库：${database}`;
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
    let nextIndex = 0;
    const loadedSchemas = new Map();
    const workers = Array.from({ length: Math.min(SCHEMA_LOAD_CONCURRENCY, tables.length) }, async () => {
      while (nextIndex < tables.length && isCurrentTableLoad(token, connectionId, database)) {
        const table = tables[nextIndex++];
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

  function openConnDialog() {
    connDialog.error = "";
    connDialog.kind = connDialog.kind || CONNECTION_KINDS.mysql.kind;
    connDialog.open = true;
  }

  function cancelConnDialog() {
    connDialog.open = false;
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
      const database = newConnection?.database || dbList[0] || "";
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
    databases,
    selectedConnectionId,
    selectedDatabase,
    connDialog,
    busy,
    statusText,
    loadConnections,
    selectConnection,
    selectDatabase,
    reorderConnections,
    reorderDatabases,
    loadTables,
    ensureTableSchema,
    buildConnectionUrl,
    isReadOnlyConnection,
    openConnDialog,
    cancelConnDialog,
    submitConnDialog,
  };
}
