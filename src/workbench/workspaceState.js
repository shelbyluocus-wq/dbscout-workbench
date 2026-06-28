import { compareSearchMatches, matchSearchText } from "./utils/searchMatch.js";

const DEFAULT_PAGE_SIZE = 100;
const COLUMN_PREVIEW_LIMIT = 3;
const SCHEMA_MATCH_RANK = Object.freeze({
  tableName: 0,
  columnName: 5,
  tableComment: 10,
  columnComment: 15,
});

function createPaneRecord(id, values = {}) {
  return {
    id,
    tabIds: Array.isArray(values.tabIds) ? [...values.tabIds] : [],
    activeTabId: String(values.activeTabId || ""),
  };
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function tableKey(connectionId, database, tableName) {
  return [connectionId, database, tableName].map((value) => String(value ?? "").trim()).join("\u001f");
}

function normalizeTabKind(kind) {
  return kind === "design" ? "design" : "data";
}

function tabKey(kind, sourceKey) {
  return [normalizeTabKind(kind), sourceKey].join("");
}

function createBaseTab({ id, kind, connectionId = "", database = "", tableName, tableComment = "", readOnly = false }) {
  const normalizedKind = normalizeTabKind(kind);
  const sourceKey = tableKey(connectionId, database, tableName);
  return {
    id,
    kind: normalizedKind,
    connectionId,
    database,
    tableName,
    tableKey: sourceKey,
    tabKey: tabKey(normalizedKind, sourceKey),
    tableComment,
    readOnly: Boolean(readOnly),
  };
}

function ensureTabIdentity(tab, kind, sourceKey) {
  tab.kind = normalizeTabKind(kind);
  tab.tableKey = sourceKey;
  tab.tabKey = tabKey(tab.kind, sourceKey);
}

function createEmptyTab({ id, connectionId = "", database = "", tableName, tableComment = "", readOnly = false }) {
  return {
    ...createBaseTab({ id, kind: "data", connectionId, database, tableName, tableComment, readOnly }),
    sessionId: "",
    columns: [],
    rows: [],
    totalRows: 0,
    totalRowsExact: true,
    totalRowsLoading: false,
    totalRowsError: "",
    hasMore: false,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    rowKeyCacheVersion: 0,
    loading: false,
    loadingMore: false,
    fullyLoaded: false,
    filter: "",
    filterMode: "fuzzy",
    sort: null,
    selectedRowKeys: new Set(),
    schemaSearchQuery: "",
    schemaSearchMatches: [],
    schemaSearchIndex: -1,
  };
}

function createDesignTab({ id, connectionId = "", database = "", tableName, tableComment = "" }) {
  return {
    ...createBaseTab({ id, kind: "design", connectionId, database, tableName, tableComment }),
    loading: false,
    saving: false,
    error: "",
    design: null,
    draft: null,
    dirty: false,
    preview: "",
  };
}

export function createWorkspaceState({ connectionId = "", database = "" } = {}) {
  const defaultPane = createPaneRecord("pane-1");
  return {
    connectionId,
    database,
    connectionStatus: "disconnected",
    databases: [],
    tables: [],
    schema: [],
    tabs: [],
    activeTabId: "",
    panes: { [defaultPane.id]: defaultPane },
    layout: { type: "pane", paneId: defaultPane.id },
    focusedPaneId: defaultPane.id,
    nextPaneSeq: 2,
    nextSplitSeq: 1,
    nextTabSeq: 1,
  };
}

function ensurePaneState(state) {
  if (!state) return null;
  if (!state.panes || typeof state.panes !== "object") {
    const pane = createPaneRecord("pane-1", {
      tabIds: state.tabs?.map((tab) => tab.id) || [],
      activeTabId: state.activeTabId || "",
    });
    state.panes = { [pane.id]: pane };
  }
  if (!state.layout) state.layout = { type: "pane", paneId: Object.keys(state.panes)[0] || "pane-1" };
  if (!state.focusedPaneId || !state.panes[state.focusedPaneId]) {
    state.focusedPaneId = Object.keys(state.panes)[0] || "pane-1";
  }
  return state;
}

function paneForTab(state, tabId) {
  ensurePaneState(state);
  return Object.values(state.panes || {}).find((pane) => pane.tabIds?.includes(tabId)) || null;
}

function ensurePane(state, paneId = "") {
  ensurePaneState(state);
  const id = String(paneId || state.focusedPaneId || "pane-1");
  if (!state.panes[id]) state.panes[id] = createPaneRecord(id);
  return state.panes[id];
}

function addTabToPane(state, paneId, tabId, { activate = true } = {}) {
  const pane = ensurePane(state, paneId);
  if (!pane.tabIds.includes(tabId)) pane.tabIds.push(tabId);
  if (activate) {
    pane.activeTabId = tabId;
    state.focusedPaneId = pane.id;
    state.activeTabId = tabId;
  }
  return pane;
}

function removeTabFromPane(state, pane, tabId) {
  if (!pane) return;
  const index = pane.tabIds.indexOf(tabId);
  if (index < 0) return;
  pane.tabIds.splice(index, 1);
  if (pane.activeTabId === tabId) {
    const next = pane.tabIds[index] || pane.tabIds[index - 1] || "";
    pane.activeTabId = next;
  }
}

export function getFocusedPane(state) {
  ensurePaneState(state);
  return state?.panes?.[state.focusedPaneId] || null;
}

export function getFocusedTab(state) {
  const pane = getFocusedPane(state);
  const tabId = pane?.activeTabId || state?.activeTabId || "";
  return state?.tabs?.find((tab) => tab.id === tabId) || null;
}

export function focusPane(state, paneId) {
  const pane = state?.panes?.[paneId] ? state.panes[paneId] : null;
  if (!pane) return null;
  state.focusedPaneId = pane.id;
  state.activeTabId = pane.activeTabId || "";
  return pane;
}

export function openTableTab(
  state,
  {
    connectionId = state?.connectionId || "",
    database = state?.database || "",
    tableName = "",
    tableComment = "",
    readOnly = false,
  } = {},
  { activate = true, paneId = "" } = {},
) {
  const safeName = String(tableName || "").trim();
  if (!state || !safeName) return null;
  const safeConnectionId = String(connectionId || "").trim();
  const safeDatabase = String(database || "").trim();
  const sourceKey = tableKey(safeConnectionId, safeDatabase, safeName);
  const dataTabKey = tabKey("data", sourceKey);
  const pane = ensurePane(state, paneId);
  const existing = state.tabs.find((tab) => {
    const kind = normalizeTabKind(tab.kind);
    const source = tab.tableKey || tableKey(tab.connectionId, tab.database, tab.tableName);
    ensureTabIdentity(tab, kind, source);
    return tab.tabKey === dataTabKey && pane.tabIds.includes(tab.id);
  });
  if (existing) {
    if (activate) addTabToPane(state, pane.id, existing.id, { activate: true });
    return existing;
  }
  const tab = createEmptyTab({
    id: `tab-${state.nextTabSeq++}`,
    connectionId: safeConnectionId,
    database: safeDatabase,
    tableName: safeName,
    tableComment,
    readOnly,
  });
  state.tabs.push(tab);
  addTabToPane(state, pane.id, tab.id, { activate });
  return tab;
}

export function openTableDesignTab(
  state,
  {
    connectionId = state?.connectionId || "",
    database = state?.database || "",
    tableName = "",
    tableComment = "",
  } = {},
  { activate = true, paneId = "" } = {},
) {
  const safeName = String(tableName || "").trim();
  if (!state || !safeName) return null;
  const safeConnectionId = String(connectionId || "").trim();
  const safeDatabase = String(database || "").trim();
  const sourceKey = tableKey(safeConnectionId, safeDatabase, safeName);
  const designTabKey = tabKey("design", sourceKey);
  const pane = ensurePane(state, paneId);
  const existing = state.tabs.find((tab) => {
    const kind = normalizeTabKind(tab.kind);
    const source = tab.tableKey || tableKey(tab.connectionId, tab.database, tab.tableName);
    ensureTabIdentity(tab, kind, source);
    return tab.tabKey === designTabKey && pane.tabIds.includes(tab.id);
  });
  if (existing) {
    if (activate) addTabToPane(state, pane.id, existing.id, { activate: true });
    return existing;
  }
  const tab = createDesignTab({
    id: `tab-${state.nextTabSeq++}`,
    connectionId: safeConnectionId,
    database: safeDatabase,
    tableName: safeName,
    tableComment,
  });
  state.tabs.push(tab);
  addTabToPane(state, pane.id, tab.id, { activate });
  return tab;
}

function schemaColumnName(column) {
  return column?.column_name || column?.columnName || column?.name || "";
}

function columnRenameMap(previousColumns = [], nextColumns = []) {
  const renames = new Map();

  previousColumns.forEach((previousColumn, index) => {
    const previousName = schemaColumnName(previousColumn);
    const nextName = schemaColumnName(nextColumns[index]);
    if (previousName && nextName && previousName !== nextName) {
      renames.set(previousName, nextName);
    }
  });

  nextColumns.forEach((nextColumn) => {
    const originalName = nextColumn?.original_name || nextColumn?.originalName || "";
    const nextName = schemaColumnName(nextColumn);
    if (originalName && nextName && originalName !== nextName) {
      renames.set(originalName, nextName);
    }
  });

  return renames;
}

function migrateSortColumn(tab, renames, nextColumns) {
  if (!tab?.sort) return;
  const currentName = tab.sort.columnName || tab.sort.column_name || "";
  if (!currentName) return;
  const nextNames = new Set(nextColumns.map(schemaColumnName).filter(Boolean));
  const nextName = renames.get(currentName) || (nextNames.has(currentName) ? currentName : "");
  if (!nextName) {
    tab.sort = null;
    return;
  }
  const nextSort = { ...tab.sort, columnName: nextName };
  if (Object.prototype.hasOwnProperty.call(nextSort, "column_name")) {
    nextSort.column_name = nextName;
  }
  tab.sort = nextSort;
}

function migrateRowColumnKeys(rows, renames) {
  if (!Array.isArray(rows) || renames.size === 0) return;
  rows.forEach((row) => {
    if (!row || typeof row !== "object") return;
    const snapshot = { ...row };
    renames.forEach((_, previousName) => {
      if (Object.prototype.hasOwnProperty.call(snapshot, previousName)) {
        delete row[previousName];
      }
    });
    renames.forEach((nextName, previousName) => {
      if (Object.prototype.hasOwnProperty.call(snapshot, previousName)) {
        row[nextName] = snapshot[previousName];
      }
    });
  });
}

function schemaTableComment(schema = {}) {
  return schema?.table_comment || schema?.tableComment || schema?.comment || "";
}

export function applyTableSchemaToDataTab(tab, schema = {}) {
  if (!tab || !schema) return tab || null;
  if (Array.isArray(schema.columns)) {
    const previousColumns = Array.isArray(tab.columns) ? tab.columns : [];
    const renames = columnRenameMap(previousColumns, schema.columns);
    migrateSortColumn(tab, renames, schema.columns);
    migrateRowColumnKeys(tab.rows, renames);
    tab.columns = schema.columns;
    tab.primaryKeys = Array.isArray(schema.primaryKeys)
      ? schema.primaryKeys
      : schema.columns
          .filter((column) => column.is_primary_key || column.isPrimaryKey || column.primaryKey)
          .map(schemaColumnName)
          .filter(Boolean);
  } else if (Array.isArray(schema.primaryKeys)) {
    tab.primaryKeys = schema.primaryKeys;
  }
  if ("table_comment" in schema || "tableComment" in schema || "comment" in schema) {
    tab.tableComment = schemaTableComment(schema);
  }
  tab.selectedRowKeys?.clear?.();
  return tab;
}

export function markTableDataTabSchemaStale(tab, schema = {}) {
  if (!tab) return null;
  applyTableSchemaToDataTab(tab, schema);
  tab.sessionId = "";
  tab.rows = [];
  tab.totalRows = 0;
  tab.totalRowsExact = true;
  tab.totalRowsLoading = false;
  tab.totalRowsError = "";
  tab.hasMore = false;
  tab.page = 1;
  tab.loading = false;
  tab.loadingMore = false;
  tab.fullyLoaded = true;
  bumpRowKeyCacheVersion(tab);
  tab.selectedRowKeys?.clear?.();
  return tab;
}

export function findTableDataTabs(state, source = {}) {
  if (!state) return [];
  const safeConnectionId = String(source.connectionId || source.connection_id || "").trim();
  const safeDatabase = String(source.database || "").trim();
  const safeName = String(source.tableName || source.table_name || source.name || "").trim();
  const sourceKey = String(source.tableKey || (safeName ? tableKey(safeConnectionId, safeDatabase, safeName) : ""));
  if (!sourceKey) return [];
  return state.tabs.filter((tab) => {
    const kind = normalizeTabKind(tab.kind);
    const tabSource = tab.tableKey || tableKey(tab.connectionId, tab.database, tab.tableName);
    ensureTabIdentity(tab, kind, tabSource);
    return kind === "data" && tab.tableKey === sourceKey;
  });
}

export function activateTableTab(state, tabId) {
  if (!state || !tabId) return null;
  const tab = state.tabs.find((item) => item.id === tabId);
  if (!tab) return null;
  const pane = paneForTab(state, tabId);
  if (pane) {
    pane.activeTabId = tab.id;
    state.focusedPaneId = pane.id;
  }
  state.activeTabId = tab.id;
  return tab;
}

export function closeTableTab(state, tabId) {
  if (!state || !tabId) return null;
  const ownerPane = paneForTab(state, tabId);
  return closePaneTab(state, ownerPane?.id || state.focusedPaneId, tabId);
}

export function closePaneTab(state, paneId, tabId) {
  if (!state || !tabId) return null;
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return null;
  const ownerPane = state.panes?.[paneId] || paneForTab(state, tabId);
  const [closed] = state.tabs.splice(index, 1);
  removeTabFromPane(state, ownerPane, tabId);
  if (ownerPane) {
    state.focusedPaneId = ownerPane.id;
    state.activeTabId = ownerPane.activeTabId || "";
  } else if (state.activeTabId === tabId) {
    state.activeTabId = state.tabs[index]?.id || state.tabs[index - 1]?.id || "";
  }
  return closed;
}

export function moveTableTab(state, sourceId, targetId, { position = "before" } = {}) {
  if (!state || !sourceId || !targetId || sourceId === targetId) return null;
  const sourceIndex = state.tabs.findIndex((tab) => tab.id === sourceId);
  const targetIndex = state.tabs.findIndex((tab) => tab.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return null;

  const [source] = state.tabs.splice(sourceIndex, 1);
  const targetIndexAfterRemoval = state.tabs.findIndex((tab) => tab.id === targetId);
  const insertIndex = position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval;
  state.tabs.splice(insertIndex, 0, source);
  const pane = paneForTab(state, sourceId);
  if (pane && pane.tabIds.includes(targetId)) {
    const sourcePaneIndex = pane.tabIds.indexOf(sourceId);
    const targetPaneIndex = pane.tabIds.indexOf(targetId);
    pane.tabIds.splice(sourcePaneIndex, 1);
    const targetIndexAfterPaneRemoval = pane.tabIds.indexOf(targetId);
    const paneInsertIndex = position === "after" ? targetIndexAfterPaneRemoval + 1 : targetIndexAfterPaneRemoval;
    pane.tabIds.splice(paneInsertIndex, 0, sourceId);
  }
  return source;
}

export function moveTabBetweenPanes(state, tabId, targetPaneId, { targetTabId = "", position = "after", activate = true } = {}) {
  if (!state || !tabId || !state.tabs.some((tab) => tab.id === tabId)) return null;
  const targetPane = ensurePane(state, targetPaneId);
  const sourcePane = paneForTab(state, tabId);
  if (sourcePane?.id === targetPane.id) {
    if (activate) addTabToPane(state, targetPane.id, tabId, { activate: true });
    return state.tabs.find((tab) => tab.id === tabId) || null;
  }
  removeTabFromPane(state, sourcePane, tabId);
  if (!targetPane.tabIds.includes(tabId)) {
    if (targetTabId && targetPane.tabIds.includes(targetTabId)) {
      const targetIndex = targetPane.tabIds.indexOf(targetTabId);
      const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
      targetPane.tabIds.splice(insertIndex, 0, tabId);
    } else {
      targetPane.tabIds.push(tabId);
    }
  }
  if (activate) {
    targetPane.activeTabId = tabId;
    state.focusedPaneId = targetPane.id;
    state.activeTabId = tabId;
  }
  return state.tabs.find((tab) => tab.id === tabId) || null;
}

export function closeAllTableTabs(state) {
  if (!state) return;
  state.tabs.splice(0, state.tabs.length);
  state.activeTabId = "";
  ensurePaneState(state);
  Object.values(state.panes || {}).forEach((pane) => {
    pane.tabIds.splice(0, pane.tabIds.length);
    pane.activeTabId = "";
  });
}

export function closePaneTabs(state, paneId = "") {
  ensurePaneState(state);
  const pane = state?.panes?.[paneId || state.focusedPaneId];
  if (!pane?.tabIds?.length) return [];
  const closedIds = new Set(pane.tabIds);
  const closed = state.tabs.filter((tab) => closedIds.has(tab.id));
  if (!closed.length) return [];

  state.tabs = state.tabs.filter((tab) => !closedIds.has(tab.id));
  pane.tabIds.splice(0, pane.tabIds.length);
  pane.activeTabId = "";
  state.focusedPaneId = pane.id;
  state.activeTabId = "";
  return closed;
}

export function closeDatabaseTabs(state, { connectionId = "", database = "" } = {}) {
  if (!state || !database) return [];
  const safeConnectionId = String(connectionId || "");
  const safeDatabase = String(database || "");
  const closed = [];
  const remaining = [];
  let firstClosedIndex = -1;
  let activeWasClosed = false;

  state.tabs.forEach((tab, index) => {
    const isMatch = String(tab.connectionId || "") === safeConnectionId && String(tab.database || "") === safeDatabase;
    if (isMatch) {
      if (firstClosedIndex < 0) firstClosedIndex = index;
      if (state.activeTabId === tab.id) activeWasClosed = true;
      closed.push(tab);
    } else {
      remaining.push(tab);
    }
  });

  if (!closed.length) return [];
  state.tabs.splice(0, state.tabs.length, ...remaining);
  ensurePaneState(state);
  const remainingIds = new Set(remaining.map((tab) => tab.id));
  Object.values(state.panes || {}).forEach((pane) => {
    pane.tabIds = pane.tabIds.filter((tabId) => remainingIds.has(tabId));
    if (pane.activeTabId && !remainingIds.has(pane.activeTabId)) {
      pane.activeTabId = pane.tabIds[0] || "";
    }
  });
  if (activeWasClosed) {
    const focusedPane = getFocusedPane(state);
    state.activeTabId = focusedPane?.activeTabId || "";
    if (!state.activeTabId) {
      const nextIndex = Math.min(firstClosedIndex, state.tabs.length - 1);
      state.activeTabId = nextIndex >= 0 ? state.tabs[nextIndex]?.id || "" : "";
    }
  }
  return closed;
}

export function closeConnectionTabs(state, { connectionId = "" } = {}) {
  if (!state || !connectionId) return [];
  const safeConnectionId = String(connectionId || "");
  const closed = [];
  const remaining = [];
  let firstClosedIndex = -1;
  let activeWasClosed = false;

  state.tabs.forEach((tab, index) => {
    const isMatch = String(tab.connectionId || "") === safeConnectionId;
    if (isMatch) {
      if (firstClosedIndex < 0) firstClosedIndex = index;
      if (state.activeTabId === tab.id) activeWasClosed = true;
      closed.push(tab);
    } else {
      remaining.push(tab);
    }
  });

  if (!closed.length) return [];
  state.tabs.splice(0, state.tabs.length, ...remaining);
  ensurePaneState(state);
  const remainingIds = new Set(remaining.map((tab) => tab.id));
  Object.values(state.panes || {}).forEach((pane) => {
    pane.tabIds = pane.tabIds.filter((tabId) => remainingIds.has(tabId));
    if (pane.activeTabId && !remainingIds.has(pane.activeTabId)) {
      pane.activeTabId = pane.tabIds[0] || "";
    }
  });
  if (activeWasClosed) {
    const focusedPane = getFocusedPane(state);
    state.activeTabId = focusedPane?.activeTabId || "";
    if (!state.activeTabId) {
      const nextIndex = Math.min(firstClosedIndex, state.tabs.length - 1);
      state.activeTabId = nextIndex >= 0 ? state.tabs[nextIndex]?.id || "" : "";
    }
  }
  return closed;
}

export function renameTableTab(state, { connectionId = "", database = "", oldName = "", newName = "" } = {}) {
  if (!state || !oldName || !newName || oldName === newName) return [];
  const safeConnectionId = String(connectionId || "");
  const safeDatabase = String(database || "");
  const updated = [];
  for (const tab of state.tabs) {
    if (
      String(tab.connectionId || "") === safeConnectionId &&
      String(tab.database || "") === safeDatabase &&
      String(tab.tableName || "") === oldName
    ) {
      const newSourceKey = tableKey(safeConnectionId, safeDatabase, newName);
      tab.tableName = newName;
      tab.tableKey = newSourceKey;
      tab.tabKey = tabKey(tab.kind, newSourceKey);
      updated.push(tab);
    }
  }
  return updated;
}

export function getActiveTab(state) {
  if (!state?.activeTabId) return null;
  return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
}

function coerceNonNegativeInteger(value, fallback = 0) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback;
}

function coercePositiveInteger(value, fallback = 1) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function updateFullyLoaded(tab) {
  if (tab.hasMore === false) {
    tab.fullyLoaded = true;
    return;
  }
  tab.fullyLoaded = Boolean(tab.totalRowsExact) && tab.rows.length >= tab.totalRows;
}

function pickPageValue(pageData, camelName, snakeName) {
  return Object.prototype.hasOwnProperty.call(pageData, camelName)
    ? pageData[camelName]
    : pageData[snakeName];
}

function normalizeTotalRowsExact(pageData, fallback = true) {
  const value = pickPageValue(pageData, "totalRowsExact", "total_rows_exact");
  return value === undefined ? Boolean(fallback) : Boolean(value);
}

function normalizeHasMore(pageData, { rows, pageSize, totalRows, totalRowsExact, fallback = false } = {}) {
  const value = pickPageValue(pageData, "hasMore", "has_more");
  if (value !== undefined) return Boolean(value);
  if (totalRowsExact) return rows.length < totalRows;
  return rows.length >= pageSize || Boolean(fallback);
}

function bumpRowKeyCacheVersion(tab) {
  tab.rowKeyCacheVersion = coerceNonNegativeInteger(tab.rowKeyCacheVersion, 0) + 1;
}

function replacePrimaryKeysFromPage(tab, pageData) {
  if (!Array.isArray(pageData.primaryKeys) && !Array.isArray(pageData.primary_keys)) return false;
  const primaryKeys = Array.isArray(pageData.primaryKeys) ? pageData.primaryKeys : pageData.primary_keys;
  const previous = Array.isArray(tab.primaryKeys) ? tab.primaryKeys : [];
  const changed = previous.length !== primaryKeys.length || previous.some((key, index) => key !== primaryKeys[index]);
  tab.primaryKeys = [...primaryKeys];
  return changed;
}

function mergeAppendedTotalRows(tab, pageData) {
  const nextExact = normalizeTotalRowsExact(pageData, tab.totalRowsExact ?? true);
  if (tab.totalRowsExact === true && nextExact === false) {
    return {
      totalRows: coerceNonNegativeInteger(tab.totalRows, 0),
      totalRowsExact: true,
    };
  }
  return {
    totalRows: coerceNonNegativeInteger(pageData.totalRows, coerceNonNegativeInteger(tab.totalRows, 0)),
    totalRowsExact: nextExact,
  };
}

export function replaceTabPage(state, tabId, pageData = {}) {
  const tab = state?.tabs?.find((item) => item.id === tabId);
  if (!tab) return null;
  tab.sessionId = String(pageData.sessionId ?? tab.sessionId ?? "");
  tab.columns = Array.isArray(pageData.columns) ? pageData.columns : [];
  tab.rows = Array.isArray(pageData.rows) ? pageData.rows : [];
  const primaryKeysChanged = replacePrimaryKeysFromPage(tab, pageData);
  tab.totalRows = coerceNonNegativeInteger(pageData.totalRows, 0);
  tab.totalRowsExact = normalizeTotalRowsExact(pageData, tab.totalRowsExact ?? true);
  tab.totalRowsLoading = false;
  tab.totalRowsError = "";
  tab.page = coercePositiveInteger(pageData.page, 1);
  tab.pageSize = coercePositiveInteger(pageData.pageSize, DEFAULT_PAGE_SIZE);
  tab.hasMore = normalizeHasMore(pageData, {
    rows: tab.rows,
    pageSize: tab.pageSize,
    totalRows: tab.totalRows,
    totalRowsExact: tab.totalRowsExact,
  });
  bumpRowKeyCacheVersion(tab);
  if (primaryKeysChanged) bumpRowKeyCacheVersion(tab);
  tab.loading = false;
  tab.loadingMore = false;
  updateFullyLoaded(tab);
  return tab;
}

export function updateTabTotalMetadata(state, tabId, pageData = {}) {
  const tab = state?.tabs?.find((item) => item.id === tabId);
  if (!tab) return null;
  tab.totalRows = coerceNonNegativeInteger(pageData.totalRows, coerceNonNegativeInteger(tab.totalRows, 0));
  tab.totalRowsExact = normalizeTotalRowsExact(pageData, tab.totalRowsExact ?? true);
  tab.hasMore = normalizeHasMore(pageData, {
    rows: Array.isArray(tab.rows) ? tab.rows : [],
    pageSize: coercePositiveInteger(tab.pageSize, DEFAULT_PAGE_SIZE),
    totalRows: tab.totalRows,
    totalRowsExact: tab.totalRowsExact,
    fallback: tab.hasMore,
  });
  tab.totalRowsLoading = false;
  tab.totalRowsError = "";
  updateFullyLoaded(tab);
  return tab;
}

export function appendTabPage(state, tabId, pageData = {}) {
  const tab = state?.tabs?.find((item) => item.id === tabId);
  if (!tab) return null;
  tab.sessionId = String(pageData.sessionId ?? tab.sessionId ?? "");
  if (Array.isArray(pageData.columns) && pageData.columns.length > 0) {
    tab.columns = pageData.columns;
  }
  const primaryKeysChanged = replacePrimaryKeysFromPage(tab, pageData);
  const receivedRows = Array.isArray(pageData.rows) ? pageData.rows : [];
  if (receivedRows.length > 0) {
    tab.rows = [...(Array.isArray(tab.rows) ? tab.rows : []), ...receivedRows];
    bumpRowKeyCacheVersion(tab);
  }
  if (primaryKeysChanged) bumpRowKeyCacheVersion(tab);
  const mergedTotal = mergeAppendedTotalRows(tab, pageData);
  tab.totalRows = mergedTotal.totalRows;
  tab.totalRowsExact = mergedTotal.totalRowsExact;
  tab.page = coercePositiveInteger(pageData.page, coercePositiveInteger(tab.page, 1));
  tab.pageSize = coercePositiveInteger(pageData.pageSize, coercePositiveInteger(tab.pageSize, DEFAULT_PAGE_SIZE));
  tab.hasMore = normalizeHasMore(pageData, {
    rows: receivedRows,
    pageSize: tab.pageSize,
    totalRows: tab.totalRows,
    totalRowsExact: tab.totalRowsExact,
    fallback: tab.hasMore,
  });
  tab.loadingMore = false;
  updateFullyLoaded(tab);
  if (Array.isArray(pageData.rows) && receivedRows.length === 0) {
    tab.fullyLoaded = true;
  }
  return tab;
}

function schemaMatch(baseRank, kind, match) {
  if (!match?.matched) return null;
  return {
    kind,
    rank: baseRank + match.rank,
    score: match.score || 0,
  };
}

function tableMatchMeta(table, query) {
  const names = [table?.tableName, table?.table_name].map(normalizeText).filter(Boolean);
  const comments = [table?.tableComment, table?.table_comment].map(normalizeText).filter(Boolean);
  const nameMatch = bestTextMatch(names, query);
  if (nameMatch.matched) return schemaMatch(SCHEMA_MATCH_RANK.tableName, "tableName", nameMatch);
  const commentMatch = bestTextMatch(comments, query);
  if (commentMatch.matched) return schemaMatch(SCHEMA_MATCH_RANK.tableComment, "tableComment", commentMatch);
  return null;
}

function columnMatchMeta(column, query) {
  const names = [column?.column_name, column?.columnName].map(normalizeText).filter(Boolean);
  const comments = [column?.column_comment, column?.columnComment].map(normalizeText).filter(Boolean);
  const nameMatch = bestTextMatch(names, query);
  if (nameMatch.matched) return schemaMatch(SCHEMA_MATCH_RANK.columnName, "columnName", nameMatch);
  const commentMatch = bestTextMatch(comments, query);
  if (commentMatch.matched) return schemaMatch(SCHEMA_MATCH_RANK.columnComment, "columnComment", commentMatch);
  return null;
}

function bestTextMatch(values, query) {
  return values
    .map((value) => matchSearchText(value, query))
    .sort(compareSearchMatches)[0] || matchSearchText("", "");
}

function cloneTableWithColumns(table, columns) {
  return { ...table, columns: Array.isArray(columns) ? [...columns] : [] };
}

function schemaResultKey(table) {
  return tableKey(table?.connectionId ?? table?.connection_id, table?.database, table?.tableName ?? table?.table_name);
}

export function buildSchemaSearchResults(schema = [], query = "") {
  const needle = normalizeText(query);
  const list = Array.isArray(schema) ? schema : [];
  if (!needle) {
    return list.map((table, index) => ({
      key: schemaResultKey(table),
      rank: index,
      index,
      matchKind: "none",
      table: cloneTableWithColumns(table, table?.columns),
      matchedColumns: [],
      visibleColumns: [],
      hiddenColumnCount: 0,
    }));
  }
  return list
    .map((table, index) => {
      const columns = Array.isArray(table.columns) ? table.columns : [];
      const tableMatch = tableMatchMeta(table, needle);
      if (tableMatch) {
        return {
          key: schemaResultKey(table),
          rank: tableMatch.rank,
          score: tableMatch.score,
          index,
          matchKind: tableMatch.kind,
          table: cloneTableWithColumns(table, columns),
          matchedColumns: [],
          visibleColumns: [],
          hiddenColumnCount: 0,
        };
      }
      const matched = columns
        .map((column) => ({ ...columnMatchMeta(column, needle), column }))
        .filter((match) => Number.isFinite(match.rank))
        .sort((left, right) => left.rank - right.rank || left.score - right.score);
      if (matched.length === 0) return null;
      const matchedColumns = matched.map((match) => ({
        ...match.column,
        searchMatchKind: match.kind,
        searchMatchRank: match.rank,
        searchMatchScore: match.score,
      }));
      const visibleColumns = matchedColumns.slice(0, COLUMN_PREVIEW_LIMIT);
      const bestMatch = matched[0];
      return {
        key: schemaResultKey(table),
        rank: bestMatch.rank,
        score: bestMatch.score,
        index,
        matchKind: bestMatch.kind,
        table: cloneTableWithColumns(table, matchedColumns),
        matchedColumns,
        visibleColumns,
        hiddenColumnCount: matchedColumns.length - visibleColumns.length,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.rank - right.rank || left.score - right.score || left.index - right.index);
}

export function filterSchemaTree(schema = [], query = "") {
  return buildSchemaSearchResults(schema, query).map((result) => result.table);
}
