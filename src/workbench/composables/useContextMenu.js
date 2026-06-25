import { computed, reactive } from "vue";
import { normalizeTableComment, normalizeTableName } from "../utils/normalize.js";
import { buildRowKey } from "../utils/rowIdentity.js";

const MENU_WIDTH = 180;
const ROW_MENU_HEIGHT = 104;
const DEFAULT_MENU_HEIGHT = 220;
const VIEWPORT_MARGIN = 8;

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
    rowTab: null,
    row: null,
    rowActions: null,
  });

  const contextMenuStyle = computed(() => ({
    left: `${contextMenu.x}px`,
    top: `${contextMenu.y}px`,
  }));

  function menuPoint(event, { height = DEFAULT_MENU_HEIGHT } = {}) {
    const viewportWidth = Number(globalThis.innerWidth || 0);
    const viewportHeight = Number(globalThis.innerHeight || 0);
    const maxX = viewportWidth > 0 ? Math.max(VIEWPORT_MARGIN, viewportWidth - MENU_WIDTH - VIEWPORT_MARGIN) : Infinity;
    const maxY = viewportHeight > 0 ? Math.max(VIEWPORT_MARGIN, viewportHeight - height - VIEWPORT_MARGIN) : Infinity;
    return {
      x: Math.max(VIEWPORT_MARGIN, Math.min(Number(event?.clientX || 0), maxX)),
      y: Math.max(VIEWPORT_MARGIN, Math.min(Number(event?.clientY || 0), maxY)),
    };
  }

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
    const point = menuPoint(event);
    contextMenu.x = point.x;
    contextMenu.y = point.y;
    contextMenu.kind = kind;
    contextMenu.tableName = kind === "table" ? tableName : "";
    contextMenu.tableComment = kind === "table" ? normalizeTableComment(target) : "";
    contextMenu.connectionId = String(target?.connectionId || target?.connection_id || "");
    contextMenu.database = String(target?.database || "");
    contextMenu.tableScoped = kind === "table";
    contextMenu.rowTabId = "";
    contextMenu.rowKey = "";
    contextMenu.anchorIndex = null;
    contextMenu.rowReadOnly = false;
    contextMenu.rowTab = null;
    contextMenu.row = null;
    contextMenu.rowActions = null;
  }

  function openRowContextMenu(event, tab, row, originalIndex, rowActions = null) {
    contextMenu.open = true;
    const point = menuPoint(event, { height: ROW_MENU_HEIGHT });
    contextMenu.x = point.x;
    contextMenu.y = point.y;
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
    contextMenu.rowTab = tab || null;
    contextMenu.row = row;
    contextMenu.rowActions = rowActions || null;
  }

  function closeContextMenu() {
    contextMenu.open = false;
  }

  async function refreshFromContextMenu() {
    const kind = contextMenu.kind;
    const rowTab = kind === "grid-row" ? contextMenu.rowTab : null;
    const tableName = contextMenu.tableName || rowTab?.tableName || "";
    const connectionId = String(contextMenu.connectionId || rowTab?.connectionId || "").trim() || undefined;
    const database = String(contextMenu.database || rowTab?.database || "").trim() || undefined;
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
          if (result?.cancelled) return;
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
