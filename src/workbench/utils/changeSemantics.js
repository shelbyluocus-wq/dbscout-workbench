/**
 * Decide whether a comparison change is a "format-only" difference: the two
 * values carry the same content and differ only by whitespace, numeric, or
 * JSON formatting (e.g. a compact one-line JSON string from Excel vs the
 * pretty-printed JSON text stored in the database, or "1.00" vs "1"). Used by
 * the batch-import comparison view so the default jump/selection and the
 * changed-cell highlight land on cells with a REAL difference instead of a
 * formatting artifact.
 */

function deepJsonEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => deepJsonEqual(value, right[index]));
  }
  if (typeof left === "object") {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepJsonEqual(left[key], right[key]));
  }
  return false;
}

function tryParseJson(text) {
  const trimmed = String(text).trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

// Plain decimal without leading zeros ("1", "-2", "0.5", "1.00"). The leading-
// zero guard keeps code-like strings ("007") on the "real difference" side.
const PLAIN_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function numericEquivalent(left, right) {
  if (!PLAIN_NUMBER_PATTERN.test(left) || !PLAIN_NUMBER_PATTERN.test(right)) return false;
  return Number(left) === Number(right);
}

/**
 * @param {{ oldValue: unknown, newValue: unknown }} change
 * @returns {boolean} true when the two sides only differ by formatting.
 */
export function isFormatOnlyChange(change) {
  const oldValue = change?.oldValue;
  const newValue = change?.newValue;
  if (oldValue === newValue) return true;
  if (oldValue === null || oldValue === undefined) return false;
  if (newValue === null || newValue === undefined) return false;
  const oldText = String(oldValue).trim();
  const newText = String(newValue).trim();
  if (oldText === newText) return true;
  if (numericEquivalent(oldText, newText)) return true;
  const oldJson = tryParseJson(oldText);
  const newJson = tryParseJson(newText);
  if (!oldJson.ok || !newJson.ok) return false;
  return deepJsonEqual(oldJson.value, newJson.value);
}

/**
 * Find the first change entry that represents a REAL difference, scanning
 * rows top-down and each row's changes left-to-right (schema order).
 *
 * @param {Array<{ changes?: Array<object> }>} rows
 * @returns {{ row: object, rowIndex: number, columnName: string } | null}
 */
export function firstRealChange(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let fallback = null;
  for (let rowIndex = 0; rowIndex < list.length; rowIndex += 1) {
    const row = list[rowIndex];
    const changes = row?.changes || [];
    for (const change of changes) {
      if (!fallback) fallback = { row, rowIndex, columnName: change?.columnName || "" };
      if (!isFormatOnlyChange(change)) {
        return { row, rowIndex, columnName: change?.columnName || "" };
      }
    }
  }
  return fallback;
}
