const MAX_EVIDENCE_REFERENCES = 8;

export function extractEvidenceReferences(toolResults) {
  const references = [];
  const seen = new Set();
  for (const result of Array.isArray(toolResults) ? toolResults : []) {
    for (const raw of collectReferences(result)) {
      const normalized = normalizeEvidenceReference(raw);
      if (!normalized) continue;
      const key = evidenceKey(normalized.action);
      if (seen.has(key)) continue;
      seen.add(key);
      references.push(normalized);
      if (references.length >= MAX_EVIDENCE_REFERENCES) return references;
    }
  }
  return references;
}

function collectReferences(value) {
  const refs = [];
  collectFromValue(value?.result ?? value, refs);
  return refs;
}

function collectFromValue(value, refs) {
  const parsed = parseJsonish(value);
  if (parsed !== value) {
    collectFromValue(parsed, refs);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFromValue(item, refs);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.type === "text" && typeof value.text === "string") {
    collectFromValue(value.text, refs);
    return;
  }
  if (isReferenceLike(value)) {
    refs.push(value);
  }
  if (Array.isArray(value.references)) {
    for (const ref of value.references) collectFromValue(ref, refs);
  }
  if (value.reference) {
    collectFromValue(value.reference, refs);
  }
  if (Array.isArray(value.results)) {
    for (const item of value.results) collectFromValue(item, refs);
  }
  if (Array.isArray(value.rows)) {
    for (const item of value.rows) collectFromValue(item, refs);
  }
}

function parseJsonish(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || !/^[\[{]/.test(text)) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function isReferenceLike(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(value.tableName || value.table || value.table_name);
}

function normalizeEvidenceReference(raw) {
  const tableName = firstString(raw.tableName, raw.table, raw.table_name);
  if (!tableName) return null;
  const columnName = firstString(raw.columnName, raw.column, raw.column_name);
  const rowKey = firstString(raw.rowKey, raw.row_key);
  const rowIdentity = normalizeRowIdentity(raw.rowIdentity || raw.row_identity);
  const action = {
    action: "open_table",
    database: firstString(raw.database),
    tableName,
    tableComment: firstString(raw.tableComment, raw.table_comment),
  };
  if (columnName) {
    action.action = "focus_column";
    action.columnName = columnName;
  }
  if (rowKey || rowIdentity) {
    action.action = columnName ? "focus_cell" : "focus_row";
    action.rowKey = rowKey;
    action.rowIdentity = rowIdentity;
  }
  return {
    key: evidenceKey(action),
    label: evidenceLabel(action),
    action,
  };
}

function normalizeRowIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = String(key || "").trim();
    if (!name) continue;
    out[name] = String(raw ?? "");
  }
  return Object.keys(out).length ? out : null;
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function evidenceKey(action) {
  return [
    action.action || "",
    action.database || "",
    action.tableName || "",
    action.columnName || "",
    action.rowKey || "",
    identityLabel(action.rowIdentity || {}),
  ].join("\x1f");
}

function evidenceLabel(action) {
  const head = action.columnName ? `${action.tableName}.${action.columnName}` : action.tableName;
  const identity = action.rowKey || identityLabel(action.rowIdentity || {});
  return identity ? `${head} #${identity}` : head;
}

function identityLabel(identity) {
  return Object.entries(identity || {})
    .filter(([key]) => key)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}
