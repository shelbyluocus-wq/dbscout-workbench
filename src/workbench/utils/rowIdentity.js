import { columnName } from "./normalize.js";
import { createRowIndex } from "./rowIndex.js";

export function buildRowIdentity(tab, row) {
  const primaryKeys = Array.isArray(tab.primaryKeys) ? tab.primaryKeys : [];
  const keys = primaryKeys.length > 0 ? primaryKeys : tab.columns.map(columnName);
  const out = {};
  for (const key of keys) {
    if (key) out[key] = String(row?.[key] ?? "");
  }
  return out;
}

export function buildRowKey(tab, row) {
  return Object.entries(buildRowIdentity(tab, row))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function findRowByKey(tab, rowKey) {
  return tab ? createRowIndex(tab, { buildRowKey }).rowForKey(rowKey) : null;
}
