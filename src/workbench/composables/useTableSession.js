import { REQUEST_PAGE_SIZE } from "../constants.js";
import {
  normalizeTableName,
  normalizeTableComment,
  columnName,
} from "../utils/normalize.js";
import { openTableTab, replaceTabPage } from "../workspaceState.js";

export function useTableSession(workspace, invokeWorkbench, { busy, statusText }) {
  async function ensureTableSchema(tableName) {
    const schema = await invokeWorkbench("get_table_schema", { tableName });
    const index = workspace.schema.findIndex(
      (item) => normalizeTableName(item) === tableName,
    );
    if (index >= 0) workspace.schema[index] = schema;
    else workspace.schema.push(schema);
    return schema;
  }

  async function openTable(table) {
    const tableName = normalizeTableName(table);
    if (!tableName) return;
    busy.value = true;
    statusText.value = `加载 ${tableName}`;
    let tab;
    try {
      tab = openTableTab(workspace, {
        tableName,
        tableComment: normalizeTableComment(table),
      });
      tab.loading = true;
      const schema = await ensureTableSchema(tableName);
      const page = await invokeWorkbench("open_table_session", {
        tableName,
        options: { page: 1, pageSize: REQUEST_PAGE_SIZE },
      });
      replaceTabPage(workspace, tab.id, page);
      tab.primaryKeys =
        page.primaryKeys ||
        schema.columns
          ?.filter((column) => column.is_primary_key)
          .map(columnName) ||
        [];
      tab.tableComment = page.tableComment || normalizeTableComment(schema);
      statusText.value = `${tableName}：${page.totalRows} 行`;
    } catch (error) {
      if (tab) tab.loading = false;
      statusText.value = `读取表失败：${String(error)}`;
    } finally {
      busy.value = false;
    }
  }

  async function fetchPage(tab, page) {
    if (!tab?.sessionId) return;
    tab.loading = true;
    try {
      const payload = await invokeWorkbench("fetch_table_page", {
        sessionId: tab.sessionId,
        request: {
          page,
          pageSize: REQUEST_PAGE_SIZE,
          filter: tab.filter
            ? {
                query: tab.filter,
                columns: [],
                mode: tab.filterMode || "fuzzy",
              }
            : null,
          sort: tab.sort || null,
        },
      });
      replaceTabPage(workspace, tab.id, payload);
      tab.primaryKeys = payload.primaryKeys || tab.primaryKeys || [];
      statusText.value = `${tab.tableName}：${payload.totalRows} 行`;
    } catch (error) {
      tab.loading = false;
      statusText.value = `读取分页失败：${String(error)}`;
    } finally {
      tab.loading = false;
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
    toggleSort,
  };
}
