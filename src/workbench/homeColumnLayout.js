const STORAGE_KEY = "dbscout.home.columns.v1";

// `align: "end"` right-aligns numeric values (and their header) so magnitudes
// line up; the `fill` column keeps its width as a minimum and absorbs the
// remaining space so the table never leaves an empty strip on wide panes.
export const HOME_COLUMN_DEFINITIONS = Object.freeze([
  { key: "name", label: "表名", minWidth: 160, maxWidth: 520, defaultWidth: 240, align: "start" },
  { key: "size", label: "数据大小", minWidth: 100, maxWidth: 180, defaultWidth: 116, align: "end" },
  { key: "modified", label: "修改时间", minWidth: 150, maxWidth: 240, defaultWidth: 176, align: "start" },
  { key: "comment", label: "备注", minWidth: 180, maxWidth: 520, defaultWidth: 280, align: "start", fill: true },
]);

const definitionByKey = new Map(HOME_COLUMN_DEFINITIONS.map((column) => [column.key, column]));

export function defaultHomeColumnLayout() {
  return HOME_COLUMN_DEFINITIONS.map((column) => ({ key: column.key, width: null }));
}

export function normalizeHomeColumnLayout(value) {
  if (!Array.isArray(value)) return defaultHomeColumnLayout();
  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    const key = String(item?.key || "");
    const definition = definitionByKey.get(key);
    if (!definition || seen.has(key)) continue;
    seen.add(key);
    const rawWidth = item?.width;
    const width = rawWidth === null || rawWidth === undefined || rawWidth === ""
      ? Number.NaN
      : Number(rawWidth);
    normalized.push({
      key,
      width: Number.isFinite(width)
        ? Math.round(Math.min(definition.maxWidth, Math.max(definition.minWidth, width)))
        : null,
    });
  }
  for (const definition of HOME_COLUMN_DEFINITIONS) {
    if (!seen.has(definition.key)) normalized.push({ key: definition.key, width: null });
  }
  return normalized;
}

export function loadHomeColumnLayout(storage = globalThis?.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(STORAGE_KEY) || "null");
    if (parsed?.version !== 1) return defaultHomeColumnLayout();
    return normalizeHomeColumnLayout(parsed.columns);
  } catch {
    return defaultHomeColumnLayout();
  }
}

export function saveHomeColumnLayout(columns, storage = globalThis?.localStorage) {
  try {
    storage?.setItem?.(STORAGE_KEY, JSON.stringify({ version: 1, columns: normalizeHomeColumnLayout(columns) }));
  } catch {
    // Keep table browsing available when local preferences are unavailable.
  }
}

export function moveHomeColumn(columns, sourceKey, targetKey, position = "before") {
  const next = normalizeHomeColumnLayout(columns);
  const sourceIndex = next.findIndex((column) => column.key === sourceKey);
  const targetIndex = next.findIndex((column) => column.key === targetKey);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return next;
  const [source] = next.splice(sourceIndex, 1);
  const adjustedTargetIndex = next.findIndex((column) => column.key === targetKey);
  next.splice(position === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex, 0, source);
  return next;
}

export function homeColumnDefinition(key) {
  return definitionByKey.get(key) || HOME_COLUMN_DEFINITIONS[0];
}

// grid-template-columns for sized columns ({ key, width }): fixed tracks, except
// the fill column, which grows from its width into any spare space.
export function homeGridTemplateColumns(columns = []) {
  return columns
    .map((column) => (homeColumnDefinition(column.key).fill
      ? `minmax(${column.width}px, 1fr)`
      : `${column.width}px`))
    .join(" ");
}

// Automatic width for the fill column: shrink toward its minimum so the table
// fits the visible surface (long comments then truncate instead of forcing a
// horizontal scroll), never below the minimum and never above its content width.
export function fittedFillWidth({ preferred, minWidth, available, otherColumnsWidth }) {
  if (!(available > 0)) return preferred;
  const room = Math.floor(available - otherColumnsWidth);
  return Math.max(minWidth, Math.min(preferred, room));
}

// Total width the table needs; it stretches to the pane when the pane is wider.
export function homeTableWidthCss(columns = []) {
  const total = columns.reduce((sum, column) => sum + (Number(column.width) || 0), 0);
  return `max(100%, ${total}px)`;
}

export function formatDataSize(bytes) {
  if (bytes === null || bytes === undefined || bytes === "") return "—";
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatModifiedAt(value) {
  const text = String(value || "").trim();
  return text || "—";
}
