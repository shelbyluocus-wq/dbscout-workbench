import { reactive, ref } from "vue";
import { normalizeTableName } from "../utils/normalize.js";

export function useConnection(workspace, invokeWorkbench) {
  const connections = ref([]);
  const databases = ref([]);
  const selectedConnectionId = ref("");
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

  function buildMySqlUrl({ host, port, username, password }) {
    if (!host || !port) return "";
    return `mysql://${encodeURIComponent(username || "root")}:${encodeURIComponent(password || "")}@${String(host).trim()}:${String(port).trim()}`;
  }

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
        const url = savedConn.url || buildMySqlUrl(savedConn);
        if (!url) continue;
        if (
          !connections.value.some(
            (c) =>
              c.host === savedConn.host &&
              String(c.port) === String(savedConn.port),
          )
        ) {
          try {
            const previousIds = new Set(connections.value.map((connection) => connection.id));
            await invokeWorkbench("restore_connection", { url });
            connections.value = await invokeWorkbench("list_connections");
            const restored = connections.value.find((connection) => !previousIds.has(connection.id));
            if (restored) {
              restored.label = `${savedConn.username}@${savedConn.host}:${savedConn.port}`;
              restored.host = savedConn.host;
              restored.port = savedConn.port;
              restored.username = savedConn.username;
              restored.connected = true;
            } else {
              connections.value.push({
                id: `restored-${savedConn.host}:${savedConn.port}`,
                label: `${savedConn.username}@${savedConn.host}:${savedConn.port}`,
                host: savedConn.host,
                port: savedConn.port,
                username: savedConn.username,
                database: null,
                connected: true,
              });
            }
          } catch {
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
    }
    const selectedConnection =
      connectionList.find((item) => item.database) || connectionList[0];
    const current = selectedConnection?.database || databaseList[0] || "";
    if (selectedConnection) selectedConnectionId.value = selectedConnection.id;
    if (current) {
      selectedDatabase.value = current;
      await selectDatabase({
        connectionId: selectedConnectionId.value,
        database: current,
      });
    } else {
      statusText.value =
        "请先在设置中配置 MySQL 连接，或使用 demo 测试连接";
    }
  }

  async function selectConnection(connectionId) {
    if (!connectionId || connectionId === selectedConnectionId.value) return;
    busy.value = true;
    try {
      selectedConnectionId.value = connectionId;
      databases.value = await invokeWorkbench("list_databases", { connectionId });
      const connection = connections.value.find((item) => item.id === connectionId);
      const database = connection?.database || databases.value[0] || "";
      if (database) await selectDatabase({ connectionId, database });
      else selectedDatabase.value = "";
    } catch (error) {
      statusText.value = `切换连接失败：${String(error)}`;
    } finally {
      busy.value = false;
    }
  }

  async function selectDatabase(selection) {
    const database = typeof selection === "string" ? selection : selection?.database;
    const connectionId =
      typeof selection === "string"
        ? selectedConnectionId.value
        : selection?.connectionId || selectedConnectionId.value;
    if (!database) return;
    busy.value = true;
    try {
      selectedConnectionId.value = connectionId || "";
      selectedDatabase.value = database;
      await invokeWorkbench("select_database", { connectionId, database });
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
      connectionId: selectedConnectionId.value || null,
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
    const url = buildMySqlUrl({ host, port, username, password });
    busy.value = true;
    connDialog.error = "";
    try {
      const previousIds = new Set(connections.value.map((connection) => connection.id));
      const dbList = await invokeWorkbench("add_connection", { url });
      databases.value = dbList;
      connections.value = await invokeWorkbench("list_connections");
      const newConnection =
        connections.value.find((connection) => !previousIds.has(connection.id)) ||
        connections.value[connections.value.length - 1];
      if (newConnection) selectedConnectionId.value = newConnection.id;
      connDialog.open = false;
      localStorage.setItem(
        "dbscout_connections",
        JSON.stringify([
          ...(JSON.parse(
            localStorage.getItem("dbscout_connections") || "[]",
          )),
          {
            host: connDialog.host.trim(),
            port: connDialog.port.trim(),
            username: connDialog.username,
            password: connDialog.password,
            url,
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
    selectedConnectionId,
    selectedDatabase,
    connDialog,
    busy,
    statusText,
    loadConnections,
    selectConnection,
    selectDatabase,
    loadTables,
    ensureTableSchema,
    openConnDialog,
    cancelConnDialog,
    submitConnDialog,
  };
}
