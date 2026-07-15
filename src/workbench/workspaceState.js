import { compareSearchMatches, matchSearchText } from "./utils/searchMatch.js";
import { matchTableSearch } from "./utils/tableSearch.js";
import { GRID_FIELD_COMMENT_HEIGHT, GRID_ROW_HEIGHT } from "./constants.js";
import {
  appendTabRows,
  ensureTabRowStore,
  invalidateTabRows,
  replaceTabRows,
  tabRowCount,
  tabRows,
} from "./rowStore.js";

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

function databaseKey(connectionId, database) {
  return [connectionId, database].map((value) => String(value ?? "").trim()).join("\u001f");
}

function normalizeTabKind(kind) {
  return kind === "design" || kind === "home" || kind === "sql" || kind === "sql-library" ? kind : "data";
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
  const tab = {
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
    hitResultMode: false,
    hitResultSourceTabId: "",
    hitResultSourcePaneId: "",
    searchResultMode: false,
    searchResultQuery: "",
    searchResultJobId: "",
    searchResultMatches: [],
    searchResultRowKeys: [],
    searchResultComplete: true,
    searchResultDroppedRows: 0,
    searchResultScannedRows: 0,
    normalViewState: null,
    searchRowStore: null,
    sort: null,
    // The visible frozen-row window ends at the chosen Excel pane boundary;
    // columns stay left-anchored. Persisted with the tab across restores.
    frozenRowStart: 0,
    frozenRowCount: 0,
    frozenColumnCount: 0,
    fieldCommentsExpanded: true,
    rowHeight: GRID_ROW_HEIGHT,
    fieldCommentHeight: GRID_FIELD_COMMENT_HEIGHT,
    selectedRowKeys: new Set(),
    schemaSearchQuery: "",
    schemaSearchMatches: [],
    schemaSearchIndex: -1,
  };
  ensureTabRowStore(tab);
  return tab;
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
    nextSqlSeq: 1,
  };
}

function createSqlTab({ id, sequence, connectionId = "", database = "", readOnly = false, values = {} }) {
  const sql = String(values.sql || "");
  const savedSql = String(values.savedSql ?? (values.filePath ? sql : ""));
  return {
    id,
    kind: "sql",
    connectionId: String(connectionId || ""),
    database: String(database || ""),
    tableName: "",
    tableKey: "",
    tabKey: `sql\u001f${id}`,
    documentId: String(values.documentId || ""),
    title: String(values.title || values.fileName || `查询 ${sequence}`),
    sql,
    savedSql,
    dirty: values.dirty == null ? sql !== savedSql : Boolean(values.dirty),
    filePath: String(values.filePath || ""),
    fileName: String(values.fileName || ""),
    limit: [100, 500, 1000, 5000, 10000].includes(Number(values.limit)) ? Number(values.limit) : 1000,
    timeoutSeconds: Math.max(1, Math.min(600, Number(values.timeoutSeconds) || 60)),
    autoCommit: values.autoCommit !== false,
    editorRatio: Math.max(0.25, Math.min(0.8, Number(values.editorRatio) || 0.55)),
    readOnly: Boolean(readOnly),
    transactionSessionId: "",
    transactionState: "idle",
    running: false,
    jobId: "",
    executionId: "",
    resultSets: [],
    messages: [],
    executionPlan: null,
    activeResultIndex: 0,
    resultView: "results",
  };
}

export function openSqlQueryTab(
  state,
  {
    connectionId = state?.connectionId || "",
    database = state?.database || "",
    readOnly = false,
    ...values
  } = {},
  { activate = true, paneId = "" } = {},
) {
  if (!state) return null;
  const pane = ensurePane(state, paneId);
  const sequence = Math.max(1, Number(state.nextSqlSeq) || 1);
  state.nextSqlSeq = sequence + 1;
  const tab = createSqlTab({
    id: `tab-${state.nextTabSeq++}`,
    sequence,
    connectionId,
    database,
    readOnly,
    values,
  });
  state.tabs.push(tab);
  addTabToPane(state, pane.id, tab.id, { activate });
  return tab;
}

function createSqlLibraryTab({ id }) {
  return {
    id,
    kind: "sql-library",
    connectionId: "",
    database: "",
    tableName: "",
    tableKey: "",
    tabKey: "sql-library",
    title: "SQL 查询",
  };
}

export function openSqlLibraryTab(state, { activate = true, paneId = "" } = {}) {
  if (!state) return null;
  const pane = ensurePane(state, paneId);
  const existing = state.tabs.find((tab) => tab.kind === "sql-library" && pane.tabIds.includes(tab.id));
  if (existing) {
    if (activate) addTabToPane(state, pane.id, existing.id, { activate: true });
    return existing;
  }
  const tab = createSqlLibraryTab({ id: `tab-${state.nextTabSeq++}` });
  state.tabs.push(tab);
  addTabToPane(state, pane.id, tab.id, { activate });
  return tab;
}

function createHomeTab({ id, connectionId = "", database = "", readOnly = false }) {
  const sourceKey = databaseKey(connectionId, database);
  const safeDatabase = String(database || "").trim();
  return {
    id,
    kind: "home",
    connectionId,
    database: safeDatabase,
    databaseKey: sourceKey,
    tableName: "",
    tableKey: "",
    tabKey: tabKey("home", sourceKey),
    title: "首页",
    query: "",
    sortMode: "nameAsc",
    selectedTableNames: [],
    focusedTableName: "",
    focusedTableComment: "",
    clipboardFeedback: "",
    loading: false,
    error: "",
    statusText: "",
    readOnly: Boolean(readOnly),
  };
}

function isPinnedTab(tab) {
  return normalizeTabKind(tab?.kind) === "home";
}

function isHomeTab(tab) {
  return normalizeTabKind(tab?.kind) === "home";
}

export function normalizeHomeTabOrder(state) {
  if (!state?.tabs?.length) return null;
  const homes = state.tabs.filter(isHomeTab);
  if (!homes.length) return null;
  state.tabs.splice(0, state.tabs.length, ...homes, ...state.tabs.filter((tab) => !isHomeTab(tab)));
  Object.values(state.panes || {}).forEach((pane) => {
    const paneHomeIndex = pane.tabIds?.findIndex((tabId) => homes.some((home) => home.id === tabId)) ?? -1;
    if (paneHomeIndex <= 0) return;
    const [homeId] = pane.tabIds.splice(paneHomeIndex, 1);
    pane.tabIds.unshift(homeId);
  });
  return homes[0];
}

function activeTabIdForPane(pane, tabs) {
  const ids = new Set(pane?.tabIds || []);
  if (!ids.size) return "";
  if (pane.activeTabId && ids.has(pane.activeTabId)) return pane.activeTabId;
  return tabs.find((tab) => ids.has(tab.id))?.id || "";
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

function updateHomeTab(tab, { connectionId, database, sourceKey, homeTabKey, readOnly }) {
  const previousSourceKey = tab.databaseKey || databaseKey(tab.connectionId, tab.database);
  const sourceChanged = previousSourceKey !== sourceKey;
  tab.kind = "home";
  tab.connectionId = connectionId;
  tab.database = database;
  tab.databaseKey = sourceKey;
  tab.tableName = "";
  tab.tableKey = "";
  tab.tabKey = homeTabKey;
  tab.readOnly = Boolean(readOnly);
  tab.title = "首页";
  if (sourceChanged) {
    tab.query = "";
    tab.sortMode = "nameAsc";
    tab.selectedTableNames = [];
    tab.focusedTableName = "";
    tab.focusedTableComment = "";
    tab.clipboardFeedback = "";
    tab.loading = false;
    tab.error = "";
    tab.statusText = "";
  } else {
    if (!Array.isArray(tab.selectedTableNames)) tab.selectedTableNames = [];
    if (!tab.sortMode) tab.sortMode = "nameAsc";
  }
  return tab;
}

function attachTabToOnlyPane(state, pane, tabId, { activate = true } = {}) {
  const ownerPane = paneForTab(state, tabId);
  const targetPane = activate || !ownerPane ? pane : ownerPane;
  Object.values(state.panes || {}).forEach((currentPane) => {
    const originalActiveTabId = currentPane.activeTabId;
    currentPane.tabIds = currentPane.tabIds.filter((id) => id !== tabId);
    if (currentPane.id !== targetPane.id && originalActiveTabId === tabId) {
      currentPane.activeTabId = activeTabIdForPane(currentPane, state.tabs);
    }
  });
  targetPane.tabIds.push(tabId);
  if (activate) {
    targetPane.activeTabId = tabId;
    state.focusedPaneId = targetPane.id;
    state.activeTabId = tabId;
  } else if (!targetPane.activeTabId || !targetPane.tabIds.includes(targetPane.activeTabId)) {
    targetPane.activeTabId = activeTabIdForPane(targetPane, state.tabs);
  }
  normalizeHomeTabOrder(state);
}

function findPaneHomeTab(state, pane) {
  return state.tabs.find((tab) => isHomeTab(tab) && pane.tabIds.includes(tab.id)) || null;
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
    hitResultMode = false,
    searchQuery = "",
    filter = "",
    filterMode = "fuzzy",
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
  const requestedHitResultMode = Boolean(hitResultMode);
  const requestedSearchQuery = String(searchQuery || filter || "").trim();
  const requestedFilterMode = String(filterMode || "fuzzy");
  const existing = state.tabs.find((tab) => {
    const kind = normalizeTabKind(tab.kind);
    if (kind !== "data") return false;
    const source = tab.tableKey || tableKey(tab.connectionId, tab.database, tab.tableName);
    ensureTabIdentity(tab, kind, source);
    if (tab.tabKey !== dataTabKey || !pane.tabIds.includes(tab.id)) return false;
    if (Boolean(tab.hitResultMode) !== requestedHitResultMode) return false;
    if (!requestedHitResultMode) return true;
    const tabSearchQuery = String(tab.searchQuery || tab.filter || "").trim();
    const tabFilterMode = String(tab.filterMode || "fuzzy");
    return tabSearchQuery === requestedSearchQuery && tabFilterMode === requestedFilterMode;
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
    if (kind !== "design") return false;
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

export function openDatabaseHomeTab(
  state,
  {
    connectionId = state?.connectionId || "",
    database = state?.database || "",
    readOnly = false,
  } = {},
  { activate = true, paneId = "" } = {},
) {
  if (!state) return null;
  const safeConnectionId = String(connectionId || "").trim();
  const safeDatabase = String(database || "").trim();
  if (!safeDatabase) return null;
  const sourceKey = databaseKey(safeConnectionId, safeDatabase);
  const homeTabKey = tabKey("home", sourceKey);
  const pane = ensurePane(state, paneId);
  const existing = findPaneHomeTab(state, pane);
  if (existing) {
    updateHomeTab(existing, {
      connectionId: safeConnectionId,
      database: safeDatabase,
      sourceKey,
      homeTabKey,
      readOnly,
    });
    addTabToPane(state, pane.id, existing.id, { activate });
    normalizeHomeTabOrder(state);
    return existing;
  }
  const tab = createHomeTab({
    id: `tab-${state.nextTabSeq++}`,
    connectionId: safeConnectionId,
    database: safeDatabase,
    readOnly,
  });
  state.tabs.push(tab);
  addTabToPane(state, pane.id, tab.id, { activate });
  normalizeHomeTabOrder(state);
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

function rowIdentityShape(tab) {
  const primaryKeys = Array.isArray(tab?.primaryKeys) ? tab.primaryKeys.filter(Boolean) : [];
  const identityColumns = primaryKeys.length > 0
    ? primaryKeys
    : (Array.isArray(tab?.columns) ? tab.columns.map(schemaColumnName).filter(Boolean) : []);
  return identityColumns.join("\u001f");
}

export function applyTableSchemaToDataTab(tab, schema = {}) {
  if (!tab || !schema) return tab || null;
  const previousIdentityShape = rowIdentityShape(tab);
  if (Array.isArray(schema.columns)) {
    const previousColumns = Array.isArray(tab.columns) ? tab.columns : [];
    const renames = columnRenameMap(previousColumns, schema.columns);
    migrateSortColumn(tab, renames, schema.columns);
    migrateRowColumnKeys(tabRows(tab), renames);
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
  if (rowIdentityShape(tab) !== previousIdentityShape) invalidateTabRows(tab);
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
  replaceTabRows(tab, []);
  tab.totalRows = 0;
  tab.totalRowsExact = true;
  tab.totalRowsLoading = false;
  tab.totalRowsError = "";
  tab.hasMore = false;
  tab.page = 1;
  tab.loading = false;
  tab.loadingMore = false;
  tab.fullyLoaded = true;
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
    if (kind !== "data") return false;
    const tabSource = tab.tableKey || tableKey(tab.connectionId, tab.database, tab.tableName);
    ensureTabIdentity(tab, kind, tabSource);
    return tab.tableKey === sourceKey;
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

export function closePaneTab(state, paneId, tabId, { focusOwner = true } = {}) {
  if (!state || !tabId) return null;
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return null;
  if (isPinnedTab(state.tabs[index])) return null;
  const ownerPane = state.panes?.[paneId] || paneForTab(state, tabId);
  const [closed] = state.tabs.splice(index, 1);
  removeTabFromPane(state, ownerPane, tabId);
  if (ownerPane && focusOwner) {
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
  normalizeHomeTabOrder(state);
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
  normalizeHomeTabOrder(state);
  return state.tabs.find((tab) => tab.id === tabId) || null;
}

export function closeAllTableTabs(state) {
  if (!state) return;
  state.tabs = state.tabs.filter(isPinnedTab);
  ensurePaneState(state);
  const keptIds = new Set(state.tabs.map((tab) => tab.id));
  Object.values(state.panes || {}).forEach((pane) => {
    pane.tabIds = pane.tabIds.filter((tabId) => keptIds.has(tabId));
    pane.activeTabId = activeTabIdForPane(pane, state.tabs);
  });
  state.activeTabId = getFocusedPane(state)?.activeTabId || state.tabs[0]?.id || "";
}

export function closePaneTabs(state, paneId = "") {
  ensurePaneState(state);
  const pane = state?.panes?.[paneId || state.focusedPaneId];
  if (!pane?.tabIds?.length) return [];
  const pinnedIds = new Set(state.tabs.filter(isPinnedTab).map((tab) => tab.id));
  const closedIds = new Set(pane.tabIds.filter((tabId) => !pinnedIds.has(tabId)));
  const closed = state.tabs.filter((tab) => closedIds.has(tab.id));
  if (!closed.length) return [];

  state.tabs = state.tabs.filter((tab) => !closedIds.has(tab.id));
  pane.tabIds = pane.tabIds.filter((tabId) => !closedIds.has(tabId));
  pane.activeTabId = activeTabIdForPane(pane, state.tabs);
  state.focusedPaneId = pane.id;
  state.activeTabId = pane.activeTabId || "";
  return closed;
}

export function discardPaneHomeTabs(state, paneId = "") {
  ensurePaneState(state);
  const pane = state?.panes?.[paneId || state.focusedPaneId];
  if (!pane?.tabIds?.length) return [];
  const homeIds = new Set(
    pane.tabIds.filter((tabId) => state.tabs.find((tab) => tab.id === tabId)?.kind === "home"),
  );
  if (!homeIds.size) return [];
  const discarded = state.tabs.filter((tab) => homeIds.has(tab.id));
  state.tabs = state.tabs.filter((tab) => !homeIds.has(tab.id));
  pane.tabIds = pane.tabIds.filter((tabId) => !homeIds.has(tabId));
  pane.activeTabId = activeTabIdForPane(pane, state.tabs);
  if (state.focusedPaneId === pane.id) state.activeTabId = pane.activeTabId || "";
  return discarded;
}

export function closePaneTabsRelative(state, paneId = "", tabId = "", direction = "right") {
  ensurePaneState(state);
  const pane = state?.panes?.[paneId || state.focusedPaneId];
  if (!pane?.tabIds?.length || !tabId) return [];
  const contextIndex = pane.tabIds.indexOf(tabId);
  if (contextIndex < 0) return [];
  const candidateIds = direction === "left"
    ? pane.tabIds.slice(0, contextIndex)
    : pane.tabIds.slice(contextIndex + 1);
  const closableIds = new Set(candidateIds.filter((id) => {
    const tab = state.tabs.find((item) => item.id === id);
    return tab && !isPinnedTab(tab);
  }));
  if (!closableIds.size) return [];
  const closed = state.tabs.filter((tab) => closableIds.has(tab.id));
  state.tabs = state.tabs.filter((tab) => !closableIds.has(tab.id));
  pane.tabIds = pane.tabIds.filter((id) => !closableIds.has(id));
  pane.activeTabId = tabId;
  state.focusedPaneId = pane.id;
  state.activeTabId = tabId;
  normalizeHomeTabOrder(state);
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
    const isMatch = !isPinnedTab(tab) && String(tab.connectionId || "") === safeConnectionId && String(tab.database || "") === safeDatabase;
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

export function closeTableObjectTabs(state, { connectionId = "", database = "", tableNames = [] } = {}) {
  if (!state || !database || !Array.isArray(tableNames) || tableNames.length === 0) return [];
  const safeConnectionId = String(connectionId || "");
  const safeDatabase = String(database || "");
  const names = new Set(tableNames.map((name) => String(name || "").trim()).filter(Boolean));
  if (!names.size) return [];
  const closed = [];
  const remaining = [];
  let firstClosedIndex = -1;
  let activeWasClosed = false;

  state.tabs.forEach((tab, index) => {
    const kind = normalizeTabKind(tab.kind);
    const isMatch = kind !== "home"
      && String(tab.connectionId || "") === safeConnectionId
      && String(tab.database || "") === safeDatabase
      && names.has(String(tab.tableName || ""));
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
    const isMatch = !isPinnedTab(tab) && String(tab.connectionId || "") === safeConnectionId;
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
  tab.fullyLoaded = Boolean(tab.totalRowsExact) && tabRowCount(tab) >= tab.totalRows;
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
  replaceTabRows(tab, Array.isArray(pageData.rows) ? pageData.rows : []);
  const primaryKeysChanged = replacePrimaryKeysFromPage(tab, pageData);
  tab.totalRows = coerceNonNegativeInteger(pageData.totalRows, 0);
  tab.totalRowsExact = normalizeTotalRowsExact(pageData, tab.totalRowsExact ?? true);
  tab.totalRowsLoading = false;
  tab.totalRowsError = "";
  tab.page = coercePositiveInteger(pageData.page, 1);
  tab.pageSize = coercePositiveInteger(pageData.pageSize, DEFAULT_PAGE_SIZE);
  tab.hasMore = normalizeHasMore(pageData, {
    rows: tabRows(tab),
    pageSize: tab.pageSize,
    totalRows: tab.totalRows,
    totalRowsExact: tab.totalRowsExact,
  });
  if (primaryKeysChanged) invalidateTabRows(tab);
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
    rows: tabRows(tab),
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
    appendTabRows(tab, receivedRows);
  }
  if (primaryKeysChanged) invalidateTabRows(tab);
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
    textMatchKind: match.kind || "none",
    ranges: Array.isArray(match.ranges) ? match.ranges : [],
  };
}

function tableMatchMeta(table, query, mode = "fuzzy", includedKinds = null) {
  const match = matchTableSearch(table, query, { mode, includedKinds });
  return match.matched
    ? {
        kind: match.kind,
        rank: match.rank,
        score: match.score || 0,
        textMatchKind: match.textMatchKind || "none",
        ranges: Array.isArray(match.ranges) ? match.ranges : [],
      }
    : null;
}

function columnMatchMeta(column, query, mode = "fuzzy", includedKinds = null, matchCache = null) {
  const allowedKinds = includedKinds instanceof Set
    ? includedKinds
    : Array.isArray(includedKinds) && includedKinds.length
      ? new Set(includedKinds)
      : null;
  const names = [...new Set([column?.column_name, column?.columnName].map(normalizeText).filter(Boolean))];
  const comments = [...new Set([column?.column_comment, column?.columnComment].map(normalizeText).filter(Boolean))];
  const nameMatch = allowedKinds && !allowedKinds.has("columnName")
    ? matchSearchText("", "")
    : bestTextMatch(names, query, mode, matchCache);
  if (nameMatch.matched) return schemaMatch(SCHEMA_MATCH_RANK.columnName, "columnName", nameMatch);
  const commentMatch = allowedKinds && !allowedKinds.has("columnComment")
    ? matchSearchText("", "")
    : bestTextMatch(comments, query, mode, matchCache);
  if (commentMatch.matched) return schemaMatch(SCHEMA_MATCH_RANK.columnComment, "columnComment", commentMatch);
  return null;
}

function bestTextMatch(values, query, mode = "fuzzy", matchCache = null) {
  let best = null;
  for (const value of values) {
    let match = matchCache?.get(value);
    if (!match) {
      match = matchSearchText(value, query, { mode });
      matchCache?.set(value, match);
    }
    if (!best || compareSearchMatches(match, best) < 0) best = match;
  }
  return best || matchSearchText("", "");
}

function compareColumnMatches(left, right) {
  return left.rank - right.rank || left.score - right.score;
}

function columnMatchCacheKey(column) {
  return `${String(column?.column_name ?? "")}\u001f${String(column?.columnName ?? "")}\u001f${String(column?.column_comment ?? "")}\u001f${String(column?.columnComment ?? "")}`;
}

function collectColumnMatches(columns, needle, mode, allowedKinds, matchCache, columnMetaCache, limit) {
  const matches = [];
  let count = 0;
  const bounded = Number.isFinite(limit);
  const cacheColumnMeta = mode === "fuzzy";
  for (const column of columns) {
    let match;
    if (cacheColumnMeta) {
      const cacheKey = columnMatchCacheKey(column);
      match = columnMetaCache.get(cacheKey);
      if (!match) {
        match = columnMatchMeta(column, needle, mode, allowedKinds, matchCache);
        columnMetaCache.set(cacheKey, match);
      }
    } else {
      match = columnMatchMeta(column, needle, mode, allowedKinds, matchCache);
    }
    if (!Number.isFinite(match?.rank)) continue;
    count += 1;
    if (bounded) {
      const last = matches[matches.length - 1];
      if (matches.length >= limit && compareColumnMatches(match, last) >= 0) continue;
      const candidate = { ...match, column };
      const insertionIndex = matches.findIndex((existing) => compareColumnMatches(candidate, existing) < 0);
      if (insertionIndex < 0) matches.push(candidate);
      else matches.splice(insertionIndex, 0, candidate);
      if (matches.length > limit) matches.pop();
    } else {
      matches.push({ ...match, column });
    }
  }
  if (!bounded) matches.sort(compareColumnMatches);
  return { matches, count };
}

function cloneTableWithColumns(table, columns) {
  return { ...table, columns: Array.isArray(columns) ? [...columns] : [] };
}

function schemaResultKey(table) {
  return tableKey(table?.connectionId ?? table?.connection_id, table?.database, table?.tableName ?? table?.table_name);
}

export function buildSchemaSearchResults(
  schema = [],
  query = "",
  { mode = "fuzzy", includedKinds = null, matchedColumnLimit = Number.POSITIVE_INFINITY } = {},
) {
  const needle = normalizeText(query);
  const list = Array.isArray(schema) ? schema : [];
  const allowedKinds = Array.isArray(includedKinds) && includedKinds.length
    ? new Set(includedKinds)
    : null;
  const materializedColumnLimit = Number.isFinite(matchedColumnLimit)
    ? Math.max(COLUMN_PREVIEW_LIMIT, Math.floor(matchedColumnLimit))
    : Number.POSITIVE_INFINITY;
  const columnMatchCache = new Map();
  const columnMetaCache = new Map();
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
      const tableMatch = tableMatchMeta(table, needle, mode, includedKinds);
      if (tableMatch) {
        return {
          key: schemaResultKey(table),
          rank: tableMatch.rank,
          score: tableMatch.score,
          index,
          matchKind: tableMatch.kind,
          searchTextMatchKind: tableMatch.textMatchKind,
          searchMatchRanges: tableMatch.ranges,
          table: cloneTableWithColumns(table, columns),
          matchedColumns: [],
          visibleColumns: [],
          hiddenColumnCount: 0,
        };
      }
      const collected = collectColumnMatches(
        columns,
        needle,
        mode,
        allowedKinds,
        columnMatchCache,
        columnMetaCache,
        materializedColumnLimit,
      );
      if (collected.count === 0) return null;
      const matchedColumns = collected.matches.map((match) => ({
        ...match.column,
        searchMatchKind: match.kind,
        searchMatchRank: match.rank,
        searchMatchScore: match.score,
        searchTextMatchKind: match.textMatchKind,
        searchMatchRanges: match.ranges,
      }));
      const visibleColumns = matchedColumns.slice(0, COLUMN_PREVIEW_LIMIT);
      const bestMatch = collected.matches[0];
      return {
        key: schemaResultKey(table),
        rank: bestMatch.rank,
        score: bestMatch.score,
        index,
        matchKind: bestMatch.kind,
        table: cloneTableWithColumns(table, matchedColumns),
        matchedColumns,
        visibleColumns,
        hiddenColumnCount: collected.count - visibleColumns.length,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.rank - right.rank || left.score - right.score || left.index - right.index);
}

export function filterSchemaTree(schema = [], query = "") {
  return buildSchemaSearchResults(schema, query).map((result) => result.table);
}
