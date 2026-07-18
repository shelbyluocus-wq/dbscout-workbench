// 列类型判定。column_type 形如 "int"、"varchar(32)"、"decimal(10,2)"，
// 也覆盖 ClickHouse 风格（Int32/UInt64/Float64）。
const NUMERIC_TYPE_PATTERN = /^(u?int(8|16|32|64|128|256)?|tinyint|smallint|mediumint|integer|bigint|decimal|numeric|float(32|64)?|double|real|bit|year|serial|bigserial)(\s*\(|\s|$)/i;

export function isNumericColumnType(type) {
  return NUMERIC_TYPE_PATTERN.test(String(type || "").trim());
}
