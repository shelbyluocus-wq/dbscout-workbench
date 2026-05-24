const DEFAULT_PAGE_SIZE = 100;

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function createEmptyTab({ id, tableName, tableComment = "" }) {
  return {
    id,
    tableName,
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

export function createWorkspaceState({ database = "" } = {}) {
  return {
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

export function openTableTab(state, { tableName = "", tableComment = "" } = {}) {
  const safeName = String(tableName || "").trim();
  if (!state || !safeName) return null;
  const existing = state.tabs.find((tab) => tab.tableName === safeName);
  if (existing) {
    state.activeTabId = existing.id;
    return existing;
  }
  const tab = createEmptyTab({
    id: `tab-${state.nextTabSeq++}`,
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

function tableMatches(table, query) {
  const haystack = [
    table?.tableName,
    table?.table_name,
    table?.tableComment,
    table?.table_comment,
  ].map(normalizeText);
  return haystack.some((item) => item.includes(query));
}

function columnMatches(column, query) {
  const haystack = [
    column?.column_name,
    column?.columnName,
    column?.column_comment,
    column?.columnComment,
  ].map(normalizeText);
  return haystack.some((item) => item.includes(query));
}

export function filterSchemaTree(schema = [], query = "") {
  const needle = normalizeText(query);
  const list = Array.isArray(schema) ? schema : [];
  if (!needle) {
    return list.map((table) => ({ ...table, columns: Array.isArray(table.columns) ? [...table.columns] : [] }));
  }
  return list
    .map((table) => {
      const columns = Array.isArray(table.columns) ? table.columns : [];
      if (tableMatches(table, needle)) {
        return { ...table, columns: [...columns] };
      }
      const matchedColumns = columns.filter((column) => columnMatches(column, needle));
      return matchedColumns.length > 0 ? { ...table, columns: matchedColumns } : null;
    })
    .filter(Boolean);
}
