import { columnName } from "./normalize.js";
import { createRowIndex } from "./rowIndex.js";

export function buildRowIdentity(tab, row) {
  const primaryKeys = Array.isArray(tab.primaryKeys) ? tab.primaryKeys : [];
  const keys = primaryKeys.length > 0 ? primaryKeys : tab.columns.map(columnName);
  const out = {};
  for (const key of keys) {
    if (!key) continue;
    const value = row?.[key];
    out[key] = value == null ? null : String(value);
  }
  return out;
}

export function buildRowKey(tab, row) {
  const entries = Object.entries(buildRowIdentity(tab, row));
  const legacySafe = entries.every(([key, value]) => (
    value != null && !/[=&]/.test(key) && !/[=&]/.test(String(value))
  ));
  return legacySafe
    ? entries.map(([key, value]) => `${key}=${value}`).join("&")
    : `\u001e${JSON.stringify(entries)}`;
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
