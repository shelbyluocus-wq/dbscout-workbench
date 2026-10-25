import { createMockAuditHistory, recordMockTableDiff } from "./mockAuditHistory.js";
import { mockDatabaseSchemas, resetMockDatabaseSchemas, resolveMockSchema } from "./mockSchema.js";
import { getOrInitRows, rowCache } from "./mockRows.js";
import { emitMockEvent } from "./mockEventBus.js";
import { createMockConfigRelations, relationRowMatches } from "./mockConfigRelations.js";
import { createMockReleaseTools } from "./mockReleaseTools.js";
import { RELATION_LAB_DATABASE, requestedRelationLabSize } from "./mockRelationLab.js";
import {
  activePerfFixture,
  createPerfFixtureSchema,
  createPerfFixturePage,
  createPerfFixtureTable,
  listPerfFixtureTables,
  perfFixtureMetadata,
} from "./perfFixture.js";
import { columnName } from "../utils/normalize.js";
import { contiguousSearchPreview, findCaseInsensitiveRange, matchSearchText, replaceSearchText } from "../utils/searchMatch.js";
import { columnConstraint, validateCellValue, validateRowDraft } from "../utils/valueValidation.js";
import { validateTableDesignConversion } from "../utils/tableDesignCompatibility.js";
import { DEFAULT_PAGE_SIZE } from "../constants.js";
import { classifySqlStatement, splitSqlStatements } from "../utils/sqlStatements.js";
import { compareSortValues } from "../utils/naturalSort.js";

let mockSessionSeq = 0;
let mockObjectIdSeq = 0x1000;
let mockTableSearchSeq = 0;
let mockConnectionSeq = 10;
const mockSessions = new Map();
// Materialize only requested fixture pages; keep writes isolated from demo rows.
const perfRows = new Map();
const mockTableSearchJobs = new Map();
let mockAgentContext = { connectionId: "demo", database: "game_db", activeTableName: "player" };
let mockExternalMcpEnabled = true;
let mockExternalMcpContext = {};
let mockSqlJobSeq = 0;
let mockSqlHistorySeq = 0;
const mockSqlJobs = new Map();
const mockSqlTransactions = new Map();
const mockSqlFiles = new Map();
let mockSqlHistory = [];

function traceTableSearch(phase) {
  const trace = globalThis.__DBSCOUT_TABLE_SEARCH_TRACE__;
  if (!Array.isArray(trace)) return;
  trace.push({ phase, at: globalThis.performance?.now?.() ?? Date.now() });
}
const pendingMockAgentRequests = new Map();
const mockConnections = [
  { id: "demo", kind: "mysql", label: "Demo GameDB", host: "demo", port: 3306, username: "root", database: "game_db", connected: true, readOnly: false },
  { id: "demo-staging", kind: "mysql", label: "Staging Server", host: "staging.local", port: 3306, username: "dev", database: "game_db", connected: true, readOnly: false },
  { id: "demo-test", kind: "mysql", label: "Test Server", host: "test.local", port: 3307, username: "tester", database: "game_db", connected: true, readOnly: false },
  { id: "demo-mongo", kind: "mongodb", label: "Demo MongoDB", host: "127.0.0.1", port: 27017, username: "", database: "game_db", connected: true, readOnly: false },
];

const mockConnectionDatabases = {
  // `?relationLab=<tables>` adds a generated config database for the relation graph.
  demo: ["game_db", "game_config", ...(requestedRelationLabSize() ? [RELATION_LAB_DATABASE] : [])],
  "demo-staging": ["game_db", "analytics_db"],
  "demo-test": ["game_db", "game_db_archive"],
  "demo-mongo": ["game_db"],
};
const PRIMARY_KEY_DUPLICATE_MESSAGE = "主键重复，不能保存";
const schemaOverrides = new Map();
const mockReleaseTools = createMockReleaseTools();
const mockConfigRelations = createMockConfigRelations({
  connectionFor: (connectionId) => mockConnections.find((connection) => connection.id === connectionId),
  schemaFor: (connectionId, database) => tableSchemaFor(connectionId, database),
  rowsFor: (connectionId, database, tableName) => getOrInitRows(connectionId, database, tableName),
});

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
    perfScenario: session?.perfScenario || "",
  };
}

function requireMockSessionContext(sessionId) {
  if (!mockSessions.has(sessionId)) {
    throw new Error("表会话已失效，请重新打开表");
  }
  return mockSessionContext(sessionId);
}

export function resetMockWorkbenchState() {
  mockSessionSeq = 0;
  mockObjectIdSeq = 0x1000;
  mockTableSearchSeq = 0;
  mockSessions.clear();
  mockTableSearchJobs.clear();
  mockSqlJobs.clear();
  mockSqlTransactions.clear();
  mockSqlFiles.clear();
  mockSqlHistory = [];
  mockSqlJobSeq = 0;
  mockSqlHistorySeq = 0;
  schemaOverrides.clear();
  rowCache.clear();
  perfRows.clear();
  mockConfigRelations.reset();
  resetMockDatabaseSchemas();
}

const MOCK_SEARCH_SCAN_PAGE_SIZE = 128;

function mockSearchSourcePage(job) {
  if (job.perfScenario) {
    const metadata = createPerfFixturePage(job.perfScenario, {
      offset: 0,
      limit: 0,
      tableName: job.tableName,
    });
    const remaining = Math.max(0, metadata.totalRows - job.offset);
    const limit = Math.min(MOCK_SEARCH_SCAN_PAGE_SIZE, remaining);
    if (!job.sort?.descending) {
      return createPerfFixturePage(job.perfScenario, {
        offset: job.offset,
        limit,
        tableName: job.tableName,
      });
    }
    const ascendingOffset = Math.max(0, metadata.totalRows - job.offset - limit);
    const page = createPerfFixturePage(job.perfScenario, {
      offset: ascendingOffset,
      limit,
      tableName: job.tableName,
    });
    page.rows.reverse();
    return page;
  }
  const { table, rows } = mockRowsFor(
    job.tableName,
    job.connectionId,
    job.database,
    null,
    job.sort,
  );
  return {
    columns: table.columns,
    primaryKeys: table.columns.filter((column) => column.is_primary_key).map((column) => column.column_name),
    rows: rows.slice(job.offset, job.offset + MOCK_SEARCH_SCAN_PAGE_SIZE).map((row) => ({ ...row })),
    totalRows: rows.length,
  };
}

function mockSearchRowKey(job, row) {
  const keys = job.primaryKeys.length > 0 ? job.primaryKeys : job.columns.map(columnName);
  return keys.map((key) => `${key}=${String(row?.[key] ?? "")}`).join("&");
}

function scanMockTableSearchJob(job) {
  const source = mockSearchSourcePage(job);
  const resultRows = [];
  const rowKeys = [];
  const matches = [];
  let consumedRows = 0;
  for (let sourceOffset = 0; sourceOffset < source.rows.length; sourceOffset += 1) {
    const row = source.rows[sourceOffset];
    const rowMatches = [];
    for (let columnIndex = 0; columnIndex < job.columns.length; columnIndex += 1) {
      const name = columnName(job.columns[columnIndex]);
      const match = matchSearchText(row?.[name], job.query, { mode: job.mode });
      if (!match.matched) continue;
      rowMatches.push({
        rowIndex: resultRows.length,
        sourceRowIndex: job.offset + sourceOffset,
        columnIndex,
        columnName: name,
        kind: match.kind,
        rank: match.rank,
        score: match.score,
        ranges: match.ranges,
      });
    }
    consumedRows += 1;
    if (!rowMatches.length) continue;
    resultRows.push(row);
    rowKeys.push(mockSearchRowKey(job, row));
    matches.push(...rowMatches);
    if (resultRows.length >= job.resultPageSize || matches.length >= job.resultMatchLimit) break;
  }
  job.offset += consumedRows;
  return {
    jobId: job.id,
    rows: resultRows,
    rowKeys,
    matches,
    scannedRows: job.offset,
    complete: job.offset >= source.totalRows,
  };
}

function beginMockTableSearch(request) {
  traceTableSearch("begin:start");
  const session = requireMockSessionContext(request.sessionId);
  for (const [jobId, job] of mockTableSearchJobs) {
    if (job.sessionId === request.sessionId) mockTableSearchJobs.delete(jobId);
  }
  const source = session.perfScenario
    ? createPerfFixturePage(session.perfScenario, { offset: 0, limit: 0, tableName: session.tableName })
    : mockRowsFor(session.tableName, session.connectionId, session.database, null, request.sort);
  const columns = source.columns || source.table?.columns || [];
  const primaryKeys = source.primaryKeys
    || columns.filter((column) => column.is_primary_key).map((column) => column.column_name);
  const resultPageSize = Math.max(1, Math.min(200, Math.floor(Number(request.resultPageSize) || 100)));
  const job = {
    id: `mock-table-search-${++mockTableSearchSeq}`,
    sessionId: request.sessionId,
    tableName: session.tableName,
    connectionId: session.connectionId,
    database: session.database,
    perfScenario: session.perfScenario,
    query: String(request.query || "").trim(),
    mode: request.mode || "fuzzy",
    sort: request.sort || null,
    columns,
    primaryKeys,
    resultPageSize,
    resultMatchLimit: Math.max(100, Math.min(2_000, resultPageSize * 4)),
    offset: 0,
  };
  if (!job.query) throw new Error("搜索内容不能为空");
  mockTableSearchJobs.set(job.id, job);
  const page = scanMockTableSearchJob(job);
  traceTableSearch("begin:end");
  return page;
}

function nextMockTableSearchPage(jobId) {
  traceTableSearch("next:start");
  const job = mockTableSearchJobs.get(String(jobId || ""));
  if (!job) throw new Error("搜索任务已结束，请重新搜索");
  const page = scanMockTableSearchJob(job);
  traceTableSearch("next:end");
  return page;
}

function perfPageResponse(active, tableName, sessionId, request = {}) {
  const page = Math.max(1, Math.floor(Number(request.page) || 1));
  const pageSize = Math.max(
    1,
    Math.min(10_000, Math.floor(Number(request.pageSize || request.page_size) || DEFAULT_PAGE_SIZE)),
  );
  const requestedOffset = Number(request.offset);
  const offset = request.offset !== undefined && request.offset !== null && Number.isFinite(requestedOffset)
    ? Math.max(0, Math.floor(requestedOffset))
    : (page - 1) * pageSize;
  const generated = createPerfFixturePage(active.scenario, { offset, limit: pageSize, tableName });
  const cacheKey = sourceKey(active.connectionId, active.database, tableName);
  if (!perfRows.has(cacheKey)) perfRows.set(cacheKey, new Map());
  const cached = perfRows.get(cacheKey);
  generated.rows = generated.rows.map((row, index) => {
    if (!cached.has(offset + index)) cached.set(offset + index, row);
    return { ...cached.get(offset + index) };
  });
  return {
    sessionId,
    tableName,
    tableComment: `Deterministic ${active.scenario} fixture`,
    columns: generated.columns,
    primaryKeys: generated.primaryKeys,
    rows: generated.rows,
    totalRows: offset + generated.rows.length,
    totalRowsExact: false,
    hasMore: offset + generated.rows.length < generated.totalRows,
    page,
    pageSize,
  };
}

async function invokePerfFixture(command, payload) {
  const active = activePerfFixture();
  if (!active) return { handled: false, value: undefined };
  if (command === "list_connections") {
    return {
      handled: true,
      value: [{
        id: active.connectionId,
        kind: "mysql",
        label: "Deterministic Performance Fixture",
        host: "fixture",
        port: 3306,
        username: "fixture",
        database: active.database,
        connected: true,
        readOnly: false,
        sampleData: true,
      }],
    };
  }
  if (command === "list_databases") return { handled: true, value: [active.database] };
  if (command === "select_database") {
    const tables = active.scenario === "schema-800x60"
      ? createPerfFixtureSchema(active.scenario).tables.map((table) => ({
          ...table,
          column_count: table.columns.length,
          columnCount: table.columns.length,
          schemaLoaded: true,
        }))
      : listPerfFixtureTables(active.scenario);
    return {
      handled: true,
      value: {
        tableCount: tables.length,
        columnCount: tables.reduce((sum, table) => sum + Number(table.columnCount || 0), 0),
        tables,
      },
    };
  }
  if (command === "list_tables") {
    return { handled: true, value: listPerfFixtureTables(active.scenario) };
  }
  if (command === "get_table_schema") {
    const tableName = payload.tableName || payload.table_name || "";
    return { handled: true, value: designFor(createPerfFixtureTable(active.scenario, tableName)) };
  }
  if (command === "get_table_schemas") {
    const tableNames = payload.tableNames || payload.table_names || [];
    return {
      handled: true,
      value: tableNames.map((tableName) => designFor(createPerfFixtureTable(active.scenario, tableName))),
    };
  }
  if (command === "open_table_session") {
    const tableName = payload.tableName || listPerfFixtureTables(active.scenario)[0].table_name;
    const sessionId = `perf-session-${++mockSessionSeq}`;
    mockSessions.set(sessionId, {
      connectionId: active.connectionId,
      database: active.database,
      tableName,
      readOnly: false,
      perfScenario: active.scenario,
    });
    return {
      handled: true,
      value: perfPageResponse(active, tableName, sessionId, payload.options || {}),
    };
  }
  if (command === "fetch_table_page") {
    if (!mockSessions.has(payload.sessionId) && /^perf-session-/u.test(String(payload.sessionId || ""))) {
      throw new Error("Performance fixture session has expired");
    }
    const session = mockSessionContext(payload.sessionId);
    if (!session.perfScenario) return { handled: false, value: undefined };
    return {
      handled: true,
      value: perfPageResponse(
        { ...active, scenario: session.perfScenario },
        session.tableName,
        payload.sessionId,
        payload.request || {},
      ),
    };
  }
  if (command === "fetch_table_count") {
    if (!mockSessions.has(payload.sessionId) && /^perf-session-/u.test(String(payload.sessionId || ""))) {
      throw new Error("Performance fixture session has expired");
    }
    const session = mockSessionContext(payload.sessionId);
    if (!session.perfScenario) return { handled: false, value: undefined };
    const count = createPerfFixturePage(session.perfScenario, {
      offset: 0,
      limit: 0,
      tableName: session.tableName,
    });
    return {
      handled: true,
      value: { totalRows: count.totalRows, exact: true, estimated: false },
    };
  }
  if (command === "cancel_table_count") {
    return { handled: true, value: { cancelled: true } };
  }
  if (command === "perf_fixture_metadata") {
    return { handled: true, value: await perfFixtureMetadata() };
  }
  if (command === "perf_fixture_reset") {
    resetMockWorkbenchState();
    return { handled: true, value: { reset: true } };
  }
  return { handled: false, value: undefined };
}

function normalizeConnectionKind(kind, url = "") {
  const normalized = String(kind || "").trim().toLowerCase();
  if (normalized === "clickhouse" || normalized === "ch") return "clickhouse";
  if (normalized === "mongodb" || normalized === "mongo") return "mongodb";
  const source = String(url || "").trim().toLowerCase();
  if (source.startsWith("mongodb://") || source.startsWith("mongodb+srv://")) return "mongodb";
  return source.startsWith("http") ? "clickhouse" : "mysql";
}

function isReadOnlyConnection(connection) {
  return Boolean(connection?.readOnly || connection?.read_only || normalizeConnectionKind(connection?.kind) === "clickhouse");
}

function isMockConnectionReadOnly(connectionId) {
  return isReadOnlyConnection(mockConnections.find((connection) => String(connection.id) === String(connectionId)));
}

function isMockMongoConnection(connectionId) {
  const connection = mockConnections.find((item) => String(item.id) === String(connectionId));
  return normalizeConnectionKind(connection?.kind) === "mongodb";
}

function rejectMockMongo(connectionId, feature) {
  if (isMockMongoConnection(connectionId)) {
    throw new Error(`MongoDB 连接不支持${feature}`);
  }
}

function mockConnectionFromUrl(url, kind) {
  const normalizedKind = normalizeConnectionKind(kind, url);
  const defaults = {
    mysql: { port: 3306, user: "root", prefix: "mysql", label: "MySQL" },
    clickhouse: { port: 8123, user: "default", prefix: "clickhouse", label: "ClickHouse" },
    mongodb: { port: 27017, user: "", prefix: "mongodb", label: "MongoDB" },
  }[normalizedKind] || { port: 3306, user: "root", prefix: "mysql", label: "MySQL" };
  try {
    const parsed = new URL(url);
    const username = decodeURIComponent(parsed.username || defaults.user);
    return {
      id: `${defaults.prefix}-${++mockConnectionSeq}`,
      kind: normalizedKind,
      label: username ? `${username}@${parsed.hostname}:${parsed.port || defaults.port}` : `${parsed.hostname}:${parsed.port || defaults.port}`,
      host: parsed.hostname,
      port: parsed.port || String(defaults.port),
      username,
      database: "game_db",
      connected: true,
      readOnly: normalizedKind === "clickhouse",
    };
  } catch {
    return {
      id: `${defaults.prefix}-${++mockConnectionSeq}`,
      kind: normalizedKind,
      label: `${defaults.label} ${mockConnectionSeq}`,
      host: "127.0.0.1",
      port: String(defaults.port),
      username: defaults.user,
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
  const connection = existing || next;
  if (existing) {
    existing.kind = next.kind;
    existing.readOnly = next.readOnly;
    existing.connected = true;
  } else {
    mockConnections.push(next);
  }
  if (normalizeConnectionKind(connection.kind) === "mongodb") {
    mockConnectionDatabases[connection.id] ||= ["game_db"];
    mockDatabaseSchemas[`${connection.id}/game_db`] ||= ["players", "loot"];
  }
  return connection;
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
    primary_key_ordinal: column.primary_key_ordinal ?? column.primaryKeyOrdinal ?? null,
    primaryKeyOrdinal: column.primaryKeyOrdinal ?? column.primary_key_ordinal ?? null,
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
  let nextPrimaryKeyOrdinal = 1;
  return {
    ...clone,
    table_name: clone.table_name,
    tableName: clone.table_name,
    table_comment: clone.table_comment || "",
    tableComment: clone.table_comment || "",
    columns: clone.columns.map((column, index) => {
      const enriched = enrichColumn(column, index);
      if (enriched.is_primary_key && !enriched.primary_key_ordinal) {
        enriched.primary_key_ordinal = nextPrimaryKeyOrdinal;
        enriched.primaryKeyOrdinal = nextPrimaryKeyOrdinal;
        nextPrimaryKeyOrdinal += 1;
      } else if (enriched.is_primary_key) {
        nextPrimaryKeyOrdinal = Math.max(nextPrimaryKeyOrdinal, enriched.primary_key_ordinal + 1);
      }
      return enriched;
    }),
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
        primary_key_ordinal: column.primaryKey
          ? Number(column.primaryKeyOrdinal ?? column.primary_key_ordinal) || null
          : null,
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
      primaryKeyOrdinal: column.primary_key_ordinal ?? column.primaryKeyOrdinal ?? null,
      defaultMode: column.default_mode || column.defaultMode || "none",
      defaultValue: column.column_default ?? null,
      comment: column.column_comment || "",
    })),
  })}`;
}

function previewSignatureFor(source, schemaSignature, draft) {
  return `mock-preview:${JSON.stringify(source)}:${schemaSignature}:${JSON.stringify(draft || {})}`;
}

function primaryKeyOrdinal(column = {}) {
  const value = column.primary_key_ordinal ?? column.primaryKeyOrdinal ?? null;
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function samePrimaryKeyOrdinal(left = {}, right = {}) {
  const leftOrdinal = primaryKeyOrdinal(left);
  const rightOrdinal = primaryKeyOrdinal(right);
  // Demo schema often omits the ordinal. Filling it in is not a column change.
  if (leftOrdinal == null || rightOrdinal == null) return true;
  return leftOrdinal === rightOrdinal;
}

function sameColumn(left = {}, right = {}) {
  return left.column_name === right.column_name &&
    left.column_type === right.column_type &&
    Boolean(left.is_nullable) === Boolean(right.is_nullable) &&
    Boolean(left.is_primary_key) === Boolean(right.is_primary_key) &&
    samePrimaryKeyOrdinal(left, right) &&
    (left.column_default ?? null) === (right.column_default ?? null) &&
    String(left.column_comment || "") === String(right.column_comment || "");
}

const MOCK_INTEGER_TYPES = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint"]);

function changedColumnType(beforeColumn = {}, afterColumn = {}) {
  return String(beforeColumn.column_type || "").trim().toLowerCase()
    !== String(afterColumn.column_type || "").trim().toLowerCase();
}

function conflictSample(value) {
  if (value == null) return "NULL";
  const normalized = String(value).replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t");
  const chars = [...normalized];
  return `「${chars.slice(0, 48).join("")}${chars.length > 48 ? "…" : ""}」`;
}

function designConflicts(baseTable = {}, nextTable = {}, rows = []) {
  const baseColumnByName = new Map((baseTable.columns || []).map((column) => [columnName(column), column]));
  return (nextTable.columns || [])
    .map((nextColumn) => {
      const originalName = String(nextColumn.original_name ?? nextColumn.originalName ?? "").trim();
      const beforeColumn = originalName ? baseColumnByName.get(originalName) : null;
      if (!beforeColumn || !changedColumnType(beforeColumn, nextColumn)) return "";
      const invalid = [];
      let reason = "";
      let invalidCount = 0;
      for (const row of rows) {
        const value = row?.[originalName];
        const validation = validateTableDesignConversion(nextColumn, value);
        if (!validation.valid) {
          invalidCount += 1;
          if (invalid.length < 3) invalid.push(conflictSample(value));
          reason ||= validation.errors?.[0]?.shortMessage || "格式不兼容";
        }
      }
      if (!reason) return "";
      return `字段「${originalName}」有 ${invalidCount} 个现有值无法转换为 ${nextColumn.column_type}${invalid.length ? `，例如 ${invalid.join("、")}` : ""}（${reason}）`;
    })
    .filter(Boolean);
}

function previewDesignChange(baseTable, draft = {}, source = {}, rows = []) {
  const baseColumns = baseTable.columns || [];
  const baseColumnNames = new Set(baseColumns.map(columnName));
  const draftColumns = Array.isArray(draft.columns) ? draft.columns : [];
  const draftOriginalNames = new Set(draftColumns.map((column) => String(column.originalName ?? column.original_name ?? "").trim()).filter(Boolean));
  const missingColumns = baseColumns.filter((column) => !draftOriginalNames.has(columnName(column)));
  const unknownOriginals = draftColumns.filter((column) => {
    const draftIdentity = String(column.originalName ?? column.original_name ?? "").trim();
    return draftIdentity && !baseColumnNames.has(draftIdentity);
  });
  if (unknownOriginals.length) {
    const names = unknownOriginals.map((column) => String(column.name || column.column_name || column.originalName || column.original_name || "unnamed column").trim()).join(", ");
    throw new Error(`Mock table design preview does not support unknown original column(s): ${names}`);
  }
  const nextTable = tableFromDraft(baseTable, draft);
  const conflicts = designConflicts(baseTable, nextTable, rows);
  const statements = [];
  const humanDescriptions = missingColumns.map((column) => `🗑️ 删除字段「${columnName(column)}」（字段数据将被永久删除）`);
  const orderedPrimaryKeyNames = (columns = []) => columns
    .filter((column) => column.is_primary_key)
    .sort((left, right) => (left.primary_key_ordinal ?? Number.MAX_SAFE_INTEGER) - (right.primary_key_ordinal ?? Number.MAX_SAFE_INTEGER))
    .map(columnName);
  const originalPk = orderedPrimaryKeyNames(baseTable.columns || []);
  const nextPk = orderedPrimaryKeyNames(nextTable.columns);
  const primaryKeyChanged = originalPk.join("\x1f") !== nextPk.join("\x1f");
  if (primaryKeyChanged && originalPk.length) {
    statements.push(`ALTER TABLE ${sqlIdent(baseTable.table_name)} DROP PRIMARY KEY`);
  }
  missingColumns.forEach((column) => {
    statements.push(`ALTER TABLE ${sqlIdent(baseTable.table_name)} DROP COLUMN ${sqlIdent(columnName(column))}`);
  });
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
  if (primaryKeyChanged && nextPk.length) {
    statements.push(`ALTER TABLE ${sqlIdent(baseTable.table_name)} ADD PRIMARY KEY (${nextPk.map(sqlIdent).join(", ")})`);
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
    humanDescriptions,
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
  const retainedNames = new Set(afterColumns.map((column) => String(column.original_name ?? column.originalName ?? "").trim()).filter(Boolean));
  const removed = [...beforeNames].filter((name) => !retainedNames.has(name));
  afterColumns.forEach((column) => {
    const beforeName = String(column.original_name ?? column.originalName ?? "").trim();
    const afterName = columnName(column);
    if (beforeName && afterName && beforeName !== afterName) renames.push([beforeName, afterName]);
    if (!beforeName && afterName && !beforeNames.has(afterName)) added.push([afterName, mockDefaultRowValue(column)]);
  });
  if (!renames.length && !added.length && !removed.length) return;
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
    removed.forEach((name) => delete row[name]);
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

function mockRowsFor(tableName, connectionId, database, filter = null, sort = null) {
  const schema = tableSchemaFor(connectionId, database);
  const table = schema.find((t) => t.table_name === tableName) || schema[0];
  const filterQuery = String(filter?.query || "").trim().toLowerCase();
  const filterMode = filter?.mode || "fuzzy";
  let rows = [...(getOrInitRows(connectionId, database, table.table_name) || [])];
  if (filterQuery) {
    const filterColumns = Array.isArray(filter?.columns)
      ? filter.columns.map((name) => String(name || "").trim()).filter(Boolean)
      : [];
    const filterValues = (row) => {
      if (!filterColumns.length) return Object.values(row);
      return filterColumns.map((name) => row[name]);
    };
    if (filterMode === "exact") {
      rows = rows.filter((row) => filterValues(row).some((value) => String(value) === filter.query.trim()));
    } else if (filterMode === "continuous") {
      rows = rows.filter((row) => filterValues(row).some((value) => contiguousValueMatches(value, filter.query)));
    } else {
      rows = rows.filter((row) => filterValues(row).some((value) => fuzzyValueMatches(value, filter.query)));
    }
  }
  if (filter?.relation) {
    rows = rows.filter((row) => relationRowMatches(row, table.columns, filter.relation));
  }
  if (sort?.columnName || sort?.column_name) {
    const sortColumn = sort.columnName || sort.column_name;
    rows.sort((a, b) => {
      const left = String(a[sortColumn] ?? "");
      const right = String(b[sortColumn] ?? "");
      const cmp = compareSortValues(left, right);
      return sort.descending ? -cmp : cmp;
    });
  } else {
    const primaryKeys = (table.columns || [])
      .filter((column) => column.is_primary_key)
      .map((column) => columnName(column));
    if (primaryKeys.length) {
      rows.sort((a, b) => {
        for (const key of primaryKeys) {
          const cmp = compareSortValues(String(a[key] ?? ""), String(b[key] ?? ""));
          if (cmp) return cmp;
        }
        return 0;
      });
    }
  }
  return { table, rows };
}

function mockPageFor(tableName, sessionId, connectionId, database, request = {}) {
  const { table, rows } = mockRowsFor(tableName, connectionId, database, request.filter, request.sort);
  const page = Math.max(1, Math.floor(Number(request.page) || 1));
  const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(request.pageSize || request.page_size) || DEFAULT_PAGE_SIZE)));
  const requestedOffset = Number(request.offset);
  const start = request.offset !== undefined && request.offset !== null && Number.isFinite(requestedOffset)
    ? Math.max(0, Math.floor(requestedOffset))
    : (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize).map((row) => ({ ...row }));
  const totalRows = start + pageRows.length;
  const totalRowsExact = false;
  const hasMore = pageRows.length >= pageSize;
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

function filterTablesByIncluded(schema, includedTables = []) {
  const included = Array.isArray(includedTables)
    ? new Set(includedTables.map((name) => String(name || "").trim().toLowerCase()).filter(Boolean))
    : new Set();
  if (!included.size) return schema;
  return schema.filter((table) => included.has(String(table?.table_name || "").toLowerCase()));
}

function mockTableOption(table, connectionId, database, index = 0) {
  const columnCount = Array.isArray(table?.columns) ? table.columns.length : 0;
  const rowCount = getOrInitRows(connectionId, database, table.table_name).length;
  const dataSizeBytes = Number.isFinite(Number(table?.data_size_bytes))
    ? Number(table.data_size_bytes)
    : Math.max(512, rowCount * Math.max(1, columnCount) * 48);
  const modifiedAt = table?.modified_at || `2026-07-${String(Math.max(1, 13 - (index % 12))).padStart(2, "0")} 10:30:00`;
  return {
    table_name: table.table_name,
    table_comment: table.table_comment,
    column_count: columnCount,
    columnCount,
    data_size_bytes: dataSizeBytes,
    dataSizeBytes,
    modified_at: modifiedAt,
    modifiedAt,
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

function mockBatchImportPreviewValue(value) {
  const characters = Array.from(String(value ?? ""));
  return {
    value: characters.slice(0, 512).join(""),
    truncated: characters.length > 512,
  };
}

function mockBatchImportPreview(table, keys, draft, changes) {
  return {
    identity: Object.fromEntries(
      keys
        .filter((key) => String(draft?.[key] ?? "").trim() !== "")
        .map((key) => [key, String(draft[key])]),
    ),
    changes: changes.map(([name, oldValue, newValue]) => {
      const oldPreview = oldValue === null || oldValue === undefined
        ? { value: null, truncated: false }
        : mockBatchImportPreviewValue(oldValue);
      const newPreview = mockBatchImportPreviewValue(newValue);
      return {
        columnName: name,
        oldValue: oldPreview.value,
        newValue: newPreview.value,
        oldValueTruncated: oldPreview.truncated,
        newValueTruncated: newPreview.truncated,
      };
    }),
  };
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

function nextMockAutoIncrement(rows, column) {
  const name = columnName(column);
  const maximum = rows.reduce((current, row) => {
    const value = Number(row?.[name]);
    return Number.isSafeInteger(value) && value >= 0 ? Math.max(current, value) : current;
  }, 0);
  return String(maximum + 1);
}

function mockExpressionValue(expression) {
  const normalized = String(expression ?? "").trim().toUpperCase().replace(/\(\s*\)$/, "");
  if (["CURRENT_TIMESTAMP", "NOW", "LOCALTIME", "LOCALTIMESTAMP"].includes(normalized)) {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
  }
  return String(expression ?? "");
}

function materializeMockInsert(table, rows, draft = {}) {
  const columns = Array.isArray(table?.columns) ? table.columns : [];
  if (!columns.length) return { storedRow: { ...draft }, returnedRow: { ...draft }, nullColumns: [] };
  const constraints = columns.map((column) => ({ column, constraint: columnConstraint(column) }));
  const primaryKeys = constraints.filter(({ constraint }) => constraint.primaryKey);
  const inferSingleIntegerPrimaryKey = primaryKeys.length === 1
    && MOCK_INTEGER_TYPES.has(primaryKeys[0].constraint.type);
  const storedRow = {};
  const nullColumns = [];

  for (const { column, constraint } of constraints) {
    const name = constraint.name;
    if (!name || constraint.isGenerated) continue;
    if (Object.hasOwn(draft, name)) {
      storedRow[name] = draft[name] == null ? null : String(draft[name]);
    } else if (constraint.isAutoIncrement || (inferSingleIntegerPrimaryKey && constraint.primaryKey)) {
      storedRow[name] = nextMockAutoIncrement(rows, column);
    } else if (constraint.defaultMode === "value") {
      storedRow[name] = String(column.column_default ?? column.columnDefault ?? column.default_value ?? column.defaultValue ?? "");
    } else if (constraint.defaultMode === "expression") {
      storedRow[name] = mockExpressionValue(column.column_default ?? column.columnDefault ?? column.default_value ?? column.defaultValue);
    } else if (constraint.defaultMode === "null" || constraint.nullable) {
      storedRow[name] = null;
    } else {
      storedRow[name] = "";
    }
    if (storedRow[name] == null) nullColumns.push(name);
  }

  const returnedRow = Object.fromEntries(
    Object.entries(storedRow).map(([name, value]) => [name, value == null ? "" : String(value)]),
  );
  return { storedRow, returnedRow, nullColumns };
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

function mockSqlEvent(job, values) {
  emitMockEvent("sql-execution-event", {
    queryTabId: job.request.queryTabId,
    connectionId: job.request.connectionId,
    database: job.request.database,
    jobId: job.jobId,
    executionId: job.executionId,
    ...values,
  });
}

function addMockSqlHistory(job, sql, status, durationMs, affectedRows = 0) {
  mockSqlHistory.unshift({
    id: ++mockSqlHistorySeq,
    connectionId: job.request.connectionId,
    database: job.request.database,
    sql,
    status,
    durationMs,
    affectedRows,
    executedAt: new Date().toISOString(),
    favorite: false,
    name: null,
  });
  const favorites = mockSqlHistory.filter((row) => row.favorite);
  const normal = mockSqlHistory.filter((row) => !row.favorite).slice(0, 500);
  mockSqlHistory = [...favorites, ...normal].sort((left, right) => right.id - left.id);
}

function demoSqlRows(sql) {
  const upper = sql.toUpperCase();
  if (upper.startsWith("EXPLAIN")) {
    return [{ id: 1, select_type: "SIMPLE", table: "player", type: "ALL", possible_keys: null, rows: 3 }];
  }
  if (/\bFROM\s+`?PLAYER`?\b/i.test(sql)) {
    return [
      { id: 1001, nickname: "北辰", level: 42, last_login: "2026-07-14 09:32:11", guild_id: null },
      { id: 1002, nickname: "夏栀", level: 37, last_login: "2026-07-13 21:08:04", guild_id: 12 },
      { id: 1003, nickname: "青禾", level: 51, last_login: "2026-07-14 08:17:29", guild_id: 8 },
    ];
  }
  if (/\bFROM\s+`?ITEM`?\b/i.test(sql)) {
    return [
      { id: 2001, name: "星辉石", rarity: "epic", price: 3200 },
      { id: 2002, name: "远行券", rarity: "rare", price: 850 },
    ];
  }
  return [{ result: 1, environment: "browser-demo", executed_at: new Date().toISOString() }];
}

function mockSqlColumns(rows) {
  const sample = rows[0] || {};
  return Object.keys(sample).map((name) => ({
    name,
    key: name,
    typeName: sample[name] == null ? "Nullable(String)" : typeof sample[name] === "number" ? "Int64" : "String",
    nullable: sample[name] == null,
  }));
}

async function mockSqlDelay(job, milliseconds) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (job.cancelled) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(40, end - Date.now())));
  }
  return !job.cancelled;
}

function requestSqlStatements(request) {
  const provided = (Array.isArray(request.statements) ? request.statements : [])
    .map((statement) => String(statement ?? "").trim())
    .filter(Boolean);
  return provided.length
    ? provided.map((text) => ({ text }))
    : splitSqlStatements(request.sql);
}

async function runMockSqlJob(job) {
  mockSqlEvent(job, { type: "execution-started" });
  const statements = requestSqlStatements(job.request);
  for (let index = 0; index < statements.length; index += 1) {
    if (job.cancelled) break;
    const sql = statements[index].text;
    const classification = classifySqlStatement(sql);
    const started = performance.now();
    mockSqlEvent(job, { type: "statement-started", statementIndex: index, sql, category: classification.kind });
    if (/\b(SLEEP|LONG_RUNNING)\b/i.test(sql) && !(await mockSqlDelay(job, 1800))) break;
    if (/SYNTAX_ERROR|INVALID\s+SQL/i.test(sql)) {
      const durationMs = Math.round(performance.now() - started);
      const error = "You have an error in your SQL syntax near 'SYNTAX_ERROR' at line 1";
      mockSqlEvent(job, { type: "statement-error", statementIndex: index, durationMs, error, errorOffset: sql.indexOf("SYNTAX_ERROR") });
      addMockSqlHistory(job, sql, "failed", durationMs);
      break;
    }
    const durationMs = Math.max(1, Math.round(performance.now() - started));
    if (classification.kind === "read") {
      const allRows = demoSqlRows(sql);
      const limit = Math.max(1, Number(job.request.rowLimit) || 1000);
      const rows = allRows.slice(0, limit);
      mockSqlEvent(job, { type: "result-meta", statementIndex: index, columns: mockSqlColumns(rows) });
      mockSqlEvent(job, { type: "row-batch", statementIndex: index, rows });
      mockSqlEvent(job, {
        type: "statement-completed",
        statementIndex: index,
        durationMs,
        rowCount: rows.length,
        affectedRows: 0,
        truncated: allRows.length > limit,
        warnings: [],
        message: `返回 ${rows.length} 行`,
        plan: classification.keyword === "EXPLAIN" ? rows : null,
      });
      addMockSqlHistory(job, sql, "success", durationMs);
    } else {
      mockSqlEvent(job, { type: "statement-completed", statementIndex: index, durationMs, rowCount: 0, affectedRows: 1, truncated: false, warnings: ["演示模式未修改真实数据库"], message: "影响 1 行" });
      mockSqlEvent(job, { type: "schema-changed" });
      addMockSqlHistory(job, sql, "success", durationMs, 1);
    }
  }
  if (job.cancelled) mockSqlEvent(job, { type: "cancelled", message: "查询已停止" });
  mockSqlEvent(job, { type: "execution-completed" });
  mockSqlJobs.delete(job.jobId);
}

function startMockSqlExecution(request) {
  const connection = mockConnections.find((item) => item.id === request.connectionId);
  const statements = requestSqlStatements(request);
  if (!statements.length) throw new Error("没有可执行的 SQL");
  const classifications = statements.map((item) => classifySqlStatement(item.text));
  if (connection?.readOnly && classifications.some((item) => item.kind !== "read")) throw new Error("当前连接为只读连接");
  if (classifications.some((item) => item.highRisk) && !request.confirmedRisky) throw new Error("该批次包含高风险 SQL，需要确认后才能执行");
  const job = {
    request,
    jobId: `mock-sql-job-${++mockSqlJobSeq}`,
    executionId: `mock-sql-execution-${mockSqlJobSeq}`,
    cancelled: false,
  };
  mockSqlJobs.set(job.jobId, job);
  queueMicrotask(() => runMockSqlJob(job));
  return { jobId: job.jobId, executionId: job.executionId };
}

function downloadMockFile(fileName, data, type = "application/octet-stream") {
  if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") return `mock://${fileName}`;
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return `mock://${fileName}`;
}

export async function mockWorkbenchInvoke(command, payload = {}) {
  // 开发/联调用：通过全局变量注入分页读取延迟，模拟真实后端时延下的滚动预取场景。
  const mockPageLatencyMs = Math.max(0, Number(globalThis.__DBSCOUT_MOCK_PAGE_LATENCY_MS__) || 0);
  if (mockPageLatencyMs > 0 && (command === "fetch_table_page" || command === "fetch_table_count")) {
    await new Promise((resolve) => setTimeout(resolve, mockPageLatencyMs));
  }
  if (command === "get_external_mcp_status" || command === "set_external_mcp_enabled") {
    if (command === "set_external_mcp_enabled") mockExternalMcpEnabled = Boolean(payload.enabled);
    return {
      enabled: mockExternalMcpEnabled,
      running: true,
      connectedClients: 0,
      protocolVersion: 1,
      endpointFile: "mock://control-endpoint.json",
      nodePath: "node",
      serverPath: "mock://mcp-server.mjs",
      appPath: "mock://blackcat",
      installCommand: "claude mcp add --transport stdio --scope user blackcat -- node mcp-server.mjs --app-executable mock://blackcat",
      codexInstallCommand: "codex mcp add blackcat -- node mcp-server.mjs --app-executable mock://blackcat",
    };
  }
  if (command === "control_frontend_ready") return [];
  if (command === "control_frontend_unready") return null;
  if (command === "control_update_context") {
    mockExternalMcpContext = { ...(payload.context || {}) };
    return null;
  }
  if (command === "control_complete_ui_action") return null;
  if (command === "read_clipboard_text") {
    const readText = globalThis.navigator?.clipboard?.readText;
    if (typeof readText !== "function") throw new Error("读取剪贴板失败");
    return await readText.call(globalThis.navigator.clipboard);
  }
  if (command === "start_sql_execution") {
    const request = payload.request || payload;
    rejectMockMongo(request.connectionId || request.connection_id, "SQL 控制台");
    return startMockSqlExecution(request);
  }
  if (command === "cancel_sql_execution") {
    const job = mockSqlJobs.get(String(payload.jobId || payload.job_id || ""));
    if (job) job.cancelled = true;
    return Boolean(job);
  }
  if (command === "begin_sql_transaction") {
    const request = payload.request || payload;
    const sessionId = `mock-sql-transaction-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
    mockSqlTransactions.set(sessionId, { ...request });
    return { sessionId };
  }
  if (command === "commit_sql_transaction" || command === "rollback_sql_transaction") {
    const sessionId = String(payload.sessionId || payload.session_id || "");
    if (!mockSqlTransactions.delete(sessionId)) throw new Error("事务会话不存在或已经结束");
    return null;
  }
  if (command === "list_sql_history") {
    const request = payload.request || payload;
    const query = String(request.query || "").toLocaleLowerCase();
    return mockSqlHistory.filter((row) => (!request.connectionId || row.connectionId === request.connectionId) && (!query || `${row.name || ""} ${row.sql} ${row.database}`.toLocaleLowerCase().includes(query))).slice(0, request.limit || 500).map((row) => ({ ...row }));
  }
  if (command === "save_sql_favorite") {
    const row = mockSqlHistory.find((item) => item.id === Number(payload.id));
    if (row) Object.assign(row, { favorite: Boolean(payload.favorite), name: payload.favorite ? String(payload.name || "").trim() || null : null });
    return null;
  }
  if (command === "delete_sql_history") { mockSqlHistory = mockSqlHistory.filter((row) => row.id !== Number(payload.id)); return null; }
  if (command === "clear_sql_history") { mockSqlHistory = mockSqlHistory.filter((row) => row.favorite || (payload.connectionId && row.connectionId !== payload.connectionId)); return 1; }
  if (command === "open_sql_file") {
    const path = String(payload.path || "");
    if (!path) return null;
    const file = mockSqlFiles.get(path);
    if (!file) throw new Error("最近 SQL 文件已不存在");
    return { ...file };
  }
  if (command === "save_sql_file") {
    const request = payload.request || payload;
    const fileName = String(request.fileName || "query.sql").replace(/\.sql\.sql$/i, ".sql");
    const path = downloadMockFile(fileName, String(request.content || ""), "text/sql;charset=utf-8");
    mockSqlFiles.set(path, { path, fileName, content: String(request.content || "") });
    return { path, fileName };
  }
  if (command === "save_sql_result_file") {
    return downloadMockFile(String(payload.fileName || "query-result.csv"), Uint8Array.from(payload.data || []));
  }
  if (command === "list_system_fonts") {
    return {
      fonts: [
        { family: "Arial", weights: [400, 700, 900] },
        { family: "Bahnschrift", weights: [300, 400, 600, 700] },
        { family: "Calibri", weights: [300, 400, 700] },
        { family: "Cambria", weights: [400, 700] },
        { family: "Cascadia Code", weights: [200, 300, 350, 400, 600, 700] },
        { family: "Cascadia Mono", weights: [200, 300, 350, 400, 600, 700] },
        { family: "Comic Sans MS", weights: [400, 700] },
        { family: "Consolas", weights: [400, 700] },
        { family: "Courier New", weights: [400, 700] },
        { family: "DengXian", weights: [300, 400, 700] },
        { family: "Georgia", weights: [400, 700] },
        { family: "Microsoft JhengHei UI", weights: [300, 400, 700] },
        { family: "Microsoft YaHei UI", weights: [300, 400, 700] },
        { family: "Noto Sans CJK SC", weights: [100, 300, 400, 500, 700, 900] },
        { family: "PingFang SC", weights: [100, 200, 300, 400, 500, 600] },
        { family: "Segoe UI", weights: [300, 400, 600, 700, 900] },
        { family: "SimHei", weights: [400] },
        { family: "SimSun", weights: [400] },
        { family: "Source Han Sans SC", weights: [100, 300, 400, 500, 700, 900] },
        { family: "Tahoma", weights: [400, 700] },
        { family: "Times New Roman", weights: [400, 700] },
        { family: "Trebuchet MS", weights: [400, 700] },
        { family: "Verdana", weights: [400, 700] },
      ],
    };
  }
  if (command === "close_table_session") {
    const sessionId = String(payload.sessionId || payload.session_id || "");
    for (const [jobId, job] of mockTableSearchJobs) {
      if (job.sessionId === sessionId) mockTableSearchJobs.delete(jobId);
    }
    return { closed: mockSessions.delete(sessionId) };
  }
  if (command === "begin_table_search") return beginMockTableSearch(payload.request || payload);
  if (command === "next_table_search_page") {
    return nextMockTableSearchPage((payload.request || payload).jobId);
  }
  if (command === "cancel_table_search") {
    return { cancelled: mockTableSearchJobs.delete(String(payload.jobId || payload.job_id || "")) };
  }
  const perfResult = await invokePerfFixture(command, payload);
  if (perfResult.handled) return perfResult.value;
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
    for (const [sessionId, session] of mockSessions) {
      if (String(session.connectionId) === String(connectionId)) mockSessions.delete(sessionId);
    }
    delete mockConnectionDatabases[connectionId];
    // Mirror the Rust backend: notify the frontend that sessions died so
    // affected tabs can reopen instead of failing lazily.
    emitMockEvent("table-sessions-invalidated", {
      connectionId,
      sessionIds: [],
      reason: "connection-removed",
    });
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
    const tables = schema.map((table, index) => mockTableOption(table, connectionId, database, index));
    return {
      tableCount: schema.length,
      columnCount: schema.reduce((sum, table) => sum + table.columns.length, 0),
      tables,
    };
  }
  if (command === "list_tables") {
    const { connectionId, database } = resolveContext(payload);
    const schema = tableSchemaFor(connectionId, database);
    return schema.map((table, index) => mockTableOption(table, connectionId, database, index));
  }
  if (command === "get_table_schema") {
    const { connectionId, database } = resolveContext(payload);
    return designFor(resolvedTable(connectionId, database, payload.tableName || payload.table_name));
  }
  if (command === "get_table_schemas") {
    const { connectionId, database } = resolveContext(payload);
    return (payload.tableNames || payload.table_names || []).map((tableName) =>
      designFor(resolvedTable(connectionId, database, tableName))
    );
  }
  if (command === "get_table_design") {
    const { connectionId, database } = resolveContext(payload);
    rejectMockMongo(connectionId, "表设计");
    if (isMockConnectionReadOnly(connectionId)) throw new Error("只读连接不能打开表设计");
    return designFor(resolvedTable(connectionId, database, payload.tableName || payload.table_name));
  }
  if (command === "preview_table_design_change") {
    const { connectionId, database } = resolveContext(payload);
    rejectMockMongo(connectionId, "表设计");
    if (isMockConnectionReadOnly(connectionId)) throw new Error("只读连接不能打开表设计");
    const tableName = payload.tableName || payload.table_name;
    const table = resolvedTable(connectionId, database, tableName);
    const rows = getOrInitRows(connectionId, database, tableName);
    const preview = previewDesignChange(table, payload.draft || {}, { connectionId, database, tableName }, rows);
    const { nextTable, ...result } = preview;
    return result;
  }
  if (command === "cancel_table_design_validation") {
    return false;
  }
  if (command === "apply_table_design_change") {
    const { connectionId, database } = resolveContext(payload);
    rejectMockMongo(connectionId, "表设计");
    if (isMockConnectionReadOnly(connectionId)) throw new Error("只读连接不能打开表设计");
    const tableName = payload.tableName || payload.table_name;
    if (!(payload.previewSignature || payload.signature) || !(payload.schemaSignature || payload.sourceSignature)) {
      throw new Error("Mock apply_table_design_change requires previewSignature and schemaSignature from preview_table_design_change");
    }
    const table = resolvedTable(connectionId, database, tableName);
    const rows = getOrInitRows(connectionId, database, tableName);
    const preview = previewDesignChange(table, payload.draft || {}, { connectionId, database, tableName }, rows);
    const expectedPreviewSignature = payload.previewSignature || payload.signature;
    const expectedSchemaSignature = payload.schemaSignature || payload.sourceSignature;
    if (expectedPreviewSignature !== preview.previewSignature || expectedSchemaSignature !== preview.schemaSignature) {
      throw new Error("Mock table design preview signature is stale; preview the design again before applying");
    }
    if (preview.conflicts.length) {
      throw new Error(`发现现有字段值与目标类型不兼容，表结构未修改。请先修正这些数据，再重新预览：${preview.conflicts.join("；")}`);
    }
    migrateRowKeysForDesign(connectionId, database, table.table_name, table.columns, preview.nextTable.columns);
    const appliedTable = appliedDesignBaseline(preview.nextTable);
    schemaOverrides.set(sourceKey(connectionId, database, table.table_name), appliedTable);
    recordMockDdlAudit({ connectionId, database, tableName, preview });
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
    const { tableName, connectionId, database } = requireMockSessionContext(payload.sessionId);
    return mockPageFor(tableName, payload.sessionId, connectionId, database, payload.request || {});
  }
  if (command === "fetch_table_count") {
    const { tableName, connectionId, database } = requireMockSessionContext(payload.sessionId);
    const { rows } = mockRowsFor(tableName, connectionId, database, payload.filter, null);
    return { totalRows: rows.length, exact: true, estimated: false };
  }
  if (command === "cancel_table_count") {
    return { cancelled: true };
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
    const schema = orderTablesByPriority(
      filterTablesByIncluded(resolveMockSchema(connectionId, database), request.includedTables),
      request.priorityTables,
    ).slice(0, 1500);
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
  if (command === "update_cell" || command === "update_cells") {
    const { tableName, connectionId, database, readOnly, perfScenario } = requireMockSessionContext(payload.request?.sessionId);
    if (readOnly) throw new Error("只读连接不能编辑数据");
    const table = perfScenario ? createPerfFixtureTable(perfScenario, tableName) : resolvedTable(connectionId, database, tableName);
    const fixtureRows = perfScenario ? perfRows.get(sourceKey(connectionId, database, tableName)) : null;
    const rows = fixtureRows ? [...fixtureRows.values()] : getOrInitRows(connectionId, database, tableName);
    const requestRows = command === "update_cell"
      ? [{
        rowIdentity: payload.request?.rowIdentity || {},
        changes: [{
          columnName: payload.request?.columnName,
          oldValue: payload.request?.oldValue,
          newValue: payload.request?.newValue,
        }],
      }]
      : payload.request?.rows || [];
    const working = rows.map((row) => ({ ...row }));
    let updated = 0;
    const identityMatches = (candidate, identity) => Object.entries(identity).every(([key, value]) => (
      value == null ? candidate[key] == null : String(candidate[key]) === String(value)
    ));
    for (const patch of requestRows) {
      const matches = working
        .map((candidate, index) => identityMatches(candidate, patch.rowIdentity || {}) ? index : -1)
        .filter((index) => index >= 0);
      if (matches.length !== 1) {
        return command === "update_cell"
          ? { updated: false, conflict: true, value: payload.request?.oldValue ?? null }
          : { updated: 0, conflict: true };
      }
      const row = working[matches[0]];
      let changed = false;
      for (const change of patch.changes || []) {
        if (isMockMongoConnection(connectionId) && String(change.columnName || "") === "_id") {
          throw new Error("MongoDB 不能修改 _id");
        }
        const current = row[change.columnName] == null ? null : String(row[change.columnName]);
        const expected = change.oldValue == null ? null : String(change.oldValue);
        if (current !== expected) {
          return command === "update_cell"
            ? { updated: false, conflict: true, value: current }
            : { updated: 0, conflict: true };
        }
        if (change.oldValue === change.newValue) continue;
        row[change.columnName] = change.newValue;
        changed = true;
      }
      if (changed) updated += 1;
    }
    const keys = primaryKeyColumns(table);
    const signatures = new Set();
    for (const row of working) {
      const signature = primaryKeySignature(row, keys);
      if (signature && signatures.has(signature)) throw new Error("主键重复，不能保存");
      if (signature) signatures.add(signature);
    }
    if (!fixtureRows) recordMockTableDiff(mockAuditLogState, { connectionId, database, tableName }, table, rows, working);
    rows.splice(0, rows.length, ...working);
    if (fixtureRows) [...fixtureRows.keys()].forEach((key, index) => fixtureRows.set(key, working[index]));
    return command === "update_cell"
      ? {
        updated: updated > 0,
        conflict: false,
        value: payload.request?.newValue ?? null,
      }
      : { updated, conflict: false };
  }
  if (command === "replace_in_table") {
    const { tableName, connectionId, database, readOnly } = requireMockSessionContext(payload.request?.sessionId);
    rejectMockMongo(connectionId, "整表查找替换");
    if (readOnly) throw new Error("只读连接不能编辑数据");
    const request = payload.request || {};
    const query = String(request.query ?? "");
    if (!query) return { replacedCells: 0, replacedRows: 0, patches: [] };
    const table = resolvedTable(connectionId, database, tableName);
    const rows = getOrInitRows(connectionId, database, tableName);
    const columns = (table?.columns || []).map(columnName);
    const identityKeys = primaryKeyColumns(table).length ? primaryKeyColumns(table) : columns;
    const dryRun = Boolean(request.dryRun);
    const caseSensitive = Boolean(request.caseSensitive);
    let replacedCells = 0;
    const patches = [];
    rows.forEach((row) => {
      const changes = [];
      for (const column of columns) {
        if (row[column] == null) continue;
        const next = replaceSearchText(row[column], query, request.replacement, { caseSensitive });
        if (!next.replacedCount) continue;
        replacedCells += next.replacedCount;
        changes.push({ columnName: column, oldValue: String(row[column]), newValue: next.text });
      }
      if (!changes.length) return;
      const rowIdentity = Object.fromEntries(
        identityKeys.map((key) => [key, row[key] == null ? null : String(row[key])]),
      );
      patches.push({ rowIdentity, changes });
      if (!dryRun) {
        for (const change of changes) row[change.columnName] = change.newValue;
      }
    });
    return {
      replacedCells,
      replacedRows: patches.length,
      patches: dryRun ? [] : patches,
    };
  }
  if (command === "find_in_table") {
    const { tableName, connectionId, database, readOnly } = requireMockSessionContext(payload.request?.sessionId);
    rejectMockMongo(connectionId, "整表查找，请使用表格上方的搜索框");
    if (readOnly) throw new Error("ClickHouse 连接的整表查找暂不可用，请使用表格上方的搜索框");
    const request = payload.request || {};
    const query = String(request.query ?? "");
    if (!query) throw new Error("查找内容不能为空");
    const table = resolvedTable(connectionId, database, tableName);
    const rows = getOrInitRows(connectionId, database, tableName);
    const columns = (table?.columns || []).map(columnName);
    const identityKeys = primaryKeyColumns(table).length ? primaryKeyColumns(table) : columns;
    const caseSensitive = Boolean(request.caseSensitive);
    const limit = Math.max(1, Math.min(2000, Number(request.limit) || 500));
    const matches = [];
    let totalCells = 0;
    let totalOccurrences = 0;
    let truncated = false;
    for (const row of rows) {
      for (const column of columns) {
        if (row[column] == null) continue;
        const next = replaceSearchText(row[column], query, "", { caseSensitive });
        if (!next.replacedCount) continue;
        totalCells += 1;
        totalOccurrences += next.replacedCount;
        if (matches.length < limit) {
          const rowIdentity = Object.fromEntries(
            identityKeys.map((key) => [key, row[key] == null ? null : String(row[key])]),
          );
          matches.push({
            rowIdentity,
            columnName: column,
            value: String(row[column]),
            occurrences: next.replacedCount,
          });
        } else {
          truncated = true;
        }
      }
    }
    return { matches, totalCells, totalOccurrences, truncated };
  }
  if (command === "insert_row") {
    const { tableName, connectionId, database, readOnly } = requireMockSessionContext(payload.request?.sessionId);
    if (readOnly) throw new Error("只读连接不能新增数据");
    const rows = getOrInitRows(connectionId, database, tableName);
    const schema = tableSchemaFor(connectionId, database);
    const table = schema.find((item) => item.table_name === tableName) || schema[0];
    const { storedRow, returnedRow, nullColumns } = materializeMockInsert(
      table,
      rows,
      payload.request?.draft || {},
    );
    if (isMockMongoConnection(connectionId) && !/^[0-9a-f]{24}$/i.test(String(storedRow._id || "").trim())) {
      storedRow._id = (++mockObjectIdSeq).toString(16).padStart(24, "0");
      returnedRow._id = storedRow._id;
    }
    if (hasPrimaryKeyConflict(table, rows, storedRow)) {
      throw new Error(PRIMARY_KEY_DUPLICATE_MESSAGE);
    }
    rows.push(storedRow);
    recordMockRowAudit({
      connectionId,
      database,
      tableName,
      operation: "INSERT",
      row: storedRow,
      table,
    });
    const rowIdentity = Object.fromEntries(
      primaryKeyColumns(table).map((name) => [name, returnedRow[name] ?? ""]),
    );
    return { affected: 1, row: returnedRow, rowIdentity, nullColumns };
  }
  if (command === "import_rows") {
    const { tableName, connectionId, database, readOnly } = mockSessionContext(payload.request?.sessionId);
    rejectMockMongo(connectionId, "导入");
    if (readOnly) throw new Error("只读连接不能导入数据");
    const previewOnly = Boolean(payload.request?.previewOnly);
    const drafts = Array.isArray(payload.request?.rows) ? payload.request.rows : [];
    if (drafts.length > 1000) throw new Error("单批导入不能超过 1000 行");
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
        if (!previewOnly) rows.push(insertDraft);
        result.inserted += 1;
        const outcome = { index, status: "inserted" };
        if (previewOnly) {
          outcome.preview = mockBatchImportPreview(
            table,
            keys,
            insertDraft,
            Object.entries(insertDraft).map(([name, value]) => [name, null, value]),
          );
        }
        result.outcomes.push(outcome);
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
      const changedEntries = updateEntries.filter(
        ([key, value]) => String(existing[key] ?? "") !== String(value ?? ""),
      );
      if (!changedEntries.length) {
        result.unchanged += 1;
        result.outcomes.push({ index, status: "unchanged" });
        return;
      }
      if (!previewOnly) Object.assign(existing, Object.fromEntries(updateEntries));
      result.updated += 1;
      const outcome = { index, status: "updated" };
      if (previewOnly) {
        outcome.preview = mockBatchImportPreview(
          table,
          keys,
          draft,
          changedEntries.map(([name, value]) => [name, existing[name] ?? null, value]),
        );
      }
      result.outcomes.push(outcome);
    });
    return result;
  }
  if (command === "replace_table_rows") {
    const { tableName, connectionId, database, readOnly } = requireMockSessionContext(payload.request?.sessionId);
    if (readOnly) throw new Error("只读连接不能导入数据");
    const previewOnly = Boolean(payload.request?.previewOnly);
    const rows = getOrInitRows(connectionId, database, tableName);
    const table = resolvedTable(connectionId, database, tableName);
    const keys = primaryKeyColumns(table);
    if (!keys.length) throw new Error("目标表没有主键，无法安全执行整表覆盖");
    const incoming = Array.isArray(payload.request?.rows) ? payload.request.rows : [];
    const requestedMappedColumns = Array.isArray(payload.request?.mappedColumns)
      ? payload.request.mappedColumns
      : [];
    const mappedColumns = new Set((requestedMappedColumns.length
      ? requestedMappedColumns
      : incoming.flatMap((draft) => Object.keys(draft || {})))
      .map((name) => String(name || "").trim())
      .filter(Boolean));
    const prepared = [];
    incoming.forEach((draft, index) => {
      const sanitized = Object.fromEntries((table?.columns || [])
        .filter((column) => !column.is_generated && !column.isGenerated)
        .map((column) => columnName(column))
        .filter((name) => name && Object.hasOwn(draft, name))
        .map((name) => [name, draft[name]]));
      const validation = validateRowDraft({ table, rows: prepared, draft: sanitized });
      if (!validation.valid) {
        throw new Error(`Excel 第 ${index + 2} 行：${validation.errors[0]?.message || "数据校验失败"}`);
      }
      if (!primaryKeySignature(sanitized, keys)) {
        throw new Error(`Excel 第 ${index + 2} 行：主键不能为空`);
      }
      prepared.push(sanitized);
    });
    const currentByKey = new Map(rows.map((row) => [primaryKeySignature(row, keys), row]));
    const replacementRows = [];
    const incomingOutcomes = [];
    const rowStatuses = [];
    const result = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
    prepared.forEach((draft, index) => {
      const signature = primaryKeySignature(draft, keys);
      const current = currentByKey.get(signature);
      if (!current) {
        const replacement = Object.fromEntries((table?.columns || [])
          .filter((column) => !column.is_generated && !column.isGenerated)
          .map((column) => {
            const name = columnName(column);
            return [name, Object.hasOwn(draft, name) ? draft[name] : mockDefaultRowValue(column)];
          }));
        replacementRows.push(replacement);
        result.inserted += 1;
        rowStatuses.push("inserted");
        if (previewOnly) {
          incomingOutcomes.push({
            status: "inserted",
            index,
            preview: {
              ...mockBatchImportPreview(
                table,
                keys,
                draft,
                Object.entries(draft).map(([name, value]) => [name, null, value]),
              ),
              after: { ...draft },
            },
          });
        }
        return;
      }
      currentByKey.delete(signature);
      const updateEntries = (table?.columns || [])
        .filter((column) => !column.is_primary_key && !column.isPrimaryKey && !column.is_generated && !column.isGenerated)
        .map((column) => columnName(column))
        .filter((name) => name && mappedColumns.has(name))
        .map((name) => {
          const column = (table?.columns || []).find((item) => columnName(item) === name);
          return [name, Object.hasOwn(draft, name) ? draft[name] : mockDefaultRowValue(column)];
        });
      const changedEntries = updateEntries.filter(
        ([name, value]) => String(current[name] ?? "") !== String(value ?? ""),
      );
      replacementRows.push({ ...current, ...Object.fromEntries(updateEntries) });
      if (changedEntries.length) {
        result.updated += 1;
        rowStatuses.push("updated");
        if (previewOnly) {
          incomingOutcomes.push({
            status: "updated",
            index,
            preview: {
              ...mockBatchImportPreview(
                table,
                keys,
                draft,
                changedEntries.map(([name, value]) => [name, current[name] ?? null, value]),
              ),
              before: { ...current },
              after: { ...current, ...Object.fromEntries(updateEntries) },
            },
          });
        }
      } else {
        result.unchanged += 1;
        rowStatuses.push("unchanged");
      }
    });
    result.deleted = currentByKey.size;
    if (previewOnly) {
      const deletedOutcomes = [...currentByKey.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, row]) => ({
          status: "deleted",
          preview: {
            identity: Object.fromEntries(keys.map((key) => [key, String(row[key] ?? "")])),
            changes: [],
            before: { ...row },
          },
        }));
      // 每类状态各自封顶，删除明细不再挤占新增/修改的展示额度。
      result.outcomes = [...deletedOutcomes.slice(0, 2000), ...incomingOutcomes.slice(0, 2000)];
      result.rowStatuses = rowStatuses;
      return result;
    }
    recordMockTableDiff(mockAuditLogState, { connectionId, database, tableName }, table, rows, replacementRows, "import");
    rows.length = 0;
    rows.push(...replacementRows);
    return result;
  }
  if (command === "delete_rows") {
    const { tableName, connectionId, database, readOnly } = requireMockSessionContext(payload.request?.sessionId);
    if (readOnly) throw new Error("只读连接不能删除数据");
    const rows = getOrInitRows(connectionId, database, tableName);
    const identities = payload.request?.rowIdentities || [];
    const before = rows.length;
    const identityMatch = (row) => identities.some((identity) =>
      Object.entries(identity).every(([key, value]) => (
        value == null ? row[key] == null : String(row[key]) === String(value)
      )));
    const deletedRows = rows.filter(identityMatch).map((row) => ({ ...row }));
    const remaining = rows.filter((row) => !identityMatch(row));
    rows.length = 0;
    rows.push(...remaining);
    const table = resolvedTable(connectionId, database, tableName);
    deletedRows.forEach((row) => recordMockRowAudit({
      connectionId,
      database,
      tableName,
      operation: "DELETE",
      row,
      table,
    }));
    return { affected: before - rows.length };
  }
  if (command === "preview_database_sync") {
    const req = payload.request || payload;
    const connectionId = req.sourceConnectionId || req.source_connection_id || req.connectionId || req.connection_id || "demo";
    rejectMockMongo(connectionId, "覆盖同步");
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
  if (mockConfigRelations.handles(command)) {
    return mockConfigRelations.invoke(command, payload);
  }
  if (mockReleaseTools.handles(command)) {
    return mockReleaseTools.invoke(command, payload);
  }
  if (command === "table_transfer_pick_script" || command === "table_transfer_pick_project_dir") {
    // 浏览器预览没有原生文件对话框，按用户取消处理。
    return null;
  }
  if (command === "table_transfer_discover_paths") {
    const list = Array.isArray(payload?.templates) ? payload.templates : [];
    const defaults = {
      "juesheng-1": {
        scriptPath: "D:\\Versions\\tools\\生成配置\\1-生成全部配置-客户端\\1.生成全部配置.bat",
        projectRoot: "D:\\Versions\\nzg",
      },
      "juesheng-2": {
        scriptPath: "D:\\client\\tool\\生成配置\\1-生成全部配置-客户端\\4区生成全部配置.bat",
        projectRoot: "D:\\client\\jswz",
      },
    };
    return list.map((item) => {
      const id = String(item?.id || "");
      const preset = defaults[id] || { scriptPath: "", projectRoot: "" };
      return {
        id,
        scriptPath: String(item?.scriptPath || "").trim() || preset.scriptPath,
        projectRoot: String(item?.projectRoot || "").trim() || preset.projectRoot,
      };
    });
  }
  if (command === "table_transfer_run") {
    const req = payload?.request || payload || {};
    const jobId = String(req.jobId || "");
    const emitTransfer = (stage, status, message, line = null) =>
      emitMockEvent("table-transfer-progress", { jobId, stage, status, message, line });
    emitTransfer("script", "running", "开始运行转表脚本", "[mock] 浏览器预览模式：模拟转表脚本运行");
    emitTransfer("locate", "running", "找到产出目录", "[mock] D:\\mock\\生成配置\\2026-01-01 12-00-00");
    emitTransfer("svn", "running", "SVN 更新", "[mock] svn update --accept theirs-full");
    emitTransfer("copy", "running", "拷贝进工程", "[mock] 已复制 0 个文件");
    emitTransfer("done", "succeeded", "转表完成：已覆盖 0 个文件");
    return {
      outputDir: "D:\\mock\\生成配置\\2026-01-01 12-00-00",
      updatedDirs: [],
      copiedFiles: 0,
    };
  }
  if (command === "table_transfer_cancel") {
    return false;
  }
  if (command === "sync_database_overwrite") {
    const req = payload.request || payload;
    const connectionId = req.connectionId || req.connection_id || "demo";
    if (isMockConnectionReadOnly(connectionId)) throw new Error("只读连接不能执行覆盖同步");
    const plan = mockSyncPlan(req);
    const jobId = req.jobId || req.job_id || "";
    const totalTables = plan.copyTables.length;
    emitMockEvent("database-sync-progress", {
      jobId,
      stage: "copyData",
      status: "running",
      currentTable: null,
      completedTables: 0,
      totalTables,
      completedRows: 0,
      totalRows: null,
      message: "正在覆盖同步浏览器演示数据",
    });
    applyMockSyncPlan(plan);
    const copiedRows = plan.copyTables.reduce((sum, table) => sum + getOrInitRows(plan.connectionId, plan.targetDatabase, table).length, 0);
    const message = plan.excludedTables.length
      ? "覆盖同步完成，一致性校验通过：所有未排除表与源库相同"
      : "覆盖同步完成，一致性校验通过：目标库与源库的基础表结构和数据完全相同";
    emitMockEvent("database-sync-progress", {
      jobId,
      stage: "verify",
      status: "running",
      currentTable: null,
      completedTables: totalTables,
      totalTables,
      completedRows: copiedRows,
      totalRows: copiedRows,
      message: "逐表一致性校验通过",
    });
    emitMockEvent("database-sync-progress", {
      jobId,
      stage: "completed",
      status: "succeeded",
      currentTable: null,
      completedTables: totalTables,
      totalTables,
      completedRows: copiedRows,
      totalRows: copiedRows,
      message,
    });
    return {
      status: "succeeded",
      jobId,
      sourceDatabase: plan.sourceDatabase,
      targetDatabase: plan.targetDatabase,
      copiedTables: plan.copyTables,
      preservedTables: plan.preservedTables,
      copiedRows,
      droppedTables: plan.removedTables,
      backupSnapshotPath: null,
      message,
      warnings: plan.warnings,
    };
  }
  if (command === "cancel_database_sync") {
    return { cancelled: false };
  }
  if (command === "copy_tables") {
    const req = payload.request || payload;
    const tableNames = req.tableNames || req.table_names || [];
    const sourceDatabase = req.sourceDatabase || req.source_database || "";
    const targetDatabase = req.targetDatabase || req.target_database || "";
    const targetConnectionId = req.targetConnectionId || req.target_connection_id || req.connectionId || "demo";
    const sourceConnectionId = req.sourceConnectionId || req.source_connection_id || req.connectionId || req.connection_id || "demo";
    rejectMockMongo(sourceConnectionId, "表复制");
    rejectMockMongo(targetConnectionId, "表复制");
    if (isMockConnectionReadOnly(sourceConnectionId) || isMockConnectionReadOnly(targetConnectionId)) {
      throw new Error("只读连接不能发送表");
    }
    const copied = [];
    const overwrite = String(req.mode || "copy").toLowerCase() === "overwrite";
    const schemaKey = `${targetConnectionId}/${targetDatabase}`;
    const targetSchema = [
      ...(mockDatabaseSchemas[schemaKey] || resolveMockSchema(targetConnectionId, targetDatabase).map((t) => t.table_name)),
    ];
    for (const tableName of tableNames) {
      // 覆盖模式：移除目标库同名表，用源表完全替换；否则重名自动添加 _copy 后缀。
      const existingIndex = targetSchema.findIndex(
        (name) => String(name).toLowerCase() === String(tableName).toLowerCase(),
      );
      const targetName = overwrite && existingIndex >= 0
        ? targetSchema[existingIndex]
        : resolveMockCopyTableName(targetSchema, tableName);
      if (overwrite && existingIndex >= 0) targetSchema.splice(existingIndex, 1);
      const sourceTable = resolvedTable(sourceConnectionId, sourceDatabase, tableName);
      const targetTable = cloneTable(sourceTable);
      targetTable.table_name = targetName;
      targetTable.tableName = targetName;
      schemaOverrides.set(sourceKey(targetConnectionId, targetDatabase, targetName), targetTable);
      targetSchema.push(targetName);
      mockDatabaseSchemas[schemaKey] = [...targetSchema];
      const targetRows = getOrInitRows(targetConnectionId, targetDatabase, targetName);
      const sourceRows = getOrInitRows(sourceConnectionId, sourceDatabase, tableName);
      targetRows.length = 0;
      targetRows.push(...sourceRows.map((row) => ({ ...row })));
      copied.push({ originalName: tableName, targetName, rowCount: sourceRows.length });
    }
    return { status: "succeeded", copied, warnings: [] };
  }
  if (command === "drop_tables") {
    const req = payload.request || payload;
    const connectionId = req.connectionId || req.connection_id || "demo";
    rejectMockMongo(connectionId, "删除表");
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
    rejectMockMongo(connectionId, "重命名表");
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
    const connection = upsertMockConnection(payload.url, payload.kind);
    // Mirror the real backend: the returned list equals list_databases.
    return [...(mockConnectionDatabases[connection.id] || ["game_db"])];
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
  if (command === "agent_open_artifact" || command === "agent_reveal_artifact" || command === "reveal_local_path") {
    return true;
  }
  if (command === "agent_runtime_status" || command === "agent_runtime_check" || command === "agent_runtime_install") {
    return {
      state: "ready",
      ready: true,
      installedVersion: 1,
      availableVersion: 1,
      size: 0,
      updateAvailable: false,
      needsDirectory: false,
      minAppVersion: null,
      message: "浏览器演示模式中的 AI 组件已就绪",
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
    const isArtifactQuestion = /生成|创建|导出|做一份|制作/i.test(payload.text || "")
      && /xlsx|excel|csv|json|markdown|md|html|sql|文本|文件|表格|报表/i.test(payload.text || "");
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

      if (isArtifactQuestion) {
        const reqId = `artifact-${Date.now()}`;
        const spreadsheet = /xlsx|excel|表格|报表/i.test(payload.text || "");
        const format = spreadsheet
          ? "xlsx"
          : (/csv|json|html|sql|markdown|md/i.exec(payload.text || "")?.[0]?.toLowerCase() || "txt").replace("markdown", "md");
        const fileName = spreadsheet ? "agent-report.xlsx" : `agent-output.${format}`;
        const toolName = spreadsheet
          ? "mcp__dbscout-artifacts__create_spreadsheet"
          : "mcp__dbscout-artifacts__create_text_file";
        const input = spreadsheet
          ? { fileName, sheets: [{ name: "数据", headers: ["字段", "值"], rows: [["示例", 1]] }] }
          : { fileName, format, content: format === "json" ? "{\"status\":\"ok\"}" : "Agent 生成内容" };
        pendingMockAgentRequests.set(reqId, {
          kind: "artifact",
          toolName,
          toolUseId: `artifact-tool-${Date.now()}`,
          fileName,
          format,
          input,
        });
        const request = pendingMockAgentRequests.get(reqId);
        emitMockEvent("agent-event", {
          ev: "tool_use",
          id: request.toolUseId,
          name: toolName,
          input,
        });
        emitMockEvent("agent-event", {
          ev: "approval_request",
          req_id: reqId,
          toolName,
          input,
        });
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
        if (request?.kind === "artifact") {
          const artifact = {
            artifactVersion: 1,
            fileName: request.fileName,
            path: `C:/Users/Demo/Documents/DB Scout Workbench/Agent Files/${request.fileName}`,
            directory: "C:/Users/Demo/Documents/DB Scout Workbench/Agent Files",
            kind: request.format === "xlsx" ? "spreadsheet" : "text",
            format: request.format,
            sizeBytes: request.format === "xlsx" ? 8640 : 128,
            sheetCount: request.format === "xlsx" ? 1 : undefined,
            rowCount: request.format === "xlsx" ? 1 : undefined,
            createdAt: new Date().toISOString(),
          };
          emitMockEvent("agent-event", { ev: "artifact_created", artifact });
          emitMockEvent("agent-event", {
            ev: "tool_result",
            id: request.toolUseId,
            summary: `已生成 ${request.fileName}`,
            result: artifact,
            isError: false,
          });
          emitMockEvent("agent-event", {
            ev: "text_delta",
            text: `文件已生成：${request.fileName}\n${artifact.path}`,
          });
          emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0, isError: false, text: "" });
          return;
        }
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
  if (["list_audit_tables", "list_audit_operations", "list_audit_operation_details", "preview_audit_table_restore", "restore_audit_table"].includes(command)) {
    return mockAuditHistory(command, payload.request || {});
  }
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
  if (command === "inspect_snapshot_file") {
    // Browser dev can't open a native file picker; simulate picking a
    // DB Scout snapshot so the import confirmation panel is exercisable.
    return {
      sourcePath: "mock://external/20260618-073000.sql",
      fileName: "20260618-073000.sql",
      sizeBytes: 4096,
      originConnectionId: "demo",
      originDatabase: "game_db",
      originTs: "20260618-073000",
    };
  }
  if (command === "import_snapshot") {
    const req = payload.request || {};
    const entry = {
      path: `mock://backup/snapshots/${req.connectionId}/${req.database}/imported-${Date.now()}.sql`,
      connectionId: req.connectionId,
      database: req.database,
      ts: new Date().toISOString(),
      sizeBytes: 4096,
      tableCount: 0,
      manifest: null,
    };
    mockSnapshotState.unshift(entry);
    return entry;
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

function recordMockRowAudit({ connectionId, database, tableName, operation, row, table }) {
  const keys = primaryKeyColumns(table);
  const rowIdentity = Object.fromEntries(keys.map((key) => [key, String(row?.[key] ?? "")]));
  const id = Math.max(0, ...mockAuditLogState.map((item) => item.id)) + 1;
  mockAuditLogState.unshift({
    id,
    ts: new Date().toISOString(),
    connectionId,
    database,
    tableName,
    operation,
    rowIdentity,
    columnName: null,
    oldValue: operation === "DELETE" ? JSON.stringify(row) : null,
    newValue: operation === "INSERT" ? JSON.stringify(row) : null,
    forwardSql: null,
    inverseSql: null,
    rollbackStrategy: keys.length ? "auto" : "manual",
    source: "grid",
    status: "committed",
    isRollback: false,
    rollbackOf: null,
    actor: "演示用户",
    clientId: `mock-cid-${id}`,
    synced: false,
  });
}

function recordMockDdlAudit({ connectionId, database, tableName, preview }) {
  const id = Math.max(0, ...mockAuditLogState.map((item) => item.id)) + 1;
  const descriptions = Array.isArray(preview?.humanDescriptions)
    ? preview.humanDescriptions
    : [];
  mockAuditLogState.unshift({
    id,
    ts: new Date().toISOString(),
    connectionId,
    database,
    tableName,
    operation: "DDL",
    rowIdentity: null,
    columnName: null,
    oldValue: null,
    newValue: JSON.stringify(descriptions),
    forwardSql: (preview?.statements || []).join(";\n"),
    inverseSql: null,
    rollbackStrategy: "ddl",
    source: "ddl",
    status: "committed",
    isRollback: false,
    rollbackOf: null,
    notes: "结构变更，需通过快照还原",
    actor: "演示用户",
    clientId: `mock-cid-${id}`,
    synced: false,
  });
}

const mockSnapshotState = [
  { path: "mock://backup/snapshots/demo/game_db/20260620-090000.sql", connectionId: "demo", database: "game_db", ts: "20260620-090000", sizeBytes: 8192, tableCount: 12, manifest: { tables: [{ name: "player", rows: 128 }] } },
  { path: "mock://backup/snapshots/demo/game_db/20260619-090000.sql", connectionId: "demo", database: "game_db", ts: "20260619-090000", sizeBytes: 7680, tableCount: 12, manifest: { tables: [{ name: "player", rows: 120 }] } },
];

function mockSnapshots(request) {
  let rows = mockSnapshotState.slice();
  if (request.connectionId) rows = rows.filter((row) => row.connectionId === request.connectionId);
  if (request.database) rows = rows.filter((row) => row.database === request.database);
  return rows;
}

const mockAuditHistory = createMockAuditHistory({
  logs: mockAuditLogState,
  getRows: (r) => getOrInitRows(r.connectionId, r.database, r.tableName),
  getTable: (r) => resolvedTable(r.connectionId, r.database, r.tableName),
  onRestored: (r) => emitMockEvent("backup-job", { kind: "restore", connectionId: r.connectionId, database: r.database, table: r.tableName }),
});
