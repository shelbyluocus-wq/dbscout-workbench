import { markRaw, ref, watch } from "vue";
import { DEFAULT_PAGE_SIZE, REQUEST_PAGE_SIZE } from "../constants.js";
import { DenseRowStore, ensureTabRowStore, tabRowCount, tabRows } from "../rowStore.js";
import {
  normalizeTableName,
  normalizeTableComment,
} from "../utils/normalize.js";
import { activateTableTab, closePaneTab, openTableTab, replaceTabPage, appendTabPage, updateTabTotalMetadata, findTableDataTabs } from "../workspaceState.js";
import { markPerf, measureAsync, sampleNextFrame } from "../utils/performanceMarks.js";
import { resetTableTabViewState } from "../utils/tabActivation.js";
import { DEFAULT_TABLE_FILTER_MODE, normalizeTableFilterMode } from "../utils/tableFilterMode.js";
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
  const count = Math.max(0, Math.floor(Number(totalRows) || 0));
  if (totalRowsExact === false) {
    if (hasMore === false) return `${source}：已加载全部 ${loadedRows} 行`;
    return `${source}：已加载 ${loadedRows}+ 行${tab?.totalRowsLoading ? " · 总数计算中" : ""}`;
  }
  return `${source}：${count} 行`;
}

export function useTableSession(
  workspace,
  invokeWorkbench,
  { statusText, setStatus, ensureTableSchema: sharedEnsureTableSchema = null },
) {
  const currentRequestByTab = new Map();
  const currentTotalRequestByTab = new Map();
  const currentSearchJobByTab = new Map();
  const openingRequestsByTab = new Map();
  const activationIntentByPane = new Map();
  const pendingTableOpenCount = ref(0);
  let requestSequence = 0;
  let totalRequestSequence = 0;
  let activationIntentSequence = 0;
  const closingSessionRequests = new Map();
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

  async function reopenTableSession(tab) {
    if (disposed || !tab?.id || !findTabById(tab.id)) return null;
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
    return loadFirstPageIntoTab(tab, null, {
      connectionId: tab.connectionId,
      database: tab.database,
      tableName: tab.tableName,
      readOnly: Boolean(tab.readOnly),
    });
  }

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
    // Recover the visible tab first; background tabs follow sequentially.
    affected.sort(
      (a, b) => Number(b.id === workspace.activeTabId) - Number(a.id === workspace.activeTabId),
    );
    let recovered = 0;
    for (const tab of affected) {
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
    return workspace.tabs.find(
      (tab) =>
        (tab.kind || "data") === "data" &&
        paneIncludesTab(paneId, tab) &&
        sameSource(tab.connectionId, tab.database, connectionId, database) &&
        String(tab.tableName || "") === String(tableName || "") &&
        Boolean(tab.hitResultMode) === hitResultMode &&
        (!hitResultMode || (searchText(tab) === query && normalizeTableFilterMode(tab.filterMode) === filterMode)),
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
    return true;
  }

  function discardProvisionalTab(tab, paneId) {
    if (!tab?.id || !findTabById(tab.id)) return;
    closePaneTab(workspace, paneId, tab.id, { focusOwner: false });
  }

  function usesBackendFilter(tab) {
    return tab?.hitResultMode === true || tab?.searchResultMode === true;
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
    tab.searchResultMode = false;
    tab.searchResultQuery = "";
    tab.searchResultJobId = "";
    tab.searchResultMatches = [];
    tab.searchResultRowKeys = [];
    tab.searchResultComplete = true;
    tab.hitResultMode = false;
    tab.hitResultSourceTabId = "";
    tab.hitResultSourcePaneId = "";
    tab.filterMode = DEFAULT_TABLE_FILTER_MODE;
    tab.sort = null;
    tab.selectedRowKeys?.clear?.();
    tab.schemaSearchQuery = "";
    tab.schemaSearchMatches = [];
    tab.schemaSearchIndex = -1;
    tab.fullyLoaded = false;
    tab.loadError = null;
    tab.loadMoreError = "";
    resetTableTabViewState(tab);
  }

  function buildBackendFilter(tab) {
    const query = String(tab?.filter || tab?.searchQuery || "").trim();
    if (!query) return null;
    return {
      query,
      columns: [],
      mode: normalizeTableFilterMode(tab.filterMode),
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
    { connectionId = workspace.connectionId, database = workspace.database, tableName = normalizeTableName(table), readOnly = Boolean(table?.readOnly || table?.read_only) } = {},
  ) {
    if (!tab) return null;
    pendingTableOpenCount.value += 1;
    statusText.value = `加载 ${database ? `${database}.` : ""}${tableName}`;
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
      const msg = tableStatusLabel(tab, page.totalRows, page.totalRowsExact, page.hasMore);
      if (setStatus) setStatus(msg);
      else statusText.value = msg;
      return tab;
    } catch (error) {
      if (openedSessionId && findTabById(tab.id)?.sessionId !== openedSessionId) {
        await closeOwnedSession(openedSessionId);
      }
      if (!requestToken || isCurrentTabRequest(tab.id, requestToken)) {
        tab.loading = false;
        tab.loadError = String(error?.message || error);
        const msg = `读取表失败：${String(error?.message || error)}`;
        if (setStatus) setStatus(msg, { error: true });
        else statusText.value = msg;
      }
      return null;
    } finally {
      pendingTableOpenCount.value = Math.max(0, pendingTableOpenCount.value - 1);
    }
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

  async function openTable(table, { activate = true, paneId = "", duplicate = false, initialState = null } = {}) {
    const tableName = normalizeTableName(table);
    if (!tableName) return;
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
        const openingRequest = openingRequestsByTab.get(existingTab.id);
        const loadedTab = openingRequest ? await openingRequest : existingTab;
        if (!loadedTab) {
          releaseActivationIntent(targetPaneId, activationIntent);
          return null;
        }
        activateForIntent(loadedTab, targetPaneId, activationIntent);
        return loadedTab;
      }
      activateForIntent(existingTab, targetPaneId, activationIntent);
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
    }, { activate: false, paneId: targetPaneId });
    tab.readOnly = readOnly;
    if (initialState) {
      tab.filter = String(initialState.filter ?? tab.filter ?? "");
      tab.searchQuery = String(initialState.searchQuery ?? initialState.filter ?? tab.searchQuery ?? "");
      tab.filterMode = normalizeTableFilterMode(initialState.filterMode || tab.filterMode);
      tab.sort = initialState.sort ? { ...initialState.sort } : tab.sort || null;
      tab.hitResultMode = Boolean(initialState.hitResultMode);
      tab.hitResultSourceTabId = String(initialState.hitResultSourceTabId || "");
      tab.hitResultSourcePaneId = String(initialState.hitResultSourcePaneId || "");
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

  async function fetchPage(tab, page) {
    if (tab?.searchResultMode) {
      return loadSearchResultPage(tab, tab.searchResultQuery || tab.searchQuery || tab.filter || "");
    }
    if (!tab?.sessionId) return { ok: false, error: new Error("missing table session") };
    const requestToken = beginTabRequest(tab.id);
    cancelExactTotalRefresh(tab);
    tab.loading = true;
    tab.loadingMore = false;
    tab.loadError = null;
    try {
      const payload = await measureAsync(
        "table.fetch.invoke",
        () => invokeWorkbench("fetch_table_page", {
            sessionId: tab.sessionId,
            request: buildPageRequest(tab, page, { includeFilter: usesBackendFilter(tab) }),
          }),
        { tableName: tab.tableName, page },
      );
      if (!isCurrentTabRequest(tab.id, requestToken)) return { ok: false, stale: true };
      markPerf("table.page.replace.start", { tableName: tab.tableName, rows: payload.rows?.length || 0, columns: payload.columns?.length || 0 });
      replaceTabPage(workspace, tab.id, payload);
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
  }

  async function loadNextPage(tab) {
    if (tab?.searchResultMode) {
      const result = await loadNextSearchResultPage(tab);
      return Boolean(result?.ok && result?.addedRows > 0);
    }
    if (!tab?.sessionId || tab.loading || tab.loadingMore || tab.fullyLoaded || tab.hasMore === false) return false;
    const totalRows = Math.max(0, Math.floor(Number(tab.totalRows) || 0));
    if (tab.totalRowsExact !== false && totalRows > 0 && tabRowCount(tab) >= totalRows) {
      tab.fullyLoaded = true;
      return false;
    }
    const requestToken = beginTabRequest(tab.id);
    tab.loadingMore = true;
    try {
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
            offset: loadedRowCount,
          }),
        }),
        { tableName: tab.tableName, page: nextPage, offset: loadedRowCount },
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
      return Array.isArray(payload.rows) && payload.rows.length > 0;
    } catch (error) {
      if (isCurrentTabRequest(tab.id, requestToken)) {
        tab.loadingMore = false;
        tab.loadMoreError = String(error?.message || error);
        const msg = `继续读取失败：${String(error?.message || error)}`;
        if (setStatus) setStatus(msg, { error: true });
        else statusText.value = msg;
      }
      return false;
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

  return {
    openTable,
    pendingTableOpenCount,
    cancelPendingTableActivation,
    fetchPage,
    loadNextPage,
    loadSearchResultPage,
    loadNextSearchResultPage,
    cancelSearchResultPage,
    reopenTableSession,
    handleSessionsInvalidated,
    toggleSort,
    applySort,
    dispose,
  };
}
