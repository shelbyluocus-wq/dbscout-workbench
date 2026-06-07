import { computed, reactive, shallowRef } from "vue";

function asArrayRef(value) {
  return Array.isArray(value?.value) ? value.value : Array.isArray(value) ? value : [];
}

export function useTableCopy({
  connections = [],
  databases = [],
  invokeWorkbench,
} = {}) {
  const dialog = reactive({
    open: false,
    sourceConnectionId: "",
    sourceDatabase: "",
    targetConnectionId: "",
    targetDatabase: "",
    status: "idle",
    errorMessage: "",
  });
  const sourceTableList = shallowRef([]);
  const selectedTableNames = reactive(new Set());
  const result = shallowRef(null);
  let operationToken = 0;

  const connectionList = computed(() => asArrayRef(connections));
  const databaseList = computed(() =>
    asArrayRef(databases).map((db) => String(db ?? "")).filter(Boolean),
  );

  const sourceConnection = computed(() =>
    connectionList.value.find((c) => String(c.id) === dialog.sourceConnectionId) || null,
  );

  const targetConnectionOptions = computed(() =>
    connectionList.value.filter(
      (c) => String(c.id) !== dialog.sourceConnectionId,
    ),
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
      selectedTableNames.size > 0,
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
    nextToken();
    dialog.open = true;
    dialog.sourceConnectionId = String(source.connectionId || source.connection_id || "");
    dialog.sourceDatabase = String(source.database || "");
    dialog.targetConnectionId = "";
    dialog.targetDatabase = "";
    dialog.status = "idle";
    dialog.errorMessage = "";
    result.value = null;
    selectedTableNames.clear();
    // Pre-select the table that was right-clicked
    const tableName = String(source.tableName || source.table_name || "");
    if (tableName) selectedTableNames.add(tableName);
    await loadSourceTables();
    // Default target connection to the same connection
    if (!dialog.targetConnectionId) {
      dialog.targetConnectionId = dialog.sourceConnectionId;
    }
  }

  function close() {
    nextToken();
    dialog.open = false;
  }

  async function loadSourceTables() {
    sourceTableList.value = [];
    if (!invokeWorkbench || !dialog.sourceConnectionId || !dialog.sourceDatabase) return;
    try {
      const tables = await invokeWorkbench("list_tables", {
        connectionId: dialog.sourceConnectionId,
        database: dialog.sourceDatabase,
      });
      sourceTableList.value = Array.isArray(tables) ? tables : [];
    } catch {
      sourceTableList.value = [];
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

  function setTargetConnection(connectionId) {
    dialog.targetConnectionId = String(connectionId ?? "");
    dialog.targetDatabase = "";
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
          connectionId: dialog.sourceConnectionId,
          sourceDatabase: dialog.sourceDatabase,
          tableNames,
          targetConnectionId: dialog.targetConnectionId,
          targetDatabase: dialog.targetDatabase,
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
    selectedTableNames,
    selectAllTables,
    result,
    targetConnectionOptions,
    canExecute,
    isBusy,
    open,
    close,
    toggleTable,
    setTargetConnection,
    execute,
    loadSourceTables,
  };
}
