import { computed, reactive } from "vue";
import { normalizeTableComment, normalizeTableName } from "../utils/normalize.js";

export function useContextMenu(
  { statusText },
  { loadTables, ensureTableSchema, fetchPage },
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
  });

  const contextMenuStyle = computed(() => ({
    left: `${contextMenu.x}px`,
    top: `${contextMenu.y}px`,
  }));

  function openContextMenu(event, target = null) {
    const tableName = normalizeTableName(target);
    const kind = target?.kind === "database" ? "database" : tableName ? "table" : "general";
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

  function closeContextMenu() {
    contextMenu.open = false;
  }

  async function refreshFromContextMenu() {
    const tableName = contextMenu.tableName;
    const source = { connectionId: contextMenu.connectionId, database: contextMenu.database };
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
      await loadTables();
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

  return { contextMenu, contextMenuStyle, openContextMenu, closeContextMenu, refreshFromContextMenu, openDesignFromContextMenu, renameFromContextMenu };
}
