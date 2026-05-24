import { getOptimisticCellValue } from "../editState.js";
import { buildRowKey } from "./rowIdentity.js";

export function displayCellValue(editState, tab, row, column, rowKey) {
  const key = rowKey || buildRowKey(tab, row);
  const optimistic = getOptimisticCellValue(editState, tab.tableName, key, column);
  if (optimistic != null) return optimistic;
  if (row?.[column] == null) return "NULL";
  return String(row[column]);
}

export function highlightCell(editState, tab, row, column, rowKey) {
  const text = displayCellValue(editState, tab, row, column, rowKey);
  const query = tab?.filter?.trim();
  if (!query || text === "NULL") return escapeHtml(text);
  const escaped = escapeHtml(text);
  const mode = tab.filterMode || "fuzzy";
  if (mode === "exact") {
    if (text !== query) return escaped;
    return `<mark>${escaped}</mark>`;
  }
  const escapedQuery = escapeHtml(query);
  const pattern = escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${pattern})`, "gi");
  return escaped.replace(regex, "<mark>$1</mark>");
}

export function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
