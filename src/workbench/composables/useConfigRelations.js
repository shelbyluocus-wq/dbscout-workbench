import { reactive } from "vue";
import { invokeWorkbench, listenWorkbenchEvent } from "../utils/tauriBridge.js";

// One relation index exists per (connection, database) on the backend. This
// composable mirrors its overview per scope, refreshes it when the backend
// publishes `config-relations-updated`, and forwards the row/table lookups
// the inspector panel and the review dialog need.
export const CONFIG_RELATIONS_UPDATED_EVENT = "config-relations-updated";

export function configRelationsScopeKey(scope) {
  const connectionId = String(scope?.connectionId || "");
  const database = String(scope?.database || "").trim().toLowerCase();
  return connectionId && database ? `${connectionId}\u001f${database}` : "";
}

const TABLE_CACHE_LIMIT = 60;

export function useConfigRelations({
  invoke = invokeWorkbench,
  listen = listenWorkbenchEvent,
  debounceMs = 250,
} = {}) {
  const entries = new Map();
  const tableCache = new Map();
  const pendingOverviewTimers = new Map();
  let unlisten = null;
  let attachPromise = null;

  function entryFor(scope) {
    const key = configRelationsScopeKey(scope);
    if (!key) return null;
    let entry = entries.get(key);
    if (!entry) {
      entry = reactive({
        key,
        connectionId: String(scope.connectionId || ""),
        database: String(scope.database || "").trim(),
        overview: null,
        error: "",
        loading: false,
        revision: 0,
        requestToken: 0,
      });
      entries.set(key, entry);
    }
    return entry;
  }

  function applyOverview(entry, overview) {
    if (!entry || !overview) return;
    entry.overview = overview;
    entry.revision = Number(overview.revision) || 0;
    entry.error = "";
  }

  async function loadOverview(scope, { force = false } = {}) {
    const entry = entryFor(scope);
    if (!entry) return null;
    if (entry.loading && !force) return entry.overview;
    const token = ++entry.requestToken;
    entry.loading = true;
    try {
      const overview = await invoke("config_relations_overview", {
        request: { connectionId: entry.connectionId, database: entry.database },
      });
      if (token !== entry.requestToken) return entry.overview;
      applyOverview(entry, overview);
      return entry.overview;
    } catch (error) {
      // Keep the last good overview; a transient failure must not blank the UI.
      if (token === entry.requestToken) entry.error = String(error?.message || error);
      return null;
    } finally {
      if (token === entry.requestToken) entry.loading = false;
    }
  }

  function scheduleOverviewReload(entry) {
    if (debounceMs <= 0) {
      void loadOverview(entry, { force: true });
      return;
    }
    clearTimeout(pendingOverviewTimers.get(entry.key));
    pendingOverviewTimers.set(
      entry.key,
      setTimeout(() => {
        pendingOverviewTimers.delete(entry.key);
        void loadOverview(entry, { force: true });
      }, debounceMs),
    );
  }

  function handleUpdated(event) {
    const payload = event?.payload || event;
    const key = configRelationsScopeKey(payload);
    const entry = key ? entries.get(key) : null;
    if (!entry) return;
    // The event carries the fresh review count; apply it immediately so the
    // rail badge does not wait for the debounced overview reload.
    const reviewCount = Number(payload?.reviewCount);
    if (entry.overview && Number.isFinite(reviewCount)) {
      entry.overview = { ...entry.overview, reviewCount };
    }
    scheduleOverviewReload(entry);
  }

  async function attach() {
    if (unlisten || !listen) return Boolean(unlisten);
    if (!attachPromise) {
      attachPromise = Promise.resolve()
        .then(() => listen(CONFIG_RELATIONS_UPDATED_EVENT, handleUpdated))
        .then((off) => {
          unlisten = typeof off === "function" ? off : null;
          return Boolean(unlisten);
        })
        .catch(() => {
          unlisten = null;
          return false;
        });
    }
    return attachPromise;
  }

  function dispose() {
    for (const timer of pendingOverviewTimers.values()) clearTimeout(timer);
    pendingOverviewTimers.clear();
    unlisten?.();
    unlisten = null;
    attachPromise = null;
  }

  function scopeRequest(entry, extra = {}) {
    return { request: { connectionId: entry.connectionId, database: entry.database, ...extra } };
  }

  // Table relations are cached per index revision; a backend rebuild bumps the
  // revision and naturally invalidates older entries.
  async function tableRelations(scope, table) {
    const entry = entryFor(scope);
    const tableName = String(table || "").trim();
    if (!entry || !tableName) return null;
    const cacheKey = `${entry.key}\u001f${tableName.toLowerCase()}`;
    const cached = tableCache.get(cacheKey);
    if (cached && cached.revision === entry.revision) return cached.data;
    const data = await invoke("config_relations_table", scopeRequest(entry, { table: tableName }));
    const revision = Number(data?.revision) || 0;
    if (revision > entry.revision) entry.revision = revision;
    if (tableCache.size >= TABLE_CACHE_LIMIT) tableCache.clear();
    tableCache.set(cacheKey, { revision, data });
    return data;
  }

  function rowTargets(scope, table, row, channel = "inspector") {
    const entry = entryFor(scope);
    if (!entry) return Promise.resolve(null);
    return invoke("config_relations_row_targets", scopeRequest(entry, { table: String(table || ""), row: row || {}, channel }));
  }

  function rowReferences(scope, table, row, channel = "inspector") {
    const entry = entryFor(scope);
    if (!entry) return Promise.resolve(null);
    return invoke("config_relations_row_references", scopeRequest(entry, { table: String(table || ""), row: row || {}, channel }));
  }

  async function reviewList(scope) {
    const entry = entryFor(scope);
    if (!entry) return null;
    const data = await invoke("config_relations_review_list", scopeRequest(entry));
    if (data?.overview) applyOverview(entry, data.overview);
    return data;
  }

  async function submitReview(scope, relationIds, verdict) {
    const entry = entryFor(scope);
    if (!entry) return null;
    const overview = await invoke("config_relations_review", scopeRequest(entry, {
      relationIds: Array.isArray(relationIds) ? relationIds : [],
      verdict: verdict ?? null,
    }));
    applyOverview(entry, overview);
    return overview;
  }

  // The run itself is in the background; reloading the overview right away
  // shows its "refreshing" state, and the update event reports its end.
  async function refresh(scope) {
    const entry = entryFor(scope);
    if (!entry) return;
    await invoke("config_relations_refresh", scopeRequest(entry));
    await loadOverview(entry, { force: true });
  }

  function discoverClients(scope) {
    const entry = entryFor(scope);
    if (!entry) return Promise.resolve([]);
    return invoke("config_relations_discover_clients", scopeRequest(entry));
  }

  function inspectClient(scope, path) {
    const entry = entryFor(scope);
    if (!entry) return Promise.resolve(null);
    return invoke("config_relations_inspect_client", scopeRequest(entry, { path: String(path || "") }));
  }

  async function bindClient(scope, path) {
    const entry = entryFor(scope);
    if (!entry) return null;
    const overview = await invoke("config_relations_bind_client", scopeRequest(entry, { path: String(path || "") }));
    applyOverview(entry, overview);
    return overview;
  }

  async function unbindClient(scope) {
    const entry = entryFor(scope);
    if (!entry) return null;
    const overview = await invoke("config_relations_unbind_client", scopeRequest(entry));
    applyOverview(entry, overview);
    return overview;
  }

  function pickClientDir() {
    return invoke("config_relations_pick_client_dir");
  }

  return {
    entryFor,
    loadOverview,
    tableRelations,
    rowTargets,
    rowReferences,
    reviewList,
    submitReview,
    refresh,
    discoverClients,
    inspectClient,
    bindClient,
    unbindClient,
    pickClientDir,
    attach,
    dispose,
  };
}
