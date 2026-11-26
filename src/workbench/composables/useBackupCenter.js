import { reactive, shallowRef } from "vue";
import { useSharedAuditHistory } from "./useSharedAuditHistory.js";
import { useAuditHistory } from "./useAuditHistory.js";
import { normalizeTableName } from "../utils/normalize.js";
import {
  invokeWorkbench as defaultInvokeWorkbench,
  listenWorkbenchEvent as defaultListen,
} from "../utils/tauriBridge.js";

const SNAPSHOT_PROGRESS_EVENT = "snapshot-progress";
const BACKUP_JOB_EVENT = "backup-job";
const SYSTEM_DATABASES = new Set(["information_schema", "performance_schema", "mysql", "sys"]);

function isSystemDatabase(name) {
  return SYSTEM_DATABASES.has(String(name || "").trim().toLowerCase());
}

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

  // "local" = this machine's audit.sqlite; "shared" = all users' changes from
  // the central server. Defaults to local; the host switches to shared when a
  // user is logged in and the server is reachable.
  const auditMode = reactive({ mode: "local" });

  // "server" = 243 GM hourly MySQL backups read through the central server;
  // "local" = this workstation's local snapshots.
  const snapshotSource = reactive({ mode: "server" });

  const gmBackups = reactive({
    status: "idle",
    enabled: false,
    backupDirConfigured: false,
    databases: [],
    dates: [],
    items: [],
    databaseFilter: "",
    dateFilter: "",
    error: "",
    loading: false,
    loadedOnce: false,
    activeBackup: null,
    tables: [],
    tablesLoading: false,
    tablesError: "",
    selectedTables: [],
    tableSearch: "",
  });

  const auditLogs = shallowRef([]);
  const sharedAuditLogs = shallowRef([]);
  const snapshots = shallowRef([]);
  const filterDatabases = shallowRef([]);
  const filterTables = shallowRef([]);
  const config = shallowRef({
    enabled: true,
    intervalMinutes: 30,
    largeTableThreshold: 50000,
    maxPerDb: 50,
    databasesScope: "selected",
    snapshotEnabledDatabases: [],
    auditRetentionDays: 90,
    storageDir: null,
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
    deleting: false,
    pickingDir: false,
    openingPath: false,
    togglingDb: false,
    inspecting: false,
    importing: false,
    pruning: false,
  });

  const history = useAuditHistory({ invokeWorkbench, onBusy: (value) => { busy.restoring = value; } });
  const sharedHistory = useSharedAuditHistory({ invokeWorkbench, logs: sharedAuditLogs, localLogs: auditLogs });
  const lastError = shallowRef("");
  let filterLoadToken = 0;
  let listingRequestCount = 0;
  let gmListToken = 0;
  let gmTablesToken = 0;

  function beginListing() {
    listingRequestCount += 1;
    busy.listing = true;
  }

  function endListing() {
    listingRequestCount = Math.max(0, listingRequestCount - 1);
    busy.listing = listingRequestCount > 0;
  }

  // Draft for the two-phase snapshot import: filled by startImport() (file
  // picked + header parsed), edited via setImportTarget(), consumed by
  // confirmImport(), discarded by cancelImport().
  const importDraft = reactive({
    sourcePath: "",
    fileName: "",
    sizeBytes: 0,
    originConnectionId: "",
    originDatabase: "",
    originTs: "",
    connectionId: "",
    database: "",
    databases: [],
  });

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
      const databases = Array.isArray(dbList)
        ? dbList.map((item) => String(item || "").trim()).filter((item) => item && !isSystemDatabase(item))
        : [];
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
    if (auditMode.mode === "shared") {
      return loadSharedAuditLogs();
    }
    beginListing();
    try {
      const ok = await history.loadTables(filters);
      lastError.value = history.state.error;
      return ok;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    } finally {
      endListing();
    }
  }

  async function loadSharedAuditLogs() {
    beginListing();
    try {
      const ok = await sharedHistory.loadTables(filters);
      lastError.value = sharedHistory.state.error;
      return ok;
    } finally {
      endListing();
    }
  }

  /** Switch between "local" (this machine) and "shared" (all users) views. */
  async function setAuditMode(mode) {
    history.dispose();
    sharedHistory.dispose();
    auditMode.mode = mode === "shared" ? "shared" : "local";
    filters.offset = 0;
    return loadAuditLogs();
  }

  async function loadSnapshots() {
    beginListing();
    try {
      const request = {};
      if (filters.connectionId) request.connectionId = filters.connectionId;
      if (filters.database) request.database = filters.database;
      const list = await invokeWorkbench("list_snapshots", { request });
      snapshots.value = Array.isArray(list)
        ? list.filter((item) => !isSystemDatabase(item?.database))
        : [];
      lastError.value = "";
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    } finally {
      endListing();
    }
  }

  function setSnapshotSource(mode) {
    snapshotSource.mode = mode === "local" ? "local" : "server";
    if (snapshotSource.mode === "server" && !gmBackups.loadedOnce && !gmBackups.loading) {
      loadGmBackups();
    }
  }

  function setGmBackupFilters(partial) {
    Object.assign(gmBackups, partial);
  }

  function closeGmBackupTables() {
    gmTablesToken += 1;
    gmBackups.activeBackup = null;
    gmBackups.tables = [];
    gmBackups.tablesLoading = false;
    gmBackups.tablesError = "";
    gmBackups.selectedTables = [];
    gmBackups.tableSearch = "";
  }

  async function loadGmBackups(overrides = {}) {
    const token = ++gmListToken;
    gmBackups.loading = true;
    gmBackups.error = "";
    const database = "database" in overrides ? overrides.database : gmBackups.databaseFilter;
    const date = "date" in overrides ? overrides.date : gmBackups.dateFilter;
    try {
      const request = {};
      if (database) request.database = database;
      if (date) request.date = date;
      if (overrides.limit) request.limit = overrides.limit;
      const result = await invokeWorkbench("list_gm_backups", { request });
      if (token !== gmListToken) return false;
      const payload = result || {};
      gmBackups.status = payload.status || (payload.enabled ? "ok" : "disabled");
      gmBackups.enabled = Boolean(payload.enabled);
      gmBackups.backupDirConfigured = Boolean(payload.backupDirConfigured);
      gmBackups.databases = Array.isArray(payload.databases) ? payload.databases : [];
      gmBackups.dates = Array.isArray(payload.dates) ? payload.dates : [];
      gmBackups.items = Array.isArray(payload.items) ? payload.items : [];
      gmBackups.error = payload.error || "";
      gmBackups.loadedOnce = true;
      return gmBackups.status === "ok";
    } catch (error) {
      if (token !== gmListToken) return false;
      gmBackups.status = "unreachable";
      gmBackups.enabled = false;
      gmBackups.items = [];
      gmBackups.error = errorMessage(error);
      gmBackups.loadedOnce = true;
      return false;
    } finally {
      if (token === gmListToken) {
        gmBackups.loading = false;
      }
    }
  }

  async function openGmBackupTables(item) {
    if (!item?.date || !item?.hour || !item?.fileName) return false;
    const token = ++gmTablesToken;
    gmBackups.activeBackup = item;
    gmBackups.tables = [];
    gmBackups.tablesLoading = true;
    gmBackups.tablesError = "";
    gmBackups.selectedTables = [];
    gmBackups.tableSearch = "";
    try {
      const result = await invokeWorkbench("list_gm_backup_tables", {
        request: {
          date: item.date,
          hour: String(item.hour),
          fileName: item.fileName,
        },
      });
      if (token !== gmTablesToken) return false;
      gmBackups.tables = Array.isArray(result?.tables) ? result.tables : [];
      return true;
    } catch (error) {
      if (token !== gmTablesToken) return false;
      gmBackups.tablesError = errorMessage(error);
      return false;
    } finally {
      if (token === gmTablesToken) {
        gmBackups.tablesLoading = false;
      }
    }
  }

  function toggleGmBackupTable(name) {
    const target = String(name || "");
    if (!target) return;
    if (gmBackups.selectedTables.includes(target)) {
      gmBackups.selectedTables = gmBackups.selectedTables.filter((item) => item !== target);
    } else {
      gmBackups.selectedTables = [...gmBackups.selectedTables, target];
    }
  }

  function setGmSelectedTables(names) {
    gmBackups.selectedTables = Array.isArray(names) ? [...new Set(names.filter(Boolean))] : [];
  }

  async function restoreGmBackup({ connectionId, database, item, tables = [] }) {
    if (!connectionId || !database || !item?.fileName) {
      throw new Error("请先选择还原的目标连接和数据库");
    }
    busy.restoring = true;
    try {
      const result = await invokeWorkbench("restore_gm_backup", {
        request: {
          connectionId,
          database,
          date: item.date,
          hour: String(item.hour),
          fileName: item.fileName,
          tables: Array.isArray(tables) ? tables : [],
        },
      });
      closeGmBackupTables();
      await loadSnapshots();
      lastError.value = "";
      return result;
    } catch (error) {
      lastError.value = errorMessage(error);
      throw error;
    } finally {
      busy.restoring = false;
    }
  }

  async function loadConfig() {
    try {
      config.value = await invokeWorkbench("get_backup_config", {});
      lastError.value = "";
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    }
  }

  async function saveConfig(next) {
    busy.savingConfig = true;
    try {
      config.value = await invokeWorkbench("set_backup_config", { config: next || config.value });
      lastError.value = "";
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
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

  async function createSnapshotFromFilters() {
    return createSnapshot({
      connectionId: filters.connectionId || undefined,
      database: filters.database || undefined,
    });
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
    busy.pruning = true;
    try {
      const request = {};
      if (filters.connectionId) request.connectionId = filters.connectionId;
      if (filters.database) request.database = filters.database;
      const result = await invokeWorkbench("prune_snapshots", { request });
      await loadSnapshots();
      lastError.value = "";
      return result;
    } catch (error) {
      lastError.value = errorMessage(error);
      return { deletedCount: 0 };
    } finally {
      busy.pruning = false;
    }
  }

  async function loadImportDatabases() {
    if (!importDraft.connectionId) {
      importDraft.databases = [];
      return [];
    }
    try {
      const dbList = await invokeWorkbench("list_databases", { connectionId: importDraft.connectionId });
      const names = (Array.isArray(dbList) ? dbList : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean);
      importDraft.databases = ensureSelectedOption(names, importDraft.database);
    } catch (error) {
      importDraft.databases = importDraft.database ? [importDraft.database] : [];
      lastError.value = errorMessage(error);
    }
    return importDraft.databases;
  }

  /** Phase 1: pick a .sql snapshot file and prefill the draft from its header. */
  async function startImport() {
    busy.inspecting = true;
    try {
      const inspection = await invokeWorkbench("inspect_snapshot_file", { request: {} });
      if (!inspection) return false; // user cancelled the file picker
      Object.assign(importDraft, {
        sourcePath: inspection.sourcePath,
        fileName: inspection.fileName,
        sizeBytes: inspection.sizeBytes || 0,
        originConnectionId: inspection.originConnectionId || "",
        originDatabase: inspection.originDatabase || "",
        originTs: inspection.originTs || "",
        connectionId: inspection.originConnectionId || filters.connectionId || "",
        database: inspection.originDatabase || filters.database || "",
        databases: [],
      });
      if (importDraft.connectionId) {
        await loadImportDatabases();
      }
      lastError.value = "";
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    } finally {
      busy.inspecting = false;
    }
  }

  function setImportTarget(partial) {
    const nextConnection = partial.connectionId ?? importDraft.connectionId;
    const connectionChanged = nextConnection !== importDraft.connectionId;
    Object.assign(importDraft, partial);
    if (connectionChanged) {
      // Reset the database on connection switch unless the caller already
      // supplied one for the new connection in the same update.
      if (!("database" in partial)) {
        importDraft.database = "";
      }
      return loadImportDatabases();
    }
    return Promise.resolve(importDraft.databases);
  }

  /** Phase 2: copy the picked file into the chosen connection/database. */
  async function confirmImport() {
    if (!importDraft.sourcePath || !importDraft.connectionId || !importDraft.database) {
      return false;
    }
    busy.importing = true;
    try {
      const info = await invokeWorkbench("import_snapshot", {
        request: {
          sourcePath: importDraft.sourcePath,
          connectionId: importDraft.connectionId,
          database: importDraft.database,
        },
      });
      cancelImport();
      await loadSnapshots();
      lastError.value = "";
      return info;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    } finally {
      busy.importing = false;
    }
  }

  function cancelImport() {
    Object.assign(importDraft, {
      sourcePath: "",
      fileName: "",
      sizeBytes: 0,
      originConnectionId: "",
      originDatabase: "",
      originTs: "",
      connectionId: "",
      database: "",
      databases: [],
    });
  }

  async function clearAuditLogs() {
    busy.deleting = true;
    try {
      const deletedCount = await invokeWorkbench("clear_audit_logs", {});
      await loadAuditLogs();
      lastError.value = "";
      return { deletedCount: Number(deletedCount || 0) };
    } catch (error) {
      lastError.value = errorMessage(error);
      return { deletedCount: 0 };
    } finally {
      busy.deleting = false;
    }
  }

  async function deleteSnapshot(snapshotPath) {
    busy.deleting = true;
    try {
      await invokeWorkbench("delete_snapshot", { snapshotPath });
      await loadSnapshots();
      lastError.value = "";
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      throw error;
    } finally {
      busy.deleting = false;
    }
  }

  /**
   * Whether a (connectionId, database) is opted in to automatic snapshots.
   * `databasesScope === "all"` enables every database; otherwise only those
   * listed in `snapshotEnabledDatabases` are enabled. Pure read of `config` —
   * used by the snapshot-tab enable panel to drive checkbox state.
   */
  function isSnapshotEnabled(connectionId, database) {
    const cfg = config.value || {};
    if (cfg.databasesScope === "all") return true;
    const list = Array.isArray(cfg.snapshotEnabledDatabases) ? cfg.snapshotEnabledDatabases : [];
    return list.some(
      (key) => key && key.connectionId === connectionId && key.database === database,
    );
  }

  /**
   * Toggle the per-database snapshot opt-in for one (connectionId, database).
   * The backend persists the change and returns the full updated config, which
   * replaces the local `config` so the enable panel reflects the new state
   * (including any "all" -> "selected" whitelist seeding done server-side).
   */
  async function setSnapshotEnabled(connectionId, database, enabled) {
    busy.togglingDb = true;
    try {
      const next = await invokeWorkbench("set_snapshot_enabled", {
        request: { connectionId, database, enabled },
      });
      config.value = next;
      lastError.value = "";
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    } finally {
      busy.togglingDb = false;
    }
  }

  async function pickStorageDir() {
    busy.pickingDir = true;
    try {
      const dir = await invokeWorkbench("pick_backup_directory", {});
      return dir;
    } catch (error) {
      lastError.value = errorMessage(error);
      return null;
    } finally {
      busy.pickingDir = false;
    }
  }

  async function openBackupPath(path) {
    const normalized = String(path || "").trim();
    if (!normalized) {
      lastError.value = "缺少备份路径";
      return false;
    }
    busy.openingPath = true;
    try {
      await invokeWorkbench("open_backup_path", { path: normalized });
      lastError.value = "";
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    } finally {
      busy.openingPath = false;
    }
  }

  let stopListeners = null;

  async function open({ tab = "audit", connectionId, database } = {}) {
    // Default to the audit log tab when opening from the sidebar entry; callers
    // such as the release database page can land directly on snapshots.
    dialog.tab = ["audit", "snapshots", "settings"].includes(tab) ? tab : "audit";
    if (connectionId !== undefined || database !== undefined) {
      setFilters({
        connectionId: connectionId ?? filters.connectionId,
        database: database ?? filters.database,
        tableName: "",
      });
    }
    dialog.open = true;
    await Promise.all([loadConfig(), loadFilterOptions(), loadAuditLogs(), loadSnapshots()]);
    if (!stopListeners) {
      stopListeners = await startEventListeners();
    }
  }

  function close() {
    dialog.open = false;
    history.dispose();
    sharedHistory.dispose();
    filterLoadToken += 1;
    gmListToken += 1;
    closeGmBackupTables();
    filterDatabases.value = [];
    filterTables.value = [];
    cancelImport();
  }

  async function startEventListeners() {
    const unlistenProgress = await listen(SNAPSHOT_PROGRESS_EVENT, (event) => {
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
    const unlistenJob = await listen(BACKUP_JOB_EVENT, (event) => {
      const payload = event?.payload || event;
      if (payload?.kind === "rollback" || payload?.kind === "restore") {
        onDataChanged(payload);
      }
    });
    return () => {
      unlistenProgress?.();
      unlistenJob?.();
    };
  }

  function dispose() {
    history.dispose();
    sharedHistory.dispose();
    if (stopListeners) {
      stopListeners();
      stopListeners = null;
    }
  }

  return {
    dialog,
    filters,
    auditMode,
    snapshotSource,
    gmBackups,
    history,
    sharedHistory,
    auditLogs,
    sharedAuditLogs,
    snapshots,
    filterDatabases,
    filterTables,
    config,
    progress,
    busy,
    lastError,
    importDraft,
    setFilters,
    loadFilterOptions,
    loadFilterDatabases,
    loadFilterTables,
    loadAuditLogs,
    loadSharedAuditLogs,
    setAuditMode,
    loadSnapshots,
    setSnapshotSource,
    setGmBackupFilters,
    loadGmBackups,
    openGmBackupTables,
    closeGmBackupTables,
    toggleGmBackupTable,
    setGmSelectedTables,
    restoreGmBackup,
    loadConfig,
    saveConfig,
    rollback,
    createSnapshot,
    createSnapshotFromFilters,
    restoreSnapshot,
    pruneSnapshots,
    clearAuditLogs,
    deleteSnapshot,
    startImport,
    setImportTarget,
    confirmImport,
    cancelImport,
    isSnapshotEnabled,
    setSnapshotEnabled,
    pickStorageDir,
    openBackupPath,
    open,
    close,
    dispose,
    startEventListeners,
  };
}
