import { computed, reactive } from "vue";
import { normalizeTableComment, normalizeTableName } from "../utils/normalize.js";
import { gridRowKey } from "../utils/gridRowIdentity.js";

const MENU_WIDTH = 180;
const ROW_MENU_HEIGHT = 280;
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
    surface: "general",
    tableName: "",
    // Sidebar multi-selection the table actions apply to (includes tableName).
    tableNames: [],
    tableComment: "",
    connectionId: "",
    database: "",
    tableScoped: false,
    rowTabId: "",
    rowKey: "",
    anchorIndex: null,
    // 右键目标所在列序号（0-based），用于「冻结到此列」。当右键的是数据
    // 单元格时由调用方传入；表头右键时由事件源解析；无明确列时为 -1。
    targetColumnIndex: -1,
    fromColumnHeader: false,
    rowReadOnly: false,
    rowTab: null,
    row: null,
    rowActions: null,
    // 右键打开行菜单时当前表选中的行数，用于「删除 X 行」标签与多行删除分发。
    selectedRowCount: 0,
    canInsertCopiedRows: false,
    canToggleHitResultPane: false,
    hitResultPaneOpen: false,
    hitResultSourceTabId: "",
    hitResultSourcePaneId: "",
    hitResultQuery: "",
    hitResultFilterMode: "fuzzy",
    showClipboardActions: false,
    canCopy: false,
    canPaste: false,
    clipboardActions: null,
    commentTarget: null,
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

  function resetHitResultContext() {
    contextMenu.canToggleHitResultPane = false;
    contextMenu.hitResultPaneOpen = false;
    contextMenu.hitResultSourceTabId = "";
    contextMenu.hitResultSourcePaneId = "";
    contextMenu.hitResultQuery = "";
    contextMenu.hitResultFilterMode = "exact";
  }

  function resetClipboardContext() {
    contextMenu.showClipboardActions = false;
    contextMenu.canCopy = false;
    contextMenu.canPaste = false;
    contextMenu.clipboardActions = null;
  }

  function openContextMenu(
    event,
    target = null,
    {
      columnIndex = -1,
      surface = "general",
      menuHeight = DEFAULT_MENU_HEIGHT,
      clipboardActions = null,
      commentTarget = null,
      tableNames = null,
    } = {},
  ) {
    const tableName = normalizeTableName(target);
    const kind = target?.kind === "database"
      ? "database"
      : target?.kind === "connection"
        ? "connection"
        : tableName
          ? "table"
          : "general";
    contextMenu.open = true;
    const point = menuPoint(event, { height: menuHeight });
    contextMenu.x = point.x;
    contextMenu.y = point.y;
    contextMenu.kind = kind;
    contextMenu.surface = String(surface || "general");
    contextMenu.tableName = kind === "table" ? tableName : "";
    contextMenu.tableNames = kind === "table" ? selectionNames(tableNames, tableName) : [];
    contextMenu.tableComment = kind === "table" ? normalizeTableComment(target) : "";
    contextMenu.connectionId = String(target?.connectionId || target?.connection_id || "");
    contextMenu.database = String(target?.database || "");
    contextMenu.tableScoped = kind === "table";
    contextMenu.rowTabId = "";
    contextMenu.rowKey = "";
    contextMenu.anchorIndex = null;
    contextMenu.targetColumnIndex = Number.isFinite(columnIndex) ? columnIndex : -1;
    contextMenu.fromColumnHeader = false;
    contextMenu.rowReadOnly = false;
    contextMenu.rowTab = null;
    contextMenu.row = null;
    contextMenu.rowActions = null;
    contextMenu.selectedRowCount = 0;
    contextMenu.canInsertCopiedRows = false;
    contextMenu.showClipboardActions = Boolean(clipboardActions);
    contextMenu.canCopy = Boolean(clipboardActions?.canCopy);
    contextMenu.canPaste = Boolean(clipboardActions?.canPaste);
    contextMenu.clipboardActions = clipboardActions || null;
    contextMenu.commentTarget = normalizeCommentTarget(commentTarget);
    resetHitResultContext();
  }

  function openRowContextMenu(event, tab, row, originalIndex, rowActions = null, columnIndex = -1) {
    contextMenu.open = true;
    const point = menuPoint(event, { height: ROW_MENU_HEIGHT });
    contextMenu.x = point.x;
    contextMenu.y = point.y;
    contextMenu.kind = "grid-row";
    contextMenu.surface = "grid";
    contextMenu.tableScoped = false;
    contextMenu.tableName = "";
    contextMenu.tableNames = [];
    contextMenu.tableComment = "";
    contextMenu.connectionId = "";
    contextMenu.database = "";
    contextMenu.rowTabId = String(tab?.id || "");
    contextMenu.rowKey = gridRowKey(tab, row);
    contextMenu.anchorIndex = originalIndex;
    contextMenu.targetColumnIndex = Number.isFinite(columnIndex) ? columnIndex : -1;
    contextMenu.fromColumnHeader = false;
    contextMenu.rowReadOnly = Boolean(tab?.readOnly || tab?.read_only);
    contextMenu.rowTab = tab || null;
    contextMenu.row = row;
    contextMenu.rowActions = rowActions || null;
    contextMenu.selectedRowCount = Number(rowActions?.selectedRowCount) || 0;
    contextMenu.canInsertCopiedRows = Boolean(rowActions?.canInsertCopiedRows);
    contextMenu.commentTarget = null;
    resetClipboardContext();
    resetHitResultContext();
  }

  function selectionNames(names, tableName) {
    const list = Array.isArray(names) ? names.map((name) => String(name || "")).filter(Boolean) : [];
    return list.includes(tableName) ? [...new Set(list)] : [tableName];
  }

  function normalizeCommentTarget(target) {
    const kind = target?.kind === "table" || target?.kind === "column" ? target.kind : "";
    if (!kind) return null;
    const columnName = String(target.columnName || "");
    if (kind === "column" && !columnName) return null;
    return {
      kind,
      columnName,
      comment: String(target.comment || ""),
    };
  }

  function closeContextMenu() {
    contextMenu.open = false;
  }

  async function runClipboardAction(kind, successMessage) {
    const action = contextMenu.clipboardActions?.[kind];
    closeContextMenu();
    if (typeof action !== "function") return false;
    try {
      const result = await action();
      if (result?.ok === false) {
        if (result.message) statusText.value = result.message;
        return false;
      }
      statusText.value = successMessage;
      return true;
    } catch (error) {
      statusText.value = `${kind === "copy" ? "复制" : "粘贴"}失败：${String(error?.message || error)}`;
      return false;
    }
  }

  function copyFromContextMenu() {
    return runClipboardAction("copy", "复制成功");
  }

  function pasteFromContextMenu() {
    return runClipboardAction("paste", "粘贴成功");
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
        await ensureTableSchema(tableName, { ...source, force: true });
        const hasSource = Boolean(source.connectionId || source.database);
        const sameTab = hasSource
          ? activeTab.value?.tableKey === [source.connectionId, source.database, tableName].join("\u001f")
          : activeTab.value?.tableName === tableName;
        if (sameTab) {
          const result = await fetchPage(activeTab.value, 1);
          if (result?.cancelled) return;
          if (result?.ok) await onTablePageRefreshed(activeTab.value);
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
    const tableNames = [...contextMenu.tableNames];
    closeContextMenu();
    if (!source.tableName) return;
    // A sidebar multi-selection opens the design of every selected table.
    if (tableNames.length > 1) {
      openTableDesign?.(tableNames.map((tableName) => ({ ...source, tableName, tableComment: "" })));
      return;
    }
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

  function renameDatabaseFromContextMenu() {
    const source = {
      connectionId: contextMenu.connectionId,
      database: contextMenu.database,
    };
    closeContextMenu();
    return source;
  }

  function renameConnectionFromContextMenu() {
    const source = { connectionId: contextMenu.connectionId };
    closeContextMenu();
    return source;
  }

  return { contextMenu, contextMenuStyle, openContextMenu, openRowContextMenu, closeContextMenu, copyFromContextMenu, pasteFromContextMenu, refreshFromContextMenu, openDesignFromContextMenu, renameFromContextMenu, renameDatabaseFromContextMenu, renameConnectionFromContextMenu };
}
