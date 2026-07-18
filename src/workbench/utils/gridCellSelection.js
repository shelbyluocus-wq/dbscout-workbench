function clonePosition(position) {
  return position ? { ...position } : null;
}

export function gridCellCoordinateKey(rowIndex, columnIndex) {
  return `${Number(rowIndex)}:${Number(columnIndex)}`;
}

export function gridSelectionBaseBounds(selection) {
  if (!selection?.anchor || !selection?.focus) return null;
  return {
    top: Math.min(selection.anchor.rowIndex, selection.focus.rowIndex),
    bottom: Math.max(selection.anchor.rowIndex, selection.focus.rowIndex),
    left: Math.min(selection.anchor.columnIndex, selection.focus.columnIndex),
    right: Math.max(selection.anchor.columnIndex, selection.focus.columnIndex),
  };
}

export function createGridSelection(tabId, anchor, focus = anchor, options = {}) {
  if (!tabId || !anchor || !focus) return null;
  return {
    tabId,
    anchor: clonePosition(anchor),
    focus: clonePosition(focus),
    shiftAnchor: clonePosition(options.shiftAnchor || anchor),
    toggledCells: (options.toggledCells || []).map(clonePosition).filter(Boolean),
  };
}

export function cloneGridSelection(selection) {
  if (!selection) return null;
  return createGridSelection(selection.tabId, selection.anchor, selection.focus, {
    shiftAnchor: selection.shiftAnchor || selection.anchor,
    toggledCells: selection.toggledCells || [],
  });
}

export function gridSelectionToggleMap(selection) {
  const toggles = new Map();
  for (const position of selection?.toggledCells || []) {
    if (!Number.isInteger(position?.rowIndex) || !Number.isInteger(position?.columnIndex)) continue;
    toggles.set(gridCellCoordinateKey(position.rowIndex, position.columnIndex), position);
  }
  return toggles;
}

export function isCoordinateInGridSelectionBase(selection, rowIndex, columnIndex) {
  const bounds = gridSelectionBaseBounds(selection);
  if (!bounds) return false;
  return rowIndex >= bounds.top
    && rowIndex <= bounds.bottom
    && columnIndex >= bounds.left
    && columnIndex <= bounds.right;
}

export function isGridCellSelected(selection, rowIndex, columnIndex, toggleKeys = null) {
  if (!selection) return false;
  const baseSelected = isCoordinateInGridSelectionBase(selection, rowIndex, columnIndex);
  const key = gridCellCoordinateKey(rowIndex, columnIndex);
  const toggled = toggleKeys
    ? toggleKeys.has(key)
    : gridSelectionToggleMap(selection).has(key);
  return toggled ? !baseSelected : baseSelected;
}

export function gridSelectionCount(selection) {
  const bounds = gridSelectionBaseBounds(selection);
  if (!bounds) return 0;
  const baseCount = (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1);
  let count = baseCount;
  for (const position of gridSelectionToggleMap(selection).values()) {
    count += isCoordinateInGridSelectionBase(selection, position.rowIndex, position.columnIndex) ? -1 : 1;
  }
  return Math.max(0, count);
}

export function toggleGridSelectionCell(selection, tabId, position) {
  if (!selection || selection.tabId !== tabId) {
    return { selection: createGridSelection(tabId, position), selected: true };
  }

  const toggles = gridSelectionToggleMap(selection);
  const key = gridCellCoordinateKey(position.rowIndex, position.columnIndex);
  if (toggles.has(key)) toggles.delete(key);
  else toggles.set(key, clonePosition(position));

  const next = createGridSelection(tabId, selection.anchor, selection.focus, {
    shiftAnchor: selection.shiftAnchor || selection.anchor,
    toggledCells: [...toggles.values()],
  });
  const selected = isGridCellSelected(next, position.rowIndex, position.columnIndex, new Set(toggles.keys()));
  return { selection: gridSelectionCount(next) > 0 ? next : null, selected };
}

export function gridSelectionActualBounds(selection) {
  const base = gridSelectionBaseBounds(selection);
  if (!base) return null;
  const toggles = gridSelectionToggleMap(selection);
  const excludedRows = new Map();
  const excludedColumns = new Map();
  const extras = [];

  for (const position of toggles.values()) {
    if (isCoordinateInGridSelectionBase(selection, position.rowIndex, position.columnIndex)) {
      excludedRows.set(position.rowIndex, (excludedRows.get(position.rowIndex) || 0) + 1);
      excludedColumns.set(position.columnIndex, (excludedColumns.get(position.columnIndex) || 0) + 1);
    } else {
      extras.push(position);
    }
  }

  const baseWidth = base.right - base.left + 1;
  const baseHeight = base.bottom - base.top + 1;
  let top = base.top;
  let bottom = base.bottom;
  let left = base.left;
  let right = base.right;
  while (top <= bottom && excludedRows.get(top) === baseWidth) top++;
  while (bottom >= top && excludedRows.get(bottom) === baseWidth) bottom--;
  while (left <= right && excludedColumns.get(left) === baseHeight) left++;
  while (right >= left && excludedColumns.get(right) === baseHeight) right--;

  let bounds = top <= bottom && left <= right ? { top, bottom, left, right } : null;
  for (const position of extras) {
    if (!bounds) {
      bounds = {
        top: position.rowIndex,
        bottom: position.rowIndex,
        left: position.columnIndex,
        right: position.columnIndex,
      };
      continue;
    }
    bounds.top = Math.min(bounds.top, position.rowIndex);
    bounds.bottom = Math.max(bounds.bottom, position.rowIndex);
    bounds.left = Math.min(bounds.left, position.columnIndex);
    bounds.right = Math.max(bounds.right, position.columnIndex);
  }
  return bounds;
}

export function gridSelectionMask(selection, bounds = gridSelectionActualBounds(selection)) {
  if (!selection || !bounds) return [];
  const toggleKeys = new Set(gridSelectionToggleMap(selection).keys());
  return Array.from({ length: bounds.bottom - bounds.top + 1 }, (_, rowOffset) => (
    Array.from({ length: bounds.right - bounds.left + 1 }, (_, columnOffset) => (
      isGridCellSelected(selection, bounds.top + rowOffset, bounds.left + columnOffset, toggleKeys)
    ))
  ));
}

export function gridSelectionIsContiguous(selection) {
  const bounds = gridSelectionActualBounds(selection);
  if (!bounds) return false;
  const area = (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1);
  return gridSelectionCount(selection) === area;
}

export function gridSelectionIsDiscreteCell(selection, rowIndex, columnIndex) {
  if (!isGridCellSelected(selection, rowIndex, columnIndex)) return false;
  return !isCoordinateInGridSelectionBase(selection, rowIndex, columnIndex);
}
