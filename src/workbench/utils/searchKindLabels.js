import { t } from "../i18n/index.js";

// Labels for schema-search hit kinds, shared by Quick Open, the sidebar search
// results and the hit badges so the same kind reads the same everywhere.
const SEARCH_KIND_KEYS = Object.freeze({
  all: "search.kind.all",
  tableName: "search.kind.tableName",
  tableComment: "search.kind.tableComment",
  columnName: "search.kind.columnName",
  columnComment: "search.kind.columnComment",
  value: "search.kind.value",
});

export function searchKindLabel(kind) {
  return t(SEARCH_KIND_KEYS[kind] || "search.kind.schema");
}
