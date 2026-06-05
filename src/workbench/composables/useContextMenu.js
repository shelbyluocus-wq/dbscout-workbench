import { computed, reactive } from "vue";
import { normalizeTableComment, normalizeTableName } from "../utils/normalize.js";

export function useContextMenu({ statusText }, { loadTables, ensureTableSchema, fetchPage }, activeTab, { openTableDesign } = {}) {
  const contextMenu = reactive({ open: false, x: 0, y: 0, tableName: "", tableComment: "", connectionId: "", database: "", tableScoped: false });

  const contextMenuStyle = computed(() => ({
    left: `${contextMenu.x}px`,
    top: `${contextMenu.y}px`,
  }));

  function openContextMenu(event, table = null) {
    contextMenu.open = true;
    contextMenu.x = event.clientX;
    contextMenu.y = event.clientY;
    contextMenu.tableName = normalizeTableName(table);
    contextMenu.tableComment = normalizeTableComment(table);
    contextMenu.connectionId = String(table?.connectionId || table?.connection_id || "");
    contextMenu.database = String(table?.database || "");
    contextMenu.tableScoped = Boolean(contextMenu.tableName);
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
          await fetchPage(activeTab.value, activeTab.value.page);
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

  return { contextMenu, contextMenuStyle, openContextMenu, closeContextMenu, refreshFromContextMenu, openDesignFromContextMenu };
}
