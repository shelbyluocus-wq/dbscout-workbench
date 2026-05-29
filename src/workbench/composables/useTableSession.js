import { REQUEST_PAGE_SIZE } from "../constants.js";
import {
  normalizeTableName,
  normalizeTableComment,
  columnName,
} from "../utils/normalize.js";
import { openTableTab, replaceTabPage, appendTabPage } from "../workspaceState.js";

export function useTableSession(workspace, invokeWorkbench, { busy, statusText }) {
  const currentRequestByTab = new Map();
  let requestSequence = 0;

  function sameSource(leftConnectionId, leftDatabase, rightConnectionId, rightDatabase) {
    return String(leftConnectionId || "") === String(rightConnectionId || "") && String(leftDatabase || "") === String(rightDatabase || "");
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

  async function openTable(table) {
    const tableName = normalizeTableName(table);
    if (!tableName) return;
    const connectionId = String(table?.connectionId || table?.connection_id || workspace.connectionId || "");
    const database = String(table?.database || workspace.database || "");
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
      });
      requestToken = beginTabRequest(tab.id);
      tab.loading = true;
      const schema = await ensureTableSchema(tableName, { connectionId, database });
      if (!isCurrentTabRequest(tab.id, requestToken)) return;
      const page = await invokeWorkbench("open_table_session", {
        connectionId,
        database,
        tableName,
        options: { page: 1, pageSize: REQUEST_PAGE_SIZE },
      });
      if (!isCurrentTabRequest(tab.id, requestToken)) return;
      replaceTabPage(workspace, tab.id, page);
      tab.primaryKeys =
        page.primaryKeys ||
        schema.columns
          ?.filter((column) => column.is_primary_key)
          .map(columnName) ||
        [];
      tab.tableComment = page.tableComment || normalizeTableComment(schema);
      statusText.value = `${database ? `${database}.` : ""}${tableName}：${page.totalRows} 行`;
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

  async function fetchPage(tab, page) {
    if (!tab?.sessionId) return;
    const requestToken = beginTabRequest(tab.id);
    tab.loading = true;
    try {
      const payload = await invokeWorkbench("fetch_table_page", {
        sessionId: tab.sessionId,
        request: buildPageRequest(tab, page),
      });
      if (!isCurrentTabRequest(tab.id, requestToken)) return;
      replaceTabPage(workspace, tab.id, payload);
      tab.primaryKeys = payload.primaryKeys || tab.primaryKeys || [];
      statusText.value = `${tab.database ? `${tab.database}.` : ""}${tab.tableName}：${payload.totalRows} 行`;
    } catch (error) {
      if (isCurrentTabRequest(tab.id, requestToken)) {
        tab.loading = false;
        statusText.value = `读取分页失败：${String(error)}`;
      }
    } finally {
      if (isCurrentTabRequest(tab.id, requestToken)) tab.loading = false;
    }
  }

  async function loadNextPage(tab) {
    if (!tab?.sessionId || tab.loadingMore || tab.fullyLoaded) return false;
    const totalRows = Math.max(0, Math.floor(Number(tab.totalRows) || 0));
    if (totalRows > 0 && (tab.rows?.length || 0) >= totalRows) {
      tab.fullyLoaded = true;
      return false;
    }
    const requestToken = beginTabRequest(tab.id);
    tab.loadingMore = true;
    try {
      const nextPage = Math.max(
        Math.floor(((tab.rows?.length || 0) / REQUEST_PAGE_SIZE)) + 1,
        Math.floor(Number(tab.page) || 1) + 1,
      );
      const payload = await invokeWorkbench("fetch_table_page", {
        sessionId: tab.sessionId,
        request: buildPageRequest(tab, nextPage),
      });
      if (!isCurrentTabRequest(tab.id, requestToken)) return false;
      appendTabPage(workspace, tab.id, payload);
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

  return {
    openTable,
    fetchPage,
    loadNextPage,
    toggleSort,
  };
}
