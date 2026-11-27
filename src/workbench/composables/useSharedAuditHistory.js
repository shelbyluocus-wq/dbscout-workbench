import { computed, reactive, shallowRef } from "vue";
import { auditTableKey } from "./useAuditHistory.js";
import {
  DEFAULT_SESSION_GAP_MS,
  DEFAULT_SESSION_MAX_SPAN_MS,
  parseAuditTimestampMs,
} from "../utils/tableChangeHistory.js";

const PAGE_SIZE = 200;
const SCOPED_OPERATION_PAGE_SIZE = 2000;
const DETAIL_PAGE_SIZE = 50;
const BATCH_GROUP_WINDOW_MS = 2500;
const MAX_BATCH_DRAIN_PAGES = 30;
const LEGACY_PLACEHOLDER_SERVER_KEY = "mysql://configured:3306";

function realServerKey(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed || trimmed.toLowerCase() === LEGACY_PLACEHOLDER_SERVER_KEY) return "";
  return trimmed;
}

function normalizeFilterScope({ connectionId, serverScopeConnectionId, database, tableName } = {}) {
  const out = {};
  if (connectionId) out.connectionId = connectionId;
  if (serverScopeConnectionId) out.serverScopeConnectionId = serverScopeConnectionId;
  if (database) out.database = database;
  if (tableName) out.tableName = tableName;
  return out;
}

function buildSharedTableItem(row, activeServerScopeId = "") {
  const serverKey = realServerKey(row.serverKey);
  if (activeServerScopeId) {
    return {
      connectionId: activeServerScopeId,
      serverScopeConnectionId: activeServerScopeId,
      serverKey: serverKey || undefined,
      database: row.database,
      tableName: row.tableName,
      host: row.host || undefined,
    };
  }
  if (serverKey) {
    return {
      connectionId: row.connectionId || serverKey,
      serverKey,
      database: row.database,
      tableName: row.tableName,
      host: row.host || undefined,
    };
  }
  return {
    connectionId: row.connectionId,
    database: row.database,
    tableName: row.tableName,
  };
}

function sharedTableGroupKey(table) {
  if (table.serverScopeConnectionId) {
    return JSON.stringify([
      `scope:${table.serverScopeConnectionId}`,
      String(table.database || "").toLowerCase(),
      String(table.tableName || "").toLowerCase(),
    ]);
  }
  if (table.serverKey) {
    return JSON.stringify([
      `srv:${String(table.serverKey).toLowerCase()}`,
      String(table.database || "").toLowerCase(),
      String(table.tableName || "").toLowerCase(),
    ]);
  }
  return auditTableKey(table);
}

function operationRequestScope(selected) {
  if (!selected) return {};
  if (selected.serverScopeConnectionId) {
    return {
      serverScopeConnectionId: selected.serverScopeConnectionId,
      database: selected.database,
      tableName: selected.tableName,
    };
  }
  if (selected.serverKey) {
    return {
      database: selected.database,
      tableName: selected.tableName,
    };
  }
  return {
    connectionId: selected.connectionId,
    database: selected.database,
    tableName: selected.tableName,
  };
}

const entryDedupKey = (entry) => JSON.stringify([
  String(entry.database || "").toLowerCase(),
  String(entry.tableName || "").toLowerCase(),
  entry.clientId || entry.id,
]);

const uniqueEntries = (entries) => [...new Map(entries.map((entry) => [entryDedupKey(entry), entry])).values()];

function normalizeSummaryMeta(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rawActors = Array.isArray(obj.actors) ? obj.actors : [];
  const actors = rawActors
    .filter((a) => a && typeof a === "object")
    .map((a) => ({
      username: String(a.username || "").trim(),
      displayName: String(a.displayName ?? a.display_name ?? a.username ?? "").trim(),
      operationCount: Math.max(0, Number(a.operationCount ?? a.operation_count) || 0),
      entryCount: Math.max(0, Number(a.entryCount ?? a.entry_count) || 0),
    }))
    .filter((a) => a.displayName || a.username);
  return {
    actors,
    operationCount: Math.max(0, Number(obj.operationCount ?? obj.operation_count) || 0),
    entryCount: Math.max(0, Number(obj.entryCount ?? obj.entry_count) || 0),
    noNetChange: Boolean(obj.noNetChange ?? obj.no_net_change),
  };
}

function localDayKey(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function entrySummaryKind(entry) {
  return String(entry?.summaryKind ?? entry?.summary_kind ?? "").trim().toLowerCase();
}

function entrySummaryPeriod(entry) {
  return String(entry?.summaryPeriod ?? entry?.summary_period ?? "").trim();
}

function isBatchJoinable(prevEntry, nextEntry) {
  const prevOp = String(prevEntry.operationId || "").trim();
  const nextOp = String(nextEntry.operationId || "").trim();
  if (prevOp || nextOp) {
    return Boolean(prevOp && nextOp && prevOp === nextOp);
  }
  // Group batch imports and rollbacks stamped together by one workstation action;
  // keep legacy single-cell grid rows without operationId ungrouped.
  const src = String(nextEntry.source || "");
  if (src !== "import" && src !== "rollback") return false;
  if (String(prevEntry.source || "") !== src) return false;
  if (Boolean(prevEntry.isRollback) !== Boolean(nextEntry.isRollback)) return false;
  const prevUser = String(prevEntry.username || prevEntry.displayName || "").toLowerCase();
  const nextUser = String(nextEntry.username || nextEntry.displayName || "").toLowerCase();
  if (!prevUser || prevUser !== nextUser) return false;
  const prevMs = parseAuditTimestampMs(prevEntry.ts);
  const nextMs = parseAuditTimestampMs(nextEntry.ts);
  if (prevMs && nextMs) {
    return Math.abs(prevMs - nextMs) <= BATCH_GROUP_WINDOW_MS;
  }
  return prevEntry.ts === nextEntry.ts;
}

function isContinuousGridSessionJoinable(headEntry, prevEntry, nextEntry) {
  const prevOp = String(prevEntry.operationId || "").trim();
  const nextOp = String(nextEntry.operationId || "").trim();
  // Only collapse modern single-cell grid edits that carry distinct operationIds;
  // legacy rows without operationId remain ungrouped.
  if (!prevOp || !nextOp || prevOp === nextOp) return false;
  if (entrySummaryKind(prevEntry) || entrySummaryKind(nextEntry)) return false;
  if (String(prevEntry.source || "") !== "grid" || String(nextEntry.source || "") !== "grid") return false;
  if (prevEntry.isRollback || nextEntry.isRollback) return false;
  const prevKind = String(prevEntry.operation || "").toUpperCase();
  const nextKind = String(nextEntry.operation || "").toUpperCase();
  if (prevKind === "DDL" || nextKind === "DDL" || prevKind === "NOOP" || nextKind === "NOOP") return false;
  const prevUser = String(prevEntry.username || prevEntry.displayName || "").trim().toLowerCase();
  const nextUser = String(nextEntry.username || nextEntry.displayName || "").trim().toLowerCase();
  if (!prevUser || prevUser !== nextUser) return false;
  const headMs = parseAuditTimestampMs(headEntry.ts);
  const prevMs = parseAuditTimestampMs(prevEntry.ts);
  const nextMs = parseAuditTimestampMs(nextEntry.ts);
  if (!headMs || !prevMs || !nextMs) return false;
  if (localDayKey(headMs) !== localDayKey(nextMs)) return false;
  if (Math.abs(prevMs - nextMs) > DEFAULT_SESSION_GAP_MS) return false;
  if (Math.abs(headMs - nextMs) > DEFAULT_SESSION_MAX_SPAN_MS) return false;
  return true;
}

function groupSharedOperations(entries = []) {
  const groups = [];
  for (const entry of entries) {
    if (entry.status && entry.status !== "committed" && entry.status !== "rolled_back") {
      continue;
    }
    const last = groups[groups.length - 1];
    const joinedBatch = last && isBatchJoinable(last._lastEntry, entry);
    const joinedSession = !joinedBatch && last && isContinuousGridSessionJoinable(last._headEntry, last._lastEntry, entry);
    if (joinedBatch || joinedSession) {
      last.entries.push(entry);
      last.entryCount += 1;
      if (entry.operation === "INSERT") last.inserted += 1;
      else if (entry.operation === "UPDATE") last.updated += 1;
      else if (entry.operation === "DELETE") last.deleted += 1;
      const opId = String(entry.operationId || "").trim();
      if (opId) last._opIds.add(opId);
      last.startTs = entry.ts;
      last._lastEntry = entry;
      continue;
    }
    const headId = entryDedupKey(entry);
    const opId = String(entry.operationId || "").trim();
    const summaryKind = entrySummaryKind(entry);
    const summaryPeriod = entrySummaryPeriod(entry);
    const summaryMeta = normalizeSummaryMeta(entry.summaryMeta ?? entry.summary_meta);
    const opIds = new Set();
    if (opId) opIds.add(opId);
    groups.push({
      ...entry,
      id: opId ? `op:${opId}` : headId,
      summaryKind,
      summaryPeriod,
      summaryMeta,
      startTs: entry.ts,
      entryCount: 1,
      inserted: Number(entry.operation === "INSERT"),
      updated: Number(entry.operation === "UPDATE"),
      deleted: Number(entry.operation === "DELETE"),
      entry,
      entries: [entry],
      _headEntry: entry,
      _lastEntry: entry,
      _opIds: opIds,
    });
  }
  return groups.map(({ _headEntry, _lastEntry, _opIds, ...op }) => {
    const stepCount = _opIds.size;
    const isSession = Boolean(!op.summaryKind && stepCount > 1 && op.source === "grid");
    const isNoNetChange = Boolean(
      op.summaryMeta?.noNetChange
      || (op.inserted === 0 && op.updated === 0 && op.deleted === 0
        && op.entries.some((e) => String(e.operation || "").toUpperCase() === "NOOP")),
    );
    return {
      ...op,
      stepCount: isSession ? stepCount : 1,
      isSession,
      isNoNetChange,
    };
  });
}

/** Shared team audit history with cross-workstation server scoping and batch import grouping. */
export function useSharedAuditHistory({ invokeWorkbench, logs = shallowRef([]), localLogs = shallowRef([]) }) {
  const state = reactive({ tables: [], tablesMore: false, selected: null, operations: [], operationsMore: false,
    details: {}, expanded: null, error: "", notice: "", search: "", loadingTables: false,
    loadingOperations: false, loadingDetails: false, restoring: false });
  let filters = {}, tableOffset = 0, operationOffset = 0;
  let tableGeneration = 0, selectionGeneration = 0;
  let allTables = [];
  let rawOperationRows = [];
  const localByClientId = computed(() => new Map(localLogs.value.filter((entry) => entry.clientId).map((entry) => [entry.clientId, entry])));
  const showTables = () => {
    const search = state.search.trim().toLocaleLowerCase();
    state.tables = allTables.filter((table) => [table.tableName, table.database].some((value) => String(value || "").toLocaleLowerCase().includes(search)));
  };
  function resetSelection() {
    selectionGeneration++;
    state.selected = null; state.operations = []; state.operationsMore = false;
    state.details = {}; state.expanded = null; state.loadingOperations = false;
    operationOffset = 0; rawOperationRows = [];
  }
  async function loadTables(nextFilters, append = false) {
    if (state.loadingTables && append) return false;
    // Submitting the table search filters the loaded page without downloading all shared history.
    if (nextFilters === undefined && !append) { showTables(); return true; }
    if (nextFilters !== undefined) filters = normalizeFilterScope(nextFilters);
    const generation = ++tableGeneration;
    state.loadingTables = true; state.error = "";
    if (!append) { resetSelection(); tableOffset = 0; logs.value = []; allTables = []; state.tables = []; state.tablesMore = false; }
    try {
      const canQueryTableSummary = !append && Boolean(filters.serverScopeConnectionId && filters.database && !filters.tableName);
      const [rows, tableSummaries] = await Promise.all([
        invokeWorkbench("list_shared_audit_logs", { request: { ...filters, limit: PAGE_SIZE, offset: tableOffset } }),
        canQueryTableSummary
          ? invokeWorkbench("list_shared_audit_tables", {
              request: {
                serverScopeConnectionId: filters.serverScopeConnectionId,
                database: filters.database,
              },
            }).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (generation !== tableGeneration) return false;
      const safeRows = Array.isArray(rows) ? rows : [];
      tableOffset += safeRows.length;
      logs.value = uniqueEntries(append ? [...logs.value, ...safeRows] : safeRows);
      const tables = new Map();
      const activeScopeId = filters.serverScopeConnectionId || "";
      if (Array.isArray(tableSummaries)) {
        for (const item of tableSummaries) {
          if (!item?.tableName || !item?.database) continue;
          const tbl = buildSharedTableItem(
            { database: item.database, tableName: item.tableName },
            activeScopeId,
          );
          tables.set(sharedTableGroupKey(tbl), { ...tbl, latestTs: item.latestTs || "" });
        }
      }
      for (const row of logs.value) {
        if (row.status && row.status !== "committed" && row.status !== "rolled_back") continue;
        const tbl = buildSharedTableItem(row, activeScopeId);
        const key = sharedTableGroupKey(tbl);
        const previous = tables.get(key);
        if (!previous || row.ts > previous.latestTs) {
          tables.set(key, { ...tbl, latestTs: row.ts });
        }
      }
      allTables = [...tables.values()].sort((a, b) => String(b.latestTs || "").localeCompare(String(a.latestTs || "")));
      showTables();
      // When `/audit/table-latest` returned the complete per-table summary for
      // this database, no modified table is hidden behind pagination.
      state.tablesMore = Array.isArray(tableSummaries) && tableSummaries.length > 0
        ? false
        : safeRows.length === PAGE_SIZE;
      return true;
    } catch (error) { if (generation === tableGeneration) state.error = String(error?.message || error); return false; }
    finally { if (generation === tableGeneration) state.loadingTables = false; }
  }
  async function selectTable(table) {
    resetSelection(); state.selected = table; state.error = "";
    await loadOperations();
  }
  async function loadOperations(append = false) {
    if (!state.selected || state.loadingOperations) return;
    const generation = selectionGeneration;
    state.loadingOperations = true; state.error = "";
    const reqScope = operationRequestScope(state.selected);
    const useLargePage = Boolean(state.selected.serverScopeConnectionId || state.selected.serverKey);
    const pageLimit = useLargePage ? SCOPED_OPERATION_PAGE_SIZE : PAGE_SIZE;
    try {
      let nextOffset = append ? operationOffset : 0;
      let combined = append ? rawOperationRows.slice() : [];
      let hasMorePages = false;
      let pagesFetched = 0;

      while (pagesFetched < MAX_BATCH_DRAIN_PAGES) {
        pagesFetched += 1;
        const request = {
          ...reqScope,
          ...(useLargePage ? { committedOnly: true } : {}),
          limit: pageLimit,
          offset: nextOffset,
        };
        const rows = await invokeWorkbench("list_shared_audit_logs", { request });
        if (generation !== selectionGeneration) return;
        const safeRows = Array.isArray(rows) ? rows : [];
        nextOffset += safeRows.length;
        combined = uniqueEntries([...combined, ...safeRows]);
        hasMorePages = safeRows.length === pageLimit;
        if (!hasMorePages) break;

        // If the page ended inside a batch operation (e.g. a 4,500-row Excel
        // import), keep draining pages automatically so the operation count is
        // never truncated at 200 or 2,000 rows!
        const groupedSoFar = groupSharedOperations(combined);
        const tailOp = groupedSoFar[groupedSoFar.length - 1];
        const tailIsBatch = Boolean(
          tailOp && (
            tailOp.operationId
            || tailOp.source === "import"
            || tailOp.source === "rollback"
          ),
        );
        if (!tailIsBatch || groupedSoFar.length >= (append ? state.operations.length + 5 : 5)) {
          // If more than 1 group exists and the last group is a batch touching the
          // page boundary, hold back only if we already have complete groups above it.
          if (tailIsBatch && groupedSoFar.length === 1) {
            continue;
          }
          break;
        }
      }

      operationOffset = nextOffset;
      rawOperationRows = combined;
      let grouped = groupSharedOperations(combined);
      // Hold back an unclosed batch at the page tail when earlier complete operations
      // are already available, so a boundary-split import never shows a partial count.
      if (hasMorePages && grouped.length > 1) {
        const tailOp = grouped[grouped.length - 1];
        if (tailOp.operationId || tailOp.source === "import" || tailOp.source === "rollback") {
          grouped = grouped.slice(0, -1);
        }
      }
      state.operations = grouped.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
      state.operationsMore = hasMorePages;
    } catch (error) { if (generation === selectionGeneration) state.error = String(error?.message || error); }
    finally { if (generation === selectionGeneration) state.loadingOperations = false; }
  }
  function enrichDetailItem(entry, detailId) {
    const local = localByClientId.value.get(entry.clientId);
    const detail = { ...entry, id: detailId };
    // Only enrich an exact local match; remote records never gain local restore actions.
    if (local && String(local.database || "").toLowerCase() === String(entry.database || "").toLowerCase()
      && String(local.tableName || "").toLowerCase() === String(entry.tableName || "").toLowerCase()
      && (!entry.connectionId || !local.connectionId || local.connectionId === entry.connectionId)) {
      for (const key of ["rowIdentity", "forwardSql", "inverseSql", "notes"]) detail[key] ??= local[key];
    }
    return detail;
  }
  function loadDetails(operation, append = false) {
    if (!append && state.expanded === operation.id) { state.expanded = null; return; }
    state.expanded = operation.id;
    const entries = Array.isArray(operation.entries) && operation.entries.length
      ? operation.entries
      : (operation.entry ? [operation.entry] : []);
    const prevCount = append ? (state.details[operation.id]?.items?.length || 0) : 0;
    const end = Math.min(entries.length, prevCount + DETAIL_PAGE_SIZE);
    const slice = entries
      .slice(0, end)
      .map((entry, idx) => enrichDetailItem(entry, `${operation.id}:${entry.clientId || idx}`));
    state.details = {
      ...state.details,
      [operation.id]: {
        items: slice,
        hasMore: end < entries.length,
      },
    };
  }
  function dispose() { tableGeneration++; resetSelection(); state.loadingTables = false; }
  return { state, readOnly: true, loadTables, selectTable, loadOperations, loadDetails, resetSelection, dispose };
}
