export const TABLE_DESIGN_CLIPBOARD_KIND = "dbscout.tableDesignColumns";

function cloneCopiedColumn(column = {}) {
  return {
    name: String(column.name ?? ""),
    type: String(column.type ?? ""),
    length: String(column.length ?? ""),
    scale: String(column.scale ?? ""),
    nullable: Boolean(column.nullable),
    defaultMode: String(column.defaultMode || "none"),
    defaultValue: String(column.defaultValue ?? ""),
    comment: String(column.comment || ""),
  };
}

export function serializeTableDesignColumns(columns = []) {
  return JSON.stringify({
    kind: TABLE_DESIGN_CLIPBOARD_KIND,
    version: 1,
    columns: (Array.isArray(columns) ? columns : []).map(cloneCopiedColumn),
  });
}

export function parseTableDesignColumns(textValue) {
  const raw = String(textValue ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.kind !== TABLE_DESIGN_CLIPBOARD_KIND) return null;
    if (!Array.isArray(parsed.columns) || parsed.columns.length === 0) return null;
    return {
      kind: TABLE_DESIGN_CLIPBOARD_KIND,
      version: Number(parsed.version) || 1,
      columns: parsed.columns.map(cloneCopiedColumn),
    };
  } catch {
    return null;
  }
}

export function uniqueColumnName(name, existingNames = []) {
  const base = String(name ?? "");
  if (!base.trim()) return base;
  const taken = new Set(
    (Array.isArray(existingNames) ? existingNames : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (!taken.has(base.toLowerCase())) return base;
  const copy = `${base}_copy`;
  if (!taken.has(copy.toLowerCase())) return copy;
  let index = 2;
  while (taken.has(`${base}_copy${index}`.toLowerCase())) index += 1;
  return `${base}_copy${index}`;
}

function newColumnId() {
  return `col-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function columnsForPaste(copiedColumns = [], existingColumns = []) {
  const taken = (Array.isArray(existingColumns) ? existingColumns : []).map((column) => column?.name);
  const result = [];
  for (const source of Array.isArray(copiedColumns) ? copiedColumns : []) {
    const copied = cloneCopiedColumn(source);
    const name = uniqueColumnName(copied.name, taken);
    taken.push(name);
    result.push({
      id: newColumnId(),
      originalName: "",
      name,
      type: copied.type || "varchar",
      length: copied.length,
      scale: copied.scale,
      originalType: "",
      nullable: copied.nullable,
      primaryKey: false,
      primaryKeyOrdinal: null,
      defaultMode: copied.defaultMode || "none",
      defaultValue: copied.defaultValue,
      comment: copied.comment,
    });
  }
  return result;
}

let sharedPayload = null;

export function clearTableDesignClipboard() {
  sharedPayload = null;
}

export function setTableDesignClipboard(text, columns = []) {
  const parsed = parseTableDesignColumns(text);
  const nextColumns = parsed
    ? parsed.columns
    : (Array.isArray(columns) ? columns : []).map(cloneCopiedColumn);
  if (!nextColumns.length) {
    sharedPayload = null;
    return;
  }
  sharedPayload = {
    text: String(text ?? ""),
    columns: nextColumns.map(cloneCopiedColumn),
  };
}

export function peekTableDesignClipboard() {
  if (!sharedPayload?.columns?.length) return null;
  return {
    kind: TABLE_DESIGN_CLIPBOARD_KIND,
    version: 1,
    columns: sharedPayload.columns.map(cloneCopiedColumn),
  };
}

export function resolveTableDesignClipboard(text, { allowInternalFallback = false } = {}) {
  const parsed = parseTableDesignColumns(text);
  if (parsed) return parsed;
  if (allowInternalFallback) return peekTableDesignClipboard();
  return null;
}

export function hasEditableTextSelection(target) {
  if (!target) return false;
  const element = typeof target.closest === "function"
    ? target.closest("input, textarea")
    : null;
  const editable = element
    || (target.isContentEditable ? target : null)
    || (target.selectionStart != null && target.selectionEnd != null ? target : null);
  if (!editable) return false;
  if (editable.isContentEditable) {
    const selection = globalThis.getSelection?.();
    return Boolean(selection && !selection.isCollapsed && editable.contains?.(selection.anchorNode));
  }
  const start = editable.selectionStart;
  const end = editable.selectionEnd;
  return typeof start === "number" && typeof end === "number" && start !== end;
}
