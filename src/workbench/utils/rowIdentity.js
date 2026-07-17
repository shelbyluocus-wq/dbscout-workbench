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


const IDENTITY_LABEL_MAX_LENGTH = 60;

function formatIdentityValue(value) {
  if (value == null) return "NULL";
  if (value === "") return '""';
  return String(value);
}

// Human-readable primary-key identity for confirmations, e.g. "id=3" or
// "k1=v1 + k2=v2". Mirrors the formatting used by selectedCellIdentity.js.
export function rowIdentityLabel(tab, row) {
  const primaryKeys = Array.isArray(tab?.primaryKeys) ? tab.primaryKeys.filter(Boolean) : [];
  if (!primaryKeys.length || !row) return null;
  const label = primaryKeys.map((key) => `${key}=${formatIdentityValue(row[key])}`).join(" + ");
  return label.length > IDENTITY_LABEL_MAX_LENGTH
    ? `${label.slice(0, IDENTITY_LABEL_MAX_LENGTH - 3)}…`
    : label;
}
