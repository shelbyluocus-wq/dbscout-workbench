const DEFAULT_PAGE_SIZE = 100;
const COLUMN_PREVIEW_LIMIT = 3;

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function tableKey(connectionId, database, tableName) {
  return [connectionId, database, tableName].map((value) => String(value ?? "").trim()).join("\u001f");
}

function createEmptyTab({ id, connectionId = "", database = "", tableName, tableComment = "" }) {
  return {
    id,
    connectionId,
    database,
    tableName,
    tableKey: tableKey(connectionId, database, tableName),
    tableComment,
    sessionId: "",
    columns: [],
    rows: [],
    totalRows: 0,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    loading: false,
    loadingMore: false,
    fullyLoaded: false,
    filter: "",
    filterMode: "fuzzy",
    sort: null,
    selectedRowKeys: new Set(),
  };
}

export function createWorkspaceState({ connectionId = "", database = "" } = {}) {
  return {
    connectionId,
    database,
    connectionStatus: "disconnected",
    databases: [],
    tables: [],
    schema: [],
    tabs: [],
    activeTabId: "",
    nextTabSeq: 1,
    dataSearchResults: [],
    dataSearchLoading: false,
  };
}

export function openTableTab(
  state,
  {
    connectionId = state?.connectionId || "",
    database = state?.database || "",
    tableName = "",
    tableComment = "",
  } = {},
  { activate = true } = {},
) {
  const safeName = String(tableName || "").trim();
  if (!state || !safeName) return null;
  const safeConnectionId = String(connectionId || "").trim();
  const safeDatabase = String(database || "").trim();
  const sourceKey = tableKey(safeConnectionId, safeDatabase, safeName);
  const existing = state.tabs.find((tab) => tab.tableKey === sourceKey);
  if (existing) {
    if (activate) state.activeTabId = existing.id;
    return existing;
  }
  const tab = createEmptyTab({
    id: `tab-${state.nextTabSeq++}`,
    connectionId: safeConnectionId,
    database: safeDatabase,
    tableName: safeName,
    tableComment,
  });
  state.tabs.push(tab);
  if (activate) state.activeTabId = tab.id;
  return tab;
}

export function activateTableTab(state, tabId) {
  if (!state || !tabId) return null;
  const tab = state.tabs.find((item) => item.id === tabId);
  if (!tab) return null;
  state.activeTabId = tab.id;
  return tab;
}

export function closeTableTab(state, tabId) {
  if (!state || !tabId) return null;
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return null;
  const [closed] = state.tabs.splice(index, 1);
  if (state.activeTabId === tabId) {
    const next = state.tabs[index] || state.tabs[index - 1] || null;
    state.activeTabId = next?.id || "";
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
  return source;
}

export function closeAllTableTabs(state) {
  if (!state) return;
  state.tabs.splice(0, state.tabs.length);
  state.activeTabId = "";
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
  tab.fullyLoaded = tab.rows.length >= tab.totalRows;
}

export function replaceTabPage(state, tabId, pageData = {}) {
  const tab = state?.tabs?.find((item) => item.id === tabId);
  if (!tab) return null;
  tab.sessionId = String(pageData.sessionId ?? tab.sessionId ?? "");
  tab.columns = Array.isArray(pageData.columns) ? pageData.columns : [];
  tab.rows = Array.isArray(pageData.rows) ? pageData.rows : [];
  tab.totalRows = coerceNonNegativeInteger(pageData.totalRows, 0);
  tab.page = coercePositiveInteger(pageData.page, 1);
  tab.pageSize = coercePositiveInteger(pageData.pageSize, DEFAULT_PAGE_SIZE);
  tab.loading = false;
  tab.loadingMore = false;
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
  const receivedRows = Array.isArray(pageData.rows) ? pageData.rows : [];
  if (receivedRows.length > 0) {
    tab.rows = [...(Array.isArray(tab.rows) ? tab.rows : []), ...receivedRows];
  }
  tab.totalRows = coerceNonNegativeInteger(pageData.totalRows, coerceNonNegativeInteger(tab.totalRows, 0));
  tab.page = coercePositiveInteger(pageData.page, coercePositiveInteger(tab.page, 1));
  tab.pageSize = coercePositiveInteger(pageData.pageSize, coercePositiveInteger(tab.pageSize, DEFAULT_PAGE_SIZE));
  tab.loadingMore = false;
  updateFullyLoaded(tab);
  if (Array.isArray(pageData.rows) && receivedRows.length === 0) {
    tab.fullyLoaded = true;
  }
  return tab;
}

function tableMatchRank(table, query) {
  const names = [table?.tableName, table?.table_name].map(normalizeText).filter(Boolean);
  const comments = [table?.tableComment, table?.table_comment].map(normalizeText).filter(Boolean);
  if (names.some((item) => item === query)) return 0;
  if (names.some((item) => item.startsWith(query))) return 1;
  if (names.some((item) => item.includes(query))) return 2;
  if (comments.some((item) => item.includes(query))) return 6;
  return Number.POSITIVE_INFINITY;
}

function columnMatchRank(column, query) {
  const names = [column?.column_name, column?.columnName].map(normalizeText).filter(Boolean);
  const comments = [column?.column_comment, column?.columnComment].map(normalizeText).filter(Boolean);
  if (names.some((item) => item === query)) return 3;
  if (names.some((item) => item.startsWith(query))) return 4;
  if (names.some((item) => item.includes(query))) return 5;
  if (comments.some((item) => item.includes(query))) return 7;
  return Number.POSITIVE_INFINITY;
}

function columnMatchKind(column, query) {
  const rank = columnMatchRank(column, query);
  if (rank >= 3 && rank <= 5) return "columnName";
  if (rank === 7) return "columnComment";
  return "";
}

function tableMatchKind(table, query) {
  const rank = tableMatchRank(table, query);
  if (rank >= 0 && rank <= 2) return "tableName";
  if (rank === 6) return "tableComment";
  return "";
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
      const tableRank = tableMatchRank(table, needle);
      if (Number.isFinite(tableRank)) {
        return {
          key: schemaResultKey(table),
          rank: tableRank,
          index,
          matchKind: tableMatchKind(table, needle),
          table: cloneTableWithColumns(table, columns),
          matchedColumns: [],
          visibleColumns: [],
          hiddenColumnCount: 0,
        };
      }
      const matched = columns
        .map((column) => ({ rank: columnMatchRank(column, needle), column }))
        .filter((match) => Number.isFinite(match.rank));
      if (matched.length === 0) return null;
      const matchedColumns = matched.map((match) => match.column);
      const visibleColumns = matchedColumns.slice(0, COLUMN_PREVIEW_LIMIT);
      const rank = Math.min(...matched.map((match) => match.rank));
      return {
        key: schemaResultKey(table),
        rank,
        index,
        matchKind: columnMatchKind(matched.find((match) => match.rank === rank)?.column, needle),
        table: cloneTableWithColumns(table, matchedColumns),
        matchedColumns,
        visibleColumns,
        hiddenColumnCount: matchedColumns.length - visibleColumns.length,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
}

export function filterSchemaTree(schema = [], query = "") {
  return buildSchemaSearchResults(schema, query).map((result) => result.table);
}
