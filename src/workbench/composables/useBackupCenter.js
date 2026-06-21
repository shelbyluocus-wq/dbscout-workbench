import { reactive, shallowRef } from "vue";
import { normalizeTableName } from "../utils/normalize.js";
import {
  invokeWorkbench as defaultInvokeWorkbench,
  listenWorkbenchEvent as defaultListen,
} from "../utils/tauriBridge.js";

const SNAPSHOT_PROGRESS_EVENT = "snapshot-progress";
const BACKUP_JOB_EVENT = "backup-job";

function errorMessage(error) {
  return String(error?.message || error || "未知错误");
}

/**
 * Composable backing the Backup Center dialog. Wraps the 8 backup/audit
 * Tauri commands, exposes reactive audit-log / snapshot / config state, and
 * listens for snapshot-progress + backup-job events (rolled back / restored)
 * so the UI can refresh and the host grid can refetch.
 *
 * @param {object} options
 * @param {() => void} [options.onDataChanged] Called when a rollback/restore
 *   invalidates the currently displayed grid data (host should refetch).
 * @param {(command: string, payload?: object) => Promise<any>} [options.invokeWorkbench]
 *   Injected command invoker (defaults to the real Tauri bridge / mock fallback).
 * @param {(eventName: string, handler: Function) => Function} [options.listen]
 *   Injected event listener (defaults to the real Tauri event bus / mock).
 */
export function useBackupCenter(options = {}) {
  const onDataChanged = options.onDataChanged || (() => {});
  const invokeWorkbench = options.invokeWorkbench || defaultInvokeWorkbench;
  const listen = options.listen || defaultListen;

  const filters = reactive({
    connectionId: "",
    database: "",
    tableName: "",
    limit: 200,
    offset: 0,
  });

  const dialog = reactive({ open: false, tab: "audit" });

  const auditLogs = shallowRef([]);
  const snapshots = shallowRef([]);
  const filterDatabases = shallowRef([]);
  const filterTables = shallowRef([]);
  const config = shallowRef({
    enabled: true,
    intervalMinutes: 30,
    largeTableThreshold: 50000,
    maxPerDb: 50,
    databasesScope: "all",
    auditRetentionDays: 90,
  });

  const progress = reactive({
    active: false,
    jobId: "",
    connectionId: "",
    database: "",
    done: 0,
    total: 0,
    currentTable: "",
    status: "",
    message: "",
  });

  const busy = reactive({
    listing: false,
    filterOptions: false,
    rollingBack: false,
    snapshotting: false,
    restoring: false,
    savingConfig: false,
  });

  const lastError = shallowRef("");
  let filterLoadToken = 0;

  function setFilters(partial) {
    Object.assign(filters, partial);
    filters.offset = 0;
  }

  function ensureSelectedOption(options, value) {
    const selected = String(value || "").trim();
    if (!selected) return options;
    return options.includes(selected) ? options : [selected, ...options];
  }

  async function loadFilterDatabases() {
    const token = ++filterLoadToken;
    if (!filters.connectionId) {
      filterDatabases.value = [];
      filterTables.value = [];
      return [];
    }
    busy.filterOptions = true;
    try {
      const dbList = await invokeWorkbench("list_databases", { connectionId: filters.connectionId });
      if (token !== filterLoadToken || !dialog.open) return [];
      const databases = Array.isArray(dbList) ? dbList.map((item) => String(item || "").trim()).filter(Boolean) : [];
      filterDatabases.value = ensureSelectedOption(databases, filters.database);
      return filterDatabases.value;
    } catch (error) {
      if (token === filterLoadToken) {
        filterDatabases.value = filters.database ? [filters.database] : [];
        lastError.value = errorMessage(error);
      }
      return filterDatabases.value;
    } finally {
      if (token === filterLoadToken) busy.filterOptions = false;
    }
  }

  async function loadFilterTables() {
    const token = ++filterLoadToken;
    if (!filters.connectionId || !filters.database) {
      filterTables.value = [];
      return [];
    }
    busy.filterOptions = true;
    try {
      const tables = await invokeWorkbench("list_tables", {
        connectionId: filters.connectionId,
        database: filters.database,
      });
      if (token !== filterLoadToken || !dialog.open) return [];
      const names = (Array.isArray(tables) ? tables : [])
        .map((table) => normalizeTableName(table))
        .filter(Boolean);
      filterTables.value = ensureSelectedOption(names, filters.tableName);
      return filterTables.value;
    } catch (error) {
      if (token === filterLoadToken) {
        filterTables.value = filters.tableName ? [filters.tableName] : [];
        lastError.value = errorMessage(error);
      }
      return filterTables.value;
    } finally {
      if (token === filterLoadToken) busy.filterOptions = false;
    }
  }

  async function loadFilterOptions() {
    await loadFilterDatabases();
    await loadFilterTables();
  }

  async function loadAuditLogs() {
    busy.listing = true;
    try {
      const request = {
        limit: filters.limit,
        offset: filters.offset,
      };
      if (filters.connectionId) request.connectionId = filters.connectionId;
      if (filters.database) request.database = filters.database;
      if (filters.tableName) request.tableName = filters.tableName;
      auditLogs.value = await invokeWorkbench("list_audit_logs", { request });
      lastError.value = "";
    } catch (error) {
      lastError.value = errorMessage(error);
    } finally {
      busy.listing = false;
    }
  }

  async function loadSnapshots() {
    try {
      const request = {};
      if (filters.connectionId) request.connectionId = filters.connectionId;
      if (filters.database) request.database = filters.database;
      snapshots.value = await invokeWorkbench("list_snapshots", { request });
    } catch (error) {
      lastError.value = errorMessage(error);
    }
  }

  async function loadConfig() {
    try {
      config.value = await invokeWorkbench("get_backup_config", {});
    } catch (error) {
      lastError.value = errorMessage(error);
    }
  }

  async function saveConfig(next) {
    busy.savingConfig = true;
    try {
      config.value = await invokeWorkbench("set_backup_config", { config: next || config.value });
      lastError.value = "";
    } catch (error) {
      lastError.value = errorMessage(error);
    } finally {
      busy.savingConfig = false;
    }
  }

  async function rollback(auditId) {
    busy.rollingBack = true;
    try {
      const result = await invokeWorkbench("rollback_audit_entry", { request: { auditId } });
      await loadAuditLogs();
      // onDataChanged is fired by the backup-job event listener (the backend
      // emits it on rollback/restore), so we don't trigger it again here.
      return result;
    } catch (error) {
      lastError.value = errorMessage(error);
      return { rolledBack: false, conflict: true, message: errorMessage(error) };
    } finally {
      busy.rollingBack = false;
    }
  }

  async function createSnapshot(target = {}) {
    busy.snapshotting = true;
    progress.active = true;
    progress.status = "running";
    try {
      const request = {};
      if (target.connectionId) request.connectionId = target.connectionId;
      if (target.database) request.database = target.database;
      const info = await invokeWorkbench("create_snapshot", { request });
      await loadSnapshots();
      return info;
    } catch (error) {
      lastError.value = errorMessage(error);
      throw error;
    } finally {
      busy.snapshotting = false;
    }
  }

  async function restoreSnapshot(snapshotPath, connectionId) {
    busy.restoring = true;
    try {
      const result = await invokeWorkbench("restore_snapshot", {
        request: { snapshotPath, connectionId },
      });
      // onDataChanged is fired by the backup-job event listener on restore.
      return result;
    } catch (error) {
      lastError.value = errorMessage(error);
      throw error;
    } finally {
      busy.restoring = false;
    }
  }

  async function pruneSnapshots() {
    try {
      const request = {};
      if (filters.connectionId) request.connectionId = filters.connectionId;
      if (filters.database) request.database = filters.database;
      return await invokeWorkbench("prune_snapshots", { request });
    } catch (error) {
      lastError.value = errorMessage(error);
      return { deletedCount: 0 };
    }
  }

  let stopListeners = null;

  async function open() {
    dialog.open = true;
    await Promise.all([loadConfig(), loadFilterOptions(), loadAuditLogs(), loadSnapshots()]);
    if (!stopListeners) {
      stopListeners = startEventListeners();
    }
  }

  function close() {
    dialog.open = false;
    filterLoadToken += 1;
    filterDatabases.value = [];
    filterTables.value = [];
  }

  function startEventListeners() {
    const unlistenProgress = listen(SNAPSHOT_PROGRESS_EVENT, (event) => {
      const payload = event?.payload || event;
      Object.assign(progress, {
        active: payload?.status !== "done" && payload?.status !== "failed",
        jobId: payload?.jobId || "",
        connectionId: payload?.connectionId || "",
        database: payload?.database || "",
        done: payload?.done || 0,
        total: payload?.total || 0,
        currentTable: payload?.currentTable || "",
        status: payload?.status || "",
        message: payload?.message || "",
      });
      if (payload?.status === "done" || payload?.status === "failed") {
        loadSnapshots();
      }
    });
    const unlistenJob = listen(BACKUP_JOB_EVENT, (event) => {
      const payload = event?.payload || event;
      if (payload?.kind === "rollback" || payload?.kind === "restore") {
        onDataChanged();
      }
    });
    return () => {
      unlistenProgress?.();
      unlistenJob?.();
    };
  }

  function dispose() {
    if (stopListeners) {
      stopListeners();
      stopListeners = null;
    }
  }

  return {
    dialog,
    filters,
    auditLogs,
    snapshots,
    filterDatabases,
    filterTables,
    config,
    progress,
    busy,
    lastError,
    setFilters,
    loadFilterOptions,
    loadFilterDatabases,
    loadFilterTables,
    loadAuditLogs,
    loadSnapshots,
    loadConfig,
    saveConfig,
    rollback,
    createSnapshot,
    restoreSnapshot,
    pruneSnapshots,
    open,
    close,
    dispose,
    startEventListeners,
  };
}
