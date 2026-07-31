export function tableWindowOffset(tab) {
  const offset = Math.floor(Number(tab?.rowWindowOffset) || 0);
  return Math.max(0, offset);
}

function normalizeRowCount(value) {
  const count = Math.floor(Number(value) || 0);
  return Math.max(0, count);
}

export function tableWindowEndRow(tab, loadedRowCount) {
  return tableWindowOffset(tab) + normalizeRowCount(loadedRowCount);
}

export function tableScrollRowCount(tab, loadedRowCount) {
  return Math.max(
    tableWindowEndRow(tab, loadedRowCount),
    normalizeRowCount(tab?.totalRows),
  );
}

export function tableWindowStartTop(tab, rowHeight) {
  const height = Math.max(0, Number(rowHeight) || 0);
  return tableWindowOffset(tab) * height;
}

export function tableWindowEndTop(tab, loadedRowCount, rowHeight) {
  const height = Math.max(0, Number(rowHeight) || 0);
  return tableWindowEndRow(tab, loadedRowCount) * height;
}

export function distanceToTableWindowStart(tab, scrollTop, rowHeight) {
  const top = Math.max(0, Number(scrollTop) || 0);
  return Math.max(0, top - tableWindowStartTop(tab, rowHeight));
}

export function distanceToTableWindowEnd(
  tab,
  loadedRowCount,
  scrollTop,
  viewportHeight,
  rowHeight,
) {
  const viewportBottom = Math.max(0, Number(scrollTop) || 0)
    + Math.max(0, Number(viewportHeight) || 0);
  return Math.max(0, tableWindowEndTop(tab, loadedRowCount, rowHeight) - viewportBottom);
}
