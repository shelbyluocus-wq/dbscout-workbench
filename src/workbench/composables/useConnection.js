import { computed, customRef, reactive, ref, watch } from "vue";
import { normalizeTableName } from "../utils/normalize.js";
import { loadWorkspaceSnapshot } from "../utils/workspacePersistence.js";
import { markPerf, measureAsync } from "../utils/performanceMarks.js";
import { filterVisibleConnections } from "../utils/connectionDisplay.js";
import { syncDatabaseHomeTabs } from "../workspaceState.js";
import { useAliases } from "./aliasStore.js";
import { useDatabaseDecorations } from "./databaseDecorationStore.js";
import { useSchemaMetadata } from "./useSchemaMetadata.js";
import { mergeTableModifiedTimes } from "./tableModifiedTimeRefresh.js";
import {
  CONNECTION_KINDS,
  buildConnectionUrl,
  connectionCapabilities,
  connectionHasCapability,
  connectionKindBadge,
  connectionKindLabel,
  isConnFormComplete,
  isConnTestReady,
  isReadOnlyKind,
  isSupportedConnectionKind,
  normalizeConnectionKind,
} from "../utils/connectionKinds.js";
import { savedConnectionKey } from "../utils/connectionIdentity.js";
import {
  buildImportedConnectionRecord,
  hasConnectableCredentials,
  injectPasswordIntoConnectionUrl,
} from "../utils/navicatImport.js";

export { normalizeAliasInput, resolveDatabaseAlias, resolveConnectionAlias } from "./aliasStore.js";
export {
  CONNECTION_KINDS,
  buildConnectionUrl,
  connectionCapabilities,
  connectionHasCapability,
  connectionKindBadge,
  connectionKindLabel,
  isConnFormComplete,
  isConnTestReady,
  isReadOnlyKind,
  isSupportedConnectionKind,
  normalizeConnectionKind,
};

const SAVED_CONNECTIONS_KEY = "dbscout_connections";
const CONNECTION_ORDER_KEY = "dbscout_connection_order";
const DATABASE_ORDER_KEY = "dbscout_database_order";
// Saved connections the user closed, by savedConnectionKey: they are not
// connected at startup until the user opens them again.
const CLOSED_CONNECTIONS_KEY = "dbscout_closed_connections";
const SCHEMA_LOAD_BATCH_SIZE = 80;
const CONNECTION_TEST_TIMEOUT_MS = 4000;
// Status writes kept until the notice watcher drains them after each task.
const STATUS_JOURNAL_LIMIT = 20;

// How a request to change the selected source ended. `superseded` means a
// newer request took over while this one waited: the source is no longer this
// request's to touch, so its caller must not finish the switch by itself.
export const SOURCE_SELECTION = Object.freeze({
  selected: "selected",
  superseded: "superseded",
  failed: "failed",
});

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

function readClosedConnectionKeys() {
  const stored = readJsonStorage(CLOSED_CONNECTIONS_KEY, []);
  return new Set((Array.isArray(stored) ? stored : []).map(String).filter(Boolean));
}

function rememberConnectionClosed(connection, closed) {
  if (!connection?.saved) return;
  const key = savedConnectionKey(connection);
  const keys = readClosedConnectionKeys();
  if (closed === keys.has(key)) return;
  if (closed) keys.add(key);
  else keys.delete(key);
  writeJsonStorage(CLOSED_CONNECTIONS_KEY, [...keys]);
}

function isPlaceholderConnectionId(connectionId) {
  return String(connectionId || "").startsWith("saved-");
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
  const username = saved.username || defaultUser;
  connection.label = saved.label || (username ? `${username}@${saved.host}:${saved.port}` : `${saved.host}:${saved.port}`);
  connection.host = saved.host;
  connection.port = saved.port;
  connection.username = username;
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
  const columns = Array.isArray(table?.columns) ? table.columns : [];
  return {
    ...table,
    table_name: table?.table_name || table?.tableName || "",
    table_comment: table?.table_comment || table?.tableComment || "",
    connectionId: connectionId || "",
    database: database || "",
    readOnly: Boolean(readOnly || table?.readOnly),
    column_count: table?.column_count ?? table?.columnCount ?? null,
    columnCount: table?.columnCount ?? table?.column_count ?? null,
    schemaLoaded: columns.length > 0 || table?.schemaLoaded === true,
    columns,
  };
}

function sourcedSchema(schema, connectionId, database, readOnly = false, tableMetadata = null, force = false) {
  const columnCount = Array.isArray(schema?.columns) ? schema.columns.length : (schema?.columnCount ?? schema?.column_count ?? null);
  // The table list is live; ordinary schema reads may still come from cache.
  const schemaComment = schema?.table_comment ?? schema?.tableComment;
  const tableComment = tableMetadata?.table_comment ?? tableMetadata?.tableComment;
  const comment = (force ? schemaComment ?? tableComment : tableComment ?? schemaComment) ?? "";
  return {
    ...(tableMetadata || {}),
    ...schema,
    table_comment: comment,
    tableComment: comment,
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

async function restoreRuntimeConnection(invokeWorkbench, payload) {
  const retryDelays = [250, 750];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await invokeWorkbench("restore_connection", payload);
    } catch (error) {
      // macOS can briefly reject LAN routes while registering a cold app launch.
      const message = String(error?.message || error || "");
      if (attempt >= retryDelays.length || !/no route to host|network is unreachable|host is unreachable|operation not permitted/i.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }
  }
}


export function useConnection(workspace, invokeWorkbench, { schemaMetadata: providedSchemaMetadata = null } = {}) {
  // A forced read follows a schema edit. Older background/jump reads must
  // neither publish their old comments nor return them to their callers.
  const schemaRefreshes = new Map();
  let disposed = false;
  const schemaKey = (connectionId, database, tableName) =>
    [connectionId, database, tableName].map((value) => String(value || "").toLowerCase()).join("\u001f");
  const schemaMetadata = providedSchemaMetadata || useSchemaMetadata(invokeWorkbench);
  const connections = ref([]);
  const visibleConnections = computed(() => filterVisibleConnections(connections.value));
  const databases = ref([]);
  const aliases = useAliases();
  const databaseDecorations = useDatabaseDecorations();
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
    reconnectPlaceholderId: "",
    reconnectAlias: "",
    reconnectUrl: "",
    error: "",
    testPassed: false,
  });
  const busy = ref(false);
  const connTestBusy = ref(false);
  let connTestSuccessTimer = null;
  // 结构化错误标志：与 statusText 配合使用。调用 setStatus(text, { error: true })
  // 时置为 true，成功/中性消息置为 false。比纯正则判断更可靠，逐步替换历史赋值点。
  const statusError = ref(false);
  // Revision at which setStatus() last flagged an error. Direct statusText
  // assignments leave statusError untouched, so the flag only describes the
  // message written by that same setStatus() call.
  const statusErrorRevision = ref(-1);
  // Every assignment is journaled and bumps statusRevision, even when the text
  // is unchanged, so a repeated failure is announced again and a message
  // overwritten within the same tick is not lost. Consumers drain the journal.
  const statusRevision = ref(0);
  const statusJournal = [];
  const statusText = customRef((track, trigger) => {
    let value = "";
    return {
      get() {
        track();
        return value;
      },
      set(next) {
        value = next ?? "";
        statusRevision.value += 1;
        statusJournal.push({
          text: value,
          explicitError: statusError.value && statusErrorRevision.value === statusRevision.value,
        });
        if (statusJournal.length > STATUS_JOURNAL_LIMIT) statusJournal.splice(0, statusJournal.length - STATUS_JOURNAL_LIMIT);
        trigger();
      },
    };
  });

  function drainStatusJournal() {
    return statusJournal.splice(0);
  }
  let tableLoadToken = 0;
  let connectionSelectionToken = 0;
  const savedRestoreRequests = new Map();
  // Database lists returned by restore_connection during startup, by runtime id.
  const restoredDatabaseLists = new Map();

  // 统一状态写入入口：同时设置文案与错误标志。鼓励新代码用这个替代直接赋值。
  function setStatus(text, { error = false } = {}) {
    // Flags first: synchronous observers of statusText then see a consistent pair.
    statusError.value = Boolean(error);
    statusErrorRevision.value = error ? statusRevision.value + 1 : -1;
    statusText.value = text ?? "";
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
    const resolvedId = String(connectionId || selectedConnectionId.value || "");
    const isSelectedConn = resolvedId === String(selectedConnectionId.value || "");
    const baseList = isSelectedConn && databases.value.length > 0
      ? databases.value
      : (databasesByConnection[resolvedId] || databases.value);
    const nextList = moveItem(baseList, sourceDatabase, targetDatabase, (database) => database, position);
    if (isSelectedConn) {
      databases.value = nextList;
    }
    if (resolvedId) databasesByConnection[resolvedId] = [...nextList];
    const orderMap = readJsonStorage(DATABASE_ORDER_KEY, {});
    orderMap[databaseOrderKey(resolvedId)] = [...nextList];
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
    const connection = connectionById(resolvedConnectionId);
    if (connection?.saved && !connection.connected) {
      await selectConnection(resolvedConnectionId);
      if (connDialog.open || !connectionById(selectedConnectionId.value)?.connected) return [];
      return [...databases.value];
    }
    const dbList = await measureAsync(
      "database.list",
      () => invokeWorkbench("list_databases", { connectionId: resolvedConnectionId }),
      { connectionId: resolvedConnectionId },
    );
    const ordered = applyDatabaseOrder(resolvedConnectionId, Array.isArray(dbList) ? dbList : []);
    databases.value = ordered;
    databasesByConnection[resolvedConnectionId] = ordered;
    pruneStoredDatabaseOrder(resolvedConnectionId, ordered);
    aliases.pruneDatabaseAliases(resolvedConnectionId, ordered);
    databaseDecorations.pruneDatabaseDecorations(resolvedConnectionId, ordered);
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
  // 进行中的请求 token，避免同一连接并发重复拉取，并供侧栏按连接显示加载态。
  const inFlightConnections = new Set();
  const loadingConnectionIds = reactive(new Set());
  const tablesByDatabase = reactive({});

  function sourceCacheKey(connectionId, database) {
    const cid = String(connectionId || "").trim();
    const db = String(database || "").trim().toLowerCase();
    return cid && db ? `${cid}\u001f${db}` : "";
  }

  function rememberCachedTables(connectionId, database, list) {
    const key = sourceCacheKey(connectionId, database);
    if (!key || !Array.isArray(list)) return;
    tablesByDatabase[key] = list;
  }

  function getCachedTables(connectionId, database) {
    const key = sourceCacheKey(connectionId, database);
    return key && Array.isArray(tablesByDatabase[key]) ? tablesByDatabase[key] : [];
  }

  function clearCachedTablesForConnection(connectionId) {
    const prefix = `${String(connectionId || "").trim()}\u001f`;
    if (prefix === "\u001f") return;
    for (const key of Object.keys(tablesByDatabase)) {
      if (key.startsWith(prefix)) delete tablesByDatabase[key];
    }
  }

  watch(
    () => [workspace.connectionId, workspace.database, workspace.tables],
    ([connectionId, database, tables]) => {
      if (connectionId && database && Array.isArray(tables)) {
        rememberCachedTables(connectionId, database, tables);
      }
    },
  );

  async function fetchDatabasesForConnection(connectionId) {
    const resolvedId = String(connectionId || "").trim();
    if (!resolvedId) return [];
    // Background and bulk listings never open a connection the user closed.
    if (connectionById(resolvedId)?.closed) return [];
    if (inFlightConnections.has(resolvedId)) return databasesByConnection[resolvedId] || [];
    inFlightConnections.add(resolvedId);
    loadingConnectionIds.add(resolvedId);
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
      if (runtimeId !== resolvedId) databasesByConnection[runtimeId] = ordered;
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
      loadingConnectionIds.delete(resolvedId);
    }
  }

  async function fetchAllConnectionsDatabases() {
    const targets = visibleConnections.value
      .filter((connection) => !connection?.closed)
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

  function connectionCapability(connectionId, name) {
    const connection = connectionById(connectionId);
    return connectionHasCapability(connection?.kind, name);
  }

  // Saved connections are restored strictly one after another in saved order:
  // runtime connection ids are allocated in that order and aliases, backups and
  // database order are keyed by them. Startup only waits until the last-used
  // connection is ready; the rest of the same chain continues in background.
  let connectionsRestored = Promise.resolve();

  function whenConnectionsRestored() {
    return connectionsRestored;
  }

  async function restoreDisconnectedSavedConnections({ targetConnectionId = "" } = {}) {
    await connectionsRestored;
    const requestedId = String(targetConnectionId || "").trim();
    if (requestedId && connections.value.some((item) => item.id === requestedId && item.connected)) {
      return true;
    }
    const hasDisconnected = connections.value.some((item) => item?.saved && !item.connected && !item.closed);
    if (!hasDisconnected) return false;
    const saved = readSavedConnections();
    if (!saved.length) return false;
    await restoreSavedConnectionsInOrder(saved, {
      readyWhen: () => Boolean(requestedId) && connections.value.some((item) => (
        item.id === requestedId && item.connected
      )),
    });
    connections.value = applyConnectionOrder(connections.value);
    return requestedId
      ? connections.value.some((item) => item.id === requestedId && item.connected)
      : connections.value.some((item) => item.connected);
  }

  function restoreSavedConnectionsInOrder(saved, { readyWhen = () => false } = {}) {
    let chain = Promise.resolve();
    const steps = saved.map((savedConn) => {
      chain = chain
        .then(() => ensureSavedConnectionRuntime(savedConn))
        .catch(() => null);
      return chain;
    });
    connectionsRestored = chain.then(() => {
      restoredDatabaseLists.clear();
      connections.value = applyConnectionOrder(connections.value);
      markPerf("connection.all-restored", { count: connections.value.length });
    });
    return (async () => {
      for (const step of steps) {
        if (readyWhen()) return;
        await step;
      }
    })();
  }

  async function loadConnections() {
    connections.value = applyConnectionOrder(await measureAsync("connection.list", () => invokeWorkbench("list_connections")));
    const saved = readSavedConnections();
    const snapshot = loadWorkspaceSnapshot();
    const lastUsedConnectionId = String(snapshot?.connectionId || "");
    await restoreSavedConnectionsInOrder(saved, {
      readyWhen: () => Boolean(lastUsedConnectionId) && connections.value.some((item) => (
        item.id === lastUsedConnectionId && item.connected
      )),
    });
    connections.value = applyConnectionOrder(connections.value);
    markPerf("connection.loaded", { count: connections.value.length });
    let selectedConnection;

    if (snapshot?.connectionId) {
      const visibleIds = new Set(visibleConnections.value.map((item) => item.id));
      const allowSnapshotId = visibleIds.size === 0 || visibleIds.has(snapshot.connectionId);
      if (allowSnapshotId) {
        selectedConnection =
          connections.value.find((item) => item.id === snapshot.connectionId && item.connected) ||
          connections.value.find((item) => item.id === snapshot.connectionId && !item.closed) ||
          null;
      }
    }
    if (!selectedConnection) {
      selectedConnection = chooseInitialConnection();
    }

    if (!selectedConnection) {
      statusText.value = connections.value.length ? "连接都已关闭，单击连接即可打开" : "请先新建数据库连接";
      return;
    }
    selectedConnectionId.value = selectedConnection.id;
    if (!selectedConnection.connected && selectedConnection.saved) {
      databases.value = [];
      setStatus(selectedConnection.restoreError || "请重新输入密码以恢复连接", { error: true });
      return;
    }
    try {
      // The restore that just connected already read this server's database
      // list; reuse it instead of a second identical round trip.
      const restoredList = restoredDatabaseLists.get(selectedConnection.id);
      restoredDatabaseLists.delete(selectedConnection.id);
      databases.value = applyDatabaseOrder(
        selectedConnection.id,
        Array.isArray(restoredList)
          ? restoredList
          : await measureAsync(
            "database.list",
            () => invokeWorkbench("list_databases", { connectionId: selectedConnection.id }),
            { connectionId: selectedConnection.id },
          ),
      );
      databasesByConnection[selectedConnection.id] = databases.value;
      markPerf("database.loaded", { connectionId: selectedConnection.id, count: databases.value.length });
    } catch (error) {
      databases.value = [];
      setStatus(`切换连接失败：${String(error)}`, { error: true });
      return;
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

  function chooseInitialConnection({ excludeId = "" } = {}) {
    const candidates = connections.value.filter((item) => !item.closed && item.id !== excludeId);
    return (
      candidates.find((item) => item.connected && item.host && item.host !== "demo") ||
      candidates.find((item) => item.database) ||
      candidates[0]
    );
  }

  function migratePlaceholderAlias(placeholderId, runtimeId, fallbackAlias = "") {
    if (!runtimeId) return;
    const placeholderAlias = placeholderId ? aliases.getConnectionAlias(placeholderId) : "";
    const existingAlias = aliases.getConnectionAlias(runtimeId);
    const nextAlias = existingAlias || placeholderAlias || String(fallbackAlias || "").trim();
    if (!existingAlias && nextAlias) {
      aliases.setConnectionAlias(runtimeId, nextAlias);
    }
    if (placeholderId && placeholderId !== runtimeId && placeholderAlias) {
      aliases.removeConnectionAliases(placeholderId);
    }
  }

  function replaceConnectionOrderId(previousId, nextId) {
    if (!previousId || !nextId || previousId === nextId) return;
    const order = readJsonStorage(CONNECTION_ORDER_KEY, []);
    if (!Array.isArray(order) || !order.includes(previousId)) return;
    const nextOrder = [];
    for (const id of order) {
      const mapped = id === previousId ? nextId : id;
      if (!nextOrder.includes(mapped)) nextOrder.push(mapped);
    }
    writeJsonStorage(CONNECTION_ORDER_KEY, nextOrder);
  }

  async function restoreSavedConnectionRuntime(savedConn) {
    const placeholderId = `saved-${savedConnectionKey(savedConn)}`;
    const existing = connections.value.find((connection) => (
      connection.id !== placeholderId && savedConnectionMatches(connection, savedConn)
    ));
    if (existing?.connected || existing?.closed) {
      applySavedMetadata(existing, savedConn);
      migratePlaceholderAlias(placeholderId, existing.id, savedConn.alias);
      replaceConnectionOrderId(placeholderId, existing.id);
      connections.value = connections.value.filter((connection) => connection.id !== placeholderId);
      return existing;
    }
    const kind = normalizeConnectionKind(savedConn.kind);
    const url = savedConn.url || buildConnectionUrl({ ...savedConn, kind });
    const closed = readClosedConnectionKeys().has(savedConnectionKey(savedConn));
    if (!url) {
      const placeholder = upsertSavedConnectionPlaceholder(savedConn, false);
      placeholder.closed = closed;
      return closed ? placeholder : null;
    }
    const previousIds = new Set(connections.value.map((connection) => connection.id));
    try {
      // A connection the user closed only reserves its id: no network.
      let restoredDatabases = null;
      if (closed) await invokeWorkbench("register_connection", { kind, url });
      else restoredDatabases = await restoreRuntimeConnection(invokeWorkbench, { kind, url });
      const previousConnections = connections.value;
      const merged = mergeConnections(previousConnections, await invokeWorkbench("list_connections"));
      const restored =
        merged.find((connection) => connection.id !== placeholderId && savedConnectionMatches(connection, savedConn)) ||
        merged.find((connection) => !previousIds.has(connection.id) && connection.id !== placeholderId);
      if (restored) {
        if (Array.isArray(restoredDatabases)) {
          restoredDatabaseLists.set(restored.id, restoredDatabases);
          databasesByConnection[restored.id] = applyDatabaseOrder(restored.id, restoredDatabases);
        }
        applySavedMetadata(restored, savedConn);
        migratePlaceholderAlias(placeholderId, restored.id, savedConn.alias);
        replaceConnectionOrderId(placeholderId, restored.id);
        if (selectedConnectionId.value === placeholderId) {
          selectedConnectionId.value = restored.id;
        }
        restored.connected = !closed;
        restored.closed = closed;
        delete restored.restoreError;
        connections.value = applyConnectionOrder(merged.filter((connection) => connection.id !== placeholderId));
        return restored;
      }
      connections.value = applyConnectionOrder(merged);
      const placeholder = upsertSavedConnectionPlaceholder(savedConn, !closed);
      placeholder.closed = closed;
      return placeholder;
    } catch (error) {
      const placeholder = upsertSavedConnectionPlaceholder(savedConn, false);
      placeholder.closed = closed;
      if (!closed) placeholder.restoreError = String(error?.message || error || formatConnectionTestError(error));
      return placeholder;
    }
  }

  function ensureSavedConnectionRuntime(savedConn) {
    const key = savedConnectionKey(savedConn);
    if (savedRestoreRequests.has(key)) return savedRestoreRequests.get(key);
    const request = restoreSavedConnectionRuntime(savedConn)
      .finally(() => savedRestoreRequests.delete(key));
    savedRestoreRequests.set(key, request);
    return request;
  }

  function mergeConnections(previousConnections, nextConnections) {
    const byId = new Map(nextConnections.map((connection) => [connection.id, connection]));
    for (const connection of previousConnections) {
      if (!connection.saved) continue;
      if (byId.has(connection.id)) {
        const next = byId.get(connection.id);
        Object.assign(next, connection, { connected: next.connected, closed: Boolean(next.closed) });
      } else byId.set(connection.id, connection);
    }
    return [...byId.values()];
  }

  function upsertSavedConnectionPlaceholder(savedConn, connected) {
    const id = `saved-${savedConnectionKey(savedConn)}`;
    const existing = connections.value.find((connection) => connection.id === id || savedConnectionMatches(connection, savedConn));
    const placeholder = applySavedMetadata(existing || { id, database: savedConn.database || null }, savedConn);
    placeholder.connected = connected;
    if (savedConn.alias && !aliases.getConnectionAlias(placeholder.id)) {
      aliases.setConnectionAlias(placeholder.id, savedConn.alias);
    }
    if (!existing) connections.value.push(placeholder);
    return placeholder;
  }

  async function selectConnection(connectionId, { preferredDatabase = "" } = {}) {
    if (!connectionId) return SOURCE_SELECTION.failed;
    const connection = connections.value.find((item) => item.id === connectionId);
    if (!connection) return SOURCE_SELECTION.failed;
    const selectionToken = ++connectionSelectionToken;
    busy.value = true;
    try {
      let runtimeConnection = connection;
      // Choosing a closed connection is an explicit request to open it.
      let openedDatabases = null;
      if (connection.closed) {
        const opened = await openConnection(connectionId);
        if (!opened.ok) return SOURCE_SELECTION.failed;
        connectionId = opened.connectionId;
        runtimeConnection = connectionById(connectionId) || connection;
        openedDatabases = opened.databases;
      } else if (!connection.connected && connection.saved) {
        const saved = readSavedConnections().find((item) => savedConnectionMatches(connection, item));
        runtimeConnection = saved ? await ensureSavedConnectionRuntime(saved) : null;
        if (!runtimeConnection?.connected) {
          const detail = runtimeConnection?.restoreError || connection.restoreError;
          prefillConnDialog(connection, detail ? `请重新输入密码以恢复连接：${detail}` : "请重新输入密码以恢复连接");
          setStatus(connDialog.error, { error: true });
          return SOURCE_SELECTION.failed;
        }
        connectionId = runtimeConnection.id;
      }
      if (selectionToken !== connectionSelectionToken) return SOURCE_SELECTION.superseded;
      selectedConnectionId.value = connectionId;
      selectedDatabase.value = "";
      const cachedDatabases = Array.isArray(databasesByConnection[connectionId])
        ? applyDatabaseOrder(connectionId, databasesByConnection[connectionId])
        : [];
      databases.value = cachedDatabases;
      workspace.connectionId = connectionId || "";
      workspace.database = "";
      workspace.tables = [];
      workspace.schema = [];
      ++tableLoadToken;
      const nextDatabases = openedDatabases || applyDatabaseOrder(
        connectionId,
        await measureAsync(
          "database.list",
          () => invokeWorkbench("list_databases", { connectionId }),
          { connectionId },
        ),
      );
      if (selectionToken !== connectionSelectionToken) return SOURCE_SELECTION.superseded;
      databases.value = nextDatabases;
      databasesByConnection[connectionId] = nextDatabases;
      markPerf("database.loaded", { connectionId, count: databases.value.length });
      const requestedDatabase = databases.value.find((database) => (
        String(database) === String(preferredDatabase || "")
      ));
      const restoredDatabase = databases.value.find((database) => (
        String(database) === String(runtimeConnection?.database || "")
      ));
      const database = requestedDatabase || restoredDatabase || databases.value[0] || "";
      if (database) return await selectDatabase({ connectionId, database }, { connectionSelectionToken: selectionToken });
      selectedDatabase.value = "";
      return SOURCE_SELECTION.selected;
    } catch (error) {
      if (selectionToken !== connectionSelectionToken) return SOURCE_SELECTION.superseded;
      prefillConnDialog(connection, "连接已失效，请重新输入密码");
      statusText.value = `切换连接失败：${String(error)}`;
      return SOURCE_SELECTION.failed;
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
    connDialog.importedDatabase = String(connection.database || "").trim();
    connDialog.reconnectPlaceholderId = String(connection.id || "").startsWith("saved-") ? String(connection.id) : "";
    connDialog.reconnectAlias = aliases.getConnectionAlias(connection.id) || "";
    connDialog.reconnectUrl = kind === CONNECTION_KINDS.mongodb.kind ? String(connection.url || "") : "";
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
    if (!database) return SOURCE_SELECTION.failed;
    if (owningConnectionToken === null) connectionSelectionToken += 1;
    else if (owningConnectionToken !== connectionSelectionToken) return SOURCE_SELECTION.superseded;
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
      if (!sameSource(previousSource.selectedConnectionId, previousSource.selectedDatabase, connectionId, database)) {
        schemaMetadata.cancelSource({
          connectionId: previousSource.selectedConnectionId,
          database: previousSource.selectedDatabase,
        });
      }
      const selectionResult = await invokeWorkbench("select_database", { connectionId, database });
      if (!isCurrentTableLoad(token, connectionId, database)) return SOURCE_SELECTION.superseded;
      workspace.connectionId = connectionId || "";
      workspace.database = database;
      if (Array.isArray(selectionResult?.tables)) {
        publishTables(selectionResult.tables, { connectionId, database, token });
      } else {
        await loadTables({ connectionId, database, token });
      }
      if (isCurrentTableLoad(token, connectionId, database)) {
        syncDatabaseHomeTabs(workspace, {
          connectionId,
          database,
          readOnly: isReadOnlyConnection(connectionId),
        });
        statusText.value = `已连接数据库：${databaseLabel(connectionId, database)}`;
        return SOURCE_SELECTION.selected;
      }
      return SOURCE_SELECTION.superseded;
    } catch (error) {
      if (isCurrentTableLoad(token, connectionId, database)) {
        selectedConnectionId.value = previousSource.selectedConnectionId;
        selectedDatabase.value = previousSource.selectedDatabase;
        workspace.connectionId = previousSource.workspaceConnectionId;
        workspace.database = previousSource.workspaceDatabase;
        workspace.tables = previousSource.tables;
        workspace.schema = previousSource.schema;
        statusText.value = `切换数据库失败：${String(error)}`;
        return SOURCE_SELECTION.failed;
      }
      return SOURCE_SELECTION.superseded;
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
    return publishTables(tables, { connectionId, database, token });
  }

  async function refreshTableModifiedTimes({ connectionId = selectedConnectionId.value || null, database = selectedDatabase.value || null } = {}) {
    if (!connectionId || !database) return { updatedCount: 0, stale: false };
    const loadTokenAtStart = tableLoadToken;
    // Silent periodic refresh: background priority so it never takes a
    // foreground database permit from the user's own actions.
    const tables = await invokeWorkbench("list_tables", { connectionId, database, priority: "background" });
    if (
      loadTokenAtStart !== tableLoadToken
      || !sameSource(workspace.connectionId, workspace.database, connectionId, database)
    ) {
      return { updatedCount: 0, stale: true };
    }

    const tableMerge = mergeTableModifiedTimes(workspace.tables, tables);
    const schemaMerge = mergeTableModifiedTimes(workspace.schema, tables);
    if (tableMerge.updatedCount > 0) workspace.tables = tableMerge.tables;
    if (schemaMerge.updatedCount > 0) workspace.schema = schemaMerge.tables;
    const updatedCount = Math.max(tableMerge.updatedCount, schemaMerge.updatedCount);
    markPerf("tables.modified-time-refreshed", { connectionId, database, updatedCount });
    return { updatedCount, stale: false };
  }

  function applyTableModifiedUpdates(payload = {}) {
    const connectionId = String(payload?.connectionId || "").trim();
    const database = String(payload?.database || "").trim();
    const updates = Array.isArray(payload?.updates) ? payload.updates : [];
    if (!connectionId || !database || !updates.length) return { updatedCount: 0 };
    if (
      String(workspace.connectionId || "").trim() !== connectionId
      || String(workspace.database || "").trim().toLowerCase() !== database.toLowerCase()
    ) {
      return { updatedCount: 0 };
    }
    const tableMerge = mergeTableModifiedTimes(workspace.tables, updates);
    const schemaMerge = mergeTableModifiedTimes(workspace.schema, updates);
    if (tableMerge.updatedCount > 0) workspace.tables = tableMerge.tables;
    if (schemaMerge.updatedCount > 0) workspace.schema = schemaMerge.tables;
    return { updatedCount: Math.max(tableMerge.updatedCount, schemaMerge.updatedCount) };
  }

  function publishTables(tables, { connectionId, database, token }) {
    if (!isCurrentTableLoad(token, connectionId, database)) return [];
    workspace.tables = Array.isArray(tables) ? tables : [];
    rememberCachedTables(connectionId, database, workspace.tables);
    markPerf("tables.loaded", { connectionId, database, count: workspace.tables.length });
    const readOnly = isReadOnlyConnection(connectionId);
    workspace.schema = workspace.tables.map((table) => schemaPlaceholder(table, connectionId, database, readOnly));
    void loadTableSchemasInBackground(workspace.tables, { connectionId, database, token });
    return workspace.tables;
  }

  function nowTimestampMs() {
    return typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();
  }

  function yieldToBrowserFrame() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function loadTableSchemasInBackground(tables, { connectionId, database, token }) {
    const unloadedTables = tables.filter((table) => (
      table?.schemaLoaded !== true
      && !(Array.isArray(table?.columns) && table.columns.length > 0)
    ));
    let sliceStart = nowTimestampMs();
    // Publish every batch as it arrives, and continue until the whole database
    // is searchable. Foreground table opens remain independent of this work.
    for (let offset = 0; offset < unloadedTables.length; offset += SCHEMA_LOAD_BATCH_SIZE) {
      if (disposed || !isCurrentTableLoad(token, connectionId, database)) return;
      await loadSchemaBatch(unloadedTables.slice(offset, offset + SCHEMA_LOAD_BATCH_SIZE), { connectionId, database, token });
      if (offset + SCHEMA_LOAD_BATCH_SIZE < unloadedTables.length && nowTimestampMs() - sliceStart >= 8) {
        await yieldToBrowserFrame();
        sliceStart = nowTimestampMs();
      }
    }
  }

  async function loadSchemaBatch(tables, { connectionId, database, token }) {
    const loadedSchemas = new Map();
    const requests = tables
      .map((table) => normalizeTableName(table))
      .filter(Boolean)
      .map((tableName) => ({
        tableName,
        refresh: schemaRefreshes.get(schemaKey(connectionId, database, tableName)),
        promise: schemaMetadata.request({
          connectionId,
          database,
          tableName,
          priority: "background",
        }),
      }));
    const results = await Promise.allSettled(requests.map((request) => request.promise));
    const existingByName = new Map();
    for (const item of workspace.schema) {
      const name = normalizeTableName(item);
      if (name) existingByName.set(name, item);
    }
    const batchByName = new Map();
    for (const item of tables) {
      const name = normalizeTableName(item);
      if (name) batchByName.set(name, item);
    }
    const readOnly = isReadOnlyConnection(connectionId);
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status !== "fulfilled") continue;
      const tableName = requests[index].tableName;
      if (requests[index].refresh !== schemaRefreshes.get(schemaKey(connectionId, database, tableName))) continue;
      loadedSchemas.set(
        tableName,
        sourcedSchema(
          result.value,
          connectionId,
          database,
          readOnly,
          existingByName.get(tableName) || batchByName.get(tableName),
        ),
      );
    }
    if (disposed || !loadedSchemas.size || !isCurrentTableLoad(token, connectionId, database)) return;
    workspace.schema = workspace.schema.map((table) => loadedSchemas.get(normalizeTableName(table)) || table);
  }

  async function ensureTableSchema(
    tableName,
    {
      connectionId = selectedConnectionId.value || null,
      database = selectedDatabase.value || null,
      force = false,
      priority = "visible",
    } = {},
  ) {
    const key = schemaKey(connectionId, database, tableName);
    const request = schemaMetadata.request({
      connectionId,
      database,
      tableName,
      force,
      priority,
    });
    if (force) schemaRefreshes.set(key, request);
    const refresh = schemaRefreshes.get(key);
    const schema = await request;
    if (refresh !== schemaRefreshes.get(key)) return schemaRefreshes.get(key);
    if (!disposed && sameSource(workspace.connectionId, workspace.database, connectionId, database)) {
      const index = workspace.schema.findIndex(
        (item) => normalizeTableName(item) === tableName,
      );
      const nextSchema = sourcedSchema(
        schema,
        connectionId,
        database,
        isReadOnlyConnection(connectionId),
        index >= 0 ? workspace.schema[index] : null,
        force,
      );
      if (index >= 0) workspace.schema[index] = nextSchema;
      else workspace.schema.push(nextSchema);
      if (force) {
        workspace.tables = workspace.tables.map((table) => normalizeTableName(table) === tableName
          ? { ...table, table_comment: nextSchema.table_comment, tableComment: nextSchema.table_comment }
          : table);
      }
    }
    return schema;
  }

  function dispose() {
    disposed = true;
    schemaMetadata.dispose();
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

  function clearConnDialogReconnectMeta() {
    connDialog.reconnectPlaceholderId = "";
    connDialog.reconnectAlias = "";
    connDialog.reconnectUrl = "";
  }

  function openConnDialog() {
    resetConnTestState();
    clearConnDialogReconnectMeta();
    connDialog.error = "";
    connDialog.kind = connDialog.kind || CONNECTION_KINDS.mysql.kind;
    connDialog.importedDatabase = "";
    connDialog.open = true;
  }

  function cancelConnDialog() {
    connDialog.open = false;
    resetConnTestState();
    clearConnDialogReconnectMeta();
    connDialog.error = "";
    connDialog.importedDatabase = "";
  }

  function applyConnConfigImport(config = {}) {
    resetConnTestState();
    clearConnDialogReconnectMeta();
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
      connDialog.error = normalizeConnectionKind(connDialog.kind) === CONNECTION_KINDS.mongodb.kind
        ? "请填写主机和端口，或粘贴 MongoDB 连接串"
        : "请填写主机、端口和用户名";
      return;
    }
    if (!isConnTestReady(connDialog)) {
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
    // Runtime ids are allocated by count: never add/remove mid-restore.
    await whenConnectionsRestored();
    const connection = connectionById(connectionId);
    if (!connection) return false;
    try {
      await invokeWorkbench("remove_connection", { connectionId });
    } catch (error) {
      statusText.value = `移除连接失败：${String(error)}`;
      return false;
    }
    removeSavedConnection(connection);
    rememberConnectionClosed(connection, false);
    aliases.removeConnectionAliases(connectionId);
    databaseDecorations.removeConnectionDecorations(connectionId);
    forgetConnectionCaches(connectionId);
    connections.value = connections.value.filter((item) => item.id !== connectionId);
    writeJsonStorage(CONNECTION_ORDER_KEY, connections.value.map((item) => item.id));
    const orderMap = readJsonStorage(DATABASE_ORDER_KEY, {});
    delete orderMap[databaseOrderKey(connectionId)];
    writeJsonStorage(DATABASE_ORDER_KEY, orderMap);
    if (selectedConnectionId.value === connectionId) {
      await selectFallbackSource();
    }
    statusText.value = `已移除连接 ${connectionLabel(connectionId, connection.label || connectionId)}`;
    return true;
  }

  function clearSelectedSource() {
    selectedConnectionId.value = "";
    selectedDatabase.value = "";
    databases.value = [];
    workspace.connectionId = "";
    workspace.database = "";
    workspace.tables = [];
    workspace.schema = [];
  }

  // After the selected connection went away: the given source when it is on
  // an open connection, otherwise the first open connection, otherwise none.
  async function selectFallbackSource({ connectionId: preferredId = "", database = "", excludeId = "" } = {}) {
    const preferred = preferredId && preferredId !== excludeId ? connectionById(preferredId) : null;
    const next = preferred && !preferred.closed ? preferred : chooseInitialConnection({ excludeId });
    if (next) {
      await selectConnection(next.id, { preferredDatabase: next === preferred ? database : "" });
      return;
    }
    clearSelectedSource();
    statusText.value = connections.value.length ? "连接都已关闭，单击连接即可打开" : "请先新建数据库连接";
  }

  function forgetConnectionCaches(connectionId) {
    delete databasesByConnection[connectionId];
    delete databaseFetchErrors[connectionId];
    loadingConnectionIds.delete(connectionId);
    restoredDatabaseLists.delete(connectionId);
    clearCachedTablesForConnection(connectionId);
  }

  // Closes the connection to the server but keeps it in the tree: its id,
  // alias, order and group stay, and a saved one is not reconnected at
  // startup until it is opened again. `fallback` is the source to show when
  // the closed connection was the selected one (the tab that becomes active).
  async function closeConnection(connectionId, { fallback = null } = {}) {
    const connection = connectionById(connectionId);
    if (!connection || connection.closed || connection.sampleData) return false;
    if (!isPlaceholderConnectionId(connectionId)) {
      try {
        await invokeWorkbench("close_connection", { connectionId });
      } catch (error) {
        setStatus(`关闭连接失败：${String(error?.message || error)}`, { error: true });
        return false;
      }
    }
    connection.connected = false;
    connection.closed = true;
    delete connection.restoreError;
    rememberConnectionClosed(connection, true);
    forgetConnectionCaches(connectionId);
    if (selectedConnectionId.value === connectionId) {
      schemaMetadata.cancelSource({ connectionId, database: selectedDatabase.value });
      await selectFallbackSource({ ...(fallback || {}), excludeId: connectionId });
    }
    statusText.value = `已关闭连接 ${connectionLabel(connectionId, connection.label || connectionId)}`;
    return true;
  }

  // Connects a closed connection again under its own id. Returns the id it
  // now runs under (a saved one that never reached the server gets a new
  // one) and its databases.
  async function openConnection(connectionId) {
    const connection = connectionById(connectionId);
    if (!connection) return { ok: false };
    if (!connection.closed) {
      return { ok: true, connectionId, databases: databasesByConnection[connectionId] || [] };
    }
    loadingConnectionIds.add(connectionId);
    delete databaseFetchErrors[connectionId];
    try {
      let runtimeId = connectionId;
      let list;
      if (isPlaceholderConnectionId(connectionId)) {
        rememberConnectionClosed(connection, false);
        connection.closed = false;
        const saved = readSavedConnections().find((item) => savedConnectionMatches(connection, item));
        const runtime = saved ? await ensureSavedConnectionRuntime(saved) : null;
        if (!runtime?.connected) {
          throw new Error(runtime?.restoreError || connection.restoreError || "无法连接服务器");
        }
        runtimeId = runtime.id;
        list = restoredDatabaseLists.get(runtimeId)
          || await invokeWorkbench("list_databases", { connectionId: runtimeId });
        restoredDatabaseLists.delete(runtimeId);
      } else {
        list = await measureAsync(
          "connection.open",
          () => invokeWorkbench("open_connection", { connectionId }),
          { connectionId },
        );
      }
      const opened = connectionById(runtimeId) || connection;
      opened.connected = true;
      opened.closed = false;
      delete opened.restoreError;
      rememberConnectionClosed(opened, false);
      const ordered = applyDatabaseOrder(runtimeId, Array.isArray(list) ? list : []);
      databasesByConnection[runtimeId] = ordered;
      delete databaseFetchErrors[runtimeId];
      statusText.value = `已打开连接 ${connectionLabel(runtimeId, opened.label || runtimeId)}`;
      return { ok: true, connectionId: runtimeId, databases: ordered };
    } catch (error) {
      const message = String(error?.message || error || "无法连接服务器");
      if (isPlaceholderConnectionId(connectionId) && connectionById(connectionId)) {
        connection.closed = true;
        rememberConnectionClosed(connection, true);
      }
      databaseFetchErrors[connectionId] = { message, needsReconnect: false };
      setStatus(`打开连接失败：${message}`, { error: true });
      return { ok: false, error: message };
    } finally {
      loadingConnectionIds.delete(connectionId);
    }
  }

  async function submitConnDialog() {
    const { kind, host, port, username, password } = connDialog;
    if (!isConnFormComplete(connDialog)) {
      connDialog.error = normalizeConnectionKind(kind) === CONNECTION_KINDS.mongodb.kind
        ? "请填写主机和端口，或粘贴 MongoDB 连接串"
        : "请填写主机、端口和用户名";
      return;
    }
    const normalizedKind = normalizeConnectionKind(kind);
    const reconnectPlaceholderId = connDialog.reconnectPlaceholderId;
    const reconnectAlias = connDialog.reconnectAlias;
    const url =
      normalizedKind === CONNECTION_KINDS.mongodb.kind && connDialog.reconnectUrl
        ? injectPasswordIntoConnectionUrl(connDialog.reconnectUrl, { username, password })
        : buildConnectionUrl({ kind: normalizedKind, host, port, username, password });
    busy.value = true;
    connDialog.error = "";
    try {
      // Runtime ids are allocated by count: never add/remove mid-restore.
      await whenConnectionsRestored();
      const previousIds = new Set(connections.value.map((connection) => connection.id));
      const dbList = await invokeWorkbench("add_connection", { kind: normalizedKind, url });
      connections.value = applyConnectionOrder(
        mergeConnections(connections.value, await invokeWorkbench("list_connections")),
      );
      const newConnection =
        connections.value.find((connection) => !previousIds.has(connection.id) && connection.id !== reconnectPlaceholderId) ||
        connections.value[connections.value.length - 1];
      if (newConnection) selectedConnectionId.value = newConnection.id;
      const orderedNewDatabases = applyDatabaseOrder(newConnection?.id || selectedConnectionId.value, dbList);
      databases.value = orderedNewDatabases;
      if (newConnection?.id) databasesByConnection[newConnection.id] = orderedNewDatabases;
      connDialog.open = false;
      clearConnDialogReconnectMeta();
      if (newConnection) {
        applySavedMetadata(newConnection, {
          host: connDialog.host.trim(),
          port: connDialog.port.trim(),
          username: connDialog.username,
          kind: normalizedKind,
          readOnly: isReadOnlyKind(normalizedKind),
          url,
        });
        migratePlaceholderAlias(reconnectPlaceholderId, newConnection.id, reconnectAlias);
        newConnection.connected = true;
        if (reconnectPlaceholderId && reconnectPlaceholderId !== newConnection.id) {
          connections.value = connections.value.filter((connection) => connection.id !== reconnectPlaceholderId);
        }
      }
      rememberConnectionClosed({ saved: true, kind: normalizedKind, host: connDialog.host.trim(), port: connDialog.port.trim(), username: connDialog.username }, false);
      writeSavedConnection({
        kind: normalizedKind,
        host: connDialog.host.trim(),
        port: connDialog.port.trim(),
        username: connDialog.username,
        password: connDialog.password,
        alias: reconnectAlias || undefined,
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
      statusText.value = `已连接 ${connectionKindLabel(normalizedKind)}，共 ${dbList.length} 个数据库`;
    } catch (error) {
      connDialog.error = String(error);
      statusText.value = `连接失败：${String(error)}`;
    } finally {
      busy.value = false;
    }
  }

  function listSavedConnections() {
    return readSavedConnections();
  }

  async function importNavicatConnections(items, { onFirstConnected = null } = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return { added: 0, updated: 0, skipped: 0, total: 0 };

    await whenConnectionsRestored();

    const hadConnectedServer = connections.value.some((connection) => connection?.connected);
    const seenKeys = new Set();
    const toRestore = [];
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const rawItem of list) {
      const record = buildImportedConnectionRecord(rawItem);
      if (!record.host) {
        skipped += 1;
        continue;
      }
      const key = savedConnectionKey(record);
      if (seenKeys.has(key)) {
        skipped += 1;
        continue;
      }
      seenKeys.add(key);

      const existingConn = connections.value.find((connection) => savedConnectionMatches(connection, record));
      const existingSaved = readSavedConnections().find((saved) => savedConnectionKey(saved) === key);
      const mergedRecord = {
        ...record,
        alias: record.alias || existingSaved?.alias || "",
        database: record.database || existingSaved?.database || "",
      };

      writeSavedConnection(mergedRecord);

      if (existingConn || existingSaved) {
        updated += 1;
        if (existingConn) {
          if (mergedRecord.alias && !aliases.getConnectionAlias(existingConn.id)) {
            aliases.setConnectionAlias(existingConn.id, mergedRecord.alias);
          }
          if (!existingConn.connected) {
            applySavedMetadata(existingConn, mergedRecord);
            if (hasConnectableCredentials(mergedRecord)) toRestore.push(mergedRecord);
          }
        } else {
          upsertSavedConnectionPlaceholder(mergedRecord, false);
          if (hasConnectableCredentials(mergedRecord)) toRestore.push(mergedRecord);
        }
      } else {
        added += 1;
        upsertSavedConnectionPlaceholder(mergedRecord, false);
        if (hasConnectableCredentials(mergedRecord)) toRestore.push(mergedRecord);
      }
    }

    writeJsonStorage(CONNECTION_ORDER_KEY, connections.value.map((connection) => connection.id));

    if (toRestore.length > 0) {
      const restorePromise = restoreSavedConnectionsInOrder(toRestore, { readyWhen: () => true });
      void restorePromise
        .then(() => connectionsRestored)
        .then(async () => {
          if (disposed || hadConnectedServer) return;
          const firstConnected = connections.value.find((connection) => connection?.connected);
          if (!firstConnected) return;
          if (!selectedConnectionId.value || String(selectedConnectionId.value).startsWith("saved-")) {
            await selectConnection(firstConnected.id);
            if (typeof onFirstConnected === "function") {
              await onFirstConnected(firstConnected);
            }
          }
        })
        .catch(() => null);
    }

    const total = added + updated;
    if (added > 0 && updated > 0) {
      statusText.value = `已从 Navicat 导入 ${added} 个新连接，更新 ${updated} 个已有连接`;
    } else if (added > 0) {
      statusText.value = `已从 Navicat 导入 ${added} 个连接`;
    } else if (updated > 0) {
      statusText.value = `已更新 ${updated} 个 Navicat 连接`;
    }
    return { added, updated, skipped, total };
  }

  return {
    connections,
    whenConnectionsRestored,
    restoreDisconnectedSavedConnections,
    visibleConnections,
    databases,
    databasesByConnection,
    databaseFetchErrors,
    loadingConnectionIds,
    getCachedTables,
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
    databaseDecorations: databaseDecorations.decorations,
    getDatabaseDecoration: databaseDecorations.getDatabaseDecoration,
    setDatabaseDecoration: databaseDecorations.setDatabaseDecoration,
    selectedConnectionId,
    selectedDatabase,
    connDialog,
    busy,
    connTestBusy,
    statusText,
    statusRevision,
    statusError,
    drainStatusJournal,
    setStatus,
    loadConnections,
    selectConnection,
    selectDatabase,
    reorderConnections,
    reorderDatabases,
    refreshDatabases,
    loadTables,
    refreshTableModifiedTimes,
    applyTableModifiedUpdates,
    ensureTableSchema,
    buildConnectionUrl,
    isReadOnlyConnection,
    connectionCapability,
    connectionCapabilities,
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
    closeConnection,
    openConnection,
    listSavedConnections,
    importNavicatConnections,
    dispose,
  };
}
