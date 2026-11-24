import { computed, customRef, reactive, ref } from "vue";
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
      if (attempt >= retryDelays.length || !/no route to host|network is unreachable|host is unreachable/i.test(message)) throw error;
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
    databases.value = moveItem(databases.value, sourceDatabase, targetDatabase, (database) => database, position);
    if (connectionId) databasesByConnection[connectionId] = [...databases.value];
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
      selectedConnection =
        connections.value.find((item) => item.id === snapshot.connectionId && item.connected) ||
        connections.value.find((item) => item.id === snapshot.connectionId) ||
        null;
    }
    if (!selectedConnection) {
      selectedConnection = chooseInitialConnection();
    }

    if (!selectedConnection) {
      statusText.value = "请先新建数据库连接";
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

  function chooseInitialConnection() {
    return (
      connections.value.find((item) => item.connected && item.host && item.host !== "demo") ||
      connections.value.find((item) => item.database) ||
      connections.value[0]
    );
  }

  async function restoreSavedConnectionRuntime(savedConn) {
    const placeholderId = `saved-${savedConnectionKey(savedConn)}`;
    const existing = connections.value.find((connection) => (
      connection.id !== placeholderId && savedConnectionMatches(connection, savedConn)
    ));
    if (existing?.connected) {
      applySavedMetadata(existing, savedConn);
      connections.value = connections.value.filter((connection) => connection.id !== placeholderId);
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
      const restoredDatabases = await restoreRuntimeConnection(invokeWorkbench, { kind, url });
      const previousConnections = connections.value;
      connections.value = applyConnectionOrder(mergeConnections(previousConnections, await invokeWorkbench("list_connections")));
      const restored =
        connections.value.find((connection) => connection.id !== placeholderId && savedConnectionMatches(connection, savedConn)) ||
        connections.value.find((connection) => !previousIds.has(connection.id) && connection.id !== placeholderId);
      if (restored) {
        if (Array.isArray(restoredDatabases)) restoredDatabaseLists.set(restored.id, restoredDatabases);
        applySavedMetadata(restored, savedConn);
        restored.connected = true;
        delete restored.restoreError;
        connections.value = connections.value.filter((connection) => connection.id !== placeholderId);
        return restored;
      }
      return upsertSavedConnectionPlaceholder(savedConn, true);
    } catch (error) {
      const placeholder = upsertSavedConnectionPlaceholder(savedConn, false);
      placeholder.restoreError = String(error?.message || error || formatConnectionTestError(error));
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

  async function selectConnection(connectionId, { preferredDatabase = "" } = {}) {
    if (!connectionId) return SOURCE_SELECTION.failed;
    const connection = connections.value.find((item) => item.id === connectionId);
    if (!connection) return SOURCE_SELECTION.failed;
    const selectionToken = ++connectionSelectionToken;
    busy.value = true;
    try {
      let runtimeConnection = connection;
      if (!connection.connected && connection.saved) {
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
      const nextDatabases = applyDatabaseOrder(
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
    markPerf("tables.loaded", { connectionId, database, count: workspace.tables.length });
    const readOnly = isReadOnlyConnection(connectionId);
    workspace.schema = workspace.tables.map((table) => schemaPlaceholder(table, connectionId, database, readOnly));
    void loadTableSchemasInBackground(workspace.tables, { connectionId, database, token });
    return workspace.tables;
  }

  async function loadTableSchemasInBackground(tables, { connectionId, database, token }) {
    const unloadedTables = tables.filter((table) => (
      table?.schemaLoaded !== true
      && !(Array.isArray(table?.columns) && table.columns.length > 0)
    ));
    // Publish every batch as it arrives, and continue until the whole database
    // is searchable. Foreground table opens remain independent of this work.
    for (let offset = 0; offset < unloadedTables.length; offset += SCHEMA_LOAD_BATCH_SIZE) {
      if (disposed || !isCurrentTableLoad(token, connectionId, database)) return;
      await loadSchemaBatch(unloadedTables.slice(offset, offset + SCHEMA_LOAD_BATCH_SIZE), { connectionId, database, token });
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
          isReadOnlyConnection(connectionId),
          workspace.schema.find((table) => normalizeTableName(table) === tableName)
            || tables.find((table) => normalizeTableName(table) === tableName),
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
    aliases.removeConnectionAliases(connectionId);
    databaseDecorations.removeConnectionDecorations(connectionId);
    delete databasesByConnection[connectionId];
    delete databaseFetchErrors[connectionId];
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
        statusText.value = "请先新建数据库连接";
      }
    }
    statusText.value = `已移除连接 ${connectionLabel(connectionId, connection.label || connectionId)}`;
    return true;
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
    const url = buildConnectionUrl({ kind: normalizedKind, host, port, username, password });
    busy.value = true;
    connDialog.error = "";
    try {
      // Runtime ids are allocated by count: never add/remove mid-restore.
      await whenConnectionsRestored();
      const previousIds = new Set(connections.value.map((connection) => connection.id));
      const dbList = await invokeWorkbench("add_connection", { kind: normalizedKind, url });
      connections.value = applyConnectionOrder(await invokeWorkbench("list_connections"));
      const newConnection =
        connections.value.find((connection) => !previousIds.has(connection.id)) ||
        connections.value[connections.value.length - 1];
      if (newConnection) selectedConnectionId.value = newConnection.id;
      const orderedNewDatabases = applyDatabaseOrder(newConnection?.id || selectedConnectionId.value, dbList);
      databases.value = orderedNewDatabases;
      if (newConnection?.id) databasesByConnection[newConnection.id] = orderedNewDatabases;
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
      statusText.value = `已连接 ${connectionKindLabel(normalizedKind)}，共 ${dbList.length} 个数据库`;
    } catch (error) {
      connDialog.error = String(error);
      statusText.value = `连接失败：${String(error)}`;
    } finally {
      busy.value = false;
    }
  }

  return {
    connections,
    whenConnectionsRestored,
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
    dispose,
  };
}
