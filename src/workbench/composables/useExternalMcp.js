import { ref } from "vue";
import { listenWorkbenchEvent } from "../utils/tauriBridge.js";

const DEFAULT_PERMISSIONS = { navigate: true, writeData: true, schema: true, manageTables: true, readProject: false, scanRelations: false, editRelations: false };

function normalizeRowIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).map(([key, raw]) => [key.trim(), String(raw ?? "")]).filter(([key]) => key);
  return entries.length ? Object.fromEntries(entries) : null;
}

export function normalizeControlAction(payload) {
  const action = String(payload.action || "").trim();
  const supported = ["open_table", "focus_column", "focus_row", "focus_cell", "refresh_table", "select_database", "open_sql", "select_range", "scroll_table", "get_view_state"];
  if (!supported.includes(action)) return null;
  const tableName = String(payload.tableName || payload.table || "").trim();
  if (!["select_database", "open_sql", "get_view_state"].includes(action) && !tableName) return null;
  if (action === "select_database" && !String(payload.database || "").trim()) return null;
  if (action === "open_sql" && !String(payload.sql || "").trim()) return null;
  const normalized = {
    requestId: String(payload.requestId || `workbench-action-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    action,
    connectionId: String(payload.connectionId || payload.connection_id || ""),
    database: String(payload.database || ""),
    tableName,
    tableComment: String(payload.tableComment || payload.table_comment || ""),
    ...(payload.demoStep ? { demoStep: String(payload.demoStep) } : {}),
  };
  if (action === "scroll_table") {
    normalized.direction = String(payload.direction || "");
    normalized.screens = Number(payload.screens ?? 1);
  }
  if (action === "focus_column" || action === "focus_cell") {
    normalized.columnName = String(payload.columnName || payload.column || "").trim();
    if (!normalized.columnName) return null;
  }
  if (action === "focus_row" || action === "focus_cell") {
    normalized.rowKey = String(payload.rowKey || payload.row_key || "").trim();
    normalized.rowIdentity = normalizeRowIdentity(payload.rowIdentity || payload.row_identity);
    if (!normalized.rowKey && !normalized.rowIdentity) return null;
  }
  if (action === "open_table") {
    if (typeof payload.filter === "string") normalized.filter = payload.filter;
    if (typeof payload.filterMode === "string") normalized.filterMode = payload.filterMode;
    if (payload.sort && typeof payload.sort === "object") normalized.sort = { ...payload.sort };
  }
  if (action === "open_sql") {
    normalized.sql = String(payload.sql || "");
    normalized.run = payload.run === true;
  }
  if (action === "select_range") {
    normalized.startRowKey = String(payload.startRowKey || "");
    normalized.startRowIdentity = normalizeRowIdentity(payload.startRowIdentity);
    normalized.startColumn = String(payload.startColumn || "").trim();
    normalized.endRowKey = String(payload.endRowKey || "");
    normalized.endRowIdentity = normalizeRowIdentity(payload.endRowIdentity);
    normalized.endColumn = String(payload.endColumn || "");
    if (!normalized.startColumn || (!normalized.startRowKey.trim() && !normalized.startRowIdentity)) return null;
  }
  return normalized;
}

export function useExternalMcp(invokeWorkbench, listen = listenWorkbenchEvent) {
  const pendingWorkbenchActions = ref([]);
  const requestIds = new Set();
  const externalMcpStatus = ref({ enabled: false, connectedClients: 0, permissions: { ...DEFAULT_PERMISSIONS } });
  const externalMcpLoading = ref(false);
  const externalMcpError = ref("");
  let unlisten = null;
  let listenerRequest = null;
  let disposed = false;

  function enqueue(payload) {
    const action = normalizeControlAction(payload || {});
    if (!action || disposed || requestIds.has(action.requestId)) return;
    requestIds.add(action.requestId);
    pendingWorkbenchActions.value.push(action);
  }

  function ensureControlListener() {
    if (disposed || unlisten) return Promise.resolve();
    listenerRequest ||= registerListener().finally(() => { listenerRequest = null; });
    return listenerRequest;
  }

  async function registerListener() {
    const stop = await listen("control-workbench-action", (event) => enqueue(event?.payload));
    if (disposed) { stop?.(); return; }
    unlisten = stop;
    try {
      const queued = await invokeWorkbench("control_frontend_ready");
      for (const payload of Array.isArray(queued) ? queued : []) enqueue(payload);
    } catch {}
  }

  async function disposeControlListener() {
    disposed = true;
    await listenerRequest?.catch(() => {});
    try { await invokeWorkbench("control_frontend_unready"); } catch {}
    unlisten?.();
    unlisten = null;
  }

  async function loadExternalMcpStatus({ silent = false } = {}) {
    if (!silent) {
      externalMcpLoading.value = true;
      externalMcpError.value = "";
    }
    try {
      externalMcpStatus.value = await invokeWorkbench("get_external_mcp_status");
      return externalMcpStatus.value;
    } catch (error) {
      if (!silent) externalMcpError.value = String(error?.message || error);
      return null;
    } finally {
      if (!silent) externalMcpLoading.value = false;
    }
  }

  async function setExternalMcpEnabled(enabled) {
    externalMcpLoading.value = true;
    externalMcpError.value = "";
    try {
      externalMcpStatus.value = await invokeWorkbench("set_external_mcp_enabled", { enabled: Boolean(enabled) });
      return externalMcpStatus.value;
    } catch (error) {
      externalMcpError.value = String(error?.message || error);
      return null;
    } finally {
      externalMcpLoading.value = false;
    }
  }

  async function setExternalMcpPermission(key, value) {
    const previous = { ...DEFAULT_PERMISSIONS, ...externalMcpStatus.value?.permissions };
    const permissions = { ...previous, [key]: Boolean(value) };
    externalMcpStatus.value = { ...externalMcpStatus.value, permissions };
    externalMcpError.value = "";
    try {
      externalMcpStatus.value = await invokeWorkbench("set_external_mcp_permissions", { permissions });
      return externalMcpStatus.value;
    } catch (error) {
      externalMcpStatus.value = { ...externalMcpStatus.value, permissions: previous };
      externalMcpError.value = String(error?.message || error);
      return null;
    }
  }

  async function updateControlContext(context) {
    try { await invokeWorkbench("control_update_context", { context }); } catch {}
  }

  async function completeControlWorkbenchAction(action, result = {}) {
    if (!requestIds.has(String(action?.requestId || ""))) return;
    await invokeWorkbench("control_complete_ui_action", {
      requestId: action.requestId,
      ok: result.ok !== false,
      message: String(result.message || ""),
      context: result.context || null,
    });
  }

  function markWorkbenchActionHandled(requestId) {
    const key = String(requestId || "");
    requestIds.delete(key);
    pendingWorkbenchActions.value = pendingWorkbenchActions.value.filter((action) => action.requestId !== key);
  }

  return {
    pendingWorkbenchActions, ensureControlListener, disposeControlListener,
    completeControlWorkbenchAction, markWorkbenchActionHandled, updateControlContext,
    externalMcpStatus, externalMcpLoading, externalMcpError,
    loadExternalMcpStatus, setExternalMcpEnabled, setExternalMcpPermission,
  };
}
