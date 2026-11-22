export const COLUMN_FILTER_OPERATORS = [
  "eq",
  "neq",
  "contains",
  "notContains",
  "startsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "isEmpty",
  "isNotEmpty",
];

const VALID_OPERATOR_SET = new Set(COLUMN_FILTER_OPERATORS);

export function isNoValueOperator(operator) {
  return operator === "isEmpty" || operator === "isNotEmpty";
}

export function normalizeColumnFilter(rule) {
  if (!rule || typeof rule !== "object") return null;
  const column = String(rule.column ?? "").trim();
  if (!column) return null;

  const seen = new Set();
  const values = [];
  if (Array.isArray(rule.values)) {
    for (const raw of rule.values) {
      if (raw == null) continue;
      const text = String(raw);
      if (seen.has(text)) continue;
      seen.add(text);
      values.push(text);
    }
  }
  const includeNull = Boolean(rule.includeNull);

  const rawOperator = String(rule.operator ?? "").trim();
  const operator = VALID_OPERATOR_SET.has(rawOperator) ? rawOperator : "";
  const value = rule.value == null ? "" : String(rule.value);
  const hasCondition = operator
    ? (isNoValueOperator(operator) || value.length > 0)
    : false;

  if (!values.length && !includeNull && !hasCondition) return null;
  return {
    column,
    values,
    includeNull,
    operator: hasCondition ? operator : "",
    value: hasCondition && !isNoValueOperator(operator) ? value : "",
  };
}

export function normalizeColumnFilters(filters) {
  if (!Array.isArray(filters) || !filters.length) return [];
  const byKey = new Map();
  for (const item of filters) {
    const normalized = normalizeColumnFilter(item);
    if (!normalized) continue;
    byKey.set(normalized.column.toLowerCase(), normalized);
  }
  return Array.from(byKey.values());
}

export function hasActiveColumnFilters(filters) {
  return normalizeColumnFilters(filters).length > 0;
}

export function getColumnFilter(filters, columnName) {
  const key = String(columnName ?? "").trim().toLowerCase();
  if (!key || !Array.isArray(filters)) return null;
  for (const item of filters) {
    const normalized = normalizeColumnFilter(item);
    if (normalized && normalized.column.toLowerCase() === key) return normalized;
  }
  return null;
}

export function upsertColumnFilter(filters, rule) {
  const list = normalizeColumnFilters(filters);
  const targetColumn = String(rule?.column ?? "").trim().toLowerCase();
  if (!targetColumn) return list;
  const normalized = normalizeColumnFilter(rule);
  const next = list.filter((item) => item.column.toLowerCase() !== targetColumn);
  if (normalized) next.push(normalized);
  return next;
}

export function removeColumnFilter(filters, columnName) {
  const targetColumn = String(columnName ?? "").trim().toLowerCase();
  if (!targetColumn) return normalizeColumnFilters(filters);
  return normalizeColumnFilters(filters).filter(
    (item) => item.column.toLowerCase() !== targetColumn,
  );
}

const COMPACT_OPERATOR_SYMBOLS = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

function truncateChipValue(text, max = 18) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function formatColumnFilterChip(rule, t = (key) => key) {
  const normalized = normalizeColumnFilter(rule);
  if (!normalized) return "";
  const parts = [];
  const emptyLabel = t("grid.columnFilter.emptyValue");

  if (normalized.values.length || normalized.includeNull) {
    const labels = [];
    if (normalized.includeNull) labels.push(emptyLabel);
    for (const val of normalized.values) {
      labels.push(val === "" ? '""' : truncateChipValue(val));
    }
    if (labels.length === 1) {
      parts.push(`= ${labels[0]}`);
    } else if (labels.length === 2) {
      parts.push(`∈ ${labels[0]}, ${labels[1]}`);
    } else {
      parts.push(`∈ ${labels[0]}, ${labels[1]} +${labels.length - 2}`);
    }
  }

  if (normalized.operator) {
    const symbol = COMPACT_OPERATOR_SYMBOLS[normalized.operator];
    if (symbol) {
      parts.push(`${symbol} ${truncateChipValue(normalized.value)}`);
    } else if (isNoValueOperator(normalized.operator)) {
      parts.push(t(`grid.columnFilter.op.${normalized.operator}`));
    } else {
      parts.push(
        `${t(`grid.columnFilter.op.${normalized.operator}`)} ${truncateChipValue(normalized.value)}`,
      );
    }
  }

  return `${normalized.column} ${parts.join(" · ")}`;
}

export function matchesColumnFilterRow(row, rule, { isNull = false } = {}) {
  const normalized = normalizeColumnFilter(rule);
  if (!normalized) return true;
  const raw = row?.[normalized.column];
  const cellIsNull = isNull || raw === null || raw === undefined;
  const text = cellIsNull ? "" : String(raw);

  if (normalized.values.length || normalized.includeNull) {
    const nullMatch = normalized.includeNull && cellIsNull;
    const valueMatch = !cellIsNull && normalized.values.includes(text);
    if (!nullMatch && !valueMatch) return false;
  }

  const op = normalized.operator;
  if (!op) return true;
  if (op === "isEmpty") return cellIsNull || text === "";
  if (op === "isNotEmpty") return !cellIsNull && text !== "";
  if (op === "eq") return !cellIsNull && text === normalized.value;
  if (op === "neq") return cellIsNull || text !== normalized.value;
  if (op === "contains") {
    return !cellIsNull && text.toLowerCase().includes(normalized.value.toLowerCase());
  }
  if (op === "notContains") {
    return cellIsNull || !text.toLowerCase().includes(normalized.value.toLowerCase());
  }
  if (op === "startsWith") {
    return !cellIsNull && text.toLowerCase().startsWith(normalized.value.toLowerCase());
  }
  if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
    if (cellIsNull || text === "") return false;
    const lhsNum = Number(text.trim());
    const rhsNum = Number(normalized.value.trim());
    const numeric = text.trim() !== "" && normalized.value.trim() !== ""
      && Number.isFinite(lhsNum) && Number.isFinite(rhsNum);
    const lhs = numeric ? lhsNum : text;
    const rhs = numeric ? rhsNum : normalized.value;
    if (op === "gt") return lhs > rhs;
    if (op === "gte") return lhs >= rhs;
    if (op === "lt") return lhs < rhs;
    return lhs <= rhs;
  }
  return true;
}

export function collectLocalDistinctValues(rows, columnName, { search = "", limit = 200 } = {}) {
  const needle = String(search ?? "").trim().toLowerCase();
  const counts = new Map();
  let nullCount = 0;

  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;
    const raw = row[columnName];
    if (raw === null || raw === undefined) {
      if (!needle) nullCount += 1;
      continue;
    }
    const text = String(raw);
    if (needle && !text.toLowerCase().includes(needle)) continue;
    counts.set(text, (counts.get(text) || 0) + 1);
  }

  const items = [];
  if (nullCount > 0) items.push({ value: null, count: nullCount });
  const sortedValues = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [value, count] of sortedValues) {
    items.push({ value, count });
  }
  const safeLimit = Math.max(1, Number(limit) || 200);
  const truncated = items.length > safeLimit;
  return {
    values: items.slice(0, safeLimit),
    truncated,
  };
}
