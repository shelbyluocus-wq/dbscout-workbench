const NUMERIC_TEXT_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseNumericCellValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text === "NULL" || !NUMERIC_TEXT_PATTERN.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function formatStatNumber(value) {
  if (!Number.isFinite(value)) return "";
  const rounded = Number(value.toPrecision(12));
  if (Object.is(rounded, -0)) return "0";
  return String(rounded);
}

function statItems(count, numericCount, sum) {
  return [
    numericCount > 0
      ? { key: "average", label: "平均值", text: formatStatNumber(sum / numericCount) }
      : null,
    { key: "count", label: "计数", text: String(count) },
    numericCount > 0
      ? { key: "sum", label: "求和", text: formatStatNumber(sum) }
      : null,
  ].filter(Boolean);
}

export function statsFromTotals(count, numericCount, sum) {
  if (!count) return null;
  return {
    count,
    numericCount,
    sum,
    average: numericCount > 0 ? sum / numericCount : null,
    items: statItems(count, numericCount, sum),
  };
}

export function createSelectionStatsAccumulator() {
  let count = 0;
  let numericCount = 0;
  let sum = 0;
  return {
    add(value) {
      count += 1;
      const number = parseNumericCellValue(value);
      if (number == null) return;
      sum += number;
      numericCount += 1;
    },
    result() {
      return statsFromTotals(count, numericCount, sum);
    },
  };
}

export function buildSelectionStats(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const accumulator = createSelectionStatsAccumulator();
  for (const value of values) accumulator.add(value);
  return accumulator.result();
}

const CELL_KEY_SEPARATOR = "\u001f";

/**
 * Index optimistic (pending-save) cell values of one table once per scan:
 * rowKey -> column -> value. Keys follow editState's
 * `table\x1frowKey\x1fcolumn` layout; the column is after the last separator.
 */
export function indexOptimisticValuesForTable(optimisticValues, tableName) {
  const index = new Map();
  if (!optimisticValues?.size) return index;
  const prefix = `${tableName ?? ""}${CELL_KEY_SEPARATOR}`;
  for (const [key, value] of optimisticValues) {
    if (!key.startsWith(prefix)) continue;
    const split = key.lastIndexOf(CELL_KEY_SEPARATOR);
    if (split < prefix.length) continue;
    const rowKey = key.slice(prefix.length, split);
    let columns = index.get(rowKey);
    if (!columns) {
      columns = new Map();
      index.set(rowKey, columns);
    }
    columns.set(key.slice(split + 1), value);
  }
  return index;
}

/**
 * Incremental selection-statistics scan over a visual row model.
 *
 * Cell values resolve exactly like the cell detail bar: in-grid edit draft,
 * then the text-panel draft of the selected cell, then the insert-row draft,
 * then a pending optimistic value, then the loaded value. Row keys are built
 * at most once per row and only when an override or optimistic value exists,
 * so large selections no longer pay a key build per cell.
 *
 * `step(maxRows)` processes up to `maxRows` rows and returns true when done.
 */
export function createSelectionStatsScan({
  bounds,
  isSelected = null,
  model,
  columns = [],
  rowKeyOf = () => "",
  overrides = [],
  optimistic = null,
} = {}) {
  const accumulator = createSelectionStatsAccumulator();
  const activeOverrides = (Array.isArray(overrides) ? overrides : []).filter(Boolean);
  const optimisticIndex = optimistic?.size ? optimistic : null;
  const needsRowKey = activeOverrides.length > 0 || Boolean(optimisticIndex);
  const top = bounds ? bounds.top : 0;
  const bottom = bounds ? bounds.bottom : -1;
  const left = bounds ? Math.max(0, bounds.left) : 0;
  const right = bounds ? Math.min(columns.length - 1, bounds.right) : -1;
  let nextRow = top;

  function valueFor(entry, rowKey, rowOptimistic, column) {
    for (const override of activeOverrides) {
      if (override.rowKey === rowKey && override.column === column) return override.value;
    }
    if (entry.type === "insert") return entry.insertRow?.draft?.[column] ?? "";
    const pending = rowOptimistic?.get(column);
    return pending != null ? pending : entry.row?.[column];
  }

  function scanRow(rowIndex) {
    const entry = model?.at(rowIndex);
    if (!entry) return;
    const rowKey = needsRowKey ? rowKeyOf(entry) : "";
    const rowOptimistic = optimisticIndex && entry.type !== "insert" ? optimisticIndex.get(rowKey) : null;
    for (let columnIndex = left; columnIndex <= right; columnIndex += 1) {
      if (isSelected && !isSelected(rowIndex, columnIndex)) continue;
      const column = columns[columnIndex];
      if (!column) continue;
      accumulator.add(valueFor(entry, rowKey, rowOptimistic, column));
    }
  }

  return {
    get done() {
      return nextRow > bottom;
    },
    step(maxRows = Number.POSITIVE_INFINITY) {
      const end = Math.min(bottom, nextRow + Math.max(1, maxRows) - 1);
      for (; nextRow <= end; nextRow += 1) scanRow(nextRow);
      return nextRow > bottom;
    },
    result() {
      return accumulator.result();
    },
  };
}
