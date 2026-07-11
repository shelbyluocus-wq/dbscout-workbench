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
    freezeRows: coversAllRows ? 0 : rowIndex + 1,
    freezeColumns: (coversAllRows ? rightmostColumn : columnIndex) + 1,
  };
}

export function applyResolvedFreeze({ freezePanes, tab, target } = {}) {
  if (!freezePanes || !tab || !target) return false;

  freezePanes.clearFreeze(tab);
  freezePanes.setFreezeRows(tab, target.freezeRows);
  freezePanes.setFreezeColumns(tab, target.freezeColumns);
  return true;
}
