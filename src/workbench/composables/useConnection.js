import { reactive, ref } from "vue";
import { normalizeTableName } from "../utils/normalize.js";

export function useConnection(workspace, invokeWorkbench) {
  const connections = ref([]);
  const databases = ref([]);
  const selectedDatabase = ref("");
  const connDialog = reactive({
    open: false,
    host: "127.0.0.1",
    port: "3306",
    username: "root",
    password: "",
    error: "",
  });
  const busy = ref(false);
  const statusText = ref("");

  async function loadConnections() {
    const [connectionList, databaseList] = await Promise.all([
      invokeWorkbench("list_connections"),
      invokeWorkbench("list_databases").catch(() => []),
    ]);
    connections.value = connectionList;
    databases.value = databaseList;
    const saved = JSON.parse(
      localStorage.getItem("dbscout_connections") || "[]",
    );
    if (saved.length > 0) {
      for (const savedConn of saved) {
        if (
          !connectionList.some(
            (c) =>
              c.host === savedConn.host &&
              c.port === String(savedConn.port),
          )
        ) {
          connections.value.push({
            id: `saved-${savedConn.host}:${savedConn.port}`,
            label: `${savedConn.username}@${savedConn.host}:${savedConn.port}`,
            host: savedConn.host,
            port: savedConn.port,
            username: savedConn.username,
            database: null,
            connected: false,
          });
        }
      }
    }
    const current =
      connectionList.find((item) => item.database)?.database ||
      databaseList[0] ||
      "";
    if (current) {
      selectedDatabase.value = current;
      await selectDatabase(current);
    } else {
      statusText.value =
        "请先在设置中配置 MySQL 连接，或使用 demo 测试连接";
    }
  }

  async function selectDatabase(database) {
    if (!database) return;
    busy.value = true;
    try {
      selectedDatabase.value = database;
      await invokeWorkbench("select_database", { database });
      workspace.database = database;
      await loadTables();
      statusText.value = `已连接数据库：${database}`;
    } catch (error) {
      statusText.value = `切换数据库失败：${String(error)}`;
    } finally {
      busy.value = false;
    }
  }

  async function loadTables() {
    const tables = await invokeWorkbench("list_tables", {
      database: selectedDatabase.value || null,
    });
    workspace.tables = tables;
    const schemas = await Promise.all(
      tables.map(async (table) => {
        try {
          return await invokeWorkbench("get_table_schema", {
            tableName: normalizeTableName(table),
          });
        } catch {
          return { ...table, columns: [] };
        }
      }),
    );
    workspace.schema = schemas;
  }

  async function ensureTableSchema(tableName) {
    const schema = await invokeWorkbench("get_table_schema", { tableName });
    const index = workspace.schema.findIndex(
      (item) => normalizeTableName(item) === tableName,
    );
    if (index >= 0) workspace.schema[index] = schema;
    else workspace.schema.push(schema);
    return schema;
  }

  function openConnDialog() {
    connDialog.error = "";
    connDialog.open = true;
  }

  function cancelConnDialog() {
    connDialog.open = false;
  }

  async function submitConnDialog() {
    const { host, port, username, password } = connDialog;
    if (!host.trim() || !port.trim()) {
      connDialog.error = "请填写主机和端口";
      return;
    }
    const url = `mysql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host.trim()}:${port.trim()}`;
    busy.value = true;
    connDialog.error = "";
    try {
      const dbList = await invokeWorkbench("add_connection", { url });
      databases.value = dbList;
      connections.value = await invokeWorkbench("list_connections");
      connDialog.open = false;
      localStorage.setItem(
        "dbscout_connections",
        JSON.stringify([
          ...(JSON.parse(
            localStorage.getItem("dbscout_connections") || "[]",
          )),
          {
            host: connDialog.host,
            port: connDialog.port,
            username: connDialog.username,
          },
        ]),
      );
      statusText.value = `已连接 MySQL，共 ${dbList.length} 个数据库`;
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
    selectedDatabase,
    connDialog,
    busy,
    statusText,
    loadConnections,
    selectDatabase,
    loadTables,
    ensureTableSchema,
    openConnDialog,
    cancelConnDialog,
    submitConnDialog,
  };
}
