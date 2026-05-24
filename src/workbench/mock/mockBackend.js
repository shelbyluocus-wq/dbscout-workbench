import { mockSchema } from "./mockSchema.js";
import { mockRows } from "./mockRows.js";
import { columnName } from "../utils/normalize.js";
import { DEFAULT_PAGE_SIZE } from "../constants.js";

let mockSessionSeq = 0;
const mockSessions = new Map();

function mockPageFor(tableName, sessionId, request = {}) {
  const schema = mockSchema.find((table) => table.table_name === tableName) || mockSchema[0];
  const page = Math.max(1, Math.floor(Number(request.page) || 1));
  const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(request.pageSize || request.page_size) || DEFAULT_PAGE_SIZE)));
  const filterQuery = String(request.filter?.query || "").trim().toLowerCase();
  const filterMode = request.filter?.mode || "fuzzy";
  let rows = [...(mockRows[schema.table_name] || [])];
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
    tableName: schema.table_name,
    tableComment: schema.table_comment,
    columns: schema.columns,
    primaryKeys: schema.columns.filter((column) => column.is_primary_key).map(columnName),
    rows: rows.slice(start, start + pageSize).map((row) => ({ ...row })),
    totalRows: rows.length,
    page,
    pageSize,
  };
}

export async function mockWorkbenchInvoke(command, payload = {}) {
  if (command === "list_connections") {
    return [{ id: "demo", label: "Demo GameDB", host: "demo", port: 3306, username: "root", database: "game_db", connected: true }];
  }
  if (command === "list_databases") return ["game_db"];
  if (command === "select_database") return { tableCount: mockSchema.length, columnCount: mockSchema.reduce((sum, table) => sum + table.columns.length, 0) };
  if (command === "list_tables") return mockSchema.map(({ table_name, table_comment }) => ({ table_name, table_comment }));
  if (command === "get_table_schema") return mockSchema.find((table) => table.table_name === payload.tableName) || mockSchema[0];
  if (command === "open_table_session") {
    const sessionId = `mock-session-${++mockSessionSeq}`;
    mockSessions.set(sessionId, payload.tableName);
    return mockPageFor(payload.tableName, sessionId, payload.options || {});
  }
  if (command === "fetch_table_page") {
    const tableName = mockSessions.get(payload.sessionId) || "game_db";
    return mockPageFor(tableName, payload.sessionId, payload.request || {});
  }
  if (command === "search_data") {
    const query = String(payload.request?.query || "").toLowerCase();
    if (!query) return [];
    const results = [];
    for (const table of mockSchema) {
      const rows = mockRows[table.table_name] || [];
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
    const tableName = mockSessions.get(payload.request?.sessionId) || "game_db";
    const rows = mockRows[tableName] || [];
    const identity = payload.request?.rowIdentity || {};
    const row = rows.find((candidate) => Object.entries(identity).every(([key, value]) => String(candidate[key] ?? "") === String(value)));
    if (row) row[payload.request.columnName] = payload.request.newValue;
    return { updated: Boolean(row), conflict: !row, value: payload.request?.newValue || "" };
  }
  if (command === "insert_row") {
    const tableName = mockSessions.get(payload.request?.sessionId) || "game_db";
    const rows = mockRows[tableName] || [];
    rows.push({ ...(payload.request?.draft || {}) });
    return { affected: 1 };
  }
  if (command === "delete_rows") {
    const tableName = mockSessions.get(payload.request?.sessionId) || "game_db";
    const rows = mockRows[tableName] || [];
    const identities = payload.request?.rowIdentities || [];
    const before = rows.length;
    mockRows[tableName] = rows.filter(
      (row) => !identities.some((identity) =>
        Object.entries(identity).every(([key, value]) => String(row[key] ?? "") === String(value)),
      ),
    );
    return { affected: before - mockRows[tableName].length };
  }
  if (command === "add_connection") {
    return ["game_db"];
  }
  return null;
}
