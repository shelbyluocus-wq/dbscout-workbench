import { watch } from "vue";
import { REQUEST_PAGE_SIZE } from "../constants.js";
import { tabRowCount } from "../rowStore.js";
import {
  normalizeTableName,
  normalizeTableComment,
} from "../utils/normalize.js";
import { activateTableTab, openTableTab, replaceTabPage, appendTabPage, updateTabTotalMetadata, findTableDataTabs } from "../workspaceState.js";
import { markPerf, measureAsync, sampleNextFrame } from "../utils/performanceMarks.js";

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

export function useTableSession(workspace, invokeWorkbench, { busy, statusText, setStatus }) {
  const currentRequestByTab = new Map();
  const currentTotalRequestByTab = new Map();
  let requestSequence = 0;
  let totalRequestSequence = 0;
  const closingSessionRequests = new Map();
  let disposed = false;

  function liveSessionIds() {
    return new Set(
      (workspace.tabs || [])
        .map((tab) => String(tab?.sessionId || ""))
        .filter(Boolean),
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

  let ownedSessionIds = liveSessionIds();
  const stopSessionOwnershipWatch = watch(
    () => (workspace.tabs || []).map((tab) => String(tab?.sessionId || "")),
    (sessionIds) => {
      const nextSessionIds = new Set(sessionIds.filter(Boolean));
      const removedSessionIds = [...ownedSessionIds].filter((sessionId) => !nextSessionIds.has(sessionId));
      ownedSessionIds = nextSessionIds;
      removedSessionIds.forEach((sessionId) => {
        void closeOwnedSession(sessionId);
      });
    },
  );

  async function dispose() {
    if (disposed) return;
    disposed = true;
    stopSessionOwnershipWatch();
    const remainingSessionIds = new Set([...ownedSessionIds, ...liveSessionIds()]);
    ownedSessionIds.clear();
    await Promise.all([...remainingSessionIds].map(closeOwnedSession));
  }

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
    const filterMode = String(initialState?.filterMode || "fuzzy");
    return workspace.tabs.find(
      (tab) =>
        (tab.kind || "data") === "data" &&
        paneIncludesTab(paneId, tab) &&
        sameSource(tab.connectionId, tab.database, connectionId, database) &&
        String(tab.tableName || "") === String(tableName || "") &&
        Boolean(tab.hitResultMode) === hitResultMode &&
        (!hitResultMode || (searchText(tab) === query && String(tab.filterMode || "fuzzy") === filterMode)),
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

  function cancelExactTotalRefresh(tab) {
    if (!tab?.id) return;
    currentTotalRequestByTab.set(tab.id, ++totalRequestSequence);
    tab.totalRowsLoading = false;
    tab.totalRowsError = "";
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
    tab.hitResultMode = false;
    tab.hitResultSourceTabId = "";
    tab.hitResultSourcePaneId = "";
    tab.sort = null;
    tab.fullyLoaded = false;
    tab.loadError = null;
    tab.loadMoreError = "";
  }

  function buildBackendFilter(tab) {
    const query = String(tab?.filter || tab?.searchQuery || "").trim();
    if (!query) return null;
    return {
      query,
      columns: [],
      mode: tab.filterMode || "fuzzy",
    };
  }

  function buildExactTotalRequest(tab) {
    return {
      page: 1,
      pageSize: 1,
      includeTotal: true,
      filter: usesBackendFilter(tab) ? buildBackendFilter(tab) : null,
      sort: null,
    };
  }

  function markTotalLoadingFinished(tabId, requestToken, error = null) {
    const tab = findTabById(tabId);
    if (!tab || currentTotalRequestByTab.get(tabId) !== requestToken) return null;
    tab.totalRowsLoading = false;
    tab.totalRowsError = error ? String(error?.message || error) : "";
    return tab;
  }

  function scheduleExactTotalRefresh(tab) {
    if (!tab?.sessionId || tab.totalRowsExact !== false || tab.hasMore === false) return;
    const tabId = tab.id;
    const sessionId = tab.sessionId;
    const requestToken = ++totalRequestSequence;
    currentTotalRequestByTab.set(tabId, requestToken);
    tab.totalRowsLoading = true;
    tab.totalRowsError = "";
    scheduleAfterFirstFrame(async () => {
      const currentTab = findTabById(tabId);
      if (!currentTab || currentTotalRequestByTab.get(tabId) !== requestToken) return;
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
          () => invokeWorkbench("fetch_table_page", {
            sessionId,
            request: buildExactTotalRequest(currentTab),
          }),
          { tableName: currentTab.tableName },
        );
        const latestTab = findTabById(tabId);
        if (!latestTab || currentTotalRequestByTab.get(tabId) !== requestToken) return;
        if (latestTab.sessionId !== sessionId) {
          const staleTab = markTotalLoadingFinished(tabId, requestToken);
          if (staleTab && workspace.activeTabId === tabId) {
            const msg = tableStatusLabel(staleTab);
            if (setStatus) setStatus(msg);
            else statusText.value = msg;
          }
          return;
        }
        updateTabTotalMetadata(workspace, tabId, payload);
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

  async function ensureTableSchema(tableName, { connectionId = workspace.connectionId, database = workspace.database } = {}) {
    const schema = await invokeWorkbench("get_table_schema", { connectionId, database, tableName });
    if (!sameSource(workspace.connectionId, workspace.database, connectionId, database)) return schema;
    const sourcedSchema = { ...schema, connectionId: connectionId || "", database: database || "" };
    const index = workspace.schema.findIndex(
      (item) => normalizeTableName(item) === tableName,
    );
    if (index >= 0) workspace.schema[index] = sourcedSchema;
    else workspace.schema.push(sourcedSchema);
    return schema;
  }

  async function loadFirstPageIntoTab(
    tab,
    table,
    { connectionId = workspace.connectionId, database = workspace.database, tableName = normalizeTableName(table), readOnly = Boolean(table?.readOnly || table?.read_only), activateWhenReady = false } = {},
  ) {
    if (!tab) return null;
    busy.value = true;
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
      // Background refresh of workspace.schema (sidebar tree) — fire-and-forget.
      // Retains the sameSource stale-guard inside ensureTableSchema.
      ensureTableSchema(tableName, { connectionId, database }).catch(() => {});
      if (activateWhenReady) activateTableTab(workspace, tab.id);
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
    } finally {
      if (!requestToken || isCurrentTabRequest(tab.id, requestToken)) busy.value = false;
    }
  }

  async function openTable(table, { activate = true, paneId = "", duplicate = false, initialState = null } = {}) {
    const tableName = normalizeTableName(table);
    if (!tableName) return;
    const connectionId = String(table?.connectionId || table?.connection_id || workspace.connectionId || "");
    const database = String(table?.database || workspace.database || "");
    const readOnly = Boolean(table?.readOnly || table?.read_only);
    const targetPaneId = paneId || workspace.focusedPaneId || "";
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
      if (activate) activateTableTab(workspace, existingTab.id);
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
        activateWhenReady: false,
      });
      return loadedTab || existingTab;
    }
    const activateImmediately = activate && (!workspace.activeTabId || Boolean(existingTab));
    const activateWhenReady = activate && !activateImmediately;
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
      filterMode: initialState?.filterMode || "fuzzy",
    }, { activate: activateImmediately, paneId: targetPaneId });
    tab.readOnly = readOnly;
    if (initialState) {
      tab.filter = String(initialState.filter ?? tab.filter ?? "");
      tab.searchQuery = String(initialState.searchQuery ?? initialState.filter ?? tab.searchQuery ?? "");
      tab.filterMode = String(initialState.filterMode || tab.filterMode || "fuzzy");
      tab.sort = initialState.sort ? { ...initialState.sort } : tab.sort || null;
      tab.hitResultMode = Boolean(initialState.hitResultMode);
      tab.hitResultSourceTabId = String(initialState.hitResultSourceTabId || "");
      tab.hitResultSourcePaneId = String(initialState.hitResultSourcePaneId || "");
    }
    return loadFirstPageIntoTab(tab, table, {
      connectionId,
      database,
      tableName,
      readOnly,
      activateWhenReady,
    });
  }

  function buildPageRequest(tab, page, { includeFilter = false } = {}) {
    return {
      page,
      pageSize: REQUEST_PAGE_SIZE,
      includeTotal: false,
      filter: includeFilter && usesBackendFilter(tab) ? buildBackendFilter(tab) : null,
      sort: tab.sort || null,
    };
  }

  function buildOpenSessionOptions(tab) {
    const request = buildPageRequest(tab, 1, { includeFilter: usesBackendFilter(tab) });
    if (!request.filter) delete request.filter;
    if (!request.sort) delete request.sort;
    return request;
  }

  async function fetchPage(tab, page) {
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
    if (!tab?.sessionId || tab.loading || tab.loadingMore || tab.fullyLoaded || tab.hasMore === false) return false;
    const totalRows = Math.max(0, Math.floor(Number(tab.totalRows) || 0));
    if (tab.totalRowsExact !== false && totalRows > 0 && tabRowCount(tab) >= totalRows) {
      tab.fullyLoaded = true;
      return false;
    }
    const requestToken = beginTabRequest(tab.id);
    tab.loadingMore = true;
    try {
      const effectivePageSize = Math.max(1, Math.floor(Number(tab.pageSize) || REQUEST_PAGE_SIZE));
      const nextPage = Math.floor(tabRowCount(tab) / effectivePageSize) + 1;
      const payload = await measureAsync(
        "table.fetchMore.invoke",
        () => invokeWorkbench("fetch_table_page", {
          sessionId: tab.sessionId,
          request: buildPageRequest(tab, nextPage, { includeFilter: usesBackendFilter(tab) }),
        }),
        { tableName: tab.tableName, page: nextPage },
      );
      if (!isCurrentTabRequest(tab.id, requestToken)) return false;
      appendTabPage(workspace, tab.id, payload);
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

  async function loadSearchResultPage(tab, query) {
    if (!tab?.sessionId) return false;
    const text = String(query ?? tab.searchQuery ?? tab.filter ?? "").trim();
    if (!text) {
      tab.searchResultMode = false;
      tab.searchResultQuery = "";
      return fetchPage(tab, 1).then((result) => Boolean(result?.ok));
    }
    cancelExactTotalRefresh(tab);
    const requestToken = beginTabRequest(tab.id);
    tab.searchResultMode = true;
    tab.searchResultQuery = text;
    tab.filter = text;
    tab.searchQuery = text;
    tab.loading = true;
    tab.loadingMore = false;
    tab.loadError = null;
    try {
      const payload = await measureAsync(
        "table.searchResults.invoke",
        () => invokeWorkbench("fetch_table_page", {
          sessionId: tab.sessionId,
          request: buildPageRequest(tab, 1, { includeFilter: true }),
        }),
        { tableName: tab.tableName },
      );
      if (!isCurrentTabRequest(tab.id, requestToken)) return false;
      replaceTabPage(workspace, tab.id, payload);
      const latestTab = findTabById(tab.id) || tab;
      latestTab.searchResultMode = true;
      latestTab.searchResultQuery = text;
      latestTab.filter = text;
      latestTab.searchQuery = text;
      latestTab.loadError = null;
      const hitCount = Array.isArray(payload.rows) ? payload.rows.length : 0;
      const msg = hitCount > 0 ? `全表搜索命中 ${hitCount}+ 行` : "当前表未找到匹配内容";
      if (setStatus) setStatus(msg);
      else statusText.value = msg;
      return true;
    } catch (error) {
      if (!isCurrentTabRequest(tab.id, requestToken)) return false;
      tab.searchResultMode = false;
      tab.searchResultQuery = "";
      tab.loading = false;
      tab.loadError = String(error?.message || error);
      const msg = `全表搜索失败：${String(error?.message || error)}`;
      if (setStatus) setStatus(msg, { error: true });
      else statusText.value = msg;
      return false;
    } finally {
      if (isCurrentTabRequest(tab.id, requestToken)) tab.loading = false;
    }
  }

  function toggleSort(tab, column) {
    const current = tab.sort;
    const nextDescending =
      current?.columnName === column ? !current.descending : false;
    tab.sort = { columnName: column, descending: nextDescending };
    return fetchPage(tab, 1);
  }

  function applySort(tab, column, direction) {
    if (direction === "none") {
      tab.sort = null;
    } else {
      tab.sort = { columnName: column, descending: direction === "descending" };
    }
    return fetchPage(tab, 1);
  }

  return {
    openTable,
    fetchPage,
    loadNextPage,
    loadSearchResultPage,
    toggleSort,
    applySort,
    dispose,
  };
}
