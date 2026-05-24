import { computed, reactive } from "vue";
import { normalizeTableName } from "../utils/normalize.js";

export function useContextMenu({ statusText }, { loadTables, ensureTableSchema, fetchPage }, activeTab) {
  const contextMenu = reactive({ open: false, x: 0, y: 0, tableName: "" });

  const contextMenuStyle = computed(() => ({
    left: `${contextMenu.x}px`,
    top: `${contextMenu.y}px`,
  }));

  function openContextMenu(event, table = null) {
    contextMenu.open = true;
    contextMenu.x = event.clientX;
    contextMenu.y = event.clientY;
    contextMenu.tableName = normalizeTableName(table);
  }

  function closeContextMenu() {
    contextMenu.open = false;
  }

  async function refreshFromContextMenu() {
    const tableName = contextMenu.tableName;
    closeContextMenu();
    try {
      if (tableName) {
        await ensureTableSchema(tableName);
        if (activeTab.value?.tableName === tableName) {
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
