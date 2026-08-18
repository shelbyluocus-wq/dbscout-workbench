import { columnName } from "./normalize.js";

export const COLUMN_ORDER_STORAGE_KEY = "dbscout.table.columnOrder.v1";
export const COLUMN_REORDER_THRESHOLD_PX = 5;
export const COLUMN_REORDER_EDGE_PX = 36;
export const COLUMN_REORDER_SCROLL_STEP = 28;

export function columnNamesOf(columns) {
  return (Array.isArray(columns) ? columns : [])
    .map((column) => columnName(column) || String(column || "").trim())
    .filter(Boolean);
}

export function normalizeColumnOrder(order) {
  if (!Array.isArray(order)) return [];
  const seen = new Set();
  const next = [];
  for (const item of order) {
    const name = typeof item === "string" ? item.trim() : columnName(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    next.push(name);
  }
  return next;
}

export function applyColumnOrder(columns, order) {
  const list = Array.isArray(columns) ? [...columns] : [];
  const preferred = normalizeColumnOrder(order);
  if (!list.length || !preferred.length) return list;
  const byName = new Map();
  for (const column of list) {
    const name = columnName(column);
    if (!name || byName.has(name)) continue;
    byName.set(name, column);
  }
  const seen = new Set();
  const next = [];
  for (const name of preferred) {
    const column = byName.get(name);
    if (!column) continue;
    seen.add(name);
    next.push(column);
  }
  for (const column of list) {
    const name = columnName(column);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    next.push(column);
  }
  return next;
}

export function migrateColumnOrder(order, renameMap) {
  const names = normalizeColumnOrder(order);
  if (!names.length || !renameMap || typeof renameMap.get !== "function") return names;
  const seen = new Set();
  const next = [];
  for (const name of names) {
    const mapped = String(renameMap.get(name) || name).trim();
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  return next;
}

export function sameFreezeZone(sourceIndex, targetIndex, frozenCount = 0) {
  const count = Math.max(0, Math.floor(Number(frozenCount) || 0));
  if (count <= 0) return true;
  if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)) return false;
  return (sourceIndex < count) === (targetIndex < count);
}

export function resolveColumnDrop({ sourceIndex, targetIndex, position = "before", frozenCount = 0 } = {}) {
  if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)) return null;
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return null;
  if (!sameFreezeZone(sourceIndex, targetIndex, frozenCount)) return null;
  const normalizedPosition = position === "after" ? "after" : "before";
  if (normalizedPosition === "before" && targetIndex === sourceIndex + 1) return null;
  if (normalizedPosition === "after" && targetIndex === sourceIndex - 1) return null;
  return { targetIndex, position: normalizedPosition };
}

export function moveColumn(columns, sourceName, targetName, position = "before", { frozenCount = 0 } = {}) {
  const list = Array.isArray(columns) ? [...columns] : [];
  const names = columnNamesOf(list);
  const sourceIndex = names.indexOf(sourceName);
  const targetIndex = names.indexOf(targetName);
  const drop = resolveColumnDrop({ sourceIndex, targetIndex, position, frozenCount });
  if (!drop) return Array.isArray(columns) ? columns : list;
  const [source] = list.splice(sourceIndex, 1);
  const adjustedTargetIndex = list.findIndex((column) => columnName(column) === targetName);
  if (adjustedTargetIndex < 0) return Array.isArray(columns) ? columns : list;
  list.splice(drop.position === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex, 0, source);
  return list;
}

export function sameColumnOrder(left, right) {
  const previous = normalizeColumnOrder(left);
  const next = normalizeColumnOrder(right);
  return previous.length === next.length && previous.every((name, index) => name === next[index]);
}

export function isCustomColumnOrder(columns, schemaNames) {
  const current = columnNamesOf(columns);
  const schema = normalizeColumnOrder(schemaNames);
  if (!current.length || !schema.length || current.length !== schema.length) {
    return current.join("\u001f") !== schema.join("\u001f");
  }
  return current.some((name, index) => name !== schema[index]);
}

export function remapColumnIndex(oldNames, newNames, oldIndex) {
  const previous = normalizeColumnOrder(oldNames);
  const next = normalizeColumnOrder(newNames);
  const name = previous[oldIndex];
  if (!name) return -1;
  return next.indexOf(name);
}

export function remapColumnIndexSet(oldNames, newNames, indexes) {
  const next = new Set();
  for (const index of indexes || []) {
    const mapped = remapColumnIndex(oldNames, newNames, index);
    if (mapped >= 0) next.add(mapped);
  }
  return next;
}

export function remapSelectionPosition(position, oldNames, newNames) {
  if (!position || typeof position !== "object") return position;
  const namedIndex = position.column
    ? normalizeColumnOrder(newNames).indexOf(position.column)
    : -1;
  const mappedIndex = namedIndex >= 0
    ? namedIndex
    : remapColumnIndex(oldNames, newNames, position.columnIndex);
  if (mappedIndex < 0) return { ...position };
  return { ...position, columnIndex: mappedIndex };
}

export function tableColumnOrderKey(tabOrKey) {
  if (typeof tabOrKey === "string") return tabOrKey;
  return [
    tabOrKey?.connectionId,
    tabOrKey?.database,
    tabOrKey?.tableName,
  ].map((value) => String(value ?? "").trim()).join("\u001f");
}

function readColumnOrderStore(storage = globalThis?.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(COLUMN_ORDER_STORAGE_KEY) || "null");
    if (parsed?.version !== 1 || !parsed.tables || typeof parsed.tables !== "object") return {};
    return parsed.tables;
  } catch {
    return {};
  }
}

function writeColumnOrderStore(tables, storage = globalThis?.localStorage) {
  try {
    storage?.setItem?.(COLUMN_ORDER_STORAGE_KEY, JSON.stringify({ version: 1, tables }));
  } catch {
    // Keep table browsing available when local preferences are unavailable.
  }
}

export function loadTableColumnOrder(tabOrKey, storage = globalThis?.localStorage) {
  const key = tableColumnOrderKey(tabOrKey);
  if (!key || key === "\u001f\u001f") return [];
  return normalizeColumnOrder(readColumnOrderStore(storage)[key]);
}

export function saveTableColumnOrder(tabOrKey, order, storage = globalThis?.localStorage) {
  const key = tableColumnOrderKey(tabOrKey);
  if (!key || key === "\u001f\u001f") return;
  const tables = readColumnOrderStore(storage);
  const normalized = normalizeColumnOrder(order);
  if (!normalized.length) delete tables[key];
  else tables[key] = normalized;
  writeColumnOrderStore(tables, storage);
}

export function clearTableColumnOrder(tabOrKey, storage = globalThis?.localStorage) {
  saveTableColumnOrder(tabOrKey, [], storage);
}

export function moveTableColumnOrderKey(previousTabOrKey, nextTabOrKey, storage = globalThis?.localStorage) {
  const previousKey = tableColumnOrderKey(previousTabOrKey);
  const nextKey = tableColumnOrderKey(nextTabOrKey);
  if (!previousKey || !nextKey || previousKey === nextKey) return;
  const tables = readColumnOrderStore(storage);
  if (!Object.prototype.hasOwnProperty.call(tables, previousKey)) return;
  tables[nextKey] = tables[previousKey];
  delete tables[previousKey];
  writeColumnOrderStore(tables, storage);
}

export function preferredColumnOrder(tab, storage = globalThis?.localStorage) {
  const local = normalizeColumnOrder(tab?.columnOrder);
  if (local.length) return local;
  return loadTableColumnOrder(tab, storage);
}

export function shouldIgnoreColumnReorderPointer(event) {
  if (!event || event.button !== 0) return true;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return true;
  return Boolean(event.target?.closest?.(
    ".wb-col-resize, .wb-sort-menu, .wb-column-sort, .wb-field-comment-cell, input, textarea, select, button",
  ));
}

export function columnReorderExceededThreshold(dx, dy, threshold = COLUMN_REORDER_THRESHOLD_PX) {
  return Math.hypot(Number(dx) || 0, Number(dy) || 0) >= threshold;
}

export function resolveColumnDropFromPoint(headers, clientX, { sourceIndex, frozenCount = 0 } = {}) {
  const list = Array.isArray(headers) ? headers.filter((header) => Number.isInteger(header?.index)) : [];
  if (!list.length || !Number.isFinite(Number(clientX))) return null;
  let target = list[0];
  for (const header of list) {
    if (clientX >= header.left && clientX < header.right) {
      target = header;
      break;
    }
    if (clientX >= header.right) target = header;
  }
  const last = list[list.length - 1];
  if (clientX >= last.right) target = last;
  if (clientX < list[0].left) target = list[0];
  const position = clientX >= (Number(target.left) + Number(target.right)) / 2 ? "after" : "before";
  const drop = resolveColumnDrop({
    sourceIndex,
    targetIndex: target.index,
    position,
    frozenCount,
  });
  return {
    targetIndex: target.index,
    position,
    allowed: Boolean(drop),
    left: position === "before" ? target.left : target.right,
    top: target.top,
    height: target.height,
  };
}

export function columnReorderScrollDelta({
  clientX,
  wrapLeft,
  wrapRight,
  frozenRight,
  sourceIndex,
  frozenCount = 0,
  edge = COLUMN_REORDER_EDGE_PX,
  step = COLUMN_REORDER_SCROLL_STEP,
} = {}) {
  if (!Number.isFinite(Number(clientX))) return 0;
  const count = Math.max(0, Math.floor(Number(frozenCount) || 0));
  if (count > 0 && Number.isInteger(sourceIndex) && sourceIndex < count) return 0;
  const right = Number(wrapRight);
  const leftBound = Math.max(Number(wrapLeft) || 0, Number(frozenRight) || Number(wrapLeft) || 0);
  if (Number.isFinite(right) && clientX >= right - edge) return step;
  if (clientX <= leftBound + edge) return -step;
  return 0;
}
