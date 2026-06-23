import { computed, reactive } from "vue";
import { normalizeTableComment, normalizeTableName } from "../utils/normalize.js";
import { buildRowKey } from "../utils/rowIdentity.js";

export function useContextMenu(
  { statusText },
  { loadTables, ensureTableSchema, fetchPage, refreshDatabases },
  activeTab,
  { openTableDesign, onTablePageRefreshed = () => {} } = {},
) {
  const contextMenu = reactive({
    open: false,
    x: 0,
    y: 0,
    kind: "general",
    tableName: "",
    tableComment: "",
    connectionId: "",
    database: "",
    tableScoped: false,
    rowTabId: "",
    rowKey: "",
    anchorIndex: null,
    rowReadOnly: false,
    row: null,
  });

  const contextMenuStyle = computed(() => ({
    left: `${contextMenu.x}px`,
    top: `${contextMenu.y}px`,
  }));

  function openContextMenu(event, target = null) {
    const tableName = normalizeTableName(target);
    const kind = target?.kind === "database"
      ? "database"
      : target?.kind === "connection"
        ? "connection"
        : tableName
          ? "table"
          : "general";
    contextMenu.open = true;
    contextMenu.x = event.clientX;
    contextMenu.y = event.clientY;
    contextMenu.kind = kind;
    contextMenu.tableName = kind === "table" ? tableName : "";
    contextMenu.tableComment = kind === "table" ? normalizeTableComment(target) : "";
    contextMenu.connectionId = String(target?.connectionId || target?.connection_id || "");
    contextMenu.database = String(target?.database || "");
    contextMenu.tableScoped = kind === "table";
  }

  function openRowContextMenu(event, tab, row, originalIndex) {
    contextMenu.open = true;
    contextMenu.x = event.clientX;
    contextMenu.y = event.clientY;
    contextMenu.kind = "grid-row";
    contextMenu.tableScoped = false;
    contextMenu.tableName = "";
    contextMenu.tableComment = "";
    contextMenu.connectionId = "";
    contextMenu.database = "";
    contextMenu.rowTabId = String(tab?.id || "");
    contextMenu.rowKey = buildRowKey(tab, row);
    contextMenu.anchorIndex = originalIndex;
    contextMenu.rowReadOnly = Boolean(tab?.readOnly || tab?.read_only);
    contextMenu.row = row;
  }

  function closeContextMenu() {
    contextMenu.open = false;
  }

  async function refreshFromContextMenu() {
    const tableName = contextMenu.tableName;
    const kind = contextMenu.kind;
    const connectionId = String(contextMenu.connectionId || "").trim() || undefined;
    const database = String(contextMenu.database || "").trim() || undefined;
    const source = { connectionId, database };
    closeContextMenu();
    try {
      if (tableName) {
        await ensureTableSchema(tableName, source);
        const hasSource = Boolean(source.connectionId || source.database);
        const sameTab = hasSource
          ? activeTab.value?.tableKey === [source.connectionId, source.database, tableName].join("\u001f")
          : activeTab.value?.tableName === tableName;
        if (sameTab) {
          const result = await fetchPage(activeTab.value, activeTab.value.page);
          if (result?.ok) onTablePageRefreshed(activeTab.value);
        }
        statusText.value = `已刷新 ${tableName}`;
        return;
      }

      let refreshedDatabases = null;
      if (typeof refreshDatabases === "function") {
        refreshedDatabases = await refreshDatabases({ connectionId });
      }

      if (kind === "database" && database) {
        const stillExists = Array.isArray(refreshedDatabases)
          ? refreshedDatabases.includes(database)
          : true;
        if (!stillExists) {
          statusText.value = `数据库 ${database} 已不存在，列表已刷新`;
          return;
        }
        await loadTables({ connectionId, database });
        statusText.value = `已刷新数据库 ${database}`;
        return;
      }

      if (kind === "connection") {
        statusText.value = refreshedDatabases?.length
          ? `已刷新数据库列表（${refreshedDatabases.length} 个）`
          : "已刷新数据库列表";
        return;
      }

      await loadTables({ connectionId, database });
      statusText.value = "已刷新对象树";
    } catch (error) {
      statusText.value = `刷新失败：${String(error)}`;
    }
  }

  function openDesignFromContextMenu() {
    const source = {
      connectionId: contextMenu.connectionId,
      database: contextMenu.database,
      tableName: contextMenu.tableName,
      tableComment: contextMenu.tableComment,
    };
    closeContextMenu();
    if (!source.tableName) return;
    openTableDesign?.(source);
  }

  function renameFromContextMenu() {
    const source = {
      connectionId: contextMenu.connectionId,
      database: contextMenu.database,
      tableName: contextMenu.tableName,
      tableComment: contextMenu.tableComment,
    };
    closeContextMenu();
    return source;
  }

  return { contextMenu, contextMenuStyle, openContextMenu, openRowContextMenu, closeContextMenu, refreshFromContextMenu, openDesignFromContextMenu, renameFromContextMenu };
}
