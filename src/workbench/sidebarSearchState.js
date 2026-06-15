export function createSidebarSearchState() {
  return {
    query: "",
    selectedIndex: 0,
    valueLoading: false,
    valueError: "",
    valueResults: [],
    valueSearchedQuery: "",
    valueSearchToken: 0,
    valueSearchJobId: "",
    valueProgress: createValueSearchProgress(),
    selectionTouched: false,
  };
}

export function createValueSearchProgress(overrides = {}) {
  return {
    jobId: "",
    done: 0,
    total: 0,
    matches: 0,
    currentTable: "",
    message: "",
    status: "idle",
    ...overrides,
  };
}

export function createValueSearchJobId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `value-search-${Date.now().toString(36)}-${random}`;
}

export function normalizeSidebarSearchQuery(value) {
  return String(value ?? "").trim();
}

export function clearValueSearchResults(state) {
  state.valueLoading = false;
  state.valueError = "";
  state.valueResults = [];
  state.valueSearchedQuery = "";
  state.valueSearchJobId = "";
  state.valueProgress = createValueSearchProgress();
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

export function beginValueSearch(state, query, jobId = createValueSearchJobId()) {
  const normalizedQuery = normalizeSidebarSearchQuery(query);
  const token = state.valueSearchToken + 1;

  state.valueSearchToken = token;
  state.query = String(query ?? "");
  state.valueLoading = normalizedQuery !== "";
  state.valueError = "";
  state.valueResults = [];
  state.valueSearchedQuery = "";
  state.valueSearchJobId = normalizedQuery ? String(jobId || createValueSearchJobId()) : "";
  state.valueProgress = createValueSearchProgress({
    jobId: state.valueSearchJobId,
    status: normalizedQuery ? "running" : "idle",
  });
  state.selectionTouched = false;

  return token;
}

export function updateValueSearchProgress(state, payload = {}) {
  const jobId = String(payload.jobId || payload.job_id || "");
  if (state.valueSearchJobId && jobId && jobId !== state.valueSearchJobId) return false;
  if (!state.valueLoading && state.valueProgress.status !== "running") return false;

  const total = Math.max(0, Number(payload.total ?? payload.totalTables ?? payload.total_tables ?? 0) || 0);
  const done = Math.max(0, Number(payload.done ?? payload.completedTables ?? payload.completed_tables ?? 0) || 0);
  const matches = Math.max(0, Number(payload.matches ?? payload.matchCount ?? payload.match_count ?? 0) || 0);

  state.valueProgress = createValueSearchProgress({
    jobId: jobId || state.valueSearchJobId,
    done: total ? Math.min(done, total) : done,
    total,
    matches,
    currentTable: String(payload.currentTable || payload.current_table || ""),
    message: String(payload.message || ""),
    status: String(payload.status || "running"),
  });
  return true;
}

export function valueSearchProgressPercent(state) {
  const progress = state?.valueProgress || {};
  const total = Number(progress.total) || 0;
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round(((Number(progress.done) || 0) / total) * 100)));
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
  state.valueProgress = createValueSearchProgress({
    ...state.valueProgress,
    done: state.valueProgress.total || state.valueProgress.done,
    matches: state.valueResults.length,
    status: "completed",
  });
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
  state.valueProgress = createValueSearchProgress({
    ...state.valueProgress,
    status: "failed",
    message: String(error ?? ""),
  });
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
