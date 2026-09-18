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

export function buildSelectionStats(values) {
  if (!Array.isArray(values) || values.length === 0) return null;

  let sum = 0;
  let numericCount = 0;
  for (const value of values) {
    const number = parseNumericCellValue(value);
    if (number == null) continue;
    sum += number;
    numericCount += 1;
  }

  const items = [
    numericCount > 0
      ? { key: "average", label: "平均值", text: formatStatNumber(sum / numericCount) }
      : null,
    { key: "count", label: "计数", text: String(values.length) },
    numericCount > 0
      ? { key: "sum", label: "求和", text: formatStatNumber(sum) }
      : null,
  ].filter(Boolean);

  return {
    count: values.length,
    numericCount,
    sum,
    average: numericCount > 0 ? sum / numericCount : null,
    items,
  };
}
