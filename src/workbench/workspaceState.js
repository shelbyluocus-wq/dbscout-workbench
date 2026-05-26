const DEFAULT_PAGE_SIZE = 100;

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
) {
  const safeName = String(tableName || "").trim();
  if (!state || !safeName) return null;
  const safeConnectionId = String(connectionId || "").trim();
  const safeDatabase = String(database || "").trim();
  const sourceKey = tableKey(safeConnectionId, safeDatabase, safeName);
  const existing = state.tabs.find((tab) => tab.tableKey === sourceKey);
  if (existing) {
    state.activeTabId = existing.id;
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

export function getActiveTab(state) {
  if (!state?.activeTabId) return null;
  return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
}

export function replaceTabPage(state, tabId, pageData = {}) {
  const tab = state?.tabs?.find((item) => item.id === tabId);
  if (!tab) return null;
  tab.sessionId = String(pageData.sessionId ?? tab.sessionId ?? "");
  tab.columns = Array.isArray(pageData.columns) ? pageData.columns : [];
  tab.rows = Array.isArray(pageData.rows) ? pageData.rows : [];
  tab.totalRows = Math.max(0, Math.floor(Number(pageData.totalRows) || 0));
  tab.page = Math.max(1, Math.floor(Number(pageData.page) || 1));
  tab.pageSize = Math.max(1, Math.floor(Number(pageData.pageSize) || DEFAULT_PAGE_SIZE));
  tab.loading = false;
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

export function filterSchemaTree(schema = [], query = "") {
  const needle = normalizeText(query);
  const list = Array.isArray(schema) ? schema : [];
  if (!needle) {
    return list.map((table) => ({ ...table, columns: Array.isArray(table.columns) ? [...table.columns] : [] }));
  }
  return list
    .map((table, index) => {
      const columns = Array.isArray(table.columns) ? table.columns : [];
      const rank = tableMatchRank(table, needle);
      if (Number.isFinite(rank)) return { rank, index, table: { ...table, columns: [...columns] } };
      const matched = columns
        .map((column) => ({ rank: columnMatchRank(column, needle), column }))
        .filter((match) => Number.isFinite(match.rank));
      if (matched.length === 0) return null;
      return {
        rank: Math.min(...matched.map((match) => match.rank)),
        index,
        table: { ...table, columns: matched.map((match) => match.column) },
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((match) => match.table);
}
