import { resolveGridRowHeight } from "./gridRowHeight.js";

export function resolveFreezeTarget({ tabId, rowCount, selectedRange } = {}) {
  if (!tabId || selectedRange?.tabId !== tabId || !Number.isInteger(rowCount) || rowCount <= 0) {
    return null;
  }

  const anchorRow = selectedRange.anchor?.rowIndex;
  const anchorColumn = selectedRange.anchor?.columnIndex;
  const rowIndex = selectedRange.focus?.rowIndex;
  const columnIndex = selectedRange.focus?.columnIndex;
  const coordinates = [anchorRow, anchorColumn, rowIndex, columnIndex];

  if (!coordinates.every((value) => Number.isInteger(value) && value >= 0)) {
    return null;
  }

  const coversAllRows = Math.min(anchorRow, rowIndex) === 0
    && Math.max(anchorRow, rowIndex) >= rowCount - 1;
  const rightmostColumn = Math.max(anchorColumn, columnIndex);

  return {
    kind: coversAllRows ? "column" : "cell",
    rowIndex,
    columnIndex,
    freezeRows: coversAllRows ? 0 : rowIndex,
    freezeColumns: (coversAllRows ? rightmostColumn : columnIndex) + 1,
  };
}

export function resolveVisibleFrozenRows({ tab, freezeRows, scrollTop, maxFrozenRows } = {}) {
  const boundary = Math.max(0, Math.floor(Number(freezeRows) || 0));
  if (boundary === 0) return { start: 0, count: 0, end: 0 };

  const rowHeight = resolveGridRowHeight(tab);
  const firstVisibleRow = Math.max(0, Math.floor((Number(scrollTop) || 0) / rowHeight));
  const visibleStart = Math.min(boundary, firstVisibleRow);
  const count = Math.max(0, Math.min(
    boundary - visibleStart,
    Math.floor(Number(maxFrozenRows) || 0),
  ));

  // Keep the Excel pane boundary stable when the viewport limits how many
  // frozen rows can be rendered. Earlier frozen rows are already off-screen.
  const start = boundary - count;
  return { start, count, end: boundary };
}

export function applyResolvedFreeze({ freezePanes, tab, target, scrollTop, viewportHeight } = {}) {
  if (!freezePanes || !tab || !target) return false;

  const frozenRows = resolveVisibleFrozenRows({
    tab,
    freezeRows: target.freezeRows,
    scrollTop,
    maxFrozenRows: freezePanes.maxFrozenRowsForViewport(tab, viewportHeight),
  });
  freezePanes.clearFreeze(tab);
  freezePanes.setFreezeRows(tab, frozenRows.count, viewportHeight, frozenRows.start);
  freezePanes.setFreezeColumns(tab, target.freezeColumns);
  return true;
}
