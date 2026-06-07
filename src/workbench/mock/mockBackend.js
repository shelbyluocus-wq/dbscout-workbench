import { mockDatabaseSchemas, resolveMockSchema } from "./mockSchema.js";
import { getOrInitRows } from "./mockRows.js";
import { columnName } from "../utils/normalize.js";
import { DEFAULT_PAGE_SIZE } from "../constants.js";

let mockSessionSeq = 0;
let mockConnectionSeq = 10;
const mockSessions = new Map();
const mockConnections = [
  { id: "demo", label: "Demo GameDB", host: "demo", port: 3306, username: "root", database: "game_db", connected: true },
  { id: "demo-staging", label: "Staging Server", host: "staging.local", port: 3306, username: "dev", database: "game_db", connected: true },
  { id: "demo-test", label: "Test Server", host: "test.local", port: 3307, username: "tester", database: "game_db", connected: true },
];

const mockConnectionDatabases = {
  demo: ["game_db", "game_config"],
  "demo-staging": ["game_db", "analytics_db"],
  "demo-test": ["game_db", "game_db_archive"],
};
const PRIMARY_KEY_DUPLICATE_MESSAGE = "主键重复，不能保存";
const schemaOverrides = new Map();

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
  };
}

function mockConnectionFromUrl(url) {
  try {
    const parsed = new URL(url);
    const username = decodeURIComponent(parsed.username || "root");
    return {
      id: `mysql-${++mockConnectionSeq}`,
      label: `${username}@${parsed.hostname}:${parsed.port || 3306}`,
      host: parsed.hostname,
      port: parsed.port || "3306",
      username,
      database: "game_db",
      connected: true,
    };
  } catch {
    return {
      id: `mysql-${++mockConnectionSeq}`,
      label: `MySQL ${mockConnectionSeq}`,
      host: "127.0.0.1",
      port: "3306",
      username: "root",
      database: "game_db",
      connected: true,
    };
  }
}

function upsertMockConnection(url) {
  const next = mockConnectionFromUrl(url);
  const existing = mockConnections.find((connection) => connection.host === next.host && String(connection.port) === String(next.port) && connection.username === next.username);
  if (existing) {
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
  return {
    table_name: baseTable.table_name,
    tableName: baseTable.table_name,
    table_comment: String(draft.tableComment ?? baseTable.table_comment ?? ""),
    tableComment: String(draft.tableComment ?? baseTable.table_comment ?? ""),
    columns: (Array.isArray(draft.columns) ? draft.columns : []).map((column, index) => {
      const original = baseColumns[index] || {};
      const name = String(column.name || column.column_name || columnName(original) || `column_${index + 1}`).trim();
      const columnType = columnTypeFromDraft(column, original);
      const defaultMode = String(column.defaultMode || column.default_mode || "none");
      const defaultValue = defaultMode === "none" ? null : defaultMode === "null" ? null : column.defaultValue ?? column.column_default ?? null;
      return enrichColumn({
        column_name: name,
        column_type: columnType,
        is_nullable: column.primaryKey ? false : Boolean(column.nullable ?? column.is_nullable),
        is_primary_key: Boolean(column.primaryKey ?? column.is_primary_key),
        column_default: defaultValue,
        default_mode: defaultMode,
        column_comment: String(column.comment ?? column.column_comment ?? ""),
        original_name: column.originalName || column.original_name || columnName(original) || name,
        original_type: original.column_type || original.original_type || columnType,
      }, index);
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
  return (nextTable.columns || [])
    .map((nextColumn, index) => typeConversionConflict((baseTable.columns || [])[index], nextColumn))
    .filter(Boolean);
}

function previewDesignChange(baseTable, draft = {}, source = {}) {
  const baseColumns = baseTable.columns || [];
  const baseColumnNames = new Set(baseColumns.map(columnName));
  const draftColumns = Array.isArray(draft.columns) ? draft.columns : [];
  const draftOriginalNames = new Set(draftColumns.map((column) => String(column.originalName || column.original_name || column.name || column.column_name || "").trim()).filter(Boolean));
  const missingColumns = baseColumns.filter((column) => !draftOriginalNames.has(columnName(column)));
  if (missingColumns.length) {
    throw new Error(`Mock table design preview does not support dropping columns; draft omitted existing column(s): ${missingColumns.map(columnName).join(", ")}`);
  }
  const addedColumns = draftColumns.filter((column, index) => {
    const draftIdentity = String(column.originalName || column.original_name || column.name || column.column_name || "").trim();
    return index >= baseColumns.length || (draftIdentity && !baseColumnNames.has(draftIdentity));
  });
  if (addedColumns.length) {
    const names = addedColumns.map((column) => String(column.name || column.column_name || column.originalName || column.original_name || "unnamed column").trim()).join(", ");
    throw new Error(`Mock table design preview does not support adding or dropping columns; draft included new column(s): ${names}`);
  }
  const nextTable = tableFromDraft(baseTable, draft);
  const conflicts = designConflicts(baseTable, nextTable);
  const statements = [];
  if (String(baseTable.table_comment || "") !== String(nextTable.table_comment || "")) {
    statements.push(`ALTER TABLE ${sqlIdent(baseTable.table_name)} COMMENT = ${sqlString(nextTable.table_comment)}`);
  }
  nextTable.columns.forEach((nextColumn, index) => {
    const original = (baseTable.columns || [])[index];
    if (!original) {
      statements.push(`ALTER TABLE ${sqlIdent(baseTable.table_name)} ADD COLUMN ${sqlIdent(nextColumn.column_name)} ${columnSql(nextColumn)}`);
    } else if (!sameColumn(original, nextColumn)) {
      statements.push(`ALTER TABLE ${sqlIdent(baseTable.table_name)} CHANGE COLUMN ${sqlIdent(columnName(original))} ${sqlIdent(nextColumn.column_name)} ${columnSql(nextColumn)}`);
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

function renameRowKeys(connectionId, database, tableName, beforeColumns = [], afterColumns = []) {
  const renames = [];
  afterColumns.forEach((column, index) => {
    const beforeName = columnName(beforeColumns[index]);
    const afterName = columnName(column);
    if (beforeName && afterName && beforeName !== afterName) renames.push([beforeName, afterName]);
  });
  if (!renames.length) return;
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
  return resolveMockSchema(connectionId, database).map((table) => table.table_name).sort((a, b) => a.localeCompare(b));
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
  mockDatabaseSchemas[key] = [...plan.copyTables, ...plan.preservedTables].sort((a, b) => a.localeCompare(b));
  for (const tableName of plan.copyTables) {
    replaceMockRows(plan.connectionId, plan.targetDatabase, plan.sourceDatabase, tableName);
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
    if (filterMode === "exact") {
      rows = rows.filter((row) => Object.values(row).some((value) => String(value) === request.filter.query.trim()));
    } else {
      rows = rows.filter((row) => Object.values(row).some((value) => String(value).toLowerCase().includes(filterQuery)));
    }
  }
  if (request.sort?.columnName || request.sort?.column_name) {
    const sortColumn = request.sort.columnName || request.sort.column_name;
    rows.sort((a, b) => {
      const left = String(a[sortColumn] ?? "");
      const right = String(b[sortColumn] ?? "");
      return request.sort.descending ? right.localeCompare(left) : left.localeCompare(right);
    });
  }
  const start = (page - 1) * pageSize;
  return {
    sessionId,
    tableName: table.table_name,
    tableComment: table.table_comment,
    columns: table.columns,
    primaryKeys: table.columns.filter((column) => column.is_primary_key).map(columnName),
    rows: rows.slice(start, start + pageSize).map((row) => ({ ...row })),
    totalRows: rows.length,
    page,
    pageSize,
  };
}

function primaryKeyColumns(table) {
  return (table?.columns || []).filter((column) => column.is_primary_key).map(columnName);
}

function primaryKeySignature(row, keys) {
  if (!keys.length) return "";
  const values = keys.map((key) => String(row?.[key] ?? "").trim());
  return values.every((value) => value !== "") ? values.join("\x1f") : "";
}

function hasPrimaryKeyConflict(table, rows, draft) {
  const keys = primaryKeyColumns(table);
  const signature = primaryKeySignature(draft, keys);
  return Boolean(signature && rows.some((row) => primaryKeySignature(row, keys) === signature));
}

export async function mockWorkbenchInvoke(command, payload = {}) {
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
    return schema.map(({ table_name, table_comment }) => ({ table_name, table_comment }));
  }
  if (command === "get_table_schema") {
    const { connectionId, database } = resolveContext(payload);
    return designFor(resolvedTable(connectionId, database, payload.tableName || payload.table_name));
  }
  if (command === "get_table_design") {
    const { connectionId, database } = resolveContext(payload);
    return designFor(resolvedTable(connectionId, database, payload.tableName || payload.table_name));
  }
  if (command === "preview_table_design_change") {
    const { connectionId, database } = resolveContext(payload);
    const tableName = payload.tableName || payload.table_name;
    const table = resolvedTable(connectionId, database, tableName);
    const preview = previewDesignChange(table, payload.draft || {}, { connectionId, database, tableName });
    const { nextTable, ...result } = preview;
    return result;
  }
  if (command === "apply_table_design_change") {
    const { connectionId, database } = resolveContext(payload);
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
    const appliedTable = appliedDesignBaseline(preview.nextTable);
    renameRowKeys(connectionId, database, table.table_name, table.columns, appliedTable.columns);
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
    mockSessions.set(sessionId, { connectionId, database, tableName: payload.tableName });
    return mockPageFor(payload.tableName, sessionId, connectionId, database, payload.options || {});
  }
  if (command === "fetch_table_page") {
    const { tableName, connectionId, database } = mockSessionContext(payload.sessionId);
    return mockPageFor(tableName, payload.sessionId, connectionId, database, payload.request || {});
  }
  if (command === "search_values") {
    const { connectionId, database } = resolveContext(payload.request || payload);
    const request = payload.request || payload;
    const query = String(request.query || "").trim().toLowerCase();
    const hasLimit = request.limit !== undefined && request.limit !== null && String(request.limit).trim() !== "";
    const rawLimit = hasLimit ? Number(request.limit) : NaN;
    const limitValue = Number.isFinite(rawLimit) ? rawLimit : 50;
    const limit = Math.max(1, Math.min(50, Math.floor(limitValue)));
    if (!query) return [];
    const schema = resolveMockSchema(connectionId, database);
    const results = [];
    for (const table of schema) {
      const rows = getOrInitRows(connectionId, database, table.table_name);
      let hit = null;
      for (const row of rows) {
        for (const col of table.columns) {
          const colName = col.column_name;
          const value = String(row[colName] ?? "");
          if (value.toLowerCase().includes(query)) {
            hit = {
              tableName: table.table_name,
              tableComment: table.table_comment || "",
              columnName: colName,
              previewValue: value.length > 80 ? value.slice(0, 80) : value,
            };
            break;
          }
        }
        if (hit) break;
      }
      if (hit) {
        results.push(hit);
        if (results.length >= limit) break;
      }
    }
    return results;
  }
  if (command === "search_data") {
    const { connectionId, database } = resolveContext(payload);
    const query = String(payload.request?.query || "").toLowerCase();
    if (!query) return [];
    const schema = tableSchemaFor(connectionId, database);
    const results = [];
    for (const table of schema) {
      const rows = getOrInitRows(connectionId, database, table.table_name);
      const matches = [];
      for (const row of rows) {
        for (const col of table.columns) {
          const colName = col.column_name;
          const value = String(row[colName] ?? "");
          if (value.toLowerCase().includes(query)) {
            matches.push({ columnName: colName, value: value.length > 60 ? value.slice(0, 60) + "..." : value });
          }
        }
      }
      if (matches.length > 0) {
        results.push({
          tableName: table.table_name,
          tableComment: table.table_comment || "",
          matchCount: matches.length,
          matches: matches.slice(0, 5),
        });
      }
    }
    return results;
  }
  if (command === "update_cell") {
    const { tableName, connectionId, database } = mockSessionContext(payload.request?.sessionId);
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
    const { tableName, connectionId, database } = mockSessionContext(payload.request?.sessionId);
    const rows = getOrInitRows(connectionId, database, tableName);
    const schema = tableSchemaFor(connectionId, database);
    const table = schema.find((item) => item.table_name === tableName) || schema[0];
    if (hasPrimaryKeyConflict(table, rows, payload.request?.draft || {})) {
      throw new Error(PRIMARY_KEY_DUPLICATE_MESSAGE);
    }
    rows.push({ ...(payload.request?.draft || {}) });
    return { affected: 1 };
  }
  if (command === "delete_rows") {
    const { tableName, connectionId, database } = mockSessionContext(payload.request?.sessionId);
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
    const plan = mockSyncPlan(payload);
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
    const plan = mockSyncPlan(payload);
    applyMockSyncPlan(plan);
    return {
      status: "succeeded",
      jobId: payload.jobId || payload.job_id || "",
      sourceDatabase: plan.sourceDatabase,
      targetDatabase: plan.targetDatabase,
      copiedTables: plan.copyTables,
      preservedTables: plan.preservedTables,
      removedTables: plan.removedTables,
      syncedTables: plan.copyTables.length,
    };
  }
  if (command === "add_connection" || command === "restore_connection") {
    upsertMockConnection(payload.url);
    return ["game_db"];
  }
  return null;
}
