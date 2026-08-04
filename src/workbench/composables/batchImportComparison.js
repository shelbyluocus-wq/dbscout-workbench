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

export function comparisonRowsForChunk(sheet, chunk, chunkResult) {
  const errorsByIndex = new Map(
    (Array.isArray(chunkResult?.errors) ? chunkResult.errors : [])
      .map((error) => [Number(error?.index), error]),
  );
  const rows = [];
  for (const outcome of Array.isArray(chunkResult?.outcomes) ? chunkResult.outcomes : []) {
    const index = Number(outcome?.index);
    const item = chunk[index];
    if (!item || outcome?.status === "unchanged") continue;
    if (outcome?.status === "error") {
      const error = errorsByIndex.get(index) || {};
      rows.push({
        ...comparisonRowBase(sheet, item, "error"),
        identity: {},
        changes: [],
        columnName: error.columnName || "",
        value: error.columnName ? (item.draft?.[error.columnName] ?? "") : "",
        error: String(error.error || error.message || "无法对比该行"),
      });
      continue;
    }
    if (outcome?.status !== "inserted" && outcome?.status !== "updated") continue;
    rows.push({
      ...comparisonRowBase(sheet, item, outcome.status),
      identity: outcome.preview?.identity || {},
      changes: Array.isArray(outcome.preview?.changes) ? outcome.preview.changes : [],
      error: "",
    });
  }
  return rows;
}

function identityKey(identity) {
  return Object.entries(identity || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
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
