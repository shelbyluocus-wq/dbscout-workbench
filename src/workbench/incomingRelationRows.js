import { reactive } from "vue";
import { invokeWorkbench } from "./utils/tauriBridge.js";
import { buildRowIdentity, buildRowKey } from "./utils/rowIdentity.js";
import { relationLabelColumn, relationRowName, rowCellValue } from "./utils/configRelations.js";

export const INCOMING_PAGE_SIZE = 50;

export function incomingRelationFilter(relation, value) {
  return {
    column: relation.sourceColumn,
    kind: relation.kind === "list" ? "listContains" : "equals",
    values: [String(value)],
  };
}

// Short-lived sessions reuse the normal, parameterized relation filter and
// primary-key ordering. Expanding a card never opens a workspace tab or counts.
export async function fetchIncomingRelationRows(context, offset = 0, invoke = invokeWorkbench) {
  const page = await invoke("open_table_session", {
    ...context.scope,
    tableName: context.tableName,
    options: {
      page: 1, pageSize: INCOMING_PAGE_SIZE, offset, includeTotal: false,
      filter: { query: "", relation: incomingRelationFilter(context.relation, context.value) },
    },
  });
  try {
    const primaryKeys = page.primaryKeys || [];
    // Rows are recognised by name, the way the outgoing targets read.
    const nameColumn = relationLabelColumn(page.columns, primaryKeys);
    const rows = (page.rows || []).map((row, index) => {
      const identity = buildRowIdentity({ primaryKeys, columns: page.columns || [] }, row);
      const label = primaryKeys.map((key) => `${key}=${rowCellValue(row, key) ?? "NULL"}`).join(" + ");
      return {
        key: buildRowKey({ primaryKeys, columns: page.columns || [] }, row),
        identity: primaryKeys.length ? identity : null,
        label,
        name: relationRowName(row, nameColumn),
        ordinal: offset + index + 1,
      };
    });
    return { rows, hasMore: Boolean(page.hasMore) && rows.length > 0 };
  } finally {
    if (page.sessionId) await invoke("close_table_session", { sessionId: page.sessionId });
  }
}

export function createIncomingRelationRows(loadPage) {
  const state = reactive({ expanded: false, loading: false, loaded: false, rows: [], hasMore: false, error: "" });
  let generation = 0;
  function reset() {
    generation += 1;
    Object.assign(state, { expanded: false, loading: false, loaded: false, rows: [], hasMore: false, error: "" });
  }
  async function loadMore() {
    if (state.loading || (state.loaded && !state.hasMore)) return;
    const token = generation;
    state.loading = true;
    state.error = "";
    try {
      const page = await loadPage(state.rows.length);
      if (token !== generation) return;
      state.rows.push(...page.rows);
      state.hasMore = page.hasMore;
      state.loaded = true;
    } catch (error) {
      if (token === generation) state.error = String(error?.message || error);
    } finally {
      if (token === generation) state.loading = false;
    }
  }
  function toggle() {
    state.expanded = !state.expanded;
    if (state.expanded && !state.loaded) void loadMore();
  }
  return { state, reset, toggle, loadMore };
}
