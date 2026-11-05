import { REQUEST_PAGE_SIZE } from "../constants.js";

export function primaryKeyFilter(tab, identity) {
  const keys = tab?.primaryKeys || [];
  if (!keys.length) throw new Error("该表没有主键，不能跨页精确定位；请先筛选或使用已加载行的 rowKey");
  if (!identity || keys.some((key) => !Object.hasOwn(identity, key))) {
    throw new Error(`跨页定位需要完整 rowIdentity：${keys.join("、")}`);
  }
  if (Object.keys(identity).some((key) => !keys.includes(key))) {
    throw new Error("rowIdentity 只能包含该表的完整主键字段");
  }
  const entries = keys.map((key) => {
    const value = identity[key];
    if (!["string", "number"].includes(typeof value) || (typeof value === "number" && !Number.isSafeInteger(value))
      || !String(value).trim() || String(value) !== String(value).trim()) {
      throw new Error("主键必须为非空、无首尾空白的字符串或安全整数；大整数请传字符串");
    }
    return { column: key, values: [String(value)] };
  });
  return { ...entries[0], kind: "equals", sourceConstraints: entries.slice(1) };
}

export function gridViewportSnapshot(wrap, tab) {
  if (!wrap || !tab) return null;
  const viewport = wrap.getBoundingClientRect();
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const header = wrap.querySelector("thead")?.getBoundingClientRect();
  const bodyTop = Math.max(viewport.top, header?.bottom || viewport.top);
  const rows = new Set();
  const columns = new Set();
  for (const cell of wrap.querySelectorAll("td[data-row-key][data-column-name]")) {
    const rect = cell.getBoundingClientRect();
    if (rect.bottom <= bodyTop || rect.top >= viewport.bottom || rect.right <= viewport.left || rect.left >= viewport.right) continue;
    rows.add(cell.dataset.rowKey);
    columns.add(cell.dataset.columnName);
  }
  return {
    scrollTop: wrap.scrollTop, scrollLeft: wrap.scrollLeft,
    width: wrap.clientWidth, height: wrap.clientHeight,
    visibleRowKeys: [...rows], visibleColumns: [...columns],
    coordinateSystem: "viewport-intersecting rendered cells; frozen cells included",
  };
}

export async function scrollControlGrid({ tab, direction, screens = 1, getWrap, restore, nextTick, fetchPage, loadNextPage, loadPreviousPage, jumpToTableBoundary, rowHeight, rowCount, pageSize = REQUEST_PAGE_SIZE }) {
  if (!["up", "down", "left", "right", "top", "bottom"].includes(direction)
    || !Number.isInteger(screens) || screens < 1 || screens > 5) throw new Error("无效滚动方向或屏数");
  let wrap = getWrap();
  if (!wrap) throw new Error("表格尚未显示，请重试");
  const horizontal = ["left", "right"].includes(direction);
  const left = horizontal ? wrap.scrollLeft + (direction === "left" ? -1 : 1) * wrap.clientWidth * screens : wrap.scrollLeft;
  let top = wrap.scrollTop;
  if (!horizontal) {
    if (tab.loading || tab.boundaryLoading) throw new Error("表格正在加载，请稍后重试");
    if (["top", "bottom"].includes(direction)) {
      if (tab.loadingMore || tab.loadingPrevious) throw new Error("表格正在填充数据，请稍后重试");
      const result = await jumpToTableBoundary(tab, direction);
      if (!result?.ok) throw new Error(String(result?.error || "当前视图暂不支持首末行跳转，请等待加载或清除搜索"));
      await nextTick();
      wrap = getWrap();
      top = direction === "bottom" ? wrap.scrollHeight - wrap.clientHeight : 0;
    } else {
      top = Math.max(0, Math.min(wrap.scrollHeight - wrap.clientHeight,
        wrap.scrollTop + (direction === "up" ? -1 : 1) * Math.max(rowHeight, wrap.clientHeight - 100) * screens));
      const offset = Math.max(0, Number(tab.rowWindowOffset) || 0);
      const targetRow = Math.floor(top / rowHeight);
      const endRow = targetRow + Math.ceil(wrap.clientHeight / rowHeight);
      if (targetRow < offset || endRow >= offset + rowCount()) {
        if (tab.searchResultMode) {
          const result = direction === "up" ? await loadPreviousPage(tab) : await loadNextPage(tab);
          if (result?.error) throw new Error(String(result.error));
          if (tab.loadingMore || tab.loadingPrevious) throw new Error("搜索结果正在加载，请稍后重试");
        } else {
          const result = await fetchPage(tab, Math.floor(Math.max(0, targetRow - 10) / pageSize) + 1);
          if (!result?.ok) throw new Error(String(result?.error || "目标窗口加载失败，请重试"));
        }
        await nextTick();
      }
    }
  }
  wrap = getWrap();
  if (!wrap) throw new Error("表格视图已关闭");
  restore({ top: Math.max(0, Math.min(top, wrap.scrollHeight - wrap.clientHeight)), left: Math.max(0, Math.min(left, wrap.scrollWidth - wrap.clientWidth)) });
  await nextTick();
}
