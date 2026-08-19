import {
  AUTOFIT_LONG_VALUE_PREVIEW_WIDTH,
  AUTOFIT_MAX_COL_WIDTH,
  COL_PADDING,
  MIN_COL_WIDTH,
} from "../constants.js";
import { columnName } from "./normalize.js";

const AUTOFIT_SAMPLE_ROW_LIMIT = 200;
const LONG_VALUE_CHAR_LIMIT = 36;
const ASCII_CHAR_WIDTH = 7.2;
const ASCII_HEADER_CHAR_WIDTH = 7.5;
const WIDE_CHAR_WIDTH = 12;
const VALUE_CHROME_WIDTH = COL_PADDING + 16;
const HEADER_CHROME_WIDTH = COL_PADDING + 24;
const LONG_VALUE_MIN_WIDTH = 140;
const MAX_MEASURE_CANDIDATES = 3;

function columnType(column) {
  return String(
    column?.column_type
      ?? column?.columnType
      ?? column?.data_type
      ?? column?.dataType
      ?? "",
  ).trim().toLowerCase();
}

/**
 * Compact fallbacks for empty/all-NULL samples. They intentionally do not use
 * declared VARCHAR/TEXT capacity: a varchar(255) should not open at 600px.
 */
function emptyTypeWidthSpec(column) {
  const type = columnType(column);
  if (!type) return { width: 0, longMinWidth: LONG_VALUE_MIN_WIDTH };
  if (/\buuid\b/.test(type)) return { width: 290, longMinWidth: 290 };
  if (/\b(json|longtext|mediumtext)\b/.test(type)) return { width: 160, longMinWidth: 160 };
  if (/\b(array|map|tuple|nested|object)\b/.test(type)) {
    return { width: 160, longMinWidth: 160 };
  }
  if (/\b(text|tinytext|blob|binary|varbinary)\b/.test(type)) return { width: 150, longMinWidth: 150 };
  if (/\b(string|fixedstring)\b/.test(type)) return { width: 150, longMinWidth: 150 };
  if (/\b(datetime(?:64)?|timestamp)\b/.test(type)) return { width: 164, longMinWidth: LONG_VALUE_MIN_WIDTH };
  if (/\bdate(?:32)?\b/.test(type)) return { width: 112, longMinWidth: LONG_VALUE_MIN_WIDTH };
  if (/^time\b/.test(type)) return { width: 108, longMinWidth: LONG_VALUE_MIN_WIDTH };
  if (/\b(bool|boolean)\b/.test(type) || /tinyint\s*\(\s*1\s*\)/.test(type)) {
    return { width: 74, longMinWidth: LONG_VALUE_MIN_WIDTH };
  }
  if (/\bipv6\b/.test(type)) return { width: 290, longMinWidth: 290 };
  if (/\bipv4\b/.test(type)) return { width: 130, longMinWidth: LONG_VALUE_MIN_WIDTH };
  if (/\bbigint\b/.test(type)) return { width: 112, longMinWidth: LONG_VALUE_MIN_WIDTH };
  if (/\b(decimal(?:32|64|128|256)?|numeric|double|float(?:32|64)?|real)\b/.test(type)) {
    return { width: 112, longMinWidth: LONG_VALUE_MIN_WIDTH };
  }
  if (/\bu?int(?:8|16|32|64|128|256)\b/.test(type)) {
    return { width: 112, longMinWidth: LONG_VALUE_MIN_WIDTH };
  }
  if (/\b(tinyint|smallint|mediumint|int|integer)\b/.test(type)) {
    return { width: 88, longMinWidth: LONG_VALUE_MIN_WIDTH };
  }
  if (/\b(char|varchar|enum(?:8|16)?|set)\b/.test(type)) {
    return { width: 120, longMinWidth: LONG_VALUE_MIN_WIDTH };
  }
  return { width: 0, longMinWidth: LONG_VALUE_MIN_WIDTH };
}

function weightedCharLength(text) {
  let total = 0;
  for (const char of String(text || "")) total += char.charCodeAt(0) > 255 ? 2 : 1;
  return total;
}

function estimateTextWidth(text, asciiWidth = ASCII_CHAR_WIDTH) {
  let total = 0;
  for (const char of String(text || "")) {
    total += char.charCodeAt(0) > 255 ? WIDE_CHAR_WIDTH : asciiWidth;
  }
  return total;
}

function measuredTextWidth(text, measureText, asciiWidth = ASCII_CHAR_WIDTH) {
  if (typeof measureText === "function") {
    const measured = Number(measureText(String(text || "")));
    if (Number.isFinite(measured) && measured >= 0) return measured;
  }
  return estimateTextWidth(text, asciiWidth);
}

function headerMinWidth(headerText, measureText) {
  const textWidth = measuredTextWidth(headerText, measureText, ASCII_HEADER_CHAR_WIDTH);
  return Math.max(MIN_COL_WIDTH, Math.ceil(textWidth) + HEADER_CHROME_WIDTH);
}

function keepMeasureCandidate(candidates, text, estimate) {
  candidates.push({ text, estimate });
  candidates.sort((a, b) => b.estimate - a.estimate);
  if (candidates.length > MAX_MEASURE_CANDIDATES) candidates.length = MAX_MEASURE_CANDIDATES;
}

function emptyContentSpec(column, headerWidth) {
  const typeSpec = emptyTypeWidthSpec(column);
  return {
    width: Math.max(headerWidth, typeSpec.width),
    longMinWidth: Math.max(LONG_VALUE_MIN_WIDTH, typeSpec.longMinWidth),
  };
}

function sampledContentWidth(column, rows, headerWidth, valueMeasureText) {
  const emptySpec = emptyContentSpec(column, headerWidth);
  const name = columnName(column);
  const samples = Array.isArray(rows) ? rows.slice(0, AUTOFIT_SAMPLE_ROW_LIMIT) : [];
  if (!name || samples.length === 0) return emptySpec.width;

  let hasValue = false;
  const candidates = [];
  for (const row of samples) {
    if (!row || !Object.prototype.hasOwnProperty.call(row, name) || row[name] == null) continue;
    const text = String(row[name]);
    hasValue = true;
    if (weightedCharLength(text) > LONG_VALUE_CHAR_LIMIT) {
      return Math.min(
        AUTOFIT_MAX_COL_WIDTH,
        Math.max(headerWidth, emptySpec.longMinWidth, AUTOFIT_LONG_VALUE_PREVIEW_WIDTH),
      );
    }
    keepMeasureCandidate(candidates, text, estimateTextWidth(text));
  }

  if (!hasValue) return emptySpec.width;
  const maxValueTextWidth = candidates.reduce((max, candidate) => (
    Math.max(max, measuredTextWidth(candidate.text, valueMeasureText))
  ), 0);
  const maxValueWidth = Math.ceil(maxValueTextWidth) + VALUE_CHROME_WIDTH;
  return Math.max(headerWidth, Math.min(AUTOFIT_MAX_COL_WIDTH, maxValueWidth));
}

/**
 * Calculate all current column widths in one pass.
 *
 * Manual columns stay fixed. Every other column is sized from the header font,
 * type metadata, and a bounded row sample. Leftover viewport space is not
 * distributed, so resizing the window does not stretch or shrink fields.
 * Frozen columns remain ordinary columns in table flow, so no separate
 * frozen-width reservation is needed.
 */
export function calculateColumnWidths({
  columns,
  rows = [],
  manualWidths = {},
  headerMeasureText,
  valueMeasureText,
} = {}) {
  const safeColumns = Array.isArray(columns) ? columns : [];
  const result = {};

  for (const column of safeColumns) {
    const name = columnName(column);
    if (!name) continue;
    const manualWidth = Number(manualWidths[name]);
    if (Number.isFinite(manualWidth) && manualWidth > 0) {
      result[name] = Math.round(manualWidth);
      continue;
    }
    const headerWidth = headerMinWidth(name, headerMeasureText);
    result[name] = Math.round(sampledContentWidth(column, rows, headerWidth, valueMeasureText));
  }

  return result;
}

export const COLUMN_WIDTH_SAMPLE_LIMIT = AUTOFIT_SAMPLE_ROW_LIMIT;
