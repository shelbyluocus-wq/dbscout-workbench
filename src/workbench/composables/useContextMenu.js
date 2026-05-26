import { computed, reactive } from "vue";
import { normalizeTableName } from "../utils/normalize.js";

export function useContextMenu({ statusText }, { loadTables, ensureTableSchema, fetchPage }, activeTab) {
  const contextMenu = reactive({ open: false, x: 0, y: 0, tableName: "", connectionId: "", database: "" });

  const contextMenuStyle = computed(() => ({
    left: `${contextMenu.x}px`,
    top: `${contextMenu.y}px`,
  }));

  function openContextMenu(event, table = null) {
    contextMenu.open = true;
    contextMenu.x = event.clientX;
    contextMenu.y = event.clientY;
    contextMenu.tableName = normalizeTableName(table);
    contextMenu.connectionId = String(table?.connectionId || table?.connection_id || "");
    contextMenu.database = String(table?.database || "");
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

  return { contextMenu, contextMenuStyle, openContextMenu, closeContextMenu, refreshFromContextMenu };
}
