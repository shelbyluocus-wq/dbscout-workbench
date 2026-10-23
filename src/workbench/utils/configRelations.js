// Presentation helpers for the config-relations feature: status and reason
// copy, coverage-gap text, table labels and the relation-tab chip. Everything
// here is a pure function over the backend payload shapes plus a translate
// function, so components stay declarative and tests stay cheap.

import { connectionHasCapability } from "./connectionKinds.js";
import { columnName } from "./normalize.js";
import { listItemValues, normalizeRelationFilter, normalizeRelationOrigin } from "./relationFilter.js";
import { parseReferenceValues } from "./referenceParser.js";

export const RELATION_STATUSES = Object.freeze(["confirmed", "unconfirmed", "stale", "conflict", "rejected"]);

// Relations read the config server directly, so they need a known MySQL
// connection that is not served from the built-in sample data.
export function connectionOffersConfigRelations(connection) {
  return Boolean(connection?.id) &&
    !connection.sampleData &&
    connectionHasCapability(connection.kind, "configRelations");
}

export function relationStatusLabel(status, translate) {
  const known = RELATION_STATUSES.includes(status) ? status : "unconfirmed";
  return translate(`relations.status.${known}`);
}

export function relationReasonLabel(reason, translate) {
  return translate(`relations.reason.${String(reason || "").trim() || "codeOnly"}`);
}

export function relationNeedsReview(relation) {
  return relation?.status === "stale" || relation?.status === "conflict";
}

// Confirmed relations are already in effect. Only a stale or conflicting one
// still offers confirm / not-a-relation.
export function relationIsActionable(relation) {
  return relationNeedsReview(relation);
}

// `tables` is the backend's lowercase-name -> { name, comment } map.
export function tableDisplayName(tables, lowerName) {
  const lower = String(lowerName || "");
  return tables?.[lower]?.name || lower;
}

export function tableDisplayComment(tables, lowerName) {
  return tables?.[String(lowerName || "")]?.comment || "";
}

// The label map also carries the comments of the columns its relations use.
export function tableColumnComment(tables, lowerName, column) {
  return tables?.[String(lowerName || "")]?.columns?.[String(column || "").toLowerCase()] || "";
}

// One end of a relation title ("Table.column" or a bare "column") split so
// the field can carry its own hover card. Text that does not end in the
// column stays whole.
export function relationEndParts(text, column) {
  const value = String(text ?? "");
  const field = String(column || "");
  if (field && value.toLowerCase().endsWith(field.toLowerCase())) {
    const prefix = value.slice(0, value.length - field.length);
    if (!prefix || prefix.endsWith(".")) return { prefix, column: value.slice(prefix.length) };
  }
  return { prefix: value, column: "" };
}

export function relationTitle(relation, tables) {
  if (!relation) return "";
  const source = `${tableDisplayName(tables, relation.sourceTable)}.${relation.sourceColumn}`;
  const target = `${tableDisplayName(tables, relation.targetTable)}.${relation.targetColumn}`;
  return `${source} → ${target}`;
}

// Hover text for one piece of evidence: the comment itself, the code location,
// or the sampled cell that showed the list format.
export function relationEvidenceTitle(evidence) {
  if (evidence?.type === "comment") return evidence.text || "";
  if (evidence?.type === "rule") return evidence.text || "";
  if (evidence?.type === "code") return `${evidence.file}:${evidence.line}`;
  if (evidence?.type === "format") return evidence.sample || "";
  return "";
}

export function relationEvidenceKey(evidence) {
  return `${evidence?.type || ""}\u001f${evidence?.fingerprint || evidence?.text || evidence?.sample || ""}`;
}

export function coverageGapText(gap, translate) {
  switch (gap?.code) {
    case "noClient":
      return translate("relations.gap.noClient");
    case "clientMissing":
      return translate("relations.gap.clientMissing");
    case "analyzing":
      return translate("relations.gap.analyzing");
    case "scanFailed":
      return translate("relations.gap.scanFailed", { message: gap.message || "" });
    case "notUsedByClient":
      return translate("relations.gap.notUsedByClient");
    case "untracedLookups":
      return translate("relations.gap.untracedLookups", { count: gap.count ?? 0 });
    case "unsupportedFields":
      return translate("relations.gap.unsupportedFields", { columns: (gap.columns || []).join(", ") });
    default:
      return "";
  }
}

// The keys a row lookup cares about: source columns of outgoing relations and
// key columns of incoming ones. Used to notice edits that change relations.
export function relationRelevantColumns(relations) {
  const columns = new Set();
  for (const relation of relations || []) {
    if (!relation || relation.status === "rejected") continue;
    if (relation.sourceColumn) columns.add(String(relation.sourceColumn).toLowerCase());
    if (relation.targetColumn) columns.add(String(relation.targetColumn).toLowerCase());
    for (const guard of relation.sourceConstraints || []) columns.add(guard.column.toLowerCase());
  }
  return [...columns];
}

// Case-insensitive cell read; grid rows use database column case while
// relation metadata may arrive in either case.
export function rowCellValue(row, column) {
  if (!row || !column) return undefined;
  if (Object.hasOwn(row, column)) return row[column];
  const lower = String(column).toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === lower) return row[key];
  }
  return undefined;
}

const LABEL_COLUMN_NAMES = Object.freeze(["name", "title", "desc", "des", "describe", "remark"]);
const ROW_NAME_MAX_LENGTH = 40;

function columnTypeText(column) {
  return String(column?.column_type || column?.columnType || column?.data_type || column?.dataType || "");
}

function columnCommentText(column) {
  return String(column?.column_comment || column?.columnComment || "");
}

// The column whose value names a row ("Name", "Title", ...). Mirrors the
// backend's TableMeta::label_column so a referencing row reads the same way
// as a referenced one. Empty when the table has no such text column.
export function relationLabelColumn(columns, primaryKeys = []) {
  const keys = new Set((primaryKeys || []).map((key) => String(key).toLowerCase()));
  const textColumns = (columns || []).filter((column) => {
    const name = columnName(column);
    return name &&
      /char|text/i.test(columnTypeText(column)) &&
      !keys.has(name.toLowerCase()) &&
      !column.is_primary_key && !column.isPrimaryKey;
  });
  const named = (wanted) => textColumns.find((column) => columnName(column).toLowerCase() === wanted);
  const found = LABEL_COLUMN_NAMES.map(named).find(Boolean) ||
    textColumns.find((column) => columnName(column).toLowerCase().includes("name")) ||
    textColumns.find((column) => /名称|名字|名稱/.test(columnCommentText(column)));
  return found ? columnName(found) : "";
}

// One-line display name of a row from its label column, shortened for chips.
export function relationRowName(row, labelColumn) {
  if (!row || !labelColumn) return "";
  const value = rowCellValue(row, labelColumn);
  const text = value == null ? "" : String(value).replace(/\s+/g, " ").trim();
  return text.length > ROW_NAME_MAX_LENGTH ? `${text.slice(0, ROW_NAME_MAX_LENGTH - 1)}…` : text;
}

// Which side of `table` a relation sits on: "outgoing" when the table's own
// column points elsewhere, "incoming" when another table points at it.
export function relationDirection(relation, table) {
  return String(relation?.sourceTable || "") === String(table || "").toLowerCase() ? "outgoing" : "incoming";
}

// How many relations a table takes part in and how many wait for a decision,
// for the badge on the inspector's relation switch. A self reference is one
// relation even though it is listed on both sides.
export function relationTableSummary(data) {
  if (!data) return null;
  const active = new Map();
  for (const relation of [...(data.outgoing || []), ...(data.incoming || [])]) {
    if (relation?.id && relation.status !== "rejected") active.set(relation.id, relation);
  }
  const relations = [...active.values()];
  return { total: relations.length, review: relations.filter(relationNeedsReview).length };
}

// Active relations split from the rejected ones, each list in display order.
export function splitRejectedRelations(relations) {
  const active = [];
  const rejected = [];
  for (const relation of relations || []) (relation?.status === "rejected" ? rejected : active).push(relation);
  return { active, rejected };
}

// Code locations keep only their last folders so the file reads at a glance;
// the full path stays available as a tooltip.
export function shortCodePath(file, keep = 2) {
  const parts = String(file || "").split(/[\\/]+/).filter(Boolean);
  return parts.length > keep + 1 ? `…/${parts.slice(-(keep + 1)).join("/")}` : parts.join("/");
}

const EMPTY_REFERENCE_MARKERS = new Set(["", "0", "-1", "null", "NULL", "[]"]);

export function isEmptyReferenceValue(value) {
  return EMPTY_REFERENCE_MARKERS.has(String(value ?? "").trim());
}

// Keys one cell references through a relation, in cell order. Mirrors the
// backend's rows::reference_values so jump filters cover every value, even
// past the display cap.
export function referenceValuesFromCell(kind, text, parser = null) {
  if (parser) return parseReferenceValues(text, parser) || [];
  const values = kind === "list"
    ? listItemValues(text) || []
    : [String(text ?? "").trim()];
  const unique = [];
  for (const value of values) {
    if (!isEmptyReferenceValue(value) && !unique.includes(value)) unique.push(value);
  }
  return unique;
}

function chipValuesText(values, translate) {
  const shown = values.slice(0, 3).join(", ");
  const extra = values.length - 3;
  return extra > 0 ? `${shown} ${translate("relations.chip.more", { count: extra })}` : shown;
}

// One-line chip text for a relation tab, or null when the tab is not one.
export function relationChipLabel(tab, translate) {
  const filter = normalizeRelationFilter(tab?.relationFilter);
  if (!filter) return "";
  const values = chipValuesText(filter.values, translate);
  const origin = normalizeRelationOrigin(tab?.relationOrigin);
  if (origin?.direction === "outgoing") {
    // The viewed table holds the referenced rows; the column naming them
    // lives on the source table.
    return translate("relations.chip.from", {
      table: origin.sourceTable,
      column: origin.sourceColumn,
      values,
    });
  }
  const key = filter.kind === "listContains" || filter.parser ? "relations.chip.contains" : "relations.chip.equals";
  return translate(key, { column: filter.column, values });
}

export function clientDialectLabel(dialect, translate) {
  const key = String(dialect || "").toLowerCase();
  if (key === "jswz") return translate("relations.client.dialectJswz");
  if (key === "nzg") return translate("relations.client.dialectNzg");
  return String(dialect || "");
}
