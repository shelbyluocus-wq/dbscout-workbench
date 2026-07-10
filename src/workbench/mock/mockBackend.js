import { mockDatabaseSchemas, resolveMockSchema } from "./mockSchema.js";
import { getOrInitRows, rowCache } from "./mockRows.js";
import { emitMockEvent } from "./mockEventBus.js";
import { columnName } from "../utils/normalize.js";
import { contiguousSearchPreview, findCaseInsensitiveRange, matchSearchText } from "../utils/searchMatch.js";
import { validateCellValue, validateRowDraft } from "../utils/valueValidation.js";
import { DEFAULT_PAGE_SIZE } from "../constants.js";

let mockSessionSeq = 0;
let mockConnectionSeq = 10;
const mockSessions = new Map();
let mockAgentContext = { connectionId: "demo", database: "game_db", activeTableName: "player" };
const pendingMockAgentRequests = new Map();
const mockConnections = [
  { id: "demo", kind: "mysql", label: "Demo GameDB", host: "demo", port: 3306, username: "root", database: "game_db", connected: true, readOnly: false },
  { id: "demo-staging", kind: "mysql", label: "Staging Server", host: "staging.local", port: 3306, username: "dev", database: "game_db", connected: true, readOnly: false },
  { id: "demo-test", kind: "mysql", label: "Test Server", host: "test.local", port: 3307, username: "tester", database: "game_db", connected: true, readOnly: false },
];

const mockConnectionDatabases = {
  demo: ["game_db", "game_config"],
  "demo-staging": ["game_db", "analytics_db"],
  "demo-test": ["game_db", "game_db_archive"],
};
const PRIMARY_KEY_DUPLICATE_MESSAGE = "主键重复，不能保存";
const schemaOverrides = new Map();

// Numeric-aware comparison so numeric columns sort by value (10 > 9) instead
// of lexicographically ("10" < "9"). Falls back to string compare (#7).
function compareSortValues(a, b) {
  const numA = Number(a);
  const numB = Number(b);
  if (Number.isFinite(numA) && Number.isFinite(numB)) {
    return numA < numB ? -1 : numA > numB ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function resolveContext(payload) {
  const connectionId = payload.connectionId || payload.connection_id || "demo";
  const connection = mockConnections.find((c) => c.id === connectionId);
  const database = payload.database || connection?.database || "game_db";
  return { connectionId, database };
}

function mockSessionContext(sessionId) {
  const session = mockSessions.get(sessionId);
  return {
    tableName: session?.tableName || "player",
    connectionId: session?.connectionId || "demo",
    database: session?.database || "game_db",
    readOnly: Boolean(session?.readOnly),
  };
}

function normalizeConnectionKind(kind, url = "") {
  const normalized = String(kind || "").trim().toLowerCase();
  if (normalized === "clickhouse") return "clickhouse";
  return String(url || "").trim().toLowerCase().startsWith("http") ? "clickhouse" : "mysql";
}

function isReadOnlyConnection(connection) {
  return Boolean(connection?.readOnly || connection?.read_only || normalizeConnectionKind(connection?.kind) === "clickhouse");
}

function isMockConnectionReadOnly(connectionId) {
  return isReadOnlyConnection(mockConnections.find((connection) => String(connection.id) === String(connectionId)));
}

function mockConnectionFromUrl(url, kind) {
  const normalizedKind = normalizeConnectionKind(kind, url);
  try {
    const parsed = new URL(url);
    const username = decodeURIComponent(parsed.username || (normalizedKind === "clickhouse" ? "default" : "root"));
    const defaultPort = normalizedKind === "clickhouse" ? 8123 : 3306;
    const idPrefix = normalizedKind === "clickhouse" ? "clickhouse" : "mysql";
    return {
      id: `${idPrefix}-${++mockConnectionSeq}`,
      kind: normalizedKind,
      label: `${username}@${parsed.hostname}:${parsed.port || defaultPort}`,
      host: parsed.hostname,
      port: parsed.port || String(defaultPort),
      username,
      database: "game_db",
      connected: true,
      readOnly: normalizedKind === "clickhouse",
    };
  } catch {
    const defaultPort = normalizedKind === "clickhouse" ? "8123" : "3306";
    const defaultUser = normalizedKind === "clickhouse" ? "default" : "root";
    const idPrefix = normalizedKind === "clickhouse" ? "clickhouse" : "mysql";
    return {
      id: `${idPrefix}-${++mockConnectionSeq}`,
      kind: normalizedKind,
      label: `${normalizedKind === "clickhouse" ? "ClickHouse" : "MySQL"} ${mockConnectionSeq}`,
      host: "127.0.0.1",
      port: defaultPort,
      username: defaultUser,
      database: "game_db",
      connected: true,
      readOnly: normalizedKind === "clickhouse",
    };
  }
}

function upsertMockConnection(url, kind) {
  const next = mockConnectionFromUrl(url, kind);
  const existing = mockConnections.find((connection) =>
    normalizeConnectionKind(connection.kind) === next.kind &&
    connection.host === next.host &&
    String(connection.port) === String(next.port) &&
    connection.username === next.username);
  if (existing) {
    existing.kind = next.kind;
    existing.readOnly = next.readOnly;
    existing.connected = true;
    return existing;
  }
  mockConnections.push(next);
  return next;
}

function cloneTable(table) {
  return {
    ...table,
    columns: (table?.columns || []).map((column) => ({ ...column })),
  };
}

function sourceKey(connectionId, database, tableName) {
  return `${connectionId || "demo"}/${database || "game_db"}/${tableName}`;
}

function resolvedTable(connectionId, database, tableName) {
  const key = sourceKey(connectionId, database, tableName);
  const override = schemaOverrides.get(key);
  if (override) return cloneTable(override);
  const schema = tableSchemaFor(connectionId, database);
  return cloneTable(schema.find((t) => t.table_name === tableName) || schema[0]);
}

function resolveMockCopyTableName(existingNames, baseName) {
  const hasName = (candidate) => existingNames.some((name) => String(name).toLowerCase() === String(candidate).toLowerCase());
  if (!hasName(baseName)) return baseName;
  let index = 1;
  while (hasName(`${baseName}_copy${index}`)) index += 1;
  return `${baseName}_copy${index}`;
}

function tableSchemaFor(connectionId, database) {
  return resolveMockSchema(connectionId, database).map((table) => {
    const override = schemaOverrides.get(sourceKey(connectionId, database, table.table_name));
    return cloneTable(override || table);
  });
}

function parseColumnType(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^([a-z][\w]*)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/i);
  if (!match) return { dataType: raw.toLowerCase(), length: null, scale: null };
  return {
    dataType: match[1].toLowerCase(),
    length: Number(match[2]),
    scale: match[3] == null ? null : Number(match[3]),
  };
}

function columnTypeFromDraft(column = {}, fallback = {}) {
  const type = String(column.type || fallback.data_type || fallback.column_type || "").trim().toLowerCase();
  const length = column.length ?? "";
  const scale = column.scale ?? "";
  if (type && length !== "" && length != null && scale !== "" && scale != null) return `${type}(${length},${scale})`;
  if (type && length !== "" && length != null) return `${type}(${length})`;
  return type || fallback.column_type || fallback.columnType || "";
}

function enrichColumn(column = {}, index = 0) {
  const columnType = column.column_type || column.columnType || column.type || "";
  const parsed = parseColumnType(columnType);
  const name = columnName(column) || column.name || `column_${index + 1}`;
  const defaultValue = Object.prototype.hasOwnProperty.call(column, "column_default")
    ? column.column_default
    : column.columnDefault ?? null;
  const defaultMode = column.default_mode || column.defaultMode || (defaultValue == null ? "none" : "value");
  return {
    ...column,
    column_name: name,
    columnName: name,
    column_type: columnType,
    columnType,
    data_type: column.data_type || column.dataType || parsed.dataType,
    dataType: column.dataType || column.data_type || parsed.dataType,
    character_maximum_length: column.character_maximum_length ?? column.characterMaximumLength ?? parsed.length,
    characterMaximumLength: column.characterMaximumLength ?? column.character_maximum_length ?? parsed.length,
    numeric_precision: column.numeric_precision ?? column.numericPrecision ?? parsed.length,
    numericPrecision: column.numericPrecision ?? column.numeric_precision ?? parsed.length,
    numeric_scale: column.numeric_scale ?? column.numericScale ?? parsed.scale,
    numericScale: column.numericScale ?? column.numeric_scale ?? parsed.scale,
    is_nullable: Boolean(column.is_nullable),
    isNullable: Boolean(column.is_nullable),
    is_primary_key: Boolean(column.is_primary_key),
    isPrimaryKey: Boolean(column.is_primary_key),
    column_default: defaultValue,
    columnDefault: defaultValue,
    default_mode: defaultMode,
    defaultMode,
    column_comment: column.column_comment || column.columnComment || "",
    columnComment: column.columnComment || column.column_comment || "",
    original_name: column.original_name || name,
    originalName: column.originalName || column.original_name || name,
    original_type: column.original_type || column.originalType || columnType,
    originalType: column.originalType || column.original_type || columnType,
  };
}

function designFor(table) {
  const clone = cloneTable(table);
  return {
    ...clone,
    table_name: clone.table_name,
    tableName: clone.table_name,
    table_comment: clone.table_comment || "",
    tableComment: clone.table_comment || "",
    columns: clone.columns.map(enrichColumn),
  };
}

function tableFromDraft(baseTable, draft = {}) {
  const baseColumns = baseTable.columns || [];
  const baseColumnByName = new Map(baseColumns.map((column) => [columnName(column), column]));
  return {
    table_name: baseTable.table_name,
    tableName: baseTable.table_name,
    table_comment: String(draft.tableComment ?? baseTable.table_comment ?? ""),
    tableComment: String(draft.tableComment ?? baseTable.table_comment ?? ""),
    columns: (Array.isArray(draft.columns) ? draft.columns : []).map((column, index) => {
      const explicitOriginal = String(column.originalName ?? column.original_name ?? "").trim();
      const original = explicitOriginal ? (baseColumnByName.get(explicitOriginal) || {}) : {};
      const name = String(column.name || column.column_name || columnName(original) || `column_${index + 1}`).trim();
      const columnType = columnTypeFromDraft(column, original);
      const defaultMode = String(column.defaultMode || column.default_mode || "none");
      const defaultValue = defaultMode === "none" ? null : defaultMode === "null" ? null : column.defaultValue ?? column.column_default ?? null;
      const enriched = enrichColumn({
        column_name: name,
        column_type: columnType,
        is_nullable: column.primaryKey ? false : Boolean(column.nullable ?? column.is_nullable),
        is_primary_key: Boolean(column.primaryKey ?? column.is_primary_key),
        column_default: defaultValue,
        default_mode: defaultMode,
        column_comment: String(column.comment ?? column.column_comment ?? ""),
        original_name: explicitOriginal || columnName(original),
        original_type: original.column_type || original.original_type || columnType,
      }, index);
      enriched.original_name = explicitOriginal || columnName(original);
      enriched.originalName = enriched.original_name;
      return enriched;
    }),
  };
}

function appliedDesignBaseline(table) {
  const clone = cloneTable(table);
  clone.columns = (clone.columns || []).map((column) => {
    const name = columnName(column);
    return {
      ...column,
      original_name: name,
      originalName: name,
    };
  });
  return clone;
}

function sqlIdent(value) {
  return `\`${String(value || "").replaceAll("`", "``")}\``;
}

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function columnSql(column) {
  const nullable = column.is_nullable ? "NULL" : "NOT NULL";
  const defaultClause = column.column_default == null
    ? ""
    : column.default_mode === "expression"
      ? ` DEFAULT ${String(column.column_default).trim()}`
      : ` DEFAULT ${sqlString(column.column_default)}`;
  const commentClause = column.column_comment ? ` COMMENT ${sqlString(column.column_comment)}` : "";
  return `${column.column_type} ${nullable}${defaultClause}${commentClause}`;
}

function schemaSignatureFor(source, table) {
  return `mock-schema:${JSON.stringify({
    source,
    tableComment: table.table_comment || "",
    columns: (table.columns || []).map((column) => ({
      name: column.column_name,
      type: column.column_type,
      nullable: Boolean(column.is_nullable),
      primaryKey: Boolean(column.is_primary_key),
      defaultMode: column.default_mode || column.defaultMode || "none",
      defaultValue: column.column_default ?? null,
      comment: column.column_comment || "",
    })),
  })}`;
}

function previewSignatureFor(source, schemaSignature, draft) {
  return `mock-preview:${JSON.stringify(source)}:${schemaSignature}:${JSON.stringify(draft || {})}`;
}

function sameColumn(left = {}, right = {}) {
  return left.column_name === right.column_name &&
    left.column_type === right.column_type &&
    Boolean(left.is_nullable) === Boolean(right.is_nullable) &&
    Boolean(left.is_primary_key) === Boolean(right.is_primary_key) &&
    (left.column_default ?? null) === (right.column_default ?? null) &&
    String(left.column_comment || "") === String(right.column_comment || "");
}

const MOCK_INTEGER_TYPES = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint"]);
const MOCK_TEXT_TYPES = new Set(["char", "varchar", "binary", "varbinary", "tinytext", "text", "mediumtext", "longtext", "json", "enum", "set"]);

function baseTypeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .split(/[()\s]/)
    .find(Boolean) || "";
}

function typeConversionConflict(beforeColumn = {}, afterColumn = {}) {
  const beforeType = baseTypeName(beforeColumn.column_type || beforeColumn.data_type);
  const afterType = baseTypeName(afterColumn.column_type || afterColumn.data_type);
  if (MOCK_TEXT_TYPES.has(beforeType) && MOCK_INTEGER_TYPES.has(afterType)) {
    return `字段「${columnName(beforeColumn)}」：文本类型改为整数类型可能导致已有数据丢失或保存失败`;
  }
  return "";
}

function designConflicts(baseTable = {}, nextTable = {}) {
  const baseColumnByName = new Map((baseTable.columns || []).map((column) => [columnName(column), column]));
  return (nextTable.columns || [])
    .map((nextColumn) => {
      const originalName = String(nextColumn.original_name ?? nextColumn.originalName ?? "").trim();
      return typeConversionConflict(originalName ? baseColumnByName.get(originalName) : {}, nextColumn);
    })
    .filter(Boolean);
}

function previewDesignChange(baseTable, draft = {}, source = {}) {
  const baseColumns = baseTable.columns || [];
  const baseColumnNames = new Set(baseColumns.map(columnName));
  const draftColumns = Array.isArray(draft.columns) ? draft.columns : [];
  const draftOriginalNames = new Set(draftColumns.map((column) => String(column.originalName ?? column.original_name ?? "").trim()).filter(Boolean));
  const missingColumns = baseColumns.filter((column) => !draftOriginalNames.has(columnName(column)));
  if (missingColumns.length) {
    throw new Error(`Mock table design preview does not support dropping columns; draft omitted existing column(s): ${missingColumns.map(columnName).join(", ")}`);
  }
  const unknownOriginals = draftColumns.filter((column) => {
    const draftIdentity = String(column.originalName ?? column.original_name ?? "").trim();
    return draftIdentity && !baseColumnNames.has(draftIdentity);
  });
  if (unknownOriginals.length) {
    const names = unknownOriginals.map((column) => String(column.name || column.column_name || column.originalName || column.original_name || "unnamed column").trim()).join(", ");
    throw new Error(`Mock table design preview does not support unknown original column(s): ${names}`);
  }
  const nextTable = tableFromDraft(baseTable, draft);
  const conflicts = designConflicts(baseTable, nextTable);
  const statements = [];
  if (String(baseTable.table_comment || "") !== String(nextTable.table_comment || "")) {
    statements.push(`ALTER TABLE ${sqlIdent(baseTable.table_name)} COMMENT = ${sqlString(nextTable.table_comment)}`);
  }
  const baseColumnByName = new Map(baseColumns.map((column) => [columnName(column), column]));
  nextTable.columns.forEach((nextColumn) => {
    const originalName = String(nextColumn.original_name ?? nextColumn.originalName ?? "").trim();
    const original = originalName ? baseColumnByName.get(originalName) : null;
    if (!original) {
      statements.push(`ALTER TABLE ${sqlIdent(baseTable.table_name)} ADD COLUMN ${sqlIdent(nextColumn.column_name)} ${columnSql(nextColumn)}`);
    } else if (!sameColumn(original, nextColumn)) {
      statements.push(`ALTER TABLE ${sqlIdent(baseTable.table_name)} CHANGE COLUMN ${sqlIdent(originalName)} ${sqlIdent(nextColumn.column_name)} ${columnSql(nextColumn)}`);
    }
  });
  const originalPk = (baseTable.columns || []).filter((column) => column.is_primary_key).map(columnName);
  const nextPk = nextTable.columns.filter((column) => column.is_primary_key).map(columnName);
  if (originalPk.join("\x1f") !== nextPk.join("\x1f")) {
    statements.push(`ALTER TABLE ${sqlIdent(baseTable.table_name)} DROP PRIMARY KEY${nextPk.length ? `, ADD PRIMARY KEY (${nextPk.map(sqlIdent).join(", ")})` : ""}`);
  }
  const schemaSignature = schemaSignatureFor(source, baseTable);
  const previewSignature = previewSignatureFor(source, schemaSignature, draft);
  return {
    previewSignature,
    signature: previewSignature,
    schemaSignature,
    sourceSignature: schemaSignature,
    statements,
    warnings: statements.length ? ["Mock SQL preview only; verify against a real MySQL server before applying."] : [],
    conflicts,
    humanDescriptions: [],
    hasChanges: statements.length > 0,
    nextTable,
  };
}

function mockDefaultRowValue(column = {}) {
  const mode = String(column.default_mode || column.defaultMode || "none").toLowerCase();
  if (mode === "value" || mode === "expression") return String(column.column_default ?? column.columnDefault ?? "");
  return "";
}

function migrateRowKeysForDesign(connectionId, database, tableName, beforeColumns = [], afterColumns = []) {
  const renames = [];
  const added = [];
  const beforeNames = new Set(beforeColumns.map(columnName).filter(Boolean));
  afterColumns.forEach((column) => {
    const beforeName = String(column.original_name ?? column.originalName ?? "").trim();
    const afterName = columnName(column);
    if (beforeName && afterName && beforeName !== afterName) renames.push([beforeName, afterName]);
    if (!beforeName && afterName && !beforeNames.has(afterName)) added.push([afterName, mockDefaultRowValue(column)]);
  });
  if (!renames.length && !added.length) return;
  const rows = getOrInitRows(connectionId, database, tableName);
  rows.forEach((row) => {
    const originalRow = { ...row };
    renames.forEach(([beforeName]) => {
      if (Object.prototype.hasOwnProperty.call(originalRow, beforeName)) delete row[beforeName];
    });
    renames.forEach(([beforeName, afterName]) => {
      if (Object.prototype.hasOwnProperty.call(originalRow, beforeName)) {
        row[afterName] = originalRow[beforeName];
      }
    });
    added.forEach(([name, defaultValue]) => {
      if (!Object.prototype.hasOwnProperty.call(row, name)) row[name] = defaultValue;
    });
  });
}

function cleanTableNames(values) {
  const seen = new Set();
  const names = [];
  for (const value of Array.isArray(values) ? values : []) {
    const name = String(value ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function schemaTableNames(connectionId, database) {
  return resolveMockSchema(connectionId, database).map((table) => table.table_name);
}

function findMockTableOpenTarget(text, schema) {
  const raw = String(text || "");
  if (!/(打开|开启|切到|切换到|查看|show|open|switch)/i.test(raw)) return null;
  return schema.find((table) => {
    const name = String(table?.table_name || "");
    return name && new RegExp(`(^|\\b|\\s)${name}(\\b|\\s|表|$)`, "i").test(raw);
  }) || null;
}

function mockSyncPlan(payload = {}) {
  const connectionId = payload.connectionId || payload.connection_id || "demo";
  const sourceDatabase = payload.sourceDatabase || payload.source_database || "game_db";
  const targetDatabase = payload.targetDatabase || payload.target_database || "game_db";
  const requestedExclusions = cleanTableNames(payload.excludedTables || payload.excluded_tables);
  const sourceTables = schemaTableNames(connectionId, sourceDatabase);
  const targetTables = schemaTableNames(connectionId, targetDatabase);
  const sourceSet = new Set(sourceTables);
  const requestedExcluded = new Set(requestedExclusions);
  const excludedTables = sourceTables.filter((name) => requestedExcluded.has(name));
  const excluded = new Set(excludedTables);
  const copyTables = sourceTables.filter((name) => !excluded.has(name));
  const preservedTables = targetTables.filter((name) => excluded.has(name));
  const removedTables = targetTables.filter((name) => !excluded.has(name) && !sourceSet.has(name));
  const tables = [
    ...copyTables.map((name) => ({ name, action: "copy" })),
    ...preservedTables.map((name) => ({ name, action: "preserve-excluded" })),
    ...removedTables.map((name) => ({ name, action: "remove" })),
  ];
  const missingExclusions = requestedExclusions.filter((name) => !sourceSet.has(name));
  const warnings = [
    ...(missingExclusions.length ? [`排除表不在源库中，将忽略：${missingExclusions.join(", ")}`] : []),
    ...(preservedTables.length ? [`目标库存在同名排除表，将保留：${preservedTables.join(", ")}`] : []),
  ];
  return { connectionId, sourceDatabase, targetDatabase, excludedTables, copyTables, preservedTables, removedTables, tables, warnings };
}

function replaceMockRows(connectionId, targetDatabase, sourceDatabase, tableName) {
  const targetRows = getOrInitRows(connectionId, targetDatabase, tableName);
  const sourceRows = getOrInitRows(connectionId, sourceDatabase, tableName);
  targetRows.length = 0;
  targetRows.push(...sourceRows.map((row) => ({ ...row })));
}

function applyMockSyncPlan(plan) {
  const key = `${plan.connectionId}/${plan.targetDatabase}`;
  mockDatabaseSchemas[key] = [...plan.copyTables, ...plan.preservedTables];
  for (const tableName of plan.copyTables) {
    replaceMockRows(plan.connectionId, plan.targetDatabase, plan.sourceDatabase, tableName);
    // Preserve the source table definition in the target schema overrides so that
    // the target reflects the source's column structure after sync.
    const sourceTable = resolvedTable(plan.connectionId, plan.sourceDatabase, tableName);
    schemaOverrides.set(sourceKey(plan.connectionId, plan.targetDatabase, tableName), cloneTable(sourceTable));
  }
  for (const tableName of plan.removedTables || []) {
    schemaOverrides.delete(sourceKey(plan.connectionId, plan.targetDatabase, tableName));
  }
}

function mockPageFor(tableName, sessionId, connectionId, database, request = {}) {
  const schema = tableSchemaFor(connectionId, database);
  const table = schema.find((t) => t.table_name === tableName) || schema[0];
  const page = Math.max(1, Math.floor(Number(request.page) || 1));
  const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(request.pageSize || request.page_size) || DEFAULT_PAGE_SIZE)));
  const filterQuery = String(request.filter?.query || "").trim().toLowerCase();
  const filterMode = request.filter?.mode || "fuzzy";
  let rows = [...(getOrInitRows(connectionId, database, table.table_name) || [])];
  if (filterQuery) {
    const filterColumns = Array.isArray(request.filter?.columns)
      ? request.filter.columns.map((name) => String(name || "").trim()).filter(Boolean)
      : [];
    const filterValues = (row) => {
      if (!filterColumns.length) return Object.values(row);
      return filterColumns.map((name) => row[name]);
    };
    if (filterMode === "exact") {
      rows = rows.filter((row) => filterValues(row).some((value) => String(value) === request.filter.query.trim()));
    } else {
      rows = rows.filter((row) => filterValues(row).some((value) => fuzzyValueMatches(value, request.filter.query)));
    }
  }
  if (request.sort?.columnName || request.sort?.column_name) {
    const sortColumn = request.sort.columnName || request.sort.column_name;
    rows.sort((a, b) => {
      const left = String(a[sortColumn] ?? "");
      const right = String(b[sortColumn] ?? "");
      const cmp = compareSortValues(left, right);
      return request.sort.descending ? -cmp : cmp;
    });
  }
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize).map((row) => ({ ...row }));
  const includeTotal = request.includeTotal === true || request.include_total === true;
  const totalRows = includeTotal ? rows.length : start + pageRows.length;
  const totalRowsExact = includeTotal;
  const hasMore = includeTotal ? start + pageRows.length < rows.length : pageRows.length >= pageSize;
  return {
    sessionId,
    tableName: table.table_name,
    tableComment: table.table_comment,
    columns: table.columns,
    primaryKeys: table.columns.filter((column) => column.is_primary_key).map(columnName),
    rows: pageRows,
    totalRows,
    totalRowsExact,
    hasMore,
    page,
    pageSize,
  };
}

function fuzzyValueMatches(value, query) {
  return matchSearchText(value, query).matched;
}

function contiguousValueMatches(value, query) {
  return Boolean(findCaseInsensitiveRange(value, query));
}

function orderTablesByPriority(schema, priorityTables = []) {
  const priority = Array.isArray(priorityTables)
    ? priorityTables.map((name) => String(name || "").trim().toLowerCase()).filter(Boolean)
    : [];
  if (!priority.length) return schema;
  const priorityIndex = new Map(priority.map((name, index) => [name, index]));
  return [...schema].sort((left, right) => {
    const leftIndex = priorityIndex.has(String(left.table_name || "").toLowerCase()) ? priorityIndex.get(String(left.table_name || "").toLowerCase()) : Number.POSITIVE_INFINITY;
    const rightIndex = priorityIndex.has(String(right.table_name || "").toLowerCase()) ? priorityIndex.get(String(right.table_name || "").toLowerCase()) : Number.POSITIVE_INFINITY;
    return leftIndex - rightIndex;
  });
}

function primaryKeyColumns(table) {
  return (table?.columns || []).filter((column) => column.is_primary_key).map(columnName);
}

function primaryKeySignature(row, keys) {
  if (!keys.length) return "";
  const values = keys.map((key) => String(row?.[key] ?? "").trim());
  return values.every((value) => value !== "") ? values.join("\x1f") : "";
}

function stableHash64Hex(value) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(String(value || "").toLowerCase());
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function mockProjectIdFromPath(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  const readable = normalized
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "mock-project";
  return `${readable}-${stableHash64Hex(normalized)}`;
}

function hasPrimaryKeyConflict(table, rows, draft) {
  const keys = primaryKeyColumns(table);
  const signature = primaryKeySignature(draft, keys);
  return Boolean(signature && rows.some((row) => primaryKeySignature(row, keys) === signature));
}

function mockRowIdentity(table, row) {
  const keys = primaryKeyColumns(table);
  const identityKeys = keys.length ? keys : (table?.columns || []).map(columnName);
  const out = {};
  for (const key of identityKeys) {
    if (key) out[key] = String(row?.[key] ?? "");
  }
  return out;
}

function mockRowKey(identity) {
  return Object.entries(identity || {}).map(([key, value]) => `${key}=${value}`).join("&");
}

function mockReference(database, table, column = null, row = null) {
  const identity = row ? mockRowIdentity(table, row) : null;
  const rowKey = identity ? mockRowKey(identity) : "";
  return {
    kind: rowKey && column ? "cell" : rowKey ? "row" : column ? "column" : "table",
    database,
    tableName: table.table_name,
    tableComment: table.table_comment || "",
    columnName: column ? columnName(column) : null,
    rowIdentity: identity,
    rowKey,
  };
}

function mockDatabaseProfile(connectionId, database, schema) {
  const tables = schema.map((table) => {
    const name = String(table.table_name || "");
    const lower = name.toLowerCase();
    let role = "reference";
    if (/log|audit|record|history/.test(lower)) role = "log";
    else if (/config|setting|cfg|dict/.test(lower)) role = "config";
    else if (/rel|map|link|item/.test(lower)) role = "relationship";
    else if (/player|user|order|match/.test(lower)) role = "core";
    const rows = getOrInitRows(connectionId, database, name);
    const primaryKeys = primaryKeyColumns(table);
    const indexes = primaryKeys.length
      ? [{ indexName: "PRIMARY", columns: primaryKeys, unique: true, primary: true }]
      : [];
    return {
      tableName: name,
      tableComment: table.table_comment || "",
      role,
      confidence: role === "reference" ? 0.45 : 0.78,
      rowCountEstimate: rows.length,
      primaryKeys,
      indexes,
      columns: (table.columns || []).map((column) => ({
        columnName: columnName(column),
        columnType: column.column_type || column.columnType || "",
        columnComment: column.column_comment || column.columnComment || "",
        isPrimaryKey: Boolean(column.is_primary_key),
        isNullable: Boolean(column.is_nullable),
        sensitive: isMockSensitiveColumn(column),
      })),
      reference: mockReference(database, table),
    };
  });
  const coreTables = tables.filter((table) => table.role === "core").map((table) => table.tableName).slice(0, 8);
  return {
    version: 1,
    status: "ready",
    connectionId,
    database,
    schemaSignature: schema.map((table) => `${table.table_name}:${(table.columns || []).map(columnName).join(",")}`).join("|"),
    generatedAt: Date.now(),
    tableCount: tables.length,
    columnCount: tables.reduce((sum, table) => sum + table.columns.length, 0),
    coreTables,
    configTables: tables.filter((table) => table.role === "config").map((table) => table.tableName),
    logTables: tables.filter((table) => table.role === "log").map((table) => table.tableName),
    relationshipTables: tables.filter((table) => table.role === "relationship").map((table) => table.tableName),
    tables,
    references: tables.slice(0, 6).map((table) => table.reference),
    warnings: [],
  };
}

function isMockSensitiveColumn(column) {
  const text = `${columnName(column)} ${column?.column_type || ""} ${column?.column_comment || ""}`.toLowerCase();
  return /password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential|salt|email|phone|mobile|tel|telephone|contact|id_card|identity_card|密码|密钥|令牌|身份证|手机号|手机|电话|邮箱/.test(text);
}

export async function mockWorkbenchInvoke(command, payload = {}) {
  if (command === "save_export_file") {
    if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
      return "mock-xlsx-saved";
    }
    const blob = new Blob([Uint8Array.from(payload.data || [])], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = String(payload.fileName || payload.file_name || "export.xlsx");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return "mock-xlsx-saved";
  }
  if (command === "save_export_files") {
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
      return "mock-xlsx-folder";
    }
    files.forEach((file) => {
      const blob = new Blob([Uint8Array.from(file.data || [])], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = String(file.fileName || file.file_name || "export.xlsx");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
    return "mock-xlsx-folder";
  }
  if (command === "save_text_file") {
    const blob = new Blob([String(payload.content ?? "")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = String(payload.fileName || payload.file_name || "export.txt");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return "mock-text-saved";
  }
  if (command === "list_connections") return mockConnections.map((connection) => ({ ...connection }));
  if (command === "remove_connection") {
    const connectionId = payload.connectionId || payload.connection_id || "";
    const index = mockConnections.findIndex((connection) => String(connection.id) === String(connectionId));
    if (index < 0) throw new Error("连接不存在");
    mockConnections.splice(index, 1);
    delete mockConnectionDatabases[connectionId];
    if (mockAgentContext.connectionId === connectionId) {
      const fallback = mockConnections[0];
      mockAgentContext = {
        connectionId: fallback?.id || "",
        database: fallback?.database || "game_db",
        activeTableName: "player",
      };
    }
    return {};
  }
  if (command === "list_databases") {
    const { connectionId } = resolveContext(payload);
    return mockConnectionDatabases[connectionId] || ["game_db"];
  }
  if (command === "select_database") {
    const { connectionId, database } = resolveContext(payload);
    const schema = tableSchemaFor(connectionId, database);
    return { tableCount: schema.length, columnCount: schema.reduce((sum, table) => sum + table.columns.length, 0) };
  }
  if (command === "list_tables") {
    const { connectionId, database } = resolveContext(payload);
    const schema = tableSchemaFor(connectionId, database);
    return schema.map(({ table_name, table_comment, columns }) => ({
      table_name,
      table_comment,
      column_count: Array.isArray(columns) ? columns.length : 0,
      columnCount: Array.isArray(columns) ? columns.length : 0,
    }));
  }
  if (command === "get_table_schema") {
    const { connectionId, database } = resolveContext(payload);
    return designFor(resolvedTable(connectionId, database, payload.tableName || payload.table_name));
  }
  if (command === "get_table_design") {
    const { connectionId, database } = resolveContext(payload);
    if (isMockConnectionReadOnly(connectionId)) throw new Error("只读连接不能打开表设计");
    return designFor(resolvedTable(connectionId, database, payload.tableName || payload.table_name));
  }
  if (command === "preview_table_design_change") {
    const { connectionId, database } = resolveContext(payload);
    if (isMockConnectionReadOnly(connectionId)) throw new Error("只读连接不能打开表设计");
    const tableName = payload.tableName || payload.table_name;
    const table = resolvedTable(connectionId, database, tableName);
    const preview = previewDesignChange(table, payload.draft || {}, { connectionId, database, tableName });
    const { nextTable, ...result } = preview;
    return result;
  }
  if (command === "apply_table_design_change") {
    const { connectionId, database } = resolveContext(payload);
    if (isMockConnectionReadOnly(connectionId)) throw new Error("只读连接不能打开表设计");
    const tableName = payload.tableName || payload.table_name;
    if (!(payload.previewSignature || payload.signature) || !(payload.schemaSignature || payload.sourceSignature)) {
      throw new Error("Mock apply_table_design_change requires previewSignature and schemaSignature from preview_table_design_change");
    }
    const table = resolvedTable(connectionId, database, tableName);
    const preview = previewDesignChange(table, payload.draft || {}, { connectionId, database, tableName });
    const expectedPreviewSignature = payload.previewSignature || payload.signature;
    const expectedSchemaSignature = payload.schemaSignature || payload.sourceSignature;
    if (expectedPreviewSignature !== preview.previewSignature || expectedSchemaSignature !== preview.schemaSignature) {
      throw new Error("Mock table design preview signature is stale; preview the design again before applying");
    }
    if (preview.conflicts.length) {
      throw new Error(`Mock table design has blocking conflicts: ${preview.conflicts.join("; ")}`);
    }
    migrateRowKeysForDesign(connectionId, database, table.table_name, table.columns, preview.nextTable.columns);
    const appliedTable = appliedDesignBaseline(preview.nextTable);
    schemaOverrides.set(sourceKey(connectionId, database, table.table_name), appliedTable);
    return {
      applied: true,
      schema: designFor(appliedTable),
      sql: preview.statements,
      statements: preview.statements,
    };
  }
  if (command === "open_table_session") {
    const { connectionId, database } = resolveContext(payload);
    const sessionId = `mock-session-${++mockSessionSeq}`;
    mockSessions.set(sessionId, { connectionId, database, tableName: payload.tableName, readOnly: isMockConnectionReadOnly(connectionId) });
    return mockPageFor(payload.tableName, sessionId, connectionId, database, payload.options || {});
  }
  if (command === "fetch_table_page") {
    const { tableName, connectionId, database } = mockSessionContext(payload.sessionId);
    return mockPageFor(tableName, payload.sessionId, connectionId, database, payload.request || {});
  }
  if (command === "search_values") {
    const { connectionId, database } = resolveContext(payload.request || payload);
    const request = payload.request || payload;
    const query = String(request.query || "").trim();
    const hasLimit = request.limit !== undefined && request.limit !== null && String(request.limit).trim() !== "";
    const rawLimit = hasLimit ? Number(request.limit) : NaN;
    const limitValue = Number.isFinite(rawLimit) ? rawLimit : 100;
    const limit = Math.max(1, Math.min(1500, Math.floor(limitValue)));
    if (!query) return [];
    // Yield briefly so the UI can show the loading state before the sync search runs.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const schema = orderTablesByPriority(resolveMockSchema(connectionId, database), request.priorityTables);
    const results = [];
    tableLoop:
    for (const table of schema) {
      const rows = getOrInitRows(connectionId, database, table.table_name);
      for (const col of table.columns) {
        const colName = col.column_name;
        let hit = null;
        for (const row of rows) {
          const value = String(row[colName] ?? "");
          if (contiguousValueMatches(value, query)) {
            hit = {
              tableName: table.table_name,
              tableComment: table.table_comment || "",
              columnName: colName,
              previewValue: contiguousSearchPreview(value, query),
            };
            break;
          }
        }
        if (hit) {
          results.push(hit);
          if (results.length >= limit) break tableLoop;
        }
      }
    }
    return results;
  }
  if (command === "update_cell") {
    const { tableName, connectionId, database, readOnly } = mockSessionContext(payload.request?.sessionId);
    if (readOnly) throw new Error("只读连接不能编辑数据");
    const table = resolvedTable(connectionId, database, tableName);
    const rows = getOrInitRows(connectionId, database, tableName);
    const identity = payload.request?.rowIdentity || {};
    const row = rows.find((candidate) => Object.entries(identity).every(([key, value]) => String(candidate[key] ?? "") === String(value)));
    if (row) {
      const keys = primaryKeyColumns(table);
      const column = payload.request.columnName;
      if (keys.includes(column)) {
        const nextRow = { ...row, [column]: payload.request.newValue };
        const signature = primaryKeySignature(nextRow, keys);
        if (signature && rows.some((candidate) => candidate !== row && primaryKeySignature(candidate, keys) === signature)) {
          throw new Error("主键重复，不能保存");
        }
      }
      row[column] = payload.request.newValue;
    }
    return { updated: Boolean(row), conflict: !row, value: payload.request?.newValue || "" };
  }
  if (command === "insert_row") {
    const { tableName, connectionId, database, readOnly } = mockSessionContext(payload.request?.sessionId);
    if (readOnly) throw new Error("只读连接不能新增数据");
    const rows = getOrInitRows(connectionId, database, tableName);
    const schema = tableSchemaFor(connectionId, database);
    const table = schema.find((item) => item.table_name === tableName) || schema[0];
    if (hasPrimaryKeyConflict(table, rows, payload.request?.draft || {})) {
      throw new Error(PRIMARY_KEY_DUPLICATE_MESSAGE);
    }
    rows.push({ ...(payload.request?.draft || {}) });
    return { affected: 1 };
  }
  if (command === "import_rows") {
    const { tableName, connectionId, database, readOnly } = mockSessionContext(payload.request?.sessionId);
    if (readOnly) throw new Error("只读连接不能导入数据");
    const drafts = Array.isArray(payload.request?.rows) ? payload.request.rows : [];
    if (drafts.length > 100) throw new Error("单批导入不能超过 100 行");
    const rows = getOrInitRows(connectionId, database, tableName);
    const schema = tableSchemaFor(connectionId, database);
    const table = schema.find((item) => item.table_name === tableName) || schema[0];
    const keys = primaryKeyColumns(table);
    if (!keys.length) throw new Error("目标表没有主键，无法安全批量导入和回滚");
    const result = { inserted: 0, updated: 0, unchanged: 0, errors: [], outcomes: [] };
    drafts.forEach((draft, index) => {
      const signature = primaryKeySignature(draft, keys);
      const existing = signature
        ? rows.find((row) => primaryKeySignature(row, keys) === signature)
        : null;
      if (!existing) {
        const insertDraft = Object.fromEntries((table?.columns || [])
          .filter((column) => !column.is_generated && !column.isGenerated)
          .map((column) => columnName(column))
          .filter((name) => name && Object.hasOwn(draft, name))
          .map((name) => [name, draft[name]]));
        const validation = validateRowDraft({ table, rows, draft: insertDraft });
        if (!validation.valid) {
          const error = validation.errors[0] || {};
          result.errors.push({
            index,
            columnName: error.columnName || null,
            error: error.message || "导入失败",
          });
          result.outcomes.push({ index, status: "error" });
          return;
        }
        rows.push(insertDraft);
        result.inserted += 1;
        result.outcomes.push({ index, status: "inserted" });
        return;
      }
      const updateEntries = (table?.columns || [])
        .filter((column) => !column.is_primary_key && !column.isPrimaryKey && !column.is_generated && !column.isGenerated)
        .map((column) => columnName(column))
        .filter((name) => name && Object.hasOwn(draft, name))
        .map((name) => [name, draft[name]]);
      const validationError = updateEntries
        .map(([name, value]) => validateCellValue({ table, rows, row: existing, columnName: name, value }))
        .flatMap((validation) => validation.errors)
        .at(0);
      if (validationError) {
        result.errors.push({
          index,
          columnName: validationError.columnName || null,
          error: validationError.message || "导入失败",
        });
        result.outcomes.push({ index, status: "error" });
        return;
      }
      const changed = updateEntries.some(([key, value]) => String(existing[key] ?? "") !== String(value ?? ""));
      if (!changed) {
        result.unchanged += 1;
        result.outcomes.push({ index, status: "unchanged" });
        return;
      }
      Object.assign(existing, Object.fromEntries(updateEntries));
      result.updated += 1;
      result.outcomes.push({ index, status: "updated" });
    });
    return result;
  }
  if (command === "delete_rows") {
    const { tableName, connectionId, database, readOnly } = mockSessionContext(payload.request?.sessionId);
    if (readOnly) throw new Error("只读连接不能删除数据");
    const rows = getOrInitRows(connectionId, database, tableName);
    const identities = payload.request?.rowIdentities || [];
    const before = rows.length;
    const identityMatch = (row) => identities.some((identity) =>
      Object.entries(identity).every(([key, value]) => String(row[key] ?? "") === String(value)));
    const remaining = rows.filter((row) => !identityMatch(row));
    rows.length = 0;
    rows.push(...remaining);
    return { affected: before - rows.length };
  }
  if (command === "preview_database_sync") {
    const req = payload.request || payload;
    const connectionId = req.connectionId || req.connection_id || "demo";
    if (isMockConnectionReadOnly(connectionId)) throw new Error("只读连接不能执行覆盖同步");
    const plan = mockSyncPlan(req);
    return {
      status: "ready",
      sourceDatabase: plan.sourceDatabase,
      targetDatabase: plan.targetDatabase,
      excludedTables: plan.excludedTables,
      tables: plan.tables,
      warnings: plan.warnings,
    };
  }
  if (command === "sync_database_overwrite") {
    const req = payload.request || payload;
    const connectionId = req.connectionId || req.connection_id || "demo";
    if (isMockConnectionReadOnly(connectionId)) throw new Error("只读连接不能执行覆盖同步");
    const plan = mockSyncPlan(req);
    applyMockSyncPlan(plan);
    return {
      status: "succeeded",
      jobId: req.jobId || req.job_id || "",
      sourceDatabase: plan.sourceDatabase,
      targetDatabase: plan.targetDatabase,
      copiedTables: plan.copyTables,
      preservedTables: plan.preservedTables,
      copiedRows: plan.copyTables.reduce((sum, t) => sum + (getOrInitRows(plan.connectionId, plan.targetDatabase, t).length), 0),
      droppedTables: plan.removedTables,
      backupDatabase: null,
      message: "覆盖同步完成",
      warnings: plan.warnings,
    };
  }
  if (command === "copy_tables") {
    const req = payload.request || payload;
    const tableNames = req.tableNames || req.table_names || [];
    const sourceDatabase = req.sourceDatabase || req.source_database || "";
    const targetDatabase = req.targetDatabase || req.target_database || "";
    const targetConnectionId = req.targetConnectionId || req.target_connection_id || req.connectionId || "demo";
    const connectionId = req.connectionId || req.connection_id || "demo";
    if (isMockConnectionReadOnly(connectionId) || isMockConnectionReadOnly(targetConnectionId)) {
      throw new Error("只读连接不能发送表");
    }
    const copied = [];
    const schemaKey = `${targetConnectionId}/${targetDatabase}`;
    const targetSchema = [
      ...(mockDatabaseSchemas[schemaKey] || resolveMockSchema(targetConnectionId, targetDatabase).map((t) => t.table_name)),
    ];
    for (const tableName of tableNames) {
      const targetName = resolveMockCopyTableName(targetSchema, tableName);
      const sourceTable = resolvedTable(connectionId, sourceDatabase, tableName);
      const targetTable = cloneTable(sourceTable);
      targetTable.table_name = targetName;
      targetTable.tableName = targetName;
      schemaOverrides.set(sourceKey(targetConnectionId, targetDatabase, targetName), targetTable);
      targetSchema.push(targetName);
      mockDatabaseSchemas[schemaKey] = [...targetSchema];
      const targetRows = getOrInitRows(targetConnectionId, targetDatabase, targetName);
      const sourceRows = getOrInitRows(connectionId, sourceDatabase, tableName);
      targetRows.length = 0;
      targetRows.push(...sourceRows.map((row) => ({ ...row })));
      copied.push({ originalName: tableName, targetName });
    }
    return { status: "succeeded", copied, warnings: [] };
  }
  if (command === "drop_tables") {
    const req = payload.request || payload;
    const connectionId = req.connectionId || req.connection_id || "demo";
    if (isMockConnectionReadOnly(connectionId)) throw new Error("只读连接不能删除表");
    const database = req.database || "game_db";
    const tableNames = req.tables || req.tableNames || req.table_names || [];
    const schemaKey = `${connectionId}/${database}`;
    const currentNames = [
      ...(mockDatabaseSchemas[schemaKey] || resolveMockSchema(connectionId, database).map((t) => t.table_name)),
    ];
    const dropped = [];
    const failed = [];
    for (const tableName of tableNames) {
      const index = currentNames.findIndex((name) => String(name).toLowerCase() === String(tableName).toLowerCase());
      if (index < 0) {
        failed.push({ tableName, reason: "表不存在，可能已被删除" });
        continue;
      }
      const [removed] = currentNames.splice(index, 1);
      schemaOverrides.delete(sourceKey(connectionId, database, removed));
      rowCache.delete(sourceKey(connectionId, database, removed));
      dropped.push({ tableName: removed });
    }
    mockDatabaseSchemas[schemaKey] = currentNames;
    return { dropped, failed };
  }
  if (command === "rename_table") {
    const req = payload.request || payload;
    const connectionId = req.connectionId || req.connection_id || "demo";
    if (isMockConnectionReadOnly(connectionId)) throw new Error("只读连接不能重命名表");
    const database = req.database || "game_db";
    const tableName = req.tableName || req.table_name || "";
    const newName = req.newName || req.new_name || "";
    if (!tableName || !newName) throw new Error("表名和新名称不能为空");
    const schemaKey = `${connectionId}/${database}`;
    const tableNames = mockDatabaseSchemas[schemaKey] || resolveMockSchema(connectionId, database).map((t) => t.table_name);
    if (tableNames.some((n) => n.toLowerCase() === newName.toLowerCase() && n !== tableName)) {
      throw new Error(`表名已存在: ${newName}`);
    }
    const index = tableNames.findIndex((n) => n.toLowerCase() === tableName.toLowerCase());
    if (index === -1) throw new Error(`表不存在: ${tableName}`);
    // Migrate schema override before updating the name list so that
    // resolvedTable can still look up the old name in the base schema.
    const oldKey = sourceKey(connectionId, database, tableName);
    const newKey = sourceKey(connectionId, database, newName);
    const override = schemaOverrides.get(oldKey) || resolvedTable(connectionId, database, tableName);
    schemaOverrides.set(newKey, { ...override, table_name: newName });
    schemaOverrides.delete(oldKey);
    // Update schema list
    tableNames[index] = newName;
    mockDatabaseSchemas[schemaKey] = [...tableNames];
    // Migrate rows
    const oldRowKey = `${connectionId}/${database}/${tableName}`;
    const newRowKey = `${connectionId}/${database}/${newName}`;
    const cachedRows = rowCache.get(oldRowKey);
    if (cachedRows) {
      rowCache.set(newRowKey, cachedRows);
      rowCache.delete(oldRowKey);
    }
    return { renamed: true, from: tableName, to: newName };
  }
  if (command === "test_connection") {
    return null;
  }
  if (command === "add_connection" || command === "restore_connection") {
    upsertMockConnection(payload.url, payload.kind);
    return ["game_db"];
  }
  if (command === "agent_pick_project_directory") {
    return {
      id: "mock-project-dbscout-workbench",
      name: "dbscout-workbench",
      path: "E:/project/dbscout-workbench",
      shortPath: "E:/project/dbscout-workbench",
      available: true,
      readOnly: true,
    };
  }
  if (command === "agent_validate_project_directory") {
    const path = String(payload.path || "");
    const id = mockProjectIdFromPath(path);
    const available = !path.toLowerCase().includes("missing");
    return {
      id,
      name: path.split(/[\\/]/).filter(Boolean).pop() || "项目文件夹",
      path,
      shortPath: path,
      available,
      readOnly: true,
      error: available ? "" : "项目文件夹不存在",
    };
  }
  if (command === "agent_start_session") {
    const context = payload.context || {};
    const { connectionId, database } = resolveContext({
      connectionId: context.connectionId || context.connection_id,
      database: context.database,
    });
    const schema = tableSchemaFor(connectionId, database);
    const tableName = context.activeTableName || "";
    const table = schema.find((item) => item.table_name === tableName) || schema[0];
    mockAgentContext = {
      connectionId,
      database,
      activeTableName: table?.table_name || tableName || "",
      project: context.project || null,
    };

    setTimeout(() => {
      emitMockEvent("agent-event", {
        ev: "startup_progress",
        stage: "runtime",
        progress: 18,
        message: "正在准备本地 Agent 运行时",
      });
    }, 20);

    setTimeout(() => {
      emitMockEvent("agent-event", {
        ev: "startup_progress",
        stage: "context",
        progress: 48,
        message: "正在装载当前数据库上下文",
      });
    }, 90);

    setTimeout(() => {
      emitMockEvent("agent-event", {
        ev: "startup_progress",
        stage: "sdk",
        progress: 78,
        message: "正在启动 Claude Code 会话",
      });
    }, 160);

    setTimeout(() => {
      emitMockEvent("agent-event", {
        ev: "system_init",
        sessionId: `mock-session-${Date.now()}`,
        model: payload.config?.model || "claude-default",
        permissionMode: payload.config?.permissionMode || "default",
      });
    }, 260);

    return "started";
  }
  if (command === "agent_send") {
    const context = payload.context || mockAgentContext;
    const { connectionId, database } = resolveContext({
      connectionId: context.connectionId || context.connection_id,
      database: context.database,
    });
    const schema = tableSchemaFor(connectionId, database);
    const activeTableName = context.activeTableName || mockAgentContext.activeTableName || "";
    const activeTable = schema.find((item) => item.table_name === activeTableName) || schema[0];
    mockAgentContext = {
      connectionId,
      database,
      activeTableName: activeTable?.table_name || activeTableName || "",
      project: context.project || null,
    };
    const toolTableName = mockAgentContext.activeTableName || "player";
    const text = String(payload.text || "").trim().toLowerCase();
    const isSchemaQuestion = /表|table|schema|结构|struct/i.test(payload.text || "");
    const isDataQuestion = /数据|data|查询|query|select|row/i.test(payload.text || "");
    const isProfileQuestion = /核心|关联|关系|画像|理解|全库|业务|database|profile|related/i.test(payload.text || "");
    const isProjectQuestion = /项目|代码|文件|入口|readme|component|源码|目录|folder|file|code/i.test(payload.text || "");
    setTimeout(() => {
      const isPlanQuestion = /计划|plan|方案|scheme/i.test(payload.text || "");
      const isWriteQuestion = /修改|更新|update|write|写入|insert|delete|删除|改成|改一下/i.test(payload.text || "");
      const openTarget = findMockTableOpenTarget(payload.text, schema);

      if (openTarget) {
        emitMockEvent("agent-event", {
          ev: "tool_use",
          id: "call-open-table",
          name: "open_table",
          input: { table: openTarget.table_name, database },
        });
        emitMockEvent("agent-event", {
          ev: "workbench_action",
          requestId: `mock-open-table-${Date.now()}`,
          action: "open_table",
          connectionId,
          database,
          tableName: openTarget.table_name,
          tableComment: openTarget.table_comment || "",
        });
        emitMockEvent("agent-event", {
          ev: "tool_result",
          id: "call-open-table",
          summary: `已请求打开 ${openTarget.table_name} 表`,
          isError: false,
        });
        emitMockEvent("agent-event", { ev: "text_delta", text: `已为你打开 ${openTarget.table_name} 表。` });
        emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0, isError: false, text: "" });
        return;
      }

      if (isPlanQuestion) {
        const reqId = `plan-${Date.now()}`;
        pendingMockAgentRequests.set(reqId, { kind: "plan", tableName: toolTableName });
        emitMockEvent("agent-event", { ev: "text_delta", text: "我先梳理一下执行计划。" });
        emitMockEvent("agent-event", { ev: "tool_use", id: "call-1", name: "describe_table", input: { table: toolTableName } });
        emitMockEvent("agent-event", { ev: "tool_result", id: "call-1", summary: `读取 ${toolTableName} 表结构`, isError: false });
        emitMockEvent("agent-event", {
          ev: "plan",
          req_id: reqId,
          text: `## 执行计划\n1. 确认 ${toolTableName} 表结构与目标字段\n2. 执行只读查询定位目标行\n3. 如需修改，向用户请求批准后执行写入`,
        });
        return;
      }

      if (isProjectQuestion && context.project?.name) {
        if (isWriteQuestion) {
          emitMockEvent("agent-event", {
            ev: "text_delta",
            text: `当前项目 ${context.project.name} 以只读方式接入，我可以帮你查看和分析文件，但不能修改 README 或其它项目文件。`,
          });
          emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0, isError: false, text: "" });
          return;
        }
        emitMockEvent("agent-event", { ev: "text_delta", text: `我先只读查看项目 ${context.project.name}。` });
        emitMockEvent("agent-event", {
          ev: "tool_use",
          id: "project-call-1",
          name: "mcp__dbscout-project__search_project_files",
          input: { keyword: "入口", limit: 10 },
        });
        emitMockEvent("agent-event", {
          ev: "tool_result",
          id: "project-call-1",
          summary: "找到 README.md 和 src/main.js 中的相关内容",
          isError: false,
        });
        emitMockEvent("agent-event", {
          ev: "text_delta",
          text: `模拟结果：当前项目是 ${context.project.name}，入口线索在 src/main.js。`,
        });
        emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0, isError: false, text: "" });
        return;
      }

      if (isWriteQuestion) {
        const reqId = `approval-${Date.now()}`;
        pendingMockAgentRequests.set(reqId, { kind: "approval", tableName: toolTableName });
        emitMockEvent("agent-event", { ev: "text_delta", text: `我将对 ${toolTableName} 执行写入操作。` });
        emitMockEvent("agent-event", {
          ev: "approval_request",
          req_id: reqId,
          toolName: "mcp__dbscout-db__run_write_query",
          input: { sql: `UPDATE ${toolTableName} SET ...` },
        });
        return;
      }

      if (isProfileQuestion) {
        const profile = mockDatabaseProfile(connectionId, database, schema);
        const activeRows = getOrInitRows(connectionId, database, activeTable.table_name);
        const firstStringColumn = (activeTable.columns || []).find((column) => {
          const type = String(column.column_type || column.data_type || "").toLowerCase();
          return type.includes("char") || type.includes("text");
        }) || activeTable.columns?.[0];
        const cellReference = activeRows[0] && firstStringColumn
          ? mockReference(database, activeTable, firstStringColumn, activeRows[0])
          : mockReference(database, activeTable, firstStringColumn || null, null);
        emitMockEvent("agent-event", {
          ev: "text_delta",
          text: "我先读取数据库画像，再根据关系和样例证据回答。",
        });
        emitMockEvent("agent-event", { ev: "tool_use", id: "call-profile", name: "get_database_profile", input: { database } });
        emitMockEvent("agent-event", {
          ev: "tool_result",
          id: "call-profile",
          summary: `画像已就绪：${profile.tableCount} 张表，核心表 ${profile.coreTables.slice(0, 4).join("、")}`,
          result: {
            ...profile,
            references: [mockReference(database, activeTable), ...profile.references.slice(0, 4), cellReference],
          },
          isError: false,
        });
        emitMockEvent("agent-event", { ev: "tool_use", id: "call-related", name: "find_related_tables", input: { database, table: activeTable.table_name } });
        emitMockEvent("agent-event", {
          ev: "tool_result",
          id: "call-related",
          summary: `${activeTable.table_name} 与日志、配置或关系表存在命名/字段线索`,
          result: {
            tableName: activeTable.table_name,
            relatedTables: profile.tables.filter((table) => table.tableName !== activeTable.table_name).slice(0, 4).map((table) => table.tableName),
            references: [mockReference(database, activeTable), cellReference],
          },
          isError: false,
        });
        emitMockEvent("agent-event", {
          ev: "text_delta",
          text: `\n核心表优先看 ${profile.coreTables.slice(0, 4).join("、")}。我已把可跳转证据放在回答上方，可以直接点到表、列或单元格。`,
        });
        emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0, isError: false, text: "" });
        return;
      }

      if (isSchemaQuestion || isDataQuestion) {
        emitMockEvent("agent-event", { ev: "text_delta", text: "让我先查看一下数据库结构。" });
        emitMockEvent("agent-event", { ev: "tool_use", id: "call-1", name: "list_tables", input: { limit: 20 } });
        emitMockEvent("agent-event", { ev: "tool_result", id: "call-1", summary: "找到 8 张表", isError: false });
        emitMockEvent("agent-event", { ev: "tool_use", id: "call-2", name: "describe_table", input: { table: toolTableName } });
        emitMockEvent("agent-event", { ev: "tool_result", id: "call-2", summary: `读取 ${toolTableName} 表结构`, isError: false });
        if (isDataQuestion) {
          emitMockEvent("agent-event", { ev: "tool_use", id: "call-3", name: "run_read_query", input: { sql: `SELECT * FROM ${toolTableName} LIMIT 5` } });
          emitMockEvent("agent-event", { ev: "tool_result", id: "call-3", summary: "返回 5 行", isError: false });
        }
        emitMockEvent("agent-event", { ev: "text_delta", text: `这是模拟结果：${toolTableName} 表包含 ${activeTable?.columns?.length || 0} 个字段。` });
      } else {
        emitMockEvent("agent-event", { ev: "text_delta", text: `（模拟回复）收到：${payload.text || ""}` });
      }
      emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0, isError: false, text: "" });
    }, 200);
    return "sent";
  }
  if (command === "agent_abort") {
    setTimeout(() => emitMockEvent("agent-event", { ev: "closed" }), 50);
    return "aborted";
  }
  if (command === "agent_set_mode" || command === "agent_set_auto_approve") {
    return "ok";
  }
  if (command === "agent_approve_tool" || command === "agent_deny_tool") {
    const reqId = payload.req_id || payload.reqId;
    const request = pendingMockAgentRequests.get(reqId);
    pendingMockAgentRequests.delete(reqId);
    const approved = command === "agent_approve_tool";
    setTimeout(() => {
      if (approved) {
        emitMockEvent("agent-event", {
          ev: "text_delta",
          text: request?.kind === "plan"
            ? `计划已批准，我会按步骤处理 ${request.tableName}。`
            : `已批准写入操作，模拟执行 ${request?.tableName || "当前表"} 的修改。`,
        });
      } else {
        emitMockEvent("agent-event", {
          ev: "text_delta",
          text: `已取消该操作${payload.message ? `：${payload.message}` : "。"}`,
        });
      }
      emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0, isError: false, text: "" });
    }, 30);
    return "ok";
  }
  if (command === "agent_list_sessions") {
    setTimeout(() => {
      emitMockEvent("agent-event", { ev: "session_list", sessions: [] });
    }, 50);
    return "listed";
  }
  if (command === "agent_delete_session") {
    setTimeout(() => {
      emitMockEvent("agent-event", { ev: "session_deleted", sessionId: payload.sessionId });
    }, 50);
    return "deleted";
  }
  if (command === "agent_get_session_messages") {
    setTimeout(() => {
      emitMockEvent("agent-event", {
        ev: "session_messages",
        sessionId: payload.sessionId || "",
        messages: [],
      });
    }, 50);
    return "loaded";
  }

  // ---- Backup & audit (mock) ----
  if (command === "list_audit_logs") {
    return mockAuditLogs(payload.request || {});
  }
  if (command === "clear_audit_logs") {
    const deletedCount = mockAuditLogState.length;
    mockAuditLogState.length = 0;
    return deletedCount;
  }
  if (command === "rollback_audit_entry") {
    const id = payload.request?.auditId;
    const entry = mockAuditLogState.find((item) => item.id === id);
    if (!entry) {
      return { rolledBack: false, newAuditId: null, conflict: true, message: "记录不存在" };
    }
    if (entry.status !== "committed" || entry.isRollback) {
      return { rolledBack: false, newAuditId: null, conflict: true, message: "该记录无法回滚" };
    }
    entry.status = "rolled_back";
    const newId = Math.max(0, ...mockAuditLogState.map((item) => item.id)) + 1;
    mockAuditLogState.unshift({
      id: newId,
      ts: new Date().toISOString(),
      connectionId: entry.connectionId,
      database: entry.database,
      tableName: entry.tableName,
      operation: entry.operation === "INSERT" ? "DELETE" : entry.operation === "DELETE" ? "INSERT" : "UPDATE",
      columnName: entry.columnName,
      oldValue: entry.oldValue,
      newValue: entry.newValue,
      forwardSql: entry.inverseSql,
      inverseSql: entry.forwardSql,
      rollbackStrategy: entry.rollbackStrategy,
      source: "rollback",
      status: "committed",
      isRollback: true,
      rollbackOf: entry.id,
    });
    emitMockEvent("backup-job", { kind: "rollback", database: entry.database, table: entry.tableName });
    return { rolledBack: true, newAuditId: newId, conflict: false, message: "已回滚（演示）" };
  }
  if (command === "list_snapshots") {
    return mockSnapshots(payload.request || {});
  }
  if (command === "create_snapshot") {
    const req = payload.request || {};
    const jobId = `snap-${Date.now()}`;
    const connectionId = req.connectionId || "demo";
    const database = req.database || "game_db";
    const ts = new Date().toISOString();
    setTimeout(() => {
      emitMockEvent("snapshot-progress", {
        jobId, connectionId, database, done: 3, total: 3, currentTable: null, status: "done", message: "快照完成（演示）",
      });
    }, 80);
    return {
      path: `mock://backup/snapshots/${connectionId}/${database}/${ts.replace(/[:.]/g, "-")}.sql`,
      connectionId, database, ts, sizeBytes: 2048, tableCount: 3, manifest: { tables: [{ name: "player", rows: 10 }] },
    };
  }
  if (command === "restore_snapshot") {
    const req = payload.request || {};
    setTimeout(() => {
      emitMockEvent("backup-job", { kind: "restore", database: "game_db" });
    }, 80);
    return { preRestoreSnapshotPath: "mock://backup/pre-restore.sql", database: "game_db" };
  }
  if (command === "get_backup_config") {
    return mockBackupConfig;
  }
  if (command === "set_backup_config") {
    mockBackupConfig = { ...mockBackupConfig, ...(payload.config || {}) };
    mockBackupConfig.resolvedStorageDir = mockBackupConfig.storageDir || "mock://backup";
    return mockBackupConfig;
  }
  if (command === "set_snapshot_enabled") {
    const req = payload.request || {};
    const connectionId = req.connectionId || "";
    const database = req.database || "";
    const enabled = Boolean(req.enabled);
    // Transition "all" -> "selected": seed the whitelist with every snapshotable
    // database (mock uses the in-memory connection→database map) first.
    if (mockBackupConfig.databasesScope === "all") {
      const seeded = [];
      for (const [connId, databases] of Object.entries(mockConnectionDatabases)) {
        for (const db of databases) {
          seeded.push({ connectionId: connId, database: db });
        }
      }
      mockBackupConfig = {
        ...mockBackupConfig,
        databasesScope: "selected",
        snapshotEnabledDatabases: seeded,
      };
    }
    const list = Array.isArray(mockBackupConfig.snapshotEnabledDatabases)
      ? mockBackupConfig.snapshotEnabledDatabases.slice()
      : [];
    const key = { connectionId, database };
    const exists = list.some(
      (item) => item.connectionId === key.connectionId && item.database === key.database,
    );
    if (enabled && !exists) {
      list.push(key);
    } else if (!enabled && exists) {
      const idx = list.findIndex(
        (item) => item.connectionId === key.connectionId && item.database === key.database,
      );
      if (idx >= 0) list.splice(idx, 1);
    }
    mockBackupConfig = { ...mockBackupConfig, snapshotEnabledDatabases: list };
    return mockBackupConfig;
  }
  if (command === "open_backup_path") {
    return null;
  }
  if (command === "prune_snapshots") {
    return { deletedCount: 0 };
  }

  // ---- Account & shared audit commands ----
  if (command === "get_account") {
    return { serverUrl: mockAccount.serverUrl, session: mockAccount.session };
  }
  if (command === "set_account_server") {
    mockAccount.serverUrl = (payload.request?.serverUrl || "").trim() || null;
    return { serverUrl: mockAccount.serverUrl, session: mockAccount.session };
  }
  if (command === "register_account") {
    const username = (payload.request?.username || "").trim();
    if (!username) throw new Error("用户名不能为空");
    if (mockUsers.has(username)) throw new Error("用户名已被注册");
    const displayName = (payload.request?.displayName || "").trim() || username;
    const user = mockMakeUser(username, displayName);
    mockUsers.set(username, user);
    mockAccount.session = { ...user };
    return { serverUrl: mockAccount.serverUrl, session: mockAccount.session };
  }
  if (command === "login_account") {
    const username = (payload.request?.username || "").trim();
    if (!username) throw new Error("用户名不能为空");
    const user = mockUsers.get(username);
    if (!user) throw new Error("用户不存在，请先注册");
    mockAccount.session = { ...user };
    return { serverUrl: mockAccount.serverUrl, session: mockAccount.session };
  }
  if (command === "logout_account") {
    mockAccount.session = null;
    return { serverUrl: mockAccount.serverUrl, session: null };
  }
  if (command === "list_shared_audit_logs") {
    let rows = mockSharedAudit.slice();
    const req = payload.request || {};
    if (req.connectionId) rows = rows.filter((r) => r.connectionId === req.connectionId);
    if (req.database) rows = rows.filter((r) => r.database === req.database);
    if (req.tableName) rows = rows.filter((r) => r.tableName === req.tableName);
    const limit = req.limit || 200;
    const offset = req.offset || 0;
    return rows.slice(offset, offset + limit);
  }
  if (command === "sync_audit_now") {
    // Promote unsynced local audit rows into the shared log, attributed to the
    // current user. Mirrors the Rust outbox push.
    if (!mockAccount.session) return { accepted: 0, skipped: 0 };
    const user = mockAccount.session;
    let accepted = 0;
    let skipped = 0;
    for (const row of mockAuditLogState) {
      if (row.synced) {
        skipped += 1;
        continue;
      }
      const exists = mockSharedAudit.some((s) => s.clientId === row.clientId);
      if (exists) {
        skipped += 1;
        continue;
      }
      mockSharedAudit.unshift({
        clientId: row.clientId || `mock-${row.id}`,
        ts: row.ts,
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        connectionId: row.connectionId,
        database: row.database,
        tableName: row.tableName,
        operation: row.operation,
        columnName: row.columnName || null,
        oldValue: row.oldValue || null,
        newValue: row.newValue || null,
        source: row.source,
        status: row.status,
        isRollback: Boolean(row.isRollback),
        rollbackOfClientId: row.rollbackOfClientId || null,
        host: "mock-host",
      });
      row.synced = true;
      accepted += 1;
    }
    return { accepted, skipped };
  }
  return null;
}

// ---- Account & shared audit (mock) ----
// In-memory mock of the central server: registered users + shared audit log.
let mockAccount = { serverUrl: null, session: null };
const mockUsers = new Map(); // username -> { userId, username, displayName, token }
const mockSharedAudit = []; // shared change-log entries (all users)

function mockMakeUser(username, displayName) {
  return {
    userId: `user-${username}-${Math.random().toString(36).slice(2, 8)}`,
    username,
    displayName: displayName || username,
    token: `tok-${Math.random().toString(36).slice(2, 12)}`,
  };
}

let mockBackupConfig = {
  enabled: true,
  intervalMinutes: 30,
  largeTableThreshold: 50000,
  maxPerDb: 50,
  databasesScope: "selected",
  snapshotEnabledDatabases: [],
  auditRetentionDays: 90,
  storageDir: null,
  resolvedStorageDir: "mock://backup",
};

const mockAuditLogState = [
  {
    id: 1,
    ts: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
    operation: "UPDATE",
    columnName: "level",
    oldValue: "12",
    newValue: "99",
    forwardSql: "UPDATE `player` SET `level` = ? WHERE `id` <=> ? AND `level` = ? LIMIT 1",
    inverseSql: "UPDATE `player` SET `level` = ? WHERE `id` <=> ? AND `level` = ? LIMIT 1",
    rollbackStrategy: "auto",
    source: "grid",
    status: "committed",
    isRollback: false,
    rollbackOf: null,
    actor: "演示用户",
    clientId: "mock-cid-1",
    synced: false,
  },
  {
    id: 2,
    ts: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    connectionId: "demo",
    database: "game_db",
    tableName: "player",
    operation: "INSERT",
    columnName: null,
    oldValue: null,
    newValue: null,
    forwardSql: "INSERT INTO `player` (`name`,`level`) VALUES (?, ?)",
    inverseSql: "DELETE FROM `player` WHERE `id` <=> ? LIMIT 1",
    rollbackStrategy: "auto",
    source: "grid",
    status: "committed",
    isRollback: false,
    rollbackOf: null,
    actor: "演示用户",
    clientId: "mock-cid-2",
    synced: false,
  },
  {
    id: 3,
    ts: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    connectionId: "demo",
    database: "game_db",
    tableName: "(agent)",
    operation: "UPDATE",
    columnName: null,
    oldValue: null,
    newValue: null,
    forwardSql: "UPDATE player SET status = 'banned' WHERE region = 'eu'",
    inverseSql: null,
    rollbackStrategy: "manual",
    source: "agent",
    status: "committed",
    isRollback: false,
    rollbackOf: null,
    actor: "演示用户",
    clientId: "mock-cid-3",
    synced: false,
  },
];

function mockAuditLogs(request) {
  let rows = mockAuditLogState.slice();
  if (request.connectionId) rows = rows.filter((row) => row.connectionId === request.connectionId);
  if (request.database) rows = rows.filter((row) => row.database === request.database);
  if (request.tableName) rows = rows.filter((row) => row.tableName === request.tableName);
  const limit = request.limit || 200;
  const offset = request.offset || 0;
  return rows.slice(offset, offset + limit);
}

function mockSnapshots(request) {
  const base = [
    { path: "mock://backup/snapshots/demo/game_db/20260620-090000.sql", connectionId: "demo", database: "game_db", ts: "20260620-090000", sizeBytes: 8192, tableCount: 12, manifest: { tables: [{ name: "player", rows: 128 }] } },
    { path: "mock://backup/snapshots/demo/game_db/20260619-090000.sql", connectionId: "demo", database: "game_db", ts: "20260619-090000", sizeBytes: 7680, tableCount: 12, manifest: { tables: [{ name: "player", rows: 120 }] } },
  ];
  let rows = base.slice();
  if (request.connectionId) rows = rows.filter((row) => row.connectionId === request.connectionId);
  if (request.database) rows = rows.filter((row) => row.database === request.database);
  return rows;
}
