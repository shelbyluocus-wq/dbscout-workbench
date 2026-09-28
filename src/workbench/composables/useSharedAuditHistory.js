import { computed, reactive, shallowRef } from "vue";
import { auditTableKey } from "./useAuditHistory.js";

const PAGE_SIZE = 200;
const scopeOf = ({ connectionId, database, tableName }) => ({ connectionId, database, tableName });
const entryKey = (entry) => JSON.stringify([auditTableKey(entry), entry.clientId || entry.id]);
const uniqueEntries = (entries) => [...new Map(entries.map((entry) => [entryKey(entry), entry])).values()];

/** The shared API exposes rows, not operation boundaries. Never infer batches from timestamps. */
export function useSharedAuditHistory({ invokeWorkbench, logs = shallowRef([]), localLogs = shallowRef([]) }) {
  const state = reactive({ tables: [], tablesMore: false, selected: null, operations: [], operationsMore: false,
    details: {}, expanded: null, error: "", notice: "", search: "", loadingTables: false,
    loadingOperations: false, loadingDetails: false, restoring: false });
  let filters = {}, tableOffset = 0, operationOffset = 0;
  let tableGeneration = 0, selectionGeneration = 0;
  let allTables = [];
  const localByClientId = computed(() => new Map(localLogs.value.filter((entry) => entry.clientId).map((entry) => [entry.clientId, entry])));
  const showTables = () => {
    const search = state.search.trim().toLocaleLowerCase();
    state.tables = allTables.filter((table) => [table.tableName, table.database].some((value) => value.toLocaleLowerCase().includes(search)));
  };
  function resetSelection() {
    selectionGeneration++;
    state.selected = null; state.operations = []; state.operationsMore = false;
    state.details = {}; state.expanded = null; state.loadingOperations = false;
    operationOffset = 0;
  }
  async function loadTables(nextFilters, append = false) {
    if (state.loadingTables && append) return false;
    // Submitting the table search filters the loaded page without downloading all shared history.
    if (nextFilters === undefined && !append) { showTables(); return true; }
    if (nextFilters !== undefined) filters = Object.fromEntries(Object.entries(scopeOf(nextFilters)).filter(([, value]) => value));
    const generation = ++tableGeneration;
    state.loadingTables = true; state.error = "";
    if (!append) { resetSelection(); tableOffset = 0; logs.value = []; allTables = []; state.tables = []; state.tablesMore = false; }
    try {
      const rows = await invokeWorkbench("list_shared_audit_logs", { request: { ...filters, limit: PAGE_SIZE, offset: tableOffset } });
      if (generation !== tableGeneration) return false;
      tableOffset += rows.length;
      logs.value = uniqueEntries(append ? [...logs.value, ...rows] : rows);
      const tables = new Map();
      for (const row of logs.value) {
        const key = auditTableKey(row), previous = tables.get(key);
        if (!previous || row.ts > previous.latestTs) tables.set(key, { ...scopeOf(row), latestTs: row.ts });
      }
      allTables = [...tables.values()].sort((a, b) => b.latestTs.localeCompare(a.latestTs));
      showTables(); state.tablesMore = rows.length === PAGE_SIZE;
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
    try {
      const rows = await invokeWorkbench("list_shared_audit_logs", { request: { ...scopeOf(state.selected), limit: PAGE_SIZE, offset: append ? operationOffset : 0 } });
      if (generation !== selectionGeneration) return;
      operationOffset = (append ? operationOffset : 0) + rows.length;
      const operations = rows.map((entry) => ({ ...entry, id: entryKey(entry), entryCount: 1,
        inserted: Number(entry.operation === "INSERT"), updated: Number(entry.operation === "UPDATE"),
        deleted: Number(entry.operation === "DELETE"), entry }));
      state.operations = [...new Map((append ? [...state.operations, ...operations] : operations).map((operation) => [operation.id, operation])).values()].sort((a, b) => b.ts.localeCompare(a.ts));
      state.operationsMore = rows.length === PAGE_SIZE;
    } catch (error) { if (generation === selectionGeneration) state.error = String(error?.message || error); }
    finally { if (generation === selectionGeneration) state.loadingOperations = false; }
  }
  function loadDetails(operation) {
    if (state.expanded === operation.id) { state.expanded = null; return; }
    state.expanded = operation.id;
    const entry = operation.entry, local = localByClientId.value.get(entry.clientId);
    const detail = { ...entry, id: operation.id };
    // Only enrich an exact local match; remote records never gain local restore actions.
    if (local && auditTableKey(local) === auditTableKey(entry)) {
      for (const key of ["rowIdentity", "forwardSql", "inverseSql", "notes"]) detail[key] ??= local[key];
    }
    state.details = { [operation.id]: { items: [detail], hasMore: false } };
  }
  function dispose() { tableGeneration++; resetSelection(); state.loadingTables = false; }
  return { state, readOnly: true, loadTables, selectTable, loadOperations, loadDetails, resetSelection, dispose };
}
