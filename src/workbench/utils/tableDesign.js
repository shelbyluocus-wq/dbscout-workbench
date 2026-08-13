const LENGTH_TYPES = new Set(["char", "varchar", "binary", "varbinary", "bit"]);
const DECIMAL_TYPES = new Set(["decimal", "numeric", "dec", "fixed"]);
const INTEGER_TYPES = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint"]);
const FLOAT_TYPES = new Set(["float", "double", "real"]);
const TEXT_TYPES = new Set(["tinytext", "text", "mediumtext", "longtext", "json"]);
const BLOB_TYPES = new Set(["tinyblob", "blob", "mediumblob", "longblob"]);
const DATE_TYPES = new Set(["date", "datetime", "timestamp", "time", "year"]);
const ENUM_TYPES = new Set(["enum", "set"]);
const SUPPORTED_TYPES = new Set([
  ...LENGTH_TYPES,
  ...DECIMAL_TYPES,
  ...INTEGER_TYPES,
  ...FLOAT_TYPES,
  ...TEXT_TYPES,
  ...BLOB_TYPES,
  ...DATE_TYPES,
  ...ENUM_TYPES,
  "bool",
  "boolean",
]);

export const MYSQL_COMMON_TYPES = [
  // 数值类型
  { label: "TINYINT", value: "tinyint", defaultLength: "4" },
  { label: "SMALLINT", value: "smallint", defaultLength: "6" },
  { label: "MEDIUMINT", value: "mediumint", defaultLength: "9" },
  { label: "INT", value: "int", defaultLength: "11" },
  { label: "INTEGER", value: "integer", defaultLength: "11" },
  { label: "BIGINT", value: "bigint", defaultLength: "20" },
  { label: "DECIMAL", value: "decimal", defaultLength: "10,2" },
  { label: "NUMERIC", value: "numeric", defaultLength: "10,2" },
  { label: "DEC", value: "dec", defaultLength: "10,2" },
  { label: "FIXED", value: "fixed", defaultLength: "10,2" },
  { label: "FLOAT", value: "float", defaultLength: "" },
  { label: "DOUBLE", value: "double", defaultLength: "" },
  { label: "REAL", value: "real", defaultLength: "" },
  { label: "BIT", value: "bit", defaultLength: "1" },
  { label: "BOOL", value: "bool", defaultLength: "" },
  { label: "BOOLEAN", value: "boolean", defaultLength: "" },
  // 字符串类型
  { label: "CHAR", value: "char", defaultLength: "1" },
  { label: "VARCHAR", value: "varchar", defaultLength: "255" },
  { label: "BINARY", value: "binary", defaultLength: "1" },
  { label: "VARBINARY", value: "varbinary", defaultLength: "255" },
  { label: "TINYTEXT", value: "tinytext", defaultLength: "" },
  { label: "TEXT", value: "text", defaultLength: "" },
  { label: "MEDIUMTEXT", value: "mediumtext", defaultLength: "" },
  { label: "LONGTEXT", value: "longtext", defaultLength: "" },
  // 二进制类型
  { label: "TINYBLOB", value: "tinyblob", defaultLength: "" },
  { label: "BLOB", value: "blob", defaultLength: "" },
  { label: "MEDIUMBLOB", value: "mediumblob", defaultLength: "" },
  { label: "LONGBLOB", value: "longblob", defaultLength: "" },
  // 日期时间类型
  { label: "DATE", value: "date", defaultLength: "" },
  { label: "DATETIME", value: "datetime", defaultLength: "" },
  { label: "TIMESTAMP", value: "timestamp", defaultLength: "" },
  { label: "TIME", value: "time", defaultLength: "" },
  { label: "YEAR", value: "year", defaultLength: "" },
  // JSON
  { label: "JSON", value: "json", defaultLength: "" },
];

export function getTypeDefaultLength(typeValue) {
  const found = MYSQL_COMMON_TYPES.find((t) => t.value === typeValue);
  return found?.defaultLength || "";
}
const DEFAULT_MODES = new Set(["none", "null", "value", "expression"]);

function text(value) {
  return String(value ?? "").trim();
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = text(value).toLowerCase();
  if (["yes", "y", "true", "1"].includes(normalized)) return true;
  if (["no", "n", "false", "0"].includes(normalized)) return false;
  return fallback;
}

function normalizeTypeName(value) {
  const raw = text(value);
  return /^[a-z][\w]*$/i.test(raw) ? raw.toLowerCase() : raw;
}

export function parseColumnType(value) {
  const originalType = text(value);
  if (!originalType) {
    return { type: "", length: "", scale: "", originalType: "" };
  }

  const sized = originalType.match(/^([a-z][\w\s]*?)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)\s*(?:[a-z][\w\s]*)?$/i);
  if (sized) {
    return {
      type: normalizeTypeName(sized[1]),
      length: sized[2] || "",
      scale: sized[3] || "",
      originalType,
    };
  }

  const modified = originalType.match(/^([a-z][\w]*)(?:\s+(?:unsigned|signed|zerofill))+$/i);
  if (modified) {
    return {
      type: normalizeTypeName(modified[1]),
      length: "",
      scale: "",
      originalType,
    };
  }

  return {
    type: normalizeTypeName(originalType),
    length: "",
    scale: "",
    originalType,
  };
}

export function displayColumnType(column = {}) {
  const type = text(column.type || column.dataType || column.data_type || column.originalType);
  const length = text(column.length);
  const scale = text(column.scale);
  if (!type) return "";
  if (length && scale) return `${type}(${length},${scale})`;
  if (length) return `${type}(${length})`;
  return column.originalType && type.includes(" ") ? column.originalType : type;
}

function columnComment(column) {
  return text(firstDefined(column.column_comment, column.columnComment, column.comment, ""));
}

function columnDefaultValue(column) {
  if (hasOwn(column, "column_default")) return column.column_default;
  if (hasOwn(column, "columnDefault")) return column.columnDefault;
  if (hasOwn(column, "default_value")) return column.default_value;
  if (hasOwn(column, "defaultValue")) return column.defaultValue;
  return undefined;
}

function columnRawType(column) {
  const explicit = text(firstDefined(column.column_type, column.columnType, column.type, ""));
  const dataType = text(firstDefined(column.data_type, column.dataType, ""));
  const base = explicit || dataType;
  if (!base) return "";

  const parsedBase = normalizeTypeName(base);
  const characterLength = firstDefined(column.character_maximum_length, column.characterMaximumLength, column.length);
  if (characterLength != null && characterLength !== "" && LENGTH_TYPES.has(parsedBase)) {
    return `${parsedBase}(${characterLength})`;
  }

  const precision = firstDefined(column.numeric_precision, column.numericPrecision);
  const scale = firstDefined(column.numeric_scale, column.numericScale);
  if (precision != null && precision !== "" && DECIMAL_TYPES.has(parsedBase)) {
    return scale != null && scale !== "" ? `${parsedBase}(${precision},${scale})` : `${parsedBase}(${precision})`;
  }

  return base;
}

function normalizeDefaultMode(column, defaultValue, nullable, primaryKey) {
  const explicit = text(firstDefined(column.default_mode, column.defaultMode, ""));
  if (DEFAULT_MODES.has(explicit)) return explicit;
  if (defaultValue === undefined || defaultValue === null) return "none";
  if (text(defaultValue).toUpperCase() === "NULL" && nullable && !primaryKey) return "null";
  return "value";
}

function normalizeColumn(column = {}, index = 0) {
  const name = text(firstDefined(column.column_name, column.columnName, column.name, ""));
  const parsedType = parseColumnType(columnRawType(column));
  const primaryKey = Boolean(
    normalizeBoolean(firstDefined(column.is_primary_key, column.isPrimaryKey, column.primaryKey, false)) ||
    text(firstDefined(column.column_key, column.columnKey, "")).toUpperCase() === "PRI"
  );
  const nullable = primaryKey
    ? false
    : normalizeBoolean(firstDefined(column.is_nullable, column.isNullable, column.nullable, true), true);
  const defaultValue = columnDefaultValue(column);
  const defaultMode = normalizeDefaultMode(column, defaultValue, nullable, primaryKey);
  const explicitPrimaryKeyOrdinal = finiteInteger(firstDefined(
    column.primary_key_ordinal,
    column.primaryKeyOrdinal,
    column.primaryKeyOrder,
  ));

  return {
    id: text(firstDefined(column.id, column.column_id, column.columnId, name || `column-${index + 1}`)),
    originalName: text(firstDefined(column.originalName, column.original_name, name)),
    name,
    type: parsedType.type,
    length: parsedType.length,
    scale: parsedType.scale,
    originalType: parsedType.originalType,
    nullable,
    primaryKey,
    primaryKeyOrdinal: primaryKey && explicitPrimaryKeyOrdinal > 0 ? explicitPrimaryKeyOrdinal : null,
    defaultMode,
    defaultValue: defaultValue == null || defaultMode === "none" || defaultMode === "null" ? "" : String(defaultValue),
    comment: columnComment(column),
  };
}

export function normalizeTableDesign(meta = {}) {
  const columns = Array.isArray(meta.columns) ? meta.columns.map(normalizeColumn) : [];
  let nextPrimaryKeyOrdinal = columns.reduce(
    (highest, column) => Math.max(highest, column.primaryKeyOrdinal || 0),
    0,
  ) + 1;
  columns.forEach((column) => {
    if (column.primaryKey && !column.primaryKeyOrdinal) {
      column.primaryKeyOrdinal = nextPrimaryKeyOrdinal;
      nextPrimaryKeyOrdinal += 1;
    }
  });
  const primaryKeys = columns
    .filter((column) => column.primaryKey)
    .sort((left, right) => left.primaryKeyOrdinal - right.primaryKeyOrdinal);
  primaryKeys.forEach((column, index) => {
    column.primaryKeyOrdinal = index + 1;
  });
  return {
    tableName: text(firstDefined(meta.table_name, meta.tableName, meta.name, "")),
    tableComment: text(firstDefined(meta.table_comment, meta.tableComment, meta.comment, "")),
    columns,
  };
}

function finiteInteger(value) {
  if (typeof value === "number") return Number.isFinite(value) && Number.isInteger(value) ? value : null;
  const raw = text(value);
  if (!/^\d+$/.test(raw)) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && Number.isInteger(numeric) ? numeric : null;
}

function positiveInteger(value) {
  const numeric = finiteInteger(value);
  return numeric != null && numeric > 0;
}

function nonNegativeInteger(value) {
  const numeric = finiteInteger(value);
  return numeric != null && numeric >= 0;
}

function emptyColumnErrors() {
  return {
    name: "",
    type: "",
    length: "",
    scale: "",
    nullable: "",
    primaryKey: "",
    defaultMode: "",
    defaultValue: "",
    comment: "",
  };
}

function setColumnError(result, index, field, message) {
  result.valid = false;
  result.columns[index][field] = message;
  result.messages.push(message);
}

export function validateTableDesignDraft(draft = {}) {
  const columns = Array.isArray(draft.columns) ? draft.columns : [];
  const result = {
    valid: true,
    tableComment: "",
    columns: columns.map(emptyColumnErrors),
    messages: [],
  };

  if (!columns.length) {
    result.valid = false;
    result.messages.push("至少需要一个字段");
  }

  const nameBuckets = new Map();
  columns.forEach((column, index) => {
    const name = text(column.name);
    if (!name) {
      setColumnError(result, index, "name", "字段名不能为空");
      return;
    }
    const key = name.toLowerCase();
    if (!nameBuckets.has(key)) nameBuckets.set(key, []);
    nameBuckets.get(key).push(index);
  });

  for (const indexes of nameBuckets.values()) {
    if (indexes.length > 1) {
      indexes.forEach((index) => setColumnError(result, index, "name", "字段名不能重复"));
    }
  }

  const primaryKeyOrdinals = new Set();
  const primaryKeyColumns = columns.filter((column) => column.primaryKey);
  primaryKeyColumns.forEach((column, index) => {
    const ordinal = finiteInteger(column.primaryKeyOrdinal);
    if (ordinal == null || ordinal <= 0 || primaryKeyOrdinals.has(ordinal)) {
      setColumnError(result, columns.indexOf(column), "primaryKey", "主键顺序必须连续且不能重复");
      return;
    }
    primaryKeyOrdinals.add(ordinal);
  });
  if (primaryKeyOrdinals.size === primaryKeyColumns.length) {
    for (let ordinal = 1; ordinal <= primaryKeyColumns.length; ordinal += 1) {
      if (!primaryKeyOrdinals.has(ordinal)) {
        primaryKeyColumns.forEach((column) => {
          setColumnError(result, columns.indexOf(column), "primaryKey", "主键顺序必须从 1 开始连续排列");
        });
        break;
      }
    }
  }

  columns.forEach((column, index) => {
    const type = text(column.type).toLowerCase();
    const defaultMode = text(column.defaultMode || "none") || "none";

    if (!type) {
      setColumnError(result, index, "type", "请选择字段类型");
    } else if (!SUPPORTED_TYPES.has(type)) {
      setColumnError(result, index, "type", "暂不支持该字段类型");
    }

    if (LENGTH_TYPES.has(type) && !positiveInteger(column.length)) {
      setColumnError(result, index, "length", "长度必须是正整数");
    }

    if (DECIMAL_TYPES.has(type)) {
      if (!positiveInteger(column.length)) {
        setColumnError(result, index, "length", "精度必须是正整数");
      }
      if (text(column.scale) && !nonNegativeInteger(column.scale)) {
        setColumnError(result, index, "scale", "小数位必须是非负整数");
      }
    }

    if (column.primaryKey && column.nullable) {
      setColumnError(result, index, "nullable", "主键字段必须为非空");
    }

    if (!DEFAULT_MODES.has(defaultMode)) {
      setColumnError(result, index, "defaultMode", "请选择默认值模式");
    }

    if (defaultMode === "null") {
      if (column.primaryKey) {
        setColumnError(result, index, "defaultValue", "主键字段不能使用 NULL 默认值");
      } else if (!column.nullable) {
        setColumnError(result, index, "defaultValue", "非空字段不能使用 NULL 默认值");
      }
    }

    if (defaultMode === "expression" && !text(column.defaultValue)) {
      setColumnError(result, index, "defaultValue", "默认表达式不能为空");
    }
  });

  result.messages = [...new Set(result.messages)];
  return result;
}

function numberOrNull(value) {
  const raw = text(value);
  if (!raw) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function sourceIdentity(source = {}) {
  const raw = source?.value || source;
  return {
    connectionId: text(firstDefined(raw.connectionId, raw.connection_id, "")),
    database: text(firstDefined(raw.database, "")),
    tableName: text(firstDefined(raw.tableName, raw.table_name, raw.name, "")),
  };
}

export function buildTableDesignPayload(source = {}, draft = {}) {
  const identity = sourceIdentity(source);
  return {
    ...identity,
    draft: {
      tableComment: text(draft.tableComment),
      columns: (Array.isArray(draft.columns) ? draft.columns : []).map((column) => {
        const defaultMode = text(column.defaultMode || "none") || "none";
        return {
          originalName: text(firstDefined(column.originalName, column.original_name, column.name)),
          name: text(column.name),
          type: text(column.type).toLowerCase(),
          length: numberOrNull(column.length),
          scale: numberOrNull(column.scale),
          nullable: column.primaryKey ? false : Boolean(column.nullable),
          primaryKey: Boolean(column.primaryKey),
          primaryKeyOrdinal: column.primaryKey ? finiteInteger(column.primaryKeyOrdinal) : null,
          defaultMode,
          defaultValue: defaultMode === "none" || defaultMode === "null" ? null : String(column.defaultValue ?? ""),
          comment: text(column.comment),
        };
      }),
    },
  };
}
