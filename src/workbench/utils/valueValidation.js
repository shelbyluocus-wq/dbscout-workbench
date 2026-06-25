import { columnName } from "./normalize.js";

const INTEGER_RANGES = {
  tinyint: { signed: [-128n, 127n], unsigned: [0n, 255n] },
  smallint: { signed: [-32768n, 32767n], unsigned: [0n, 65535n] },
  mediumint: { signed: [-8388608n, 8388607n], unsigned: [0n, 16777215n] },
  int: { signed: [-2147483648n, 2147483647n], unsigned: [0n, 4294967295n] },
  integer: { signed: [-2147483648n, 2147483647n], unsigned: [0n, 4294967295n] },
  bigint: { signed: [-9223372036854775808n, 9223372036854775807n], unsigned: [0n, 18446744073709551615n] },
};

const INTEGER_TYPES = new Set(Object.keys(INTEGER_RANGES));
const DECIMAL_TYPES = new Set(["decimal", "numeric", "dec", "fixed"]);
const FLOAT_TYPES = new Set(["float", "double", "real"]);
const STRING_TYPES = new Set(["char", "varchar", "binary", "varbinary"]);
const JSON_TYPES = new Set(["json"]);
const BOOLEAN_TYPES = new Set(["bool", "boolean", "tinyint(1)"]);
const DATE_TYPES = new Set(["date", "datetime", "timestamp", "time", "year"]);

function text(value) {
  return String(value ?? "").trim();
}

function parseQuotedValues(inner) {
  const values = [];
  const regex = /'((?:''|\\'|[^'])*)'/g;
  let match;
  while ((match = regex.exec(inner))) {
    values.push(match[1].replaceAll("''", "'").replaceAll("\\'", "'"));
  }
  return values;
}

function parseType(rawValue) {
  const raw = text(rawValue);
  const normalized = raw.toLowerCase();
  const type = normalized.split(/[\s(]/).find(Boolean) || "";
  const lengthMatch = normalized.match(/\((\d+)(?:\s*,\s*(\d+))?\)/);
  const valuesMatch = raw.match(/\((.*)\)/);
  return {
    raw,
    type,
    firstNumber: lengthMatch ? Number(lengthMatch[1]) : null,
    secondNumber: lengthMatch?.[2] ? Number(lengthMatch[2]) : null,
    values: valuesMatch ? parseQuotedValues(valuesMatch[1]) : [],
    unsigned: /\bunsigned\b/.test(normalized),
  };
}

function bool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = text(value).toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  if (normalized === "yes") return true;
  if (normalized === "no") return false;
  return fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizedType(column, parsed) {
  const rawType = text(column.data_type || column.dataType || parsed.type).toLowerCase() || parsed.type;
  const type = rawType.split(/[\s(]/).find(Boolean) || parsed.type;
  if ((type === "tinyint" || parsed.type === "tinyint") && parsed.firstNumber === 1) {
    return "tinyint(1)";
  }
  return type;
}

export function columnConstraint(column = {}) {
  const parsed = parseType(column.column_type || column.columnType || column.type || column.data_type || column.dataType || "");
  const type = normalizedType(column, parsed);
  const maxLength = numberOrNull(
    column.character_maximum_length ?? column.characterMaximumLength ?? (STRING_TYPES.has(type) ? parsed.firstNumber : null),
  );
  const precision = numberOrNull(
    column.numeric_precision ?? column.numericPrecision ?? (DECIMAL_TYPES.has(type) ? parsed.firstNumber : null),
  );
  const scale = numberOrNull(
    column.numeric_scale ?? column.numericScale ?? (DECIMAL_TYPES.has(type) ? parsed.secondNumber : null),
  );
  const enumValues = Array.isArray(column.enum_values)
    ? column.enum_values
    : Array.isArray(column.enumValues)
      ? column.enumValues
      : type === "enum"
        ? parsed.values
        : [];
  const setValues = Array.isArray(column.set_values)
    ? column.set_values
    : Array.isArray(column.setValues)
      ? column.setValues
      : type === "set"
        ? parsed.values
        : [];
  const primaryKey = bool(column.is_primary_key ?? column.isPrimaryKey ?? column.primaryKey, false);
  const defaultMode = text(column.default_mode ?? column.defaultMode ?? "");
  const extra = text(column.extra ?? column.extraInfo ?? column.extra_info).toLowerCase();
  return {
    name: columnName(column),
    type,
    nullable: primaryKey ? false : bool(column.is_nullable ?? column.isNullable ?? column.nullable, true),
    primaryKey,
    maxLength,
    precision,
    scale,
    unsigned: bool(column.is_unsigned ?? column.isUnsigned, parsed.unsigned),
    enumValues,
    setValues,
    isAutoIncrement: bool(column.is_auto_increment ?? column.isAutoIncrement, false) || extra.includes("auto_increment"),
    isGenerated: bool(column.is_generated ?? column.isGenerated, false) || extra.includes("generated"),
    defaultMode,
  };
}

function error(code, constraintOrColumnName, message, shortMessage = message, extra = {}) {
  const name = typeof constraintOrColumnName === "string" ? constraintOrColumnName : constraintOrColumnName?.name || "";
  return { code, columnName: name, message, shortMessage, ...extra };
}

function tableColumns(table = {}) {
  return Array.isArray(table.columns) ? table.columns.map(columnConstraint) : [];
}

function primaryKeys(table = {}) {
  const explicit = Array.isArray(table.primaryKeys) ? table.primaryKeys.filter(Boolean) : [];
  return explicit.length ? explicit : tableColumns(table).filter((column) => column.primaryKey).map((column) => column.name);
}

function hasOwn(row, key) {
  return Object.prototype.hasOwnProperty.call(row ?? {}, key);
}

function valueForKey(row, key) {
  return row?.[key] ?? row?.[key.toLowerCase?.()] ?? "";
}

function primaryKeySignature(row, keys) {
  if (!keys.length) return "";
  const values = keys.map((key) => text(valueForKey(row, key)));
  return values.every((value) => value !== "") ? values.join("\x1f") : "";
}

function validateRequired(constraint, value, present = true) {
  if (!constraint.nullable && (!present || (text(value) === "" && !acceptsExplicitEmptyValue(constraint)))) {
    return error("required", constraint, `字段 ${constraint.name} 不能为空`, "不能为空");
  }
  return null;
}

function acceptsExplicitEmptyValue(constraint) {
  if (constraint.primaryKey) return false;
  return STRING_TYPES.has(constraint.type) || constraint.type === "enum" || constraint.type === "set";
}

function validateInteger(constraint, value) {
  const raw = text(value);
  if (!raw) return null;
  if (!/^-?\d+$/.test(raw)) {
    return error("invalid-integer", constraint, `字段 ${constraint.name} 需要整数`, "整数格式错误");
  }
  const numeric = BigInt(raw);
  const range = INTEGER_RANGES[constraint.type];
  if (!range) return null;
  const [min, max] = constraint.unsigned ? range.unsigned : range.signed;
  if (numeric < min || numeric > max) {
    return error("integer-range", constraint, `字段 ${constraint.name} 数值超出范围`, "数值超范围");
  }
  return null;
}

function decimalParts(raw) {
  const normalized = raw.replace(/^-/, "");
  const [whole = "", fractional = ""] = normalized.split(".");
  const significantWhole = whole.replace(/^0+/, "");
  return { whole: significantWhole, fractional };
}

function validateDecimal(constraint, value) {
  const raw = text(value);
  if (!raw) return null;
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) {
    return error("invalid-decimal", constraint, `字段 ${constraint.name} 需要数字`, "数字格式错误");
  }
  const { whole, fractional } = decimalParts(raw);
  if (constraint.scale != null && fractional.length > constraint.scale) {
    return error("decimal-scale", constraint, `字段 ${constraint.name} 小数位最多 ${constraint.scale} 位`, "小数位超限");
  }
  if (constraint.precision != null && whole.length + fractional.length > constraint.precision) {
    return error("decimal-precision", constraint, `字段 ${constraint.name} 精度最多 ${constraint.precision} 位`, "精度超限");
  }
  if (constraint.precision != null && constraint.scale != null && whole.length > constraint.precision - constraint.scale) {
    return error("decimal-precision", constraint, `字段 ${constraint.name} 整数位最多 ${constraint.precision - constraint.scale} 位`, "精度超限");
  }
  if (constraint.unsigned && raw.startsWith("-")) {
    return error("decimal-range", constraint, `字段 ${constraint.name} 数值不能为负`, "数值超范围");
  }
  return null;
}

function validateFloat(constraint, value) {
  const raw = text(value);
  if (!raw) return null;
  if (!Number.isFinite(Number(raw))) {
    return error("invalid-float", constraint, `字段 ${constraint.name} 需要数字`, "数字格式错误");
  }
  if (constraint.unsigned && Number(raw) < 0) {
    return error("float-range", constraint, `字段 ${constraint.name} 数值不能为负`, "数值超范围");
  }
  return null;
}

function validateLength(constraint, value) {
  const raw = String(value ?? "");
  if (constraint.maxLength != null && [...raw].length > constraint.maxLength) {
    return error("length-overflow", constraint, `字段 ${constraint.name} 最多 ${constraint.maxLength} 个字符`, "长度超限");
  }
  return null;
}

function validateJson(constraint, value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    JSON.parse(raw);
    return null;
  } catch {
    return error("invalid-json", constraint, `字段 ${constraint.name} 需要合法 JSON`, "JSON 格式错误");
  }
}

function validateBoolean(constraint, value) {
  const raw = text(value).toLowerCase();
  if (!raw) return null;
  if (!["0", "1", "true", "false"].includes(raw)) {
    return error("invalid-boolean", constraint, `字段 ${constraint.name} 需要布尔值 0/1/true/false`, "布尔格式错误");
  }
  return null;
}

function validDateParts(year, month, day) {
  const parsedYear = Number(year);
  const parsedMonth = Number(month);
  const parsedDay = Number(day);
  const date = new Date(Date.UTC(parsedYear, parsedMonth - 1, parsedDay));
  return date.getUTCFullYear() === parsedYear && date.getUTCMonth() === parsedMonth - 1 && date.getUTCDate() === parsedDay;
}

function validateDateTime(constraint, value) {
  const raw = text(value);
  if (!raw) return null;
  const checks = {
    date: () => {
      const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return !!match && validDateParts(match[1], match[2], match[3]);
    },
    datetime: () => {
      const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
      return !!match && validDateParts(match[1], match[2], match[3]) && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59;
    },
    timestamp: () => {
      const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
      return !!match && validDateParts(match[1], match[2], match[3]) && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59;
    },
    time: () => {
      const match = raw.match(/^-?(\d{1,3}):(\d{2}):(\d{2})(?:\.\d+)?$/);
      return !!match && Number(match[2]) <= 59 && Number(match[3]) <= 59;
    },
    year: () => /^\d{4}$/.test(raw),
  };
  const valid = checks[constraint.type]?.() ?? true;
  if (!valid) {
    return error(`invalid-${constraint.type}`, constraint, `字段 ${constraint.name} 需要 ${constraint.type} 格式`, "日期时间格式错误");
  }
  return null;
}

function validateEnumSet(constraint, value) {
  const raw = text(value);
  if (!raw) return null;
  if (constraint.type === "enum" && constraint.enumValues.length && !constraint.enumValues.includes(raw)) {
    return error("invalid-enum", constraint, `字段 ${constraint.name} 必须是：${constraint.enumValues.join("、")}`, "枚举值错误");
  }
  if (constraint.type === "set" && constraint.setValues.length) {
    const values = raw.split(",").map((item) => item.trim()).filter(Boolean);
    if (values.some((item) => !constraint.setValues.includes(item))) {
      return error("invalid-set", constraint, `字段 ${constraint.name} 只能包含：${constraint.setValues.join("、")}`, "集合值错误");
    }
  }
  return null;
}

function validateConstraint(constraint, value, present = true) {
  if (!present && (constraint.isAutoIncrement || constraint.isGenerated || (constraint.defaultMode && constraint.defaultMode !== "none"))) {
    return null;
  }
  const required = validateRequired(constraint, value, present);
  if (required) return required;
  if (INTEGER_TYPES.has(constraint.type)) return validateInteger(constraint, value);
  if (DECIMAL_TYPES.has(constraint.type)) return validateDecimal(constraint, value);
  if (FLOAT_TYPES.has(constraint.type)) return validateFloat(constraint, value);
  if (STRING_TYPES.has(constraint.type)) return validateLength(constraint, value);
  if (JSON_TYPES.has(constraint.type)) return validateJson(constraint, value);
  if (BOOLEAN_TYPES.has(constraint.type)) return validateBoolean(constraint, value);
  if (DATE_TYPES.has(constraint.type)) return validateDateTime(constraint, value);
  if (constraint.type === "enum" || constraint.type === "set") return validateEnumSet(constraint, value);
  return null;
}

function validationResult(errors) {
  return { valid: errors.length === 0, errors };
}

export function validateCellValue({ table, rows = [], row = {}, columnName: editedColumnName, value } = {}) {
  const constraint = tableColumns(table).find((item) => item.name === editedColumnName);
  if (!constraint) return { valid: true, errors: [] };

  const errors = [];
  const scalar = validateConstraint(constraint, value, true);
  if (scalar) errors.push(scalar);

  const keys = primaryKeys(table);
  if (keys.includes(editedColumnName)) {
    const nextRow = { ...row, [editedColumnName]: value };
    const signature = primaryKeySignature(nextRow, keys);
    if (signature && rows.some((candidate) => candidate !== row && primaryKeySignature(candidate, keys) === signature)) {
      errors.push(error("duplicate-primary-key", editedColumnName, "主键重复，不能保存", "主键重复"));
    }
  }

  return validationResult(errors);
}

export function validateRowDraft({ table, rows = [], draft = {}, draftRows = [] } = {}) {
  const errors = [];
  for (const constraint of tableColumns(table)) {
    const present = hasOwn(draft, constraint.name);
    const scalar = validateConstraint(constraint, draft[constraint.name], present);
    if (scalar) errors.push(scalar);
  }

  const keys = primaryKeys(table);
  const signature = primaryKeySignature(draft, keys);
  if (signature && [...rows, ...draftRows].some((row) => primaryKeySignature(row, keys) === signature)) {
    errors.push(error("duplicate-primary-key", keys[0] || "", "主键重复，不能保存", "主键重复", { columns: keys }));
  }

  return validationResult(errors);
}

export function validateBatchEdits({ table, rows = [], edits = [] } = {}) {
  const errors = [];
  const validEdits = [];
  const acceptedRows = new Map();

  for (const edit of edits) {
    const baseRow = acceptedRows.get(edit.row) || edit.row || {};
    const result = validateCellValue({
      table,
      rows: rows.map((row) => acceptedRows.get(row) || row),
      row: baseRow,
      columnName: edit.columnName,
      value: edit.value,
    });
    if (result.valid) {
      const nextRow = { ...baseRow, [edit.columnName]: edit.value };
      acceptedRows.set(edit.row, nextRow);
      validEdits.push(edit);
    } else {
      errors.push(...result.errors.map((item) => ({ ...item, rowIndex: edit.rowIndex })));
    }
  }

  return { valid: errors.length === 0, validEdits, errors };
}
