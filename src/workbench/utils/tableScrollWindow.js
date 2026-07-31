export function tableWindowOffset(tab) {
  const offset = Math.floor(Number(tab?.rowWindowOffset) || 0);
  return Math.max(0, offset);
}

export function tableWindowStartTop(tab, rowHeight) {
  const height = Math.max(0, Number(rowHeight) || 0);
  return tableWindowOffset(tab) * height;
}

export function distanceToTableWindowStart(tab, scrollTop, rowHeight) {
  const top = Math.max(0, Number(scrollTop) || 0);
  return Math.max(0, top - tableWindowStartTop(tab, rowHeight));
}
