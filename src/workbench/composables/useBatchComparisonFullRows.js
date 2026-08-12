import { onBeforeUnmount, reactive, watch } from "vue";
import { invokeWorkbench as defaultInvokeWorkbench } from "../utils/tauriBridge.js";
import { isSessionInvalidError } from "./useTableSession.js";

export const FULL_COMPARISON_PAGE_SIZE = 500;

function tableKey(table) {
  return String(table?.sheetName || table?.tableName || "");
}

function fullComparisonTotal(table) {
  return ["inserted", "updated", "deleted", "unchanged"]
    .reduce((sum, status) => sum + Math.max(0, Number(table?.[status]) || 0), 0);
}

function restoredPageRows(page) {
  const rows = Array.isArray(page?.rows) ? page.rows : [];
  const nullCells = Array.isArray(page?.nullCells) ? page.nullCells : page?.null_cells;
  if (!Array.isArray(nullCells) || !nullCells.length) return rows;
  return rows.map((row, index) => {
    const columns = nullCells[index];
    if (!Array.isArray(columns) || !columns.length) return row;
    const restored = { ...row };
    for (const column of columns) restored[column] = null;
    return restored;
  });
}

export function comparisonIdentityKey(primaryKeys, row) {
  return JSON.stringify((primaryKeys || []).map((key) => [key, String(row?.[key] ?? "").trim()]));
}

function rowIdentity(primaryKeys, row) {
  return Object.fromEntries((primaryKeys || []).map((key) => [key, String(row?.[key] ?? "")]));
}

function changedCells(columns, before, after) {
  return (columns || []).flatMap((column) => {
    const name = typeof column === "string" ? column : column?.name;
    if (!name || (typeof column === "object" && column?.primaryKey)) return [];
    const oldValue = before?.[name] ?? null;
    const newValue = after?.[name] ?? null;
    if (oldValue === newValue) return [];
    return [{ columnName: name, before: oldValue, after: newValue }];
  });
}

function replacementDefault(column) {
  const mode = String(column?.defaultMode || "none");
  if (mode === "value") return { available: true, value: column?.defaultValue ?? "" };
  if (mode === "null" || (mode === "none" && column?.nullable)) {
    return { available: true, value: null };
  }
  return { available: false, value: undefined };
}

function effectiveAfterRow(table, source, before) {
  if (!source) return null;
  const draft = source.draft || {};
  const after = { ...(before || {}), ...draft };
  const mappedColumns = new Set(table?.fullComparison?.mappedColumns || []);
  for (const column of table?.columns || []) {
    if (!column?.name || column.generated || Object.hasOwn(draft, column.name)) continue;
    const needsDefault = before ? mappedColumns.has(column.name) : true;
    if (!needsDefault) continue;
    const fallback = replacementDefault(column);
    if (fallback.available) after[column.name] = fallback.value;
  }
  return after;
}

function comparisonRow(table, source, before, status) {
  const metadata = table?.fullComparison || {};
  const after = effectiveAfterRow(table, source, before);
  const identitySource = before || after || source?.draft || {};
  const identity = rowIdentity(metadata.primaryKeys, identitySource);
  const identityToken = comparisonIdentityKey(metadata.primaryKeys, identitySource);
  return {
    id: `${tableKey(table)}\x1fdatabase:${identityToken}\x1f${status}`,
    sheetName: table?.sheetName || "",
    tableName: table?.tableName || metadata.tableName || "",
    row: source?.row ?? null,
    status,
    identity,
    changes: status === "updated" ? changedCells(table?.columns, before, after) : [],
    before,
    after,
    error: "",
  };
}

export function createFullComparisonCursor(table) {
  const metadata = table?.fullComparison || {};
  const primaryKeys = Array.isArray(metadata.primaryKeys) ? metadata.primaryKeys : [];
  const sourceByIdentity = new Map();
  const insertedSources = [];
  for (const source of Array.isArray(metadata.sourceRows) ? metadata.sourceRows : []) {
    if (source?.status === "inserted") {
      insertedSources.push(source);
      continue;
    }
    sourceByIdentity.set(comparisonIdentityKey(primaryKeys, source?.draft || {}), source);
  }
  return {
    table,
    primaryKeys,
    sourceByIdentity,
    insertedSources,
    insertedOffset: 0,
  };
}

export function consumeFullComparisonDatabaseRows(cursor, databaseRows) {
  const rows = [];
  for (const before of Array.isArray(databaseRows) ? databaseRows : []) {
    const key = comparisonIdentityKey(cursor.primaryKeys, before);
    const source = cursor.sourceByIdentity.get(key) || null;
    if (source) cursor.sourceByIdentity.delete(key);
    rows.push(comparisonRow(cursor.table, source, before, source?.status || "deleted"));
  }
  return rows;
}

export function consumeFullComparisonInsertedRows(cursor, limit = FULL_COMPARISON_PAGE_SIZE) {
  const end = Math.min(cursor.insertedSources.length, cursor.insertedOffset + Math.max(0, Number(limit) || 0));
  const sources = cursor.insertedSources.slice(cursor.insertedOffset, end);
  cursor.insertedOffset = end;
  return sources.map((source) => comparisonRow(cursor.table, source, null, "inserted"));
}

export async function loadFullComparisonToCompletion(
  table,
  loadMore,
  stateFor,
  shouldContinue = () => true,
) {
  const state = stateFor(table);
  while (!state.complete && !state.error && shouldContinue()) {
    const previousRowCount = state.rows.length;
    const previousOffset = state.databaseOffset;
    await loadMore(table);
    if (
      !state.complete
      && !state.error
      && state.rows.length === previousRowCount
      && state.databaseOffset === previousOffset
    ) break;
  }
  return state;
}

export function useBatchComparisonFullRows(comparisonSource, invokeWorkbench = defaultInvokeWorkbench) {
  const states = reactive({});
  const records = new Map();

  function closeRecordSession(record) {
    const sessionId = record?.sessionId;
    record.sessionId = "";
    if (sessionId) invokeWorkbench("close_table_session", { sessionId }).catch(() => {});
  }

  function disposeRecords() {
    for (const record of records.values()) {
      record.cancelled = true;
      closeRecordSession(record);
    }
    records.clear();
    for (const key of Object.keys(states)) delete states[key];
  }

  function ensureRecord(table) {
    const key = tableKey(table);
    let record = records.get(key);
    if (record) return record;
    const total = fullComparisonTotal(table);
    const state = reactive({
      rows: [],
      loading: false,
      complete: total === 0,
      error: "",
      total,
      databaseOffset: 0,
    });
    record = {
      table,
      state,
      cursor: createFullComparisonCursor(table),
      sessionId: "",
      databaseComplete: false,
      cancelled: false,
      pending: null,
    };
    records.set(key, record);
    states[key] = state;
    return record;
  }

  function stateFor(table) {
    return ensureRecord(table).state;
  }

  async function fetchDatabaseChunk(record) {
    const metadata = record.table?.fullComparison || {};
    const request = {
      offset: record.state.databaseOffset,
      pageSize: FULL_COMPARISON_PAGE_SIZE,
      includeTotal: false,
    };
    if (!record.sessionId) {
      const page = await invokeWorkbench("open_table_session", {
        connectionId: metadata.connectionId,
        database: metadata.database,
        tableName: metadata.tableName || record.table?.tableName,
        options: request,
      });
      record.sessionId = String(page?.sessionId || page?.session_id || "");
      return page;
    }
    return invokeWorkbench("fetch_table_page", { sessionId: record.sessionId, request });
  }

  async function loadRecord(record) {
    const { state } = record;
    const metadata = record.table?.fullComparison;
    if (!metadata?.tableName || !Array.isArray(metadata.primaryKeys) || !metadata.primaryKeys.length) {
      state.error = "缺少完整对比所需的表信息，请重新对比后再试";
      return state;
    }
    state.loading = true;
    state.error = "";
    try {
      let remaining = FULL_COMPARISON_PAGE_SIZE;
      if (!record.databaseComplete) {
        let page;
        try {
          page = await fetchDatabaseChunk(record);
        } catch (error) {
          if (!isSessionInvalidError(error)) throw error;
          closeRecordSession(record);
          page = await fetchDatabaseChunk(record);
        }
        if (record.cancelled) return state;
        const databaseRows = restoredPageRows(page);
        state.rows.push(...consumeFullComparisonDatabaseRows(record.cursor, databaseRows));
        state.databaseOffset += databaseRows.length;
        remaining = Math.max(0, remaining - databaseRows.length);
        const hasMore = Boolean(page?.hasMore ?? page?.has_more);
        if (!hasMore || databaseRows.length === 0) {
          record.databaseComplete = true;
          closeRecordSession(record);
        }
      }
      if (record.databaseComplete && remaining > 0) {
        state.rows.push(...consumeFullComparisonInsertedRows(record.cursor, remaining));
      }
      state.complete = record.databaseComplete
        && record.cursor.insertedOffset >= record.cursor.insertedSources.length;
      return state;
    } catch (error) {
      state.error = String(error?.message || error || "读取完整对比失败");
      closeRecordSession(record);
      return state;
    } finally {
      state.loading = false;
    }
  }

  function loadMore(table) {
    const record = ensureRecord(table);
    if (record.state.complete) return Promise.resolve(record.state);
    if (record.pending) return record.pending;
    const settled = loadRecord(record).finally(() => {
      if (record.pending === settled) record.pending = null;
    });
    record.pending = settled;
    return settled;
  }

  watch(
    () => comparisonSource()?.runId,
    disposeRecords,
  );
  onBeforeUnmount(disposeRecords);

  return { loadMore, stateFor };
}
