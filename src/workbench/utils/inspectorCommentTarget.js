import { columnName } from "./normalize.js";

function columnComment(column) {
  return String(column?.column_comment || column?.columnComment || "");
}

function columnByName(columns, name) {
  const target = String(name || "");
  if (!target) return null;
  return (Array.isArray(columns) ? columns : []).find((column) => columnName(column) === target) || null;
}

// Right-click in the remarks pane edits the field under the pointer.
// The table summary edits the table comment. Anywhere else edits the
// selected field, or the table comment when no field is selected.
export function resolveInspectorCommentTarget(event, {
  columns = [],
  selectedColumn = "",
  tableComment = "",
} = {}) {
  const node = event?.target;
  const columnElement = node?.closest?.("[data-schema-column]");
  const pointedColumn = columnElement?.getAttribute?.("data-schema-column") || "";
  if (pointedColumn) {
    return {
      kind: "column",
      columnName: pointedColumn,
      comment: columnComment(columnByName(columns, pointedColumn)),
    };
  }
  if (node?.closest?.(".wb-inspector-table-status")) {
    return { kind: "table", columnName: "", comment: String(tableComment || "") };
  }
  const selectedName = String(selectedColumn || "");
  if (selectedName) {
    return {
      kind: "column",
      columnName: selectedName,
      comment: columnComment(columnByName(columns, selectedName)),
    };
  }
  return { kind: "table", columnName: "", comment: String(tableComment || "") };
}
