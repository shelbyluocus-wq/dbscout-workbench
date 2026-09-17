import { gridSelectionIsContiguous } from "./gridCellSelection.js";

export const FILL_DIRECTIONS = Object.freeze(["down", "up", "right", "left"]);
export const MAX_AUTOFILL_ROWS = 5000;
export const MAX_AUTOFILL_CELLS = 100_000;

const PLAIN_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const TEXT_NUMBER_PATTERN = /^(.*?)(\d+)(\D*)$/;
const STEP_EPSILON = 1e-9;

const FILL_LISTS = [
  ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"],
  ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
  ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"],
  ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"],
];

const DATE_PATTERNS = [
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, kind: "dashed" },
  { re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, kind: "slashed" },
  { re: /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/, kind: "dotted" },
  { re: /^(\d{4})年(\d{1,2})月(\d{1,2})日$/, kind: "chinese" },
];

function sourceShape(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0 || !Array.isArray(matrix[0]) || matrix[0].length === 0) {
    return null;
  }
  const columnCount = matrix[0].length;
  if (!matrix.every((row) => Array.isArray(row) && row.length === columnCount)) return null;
  return { rowCount: matrix.length, columnCount };
}

function normalizeCell(value) {
  return value == null ? "" : String(value);
}

function modulo(index, length) {
  return ((index % length) + length) % length;
}

function tileValues(values, fillCount, sign) {
  const result = [];
  if (sign > 0) {
    for (let index = 0; index < fillCount; index += 1) {
      result.push(values[modulo(values.length + index, values.length)]);
    }
    return result;
  }
  for (let index = 0; index < fillCount; index += 1) {
    result.push(values[modulo(-fillCount + index, values.length)]);
  }
  return result;
}

function sameStep(left, right) {
  return Math.abs(left - right) <= STEP_EPSILON;
}

function parsePlainNumber(text) {
  const trimmed = String(text).trim();
  if (!PLAIN_NUMBER_PATTERN.test(trimmed)) return null;
  return {
    value: Number(trimmed),
    integer: !trimmed.includes("."),
  };
}

function formatNumber(value, samples) {
  const keepInteger = samples.every((sample) => sample.integer) && Number.isInteger(value);
  if (keepInteger) return String(value);
  const rounded = Math.round(value * 1e10) / 1e10;
  return String(rounded);
}

function detectArithmetic(values) {
  if (values.length === 1) {
    return { step: 1, constant: false };
  }
  const steps = [];
  for (let index = 1; index < values.length; index += 1) {
    steps.push(values[index] - values[index - 1]);
  }
  if (!steps.every((step) => sameStep(step, steps[0]))) return null;
  return { step: steps[0], constant: sameStep(steps[0], 0) };
}

function generateArithmetic(start, step, count, sign) {
  const values = [];
  let current = start;
  for (let index = 0; index < count; index += 1) {
    current += step * sign;
    values.push(current);
  }
  return sign > 0 ? values : values.reverse();
}

function planNumberSeries(texts, fillCount, sign) {
  const parsed = texts.map(parsePlainNumber);
  if (parsed.some((item) => !item)) return null;
  const progression = detectArithmetic(parsed.map((item) => item.value));
  if (!progression || progression.constant) return null;
  const start = sign > 0 ? parsed[parsed.length - 1].value : parsed[0].value;
  return generateArithmetic(start, progression.step, fillCount, sign).map((value) => formatNumber(value, parsed));
}

function parseTextNumber(text) {
  const match = String(text).match(TEXT_NUMBER_PATTERN);
  if (!match) return null;
  return {
    prefix: match[1],
    digits: match[2],
    suffix: match[3],
    value: Number(match[2]),
    width: match[2].length,
  };
}

function formatTextNumber(value, sample) {
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(value)).padStart(sample.width, "0");
  return `${sample.prefix}${sign}${digits}${sample.suffix}`;
}

function planTextNumberSeries(texts, fillCount, sign) {
  if (texts.some((text) => parsePlainNumber(text))) return null;
  const parsed = texts.map(parseTextNumber);
  if (parsed.some((item) => !item)) return null;
  const sample = parsed[0];
  if (!parsed.every((item) => item.prefix === sample.prefix && item.suffix === sample.suffix)) return null;
  const progression = detectArithmetic(parsed.map((item) => item.value));
  if (!progression || progression.constant) return null;
  const start = sign > 0 ? parsed[parsed.length - 1].value : parsed[0].value;
  const width = Math.max(...parsed.map((item) => item.width));
  const template = { ...sample, width };
  return generateArithmetic(start, progression.step, fillCount, sign).map((value) => formatTextNumber(value, template));
}

function parseDate(text) {
  const raw = String(text).trim();
  for (const pattern of DATE_PATTERNS) {
    const match = raw.match(pattern.re);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const utc = Date.UTC(year, month - 1, day);
    const resolved = new Date(utc);
    if (
      resolved.getUTCFullYear() !== year
      || resolved.getUTCMonth() !== month - 1
      || resolved.getUTCDate() !== day
    ) {
      return null;
    }
    return {
      utc,
      kind: pattern.kind,
      padMonth: match[2].length > 1,
      padDay: match[3].length > 1,
    };
  }
  return null;
}

function formatDate(utc, template) {
  const date = new Date(utc);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(template.padMonth ? 2 : 1, "0");
  const day = String(date.getUTCDate()).padStart(template.padDay ? 2 : 1, "0");
  if (template.kind === "dashed") return `${year}-${month}-${day}`;
  if (template.kind === "slashed") return `${year}/${month}/${day}`;
  if (template.kind === "dotted") return `${year}.${month}.${day}`;
  return `${year}年${month}月${day}日`;
}

function planDateSeries(texts, fillCount, sign) {
  const parsed = texts.map(parseDate);
  if (parsed.some((item) => !item)) return null;
  if (!parsed.every((item) => item.kind === parsed[0].kind)) return null;
  const days = parsed.map((item) => item.utc / 86_400_000);
  const progression = detectArithmetic(days);
  if (!progression || progression.constant) return null;
  const start = sign > 0 ? parsed[parsed.length - 1].utc : parsed[0].utc;
  const template = sign > 0 ? parsed[parsed.length - 1] : parsed[0];
  const stepMs = progression.step * 86_400_000;
  const values = [];
  let current = start;
  for (let index = 0; index < fillCount; index += 1) {
    current += stepMs * sign;
    values.push(formatDate(current, template));
  }
  return sign > 0 ? values : values.reverse();
}

function listMatch(text, list) {
  const exact = list.findIndex((item) => item === text);
  if (exact >= 0) return { index: exact, sample: text, canonical: true };
  const lower = text.toLowerCase();
  const insensitive = list.findIndex((item) => item.toLowerCase() === lower);
  if (insensitive < 0) return null;
  return { index: insensitive, sample: text, canonical: false };
}

function formatListItem(canonical, sample) {
  if (sample === sample.toUpperCase()) return canonical.toUpperCase();
  if (sample === sample.toLowerCase()) return canonical.toLowerCase();
  return canonical;
}

function planListSeries(texts, fillCount, sign) {
  for (const list of FILL_LISTS) {
    const matches = texts.map((text) => listMatch(text, list));
    if (matches.some((item) => !item)) continue;
    const progression = detectArithmetic(matches.map((item) => item.index));
    if (!progression || progression.constant) return null;
    const start = sign > 0 ? matches[matches.length - 1].index : matches[0].index;
    const sample = sign > 0 ? matches[matches.length - 1].sample : matches[0].sample;
    const values = [];
    let current = start;
    for (let index = 0; index < fillCount; index += 1) {
      current = modulo(current + progression.step * sign, list.length);
      values.push(formatListItem(list[current], sample));
    }
    return sign > 0 ? values : values.reverse();
  }
  return null;
}

function planAxisValues(values, fillCount, sign, mode) {
  const texts = values.map(normalizeCell);
  if (mode === "copy") {
    return { mode: "copy", values: tileValues(texts, fillCount, sign) };
  }
  if (texts.every((text) => text === "")) {
    return { mode: "copy", values: tileValues(texts, fillCount, sign) };
  }
  const listValues = planListSeries(texts, fillCount, sign);
  if (listValues) return { mode: "series", values: listValues };
  const dateValues = planDateSeries(texts, fillCount, sign);
  if (dateValues) return { mode: "series", values: dateValues };
  const numberValues = planNumberSeries(texts, fillCount, sign);
  if (numberValues) return { mode: "series", values: numberValues };
  const textNumberValues = planTextNumberSeries(texts, fillCount, sign);
  if (textNumberValues) return { mode: "series", values: textNumberValues };
  return { mode: "copy", values: tileValues(texts, fillCount, sign) };
}

function createOutputMatrix(rowCount, columnCount) {
  return Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => ""));
}

export function planAutoFill({ sourceMatrix, direction, fillCount, mode = "auto" } = {}) {
  const source = sourceShape(sourceMatrix);
  if (!source) return { ok: false, reason: "invalid-source" };
  if (!FILL_DIRECTIONS.includes(direction)) return { ok: false, reason: "invalid-direction" };
  if (!Number.isInteger(fillCount) || fillCount <= 0) return { ok: false, reason: "empty-fill" };
  const resolvedMode = mode === "copy" ? "copy" : "auto";
  const vertical = direction === "down" || direction === "up";
  const sign = direction === "down" || direction === "right" ? 1 : -1;
  const outRows = vertical ? fillCount : source.rowCount;
  const outCols = vertical ? source.columnCount : fillCount;
  const matrix = createOutputMatrix(outRows, outCols);
  const axisCount = vertical ? source.columnCount : source.rowCount;
  let usedSeries = false;
  for (let axis = 0; axis < axisCount; axis += 1) {
    const values = vertical
      ? sourceMatrix.map((row) => row[axis])
      : [...sourceMatrix[axis]];
    const planned = planAxisValues(values, fillCount, sign, resolvedMode);
    if (planned.mode === "series") usedSeries = true;
    if (vertical) {
      for (let row = 0; row < planned.values.length; row += 1) {
        matrix[row][axis] = planned.values[row];
      }
    } else {
      for (let column = 0; column < planned.values.length; column += 1) {
        matrix[axis][column] = planned.values[column];
      }
    }
  }
  return {
    ok: true,
    mode: resolvedMode === "copy" ? "copy" : (usedSeries ? "series" : "copy"),
    matrix,
  };
}

function cloneBounds(bounds) {
  return {
    top: bounds.top,
    bottom: bounds.bottom,
    left: bounds.left,
    right: bounds.right,
  };
}

function clampIndex(value, max) {
  let next = Number(value);
  if (!Number.isInteger(next)) return 0;
  if (next < 0) next = 0;
  if (Number.isInteger(max) && next > max) next = max;
  return next;
}

export function resolveFillPreview(sourceBounds, hoverRow, hoverColumn, limits = {}) {
  if (!sourceBounds) return { fillCount: 0, previewBounds: null };
  const row = clampIndex(hoverRow, limits.maxRow);
  const column = clampIndex(hoverColumn, limits.maxColumn);
  let rowDelta = 0;
  if (row > sourceBounds.bottom) rowDelta = row - sourceBounds.bottom;
  else if (row < sourceBounds.top) rowDelta = row - sourceBounds.top;
  let columnDelta = 0;
  if (column > sourceBounds.right) columnDelta = column - sourceBounds.right;
  else if (column < sourceBounds.left) columnDelta = column - sourceBounds.left;
  if (rowDelta === 0 && columnDelta === 0) {
    return { fillCount: 0, previewBounds: cloneBounds(sourceBounds) };
  }
  if (rowDelta !== 0 && Math.abs(rowDelta) >= Math.abs(columnDelta)) {
    const direction = rowDelta > 0 ? "down" : "up";
    const fillCount = Math.abs(rowDelta);
    return {
      direction,
      fillCount,
      previewBounds: {
        top: direction === "up" ? sourceBounds.top - fillCount : sourceBounds.top,
        bottom: direction === "down" ? sourceBounds.bottom + fillCount : sourceBounds.bottom,
        left: sourceBounds.left,
        right: sourceBounds.right,
      },
    };
  }
  const direction = columnDelta > 0 ? "right" : "left";
  const fillCount = Math.abs(columnDelta);
  return {
    direction,
    fillCount,
    previewBounds: {
      top: sourceBounds.top,
      bottom: sourceBounds.bottom,
      left: direction === "left" ? sourceBounds.left - fillCount : sourceBounds.left,
      right: direction === "right" ? sourceBounds.right + fillCount : sourceBounds.right,
    },
  };
}

export function mapFillTargets(sourceBounds, direction, fillCount) {
  if (!sourceBounds || !FILL_DIRECTIONS.includes(direction) || !Number.isInteger(fillCount) || fillCount <= 0) {
    return [];
  }
  const targets = [];
  const columnCount = sourceBounds.right - sourceBounds.left + 1;
  const rowCount = sourceBounds.bottom - sourceBounds.top + 1;
  if (direction === "down") {
    for (let matrixRow = 0; matrixRow < fillCount; matrixRow += 1) {
      for (let matrixCol = 0; matrixCol < columnCount; matrixCol += 1) {
        targets.push({
          rowIndex: sourceBounds.bottom + 1 + matrixRow,
          columnIndex: sourceBounds.left + matrixCol,
          matrixRow,
          matrixCol,
        });
      }
    }
    return targets;
  }
  if (direction === "up") {
    for (let matrixRow = 0; matrixRow < fillCount; matrixRow += 1) {
      for (let matrixCol = 0; matrixCol < columnCount; matrixCol += 1) {
        targets.push({
          rowIndex: sourceBounds.top - fillCount + matrixRow,
          columnIndex: sourceBounds.left + matrixCol,
          matrixRow,
          matrixCol,
        });
      }
    }
    return targets;
  }
  if (direction === "right") {
    for (let matrixRow = 0; matrixRow < rowCount; matrixRow += 1) {
      for (let matrixCol = 0; matrixCol < fillCount; matrixCol += 1) {
        targets.push({
          rowIndex: sourceBounds.top + matrixRow,
          columnIndex: sourceBounds.right + 1 + matrixCol,
          matrixRow,
          matrixCol,
        });
      }
    }
    return targets;
  }
  for (let matrixRow = 0; matrixRow < rowCount; matrixRow += 1) {
    for (let matrixCol = 0; matrixCol < fillCount; matrixCol += 1) {
      targets.push({
        rowIndex: sourceBounds.top + matrixRow,
        columnIndex: sourceBounds.left - fillCount + matrixCol,
        matrixRow,
        matrixCol,
      });
    }
  }
  return targets;
}

export function canUseFillHandle(selection, { readOnly = false, editing = false } = {}) {
  if (readOnly || editing || !selection) return false;
  return gridSelectionIsContiguous(selection);
}
