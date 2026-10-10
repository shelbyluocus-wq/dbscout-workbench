// 列类型判定。column_type 形如 "int"、"varchar(32)"、"decimal(10,2)"，
// 也覆盖 ClickHouse 风格（Int32/UInt64/Float64）。
const NUMERIC_TYPE_PATTERN = /^(u?int(8|16|32|64|128|256)?|tinyint|smallint|mediumint|integer|bigint|decimal|numeric|float(32|64)?|double|real|bit|year|serial|bigserial)(\s*\(|\s|$)/i;

export function isNumericColumnType(type) {
  return NUMERIC_TYPE_PATTERN.test(String(type || "").trim());
}

// Visual family of a column type, used to pick its icon in schema lists.
// Covers MySQL, ClickHouse (Nullable/LowCardinality wrappers) and the sampled
// MongoDB field types.
export function columnTypeKind(type, { primaryKey = false } = {}) {
  if (primaryKey) return "key";
  const raw = String(type || "").trim().toLowerCase();
  const value = raw.replace(/^(nullable|lowcardinality)\((.*)\)$/, "$2").trim();
  if (!value) return "other";
  if (/^tinyint\(1\)(\s|$)/.test(value) || /^(bool|boolean)\b/.test(value)) return "boolean";
  if (isNumericColumnType(value) && !/^year\b/.test(value)) return "number";
  if (/^(datetime|timestamp|datetime64)\b/.test(value)) return "datetime";
  if (/^(date|date32|year)\b/.test(value)) return "date";
  if (/^time\b/.test(value)) return "time";
  if (/^(json|object|document)\b/.test(value)) return "json";
  if (/^array\b/.test(value)) return "array";
  if (/^(objectid|uuid)\b/.test(value)) return "identifier";
  if (/^(binary|varbinary|blob|tinyblob|mediumblob|longblob|bit|bindata)\b/.test(value)) return "binary";
  if (/^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/.test(value)) return "spatial";
  if (/^(char|varchar|text|tinytext|mediumtext|longtext|enum|set|string|fixedstring|nchar|nvarchar)\b/.test(value)) return "text";
  return "other";
}
