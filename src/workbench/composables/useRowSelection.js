import { buildRowKey, buildRowIdentity } from "../utils/rowIdentity.js";

export function useRowSelection(invokeWorkbench, { statusText }, { fetchPage }) {
  let rowSelectionAnchor = null;

  function clearRowSelection(tab) {
    tab?.selectedRowKeys?.clear();
  }

  function toggleRowSelect(tab, row, event) {
    const key = buildRowKey(tab, row);
    const keys = tab.selectedRowKeys;
    const allKeys = tab.rows.map((r) => buildRowKey(tab, r));

    if (event?.shiftKey) {
      const from = allKeys.indexOf(rowSelectionAnchor || key);
      const to = allKeys.indexOf(key);
      keys.clear();
      if (from >= 0 && to >= 0) {
        const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
        for (let i = lo; i <= hi; i++) keys.add(allKeys[i]);
      } else {
        keys.add(key);
      }
      return;
    }

    if (event?.metaKey || event?.ctrlKey) {
      keys.has(key) ? keys.delete(key) : keys.add(key);
      rowSelectionAnchor = key;
      return;
    }

    keys.clear();
    keys.add(key);
    rowSelectionAnchor = key;
  }

  function toggleAllRows(tab) {
    if (!tab?.rows?.length) return;
    const keys = tab.selectedRowKeys;
    const allKeys = tab.rows.map((r) => buildRowKey(tab, r));
    if (keys.size === allKeys.length) {
      keys.clear();
    } else {
      keys.clear();
      for (const k of allKeys) keys.add(k);
    }
  }

  async function deleteSelectedRows(tab) {
    if (!tab || tab.selectedRowKeys.size === 0) return;
    const count = tab.selectedRowKeys.size;
    if (!window.confirm(`确定删除选中的 ${count} 行？`)) return;
    try {
      const identities = [...tab.selectedRowKeys]
        .map((key) => tab.rows.find((r) => buildRowKey(tab, r) === key))
        .filter(Boolean)
        .map((row) => buildRowIdentity(tab, row));
      await invokeWorkbench("delete_rows", {
        request: {
          sessionId: tab.sessionId,
          rowIdentities: identities,
        },
      });
      tab.selectedRowKeys = new Set();
      await fetchPage(tab, 1);
      statusText.value = `已删除 ${count} 行`;
    } catch (error) {
      statusText.value = `删除失败：${String(error)}`;
    }
  }

  async function deleteRow(tab, row) {
    if (!window.confirm(`删除 ${tab.tableName} 当前行？`)) return;
    try {
      await invokeWorkbench("delete_rows", {
        request: {
          sessionId: tab.sessionId,
          rowIdentities: [buildRowIdentity(tab, row)],
        },
      });
      const page = tab.rows.length <= 1 && tab.page > 1 ? tab.page - 1 : tab.page;
      await fetchPage(tab, page);
      statusText.value = "已删除 1 行";
    } catch (error) {
      statusText.value = `删除失败：${String(error)}`;
    }
  }

  return { clearRowSelection, toggleRowSelect, toggleAllRows, deleteSelectedRows, deleteRow };
}
