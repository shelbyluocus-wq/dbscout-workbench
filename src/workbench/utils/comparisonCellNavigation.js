let activeComparisonGrid = null;

export function setActiveComparisonGrid(token) {
  activeComparisonGrid = token || null;
}

export function claimComparisonGridIfIdle(token) {
  if (activeComparisonGrid == null && token) activeComparisonGrid = token;
  return activeComparisonGrid === token;
}

export function clearActiveComparisonGrid(token) {
  if (token == null || activeComparisonGrid === token) activeComparisonGrid = null;
}

export function isActiveComparisonGrid(token) {
  return activeComparisonGrid === token;
}

export function nearestScrollStart(viewStart, viewSize, itemStart, itemSize) {
  const start = Number(viewStart) || 0;
  const size = Number(viewSize) || 0;
  const item = Number(itemStart) || 0;
  const extent = Number(itemSize) || 0;
  if (item < start) return item;
  if (item + extent > start + size) return item + extent - size;
  return start;
}

export function comparisonColumnNames(columns, showPrimaryKeys = true) {
  const list = (Array.isArray(columns) ? columns : [])
    .map((column) => (
      typeof column === "string"
        ? { name: column, primaryKey: false }
        : { name: String(column?.name || ""), primaryKey: Boolean(column?.primaryKey) }
    ))
    .filter((column) => column.name);
  const visible = showPrimaryKeys ? list : list.filter((column) => !column.primaryKey);
  const frozen = visible.filter((column) => column.primaryKey);
  const scroll = visible.filter((column) => !column.primaryKey);
  return [...frozen, ...scroll].map((column) => column.name);
}

export function comparisonArrowDelta(event) {
  const key = event?.key;
  if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const step = (event.ctrlKey || event.metaKey) ? Number.POSITIVE_INFINITY : 1;
  if (key === "ArrowUp") return { deltaRow: -step, deltaCol: 0 };
  if (key === "ArrowDown") return { deltaRow: step, deltaCol: 0 };
  if (key === "ArrowLeft") return { deltaRow: 0, deltaCol: -step };
  return { deltaRow: 0, deltaCol: step };
}

function isNavigableRow(row) {
  return Boolean(row) && row.status !== "error";
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function moveComparisonCell({
  rows,
  columnNames,
  selected,
  deltaRow = 0,
  deltaCol = 0,
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const cols = Array.isArray(columnNames) ? columnNames.filter(Boolean) : [];
  const navigable = [];
  for (let index = 0; index < list.length; index += 1) {
    if (isNavigableRow(list[index])) navigable.push(index);
  }
  if (!navigable.length || !cols.length) return null;

  const selectedRowIndex = selected?.rowId == null
    ? -1
    : list.findIndex((row) => row.id === selected.rowId);
  const hasRow = selectedRowIndex >= 0 && isNavigableRow(list[selectedRowIndex]);
  let rowPos = hasRow ? navigable.indexOf(selectedRowIndex) : -1;
  let colIndex = selected?.column == null ? -1 : cols.indexOf(selected.column);

  if (rowPos < 0) {
    const towardStart = deltaRow > 0 || (deltaRow === 0 && deltaCol >= 0);
    rowPos = towardStart ? 0 : navigable.length - 1;
    colIndex = towardStart ? 0 : cols.length - 1;
  } else {
    if (colIndex < 0) colIndex = 0;
    rowPos = clamp(rowPos + deltaRow, 0, navigable.length - 1);
    colIndex = clamp(colIndex + deltaCol, 0, cols.length - 1);
  }

  const rowIndex = navigable[rowPos];
  return {
    row: list[rowIndex],
    rowIndex,
    column: cols[colIndex],
  };
}

function closest(target, selector) {
  if (target && typeof target.closest === "function") return target.closest(selector);
  return null;
}

export function isComparisonCellNavigationBlocked(target) {
  if (!target) return false;
  if (closest(target, '[role="separator"]')) return true;
  const field = closest(target, "input, textarea, select, [contenteditable='true']");
  if (!field) return false;
  if (field.isContentEditable) return true;
  const tag = String(field.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return true;
  const type = String(field.type || "text").toLowerCase();
  if (type === "checkbox" || type === "radio" || type === "button" || type === "submit") return false;
  return Boolean(String(field.value || ""));
}

export function shouldHandleComparisonCellNavigation(event, root) {
  if (!event || !comparisonArrowDelta(event) || event.altKey) return false;
  if (isComparisonCellNavigationBlocked(event.target)) return false;
  const origin = closest(event.target, ".wb-batch-diff");
  if (origin && root && origin !== root && !root.contains?.(origin)) return false;
  if (root && (origin === root || root.contains?.(event.target))) {
    setActiveComparisonGrid(root);
    return true;
  }
  claimComparisonGridIfIdle(root);
  return isActiveComparisonGrid(root);
}
