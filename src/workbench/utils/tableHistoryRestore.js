import {
  buildIdentityKey,
  normalizeItemRowIdentity,
  normalizeSnapshotColumns,
} from "./tableHistorySnapshot.js";

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

function toWireValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function rawValueFromDiffPart(part) {
  if (!part) return null;
  return part.isNull ? null : String(part.text ?? "");
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

function valuesDiffer(left, right) {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull !== rightNull) return true;
  if (leftNull && rightNull) return false;
  return String(left) !== String(right);
}

function emptyPlan(reason, undoneRevisions = 0) {
  return {
    canRestore: false,
    reason,
    operations: [],
    counts: { insert: 0, update: 0, delete: 0, total: 0 },
    undoneRevisions,
  };
}

/**
 * Compute minimal, deterministic row-level restore operations to transform the
 * current live table back to either:
 *   - target = "before": state immediately BEFORE `revisions[targetIndex]`
 *     (undoes revisions `0 .. targetIndex`)
 *   - target = "after":  state immediately AFTER  `revisions[targetIndex]`
 *     (undoes revisions `0 .. targetIndex - 1`)
 *
 * Works uniformly for local, merged, and teammate shared revisions as long as
 * every revision in the undone range has complete row primary-key identity and
 * no DDL gaps.
 */
export function buildHistoryRestorePlan({
  columns: rawColumns = [],
  primaryKeys: rawPrimaryKeys = [],
  liveRows = [],
  revisions = [],
  targetIndex = 0,
  targetRange = null,
  target = "before",
} = {}) {
  const primaryKeys = Array.isArray(rawPrimaryKeys) ? rawPrimaryKeys.filter(Boolean) : [];
  if (primaryKeys.length === 0) return emptyPlan("no-primary-key");

  const startIndex = targetRange && Number.isInteger(targetRange.startIndex)
    ? targetRange.startIndex
    : targetIndex;
  const endRangeIndex = targetRange && Number.isInteger(targetRange.endIndex)
    ? Math.max(startIndex, targetRange.endIndex)
    : startIndex;

  if (!Array.isArray(revisions) || startIndex < 0 || endRangeIndex >= revisions.length) {
    return emptyPlan("no-revision");
  }
  if (revisions[startIndex]?.isExternal && startIndex === endRangeIndex) {
    return emptyPlan("external-change", 0);
  }

  const endIndex = target === "after" ? startIndex - 1 : endRangeIndex;
  if (endIndex < 0) return emptyPlan("already-current", 0);

  const columns = normalizeSnapshotColumns(rawColumns, primaryKeys);
  const colNameMap = buildColumnNameMap(columns, primaryKeys);
  const writableColumns = columns
    .filter((col) => !col.isGenerated)
    .map((col) => col.name);
  const writableColSet = new Set(writableColumns);

  // Validate every Blackcat revision in [0 .. endIndex] first; external nodes
  // have no field-level diff so we track them for caution notices while the
  // transactional expectedCurrent guard protects against row-level conflicts.
  // Lightweight zero-net-change (NOOP) summary nodes have 0 row ops and pass cleanly.
  let auditRevisionsUndone = 0;
  let crossedExternalTime = "";
  for (let revIdx = 0; revIdx <= endIndex; revIdx += 1) {
    const rev = revisions[revIdx];
    if (rev?.isExternal) {
      if (!crossedExternalTime) crossedExternalTime = String(rev.ts || "");
      continue;
    }
    if (rev?.isNoNetChange) {
      continue;
    }
    auditRevisionsUndone += 1;
    if (rev?.isIncomplete) {
      return emptyPlan("incomplete-revision", auditRevisionsUndone);
    }
    for (const item of rev?.items || []) {
      const op = String(item?.operation || "").toUpperCase();
      if (op === "NOOP") continue;
      if (op === "DDL") return emptyPlan("contains-ddl", auditRevisionsUndone);
      const identity = normalizeItemRowIdentity(item, primaryKeys, colNameMap);
      if (!identity.complete) return emptyPlan("missing-row-identity", auditRevisionsUndone);
    }
  }
  if (auditRevisionsUndone === 0) {
    return emptyPlan("already-current", 0);
  }

  // Index current live rows by canonical PK identity; normalize full column
  // values lazily only for rows actually touched in the undone range.
  const pkLookup = new Map(primaryKeys.map((pk) => [pk.toLowerCase(), pk]));
  const liveRawByKey = new Map();
  for (const rawRow of Array.isArray(liveRows) ? liveRows : []) {
    if (!rawRow || typeof rawRow !== "object") continue;
    let idKey = "";
    if (primaryKeys.every((pk) => Object.hasOwn(rawRow, pk))) {
      idKey = buildIdentityKey(primaryKeys, rawRow);
    } else {
      const pkObj = {};
      for (const [k, v] of Object.entries(rawRow)) {
        const pk = pkLookup.get(String(k || "").trim().toLowerCase());
        if (pk) pkObj[pk] = v;
      }
      idKey = buildIdentityKey(primaryKeys, pkObj);
    }
    liveRawByKey.set(idKey, rawRow);
  }

  const normalizeLiveRow = (rawRow) => {
    const row = {};
    for (const [k, v] of Object.entries(rawRow)) {
      const canonical = resolveColumnName(k, colNameMap);
      row[canonical] = toWireValue(v);
    }
    return row;
  };

  // Walk newest -> oldest across [0 .. endIndex] tracking net row transitions.
  // Order is preserved deterministically by first encounter.
  const trackedOrder = [];
  const tracked = new Map();

  function ensureTracked(idKey, identityMap, fallbackExists, fallbackRow) {
    if (tracked.has(idKey)) return tracked.get(idKey);
    const rawLiveRow = liveRawByKey.get(idKey);
    const liveRow = rawLiveRow ? normalizeLiveRow(rawLiveRow) : null;
    const liveExists = liveRow ? true : Boolean(fallbackExists);
    const currentKnown = liveRow
      ? liveRow
      : (fallbackRow ? { ...fallbackRow } : null);
    const entry = {
      idKey,
      identityMap: { ...identityMap },
      liveExists,
      currentKnown,
      targetExists: liveExists,
      targetRow: currentKnown ? { ...currentKnown } : null,
    };
    tracked.set(idKey, entry);
    trackedOrder.push(idKey);
    return entry;
  }

  for (let revIdx = 0; revIdx <= endIndex; revIdx += 1) {
    const rev = revisions[revIdx];
    if (rev?.isExternal || rev?.isNoNetChange) continue;
    for (const item of rev?.items || []) {
      const op = String(item?.operation || "").toUpperCase();
      if (op === "NOOP") continue;
      const identity = normalizeItemRowIdentity(item, primaryKeys, colNameMap);
      const idKey = identity.key;

      if (op === "INSERT") {
        const rowData = { ...identity.map, ...rowFieldsToObject(item.rowFields, colNameMap) };
        const entry = ensureTracked(idKey, identity.map, true, rowData);
        // Before this INSERT, the row did not exist.
        entry.targetExists = false;
        entry.targetRow = null;
      } else if (op === "DELETE") {
        const rowData = { ...identity.map, ...rowFieldsToObject(item.rowFields, colNameMap) };
        const entry = ensureTracked(idKey, identity.map, false, null);
        // Before this DELETE, the row existed with rowData.
        entry.targetExists = true;
        entry.targetRow = { ...rowData };
      } else {
        // UPDATE
        const entry = ensureTracked(idKey, identity.map, true, { ...identity.map });
        if (!entry.targetRow) {
          entry.targetExists = true;
          entry.targetRow = { ...identity.map };
        }
        for (const change of item.changes || []) {
          if (!change?.field) continue;
          const canonical = resolveColumnName(change.field, colNameMap);
          if (writableColSet.size > 0 && !writableColSet.has(canonical)) continue;
          const afterVal = rawValueFromDiffPart(change.after);
          const beforeVal = rawValueFromDiffPart(change.before);
          if (entry.currentKnown && !Object.hasOwn(entry.currentKnown, canonical)) {
            entry.currentKnown[canonical] = afterVal;
          }
          entry.targetRow[canonical] = beforeVal;
        }
      }
    }
  }

  const operations = [];
  let insertCount = 0;
  let updateCount = 0;
  let deleteCount = 0;

  for (const idKey of trackedOrder) {
    const entry = tracked.get(idKey);
    if (!entry) continue;

    // Inserted then deleted (or vice versa with no net change): skip.
    if (!entry.liveExists && !entry.targetExists) continue;

    if (entry.liveExists && !entry.targetExists) {
      // Currently exists, did not exist at target => DELETE.
      const expectedCurrent = {};
      for (const [col, val] of Object.entries(entry.currentKnown || entry.identityMap)) {
        if (writableColSet.size > 0 && !writableColSet.has(col)) continue;
        expectedCurrent[col] = toWireValue(val);
      }
      operations.push({
        kind: "delete",
        rowIdentity: { ...entry.identityMap },
        expectedCurrent,
        targetValues: {},
      });
      deleteCount += 1;
      continue;
    }

    if (!entry.liveExists && entry.targetExists) {
      // Does not exist now, existed at target => INSERT.
      const targetValues = {};
      for (const col of writableColumns) {
        if (!entry.targetRow || !Object.hasOwn(entry.targetRow, col)) {
          return emptyPlan("incomplete-row-data", endIndex + 1);
        }
        targetValues[col] = toWireValue(entry.targetRow[col]);
      }
      operations.push({
        kind: "insert",
        rowIdentity: { ...entry.identityMap },
        expectedCurrent: {},
        targetValues,
      });
      insertCount += 1;
      continue;
    }

    // Exists in both live and target => UPDATE only changed writable columns.
    const expectedCurrent = {};
    const targetValues = {};
    const candidateCols = new Set([
      ...Object.keys(entry.targetRow || {}),
      ...Object.keys(entry.currentKnown || {}),
    ]);
    for (const col of candidateCols) {
      if (writableColSet.size > 0 && !writableColSet.has(col)) continue;
      if (!entry.currentKnown || !Object.hasOwn(entry.currentKnown, col)) continue;
      if (!entry.targetRow || !Object.hasOwn(entry.targetRow, col)) continue;
      const curVal = toWireValue(entry.currentKnown[col]);
      const tgtVal = toWireValue(entry.targetRow[col]);
      if (valuesDiffer(curVal, tgtVal)) {
        expectedCurrent[col] = curVal;
        targetValues[col] = tgtVal;
      }
    }
    if (Object.keys(targetValues).length === 0) continue;

    operations.push({
      kind: "update",
      rowIdentity: { ...entry.identityMap },
      expectedCurrent,
      targetValues,
    });
    updateCount += 1;
  }

  if (operations.length === 0) {
    return emptyPlan("already-current", auditRevisionsUndone);
  }

  return {
    canRestore: true,
    reason: "",
    operations,
    counts: {
      insert: insertCount,
      update: updateCount,
      delete: deleteCount,
      total: operations.length,
    },
    undoneRevisions: auditRevisionsUndone,
    crossedExternalTime,
  };
}
