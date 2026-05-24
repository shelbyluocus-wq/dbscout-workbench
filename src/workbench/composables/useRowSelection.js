import { buildRowKey, buildRowIdentity } from "../utils/rowIdentity.js";

export function useRowSelection(invokeWorkbench, { statusText }, { fetchPage }) {
  function toggleRowSelect(tab, row, event) {
    const key = buildRowKey(tab, row);
    const keys = tab.selectedRowKeys;
    if (event?.shiftKey && keys.size > 0) {
      const allKeys = tab.rows.map((r) => buildRowKey(tab, r));
      const lastKey = [...keys].pop();
      const from = allKeys.indexOf(lastKey);
      const to = allKeys.indexOf(key);
      const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
      for (let i = lo; i <= hi; i++) keys.add(allKeys[i]);
    } else {
      keys.has(key) ? keys.delete(key) : keys.add(key);
    }
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

  return { toggleRowSelect, toggleAllRows, deleteSelectedRows, deleteRow };
}
