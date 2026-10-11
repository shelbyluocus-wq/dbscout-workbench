// Normalization and identity for the relation filter a relation tab carries.
// The backend matches rows with it; the key decides whether two jumps share
// one tab.

export const RELATION_LIST_ITEM_KEY = "ID";

export function normalizeRelationKind(kind) {
  return String(kind || "").trim().toLowerCase() === "listcontains" ? "listContains" : "equals";
}

export function normalizeRelationFilter(filter) {
  if (!filter || typeof filter !== "object") return null;
  const column = String(filter.column || "").trim();
  if (!column) return null;
  const values = [];
  for (const value of Array.isArray(filter.values) ? filter.values : []) {
    const text = String(value ?? "").trim();
    if (text && !values.includes(text)) values.push(text);
  }
  if (!values.length) return null;
  const kind = normalizeRelationKind(filter.kind);
  const itemKey = String(filter.itemKey || "").trim();
  return {
    column,
    kind,
    values,
    ...(kind === "listContains" ? { itemKey: itemKey || RELATION_LIST_ITEM_KEY } : {}),
  };
}

// Values of `itemKey` in a JSON list cell such as `[{"ID":1001,"Num":2}]`,
// with the key matched case-insensitively. Null when the text is not a JSON
// list of objects; mirrors the backend's list matching.
export function listItemValues(text, itemKey = RELATION_LIST_ITEM_KEY) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("[")) return null;
  let items;
  try {
    items = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  const key = String(itemKey || RELATION_LIST_ITEM_KEY).toLowerCase();
  const values = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const member = Object.keys(item).find((name) => name.toLowerCase() === key);
    const value = member === undefined ? undefined : item[member];
    if (typeof value === "number") values.push(String(value));
    else if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  return values;
}

export function relationFilterKey(filter) {
  const normalized = normalizeRelationFilter(filter);
  if (!normalized) return "";
  return [
    normalized.kind,
    normalized.column.toLowerCase(),
    normalized.itemKey || "",
    ...[...normalized.values].sort(),
  ].join("\u001f");
}

// Where a relation jump came from. The chip text and the backend both only
// need the filter; the origin exists so the chip can explain the listing.
export function normalizeRelationOrigin(origin) {
  if (!origin || typeof origin !== "object") return null;
  const sourceTable = String(origin.sourceTable || "").trim();
  const sourceColumn = String(origin.sourceColumn || "").trim();
  const targetTable = String(origin.targetTable || "").trim();
  const targetColumn = String(origin.targetColumn || "").trim();
  if (!sourceTable || !sourceColumn || !targetTable || !targetColumn) return null;
  return {
    direction: origin.direction === "incoming" ? "incoming" : "outgoing",
    sourceTable,
    sourceColumn,
    targetTable,
    targetColumn,
  };
}
