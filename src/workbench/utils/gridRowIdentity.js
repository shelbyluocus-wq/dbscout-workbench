import { buildRowKey } from "./rowIdentity.js";

export const INSERT_ROW_KEY_PREFIX = "__insert__:";
export const INSERT_ROW_ID_FIELD = "__insertRowId";

export function insertRowIdFromRow(row) {
  return row?.[INSERT_ROW_ID_FIELD] || row?.__insert_row_id || "";
}

export function isInsertDraftRow(row) {
  return Boolean(insertRowIdFromRow(row));
}

export function getInsertRowKey(tab, rowId) {
  return rowId ? `${INSERT_ROW_KEY_PREFIX}${tab?.id || ""}:${rowId}` : "";
}

export function isInsertRowKey(rowKey) {
  return String(rowKey || "").startsWith(INSERT_ROW_KEY_PREFIX);
}

export function insertRowIdFromKey(tab, rowKey) {
  const value = String(rowKey || "");
  const tabPrefix = `${INSERT_ROW_KEY_PREFIX}${tab?.id || ""}:`;
  if (value.startsWith(tabPrefix)) return value.slice(tabPrefix.length);
  if (!value.startsWith(INSERT_ROW_KEY_PREFIX)) return "";
  return value.slice(INSERT_ROW_KEY_PREFIX.length).split(":").slice(1).join(":");
}

export function gridRowKey(tab, row) {
  const insertRowId = insertRowIdFromRow(row);
  return insertRowId ? getInsertRowKey(tab, insertRowId) : buildRowKey(tab, row);
}
