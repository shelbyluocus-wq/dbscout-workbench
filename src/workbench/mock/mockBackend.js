import { resolveMockSchema } from "./mockSchema.js";
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

function mockPageFor(tableName, sessionId, connectionId, database, request = {}) {
  const schema = resolveMockSchema(connectionId, database);
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
  if (command === "list_connections") return mockConnections.map((connection) => ({ ...connection }));
  if (command === "list_databases") {
    const { connectionId } = resolveContext(payload);
    return mockConnectionDatabases[connectionId] || ["game_db"];
  }
  if (command === "select_database") {
    const { connectionId, database } = resolveContext(payload);
    const schema = resolveMockSchema(connectionId, database);
    return { tableCount: schema.length, columnCount: schema.reduce((sum, table) => sum + table.columns.length, 0) };
  }
  if (command === "list_tables") {
    const { connectionId, database } = resolveContext(payload);
    const schema = resolveMockSchema(connectionId, database);
    return schema.map(({ table_name, table_comment }) => ({ table_name, table_comment }));
  }
  if (command === "get_table_schema") {
    const { connectionId, database } = resolveContext(payload);
    const schema = resolveMockSchema(connectionId, database);
    return schema.find((table) => table.table_name === payload.tableName) || schema[0];
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
  if (command === "search_data") {
    const { connectionId, database } = resolveContext(payload);
    const query = String(payload.request?.query || "").toLowerCase();
    if (!query) return [];
    const schema = resolveMockSchema(connectionId, database);
    const results = [];
    for (const table of schema) {
      const rows = getOrInitRows(connectionId, database, table.table_name);
      const matches = [];
      for (const row of rows) {
        for (const col of table.columns) {
          const colName = col.column_name;
          const value = String(row[colName] ?? "");
          if (value.toLowerCase().includes(query)) {
            matches.push({ columnName: colName, value: value.length > 60 ? value.slice(0, 60) + "…" : value });
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
    const rows = getOrInitRows(connectionId, database, tableName);
    const identity = payload.request?.rowIdentity || {};
    const row = rows.find((candidate) => Object.entries(identity).every(([key, value]) => String(candidate[key] ?? "") === String(value)));
    if (row) row[payload.request.columnName] = payload.request.newValue;
    return { updated: Boolean(row), conflict: !row, value: payload.request?.newValue || "" };
  }
  if (command === "insert_row") {
    const { tableName, connectionId, database } = mockSessionContext(payload.request?.sessionId);
    const rows = getOrInitRows(connectionId, database, tableName);
    const schema = resolveMockSchema(connectionId, database);
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
  if (command === "add_connection" || command === "restore_connection") {
    upsertMockConnection(payload.url);
    return ["game_db"];
  }
  return null;
}
