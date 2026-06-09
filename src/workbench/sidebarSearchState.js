export function createSidebarSearchState() {
  return {
    query: "",
    selectedIndex: 0,
    valueLoading: false,
    valueError: "",
    valueResults: [],
    valueSearchedQuery: "",
    valueSearchToken: 0,
    selectionTouched: false,
  };
}

export function normalizeSidebarSearchQuery(value) {
  return String(value ?? "").trim();
}

export function clearValueSearchResults(state) {
  state.valueLoading = false;
  state.valueError = "";
  state.valueResults = [];
  state.valueSearchedQuery = "";
}

export function setSidebarSearchQuery(state, query) {
  const nextQuery = String(query ?? "");
  const changed = state.query !== nextQuery;

  state.query = nextQuery;
  state.selectedIndex = 0;
  state.selectionTouched = false;

  if (changed) {
    state.valueSearchToken += 1;
    clearValueSearchResults(state);
  }
}

export function beginValueSearch(state, query) {
  const normalizedQuery = normalizeSidebarSearchQuery(query);
  const token = state.valueSearchToken + 1;

  state.valueSearchToken = token;
  state.query = String(query ?? "");
  state.valueLoading = normalizedQuery !== "";
  state.valueError = "";
  state.valueResults = [];
  state.valueSearchedQuery = "";
  state.selectionTouched = false;

  return token;
}

export function finishValueSearch(state, query, results, token = state.valueSearchToken) {
  if (
    token !== state.valueSearchToken ||
    normalizeSidebarSearchQuery(query) !== normalizeSidebarSearchQuery(state.query)
  ) {
    return false;
  }

  state.valueLoading = false;
  state.valueError = "";
  state.valueResults = Array.isArray(results) ? results : [];
  state.valueSearchedQuery = normalizeSidebarSearchQuery(query);
  state.selectedIndex = 0;
  state.selectionTouched = false;

  return true;
}

export function failValueSearch(state, query, error, token = state.valueSearchToken) {
  if (
    token !== state.valueSearchToken ||
    normalizeSidebarSearchQuery(query) !== normalizeSidebarSearchQuery(state.query)
  ) {
    return false;
  }

  state.valueLoading = false;
  state.valueError = String(error ?? "");
  state.valueResults = [];
  state.valueSearchedQuery = normalizeSidebarSearchQuery(query);
  state.selectedIndex = 0;
  state.selectionTouched = false;

  return true;
}

export function sidebarValueResultsAreFresh(state) {
  const normalizedQuery = normalizeSidebarSearchQuery(state.query);
  return normalizedQuery !== "" && normalizedQuery === state.valueSearchedQuery;
}

export function buildVisibleSidebarSearchItems(schemaResults = [], valueResults = []) {
  const schemaItems = schemaResults.map((result, index) => ({
    key: result?.key ?? `schema:${index}`,
    kind: "schema",
    result,
  }));
  const valueItems = valueResults.map((result, index) => ({
    key: result?.key ?? `value:${result?.tableName ?? ""}:${result?.columnName ?? ""}:${index}`,
    kind: "value",
    result,
  }));

  return [...schemaItems, ...valueItems];
}

export function clampSidebarSearchSelection(state, items) {
  if (!items.length) {
    state.selectedIndex = -1;
    state.selectionTouched = false;
    return;
  }

  if (state.selectedIndex < 0) {
    state.selectedIndex = 0;
    return;
  }

  if (state.selectedIndex >= items.length) {
    state.selectedIndex = items.length - 1;
  }
}

export function moveSidebarSearchSelection(state, items, delta) {
  if (!items.length) {
    state.selectedIndex = -1;
    return;
  }

  const currentIndex =
    state.selectedIndex >= 0 && state.selectedIndex < items.length ? state.selectedIndex : 0;
  state.selectedIndex = (currentIndex + delta + items.length) % items.length;
  state.selectionTouched = true;
}
