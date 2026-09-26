import { reactive } from "vue";
import { invokeWorkbench as defaultInvoke } from "../utils/tauriBridge.js";

const message = (error) => String(error?.message || error || "未知错误");
export const auditTableKey = (table) => JSON.stringify([table.connectionId, table.database, table.tableName]);

/** Independent request generations prevent slow tables/details replacing the current selection. */
export function useAuditHistory({ invokeWorkbench = defaultInvoke, onBusy = () => {} } = {}) {
  const state = reactive({ tables: [], tablesMore: false, selected: null, operations: [], operationsMore: false,
    details: {}, expanded: null, preview: null, target: null, error: "", notice: "", search: "",
    loadingTables: false, loadingOperations: false, loadingDetails: false, previewing: false, restoring: false });
  let tableGeneration = 0, selectionGeneration = 0, detailGeneration = 0, previewGeneration = 0;
  let filters = {};
  const scope = () => state.selected ? {
    connectionId: state.selected.connectionId, database: state.selected.database, tableName: state.selected.tableName,
  } : {};
  function dismissPreview() { previewGeneration++; state.preview = null; state.target = null; state.previewing = false; }
  function resetSelection() {
    selectionGeneration++; detailGeneration++; dismissPreview();
    state.selected = null; state.operations = []; state.operationsMore = false;
    state.details = {}; state.expanded = null; state.loadingOperations = false; state.loadingDetails = false;
  }
  async function loadTables(nextFilters = filters, append = false) {
    filters = Object.fromEntries(Object.entries(nextFilters).filter(([key, value]) => ["connectionId", "database", "tableName"].includes(key) && value));
    const generation = ++tableGeneration;
    state.loadingTables = true; state.error = "";
    try {
      const result = await invokeWorkbench("list_audit_tables", { request: { ...filters, search: state.search, offset: append ? state.tables.length : 0 } });
      if (generation !== tableGeneration) return false;
      state.tables = append ? [...state.tables, ...result.items] : result.items;
      state.tablesMore = result.hasMore;
      if (!append && state.selected) {
        const match = state.tables.find((row) => auditTableKey(row) === auditTableKey(state.selected));
        if (match) await selectTable(match); else resetSelection();
      }
      return true;
    } catch (error) { if (generation === tableGeneration) state.error = message(error); return false; }
    finally { if (generation === tableGeneration) state.loadingTables = false; }
  }
  async function selectTable(table) {
    if (state.restoring) return;
    resetSelection(); state.selected = table; state.error = ""; state.notice = "";
    await loadOperations();
  }
  async function loadOperations(append = false) {
    if (!state.selected) return;
    const generation = selectionGeneration;
    state.loadingOperations = true;
    try {
      const result = await invokeWorkbench("list_audit_operations", { request: { ...scope(), offset: append ? state.operations.length : 0 } });
      if (generation !== selectionGeneration) return;
      state.operations = append ? [...state.operations, ...result.items] : result.items;
      state.operationsMore = result.hasMore;
    } catch (error) { if (generation === selectionGeneration) state.error = message(error); }
    finally { if (generation === selectionGeneration) state.loadingOperations = false; }
  }
  async function loadDetails(operation, append = false) {
    if (!append && state.expanded === operation.id) { state.expanded = null; detailGeneration++; state.loadingDetails = false; return; }
    const generation = ++detailGeneration, selectedGeneration = selectionGeneration;
    state.expanded = operation.id; state.loadingDetails = true;
    const previous = state.details[operation.id];
    try {
      const result = await invokeWorkbench("list_audit_operation_details", { request: { ...scope(), auditId: operation.id, offset: append ? previous?.items.length || 0 : 0 } });
      if (generation !== detailGeneration || selectedGeneration !== selectionGeneration) return;
      state.details[operation.id] = { items: append ? [...(previous?.items || []), ...result.items] : result.items, hasMore: result.hasMore };
    } catch (error) { if (generation === detailGeneration && selectedGeneration === selectionGeneration) state.error = message(error); }
    finally { if (generation === detailGeneration) state.loadingDetails = false; }
  }
  async function prepareRestore(operation) {
    dismissPreview(); state.target = operation; state.error = ""; state.notice = "";
    const generation = ++previewGeneration, selectedGeneration = selectionGeneration;
    state.previewing = true;
    try {
      const result = await invokeWorkbench("preview_audit_table_restore", { request: { ...scope(), auditId: operation.id } });
      if (generation === previewGeneration && selectedGeneration === selectionGeneration) state.preview = result;
    } catch (error) { if (generation === previewGeneration && selectedGeneration === selectionGeneration) state.error = message(error); }
    finally { if (generation === previewGeneration) state.previewing = false; }
  }
  async function restore() {
    if (!state.preview || state.restoring) return;
    const request = { ...scope(), auditId: state.target.id, token: state.preview.token };
    state.restoring = true; onBusy(true); state.error = "";
    let notice = "";
    try { notice = await invokeWorkbench("restore_audit_table", { request }); }
    catch (error) { state.error = message(error); }
    finally { state.restoring = false; onBusy(false); dismissPreview(); }
    if (notice) { await loadTables(); state.notice = notice; }
  }
  function dispose() { tableGeneration++; resetSelection(); state.loadingTables = false; }
  return { state, loadTables, selectTable, loadOperations, loadDetails, prepareRestore, restore, dismissPreview, resetSelection, dispose };
}
