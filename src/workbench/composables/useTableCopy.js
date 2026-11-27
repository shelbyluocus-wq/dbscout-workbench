import { computed, reactive, shallowRef, watch } from "vue";
import { connectionHasCapability } from "../utils/connectionKinds.js";

function asArrayRef(value) {
  return Array.isArray(value?.value) ? value.value : Array.isArray(value) ? value : [];
}

function isCopyableConnection(connection) {
  return Boolean(
    connection?.connected !== false &&
      connectionHasCapability(connection?.kind, "tableCopy") &&
      !connection?.readOnly &&
      !connection?.read_only,
  );
}

export function useTableCopy({
  connections = [],
  invokeWorkbench,
} = {}) {
  const dialog = reactive({
    open: false,
    sourceConnectionId: "",
    sourceDatabase: "",
    targetConnectionId: "",
    targetDatabase: "",
    mode: "copy",
    structureOnly: false,
    status: "idle",
    errorMessage: "",
    sourceTableLoading: false,
    targetDatabaseLoading: false,
    targetDatabaseError: "",
  });
  const sourceTableList = shallowRef([]);
  const targetDatabaseList = shallowRef([]);
  const selectedTableNames = reactive(new Set());
  const result = shallowRef(null);
  let operationToken = 0;
  let targetLoadToken = 0;

  const connectionList = computed(() => asArrayRef(connections));
  const sourceConnection = computed(() =>
    connectionList.value.find((c) => String(c.id) === dialog.sourceConnectionId) || null,
  );

  const targetConnection = computed(() =>
    connectionList.value.find((c) => String(c.id) === dialog.targetConnectionId) || null,
  );

  const targetConnectionOptions = computed(() =>
    connectionList.value.filter((c) => isCopyableConnection(c)),
  );

  const targetDatabaseOptions = computed(() =>
    targetDatabaseList.value.filter(
      (database) =>
        dialog.mode !== "overwrite" ||
        dialog.targetConnectionId !== dialog.sourceConnectionId ||
        database !== dialog.sourceDatabase,
    ),
  );

  watch(
    () => [dialog.mode, dialog.targetConnectionId],
    ([mode, targetConnectionId]) => {
      if (
        mode === "overwrite" &&
        targetConnectionId === dialog.sourceConnectionId &&
        dialog.targetDatabase === dialog.sourceDatabase
      ) {
        dialog.targetDatabase = "";
      }
    },
  );

  const selectAllTables = computed({
    get() {
      const list = sourceTableList.value.length > 0;
      return list && selectedTableNames.size === sourceTableList.value.length;
    },
    set(checked) {
      if (checked) {
        sourceTableList.value.forEach((t) => selectedTableNames.add(String(t.table_name ?? t ?? "")));
      } else {
        selectedTableNames.clear();
      }
    },
  });

  const canExecute = computed(
    () =>
      dialog.targetConnectionId &&
      dialog.targetDatabase &&
      selectedTableNames.size > 0 &&
      !dialog.sourceTableLoading &&
      !dialog.targetDatabaseLoading &&
      isCopyableConnection(sourceConnection.value) &&
      isCopyableConnection(targetConnection.value),
  );

  const isBusy = computed(() => dialog.status === "running");

  function nextToken() {
    operationToken += 1;
    return operationToken;
  }

  function isCurrent(token) {
    return dialog.open && token === operationToken;
  }

  async function open(source = {}) {
    const token = nextToken();
    dialog.open = true;
    dialog.sourceConnectionId = String(source.connectionId || source.connection_id || "");
    dialog.sourceDatabase = String(source.database || "");
    dialog.targetConnectionId = "";
    dialog.targetDatabase = "";
    dialog.mode = "copy";
    dialog.structureOnly = Boolean(source.structureOnly);
    dialog.status = "idle";
    dialog.errorMessage = "";
    dialog.sourceTableLoading = false;
    dialog.targetDatabaseLoading = false;
    dialog.targetDatabaseError = "";
    result.value = null;
    sourceTableList.value = [];
    targetDatabaseList.value = [];
    selectedTableNames.clear();
    // Pre-select the tables that were right-clicked / selected on the home page
    const presetNames = Array.isArray(source.tableNames) ? source.tableNames : [];
    presetNames.forEach((name) => {
      const tableName = String(name || "");
      if (tableName) selectedTableNames.add(tableName);
    });
    const tableName = String(source.tableName || source.table_name || "");
    if (tableName) selectedTableNames.add(tableName);
    dialog.targetConnectionId = dialog.sourceConnectionId;
    await Promise.all([loadSourceTables(token), loadTargetDatabases(dialog.targetConnectionId)]);
  }

  function close() {
    nextToken();
    targetLoadToken += 1;
    dialog.open = false;
  }

  async function loadSourceTables(token = operationToken) {
    sourceTableList.value = [];
    if (!invokeWorkbench || !dialog.sourceConnectionId || !dialog.sourceDatabase) return;
    dialog.sourceTableLoading = true;
    try {
      const tables = await invokeWorkbench("list_tables", {
        connectionId: dialog.sourceConnectionId,
        database: dialog.sourceDatabase,
      });
      if (!isCurrent(token)) return;
      sourceTableList.value = Array.isArray(tables) ? tables : [];
    } catch {
      if (!isCurrent(token)) return;
      sourceTableList.value = [];
      dialog.status = "failed";
      dialog.errorMessage = "读取源表列表失败，请检查源连接后重试";
    } finally {
      if (isCurrent(token)) dialog.sourceTableLoading = false;
    }
  }

  async function loadTargetDatabases(connectionId = dialog.targetConnectionId) {
    const resolvedConnectionId = String(connectionId ?? "");
    const token = ++targetLoadToken;
    targetDatabaseList.value = [];
    dialog.targetDatabase = "";
    dialog.targetDatabaseError = "";
    if (!invokeWorkbench || !resolvedConnectionId) return [];
    dialog.targetDatabaseLoading = true;
    try {
      const databasesForTarget = await invokeWorkbench("list_databases", {
        connectionId: resolvedConnectionId,
      });
      if (!dialog.open || token !== targetLoadToken || dialog.targetConnectionId !== resolvedConnectionId) {
        return [];
      }
      targetDatabaseList.value = Array.isArray(databasesForTarget)
        ? databasesForTarget.map((database) => String(database ?? "")).filter(Boolean)
        : [];
      return targetDatabaseList.value;
    } catch (error) {
      if (!dialog.open || token !== targetLoadToken) return [];
      dialog.targetDatabaseError = String(
        error?.message || error || "读取目标数据库列表失败",
      );
      return [];
    } finally {
      if (dialog.open && token === targetLoadToken) dialog.targetDatabaseLoading = false;
    }
  }

  function toggleTable(tableName) {
    const name = String(tableName ?? "");
    if (selectedTableNames.has(name)) {
      selectedTableNames.delete(name);
    } else {
      selectedTableNames.add(name);
    }
  }

  async function setTargetConnection(connectionId) {
    dialog.targetConnectionId = String(connectionId ?? "");
    dialog.targetDatabase = "";
    return await loadTargetDatabases(dialog.targetConnectionId);
  }

  async function execute() {
    if (!invokeWorkbench || !canExecute.value) return null;
    const token = nextToken();
    dialog.status = "running";
    dialog.errorMessage = "";
    result.value = null;
    try {
      const tableNames = [...selectedTableNames];
      const copyResult = await invokeWorkbench("copy_tables", {
        request: {
          sourceConnectionId: dialog.sourceConnectionId,
          sourceDatabase: dialog.sourceDatabase,
          tableNames,
          targetConnectionId: dialog.targetConnectionId,
          targetDatabase: dialog.targetDatabase,
          mode: dialog.mode,
          structureOnly: Boolean(dialog.structureOnly),
        },
      });
      if (!isCurrent(token)) return null;
      result.value = copyResult;
      dialog.status = copyResult?.status === "succeeded" ? "succeeded" : "failed";
      return copyResult;
    } catch (error) {
      if (!isCurrent(token)) return null;
      dialog.status = "failed";
      dialog.errorMessage = String(error?.message || error || "未知错误");
      result.value = null;
      return null;
    }
  }

  return {
    dialog,
    sourceTableList,
    targetDatabaseList,
    selectedTableNames,
    selectAllTables,
    result,
    targetConnectionOptions,
    targetDatabaseOptions,
    canExecute,
    isBusy,
    open,
    close,
    toggleTable,
    setTargetConnection,
    execute,
    loadSourceTables,
    loadTargetDatabases,
  };
}
