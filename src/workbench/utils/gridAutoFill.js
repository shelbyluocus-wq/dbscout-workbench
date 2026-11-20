import { gridSelectionIsContiguous } from "./gridCellSelection.js";

export const FILL_DIRECTIONS = Object.freeze(["down", "up", "right", "left"]);
export const MAX_AUTOFILL_ROWS = 5000;
export const MAX_AUTOFILL_CELLS = 100_000;

const PLAIN_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const TEXT_NUMBER_PATTERN = /^(.*?)((?:^|\s)-)?(\d+)(\D*)$/;
const STEP_EPSILON = 1e-9;
const MS_PER_DAY = 86_400_000;
const SECONDS_PER_DAY = 86_400;

const FILL_LISTS = [
  ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"],
  ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
  ["礼拜一", "礼拜二", "礼拜三", "礼拜四", "礼拜五", "礼拜六", "礼拜日"],
  ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"],
  ["第一季度", "第二季度", "第三季度", "第四季度"],
  ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  ["Q1", "Q2", "Q3", "Q4"],
  ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"],
  ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"],
];

const DATE_PATTERNS = [
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, kind: "dashed" },
  { re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, kind: "slashed" },
  { re: /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/, kind: "dotted" },
  { re: /^(\d{4})年(\d{1,2})月(\d{1,2})日$/, kind: "chinese" },
];

const DATETIME_PATTERNS = [
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2})([ T])(\d{1,2}):(\d{2})(?::(\d{2}))?$/, kind: "dashed" },
  { re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})([ T])(\d{1,2}):(\d{2})(?::(\d{2}))?$/, kind: "slashed" },
  { re: /^(\d{4})\.(\d{1,2})\.(\d{1,2})([ T])(\d{1,2}):(\d{2})(?::(\d{2}))?$/, kind: "dotted" },
];

const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function sourceShape(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0 || !Array.isArray(matrix[0]) || matrix[0].length === 0) {
    return null;
  }
  const columnCount = matrix[0].length;
  if (!matrix.every((row) => Array.isArray(row) && row.length === columnCount)) return null;
  return { rowCount: matrix.length, columnCount };
}

function normalizeCopyCell(value) {
  return value == null ? null : String(value);
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

function parsePlainNumber(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!PLAIN_NUMBER_PATTERN.test(trimmed)) return null;
  const dotIndex = trimmed.indexOf(".");
  return {
    value: Number(trimmed),
    integer: dotIndex < 0,
    decimals: dotIndex < 0 ? 0 : trimmed.length - dotIndex - 1,
  };
}

function formatNumber(value, samples) {
  const keepInteger = samples.every((sample) => sample.integer) && Number.isInteger(value);
  if (keepInteger) return String(value);
  const rounded = Math.round(value * 1e10) / 1e10;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  const firstDecimals = samples[0]?.decimals || 0;
  if (firstDecimals > 0 && samples.every((sample) => sample.decimals === firstDecimals)) {
    return normalized.toFixed(firstDecimals);
  }
  return String(normalized);
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

function detectModularArithmetic(indices, period) {
  if (indices.length === 1) {
    return { step: 1, constant: false };
  }
  const steps = [];
  for (let index = 1; index < indices.length; index += 1) {
    steps.push(modulo(indices[index] - indices[index - 1], period));
  }
  if (!steps.every((step) => step === steps[0])) return null;
  return { step: steps[0], constant: steps[0] === 0 };
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

function planNumberSeries(rawValues, fillCount, sign, allowSingleNumberSeries) {
  const parsed = rawValues.map(parsePlainNumber);
  if (parsed.some((item) => !item)) return null;
  // WPS / Excel rule: dragging a single plain number copies by default;
  // explicit series mode (or Ctrl toggle) increments by 1.
  if (parsed.length === 1 && !allowSingleNumberSeries) return null;
  const progression = detectArithmetic(parsed.map((item) => item.value));
  if (!progression || progression.constant) return null;
  const start = sign > 0 ? parsed[parsed.length - 1].value : parsed[0].value;
  return generateArithmetic(start, progression.step, fillCount, sign).map((value) => formatNumber(value, parsed));
}

function parseTextNumber(value) {
  if (value == null) return null;
  const text = String(value);
  const match = text.match(TEXT_NUMBER_PATTERN);
  if (!match) return null;
  const signPrefix = match[2] || "";
  const hasNegative = signPrefix.endsWith("-");
  const prefix = hasNegative ? `${match[1]}${signPrefix.slice(0, -1)}` : match[1];
  const digits = match[3];
  const suffix = match[4];
  const magnitude = Number(digits);
  return {
    prefix,
    digits,
    suffix,
    value: hasNegative ? -magnitude : magnitude,
    width: digits.length,
  };
}

function formatTextNumber(value, sample) {
  const normalized = Object.is(value, -0) ? 0 : value;
  const sign = normalized < 0 ? "-" : "";
  const digits = String(Math.abs(normalized)).padStart(sample.width, "0");
  return `${sample.prefix}${sign}${digits}${sample.suffix}`;
}

function planTextNumberSeries(rawValues, fillCount, sign) {
  if (rawValues.some((value) => value == null || parsePlainNumber(value))) return null;
  const parsed = rawValues.map(parseTextNumber);
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

function daysInMonth(year, month1Based) {
  return new Date(Date.UTC(year, month1Based, 0)).getUTCDate();
}

function addCalendarMonths(year, month1Based, day, deltaMonths, snapMonthEnd) {
  const totalMonths = year * 12 + (month1Based - 1) + deltaMonths;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = modulo(totalMonths, 12) + 1;
  const maxDay = daysInMonth(nextYear, nextMonth);
  const nextDay = snapMonthEnd ? maxDay : Math.min(day, maxDay);
  return { year: nextYear, month: nextMonth, day: nextDay };
}

function detectCalendarMonthCadence(parsedDates) {
  if (parsedDates.length < 2) return null;
  const monthIndices = parsedDates.map((item) => item.year * 12 + (item.month - 1));
  const progression = detectArithmetic(monthIndices);
  if (!progression || progression.constant || !Number.isInteger(progression.step)) return null;
  const allSameDay = parsedDates.every((item) => item.day === parsedDates[0].day);
  if (allSameDay) {
    return { stepMonths: progression.step, targetDay: parsedDates[0].day, snapMonthEnd: false };
  }
  const allMonthEnd = parsedDates.every((item) => item.day === daysInMonth(item.year, item.month));
  if (allMonthEnd) {
    return { stepMonths: progression.step, targetDay: 31, snapMonthEnd: true };
  }
  const maxDay = Math.max(...parsedDates.map((item) => item.day));
  const clampedMatch = parsedDates.every((item) => item.day === Math.min(maxDay, daysInMonth(item.year, item.month)));
  if (clampedMatch) {
    return { stepMonths: progression.step, targetDay: maxDay, snapMonthEnd: false };
  }
  return null;
}

function resolveDatePadding(parsedDates) {
  const allTwoDigit = parsedDates.every((item) => item.monthRaw.length === 2 && item.dayRaw.length === 2);
  return {
    padMonth: parsedDates.some((item) => item.monthRaw.startsWith("0")) || allTwoDigit,
    padDay: parsedDates.some((item) => item.dayRaw.startsWith("0")) || allTwoDigit,
  };
}

function parseDate(value) {
  if (value == null) return null;
  const raw = String(value).trim();
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
      year,
      month,
      day,
      kind: pattern.kind,
      monthRaw: match[2],
      dayRaw: match[3],
    };
  }
  return null;
}

function formatDateParts(year, month, day, template) {
  const yearText = String(year).padStart(4, "0");
  const monthText = String(month).padStart(template.padMonth ? 2 : 1, "0");
  const dayText = String(day).padStart(template.padDay ? 2 : 1, "0");
  if (template.kind === "dashed") return `${yearText}-${monthText}-${dayText}`;
  if (template.kind === "slashed") return `${yearText}/${monthText}/${dayText}`;
  if (template.kind === "dotted") return `${yearText}.${monthText}.${dayText}`;
  return `${yearText}年${monthText}月${dayText}日`;
}

function formatDate(utc, template) {
  const date = new Date(utc);
  return formatDateParts(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    template,
  );
}

function planDateSeries(rawValues, fillCount, sign) {
  const parsed = rawValues.map(parseDate);
  if (parsed.some((item) => !item)) return null;
  if (!parsed.every((item) => item.kind === parsed[0].kind)) return null;
  const template = { kind: parsed[0].kind, ...resolveDatePadding(parsed) };

  const monthly = detectCalendarMonthCadence(parsed);
  if (monthly) {
    const anchor = sign > 0 ? parsed[parsed.length - 1] : parsed[0];
    const values = [];
    for (let index = 1; index <= fillCount; index += 1) {
      const next = addCalendarMonths(
        anchor.year,
        anchor.month,
        monthly.targetDay,
        monthly.stepMonths * sign * index,
        monthly.snapMonthEnd,
      );
      values.push(formatDateParts(next.year, next.month, next.day, template));
    }
    return sign > 0 ? values : values.reverse();
  }

  const days = parsed.map((item) => item.utc / MS_PER_DAY);
  const progression = detectArithmetic(days);
  if (!progression || progression.constant) return null;
  const start = sign > 0 ? parsed[parsed.length - 1].utc : parsed[0].utc;
  const stepMs = progression.step * MS_PER_DAY;
  const values = [];
  let current = start;
  for (let index = 0; index < fillCount; index += 1) {
    current += stepMs * sign;
    values.push(formatDate(current, template));
  }
  return sign > 0 ? values : values.reverse();
}

function parseDateTime(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  for (const pattern of DATETIME_PATTERNS) {
    const match = raw.match(pattern.re);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const separator = match[4];
    const hour = Number(match[5]);
    const minute = Number(match[6]);
    const hasSeconds = match[7] != null;
    const second = hasSeconds ? Number(match[7]) : 0;
    if (hour > 23 || minute > 59 || second > 59) return null;
    const utc = Date.UTC(year, month - 1, day, hour, minute, second);
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
      year,
      month,
      day,
      hour,
      minute,
      second,
      timeSeconds: hour * 3600 + minute * 60 + second,
      kind: pattern.kind,
      separator,
      monthRaw: match[2],
      dayRaw: match[3],
      hourRaw: match[5],
      hasSeconds,
    };
  }
  return null;
}

function formatTimeParts(hour, minute, second, { padHour, hasSeconds }) {
  const hh = String(hour).padStart(padHour ? 2 : 1, "0");
  const mm = String(minute).padStart(2, "0");
  if (!hasSeconds) return `${hh}:${mm}`;
  const ss = String(second).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatDateTime(utc, template) {
  const date = new Date(utc);
  const datePart = formatDateParts(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    template,
  );
  const timePart = formatTimeParts(
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    template,
  );
  return `${datePart}${template.separator}${timePart}`;
}

function planDateTimeSeries(rawValues, fillCount, sign) {
  const parsed = rawValues.map(parseDateTime);
  if (parsed.some((item) => !item)) return null;
  const first = parsed[0];
  if (!parsed.every((item) => item.kind === first.kind && item.separator === first.separator)) return null;
  const template = {
    kind: first.kind,
    separator: first.separator,
    ...resolveDatePadding(parsed),
    padHour: parsed.some((item) => item.hourRaw.startsWith("0")) || parsed.every((item) => item.hourRaw.length === 2),
    hasSeconds: parsed.some((item) => item.hasSeconds),
  };

  if (parsed.length === 1) {
    const values = [];
    let current = first.utc;
    for (let index = 0; index < fillCount; index += 1) {
      current += MS_PER_DAY * sign;
      values.push(formatDateTime(current, template));
    }
    return sign > 0 ? values : values.reverse();
  }

  const sameTime = parsed.every((item) => item.timeSeconds === first.timeSeconds);
  if (sameTime) {
    const monthly = detectCalendarMonthCadence(parsed);
    if (monthly) {
      const anchor = sign > 0 ? parsed[parsed.length - 1] : first;
      const timePart = formatTimeParts(first.hour, first.minute, first.second, template);
      const values = [];
      for (let index = 1; index <= fillCount; index += 1) {
        const next = addCalendarMonths(
          anchor.year,
          anchor.month,
          monthly.targetDay,
          monthly.stepMonths * sign * index,
          monthly.snapMonthEnd,
        );
        const datePart = formatDateParts(next.year, next.month, next.day, template);
        values.push(`${datePart}${template.separator}${timePart}`);
      }
      return sign > 0 ? values : values.reverse();
    }
  }

  const progression = detectArithmetic(parsed.map((item) => item.utc));
  if (!progression || progression.constant) return null;
  const start = sign > 0 ? parsed[parsed.length - 1].utc : first.utc;
  const values = [];
  let current = start;
  for (let index = 0; index < fillCount; index += 1) {
    current += progression.step * sign;
    values.push(formatDateTime(current, template));
  }
  return sign > 0 ? values : values.reverse();
}

function parseTime(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  const match = raw.match(TIME_PATTERN);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const hasSeconds = match[3] != null;
  const second = hasSeconds ? Number(match[3]) : 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return {
    seconds: hour * 3600 + minute * 60 + second,
    hourRaw: match[1],
    hasSeconds,
  };
}

function formatTimeSeconds(totalSeconds, template) {
  const normalized = modulo(Math.round(totalSeconds), SECONDS_PER_DAY);
  const hour = Math.floor(normalized / 3600);
  const minute = Math.floor((normalized % 3600) / 60);
  const second = normalized % 60;
  return formatTimeParts(hour, minute, second, template);
}

function planTimeSeries(rawValues, fillCount, sign) {
  const parsed = rawValues.map(parseTime);
  if (parsed.some((item) => !item)) return null;
  const template = {
    padHour: parsed.some((item) => item.hourRaw.startsWith("0")) || parsed.every((item) => item.hourRaw.length === 2),
    hasSeconds: parsed.some((item) => item.hasSeconds),
  };
  let step;
  if (parsed.length === 1) {
    step = 3600;
  } else {
    const progression = detectModularArithmetic(parsed.map((item) => item.seconds), SECONDS_PER_DAY);
    if (!progression || progression.constant) return null;
    step = progression.step;
  }
  const start = sign > 0 ? parsed[parsed.length - 1].seconds : parsed[0].seconds;
  const values = [];
  let current = start;
  for (let index = 0; index < fillCount; index += 1) {
    current = modulo(current + step * sign, SECONDS_PER_DAY);
    values.push(formatTimeSeconds(current, template));
  }
  return sign > 0 ? values : values.reverse();
}

function listMatch(value, list) {
  if (value == null) return null;
  const text = String(value);
  const exact = list.findIndex((item) => item === text);
  if (exact >= 0) return { index: exact, sample: text, canonical: true };
  const lower = text.toLowerCase();
  const insensitive = list.findIndex((item) => item.toLowerCase() === lower);
  if (insensitive < 0) return null;
  return { index: insensitive, sample: text, canonical: false };
}

function formatListItem(canonical, sample) {
  if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return canonical.toUpperCase();
  if (sample === sample.toLowerCase() && sample !== sample.toUpperCase()) return canonical.toLowerCase();
  return canonical;
}

function planListSeries(rawValues, fillCount, sign) {
  for (const list of FILL_LISTS) {
    const matches = rawValues.map((value) => listMatch(value, list));
    if (matches.some((item) => !item)) continue;
    const progression = detectModularArithmetic(matches.map((item) => item.index), list.length);
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
  const copyValues = values.map(normalizeCopyCell);
  if (mode === "copy") {
    return { mode: "copy", values: tileValues(copyValues, fillCount, sign) };
  }
  if (copyValues.every((value) => value == null || value === "")) {
    return { mode: "copy", values: tileValues(copyValues, fillCount, sign) };
  }
  const allowSingleNumberSeries = mode === "series";
  const listValues = planListSeries(copyValues, fillCount, sign);
  if (listValues) return { mode: "series", values: listValues };
  const dateTimeValues = planDateTimeSeries(copyValues, fillCount, sign);
  if (dateTimeValues) return { mode: "series", values: dateTimeValues };
  const dateValues = planDateSeries(copyValues, fillCount, sign);
  if (dateValues) return { mode: "series", values: dateValues };
  const timeValues = planTimeSeries(copyValues, fillCount, sign);
  if (timeValues) return { mode: "series", values: timeValues };
  const numberValues = planNumberSeries(copyValues, fillCount, sign, allowSingleNumberSeries);
  if (numberValues) return { mode: "series", values: numberValues };
  const textNumberValues = planTextNumberSeries(copyValues, fillCount, sign);
  if (textNumberValues) return { mode: "series", values: textNumberValues };
  return { mode: "copy", values: tileValues(copyValues, fillCount, sign) };
}

function createOutputMatrix(rowCount, columnCount) {
  return Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => ""));
}

function matricesEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let row = 0; row < left.length; row += 1) {
    if (left[row].length !== right[row].length) return false;
    for (let col = 0; col < left[row].length; col += 1) {
      if (left[row][col] !== right[row][col]) return false;
    }
  }
  return true;
}

function buildPlanMatrix(sourceMatrix, source, direction, fillCount, mode) {
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
    const planned = planAxisValues(values, fillCount, sign, mode);
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
    matrix,
    mode: mode === "copy" ? "copy" : (usedSeries ? "series" : "copy"),
  };
}

export function planAutoFill({ sourceMatrix, direction, fillCount, mode = "auto" } = {}) {
  const source = sourceShape(sourceMatrix);
  if (!source) return { ok: false, reason: "invalid-source" };
  if (!FILL_DIRECTIONS.includes(direction)) return { ok: false, reason: "invalid-direction" };
  if (!Number.isInteger(fillCount) || fillCount <= 0) return { ok: false, reason: "empty-fill" };

  const copyPlan = buildPlanMatrix(sourceMatrix, source, direction, fillCount, "copy");
  const seriesPlan = buildPlanMatrix(sourceMatrix, source, direction, fillCount, "series");
  const canToggleMode = !matricesEqual(copyPlan.matrix, seriesPlan.matrix);

  if (mode === "copy") {
    return { ok: true, mode: "copy", canToggleMode, matrix: copyPlan.matrix };
  }
  if (mode === "series") {
    return { ok: true, mode: seriesPlan.mode, canToggleMode, matrix: seriesPlan.matrix };
  }

  const autoPlan = buildPlanMatrix(sourceMatrix, source, direction, fillCount, "auto");
  if (mode === "toggle") {
    if (!canToggleMode) {
      return { ok: true, mode: autoPlan.mode, canToggleMode: false, matrix: autoPlan.matrix };
    }
    const toggled = autoPlan.mode === "series" ? copyPlan : seriesPlan;
    return { ok: true, mode: toggled.mode, canToggleMode: true, matrix: toggled.matrix };
  }

  return { ok: true, mode: autoPlan.mode, canToggleMode, matrix: autoPlan.matrix };
}

export function describeFillPreview({ sourceMatrix, direction, fillCount, mode = "auto" } = {}) {
  const planned = planAutoFill({ sourceMatrix, direction, fillCount, mode });
  if (!planned.ok) return null;
  const rows = planned.matrix.length;
  const cols = planned.matrix[0]?.length || 0;
  let endValue = null;
  if (direction === "down" || direction === "right") {
    endValue = planned.matrix[rows - 1]?.[cols - 1] ?? null;
  } else {
    endValue = planned.matrix[0]?.[0] ?? null;
  }
  const displayValue = endValue == null ? "NULL" : String(endValue);
  return {
    mode: planned.mode,
    canToggleMode: planned.canToggleMode,
    endValue,
    displayValue,
    fillCount,
    direction,
  };
}

export function resolveDoubleClickFillCount({ sourceBounds, totalRows, columnCount, getCellValue } = {}) {
  if (!sourceBounds || !Number.isInteger(totalRows) || totalRows <= sourceBounds.bottom + 1) return 0;
  const maxReachable = Math.min(totalRows - 1 - sourceBounds.bottom, MAX_AUTOFILL_ROWS);
  if (maxReachable <= 0) return 0;

  const isNonEmpty = (rowIndex, colIndex) => {
    if (typeof getCellValue !== "function") return false;
    const value = getCellValue(rowIndex, colIndex);
    return value != null && String(value).trim() !== "";
  };

  const scanColumnDown = (colIndex) => {
    let count = 0;
    while (count < maxReachable && isNonEmpty(sourceBounds.bottom + 1 + count, colIndex)) {
      count += 1;
    }
    return count;
  };

  if (sourceBounds.left > 0) {
    const leftCount = scanColumnDown(sourceBounds.left - 1);
    if (leftCount > 0) return leftCount;
  }
  if (Number.isInteger(columnCount) && sourceBounds.right + 1 < columnCount) {
    const rightCount = scanColumnDown(sourceBounds.right + 1);
    if (rightCount > 0) return rightCount;
  }
  return maxReachable;
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
