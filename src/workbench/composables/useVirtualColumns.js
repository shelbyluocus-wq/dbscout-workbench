import { MIN_COL_WIDTH, ROW_INDEX_WIDTH } from "../constants.js";
import { ensureColumnWidthState } from "./useColumnResize.js";

export const COLUMN_OVERSCAN_PX = 240;

/**
 * 按前缀和计算需要渲染的列。返回的 segments 按列序排列，占位格带精确宽度，
 * 使得 Σ(渲染列宽) + Σ(占位格宽) 恒等于全部列宽之和（滚动条几何不变）。
 * 坐标系：x = 0 为第一列左边缘（行号栏不计入）；冻结列与行号栏是 sticky 的，
 * 所以非冻结列的可见区间是 [scrollLeft + frozenWidth, scrollLeft + viewportWidth - gutterWidth]。
 */
export function computeColumnWindow({
  widths,
  frozenCount = 0,
  scrollLeft = 0,
  viewportWidth = 0,
  gutterWidth = ROW_INDEX_WIDTH,
  overscanPx = COLUMN_OVERSCAN_PX,
  pinned = [],
} = {}) {
  const total = Array.isArray(widths) ? widths.length : 0;
  const offsets = new Array(total + 1);
  offsets[0] = 0;
  for (let index = 0; index < total; index += 1) {
    const width = Number(widths[index]);
    offsets[index + 1] = offsets[index] + (Number.isFinite(width) && width > 0 ? width : MIN_COL_WIDTH);
  }
  const frozen = Math.max(0, Math.min(total, Math.floor(frozenCount) || 0));
  const frozenWidth = offsets[frozen];
  const rendered = new Set();
  for (let index = 0; index < frozen; index += 1) rendered.add(index);

  const visibleWidth = Math.max(0, viewportWidth - gutterWidth);
  const windowAll = viewportWidth <= 0 || offsets[total] <= visibleWidth;
  if (windowAll) {
    for (let index = frozen; index < total; index += 1) rendered.add(index);
  } else {
    const left = Math.max(0, scrollLeft) + frozenWidth - overscanPx;
    const right = Math.max(0, scrollLeft) + visibleWidth + overscanPx;
    for (let index = frozen; index < total; index += 1) {
      if (offsets[index + 1] > left && offsets[index] < right) rendered.add(index);
    }
  }
  for (const index of pinned) {
    if (Number.isInteger(index) && index >= 0 && index < total) rendered.add(index);
  }

  const renderedIndexes = [...rendered].sort((a, b) => a - b);
  const segments = [];
  let cursor = 0;
  for (const index of renderedIndexes) {
    if (index > cursor) segments.push({ kind: "spacer", key: `spacer-${cursor}`, from: cursor, to: index, width: offsets[index] - offsets[cursor] });
    segments.push({ kind: "column", key: `column-${index}`, index });
    cursor = index + 1;
  }
  if (cursor < total) segments.push({ kind: "spacer", key: `spacer-${cursor}`, from: cursor, to: total, width: offsets[total] - offsets[cursor] });

  return {
    segments,
    renderedIndexes,
    allRendered: renderedIndexes.length === total,
    offsets,
    frozenCount: frozen,
    frozenWidth,
    totalWidth: offsets[total],
    signature: `${renderedIndexes.join(",")}|${segments.filter((segment) => segment.kind === "spacer").map((segment) => `${segment.from}:${segment.width}`).join(",")}`,
  };
}

/** 读取某个 tab 当前各列宽度（列顺序 = tab.columns 顺序），未知宽度用 MIN_COL_WIDTH。 */
export function columnWidthsOf(tab, columnMeta) {
  const state = ensureColumnWidthState(tab);
  return (Array.isArray(columnMeta) ? columnMeta : []).map((meta) => {
    const width = Number(state?.widths?.[meta?.name]);
    return Number.isFinite(width) && width > 0 ? width : MIN_COL_WIDTH;
  });
}
