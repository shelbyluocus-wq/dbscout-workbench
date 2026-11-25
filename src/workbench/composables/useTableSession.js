import { markRaw, ref, watch } from "vue";
import { DEFAULT_PAGE_SIZE, REQUEST_PAGE_SIZE } from "../constants.js";
import { DenseRowStore, ensureTabRowStore, tabRowCount, tabRows } from "../rowStore.js";
import { tableWindowOffset } from "../utils/tableScrollWindow.js";
import {
  normalizeTableName,
  normalizeTableComment,
} from "../utils/normalize.js";
import { activateTableTab, closePaneTab, openTableTab, replaceTabPage, appendTabPage, prependTabPage, updateTabTotalMetadata, findTableDataTabs } from "../workspaceState.js";
import { markPerf, measureAsync, sampleNextFrame } from "../utils/performanceMarks.js";
import { resetTableTabViewState } from "../utils/tabActivation.js";
import { DEFAULT_TABLE_FILTER_MODE, normalizeTableFilterMode } from "../utils/tableFilterMode.js";
import { normalizeRelationFilter, normalizeRelationOrigin, relationFilterKey } from "../utils/relationFilter.js";
import {
  hasActiveColumnFilters,
  normalizeColumnFilters,
  removeColumnFilter,
  upsertColumnFilter,
} from "../utils/columnFilter.js";
import { listenWorkbenchEvent } from "../utils/tauriBridge.js";

const SEARCH_RESULT_PAGE_SIZE = 100;
const SEARCH_RESULT_BUFFER_ROWS = 500;
const TABLE_SESSIONS_INVALIDATED_EVENT = "table-sessions-invalidated";

// Backend messages from commands.rs / runtime_resources.rs when a table
// session (or its pool) is gone. Recovery reopens the session transparently.
export function isSessionInvalidError(error) {
  const message = String(error?.message || error || "");
  return (
    message.includes("表会话已失效") ||
    message.includes("连接已失效") ||
    message.includes("连接资源已关闭")
  );
}

function tableStatusLabel(tab, totalRows = tab?.totalRows, totalRowsExact = tab?.totalRowsExact, hasMore = tab?.hasMore) {
  const source = `${tab?.database ? `${tab.database}.` : ""}${tab?.tableName || ""}`;
  const loadedRows = tabRowCount(tab);
  const windowOffset = Math.max(0, Math.floor(Number(tab?.rowWindowOffset) || 0));
  const count = Math.max(0, Math.floor(Number(totalRows) || 0));
  if (windowOffset > 0 && loadedRows > 0) {
    const rangeEnd = Math.min(count || windowOffset + loadedRows, windowOffset + loadedRows);
    return `${source}：第 ${windowOffset + 1}–${rangeEnd} 行${totalRowsExact === false ? "+" : ` / 共 ${count} 行`}`;
  }
  if (totalRowsExact === false) {
    if (hasMore === false) return `${source}：已加载全部 ${loadedRows} 行`;
    return `${source}：已加载 ${loadedRows}+ 行${tab?.totalRowsLoading ? " · 总数计算中" : ""}`;
  }
  return `${source}：${count} 行`;
}

export function useTableSession(
  workspace,
  invokeWorkbench,
  { statusText, setStatus, ensureTableSchema: sharedEnsureTableSchema = null, onTableActivated = null },
) {
  const currentRequestByTab = new Map();
  const currentNextRequestByTab = new Map();
  const pendingPageRequestByTab = new Map();
  const currentTotalRequestByTab = new Map();
  const currentSearchJobByTab = new Map();
  const openingRequestsByTab = new Map();
  const activationIntentByPane = new Map();
  const pendingTableOpenCount = ref(0);
  let requestSequence = 0;
  let totalRequestSequence = 0;
  let activationIntentSequence = 0;
  const closingSessionRequests = new Map();

  function trackTabPageRequest(tabId, kind, run) {
    if (!tabId) return run({ kind, addedRows: 0, promise: null });
    const entry = { kind, addedRows: 0, promise: null };
    pendingPageRequestByTab.set(tabId, entry);
    let result;
    try {
      result = run(entry);
    } catch (error) {
      if (pendingPageRequestByTab.get(tabId) === entry) {
        pendingPageRequestByTab.delete(tabId);
      }
      return Promise.reject(error);
    }
    const promise = Promise.resolve(result).finally(() => {
      if (pendingPageRequestByTab.get(tabId) === entry) {
        pendingPageRequestByTab.delete(tabId);
      }
    });
    entry.promise = promise;
    return promise;
  }
  // Refetching the loaded rows in place never asks for more than this.
  const IN_PLACE_MAX_ROWS = REQUEST_PAGE_SIZE * 5;
  let disposed = false;
  const stopNavigationWatch = watch(
    () => [
      workspace.activeTabId,
      workspace.focusedPaneId,
      workspace.connectionId,
      workspace.database,
    ],
    () => activationIntentByPane.clear(),
    { flush: "sync" },
  );

  function liveOwnedSessions() {
    return new Map(
      (workspace.tabs || [])
        .map((tab) => [String(tab?.sessionId || ""), String(tab?.id || "")])
        .filter(([sessionId]) => Boolean(sessionId)),
    );
  }

  async function closeOwnedSession(sessionId) {
    const id = String(sessionId || "");
    if (!id) return null;
    if (closingSessionRequests.has(id)) return closingSessionRequests.get(id);
    const request = Promise.resolve()
      .then(() => invokeWorkbench("close_table_session", { sessionId: id }))
      .catch(() => null)
      .finally(() => closingSessionRequests.delete(id));
    closingSessionRequests.set(id, request);
    return request;
  }

  let ownedSessions = liveOwnedSessions();
  const stopSessionOwnershipWatch = watch(
    () => (workspace.tabs || []).map((tab) => [String(tab?.sessionId || ""), String(tab?.id || "")]),
    (sessionEntries) => {
      const nextSessions = new Map(sessionEntries.filter(([sessionId]) => Boolean(sessionId)));
      const removedSessions = [...ownedSessions].filter(([sessionId]) => !nextSessions.has(sessionId));
      ownedSessions = nextSessions;
      removedSessions.forEach(([sessionId, tabId]) => {
        cancelExactTotalRefreshById(tabId);
        void cancelSearchResultPageById(tabId);
        void closeOwnedSession(sessionId);
      });
    },
  );

  async function dispose() {
    if (disposed) return;
    disposed = true;
    unlistenSessionInvalidation?.();
    unlistenSessionInvalidation = null;
    stopNavigationWatch();
    stopDeferredVisibilityWatch();
    activationIntentByPane.clear();
    stopSessionOwnershipWatch();
    for (const tabId of currentTotalRequestByTab.keys()) cancelExactTotalRefreshById(tabId);
    const searchTabIds = new Set([
      ...currentSearchJobByTab.keys(),
      ...(workspace.tabs || []).filter((tab) => tab?.searchResultJobId).map((tab) => tab.id),
    ]);
    await Promise.all([...searchTabIds].map((tabId) => cancelSearchResultPageById(tabId)));
    const remainingSessionIds = new Set([...ownedSessions.keys(), ...liveOwnedSessions().keys()]);
    ownedSessions.clear();
    await Promise.all([...remainingSessionIds].map(closeOwnedSession));
  }

  async function releaseTabSession(tab) {
    cancelExactTotalRefresh(tab);
    await cancelSearchResultPage(tab);
    if (tab.searchResultMode) {
      tab.searchResultMode = false;
      tab.searchResultQuery = "";
      restoreNormalView(tab);
    }
    tab.sessionId = "";
    tab.loadError = null;
    tab.loadMoreError = "";
  }

  const firstPageLoadsByTab = new Map();

  function loadTabFirstPage(tab, { background = false } = {}) {
    tab.deferredLoad = false;
    const request = loadFirstPageIntoTab(tab, null, {
      connectionId: tab.connectionId,
      database: tab.database,
      tableName: tab.tableName,
      readOnly: Boolean(tab.readOnly),
      background,
    }).finally(() => {
      if (firstPageLoadsByTab.get(tab.id) === request) firstPageLoadsByTab.delete(tab.id);
    });
    firstPageLoadsByTab.set(tab.id, request);
    return request;
  }

  async function reopenTableSession(tab) {
    if (disposed || !tab?.id || !findTabById(tab.id)) return null;
    await releaseTabSession(tab);
    return loadTabFirstPage(tab);
  }

  // A deferred tab keeps its place, title and view state but has no backend
  // session yet. It loads when it becomes visible (or is preloaded), so
  // background tabs never cost a database round trip until they are needed.
  async function markTabDeferred(tab) {
    if (disposed || !tab?.id || !findTabById(tab.id)) return;
    await releaseTabSession(tab);
    tab.deferredLoad = true;
  }

  function needsDeferredLoad(tab) {
    return Boolean(
      tab
      && (tab.kind || "data") === "data"
      && tab.deferredLoad
      && !tab.sessionId
      && !tab.loading
      && !tab.opening,
    );
  }

  function loadDeferredTab(tab, { background = false } = {}) {
    const current = tab?.id ? findTabById(tab.id) : null;
    if (disposed || !current) return null;
    if (firstPageLoadsByTab.has(current.id)) return firstPageLoadsByTab.get(current.id);
    if (!needsDeferredLoad(current)) return null;
    return loadTabFirstPage(current, { background: background && !isTabVisible(current.id) });
  }

  function isTabVisible(tabId) {
    if (!tabId) return false;
    if (workspace.activeTabId === tabId) return true;
    return Object.values(workspace.panes || {}).some((pane) => pane?.activeTabId === tabId);
  }

  function visibleTabIds() {
    const ids = new Set(Object.values(workspace.panes || {}).map((pane) => pane?.activeTabId).filter(Boolean));
    if (workspace.activeTabId) ids.add(workspace.activeTabId);
    return [...ids];
  }

  function loadVisibleDeferredTabs() {
    const loads = [];
    for (const tabId of visibleTabIds()) {
      const request = loadDeferredTab(findTabById(tabId));
      if (request) loads.push(request);
    }
    return Promise.all(loads);
  }

  // Quiet one-at-a-time preload of the remaining deferred tabs (e.g. restored
  // after startup). A tab the user opens meanwhile loads immediately through
  // the visibility watcher and is skipped here because it is already loading.
  let preloadRunning = false;
  async function preloadDeferredTabs() {
    if (preloadRunning) return;
    preloadRunning = true;
    try {
      for (;;) {
        if (disposed) return;
        const next = (workspace.tabs || []).find((tab) => needsDeferredLoad(tab));
        if (!next) return;
        await loadDeferredTab(next, { background: true });
      }
    } finally {
      preloadRunning = false;
    }
  }

  const stopDeferredVisibilityWatch = watch(
    () => visibleTabIds().join("\u001f"),
    () => { void loadVisibleDeferredTabs(); },
  );

  async function handleSessionsInvalidated(payload) {
    if (disposed || !payload) return;
    const connectionId = String(payload.connectionId || "");
    const sessionIds = new Set(
      (Array.isArray(payload.sessionIds) ? payload.sessionIds : []).map(String),
    );
    const affected = (workspace.tabs || []).filter((tab) => {
      if ((tab?.kind || "data") !== "data" || !tab?.sessionId) return false;
      if (sessionIds.size) return sessionIds.has(String(tab.sessionId));
      return Boolean(connectionId) && String(tab.connectionId || "") === connectionId;
    });
    if (!affected.length) return;
    // Only tabs on screen reload now (the focused one first). Background tabs
    // are deferred until they are shown again, so an idle window no longer
    // reloads every tab each time the 30-minute session lease expires.
    const visible = affected.filter((tab) => isTabVisible(tab.id));
    const hidden = affected.filter((tab) => !isTabVisible(tab.id));
    visible.sort(
      (a, b) => Number(b.id === workspace.activeTabId) - Number(a.id === workspace.activeTabId),
    );
    for (const tab of hidden) await markTabDeferred(tab);
    let recovered = 0;
    for (const tab of visible) {
      const loaded = await reopenTableSession(tab);
      if (loaded) recovered += 1;
    }
    if (recovered > 0) {
      const msg = "表会话已失效，已自动重新打开并刷新";
      if (setStatus) setStatus(msg);
      else statusText.value = msg;
    }
  }

  let unlistenSessionInvalidation = null;
  Promise.resolve(
    listenWorkbenchEvent(TABLE_SESSIONS_INVALIDATED_EVENT, (event) => {
      void handleSessionsInvalidated(event?.payload);
    }),
  )
    .then((unlisten) => {
      if (disposed) unlisten?.();
      else unlistenSessionInvalidation = unlisten;
    })
    .catch(() => null);

  function sameSource(leftConnectionId, leftDatabase, rightConnectionId, rightDatabase) {
    return String(leftConnectionId || "") === String(rightConnectionId || "") && String(leftDatabase || "") === String(rightDatabase || "");
  }

  function paneIncludesTab(paneId, tab) {
    const pane = workspace.panes?.[paneId || workspace.focusedPaneId || "pane-1"];
    return Boolean(pane && tab?.id && pane.tabIds?.includes(tab.id));
  }

  function searchText(tab) {
    return String(tab?.searchQuery || tab?.filter || "").trim();
  }

  function findExistingTab(connectionId, database, tableName, paneId = "", initialState = null) {
    const hitResultMode = Boolean(initialState?.hitResultMode);
    const query = String(initialState?.searchQuery || initialState?.filter || "").trim();
    const filterMode = normalizeTableFilterMode(initialState?.filterMode);
    const relationKey = relationFilterKey(initialState?.relationFilter);
    return workspace.tabs.find(
      (tab) =>
        (tab.kind || "data") === "data" &&
        paneIncludesTab(paneId, tab) &&
        sameSource(tab.connectionId, tab.database, connectionId, database) &&
        String(tab.tableName || "") === String(tableName || "") &&
        Boolean(tab.hitResultMode) === hitResultMode &&
        (!hitResultMode ||
          (searchText(tab) === query &&
            normalizeTableFilterMode(tab.filterMode) === filterMode &&
            relationFilterKey(tab.relationFilter) === relationKey)),
    );
  }

  function beginTabRequest(tabId) {
    const requestToken = ++requestSequence;
    currentRequestByTab.set(tabId, requestToken);
    return requestToken;
  }

  function isCurrentTabRequest(tabId, requestToken) {
    return currentRequestByTab.get(tabId) === requestToken;
  }

  function invokeCountCancellation(requestId) {
    if (!requestId) return;
    try {
      void Promise.resolve(invokeWorkbench("cancel_table_count", { requestId })).catch(() => null);
    } catch {
      // Cancellation is best-effort; the request token still blocks stale UI updates.
    }
  }

  async function cancelSearchJob(jobId) {
    const id = String(jobId || "");
    if (!id) return false;
    try {
      const result = await invokeWorkbench("cancel_table_search", { jobId: id });
      return result?.cancelled === true;
    } catch {
      return false;
    }
  }

  async function cancelSearchResultPageById(tabId, tab = findTabById(tabId)) {
    if (!tabId) return false;
    const jobId = currentSearchJobByTab.get(tabId) || tab?.searchResultJobId || "";
    currentSearchJobByTab.delete(tabId);
    if (tab && tab.searchResultJobId === jobId) tab.searchResultJobId = "";
    return cancelSearchJob(jobId);
  }

  function cancelSearchResultPage(tab) {
    return cancelSearchResultPageById(tab?.id, tab);
  }

  function cancelExactTotalRefreshById(tabId, tab = findTabById(tabId)) {
    if (!tabId) return;
    const current = currentTotalRequestByTab.get(tabId);
    currentTotalRequestByTab.delete(tabId);
    invokeCountCancellation(current?.requestId);
    if (tab) {
      tab.totalRowsLoading = false;
      tab.totalRowsError = "";
    }
  }

  function cancelExactTotalRefresh(tab) {
    if (!tab?.id) return;
    cancelExactTotalRefreshById(tab.id, tab);
  }

  function scheduleAfterFirstFrame(callback) {
    const schedule = () => setTimeout(callback, 0);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(schedule);
    } else {
      schedule();
    }
  }

  function findTabById(tabId) {
    return workspace.tabs.find((item) => item.id === tabId) || null;
  }

  function claimActivationIntent(paneId) {
    const intent = { token: ++activationIntentSequence };
    activationIntentByPane.set(paneId, intent);
    return intent;
  }

  function cancelPendingTableActivation(paneId = "") {
    if (paneId) activationIntentByPane.delete(paneId);
    else activationIntentByPane.clear();
  }

  function releaseActivationIntent(paneId, intent) {
    if (activationIntentByPane.get(paneId)?.token === intent?.token) {
      activationIntentByPane.delete(paneId);
    }
  }

  function activateForIntent(tab, paneId, intent) {
    if (!tab || !intent || activationIntentByPane.get(paneId)?.token !== intent.token) return false;
    activateTableTab(workspace, tab.id);
    activationIntentByPane.delete(paneId);
    onTableActivated?.(tab);
    return true;
  }

  function discardProvisionalTab(tab, paneId) {
    if (!tab?.id || !findTabById(tab.id)) return;
    closePaneTab(workspace, paneId, tab.id, { focusOwner: false });
  }

  function usesBackendFilter(tab) {
    return (
      tab?.hitResultMode === true
      || tab?.searchResultMode === true
      || tab?.searchFilterActive === true
      || Boolean(normalizeRelationFilter(tab?.relationFilter))
      || hasActiveColumnFilters(tab?.columnFilters)
    );
  }

  function isNormalOpen(initialState) {
    return !Boolean(initialState?.hitResultMode);
  }

  function existingTabNeedsNormalReload(tab, initialState) {
    if (!isNormalOpen(initialState)) return false;
    if (!tab?.sessionId) return true;
    if (tab.loadError) return true;
    if (tab.searchResultMode) return true;
    return false;
  }

  function resetNormalTableViewState(tab) {
    tab.filter = "";
    tab.searchQuery = "";
    tab.searchFilterActive = false;
    tab.columnFilters = [];
    tab.searchResultMode = false;
    tab.searchResultQuery = "";
    tab.searchResultJobId = "";
    tab.searchResultMatches = [];
    tab.searchResultRowKeys = [];
    tab.searchResultComplete = true;
    tab.hitResultMode = false;
    tab.hitResultSourceTabId = "";
    tab.hitResultSourcePaneId = "";
    tab.relationFilter = null;
    tab.relationOrigin = null;
    tab.filterMode = DEFAULT_TABLE_FILTER_MODE;
    tab.sort = null;
    tab.selectedRowKeys?.clear?.();
    tab.schemaSearchQuery = "";
    tab.schemaSearchMatches = [];
    tab.schemaSearchIndex = -1;
    tab.fullyLoaded = false;
    tab.rowWindowOffset = 0;
    tab.boundaryLoading = "";
    tab.loadError = null;
    tab.loadMoreError = "";
    resetTableTabViewState(tab);
  }

  function buildBackendFilter(tab) {
    const relation = normalizeRelationFilter(tab?.relationFilter);
    const columnFilters = normalizeColumnFilters(tab?.columnFilters);
    const includeQuery = Boolean(
      tab?.hitResultMode
      || tab?.searchResultMode
      || tab?.searchFilterActive
      || relation,
    );
    const query = includeQuery ? String(tab?.filter || tab?.searchQuery || "").trim() : "";
    if (!query && !relation && !columnFilters.length) return null;
    return {
      query,
      columns: [],
      mode: normalizeTableFilterMode(tab.filterMode),
      ...(relation ? { relation } : {}),
      ...(columnFilters.length ? { columnFilters } : {}),
    };
  }

  function createTotalRequestId(tabId) {
    const randomId = globalThis.crypto?.randomUUID?.();
    return randomId || `table-count-${tabId}-${Date.now()}-${++totalRequestSequence}`;
  }

  function isCurrentTotalRequest(tabId, requestToken) {
    return currentTotalRequestByTab.get(tabId)?.token === requestToken;
  }

  function markTotalLoadingFinished(tabId, requestToken, error = null) {
    const tab = findTabById(tabId);
    if (!tab || !isCurrentTotalRequest(tabId, requestToken)) return null;
    currentTotalRequestByTab.delete(tabId);
    tab.totalRowsLoading = false;
    tab.totalRowsError = error ? String(error?.message || error) : "";
    return tab;
  }

  function scheduleExactTotalRefresh(tab) {
    if (!tab?.sessionId || tab.totalRowsExact !== false || tab.hasMore === false) return;
    const tabId = tab.id;
    const sessionId = tab.sessionId;
    const requestToken = ++totalRequestSequence;
    const requestId = createTotalRequestId(tabId);
    currentTotalRequestByTab.set(tabId, { token: requestToken, requestId });
    tab.totalRowsLoading = true;
    tab.totalRowsError = "";
    scheduleAfterFirstFrame(async () => {
      const currentTab = findTabById(tabId);
      if (!currentTab || !isCurrentTotalRequest(tabId, requestToken)) return;
      if (currentTab.sessionId !== sessionId) {
        const staleTab = markTotalLoadingFinished(tabId, requestToken);
        if (staleTab && workspace.activeTabId === tabId) {
          const msg = tableStatusLabel(staleTab);
          if (setStatus) setStatus(msg);
          else statusText.value = msg;
        }
        return;
      }
      try {
        const payload = await measureAsync(
          "table.total.invoke",
          () => invokeWorkbench("fetch_table_count", {
            sessionId,
            requestId,
            filter: usesBackendFilter(currentTab) ? buildBackendFilter(currentTab) : null,
          }),
          { tableName: currentTab.tableName },
        );
        const latestTab = findTabById(tabId);
        if (!latestTab || !isCurrentTotalRequest(tabId, requestToken)) return;
        if (latestTab.sessionId !== sessionId) {
          const staleTab = markTotalLoadingFinished(tabId, requestToken);
          if (staleTab && workspace.activeTabId === tabId) {
            const msg = tableStatusLabel(staleTab);
            if (setStatus) setStatus(msg);
            else statusText.value = msg;
          }
          return;
        }
        currentTotalRequestByTab.delete(tabId);
        updateTabTotalMetadata(workspace, tabId, {
          totalRows: payload.totalRows,
          totalRowsExact: payload.exact === true,
        });
        const updatedTab = findTabById(tabId);
        if (updatedTab && workspace.activeTabId === tabId) {
          const msg = tableStatusLabel(updatedTab);
          if (setStatus) setStatus(msg);
          else statusText.value = msg;
        }
      } catch (error) {
        const failedTab = markTotalLoadingFinished(tabId, requestToken, error);
        if (failedTab && workspace.activeTabId === tabId) {
          const msg = tableStatusLabel(failedTab);
          if (setStatus) setStatus(msg);
          else statusText.value = msg;
        }
      }
    });
  }

  function scheduleInitialBufferFill(tab) {
    if (!tab?.sessionId || tab.searchResultMode || tab.hasMore === false || tabRowCount(tab) >= REQUEST_PAGE_SIZE) return;
    const tabId = tab.id;
    const sessionId = tab.sessionId;
    scheduleAfterFirstFrame(() => {
      const currentTab = findTabById(tabId);
      if (
        !currentTab
        || currentTab.sessionId !== sessionId
        || currentTab.searchResultMode
        || currentTab.hasMore === false
        || currentTab.loading
        || currentTab.loadingMore
        || tabRowCount(currentTab) >= REQUEST_PAGE_SIZE
      ) return;
      void loadNextPage(currentTab);
    });
  }

  async function ensureTableSchema(tableName, { connectionId = workspace.connectionId, database = workspace.database } = {}) {
    if (typeof sharedEnsureTableSchema === "function") {
      return sharedEnsureTableSchema(tableName, {
        connectionId,
        database,
        priority: "recent",
      });
    }
    const normalizedTableName = String(tableName || "").trim();
    return workspace.schema.find(
      (item) => normalizeTableName(item) === normalizedTableName,
    ) || null;
  }

  async function loadFirstPageIntoTab(
    tab,
    table,
    { connectionId = workspace.connectionId, database = workspace.database, tableName = normalizeTableName(table), readOnly = Boolean(table?.readOnly || table?.read_only), background = false } = {},
  ) {
    if (!tab) return null;
    return trackTabPageRequest(tab.id, "page", async () => {
      // Background preloads stay silent: no progress cursor, no status-bar text.
      const reportProgress = !background;
      if (reportProgress) {
        pendingTableOpenCount.value += 1;
        statusText.value = `加载 ${database ? `${database}.` : ""}${tableName}`;
      }
      let requestToken;
      let openedSessionId = "";
      try {
        tab.readOnly = readOnly;
        requestToken = beginTabRequest(tab.id);
        tab.loading = true;
        tab.loadingMore = false;
        tab.loadError = null;
        // open_table_session already returns columns/primaryKeys/tableComment, so
        // we no longer block on get_table_schema for the first frame. The schema
        // fetch is fired in the background only to refresh the sidebar schema tree.
        const page = await measureAsync(
          "table.open.invoke",
          () => invokeWorkbench("open_table_session", {
            connectionId,
            database,
            tableName,
            options: buildOpenSessionOptions(tab),
          }),
          { connectionId, database, tableName },
        );
        openedSessionId = String(page?.sessionId || "");
        if (!isCurrentTabRequest(tab.id, requestToken) || !findTabById(tab.id)) {
          await closeOwnedSession(openedSessionId);
          return null;
        }
        markPerf("table.page.replace.start", { tableName, rows: page.rows?.length || 0, columns: page.columns?.length || 0 });
        replaceTabPage(workspace, tab.id, page);
        openedSessionId = "";
        tab = workspace.tabs.find((item) => item.id === tab.id) || tab;
        markPerf("table.page.replace.end", { tableName, rows: tabRowCount(tab), columns: tab.columns?.length || 0 });
        sampleNextFrame("table.first-grid-frame", { tableName, rows: tabRowCount(tab), columns: tab.columns?.length || 0 });
        tab.primaryKeys = page.primaryKeys || [];
        tab.tableComment = page.tableComment || "";
        tab.loadError = null;
        scheduleExactTotalRefresh(tab);
        scheduleInitialBufferFill(tab);
        // Background refresh of workspace.schema (sidebar tree) — fire-and-forget.
        // Retains the sameSource stale-guard inside ensureTableSchema.
        ensureTableSchema(tableName, { connectionId, database }).catch(() => {});
        if (reportProgress) {
          const msg = tableStatusLabel(tab, page.totalRows, page.totalRowsExact, page.hasMore);
          if (setStatus) setStatus(msg);
          else statusText.value = msg;
        }
        return tab;
      } catch (error) {
        if (openedSessionId && findTabById(tab.id)?.sessionId !== openedSessionId) {
          await closeOwnedSession(openedSessionId);
        }
        if (!requestToken || isCurrentTabRequest(tab.id, requestToken)) {
          tab.loading = false;
          tab.loadError = String(error?.message || error);
          if (reportProgress) {
            const msg = `读取表失败：${String(error?.message || error)}`;
            if (setStatus) setStatus(msg, { error: true });
            else statusText.value = msg;
          }
        }
        return null;
      } finally {
        if (reportProgress) pendingTableOpenCount.value = Math.max(0, pendingTableOpenCount.value - 1);
      }
    });
  }

  function startProvisionalOpen(tab, table, options, { paneId, intent } = {}) {
    tab.opening = true;
    markPerf("table.opening-tab.visible", { tableName: tab.tableName, paneId });
    sampleNextFrame("table.opening-tab-frame", { tableName: tab.tableName, paneId });
    const request = loadFirstPageIntoTab(tab, table, options)
      .then((loadedTab) => {
        if (!loadedTab) {
          releaseActivationIntent(paneId, intent);
          discardProvisionalTab(tab, paneId);
          return null;
        }
        loadedTab.opening = false;
        activateForIntent(loadedTab, paneId, intent);
        return loadedTab;
      })
      .finally(() => openingRequestsByTab.delete(tab.id));
    openingRequestsByTab.set(tab.id, request);
    return request;
  }

  async function openTable(table, { activate = true, paneId = "", duplicate = false, initialState = null, viewMode = "" } = {}) {
    const tableName = normalizeTableName(table);
    if (!tableName) return;
    const targetViewMode = viewMode === "history" ? "history" : "data";
    const connectionId = String(table?.connectionId || table?.connection_id || workspace.connectionId || "");
    const database = String(table?.database || workspace.database || "");
    const readOnly = Boolean(table?.readOnly || table?.read_only);
    const targetPaneId = paneId || workspace.focusedPaneId || "";
    const activationIntent = activate ? claimActivationIntent(targetPaneId) : null;
    let existingTab = duplicate ? null : findExistingTab(connectionId, database, tableName, targetPaneId, initialState);
    if (!existingTab && !duplicate && isNormalOpen(initialState)) {
      // 跨 pane 兜底：该表可能已在其它分屏打开。普通数据表（非值命中态）
      // 直接复用并激活，避免在当前 pane 重复建 tab。命中后 activateTableTab
      // 会把 focusedPaneId 切到该 tab 所在 pane。
      const candidates = findTableDataTabs(workspace, { connectionId, database, tableName });
      existingTab =
        candidates.find((tab) => (tab.kind || "data") === "data" && !Boolean(tab.hitResultMode)) || null;
    }
    if (existingTab) {
      if (existingTab.opening) {
        existingTab.viewMode = targetViewMode;
        const openingRequest = openingRequestsByTab.get(existingTab.id);
        const loadedTab = openingRequest ? await openingRequest : existingTab;
        if (!loadedTab) {
          releaseActivationIntent(targetPaneId, activationIntent);
          return null;
        }
        loadedTab.viewMode = targetViewMode;
        activateForIntent(loadedTab, targetPaneId, activationIntent);
        return loadedTab;
      }
      existingTab.viewMode = targetViewMode;
      activateForIntent(existingTab, targetPaneId, activationIntent);
      if (isNormalOpen(initialState) && (existingTab.deferredLoad || firstPageLoadsByTab.has(existingTab.id))) {
        // A restored/deferred tab keeps its saved sort and filter: load it as-is.
        return (await loadDeferredTab(existingTab)) || existingTab;
      }
      if (!existingTabNeedsNormalReload(existingTab, initialState)) return existingTab;
      resetNormalTableViewState(existingTab);
      if (existingTab.sessionId) {
        const result = await fetchPage(existingTab, 1);
        return result?.tab || existingTab;
      }
      const loadedTab = await loadFirstPageIntoTab(existingTab, table, {
        connectionId,
        database,
        tableName,
        readOnly,
      });
      return loadedTab || existingTab;
    }
    const initialHitResultMode = initialState ? Boolean(initialState.hitResultMode) : false;
    const tab = openTableTab(workspace, {
      connectionId,
      database,
      tableName,
      tableComment: normalizeTableComment(table),
      readOnly,
      hitResultMode: initialHitResultMode,
      searchQuery: initialState?.searchQuery ?? initialState?.filter ?? "",
      filter: initialState?.filter ?? "",
      filterMode: normalizeTableFilterMode(initialState?.filterMode),
      relationFilter: initialState?.relationFilter ?? null,
      relationOrigin: initialState?.relationOrigin ?? null,
    }, { activate: false, paneId: targetPaneId });
    tab.readOnly = readOnly;
    tab.viewMode = targetViewMode;
    if (initialState) {
      tab.filter = String(initialState.filter ?? tab.filter ?? "");
      tab.searchQuery = String(initialState.searchQuery ?? initialState.filter ?? tab.searchQuery ?? "");
      tab.filterMode = normalizeTableFilterMode(initialState.filterMode || tab.filterMode);
      tab.sort = initialState.sort ? { ...initialState.sort } : tab.sort || null;
      tab.hitResultMode = Boolean(initialState.hitResultMode);
      tab.hitResultSourceTabId = String(initialState.hitResultSourceTabId || "");
      tab.hitResultSourcePaneId = String(initialState.hitResultSourcePaneId || "");
      tab.relationFilter = normalizeRelationFilter(initialState.relationFilter);
      tab.relationOrigin = normalizeRelationOrigin(initialState.relationOrigin);
    }
    return startProvisionalOpen(tab, table, {
      connectionId,
      database,
      tableName,
      readOnly,
    }, {
      paneId: targetPaneId,
      intent: activationIntent,
    });
  }

  function buildPageRequest(tab, page, { includeFilter = false, pageSize = REQUEST_PAGE_SIZE, offset = null } = {}) {
    const request = {
      page,
      pageSize,
      includeTotal: false,
      filter: includeFilter && usesBackendFilter(tab) ? buildBackendFilter(tab) : null,
      sort: tab.sort || null,
    };
    if (offset !== null && offset !== undefined) request.offset = Math.max(0, Math.floor(Number(offset) || 0));
    return request;
  }

  function buildOpenSessionOptions(tab) {
    const request = buildPageRequest(tab, 1, {
      includeFilter: usesBackendFilter(tab),
      pageSize: DEFAULT_PAGE_SIZE,
    });
    if (!request.filter) delete request.filter;
    if (!request.sort) delete request.sort;
    return request;
  }

  // The rows the grid has loaded, to fetch again where they are. A very long
  // window is cut down to the part around `anchor` (a loaded row index, such
  // as the first deleted row) so the request stays small and still covers
  // what the user is looking at.
  function loadedRowWindow(tab, anchor = null) {
    const offset = tableWindowOffset(tab);
    const loaded = tabRowCount(tab);
    if (loaded <= IN_PLACE_MAX_ROWS) return { offset, size: Math.max(REQUEST_PAGE_SIZE, loaded) };
    const center = offset + Math.min(loaded, Math.max(0, Number.isInteger(anchor) ? anchor : 0));
    return { offset: Math.max(0, center - Math.floor(IN_PLACE_MAX_ROWS / 2)), size: IN_PLACE_MAX_ROWS };
  }

  // Totals after fetching the loaded rows again in place. The page itself only
  // estimates them, so a known exact total stays exact (less the rows just
  // removed) or, when the change is unknown, stays as a provisional figure
  // that is counted again in the background.
  function inPlaceTotals(tab, payload, offset, removedRows) {
    const reached = offset + (Array.isArray(payload?.rows) ? payload.rows.length : 0);
    if ((payload?.hasMore ?? payload?.has_more) === false) return { totalRows: reached, totalRowsExact: true };
    if (tab.totalRowsExact !== true) return {};
    const previous = Math.max(0, Math.floor(Number(tab.totalRows) || 0));
    if (Number.isInteger(removedRows) && removedRows >= 0) {
      return { totalRows: Math.max(reached, previous - removedRows), totalRowsExact: true };
    }
    return { totalRows: Math.max(reached, previous), totalRowsExact: false };
  }

  /**
   * Replaces the tab's rows with one page from the backend. `page` is placed
   * where it belongs in the table. With `inPlace` the rows already loaded are
   * fetched again from the same position instead (after rows were deleted,
   * inserted or replaced), so the grid keeps its scroll position and rows
   * after a deleted one move up; `removedRows` keeps a known total exact.
   */
  async function fetchPage(tab, page, { refreshSchema = false, inPlace = false, anchor = null, removedRows = null } = {}) {
    if (refreshSchema && tab) {
      const refreshToken = beginTabRequest(tab.id);
      cancelExactTotalRefresh(tab);
      tab.loading = true;
      tab.loadingMore = false;
      try {
        const source = { connectionId: tab.connectionId, database: tab.database, force: true };
        let schema;
        if (typeof sharedEnsureTableSchema === "function") {
          schema = await sharedEnsureTableSchema(tab.tableName, source);
        } else {
          [schema] = await invokeWorkbench("get_table_schemas", { ...source, tableNames: [tab.tableName] });
        }
        if (!findTabById(tab.id) || !isCurrentTabRequest(tab.id, refreshToken)) return { ok: false, stale: true };
        // Search result pages do not carry the table's comment.
        if (schema && ("table_comment" in schema || "tableComment" in schema)) {
          tab.tableComment = schema.table_comment ?? schema.tableComment ?? "";
        }
      } catch (error) {
        if (!isCurrentTabRequest(tab.id, refreshToken)) return { ok: false, stale: true };
        const message = `刷新字段失败：${String(error?.message || error)}`;
        if (setStatus) setStatus(message, { error: true });
        else statusText.value = message;
        return { ok: false, error };
      } finally {
        if (isCurrentTabRequest(tab.id, refreshToken)) tab.loading = false;
      }
    }
    if (tab?.searchResultMode) {
      return loadSearchResultPage(tab, tab.searchResultQuery || tab.searchQuery || tab.filter || "");
    }
    if (!tab?.sessionId) {
      const deferred = loadDeferredTab(tab);
      if (deferred) {
        const loaded = await deferred;
        return loaded ? { ok: true, tab: loaded } : { ok: false, error: new Error(String(tab.loadError || "table load failed")) };
      }
      return { ok: false, error: new Error("missing table session") };
    }
    return trackTabPageRequest(tab.id, "page", async () => {
      const requestToken = beginTabRequest(tab.id);
      const inPlaceWindow = inPlace ? loadedRowWindow(tab, anchor) : null;
      cancelExactTotalRefresh(tab);
      tab.loading = true;
      tab.loadingMore = false;
      tab.loadError = null;
      try {
        let windowOffset = (Math.max(1, Math.floor(Number(page) || 1)) - 1) * REQUEST_PAGE_SIZE;
        let payload;
        if (inPlaceWindow) {
          // Rows at the end may be gone: step back a window, then to the top.
          const starts = [...new Set([inPlaceWindow.offset, Math.max(0, inPlaceWindow.offset - inPlaceWindow.size), 0])];
          for (const start of starts) {
            payload = await measureAsync(
              "table.fetch.invoke",
              () => invokeWorkbench("fetch_table_page", {
                sessionId: tab.sessionId,
                request: buildPageRequest(tab, Math.floor(start / REQUEST_PAGE_SIZE) + 1, {
                  includeFilter: usesBackendFilter(tab),
                  pageSize: inPlaceWindow.size,
                  offset: start,
                }),
              }),
              { tableName: tab.tableName, page: Math.floor(start / REQUEST_PAGE_SIZE) + 1, offset: start },
            );
            if (!isCurrentTabRequest(tab.id, requestToken)) return { ok: false, stale: true };
            windowOffset = start;
            if (Array.isArray(payload?.rows) && payload.rows.length > 0) break;
          }
        } else {
          payload = await measureAsync(
            "table.fetch.invoke",
            () => invokeWorkbench("fetch_table_page", {
                sessionId: tab.sessionId,
                request: buildPageRequest(tab, page, { includeFilter: usesBackendFilter(tab) }),
              }),
            { tableName: tab.tableName, page },
          );
        }
        if (!isCurrentTabRequest(tab.id, requestToken)) return { ok: false, stale: true };
        markPerf("table.page.replace.start", { tableName: tab.tableName, rows: payload.rows?.length || 0, columns: payload.columns?.length || 0 });
        const totals = inPlaceWindow ? inPlaceTotals(tab, payload, windowOffset, removedRows) : {};
        replaceTabPage(workspace, tab.id, { ...payload, ...totals, rowWindowOffset: windowOffset });
        if (totals.totalRowsExact === false) scheduleExactTotalRefresh(tab);
        markPerf("table.page.replace.end", { tableName: tab.tableName, rows: tabRowCount(tab), columns: tab.columns?.length || 0 });
        sampleNextFrame("table.grid-frame", { tableName: tab.tableName, rows: tabRowCount(tab), columns: tab.columns?.length || 0 });
        tab.primaryKeys = payload.primaryKeys || tab.primaryKeys || [];
        tab.loadError = null;
        const msg = tableStatusLabel(tab, payload.totalRows, payload.totalRowsExact, payload.hasMore);
        if (setStatus) setStatus(msg);
        else statusText.value = msg;
        return { ok: true, tab };
      } catch (error) {
        if (!isCurrentTabRequest(tab.id, requestToken)) return { ok: false, stale: true };
        if (isSessionInvalidError(error)) {
          // The backend session died silently (idle TTL / capacity eviction /
          // connection teardown). Reopen it transparently instead of surfacing
          // an unrecoverable error; loadFirstPageIntoTab keeps the tab's
          // filter/sort through buildOpenSessionOptions.
          const recoveredTab = await reopenTableSession(tab);
          if (recoveredTab) return { ok: true, tab: recoveredTab, recovered: true };
          return { ok: false, error };
        }
        tab.loading = false;
        tab.loadError = String(error?.message || error);
        const msg = `读取分页失败：${String(error?.message || error)}`;
        if (setStatus) setStatus(msg, { error: true });
        else statusText.value = msg;
        return { ok: false, error };
      } finally {
        if (isCurrentTabRequest(tab.id, requestToken)) tab.loading = false;
      }
    });
  }

  async function loadNextPage(tab) {
    if (tab?.searchResultMode) {
      const result = await loadNextSearchResultPage(tab);
      return Boolean(result?.ok && result?.addedRows > 0);
    }
    const pending = tab?.id ? pendingPageRequestByTab.get(tab.id) : null;
    if (pending) {
      try {
        await pending.promise;
      } catch {
        return false;
      }
      if (disposed || !findTabById(tab.id)) return false;
      if (pending.kind === "next") return pending.addedRows > 0 || Boolean(tab.loading);
      return !tab.loadError && (Boolean(tab.loading) || (!tab.fullyLoaded && tab.hasMore !== false));
    }
    if (!tab?.sessionId || tab.loading || tab.loadingMore || tab.loadingPrevious || tab.boundaryLoading || tab.fullyLoaded || tab.hasMore === false) return false;
    const totalRows = Math.max(0, Math.floor(Number(tab.totalRows) || 0));
    if (tab.totalRowsExact !== false && totalRows > 0 && tabRowCount(tab) >= totalRows) {
      tab.fullyLoaded = true;
      return false;
    }
    return trackTabPageRequest(tab.id, "next", async (entry) => {
      const requestToken = beginTabRequest(tab.id);
      currentNextRequestByTab.set(tab.id, requestToken);
      tab.loadingMore = true;
      try {
        const windowOffset = Math.max(0, Math.floor(Number(tab.rowWindowOffset) || 0));
        const loadedRowCount = tabRowCount(tab);
        const nextPageSize = loadedRowCount < REQUEST_PAGE_SIZE
          ? REQUEST_PAGE_SIZE - loadedRowCount
          : REQUEST_PAGE_SIZE;
        const nextPage = Math.floor(loadedRowCount / REQUEST_PAGE_SIZE) + 1;
        const payload = await measureAsync(
          "table.fetchMore.invoke",
          () => invokeWorkbench("fetch_table_page", {
            sessionId: tab.sessionId,
            request: buildPageRequest(tab, nextPage, {
              includeFilter: usesBackendFilter(tab),
              pageSize: nextPageSize,
              offset: windowOffset + loadedRowCount,
            }),
          }),
          { tableName: tab.tableName, page: nextPage, offset: windowOffset + loadedRowCount },
        );
        if (!isCurrentTabRequest(tab.id, requestToken)) return false;
        appendTabPage(workspace, tab.id, payload);
        if (tabRowCount(tab) >= REQUEST_PAGE_SIZE) tab.pageSize = REQUEST_PAGE_SIZE;
        markPerf("table.page.appended", { tableName: tab.tableName, rows: tabRowCount(tab), totalRows: tab.totalRows || 0 });
        sampleNextFrame("table.append-grid-frame", { tableName: tab.tableName, rows: tabRowCount(tab), columns: tab.columns?.length || 0 });
        tab.primaryKeys = payload.primaryKeys || tab.primaryKeys || [];
        tab.loadMoreError = null;
        const msg = tableStatusLabel(tab);
        if (setStatus) setStatus(msg);
        else statusText.value = msg;
        entry.addedRows = Array.isArray(payload.rows) ? payload.rows.length : 0;
        return entry.addedRows > 0;
      } catch (error) {
        if (isCurrentTabRequest(tab.id, requestToken)) {
          tab.loadingMore = false;
          tab.loadMoreError = String(error?.message || error);
          const msg = `继续读取失败：${String(error?.message || error)}`;
          if (setStatus) setStatus(msg, { error: true });
          else statusText.value = msg;
        }
        return false;
      } finally {
        if (currentNextRequestByTab.get(tab.id) === requestToken) {
          currentNextRequestByTab.delete(tab.id);
          tab.loadingMore = false;
        }
      }
    });
  }

  // 向前（表头方向）加载上一页窗口：跳到末行后向上滚动时无缝接回前面的行。
  // 与 loadNextPage 对称，额外返回 addedRows 供调用方做滚动锚定。
  async function loadPreviousPage(tab) {
    if (tab?.searchResultMode) return { ok: false, searchResultMode: true };
    if (!tab?.sessionId || tab.loading || tab.loadingMore || tab.boundaryLoading || tab.loadingPrevious) {
      return { ok: false, busy: true };
    }
    // 插入草稿按加载下标锚定，前插行会让它们错位；有可见草稿时暂不向前加载。
    if (Array.isArray(tab.insertDrafts) && tab.insertDrafts.some((row) => row?.visible !== false)) {
      return { ok: false, insertDrafts: true };
    }
    const windowOffset = Math.max(0, Math.floor(Number(tab.rowWindowOffset) || 0));
    if (windowOffset <= 0) return { ok: false, atTop: true };
    const prevOffset = Math.max(0, windowOffset - REQUEST_PAGE_SIZE);
    const pageSize = windowOffset - prevOffset;
    const page = Math.floor(prevOffset / REQUEST_PAGE_SIZE) + 1;
    const requestToken = beginTabRequest(tab.id);
    tab.loadingPrevious = true;
    try {
      const payload = await measureAsync(
        "table.fetchPrevious.invoke",
        () => invokeWorkbench("fetch_table_page", {
          sessionId: tab.sessionId,
          request: buildPageRequest(tab, page, {
            includeFilter: usesBackendFilter(tab),
            pageSize,
            offset: prevOffset,
          }),
        }),
        { tableName: tab.tableName, page, offset: prevOffset },
      );
      if (!isCurrentTabRequest(tab.id, requestToken)) return { ok: false, stale: true };
      prependTabPage(workspace, tab.id, { ...payload, rowWindowOffset: prevOffset });
      const addedRows = Array.isArray(payload?.rows) ? payload.rows.length : 0;
      tab.primaryKeys = payload.primaryKeys || tab.primaryKeys || [];
      tab.loadMoreError = null;
      const msg = tableStatusLabel(tab);
      if (setStatus) setStatus(msg);
      else statusText.value = msg;
      return { ok: addedRows > 0, addedRows, offset: prevOffset };
    } catch (error) {
      if (isCurrentTabRequest(tab.id, requestToken)) {
        tab.loadingPrevious = false;
        tab.loadMoreError = String(error?.message || error);
        const msg = `向前读取失败：${String(error?.message || error)}`;
        if (setStatus) setStatus(msg, { error: true });
        else statusText.value = msg;
      }
      return { ok: false, error };
    } finally {
      if (isCurrentTabRequest(tab.id, requestToken)) tab.loadingPrevious = false;
    }
  }

  async function jumpToTableBoundary(tab, boundary) {
    const target = boundary === "bottom" ? "bottom" : "top";
    if (!tab?.sessionId || tab.loading || tab.loadingMore || tab.loadingPrevious || tab.boundaryLoading) {
      return { ok: false, busy: true };
    }
    if (tab.searchResultMode) {
      const message = tab.searchResultComplete
        ? "搜索结果视图不支持首末行跳转，请先清除搜索"
        : "正在扫描全表，搜索完成或清除搜索后可使用首末行跳转";
      if (setStatus) setStatus(message);
      else statusText.value = message;
      return { ok: false, searchResultMode: true };
    }

    const requestToken = beginTabRequest(tab.id);
    tab.boundaryLoading = target;
    tab.loadMoreError = "";
    try {
      const hadExactTotal = tab.totalRowsExact === true;
      let totalRows = Math.max(0, Math.floor(Number(tab.totalRows) || 0));
      if (target === "bottom" && tab.totalRowsExact !== true) {
        cancelExactTotalRefresh(tab);
        const requestId = createTotalRequestId(tab.id);
        const countPayload = await measureAsync(
          "table.boundary.total.invoke",
          () => invokeWorkbench("fetch_table_count", {
            sessionId: tab.sessionId,
            requestId,
            filter: usesBackendFilter(tab) ? buildBackendFilter(tab) : null,
          }),
          { tableName: tab.tableName, boundary: target },
        );
        if (!isCurrentTabRequest(tab.id, requestToken)) return { ok: false, stale: true };
        totalRows = Math.max(0, Math.floor(Number(countPayload?.totalRows) || 0));
      }

      const page = target === "bottom" && totalRows > 0
        ? Math.ceil(totalRows / REQUEST_PAGE_SIZE)
        : 1;
      const offset = (page - 1) * REQUEST_PAGE_SIZE;
      const payload = await measureAsync(
        "table.boundary.invoke",
        () => invokeWorkbench("fetch_table_page", {
          sessionId: tab.sessionId,
          request: buildPageRequest(tab, page, {
            includeFilter: usesBackendFilter(tab),
            pageSize: REQUEST_PAGE_SIZE,
            offset,
          }),
        }),
        { tableName: tab.tableName, boundary: target, offset },
      );
      if (!isCurrentTabRequest(tab.id, requestToken)) return { ok: false, stale: true };
      const preserveExactTotal = target === "bottom" || hadExactTotal;
      replaceTabPage(workspace, tab.id, {
        ...payload,
        totalRows: preserveExactTotal ? totalRows : payload.totalRows,
        totalRowsExact: preserveExactTotal ? true : payload.totalRowsExact,
        hasMore: target === "bottom" ? false : payload.hasMore,
        rowWindowOffset: offset,
      });
      if (target === "top") scheduleExactTotalRefresh(tab);
      tab.primaryKeys = payload.primaryKeys || tab.primaryKeys || [];
      tab.selectedRowKeys?.clear?.();
      tab.loadError = null;
      const message = target === "bottom"
        ? (totalRows > 0 ? `已定位到末行 · ${tableStatusLabel(tab)}` : `${tab.tableName}：暂无数据`)
        : `已定位到首行 · ${tableStatusLabel(tab)}`;
      if (setStatus) setStatus(message);
      else statusText.value = message;
      return { ok: true, tab, boundary: target, offset };
    } catch (error) {
      if (!isCurrentTabRequest(tab.id, requestToken)) return { ok: false, stale: true };
      if (isSessionInvalidError(error)) {
        tab.boundaryLoading = "";
        const recoveredTab = await reopenTableSession(tab);
        if (recoveredTab) {
          if (target === "top") return { ok: true, tab: recoveredTab, boundary: target, offset: 0, recovered: true };
          return jumpToTableBoundary(recoveredTab, target);
        }
      }
      tab.loadMoreError = String(error?.message || error);
      const message = `定位${target === "bottom" ? "末行" : "首行"}失败：${String(error?.message || error)}`;
      if (setStatus) setStatus(message, { error: true });
      else statusText.value = message;
      return { ok: false, error };
    } finally {
      if (isCurrentTabRequest(tab.id, requestToken)) tab.boundaryLoading = "";
    }
  }

  function captureNormalView(tab) {
    if (tab.normalViewState?.rowStore) return tab.normalViewState;
    const rowStore = ensureTabRowStore(tab);
    tab.normalViewState = {
      rowStore,
      totalRows: tab.totalRows,
      totalRowsExact: tab.totalRowsExact,
      totalRowsLoading: tab.totalRowsLoading,
      totalRowsError: tab.totalRowsError,
      hasMore: tab.hasMore,
      page: tab.page,
      pageSize: tab.pageSize,
      fullyLoaded: tab.fullyLoaded,
      loadError: tab.loadError,
      loadMoreError: tab.loadMoreError,
      rowWindowOffset: Math.max(0, Math.floor(Number(tab.rowWindowOffset) || 0)),
      sortSignature: JSON.stringify(tab.sort || null),
    };
    return tab.normalViewState;
  }

  function restoreNormalView(tab) {
    const snapshot = tab?.normalViewState;
    if (!snapshot?.rowStore) return false;
    tab.rowStore = snapshot.rowStore;
    ensureTabRowStore(tab);
    tab.totalRows = snapshot.totalRows;
    tab.totalRowsExact = snapshot.totalRowsExact;
    tab.totalRowsLoading = snapshot.totalRowsLoading;
    tab.totalRowsError = snapshot.totalRowsError;
    tab.hasMore = snapshot.hasMore;
    tab.page = snapshot.page;
    tab.pageSize = snapshot.pageSize;
    tab.fullyLoaded = snapshot.fullyLoaded;
    tab.loadError = snapshot.loadError;
    tab.loadMoreError = snapshot.loadMoreError;
    tab.rowWindowOffset = snapshot.rowWindowOffset || 0;
    tab.normalViewState = null;
    tab.searchRowStore = null;
    return true;
  }

  function applySearchPage(tab, payload, { append = false } = {}) {
    const incomingRows = Array.isArray(payload?.rows) ? payload.rows : [];
    const incomingKeys = Array.isArray(payload?.rowKeys) ? payload.rowKeys.map(String) : [];
    const incomingMatches = Array.isArray(payload?.matches) ? payload.matches : [];
    let rows = append ? [...tabRows(tab), ...incomingRows] : incomingRows;
    let rowKeys = append ? [...(tab.searchResultRowKeys || []), ...incomingKeys] : incomingKeys;
    const existingRowCount = append ? Math.max(0, rows.length - incomingRows.length) : 0;
    let matches = append
      ? [
        ...(tab.searchResultMatches || []),
        ...incomingMatches.map((match) => ({ ...match, rowIndex: existingRowCount + Number(match.rowIndex || 0) })),
      ]
      : incomingMatches.map((match) => ({ ...match, rowIndex: Number(match.rowIndex || 0) }));
    const droppedRows = Math.max(0, rows.length - SEARCH_RESULT_BUFFER_ROWS);
    if (droppedRows > 0) {
      rows = rows.slice(droppedRows);
      rowKeys = rowKeys.slice(droppedRows);
      matches = matches
        .filter((match) => match.rowIndex >= droppedRows)
        .map((match) => ({ ...match, rowIndex: match.rowIndex - droppedRows }));
    }
    if (!append || !tab.searchRowStore) {
      tab.searchRowStore = markRaw(new DenseRowStore(rows));
      tab.rowStore = tab.searchRowStore;
      ensureTabRowStore(tab);
    } else {
      tab.searchRowStore.replacePage(rows);
    }
    tab.searchResultRowKeys = rowKeys;
    tab.searchResultMatches = matches;
    tab.searchResultDroppedRows = append
      ? Math.max(0, Number(tab.searchResultDroppedRows) || 0) + droppedRows
      : droppedRows;
    tab.rowWindowOffset = 0;
    tab.searchResultJobId = String(payload?.jobId || tab.searchResultJobId || "");
    tab.searchResultScannedRows = Math.max(0, Number(payload?.scannedRows) || 0);
    tab.searchResultComplete = payload?.complete === true;
    tab.totalRows = rows.length;
    tab.totalRowsExact = tab.searchResultComplete;
    tab.totalRowsLoading = false;
    tab.totalRowsError = "";
    tab.hasMore = !tab.searchResultComplete;
    tab.page = 1;
    tab.pageSize = SEARCH_RESULT_PAGE_SIZE;
    tab.fullyLoaded = tab.searchResultComplete;
    tab.loading = false;
    tab.loadingMore = false;
    tab.loadError = null;
    tab.loadMoreError = "";
    return { droppedRows, addedRows: incomingRows.length };
  }

  async function loadSearchResultPage(tab, query) {
    if (!tab?.sessionId) return { ok: false, error: new Error("missing table session") };
    const text = String(query ?? tab.searchQuery ?? tab.filter ?? "").trim();
    if (!text) {
      const sortChanged = Boolean(
        tab.normalViewState
        && tab.normalViewState.sortSignature !== JSON.stringify(tab.sort || null),
      );
      await cancelSearchResultPage(tab);
      tab.searchResultMode = false;
      tab.searchResultQuery = "";
      tab.searchResultMatches = [];
      tab.searchResultRowKeys = [];
      tab.searchResultComplete = true;
      tab.filter = "";
      tab.searchQuery = "";
      if (restoreNormalView(tab)) {
        if (sortChanged) return fetchPage(tab, 1);
        return { ok: true, restored: true, tab };
      }
      return fetchPage(tab, 1);
    }
    await cancelSearchResultPage(tab);
    cancelExactTotalRefresh(tab);
    const requestToken = beginTabRequest(tab.id);
    captureNormalView(tab);
    tab.searchResultMode = true;
    tab.searchResultQuery = text;
    tab.loading = true;
    tab.loadingMore = false;
    tab.loadError = null;
    try {
      const payload = await measureAsync(
        "table.searchResults.invoke",
        () => invokeWorkbench("begin_table_search", {
          request: {
            sessionId: tab.sessionId,
            query: text,
            mode: normalizeTableFilterMode(tab.filterMode),
            sort: tab.sort || null,
            resultPageSize: SEARCH_RESULT_PAGE_SIZE,
          },
        }),
        { tableName: tab.tableName },
      );
      if (!isCurrentTabRequest(tab.id, requestToken)) {
        await cancelSearchJob(payload?.jobId);
        return { ok: false, stale: true };
      }
      const latestTab = findTabById(tab.id) || tab;
      applySearchPage(latestTab, payload);
      currentSearchJobByTab.set(latestTab.id, latestTab.searchResultJobId);
      latestTab.searchResultMode = true;
      latestTab.searchResultQuery = text;
      latestTab.filter = text;
      latestTab.searchQuery = text;
      latestTab.loadError = null;
      const hitCount = Array.isArray(payload.rows) ? payload.rows.length : 0;
      const suffix = payload.complete ? "" : "+";
      const msg = hitCount > 0 ? `全表搜索命中 ${hitCount}${suffix} 行` : payload.complete ? "当前表未找到匹配内容" : "正在搜索剩余数据…";
      if (setStatus) setStatus(msg);
      else statusText.value = msg;
      return { ok: true, tab: latestTab, jobId: latestTab.searchResultJobId, complete: latestTab.searchResultComplete };
    } catch (error) {
      if (!isCurrentTabRequest(tab.id, requestToken)) return { ok: false, stale: true };
      tab.searchResultMode = false;
      tab.searchResultQuery = "";
      restoreNormalView(tab);
      tab.loading = false;
      tab.loadError = String(error?.message || error);
      const msg = `全表搜索失败：${String(error?.message || error)}`;
      if (setStatus) setStatus(msg, { error: true });
      else statusText.value = msg;
      return { ok: false, error };
    } finally {
      if (isCurrentTabRequest(tab.id, requestToken)) tab.loading = false;
    }
  }

  async function loadNextSearchResultPage(tab) {
    if (!tab?.searchResultMode || !tab.searchResultJobId || tab.searchResultComplete || tab.loadingMore) {
      return { ok: false, complete: Boolean(tab?.searchResultComplete), addedRows: 0 };
    }
    const requestToken = beginTabRequest(tab.id);
    const jobId = tab.searchResultJobId;
    tab.loadingMore = true;
    try {
      const payload = await measureAsync(
        "table.searchResults.next.invoke",
        () => invokeWorkbench("next_table_search_page", { request: { jobId } }),
        { tableName: tab.tableName },
      );
      if (!isCurrentTabRequest(tab.id, requestToken) || tab.searchResultJobId !== jobId) {
        return { ok: false, stale: true, addedRows: 0 };
      }
      const page = applySearchPage(tab, payload, { append: true });
      if (payload.complete) currentSearchJobByTab.delete(tab.id);
      const hitCount = tab.searchResultMatches.length;
      const suffix = tab.searchResultComplete ? "" : "+";
      const msg = hitCount > 0 ? `全表搜索命中 ${hitCount}${suffix} 处` : tab.searchResultComplete ? "当前表未找到匹配内容" : "正在搜索剩余数据…";
      if (setStatus) setStatus(msg);
      else statusText.value = msg;
      return { ok: true, tab, complete: tab.searchResultComplete, ...page };
    } catch (error) {
      if (!isCurrentTabRequest(tab.id, requestToken)) return { ok: false, stale: true, addedRows: 0 };
      tab.loadMoreError = String(error?.message || error);
      const msg = `继续搜索失败：${String(error?.message || error)}`;
      if (setStatus) setStatus(msg, { error: true });
      else statusText.value = msg;
      return { ok: false, error, addedRows: 0 };
    } finally {
      if (isCurrentTabRequest(tab.id, requestToken)) tab.loadingMore = false;
    }
  }

  function toggleSort(tab, column) {
    const current = tab.sort;
    const nextDescending =
      current?.columnName === column ? !current.descending : false;
    tab.sort = { columnName: column, descending: nextDescending };
    return tab.searchResultMode
      ? loadSearchResultPage(tab, tab.searchResultQuery || tab.searchQuery || tab.filter || "")
      : fetchPage(tab, 1);
  }

  // The relation chip's clear button: the tab becomes an ordinary table view
  // again. A text search typed on top of the relation view survives as a
  // client-side search; everything else about the filtered view is dropped.
  async function clearRelationFilter(tab) {
    if (!normalizeRelationFilter(tab?.relationFilter)) return { ok: false };
    const query = String(tab.searchQuery || tab.filter || "").trim();
    const filterMode = normalizeTableFilterMode(tab.filterMode);
    resetNormalTableViewState(tab);
    tab.filterMode = filterMode;
    if (query) {
      tab.filter = query;
      tab.searchQuery = query;
    }
    if (!tab.sessionId) return { ok: true, tab };
    const result = await fetchPage(tab, 1);
    if (!result?.ok) return result || { ok: false, tab };
    const nextTab = result.tab || tab;
    scheduleExactTotalRefresh(nextTab);
    return { ok: true, tab: nextTab };
  }

  function applySort(tab, column, direction) {
    if (direction === "none") {
      tab.sort = null;
    } else {
      tab.sort = { columnName: column, descending: direction === "descending" };
    }
    return tab.searchResultMode
      ? loadSearchResultPage(tab, tab.searchResultQuery || tab.searchQuery || tab.filter || "")
      : fetchPage(tab, 1);
  }

  async function applySearchFilter(tab) {
    if (!tab) return { ok: false };
    if (tab.searchResultMode || tab.searchResultJobId) {
      await cancelSearchResultPage(tab);
      tab.searchResultMode = false;
      tab.searchResultQuery = "";
    }
    if (!tab.sessionId) return { ok: true, tab };
    const result = await fetchPage(tab, 1);
    if (result?.ok) scheduleExactTotalRefresh(result.tab || tab);
    return result;
  }

  async function applyColumnFilter(tab, column, rule) {
    if (!tab || !column) return { ok: false };
    if (tab.searchResultMode || tab.searchResultJobId) {
      await cancelSearchResultPage(tab);
      tab.searchResultMode = false;
      tab.searchResultQuery = "";
    }
    tab.columnFilters = rule
      ? upsertColumnFilter(tab.columnFilters, { ...rule, column })
      : removeColumnFilter(tab.columnFilters, column);
    if (!tab.sessionId) return { ok: true, tab };
    const result = await fetchPage(tab, 1);
    if (result?.ok) scheduleExactTotalRefresh(result.tab || tab);
    return result;
  }

  async function clearColumnFilters(tab) {
    if (!tab || !hasActiveColumnFilters(tab.columnFilters)) return { ok: false };
    tab.columnFilters = [];
    if (!tab.sessionId) return { ok: true, tab };
    const result = await fetchPage(tab, 1);
    if (result?.ok) scheduleExactTotalRefresh(result.tab || tab);
    return result;
  }

  return {
    markTabDeferred,
    loadDeferredTab,
    loadVisibleDeferredTabs,
    preloadDeferredTabs,
    openTable,
    pendingTableOpenCount,
    cancelPendingTableActivation,
    fetchPage,
    loadNextPage,
    loadPreviousPage,
    jumpToTableBoundary,
    loadSearchResultPage,
    loadNextSearchResultPage,
    cancelSearchResultPage,
    reopenTableSession,
    handleSessionsInvalidated,
    toggleSort,
    applySort,
    applySearchFilter,
    applyColumnFilter,
    clearColumnFilters,
    clearRelationFilter,
    dispose,
  };
}
