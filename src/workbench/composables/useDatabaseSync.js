import { computed, reactive, shallowRef } from "vue";
import { normalizeTableName } from "../utils/normalize.js";

export const DATABASE_SYNC_EXCLUSIONS_KEY = "dbscout_database_sync_exclusions";
const PROGRESS_EVENT_NAME = "database-sync-progress";

function asArrayRef(value) {
  return Array.isArray(value?.value) ? value.value : Array.isArray(value) ? value : [];
}

function isReadOnlyConnection(connection) {
  return Boolean(
    connection?.readOnly ||
      connection?.read_only ||
      String(connection?.kind || "").toLowerCase() === "clickhouse",
  );
}

function cleanTableNames(values) {
  const seen = new Set();
  const names = [];
  for (const value of values) {
    const name = String(value ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function readHistory(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(DATABASE_SYNC_EXCLUSIONS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeHistory(storage, history) {
  storage?.setItem?.(DATABASE_SYNC_EXCLUSIONS_KEY, JSON.stringify(history));
}

function sameStringArray(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function defaultJobId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `database-sync-${Date.now().toString(36)}-${random}`;
}

function errorMessage(error) {
  return String(error?.message || error || "未知错误");
}

function normalizeBackendStatus(status) {
  return String(status || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function executionDialogStatus(syncResult) {
  const status = normalizeBackendStatus(syncResult?.status);
  if (status === "restoring") return "restoring";
  if (status === "succeeded" || status === "completed") return "succeeded";
  return "failed";
}

function emptyProgress() {
  return {
    stage: "",
    currentTable: "",
    done: 0,
    total: 0,
    completedRows: 0,
    totalRows: 0,
    message: "",
  };
}

function progressNumber(payload, camelCaseKey, snakeCaseKey, fallbackKey = "") {
  const raw = payload?.[camelCaseKey] ?? payload?.[snakeCaseKey] ?? (fallbackKey ? payload?.[fallbackKey] : 0);
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function connectionHistoryKey(connection) {
  const host = String(connection?.host ?? "").trim();
  const port = String(connection?.port ?? "").trim();
  const username = String(connection?.username ?? "").trim();
  if (host && port && username) return `${host}:${port}:${username}`;
  return String(connection?.id ?? "").trim();
}

export function useDatabaseSync({
  connections = [],
  databases = [],
  invokeWorkbench,
  listen = null,
  storage = globalThis.localStorage,
  createJobId = defaultJobId,
} = {}) {
  const dialog = reactive({
    open: false,
    connectionId: "",
    targetDatabase: "",
    sourceDatabase: "",
    excludedTables: [],
    selectedExclusionTable: "",
    status: "idle",
    errorMessage: "",
    progress: emptyProgress(),
    jobId: "",
  });
  const result = shallowRef(null);
  const sourceTables = shallowRef([]);
  let unlistenProgress = null;
  let operationToken = 0;
  let tableLoadToken = 0;

  const connectionList = computed(() => asArrayRef(connections));
  const databaseList = computed(() => asArrayRef(databases).map((database) => String(database ?? "")).filter(Boolean));
  const currentConnection = computed(() => connectionList.value.find((connection) => String(connection.id) === dialog.connectionId) || null);
  const currentConnectionReadOnly = computed(() => isReadOnlyConnection(currentConnection.value));
  const sourceDatabaseOptions = computed(() => cleanTableNames([dialog.sourceDatabase, ...databaseList.value]));
  const availableTargetDatabases = computed(() => databaseList.value.filter((database) => database !== dialog.sourceDatabase));
  const targetDatabaseOptions = availableTargetDatabases;
  const availableSourceDatabases = sourceDatabaseOptions;
  const sourceTableOptions = computed(() => cleanTableNames(sourceTables.value.map((table) => normalizeTableName(table) || table?.name || table)));
  const availableExclusionTables = computed(() => {
    const excluded = new Set(dialog.excludedTables);
    return sourceTableOptions.value.filter((tableName) => !excluded.has(tableName));
  });
  const progressPercent = computed(() => {
    const total = Number(dialog.progress.total) || 0;
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round(((Number(dialog.progress.done) || 0) / total) * 100)));
  });
  const canPreview = computed(
    () => Boolean(dialog.connectionId && dialog.sourceDatabase && dialog.targetDatabase && dialog.sourceDatabase !== dialog.targetDatabase && !currentConnectionReadOnly.value),
  );
  const canExecute = computed(() => canPreview.value);

  function nextOperationToken() {
    operationToken += 1;
    return operationToken;
  }

  function isCurrentOperation(token) {
    return dialog.open && token === operationToken;
  }

  function resetRunState() {
    result.value = null;
    dialog.errorMessage = "";
    dialog.progress = emptyProgress();
    dialog.jobId = "";
  }

  function invalidateRunState() {
    nextOperationToken();
    dialog.status = "idle";
    resetRunState();
  }

  function loadExclusionHistory() {
    const key = connectionHistoryKey(currentConnection.value) || dialog.connectionId;
    const history = readHistory(storage);
    dialog.excludedTables = cleanTableNames(Array.isArray(history[key]) ? history[key] : []);
  }

  function saveExclusionHistory() {
    try {
      const key = connectionHistoryKey(currentConnection.value) || dialog.connectionId;
      if (!key) return;
      const history = readHistory(storage);
      history[key] = cleanTableNames(dialog.excludedTables);
      writeHistory(storage, history);
    } catch {
      // Exclusion history is a browser convenience; sync success must not depend on localStorage.
    }
  }

  function validTargetDatabase(database) {
    const target = String(database || "");
    return target && target !== dialog.sourceDatabase && availableTargetDatabases.value.includes(target) ? target : "";
  }

  function coerceTargetDatabase(database = dialog.targetDatabase) {
    return validTargetDatabase(database) || validTargetDatabase(dialog.targetDatabase) || availableTargetDatabases.value[0] || "";
  }

  function setTargetDefault() {
    dialog.targetDatabase = coerceTargetDatabase();
  }

  async function loadSourceTables() {
    const token = ++tableLoadToken;
    sourceTables.value = [];
    dialog.selectedExclusionTable = "";
    if (!invokeWorkbench || !dialog.connectionId || !dialog.sourceDatabase) return [];
    try {
      const tables = await invokeWorkbench("list_tables", {
        connectionId: dialog.connectionId,
        database: dialog.sourceDatabase,
      });
      if (token !== tableLoadToken || !dialog.open) return [];
      sourceTables.value = Array.isArray(tables) ? tables : [];
      return sourceTables.value;
    } catch {
      if (token === tableLoadToken) sourceTables.value = [];
      return [];
    }
  }

  async function open(target = {}) {
    nextOperationToken();
    tableLoadToken += 1;
    dialog.open = true;
    dialog.connectionId = String(target.connectionId || target.connection_id || "");
    dialog.sourceDatabase = String(target.database || "");
    dialog.targetDatabase = "";
    dialog.selectedExclusionTable = "";
    dialog.status = "idle";
    resetRunState();
    setTargetDefault();
    loadExclusionHistory();
    await loadSourceTables();
  }

  function close() {
    nextOperationToken();
    tableLoadToken += 1;
    dialog.open = false;
  }

  async function setSourceDatabase(database) {
    const nextSource = String(database || "");
    if (dialog.sourceDatabase === nextSource) return;
    dialog.sourceDatabase = nextSource;
    invalidateRunState();
    setTargetDefault();
    await loadSourceTables();
  }

  function setTargetDatabase(database) {
    const nextTarget = coerceTargetDatabase(database);
    if (dialog.targetDatabase === nextTarget) return;
    dialog.targetDatabase = nextTarget;
    invalidateRunState();
  }

  function setExcludedTables(values) {
    const nextTables = cleanTableNames(values);
    const changed = !sameStringArray(dialog.excludedTables, nextTables);
    dialog.excludedTables = nextTables;
    if (dialog.selectedExclusionTable && nextTables.includes(dialog.selectedExclusionTable)) {
      dialog.selectedExclusionTable = "";
    }
    if (changed) invalidateRunState();
    return changed;
  }

  function addExcludedTable(name) {
    return setExcludedTables([...dialog.excludedTables, name]);
  }

  function addSelectedExclusion() {
    const selected = String(dialog.selectedExclusionTable || "").trim();
    if (!selected || dialog.excludedTables.includes(selected)) {
      dialog.selectedExclusionTable = "";
      return false;
    }
    const changed = addExcludedTable(selected);
    dialog.selectedExclusionTable = "";
    return changed;
  }

  function removeExcludedTable(name) {
    const targetName = String(name ?? "").trim();
    setExcludedTables(dialog.excludedTables.filter((tableName) => tableName !== targetName));
  }

  function buildPayload(extra = {}) {
    return {
      request: {
        connectionId: dialog.connectionId,
        sourceDatabase: dialog.sourceDatabase,
        targetDatabase: dialog.targetDatabase,
        excludedTables: cleanTableNames(dialog.excludedTables),
        ...extra,
      },
    };
  }

  async function preview() {
    if (!invokeWorkbench || !canPreview.value) return null;
    const token = nextOperationToken();
    dialog.status = "previewing";
    dialog.errorMessage = "";
    result.value = null;
    try {
      const previewResult = await invokeWorkbench("preview_database_sync", buildPayload());
      if (!isCurrentOperation(token)) return null;
      result.value = previewResult;
      dialog.status = "ready";
      saveExclusionHistory();
      return previewResult;
    } catch (error) {
      if (!isCurrentOperation(token)) return null;
      dialog.status = "failed";
      dialog.errorMessage = errorMessage(error);
      return null;
    }
  }

  function handleProgressEvent(event) {
    const payload = event?.payload || event || {};
    const jobId = String(payload.jobId || payload.job_id || "");
    if (!dialog.jobId || jobId !== dialog.jobId) return;
    if (payload.status) dialog.status = payload.status;
    dialog.progress = {
      stage: String(payload.stage || ""),
      currentTable: String(payload.currentTable || payload.current_table || ""),
      done: progressNumber(payload, "completedTables", "completed_tables", "done"),
      total: progressNumber(payload, "totalTables", "total_tables", "total"),
      completedRows: progressNumber(payload, "completedRows", "completed_rows"),
      totalRows: progressNumber(payload, "totalRows", "total_rows"),
      message: String(payload.message || ""),
    };
  }

  async function ensureProgressListener() {
    if (unlistenProgress || !listen) return;
    const unlisten = await listen(PROGRESS_EVENT_NAME, handleProgressEvent);
    unlistenProgress = typeof unlisten === "function" ? unlisten : null;
  }

  function dispose() {
    try {
      unlistenProgress?.();
    } finally {
      unlistenProgress = null;
    }
  }

  async function execute() {
    if (!invokeWorkbench || !canPreview.value) return null;
    if (!canExecute.value) return null;
    const token = nextOperationToken();
    dialog.status = "running";
    dialog.errorMessage = "";
    dialog.progress = emptyProgress();
    dialog.jobId = createJobId();
    const jobId = dialog.jobId;
    result.value = null;
    try {
      await ensureProgressListener();
      const syncResult = await invokeWorkbench("sync_database_overwrite", buildPayload({ jobId }));
      if (!isCurrentOperation(token)) return null;
      result.value = syncResult;
      dialog.status = executionDialogStatus(syncResult);
      if (dialog.status === "failed") {
        dialog.errorMessage = String(syncResult?.message || syncResult?.error || "覆盖同步失败");
      }
      saveExclusionHistory();
      return syncResult;
    } catch (error) {
      if (!isCurrentOperation(token)) return null;
      dialog.status = "failed";
      dialog.errorMessage = errorMessage(error);
      result.value = null;
      return null;
    }
  }

  return {
    dialog,
    result,
    targetDatabaseOptions,
    sourceDatabaseOptions,
    availableSourceDatabases,
    availableTargetDatabases,
    sourceTableOptions,
    availableExclusionTables,
    progressPercent,
    canPreview,
    canExecute,
    open,
    close,
    setSourceDatabase,
    setTargetDatabase,
    addExcludedTable,
    addSelectedExclusion,
    loadSourceTables,
    removeExcludedTable,
    loadExclusionHistory,
    saveExclusionHistory,
    preview,
    execute,
    handleProgressEvent,
    dispose,
  };
}
