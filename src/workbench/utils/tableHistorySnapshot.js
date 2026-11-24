import { computeInlineDiff, normalizeCellDisplay } from "./tableChangeHistory.js";

export function normalizeSnapshotColumns(rawColumns = [], primaryKeys = []) {
  const pkLower = new Set((Array.isArray(primaryKeys) ? primaryKeys : []).map((k) => String(k || "").toLowerCase()));
  const list = [];
  for (const col of Array.isArray(rawColumns) ? rawColumns : []) {
    if (!col) continue;
    const name = typeof col === "string"
      ? col
      : String(col.columnName ?? col.column_name ?? col.name ?? "").trim();
    if (!name) continue;
    const comment = typeof col === "string"
      ? ""
      : String(col.columnComment ?? col.column_comment ?? col.comment ?? "").trim();
    const isPk = typeof col === "object"
      ? Boolean(col.isPrimaryKey ?? col.is_primary_key ?? col.primaryKey ?? pkLower.has(name.toLowerCase()))
      : pkLower.has(name.toLowerCase());
    list.push({ name, comment, primaryKey: isPk });
  }
  return list;
}

export function restoreNullCellsOnRows(rows = [], nullCells = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!Array.isArray(nullCells) || !nullCells.length) {
    return safeRows.map((row) => ({ ...row }));
  }
  return safeRows.map((row, index) => {
    const copy = { ...row };
    const nulls = nullCells[index];
    if (Array.isArray(nulls) && nulls.length) {
      for (const col of nulls) {
        copy[col] = null;
      }
    }
    return copy;
  });
}

function buildColumnNameMap(columns, primaryKeys) {
  const map = new Map();
  for (const col of Array.isArray(columns) ? columns : []) {
    const name = typeof col === "string"
      ? col
      : String(col?.name ?? col?.columnName ?? col?.column_name ?? "").trim();
    if (name) map.set(name.toLowerCase(), name);
  }
  for (const pk of Array.isArray(primaryKeys) ? primaryKeys : []) {
    const lower = String(pk || "").toLowerCase();
    if (lower && !map.has(lower)) map.set(lower, pk);
  }
  return map;
}

function resolveColumnName(rawName, colNameMap) {
  const trimmed = String(rawName || "").trim();
  if (!trimmed) return "";
  return colNameMap.get(trimmed.toLowerCase()) || trimmed;
}

export function buildIdentityKey(primaryKeys, valuesObj) {
  return JSON.stringify(
    primaryKeys.map((pk) => [pk, String(valuesObj?.[pk] ?? "").trim()]),
  );
}

/**
 * Extract canonical primary-key identity for an audit item.
 * Falls back to extracting PK fields from `rowFields` for INSERT/DELETE items
 * when `rowIdentity` was omitted (e.g. legacy server entries).
 */
export function normalizeItemRowIdentity(item, primaryKeys = [], colNameMap = new Map()) {
  const map = {};
  const rawIdentity = item?.rowIdentity;
  if (Array.isArray(rawIdentity)) {
    for (const pair of rawIdentity) {
      if (!pair?.key) continue;
      const canonical = resolveColumnName(pair.key, colNameMap);
      map[canonical] = pair.value === "NULL" || pair.value == null ? "" : String(pair.value);
    }
  } else if (rawIdentity && typeof rawIdentity === "object") {
    for (const [k, v] of Object.entries(rawIdentity)) {
      const canonical = resolveColumnName(k, colNameMap);
      map[canonical] = v == null ? "" : String(v);
    }
  }

  // Fallback for INSERT / DELETE: extract PK columns from rowFields JSON payload
  if (
    (item?.operation === "INSERT" || item?.operation === "DELETE")
    && Array.isArray(item?.rowFields)
    && item.rowFields.length
  ) {
    const pkSet = new Set(primaryKeys);
    for (const fieldEntry of item.rowFields) {
      if (!fieldEntry?.field) continue;
      const canonical = resolveColumnName(fieldEntry.field, colNameMap);
      if (pkSet.has(canonical) && !(canonical in map)) {
        map[canonical] = fieldEntry.value?.isNull ? "" : String(fieldEntry.value?.text ?? "");
      }
    }
  }

  const complete = primaryKeys.length > 0 && primaryKeys.every((pk) => Object.hasOwn(map, pk) && map[pk] !== "");
  const key = complete ? buildIdentityKey(primaryKeys, map) : "";
  return { key, map, complete };
}

/**
 * Decide whether the selected revision can be rendered as an accurate
 * full-table before/after comparison without fabricating row placement.
 */
export function canReconstructRevision(revision, primaryKeys = [], columns = []) {
  if (!Array.isArray(primaryKeys) || primaryKeys.length === 0) {
    return { ok: false, reason: "no-primary-key" };
  }
  const items = Array.isArray(revision?.items) ? revision.items : [];
  if (!items.length) {
    return { ok: false, reason: "empty" };
  }
  const colNameMap = buildColumnNameMap(columns, primaryKeys);
  let rowMutationCount = 0;
  for (const item of items) {
    const op = String(item?.operation || "").toUpperCase();
    if (op === "DDL") continue;
    rowMutationCount += 1;
    const identity = normalizeItemRowIdentity(item, primaryKeys, colNameMap);
    if (!identity.complete) {
      return { ok: false, reason: "missing-row-identity" };
    }
  }
  if (rowMutationCount === 0) {
    return { ok: false, reason: "ddl-only" };
  }
  return { ok: true, reason: "" };
}

function rowFieldsToObject(rowFields = [], colNameMap = new Map()) {
  const obj = {};
  for (const fieldEntry of Array.isArray(rowFields) ? rowFields : []) {
    if (!fieldEntry?.field) continue;
    const canonical = resolveColumnName(fieldEntry.field, colNameMap);
    obj[canonical] = fieldEntry.value?.isNull ? null : String(fieldEntry.value?.text ?? "");
  }
  return obj;
}

function rawValueFromDiffPart(part) {
  if (!part) return null;
  return part.isNull ? null : String(part.text ?? "");
}

function cellValuesDiffer(beforeVal, afterVal) {
  const bNull = beforeVal === null || beforeVal === undefined;
  const aNull = afterVal === null || afterVal === undefined;
  if (bNull !== aNull) return true;
  if (bNull && aNull) return false;
  return String(beforeVal) !== String(afterVal);
}

/**
 * Reconstruct exact Before and After full-table states for `revisions[targetIndex]`
 * by inverse-replaying newer revisions (0 .. targetIndex - 1) onto `liveRows`,
 * then inverse-applying `revisions[targetIndex]` to compute the aligned diff.
 */
export function reconstructRevisionFullTable({
  columns: rawColumns = [],
  primaryKeys: rawPrimaryKeys = [],
  liveRows = [],
  revisions = [],
  targetIndex = 0,
} = {}) {
  const primaryKeys = Array.isArray(rawPrimaryKeys) ? rawPrimaryKeys.filter(Boolean) : [];
  const columns = normalizeSnapshotColumns(rawColumns, primaryKeys);
  const targetRevision = revisions[targetIndex] || null;
  const check = canReconstructRevision(targetRevision, primaryKeys, columns);
  if (!check.ok) {
    return {
      mode: "field-diff",
      reason: check.reason,
      columns,
      primaryKeys,
      rows: [],
      changedRowIndices: [],
      totalRows: 0,
      changedCount: 0,
      partialReplayWarning: false,
      hasSynthesizedRows: false,
    };
  }

  const colNameMap = buildColumnNameMap(columns, primaryKeys);
  const currentMap = new Map();
  const order = [];
  const orderSet = new Set();
  const orderPkNum = new Map();

  const singleNumericPk = primaryKeys.length === 1 ? primaryKeys[0] : "";
  const parseNumericPk = (rowObj) => {
    if (!singleNumericPk || !rowObj) return Number.NaN;
    const raw = String(rowObj[singleNumericPk] ?? "").trim();
    if (!raw || !/^-?\d+(?:\.\d+)?$/.test(raw)) return Number.NaN;
    return Number(raw);
  };

  const ensureInOrder = (idKey, rowObj = null, { sortedInsert = false } = {}) => {
    if (orderSet.has(idKey)) return;
    orderSet.add(idKey);
    const num = parseNumericPk(rowObj);
    if (Number.isFinite(num)) orderPkNum.set(idKey, num);
    if (sortedInsert && Number.isFinite(num) && order.length > 0) {
      // Insert deleted/synthesized row at its natural numeric PK slot when live rows are ascending
      const firstNum = orderPkNum.get(order[0]);
      const lastNum = orderPkNum.get(order[order.length - 1]);
      if (Number.isFinite(firstNum) && Number.isFinite(lastNum) && firstNum <= lastNum) {
        let insertAt = order.length;
        for (let i = 0; i < order.length; i += 1) {
          const existingNum = orderPkNum.get(order[i]);
          if (Number.isFinite(existingNum) && existingNum > num) {
            insertAt = i;
            break;
          }
        }
        order.splice(insertAt, 0, idKey);
        return;
      }
    }
    order.push(idKey);
  };

  for (const rawRow of Array.isArray(liveRows) ? liveRows : []) {
    const row = {};
    for (const [k, v] of Object.entries(rawRow || {})) {
      const canonical = resolveColumnName(k, colNameMap);
      row[canonical] = v === undefined ? null : v;
    }
    const idKey = buildIdentityKey(primaryKeys, row);
    currentMap.set(idKey, row);
    ensureInOrder(idKey, row);
  }

  let partialReplayWarning = false;

  // Phase A: rewind revisions newer than targetIndex (0 .. targetIndex - 1).
  // Revisions are sorted newest-first; items inside a revision are also newest-first.
  for (let revIdx = 0; revIdx < targetIndex; revIdx += 1) {
    const rev = revisions[revIdx];
    for (const item of rev?.items || []) {
      const op = String(item?.operation || "").toUpperCase();
      if (op === "DDL") {
        partialReplayWarning = true;
        continue;
      }
      const identity = normalizeItemRowIdentity(item, primaryKeys, colNameMap);
      if (!identity.complete) {
        partialReplayWarning = true;
        continue;
      }
      if (op === "INSERT") {
        currentMap.delete(identity.key);
      } else if (op === "DELETE") {
        const restored = { ...identity.map, ...rowFieldsToObject(item.rowFields, colNameMap) };
        currentMap.set(identity.key, restored);
        ensureInOrder(identity.key, restored, { sortedInsert: true });
      } else {
        // UPDATE: rewind changed fields to their `before` values
        const existing = currentMap.get(identity.key);
        if (existing) {
          for (const change of item.changes || []) {
            if (!change?.field) continue;
            const canonical = resolveColumnName(change.field, colNameMap);
            existing[canonical] = rawValueFromDiffPart(change.before);
          }
        }
      }
    }
  }

  // Phase B: snapshot `afterMap` and rewind `targetRevision` into `beforeMap`.
  const afterMap = new Map();
  const beforeMap = new Map();
  for (const [idKey, row] of currentMap.entries()) {
    afterMap.set(idKey, { ...row });
    beforeMap.set(idKey, { ...row });
  }

  const touchedKeys = new Set();
  const touchedColsByKey = new Map();
  const synthesizedKeys = new Set();
  const deletedKeys = new Set();
  const insertedKeys = new Set();
  const identityMapByKey = new Map();

  const recordTouchedCol = (idKey, colName) => {
    if (!touchedColsByKey.has(idKey)) touchedColsByKey.set(idKey, new Set());
    if (colName) touchedColsByKey.get(idKey).add(colName);
  };

  for (const item of targetRevision.items || []) {
    const op = String(item?.operation || "").toUpperCase();
    if (op === "DDL") continue;
    const identity = normalizeItemRowIdentity(item, primaryKeys, colNameMap);
    if (!identity.complete) continue;

    const idKey = identity.key;
    touchedKeys.add(idKey);
    identityMapByKey.set(idKey, identity.map);

    if (op === "INSERT") {
      insertedKeys.add(idKey);
      // Before this INSERT, the row did not exist
      beforeMap.delete(idKey);
      // If externally deleted later (or beyond live row cap), synthesize into afterMap
      if (!afterMap.has(idKey)) {
        const synthesized = { ...identity.map, ...rowFieldsToObject(item.rowFields, colNameMap) };
        afterMap.set(idKey, synthesized);
        synthesizedKeys.add(idKey);
        ensureInOrder(idKey, synthesized, { sortedInsert: true });
      }
    } else if (op === "DELETE") {
      deletedKeys.add(idKey);
      // After this DELETE, the row does not exist
      afterMap.delete(idKey);
      // Before this DELETE, the row existed with its full old values
      const restoredBefore = { ...identity.map, ...rowFieldsToObject(item.rowFields, colNameMap) };
      beforeMap.set(idKey, restoredBefore);
      ensureInOrder(idKey, restoredBefore, { sortedInsert: true });
    } else {
      // UPDATE
      let afterRow = afterMap.get(idKey);
      let beforeRow = beforeMap.get(idKey);
      if (!afterRow) {
        // Row was deleted externally or outside live row cap — synthesize partial row
        afterRow = { ...identity.map };
        beforeRow = { ...identity.map };
        afterMap.set(idKey, afterRow);
        beforeMap.set(idKey, beforeRow);
        synthesizedKeys.add(idKey);
        ensureInOrder(idKey, afterRow, { sortedInsert: true });
      }
      for (const change of item.changes || []) {
        if (!change?.field) continue;
        const canonical = resolveColumnName(change.field, colNameMap);
        recordTouchedCol(idKey, canonical);
        // Since items inside a revision are newest -> oldest, preserve the newest
        // `after` value if not already set on a synthesized row, and always rewind
        // `before` to the older value.
        if (synthesizedKeys.has(idKey) && !Object.hasOwn(afterRow, canonical)) {
          afterRow[canonical] = rawValueFromDiffPart(change.after);
        }
        beforeRow[canonical] = rawValueFromDiffPart(change.before);
      }
    }
  }

  // Phase C: build aligned comparison rows in stable table order.
  const rows = [];
  const changedRowIndices = [];

  for (const idKey of order) {
    const beforeRow = beforeMap.get(idKey) || null;
    const afterRow = afterMap.get(idKey) || null;
    if (!beforeRow && !afterRow) continue;

    const refRow = afterRow || beforeRow || {};
    const identityObj = identityMapByKey.get(idKey)
      || Object.fromEntries(primaryKeys.map((pk) => [pk, String(refRow?.[pk] ?? "")]));

    let status = "unchanged";
    const changedCols = [];
    const cellDiffs = {};

    if (!beforeRow && afterRow) {
      status = "inserted";
    } else if (beforeRow && !afterRow) {
      status = "deleted";
    } else if (touchedKeys.has(idKey)) {
      const candidateCols = touchedColsByKey.get(idKey) || new Set();
      for (const col of columns) {
        if (!candidateCols.has(col.name)) continue;
        const bVal = Object.hasOwn(beforeRow, col.name) ? beforeRow[col.name] : undefined;
        const aVal = Object.hasOwn(afterRow, col.name) ? afterRow[col.name] : undefined;
        if (cellValuesDiffer(bVal, aVal)) {
          changedCols.push(col.name);
          cellDiffs[col.name] = computeInlineDiff(bVal, aVal);
        }
      }
      // Also include any touched columns not present in current live schema (e.g. dropped column)
      for (const colName of candidateCols) {
        if (changedCols.includes(colName)) continue;
        const bVal = Object.hasOwn(beforeRow, colName) ? beforeRow[colName] : undefined;
        const aVal = Object.hasOwn(afterRow, colName) ? afterRow[colName] : undefined;
        if (cellValuesDiffer(bVal, aVal)) {
          changedCols.push(colName);
          cellDiffs[colName] = computeInlineDiff(bVal, aVal);
        }
      }
      status = changedCols.length > 0 ? "updated" : "unchanged";
    }

    const rowIndex = rows.length;
    if (status !== "unchanged") {
      changedRowIndices.push(rowIndex);
    }

    rows.push({
      id: idKey,
      rowIndex,
      identity: identityObj,
      status,
      synthetic: synthesizedKeys.has(idKey),
      before: beforeRow,
      after: afterRow,
      changedCols,
      cellDiffs,
    });
  }

  return {
    mode: "full-table",
    reason: "",
    columns,
    primaryKeys,
    rows,
    changedRowIndices,
    totalRows: rows.length,
    changedCount: changedRowIndices.length,
    partialReplayWarning,
    hasSynthesizedRows: synthesizedKeys.size > 0,
  };
}

/**
 * Search across visible comparison rows (PKs, before/after cell values, and
 * column names / Chinese column comments). Returns deterministic match targets
 * for amber highlighting and Up/Down/Enter jumping.
 */
export function searchFullTableComparisonRows(displayRows = [], columns = [], rawQuery = "") {
  const query = String(rawQuery || "").trim().toLowerCase();
  const empty = {
    query: "",
    matches: [],
    matchedRowIds: new Set(),
    matchedCellKeys: new Set(),
    matchedHeaderCols: new Set(),
  };
  if (!query) return empty;

  const matchedHeaderCols = new Set();
  for (const col of columns) {
    const nameMatch = String(col?.name || "").toLowerCase().includes(query);
    const commentMatch = String(col?.comment || "").toLowerCase().includes(query);
    if (nameMatch || commentMatch) {
      matchedHeaderCols.add(col.name);
    }
  }

  const matches = [];
  const matchedRowIds = new Set();
  const matchedCellKeys = new Set();

  for (let displayIndex = 0; displayIndex < displayRows.length; displayIndex += 1) {
    const row = displayRows[displayIndex];
    for (let colIndex = 0; colIndex < columns.length; colIndex += 1) {
      const col = columns[colIndex];
      const beforeVal = row.before && Object.hasOwn(row.before, col.name)
        ? normalizeCellDisplay(row.before[col.name]).text
        : "";
      const afterVal = row.after && Object.hasOwn(row.after, col.name)
        ? normalizeCellDisplay(row.after[col.name]).text
        : "";

      const hitBefore = beforeVal.toLowerCase().includes(query);
      const hitAfter = afterVal.toLowerCase().includes(query);
      if (hitBefore || hitAfter) {
        const cellKey = `${row.id}\x1f${col.name}`;
        matchedRowIds.add(row.id);
        matchedCellKeys.add(cellKey);
        matches.push({
          displayIndex,
          rowId: row.id,
          colName: col.name,
          colIndex,
          side: hitAfter && !hitBefore ? "after" : "both",
          kind: "cell",
        });
      }
    }
  }

  // If query matched column headers (field name or Chinese comment), also allow
  // jumping to changed cells in those columns (or row 0 if no changed cell exists).
  if (matchedHeaderCols.size > 0) {
    for (const colName of matchedHeaderCols) {
      const colIndex = columns.findIndex((c) => c.name === colName);
      if (colIndex < 0) continue;
      let addedForCol = false;
      for (let displayIndex = 0; displayIndex < displayRows.length; displayIndex += 1) {
        const row = displayRows[displayIndex];
        if (row.status === "unchanged") continue;
        if (row.status === "updated" && !row.changedCols.includes(colName)) continue;
        const cellKey = `${row.id}\x1f${colName}`;
        if (!matchedCellKeys.has(cellKey)) {
          matchedRowIds.add(row.id);
          matchedCellKeys.add(cellKey);
          matches.push({
            displayIndex,
            rowId: row.id,
            colName,
            colIndex,
            side: "both",
            kind: "column",
          });
        }
        addedForCol = true;
      }
      if (!addedForCol && displayRows.length > 0 && matches.length === 0) {
        const row = displayRows[0];
        matches.push({
          displayIndex: 0,
          rowId: row.id,
          colName,
          colIndex,
          side: "both",
          kind: "header",
        });
      }
    }
  }

  return {
    query,
    matches,
    matchedRowIds,
    matchedCellKeys,
    matchedHeaderCols,
  };
}

/**
 * Split a text string into alternating plain and matched segments for inline
 * search highlighting without raw HTML injection.
 */
export function splitSearchHighlight(text, rawQuery) {
  const source = String(text ?? "");
  const query = String(rawQuery || "").trim();
  if (!query || !source) {
    return [{ text: source, match: false }];
  }
  const lowerSource = source.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts = [];
  let cursor = 0;
  while (cursor < source.length) {
    const found = lowerSource.indexOf(lowerQuery, cursor);
    if (found < 0) {
      parts.push({ text: source.slice(cursor), match: false });
      break;
    }
    if (found > cursor) {
      parts.push({ text: source.slice(cursor, found), match: false });
    }
    parts.push({ text: source.slice(found, found + query.length), match: true });
    cursor = found + query.length;
  }
  return parts;
}
