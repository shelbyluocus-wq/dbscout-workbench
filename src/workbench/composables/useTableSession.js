import { REQUEST_PAGE_SIZE } from "../constants.js";
import {
  normalizeTableName,
  normalizeTableComment,
} from "../utils/normalize.js";
import { activateTableTab, openTableTab, replaceTabPage, appendTabPage } from "../workspaceState.js";
import { markPerf, measureAsync, sampleNextFrame } from "../utils/performanceMarks.js";

export function useTableSession(workspace, invokeWorkbench, { busy, statusText }) {
  const currentRequestByTab = new Map();
  let requestSequence = 0;

  function sameSource(leftConnectionId, leftDatabase, rightConnectionId, rightDatabase) {
    return String(leftConnectionId || "") === String(rightConnectionId || "") && String(leftDatabase || "") === String(rightDatabase || "");
  }

  function paneIncludesTab(paneId, tab) {
    const pane = workspace.panes?.[paneId || workspace.focusedPaneId || "pane-1"];
    return Boolean(pane && tab?.id && pane.tabIds?.includes(tab.id));
  }

  function findExistingTab(connectionId, database, tableName, paneId = "") {
    return workspace.tabs.find(
      (tab) =>
        (tab.kind || "data") === "data" &&
        paneIncludesTab(paneId, tab) &&
        sameSource(tab.connectionId, tab.database, connectionId, database) &&
        String(tab.tableName || "") === String(tableName || ""),
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

  async function openTable(table, { activate = true, paneId = "", duplicate = false, initialState = null } = {}) {
    const tableName = normalizeTableName(table);
    if (!tableName) return;
    const connectionId = String(table?.connectionId || table?.connection_id || workspace.connectionId || "");
    const database = String(table?.database || workspace.database || "");
    const readOnly = Boolean(table?.readOnly || table?.read_only);
    const targetPaneId = paneId || workspace.focusedPaneId || "";
    const existingTab = duplicate ? null : findExistingTab(connectionId, database, tableName, targetPaneId);
    const activateImmediately = activate && (!workspace.activeTabId || Boolean(existingTab));
    const activateWhenReady = activate && !activateImmediately;
    busy.value = true;
    statusText.value = `加载 ${database ? `${database}.` : ""}${tableName}`;
    let tab;
    let requestToken;
    try {
      tab = openTableTab(workspace, {
        connectionId,
        database,
        tableName,
        tableComment: normalizeTableComment(table),
        readOnly,
      }, { activate: activateImmediately, paneId: targetPaneId });
      tab.readOnly = readOnly;
      requestToken = beginTabRequest(tab.id);
      if (initialState) {
        tab.filter = String(initialState.filter ?? tab.filter ?? "");
        tab.searchQuery = String(initialState.searchQuery ?? initialState.filter ?? tab.searchQuery ?? "");
        tab.filterMode = String(initialState.filterMode || tab.filterMode || "fuzzy");
        tab.sort = initialState.sort ? { ...initialState.sort } : tab.sort || null;
      }
      tab.loading = true;
      tab.loadingMore = false;
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
      if (!isCurrentTabRequest(tab.id, requestToken)) return;
      markPerf("table.page.replace.start", { tableName, rows: page.rows?.length || 0, columns: page.columns?.length || 0 });
      replaceTabPage(workspace, tab.id, page);
      tab = workspace.tabs.find((item) => item.id === tab.id) || tab;
      markPerf("table.page.replace.end", { tableName, rows: tab.rows?.length || 0, columns: tab.columns?.length || 0 });
      sampleNextFrame("table.first-grid-frame", { tableName, rows: tab.rows?.length || 0, columns: tab.columns?.length || 0 });
      tab.primaryKeys = page.primaryKeys || [];
      tab.tableComment = page.tableComment || "";
      // Background refresh of workspace.schema (sidebar tree) — fire-and-forget.
      // Retains the sameSource stale-guard inside ensureTableSchema.
      ensureTableSchema(tableName, { connectionId, database }).catch(() => {});
      if (activateWhenReady) activateTableTab(workspace, tab.id);
      statusText.value = `${database ? `${database}.` : ""}${tableName}：${page.totalRows} 行`;
      return tab;
    } catch (error) {
      if (!tab || !requestToken || isCurrentTabRequest(tab.id, requestToken)) {
        if (tab) tab.loading = false;
        statusText.value = `读取表失败：${String(error)}`;
      }
    } finally {
      if (!tab || !requestToken || isCurrentTabRequest(tab.id, requestToken)) busy.value = false;
    }
  }

  function buildPageRequest(tab, page, { includeFilter = false } = {}) {
    return {
      page,
      pageSize: REQUEST_PAGE_SIZE,
      filter: includeFilter && tab.filter
        ? {
            query: tab.filter,
            columns: [],
            mode: tab.filterMode || "fuzzy",
          }
        : null,
      sort: tab.sort || null,
    };
  }

  function buildOpenSessionOptions(tab) {
    const request = buildPageRequest(tab, 1, { includeFilter: true });
    if (!request.filter) delete request.filter;
    if (!request.sort) delete request.sort;
    return request;
  }

  async function fetchPage(tab, page) {
    if (!tab?.sessionId) return { ok: false, error: new Error("missing table session") };
    const requestToken = beginTabRequest(tab.id);
    tab.loading = true;
    tab.loadingMore = false;
    try {
      const payload = await measureAsync(
        "table.fetch.invoke",
        () => invokeWorkbench("fetch_table_page", {
          sessionId: tab.sessionId,
          request: buildPageRequest(tab, page),
        }),
        { tableName: tab.tableName, page },
      );
      if (!isCurrentTabRequest(tab.id, requestToken)) return { ok: false, stale: true };
      markPerf("table.page.replace.start", { tableName: tab.tableName, rows: payload.rows?.length || 0, columns: payload.columns?.length || 0 });
      replaceTabPage(workspace, tab.id, payload);
      markPerf("table.page.replace.end", { tableName: tab.tableName, rows: tab.rows?.length || 0, columns: tab.columns?.length || 0 });
      sampleNextFrame("table.grid-frame", { tableName: tab.tableName, rows: tab.rows?.length || 0, columns: tab.columns?.length || 0 });
      tab.primaryKeys = payload.primaryKeys || tab.primaryKeys || [];
      statusText.value = `${tab.database ? `${tab.database}.` : ""}${tab.tableName}：${payload.totalRows} 行`;
      return { ok: true, tab };
    } catch (error) {
      if (!isCurrentTabRequest(tab.id, requestToken)) return { ok: false, stale: true };
      tab.loading = false;
      statusText.value = `读取分页失败：${String(error)}`;
      return { ok: false, error };
    } finally {
      if (isCurrentTabRequest(tab.id, requestToken)) tab.loading = false;
    }
  }

  async function loadNextPage(tab) {
    if (!tab?.sessionId || tab.loading || tab.loadingMore || tab.fullyLoaded) return false;
    const totalRows = Math.max(0, Math.floor(Number(tab.totalRows) || 0));
    if (totalRows > 0 && (tab.rows?.length || 0) >= totalRows) {
      tab.fullyLoaded = true;
      return false;
    }
    const requestToken = beginTabRequest(tab.id);
    tab.loadingMore = true;
    try {
      const nextPage = Math.floor((tab.rows.length || 0) / REQUEST_PAGE_SIZE) + 1;
      const payload = await measureAsync(
        "table.fetchMore.invoke",
        () => invokeWorkbench("fetch_table_page", {
          sessionId: tab.sessionId,
          request: buildPageRequest(tab, nextPage),
        }),
        { tableName: tab.tableName, page: nextPage },
      );
      if (!isCurrentTabRequest(tab.id, requestToken)) return false;
      appendTabPage(workspace, tab.id, payload);
      markPerf("table.page.appended", { tableName: tab.tableName, rows: tab.rows?.length || 0, totalRows: tab.totalRows || 0 });
      sampleNextFrame("table.append-grid-frame", { tableName: tab.tableName, rows: tab.rows?.length || 0, columns: tab.columns?.length || 0 });
      tab.primaryKeys = payload.primaryKeys || tab.primaryKeys || [];
      statusText.value = `${tab.database ? `${tab.database}.` : ""}${tab.tableName}：已加载 ${tab.rows.length}/${tab.totalRows} 行`;
      return Array.isArray(payload.rows) && payload.rows.length > 0;
    } catch (error) {
      if (isCurrentTabRequest(tab.id, requestToken)) {
        tab.loadingMore = false;
        statusText.value = `继续读取失败：${String(error)}`;
      }
      return false;
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
    toggleSort,
    applySort,
  };
}
