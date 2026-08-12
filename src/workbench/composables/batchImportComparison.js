export const BATCH_IMPORT_COMPARISON_DETAIL_LIMIT = 2000;

export function createBatchImportComparison(runId = 0) {
  return {
    runId,
    status: "idle",
    running: false,
    cancelRequested: false,
    stale: false,
    errorMessage: "",
    progress: {
      done: 0,
      total: 0,
      current: "",
      phase: "",
      detail: "",
      errors: [],
    },
    summary: {
      inserted: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      skipped: 0,
      errors: 0,
    },
    tables: [],
    rows: [],
    detailTotal: 0,
    truncated: false,
  };
}

function comparisonRowBase(sheet, item, status) {
  return {
    id: `${sheet.sheetName}\x1f${item?.row || 0}\x1f${status}`,
    sheetName: sheet.sheetName,
    sourceFileName: sheet.sourceFileName || "",
    workbookSheetName: sheet.workbookSheetName || sheet.sheetName,
    tableName: sheet.targetTableName,
    row: item?.row,
    status,
  };
}

function identityKey(identity) {
  return Object.entries(identity || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

const INCOMING_ROW_STATUSES = new Set(["inserted", "updated", "unchanged"]);

export function comparisonColumnForSchema(column) {
  const name = column?.column_name || column?.columnName || column?.name || "";
  const nullable = column?.is_nullable ?? column?.isNullable ?? column?.nullable;
  return {
    name,
    primaryKey: Boolean(column?.is_primary_key || column?.isPrimaryKey || column?.primaryKey),
    generated: Boolean(column?.is_generated || column?.isGenerated || column?.generated),
    nullable: nullable === true || nullable === 1 || /^(yes|true|1)$/i.test(String(nullable ?? "")),
    defaultMode: column?.default_mode || column?.defaultMode || "none",
    defaultValue: column?.default_value ?? column?.defaultValue ?? null,
  };
}

export function replacementRowStatuses(result, rowCount) {
  const count = Math.max(0, Number(rowCount) || 0);
  const statuses = Array(count).fill("unchanged");
  const returned = Array.isArray(result?.rowStatuses)
    ? result.rowStatuses
    : (Array.isArray(result?.row_statuses) ? result.row_statuses : []);
  for (let index = 0; index < Math.min(count, returned.length); index += 1) {
    const status = String(returned[index] || "");
    if (INCOMING_ROW_STATUSES.has(status)) statuses[index] = status;
  }
  for (const outcome of Array.isArray(result?.outcomes) ? result.outcomes : []) {
    const index = Number(outcome?.index);
    const status = String(outcome?.status || "");
    if (Number.isInteger(index) && index >= 0 && index < count && INCOMING_ROW_STATUSES.has(status)) {
      statuses[index] = status;
    }
  }
  return statuses;
}

export function comparisonSourceRowsForReplacement(drafts, result) {
  const items = Array.isArray(drafts) ? drafts : [];
  const statuses = replacementRowStatuses(result, items.length);
  return items.map((item, index) => ({
    row: item?.row ?? null,
    draft: item?.draft && typeof item.draft === "object" ? item.draft : {},
    status: statuses[index],
  }));
}

export function comparisonRowsForReplacement(sheet, drafts, result) {
  const rows = [];
  for (const outcome of Array.isArray(result?.outcomes) ? result.outcomes : []) {
    const status = String(outcome?.status || "");
    if (status === "deleted") {
      const identity = outcome.preview?.identity || {};
      rows.push({
        ...comparisonRowBase(sheet, null, status),
        id: `${sheet.sheetName}\x1fdatabase:${identityKey(identity)}\x1f${status}`,
        identity,
        changes: [],
        before: outcome.preview?.before || null,
        after: null,
        error: "",
      });
      continue;
    }
    if (status !== "inserted" && status !== "updated") continue;
    const item = drafts[Number(outcome?.index)];
    if (!item) continue;
    rows.push({
      ...comparisonRowBase(sheet, item, status),
      identity: outcome.preview?.identity || {},
      changes: Array.isArray(outcome.preview?.changes) ? outcome.preview.changes : [],
      before: outcome.preview?.before || null,
      after: outcome.preview?.after || null,
      error: "",
    });
  }
  return rows;
}

export function comparisonErrorRows(sheet, items, error) {
  const message = String(error?.message || error || "无法对比该行");
  return items.map((item) => ({
    ...comparisonRowBase(sheet, item, "error"),
    identity: {},
    changes: [],
    columnName: "",
    value: "",
    error: message,
  }));
}

export function appendBatchImportComparisonRows(comparison, rows, detailTotal = null) {
  const candidates = Array.isArray(rows) ? rows : [];
  const exactTotal = detailTotal === null ? candidates.length : Math.max(0, Number(detailTotal) || 0);
  comparison.detailTotal += exactTotal;
  const remaining = Math.max(0, BATCH_IMPORT_COMPARISON_DETAIL_LIMIT - comparison.rows.length);
  if (remaining > 0) comparison.rows.push(...candidates.slice(0, remaining));
  if (candidates.length < exactTotal || candidates.length > remaining) comparison.truncated = true;
}
