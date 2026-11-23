const STORAGE_KEY = "dbscout.home.columns.v1";

// `align: "end"` right-aligns numeric values (and their header) so magnitudes
// line up. Every column keeps an explicit pixel track so none stretches into
// spare pane width or resists being dragged narrower.
export const HOME_COLUMN_DEFINITIONS = Object.freeze([
  { key: "name", label: "表名", minWidth: 120, maxWidth: 520, defaultWidth: 200, autoMinWidth: 156, autoMaxWidth: 250, align: "start" },
  { key: "size", label: "数据大小", minWidth: 72, maxWidth: 180, defaultWidth: 96, autoMinWidth: 96, autoMaxWidth: 96, align: "end" },
  { key: "modified", label: "修改时间", minWidth: 88, maxWidth: 240, defaultWidth: 160, autoMinWidth: 160, autoMaxWidth: 160, align: "start" },
  { key: "comment", label: "备注", minWidth: 80, maxWidth: 640, defaultWidth: 200, autoMinWidth: 120, autoMaxWidth: 240, align: "start" },
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

// grid-template-columns for sized columns ({ key, width }): fixed pixel tracks
// so every column honors its exact width and can always be dragged narrower.
export function homeGridTemplateColumns(columns = []) {
  return columns
    .map((column) => `${column.width}px`)
    .join(" ");
}

function isWideCodePoint(code) {
  return (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7af)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6);
}

export function estimateHomeTextWidth(value, fontSize = 13, maxWidth = Number.POSITIVE_INFINITY) {
  const text = String(value || "");
  if (!text) return 0;
  const narrow = Math.max(7, fontSize * 0.56);
  const wide = fontSize;
  let width = 0;
  for (let index = 0; index < text.length; index += 1) {
    width += isWideCodePoint(text.charCodeAt(index)) ? wide : narrow;
    if (width >= maxWidth) return maxWidth;
  }
  return width;
}

function percentileNumber(values, ratio = 0.85) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function clampAutoWidth(value, min, max) {
  return Math.max(min, Math.min(max, Math.ceil(Number(value) || min)));
}

// Default widths stay compact by using the 85th percentile of table names and
// non-empty comments capped at each column's autoMaxWidth, so a few outliers
// never blow up the whole homepage table.
export function computeAutoHomeColumnWidths(tables = [], { readOnly = false, emptyComment = "" } = {}) {
  const nameDef = homeColumnDefinition("name");
  const sizeDef = homeColumnDefinition("size");
  const modifiedDef = homeColumnDefinition("modified");
  const commentDef = homeColumnDefinition("comment");
  const nameOverhead = readOnly ? 132 : 92;
  const nameAutoMax = nameDef.autoMaxWidth + (readOnly ? 36 : 0);
  const commentOverhead = 24;

  const list = Array.isArray(tables) ? tables : [];
  if (!list.length) {
    return {
      name: nameDef.defaultWidth,
      size: sizeDef.defaultWidth,
      modified: modifiedDef.defaultWidth,
      comment: commentDef.defaultWidth,
    };
  }

  const sampleLimit = 400;
  const step = list.length > sampleLimit ? list.length / sampleLimit : 1;
  const nameWidths = [];
  const commentWidths = [];
  const count = Math.min(list.length, sampleLimit);
  for (let i = 0; i < count; i += 1) {
    const table = list[step === 1 ? i : Math.floor(i * step)];
    const name = String(table?.tableName || table?.table_name || "").trim();
    if (name) nameWidths.push(estimateHomeTextWidth(name, 13, nameAutoMax));
    const comment = String(table?.tableComment || table?.table_comment || "").trim();
    if (comment) commentWidths.push(estimateHomeTextWidth(comment, 13, commentDef.autoMaxWidth));
  }

  const targetName = nameWidths.length ? percentileNumber(nameWidths, 0.85) + nameOverhead : nameDef.defaultWidth;
  const targetComment = commentWidths.length
    ? percentileNumber(commentWidths, 0.85) + commentOverhead
    : estimateHomeTextWidth(emptyComment, 13, commentDef.autoMaxWidth) + commentOverhead;

  return {
    name: clampAutoWidth(targetName, nameDef.autoMinWidth, nameAutoMax),
    size: sizeDef.defaultWidth,
    modified: modifiedDef.defaultWidth,
    comment: clampAutoWidth(targetComment, commentDef.autoMinWidth, commentDef.autoMaxWidth),
  };
}

// Automatic width for the comment column on tight panes: trim toward its
// automatic minimum so the table fits without horizontal scrolling, never
// expanding past its compact preferred width.
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

export function formatModifiedAtTooltip(table, labels = {}) {
  const timeText = String(table?.modifiedAt ?? table?.modified_at ?? "").trim();
  if (!timeText) return labels.empty || "—";
  const source = String(table?.modifiedSource ?? table?.modified_source ?? "").trim();
  const actor = String(table?.modifiedActor ?? table?.modified_actor ?? "").trim();
  const sourceLabel = source ? labels[source] || "" : "";
  if (!sourceLabel) return timeText;
  if (actor && (source === "blackcat" || source === "shared")) {
    return `${timeText} · ${sourceLabel}（${actor}）`;
  }
  return `${timeText} · ${sourceLabel}`;
}
