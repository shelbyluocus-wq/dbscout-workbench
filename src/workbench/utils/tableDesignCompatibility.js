import { columnConstraint, validateCellValue } from "./valueValidation.js";

const EMPTY_STRING_TYPES = new Set([
  "char", "varchar", "binary", "varbinary",
  "tinytext", "text", "mediumtext", "longtext",
  "tinyblob", "blob", "mediumblob", "longblob",
  "enum", "set",
]);

const BYTE_LIMITS = new Map([
  ["tinytext", 255],
  ["tinyblob", 255],
  ["text", 65_535],
  ["blob", 65_535],
  ["mediumtext", 16_777_215],
  ["mediumblob", 16_777_215],
  ["longtext", 4_294_967_295],
  ["longblob", 4_294_967_295],
]);

function result(shortMessage = "") {
  return shortMessage
    ? { valid: false, errors: [{ shortMessage }] }
    : { valid: true, errors: [] };
}

function firstTypeNumber(column = {}) {
  const raw = String(column.column_type || column.columnType || column.type || "");
  const match = raw.match(/\(\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function validateTinyIntDisplayWidth(constraint, raw) {
  const normalized = raw.trim();
  if (!/^-?\d+$/.test(normalized)) return result("整数格式错误");
  const numeric = BigInt(normalized);
  const minimum = constraint.unsigned ? 0n : -128n;
  const maximum = constraint.unsigned ? 255n : 127n;
  return numeric < minimum || numeric > maximum ? result("数值超范围") : result();
}

/**
 * Browser-demo fallback for DDL conversion previews. Real MySQL previews are
 * authoritative and run on the server; this helper keeps mock semantics from
 * reusing cell-editor shortcuts such as boolean-only TINYINT(1).
 */
export function validateTableDesignConversion(column = {}, value) {
  const constraint = columnConstraint(column);
  if (value == null) {
    return constraint.nullable ? result() : result("不能为空");
  }

  const raw = String(value);
  if (raw === "") {
    return EMPTY_STRING_TYPES.has(constraint.type)
      ? result()
      : result("空字符串不能转换");
  }
  if (raw.trim() === "" && !EMPTY_STRING_TYPES.has(constraint.type)) {
    return result("空白字符串不能转换");
  }

  if (constraint.type === "binary" || constraint.type === "varbinary") {
    const maximum = firstTypeNumber(column);
    return maximum != null && utf8ByteLength(raw) > maximum
      ? result("字节长度超限")
      : result();
  }
  const byteLimit = BYTE_LIMITS.get(constraint.type);
  if (byteLimit != null) {
    return utf8ByteLength(raw) > byteLimit ? result("字节长度超限") : result();
  }
  if (constraint.type === "bit") {
    const normalized = raw.trim();
    if (!/^\d+$/.test(normalized)) return result("位值格式错误");
    const width = Math.min(firstTypeNumber(column) || 1, 64);
    const maximum = (1n << BigInt(width)) - 1n;
    return BigInt(normalized) > maximum ? result("位值超出范围") : result();
  }
  if (["bool", "boolean", "tinyint(1)"].includes(constraint.type)) {
    return validateTinyIntDisplayWidth(constraint, raw);
  }

  return validateCellValue({
    table: { columns: [column] },
    row: {},
    columnName: constraint.name,
    value,
  });
}
