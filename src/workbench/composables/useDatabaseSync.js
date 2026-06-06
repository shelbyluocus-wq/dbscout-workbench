import { computed, reactive, shallowRef } from "vue";

export const DATABASE_SYNC_EXCLUSIONS_KEY = "dbscout_database_sync_exclusions";
const PROGRESS_EVENT_NAME = "database-sync-progress";

function asArrayRef(value) {
  return Array.isArray(value?.value) ? value.value : Array.isArray(value) ? value : [];
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

function splitManualInput(value) {
  return String(value ?? "").split(/[\n,，]+/);
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
    exclusionInput: "",
    status: "idle",
    errorMessage: "",
    progress: { done: 0, total: 0, message: "" },
    jobId: "",
  });
  const result = shallowRef(null);
  let unlistenProgress = null;
  let operationToken = 0;

  const connectionList = computed(() => asArrayRef(connections));
  const databaseList = computed(() => asArrayRef(databases).map((database) => String(database ?? "")).filter(Boolean));
  const currentConnection = computed(() => connectionList.value.find((connection) => String(connection.id) === dialog.connectionId) || null);
  const targetDatabaseOptions = computed(() => cleanTableNames([dialog.targetDatabase, ...databaseList.value]));
  const availableSourceDatabases = computed(() => databaseList.value.filter((database) => database !== dialog.targetDatabase));
  const progressPercent = computed(() => {
    const total = Number(dialog.progress.total) || 0;
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round(((Number(dialog.progress.done) || 0) / total) * 100)));
  });
  const canPreview = computed(
    () => Boolean(dialog.connectionId && dialog.sourceDatabase && dialog.targetDatabase && dialog.sourceDatabase !== dialog.targetDatabase),
  );
  const hasPendingExclusionInput = computed(() => cleanTableNames(splitManualInput(dialog.exclusionInput)).length > 0);
  const canExecute = computed(() => canPreview.value && dialog.status === "ready" && Boolean(result.value) && !hasPendingExclusionInput.value);

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
    dialog.progress = { done: 0, total: 0, message: "" };
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

  function validSourceDatabase(database) {
    const source = String(database || "");
    return source && source !== dialog.targetDatabase && availableSourceDatabases.value.includes(source) ? source : "";
  }

  function coerceSourceDatabase(database = dialog.sourceDatabase) {
    return validSourceDatabase(database) || validSourceDatabase(dialog.sourceDatabase) || availableSourceDatabases.value[0] || "";
  }

  function setSourceDefault() {
    dialog.sourceDatabase = coerceSourceDatabase();
  }

  function open(target = {}) {
    nextOperationToken();
    dialog.open = true;
    dialog.connectionId = String(target.connectionId || target.connection_id || "");
    dialog.targetDatabase = String(target.database || "");
    dialog.sourceDatabase = "";
    dialog.exclusionInput = "";
    dialog.status = "idle";
    resetRunState();
    setSourceDefault();
    loadExclusionHistory();
  }

  function close() {
    nextOperationToken();
    dialog.open = false;
  }

  function setSourceDatabase(database) {
    const nextSource = coerceSourceDatabase(database);
    if (dialog.sourceDatabase === nextSource) return;
    dialog.sourceDatabase = nextSource;
    invalidateRunState();
  }

  function setTargetDatabase(database) {
    const nextTarget = String(database || "");
    if (dialog.targetDatabase === nextTarget) return;
    dialog.targetDatabase = nextTarget;
    invalidateRunState();
    setSourceDefault();
  }

  function setExcludedTables(values) {
    const nextTables = cleanTableNames(values);
    const changed = !sameStringArray(dialog.excludedTables, nextTables);
    dialog.excludedTables = nextTables;
    if (changed) invalidateRunState();
    return changed;
  }

  function addExcludedTable(name) {
    setExcludedTables([...dialog.excludedTables, name]);
  }

  function addExclusionsFromInput() {
    const changed = setExcludedTables([...dialog.excludedTables, ...splitManualInput(dialog.exclusionInput)]);
    dialog.exclusionInput = "";
    return changed;
  }

  function removeExcludedTable(name) {
    const targetName = String(name ?? "").trim();
    setExcludedTables(dialog.excludedTables.filter((tableName) => tableName !== targetName));
  }

  function buildPayload(extra = {}) {
    return {
      connectionId: dialog.connectionId,
      sourceDatabase: dialog.sourceDatabase,
      targetDatabase: dialog.targetDatabase,
      excludedTables: cleanTableNames(dialog.excludedTables),
      ...extra,
    };
  }

  async function preview() {
    if (!invokeWorkbench || !canPreview.value) return null;
    addExclusionsFromInput();
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
    if (!dialog.jobId || payload.jobId !== dialog.jobId) return;
    if (payload.status) dialog.status = payload.status;
    dialog.progress = {
      done: Number(payload.done) || 0,
      total: Number(payload.total) || 0,
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
    const exclusionsChanged = addExclusionsFromInput();
    if (exclusionsChanged || !canExecute.value) return null;
    const token = nextOperationToken();
    dialog.status = "running";
    dialog.errorMessage = "";
    dialog.progress = { done: 0, total: 0, message: "" };
    dialog.jobId = createJobId();
    const jobId = dialog.jobId;
    result.value = null;
    try {
      await ensureProgressListener();
      const syncResult = await invokeWorkbench("sync_database_overwrite", buildPayload({ jobId }));
      if (!isCurrentOperation(token)) return null;
      result.value = syncResult;
      dialog.status = executionDialogStatus(syncResult);
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
    availableSourceDatabases,
    progressPercent,
    canPreview,
    canExecute,
    open,
    close,
    setSourceDatabase,
    setTargetDatabase,
    addExcludedTable,
    addExclusionsFromInput,
    hasPendingExclusionInput,
    removeExcludedTable,
    loadExclusionHistory,
    saveExclusionHistory,
    preview,
    execute,
    handleProgressEvent,
    dispose,
  };
}
