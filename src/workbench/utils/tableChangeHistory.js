import { auditChangeItems, auditChangeSql } from "./auditDisplay.js";

const LEGACY_PLACEHOLDER_SERVER_KEY = "mysql://configured:3306";
const DEFAULT_GROUP_WINDOW_MS = 2500;
const EXTERNAL_NEWER_GRACE_MS = 120_000;
const EXACT_AUDIT_MATCH_BEFORE_MS = 5_000;
const EXACT_AUDIT_MATCH_AFTER_MS = 12_000;
const DETECTED_AUDIT_MATCH_BEFORE_MS = 15_000;
const DETECTED_AUDIT_MATCH_AFTER_MS = 90_000;
const EXACT_COALESCE_WINDOW_MS = 5_000;
const DETECTED_COALESCE_WINDOW_MS = 90_000;
const VALID_STATUSES = new Set(["committed", "rolled_back"]);

export const EXTERNAL_ACTOR_FILTER = "__external__";

export function parseAuditTimestampMs(raw) {
  const text = String(raw || "").trim();
  if (!text) return 0;
  // Normalize space-separated timestamps ("YYYY-MM-DD HH:mm:ss") for Date.parse
  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(text)
    ? text.replace(" ", "T")
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function canonicalRealServerKey(raw) {
  const trimmed = String(raw || "").trim().toLowerCase();
  if (!trimmed || trimmed === LEGACY_PLACEHOLDER_SERVER_KEY) return "";
  return trimmed;
}

function tryParseJson(raw) {
  if (raw == null || raw === "") return raw;
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

export function normalizeCellDisplay(value) {
  if (value === null || value === undefined) {
    return { text: "NULL", isNull: true, isEmpty: false };
  }
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return { text: json, isNull: false, isEmpty: json === "" };
  }
  const text = String(value);
  return { text, isNull: false, isEmpty: text === "" };
}

const PURE_NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const ASCII_WORD_RE = /^[A-Za-z0-9_]$/;

/**
 * Compute lightweight Unicode-safe inline diff spans using longest common
 * prefix + suffix snapped to word/number token boundaries. Pure numeric cells
 * stay whole (e.g. 1280 -> 1450), while structured strings (e.g. item lists,
 * formulas, descriptions) highlight the exact changed token (e.g. 200 -> 350).
 */
export function computeInlineDiff(beforeRaw, afterRaw) {
  const before = normalizeCellDisplay(beforeRaw);
  const after = normalizeCellDisplay(afterRaw);

  if (
    before.isNull
    || after.isNull
    || before.isEmpty
    || after.isEmpty
    || before.text === after.text
    || (PURE_NUMBER_RE.test(before.text) && PURE_NUMBER_RE.test(after.text))
  ) {
    return {
      before: { ...before, prefix: "", changed: before.text, suffix: "", hasHighlight: false },
      after: { ...after, prefix: "", changed: after.text, suffix: "", hasHighlight: false },
    };
  }

  const a = Array.from(before.text);
  const b = Array.from(after.text);
  const maxPrefix = Math.min(a.length, b.length);
  let prefixLen = 0;
  while (prefixLen < maxPrefix && a[prefixLen] === b[prefixLen]) {
    prefixLen += 1;
  }

  // Snap prefix back to token boundary so we never split inside an ASCII word or number.
  if (prefixLen > 0 && prefixLen < a.length && prefixLen < b.length) {
    if (
      ASCII_WORD_RE.test(a[prefixLen - 1])
      && (ASCII_WORD_RE.test(a[prefixLen]) || ASCII_WORD_RE.test(b[prefixLen]))
    ) {
      while (prefixLen > 0 && ASCII_WORD_RE.test(a[prefixLen - 1])) {
        prefixLen -= 1;
      }
    }
  }

  const maxSuffix = Math.min(a.length - prefixLen, b.length - prefixLen);
  let suffixLen = 0;
  while (
    suffixLen < maxSuffix
    && a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]
  ) {
    suffixLen += 1;
  }

  // Snap suffix forward to token boundary so we never split inside an ASCII word or number.
  if (suffixLen > 0) {
    const aPrev = a.length - suffixLen - 1;
    const bPrev = b.length - suffixLen - 1;
    if (
      ASCII_WORD_RE.test(a[a.length - suffixLen])
      && (
        (aPrev >= prefixLen && ASCII_WORD_RE.test(a[aPrev]))
        || (bPrev >= prefixLen && ASCII_WORD_RE.test(b[bPrev]))
      )
    ) {
      while (suffixLen > 0 && ASCII_WORD_RE.test(a[a.length - suffixLen])) {
        suffixLen -= 1;
      }
    }
  }

  const sharedLen = prefixLen + suffixLen;
  const beforeChanged = a.slice(prefixLen, a.length - suffixLen).join("");
  const afterChanged = b.slice(prefixLen, b.length - suffixLen).join("");
  const hasMeaningfulContext = sharedLen >= 2 && (beforeChanged.length > 0 || afterChanged.length > 0);

  if (!hasMeaningfulContext) {
    return {
      before: { ...before, prefix: "", changed: before.text, suffix: "", hasHighlight: false },
      after: { ...after, prefix: "", changed: after.text, suffix: "", hasHighlight: false },
    };
  }

  const prefix = a.slice(0, prefixLen).join("");
  const suffix = suffixLen > 0 ? a.slice(a.length - suffixLen).join("") : "";
  return {
    before: { ...before, prefix, changed: beforeChanged, suffix, hasHighlight: beforeChanged.length > 0 },
    after: { ...after, prefix, changed: afterChanged, suffix, hasHighlight: afterChanged.length > 0 },
  };
}

export function extractEntryChanges(entry) {
  const operation = String(entry?.operation || "").toUpperCase();
  const rowIdentity = entry?.rowIdentity && typeof entry.rowIdentity === "object"
    ? Object.entries(entry.rowIdentity).map(([key, value]) => ({
        key,
        value: value === null || value === undefined ? "NULL" : String(value),
      }))
    : [];

  if (operation === "DDL") {
    return {
      operation,
      rowIdentity,
      changes: [],
      rowFields: [],
      ddlItems: auditChangeItems(entry),
      forwardSql: auditChangeSql(entry),
    };
  }

  if (operation === "INSERT" || operation === "DELETE") {
    const raw = operation === "INSERT" ? entry?.newValue : entry?.oldValue;
    const parsed = tryParseJson(raw);
    let rowFields = [];
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      rowFields = Object.entries(parsed).map(([field, val]) => ({
        field,
        value: normalizeCellDisplay(val),
      }));
    } else if (raw != null && raw !== "") {
      rowFields = [{ field: "", value: normalizeCellDisplay(raw) }];
    }
    return {
      operation,
      rowIdentity,
      changes: [],
      rowFields,
      ddlItems: [],
      forwardSql: "",
    };
  }

  // UPDATE or other row/cell edits
  const changes = [];
  if (entry?.columnName) {
    changes.push({
      field: String(entry.columnName),
      ...computeInlineDiff(entry.oldValue, entry.newValue),
    });
  } else {
    const oldObj = tryParseJson(entry?.oldValue);
    const newObj = tryParseJson(entry?.newValue);
    const oldIsObj = oldObj && typeof oldObj === "object" && !Array.isArray(oldObj);
    const newIsObj = newObj && typeof newObj === "object" && !Array.isArray(newObj);
    if (oldIsObj || newIsObj) {
      const keys = new Set([
        ...Object.keys(oldIsObj ? oldObj : {}),
        ...Object.keys(newIsObj ? newObj : {}),
      ]);
      for (const field of keys) {
        const beforeVal = oldIsObj ? oldObj[field] : undefined;
        const afterVal = newIsObj ? newObj[field] : undefined;
        if (normalizeCellDisplay(beforeVal).text === normalizeCellDisplay(afterVal).text
          && (beforeVal === null) === (afterVal === null)) {
          continue;
        }
        changes.push({
          field,
          ...computeInlineDiff(beforeVal, afterVal),
        });
      }
    } else if (entry?.oldValue != null || entry?.newValue != null) {
      changes.push({
        field: "",
        ...computeInlineDiff(entry.oldValue, entry.newValue),
      });
    }
  }

  return {
    operation: operation || "UPDATE",
    rowIdentity,
    changes,
    rowFields: [],
    ddlItems: [],
    forwardSql: String(entry?.forwardSql || "").trim(),
  };
}

function normalizeActor(entry, selfLabel) {
  const displayName = String(entry?.displayName || "").trim();
  const username = String(entry?.username || "").trim();
  const localActor = String(entry?.actor || "").trim();
  const actor = displayName || username || localActor || selfLabel;
  return {
    actor,
    username: username || "",
    isSelfFallback: !displayName && !username && !localActor,
  };
}

/**
 * Merge local SQLite audit entries and central-server shared entries into one
 * deduplicated list (deduping by clientId while keeping local rowIdentity /
 * sessionId / SQL metadata and preferring the shared display name).
 */
export function mergeTableAuditEntries({
  localEntries = [],
  sharedEntries = [],
  selfLabel = "我",
  serverKey = "",
} = {}) {
  const wantedServerKey = canonicalRealServerKey(serverKey);
  const byClientId = new Map();
  const withoutClientId = [];

  for (const raw of Array.isArray(localEntries) ? localEntries : []) {
    if (!raw || !VALID_STATUSES.has(String(raw.status || ""))) continue;
    const clientId = String(raw.clientId || "").trim();
    const operationId = String(raw.operationId ?? raw.operation_id ?? "").trim();
    const operationSize = Math.max(0, Number(raw.operationSize ?? raw.operation_size) || 0);
    const actorInfo = normalizeActor(raw, selfLabel);
    const normalized = {
      ...raw,
      clientId,
      operationId,
      operationSize,
      tsMs: parseAuditTimestampMs(raw.ts),
      actor: actorInfo.actor,
      username: actorInfo.username,
      isSelfFallback: actorInfo.isSelfFallback,
      origin: "local",
    };
    if (clientId) {
      byClientId.set(clientId, normalized);
    } else {
      withoutClientId.push(normalized);
    }
  }

  const safeShared = Array.isArray(sharedEntries) ? sharedEntries : [];
  for (let sharedIndex = 0; sharedIndex < safeShared.length; sharedIndex += 1) {
    const raw = safeShared[sharedIndex];
    if (!raw || !VALID_STATUSES.has(String(raw.status || ""))) continue;
    const entryServerKey = canonicalRealServerKey(raw.serverKey);
    if (wantedServerKey && entryServerKey && entryServerKey !== wantedServerKey) {
      continue;
    }
    const clientId = String(raw.clientId || "").trim();
    const operationId = String(raw.operationId ?? raw.operation_id ?? "").trim();
    const operationSize = Math.max(0, Number(raw.operationSize ?? raw.operation_size) || 0);
    const actorInfo = normalizeActor(raw, selfLabel);
    const existing = clientId ? byClientId.get(clientId) : null;
    if (existing) {
      byClientId.set(clientId, {
        ...existing,
        operationId: existing.operationId || operationId,
        operationSize: Math.max(existing.operationSize || 0, operationSize),
        // Prefer central-server display name/username while preserving local
        // rowIdentity, forwardSql, and notes.
        displayName: raw.displayName || existing.displayName,
        username: actorInfo.username || existing.username,
        actor: actorInfo.isSelfFallback ? existing.actor : actorInfo.actor,
        isSelfFallback: actorInfo.isSelfFallback && existing.isSelfFallback,
        origin: "merged",
      });
    } else {
      const normalized = {
        ...raw,
        clientId,
        operationId,
        operationSize,
        tsMs: parseAuditTimestampMs(raw.ts),
        actor: actorInfo.actor,
        username: actorInfo.username,
        isSelfFallback: actorInfo.isSelfFallback,
        origin: "shared",
        _sharedOrder: sharedIndex,
      };
      if (clientId) {
        byClientId.set(clientId, normalized);
      } else {
        withoutClientId.push(normalized);
      }
    }
  }

  const merged = [...byClientId.values(), ...withoutClientId];
  merged.sort((a, b) => {
    if (b.tsMs !== a.tsMs) return b.tsMs - a.tsMs;
    const aId = Number(a.id) || 0;
    const bId = Number(b.id) || 0;
    if (aId > 0 && bId > 0 && bId !== aId) return bId - aId;
    if (Number.isInteger(a._sharedOrder) && Number.isInteger(b._sharedOrder) && a._sharedOrder !== b._sharedOrder) {
      return a._sharedOrder - b._sharedOrder;
    }
    return String(b.clientId || "").localeCompare(String(a.clientId || ""));
  });
  return merged.map(({ _sharedOrder, ...entry }) => entry);
}

function sameRevisionBucket(currentGroup, entry, windowMs) {
  const last = currentGroup._lastEntry;
  if (!last) return false;
  const lastOpId = String(last.operationId || "").trim();
  const entryOpId = String(entry.operationId || "").trim();
  if (lastOpId || entryOpId) {
    return Boolean(lastOpId && entryOpId && lastOpId === entryOpId);
  }
  const sameActor = String(last.actor || "").toLowerCase() === String(entry.actor || "").toLowerCase();
  const sameSource = String(last.source || "") === String(entry.source || "");
  const sameRollback = Boolean(last.isRollback) === Boolean(entry.isRollback);
  if (!sameActor || !sameSource || !sameRollback) return false;
  return Math.abs((last.tsMs || 0) - (entry.tsMs || 0)) <= windowMs;
}

/**
 * Compute the unclosed boundary horizon for a paginated raw audit stream
 * ordered newest-first (`ts DESC`). When `hasMore` is true, the last revision
 * bucket touching the page tail may continue on the next page, so its maximum
 * timestamp defines the safe horizon above which this stream is 100% complete.
 */
export function inspectStreamRevisionHorizon(
  rawEntries = [],
  hasMore = false,
  { selfLabel = "我", windowMs = DEFAULT_GROUP_WINDOW_MS } = {},
) {
  if (!hasMore) {
    return {
      groupCount: 0,
      closedGroupCount: 0,
      horizonMs: Number.NEGATIVE_INFINITY,
    };
  }
  const groups = [];
  for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
    if (!raw || !VALID_STATUSES.has(String(raw.status || ""))) continue;
    const actorInfo = normalizeActor(raw, selfLabel);
    const entry = {
      operationId: String(raw.operationId ?? raw.operation_id ?? "").trim(),
      actor: actorInfo.actor,
      source: raw.source || "",
      isRollback: Boolean(raw.isRollback),
      tsMs: parseAuditTimestampMs(raw.ts),
    };
    const current = groups[groups.length - 1];
    if (current && sameRevisionBucket(current, entry, windowMs)) {
      current._lastEntry = entry;
      if (entry.tsMs > current.maxTsMs) current.maxTsMs = entry.tsMs;
      continue;
    }
    groups.push({
      maxTsMs: entry.tsMs,
      _lastEntry: entry,
    });
  }
  if (groups.length <= 1) {
    return {
      groupCount: groups.length,
      closedGroupCount: 0,
      horizonMs: Number.POSITIVE_INFINITY,
    };
  }
  const tailGroup = groups[groups.length - 1];
  return {
    groupCount: groups.length,
    closedGroupCount: groups.length - 1,
    horizonMs: tailGroup.maxTsMs,
  };
}

/**
 * Group merged chronological audit entries into human-readable "revisions"
 * ("一次修改") so multi-row Excel imports or multi-cell saves appear as one
 * timeline item with all individual row/field diffs neatly organized inside.
 */
export function groupAuditRevisions(entries = [], { windowMs = DEFAULT_GROUP_WINDOW_MS } = {}) {
  const revisions = [];

  for (const entry of entries) {
    const parsed = extractEntryChanges(entry);
    const entryOpId = String(entry.operationId ?? entry.operation_id ?? "").trim();
    const entryOpSize = Math.max(0, Number(entry.operationSize ?? entry.operation_size) || 0);
    const detailItem = {
      id: entry.clientId || `local-${entry.id || revisions.length}`,
      ts: entry.ts,
      tsMs: entry.tsMs,
      operation: parsed.operation,
      status: entry.status,
      source: entry.source || "",
      isRollback: Boolean(entry.isRollback),
      notes: String(entry.notes || "").trim(),
      rowIdentity: parsed.rowIdentity,
      changes: parsed.changes,
      rowFields: parsed.rowFields,
      ddlItems: parsed.ddlItems,
      forwardSql: parsed.forwardSql,
    };

    const current = revisions[revisions.length - 1];
    if (current && sameRevisionBucket(current, entry, windowMs)) {
      current.items.push(detailItem);
      current._lastEntry = entry;
      if (entryOpSize > current.expectedEntryCount) {
        current.expectedEntryCount = entryOpSize;
      }
      if (entry._forceIncomplete) {
        current._forceIncomplete = true;
      }
      accumulateRevisionCounts(current, detailItem);
      if (current.origin !== entry.origin) current.origin = "merged";
      continue;
    }

    const rev = {
      id: `rev-${detailItem.id}-${revisions.length}`,
      kind: "audit",
      isExternal: false,
      operationId: entryOpId,
      ts: entry.ts,
      tsMs: entry.tsMs,
      actor: entry.actor,
      username: entry.username || "",
      isSelfFallback: Boolean(entry.isSelfFallback),
      source: entry.source || "",
      isRollback: Boolean(entry.isRollback),
      origin: entry.origin || "local",
      counts: { update: 0, insert: 0, delete: 0, ddl: 0 },
      fieldChangeCount: 0,
      entryCount: 0,
      expectedEntryCount: entryOpSize,
      items: [detailItem],
      _forceIncomplete: Boolean(entry._forceIncomplete),
      _lastEntry: entry,
    };
    accumulateRevisionCounts(rev, detailItem);
    revisions.push(rev);
  }

  return revisions.map(({ _lastEntry, _forceIncomplete, ...rev }) => ({
    ...rev,
    isIncomplete: Boolean(
      _forceIncomplete
      || (rev.expectedEntryCount > 0 && rev.entryCount < rev.expectedEntryCount),
    ),
  }));
}

function accumulateRevisionCounts(rev, item) {
  rev.entryCount += 1;
  if (item.operation === "INSERT") {
    rev.counts.insert += 1;
    rev.fieldChangeCount += Math.max(1, item.rowFields.length);
  } else if (item.operation === "DELETE") {
    rev.counts.delete += 1;
    rev.fieldChangeCount += Math.max(1, item.rowFields.length);
  } else if (item.operation === "DDL") {
    rev.counts.ddl += 1;
    rev.fieldChangeCount += Math.max(1, item.ddlItems.length);
  } else {
    rev.counts.update += 1;
    rev.fieldChangeCount += Math.max(1, item.changes.length);
  }
}

/**
 * Determine whether the table's latest observed database modification time is
 * genuinely newer than the newest Blackcat / shared audit revision (meaning an
 * external tool like Navicat or a script edited it after the last Blackcat edit).
 */
export function detectExternalNewerModification(tableMeta, revisions = []) {
  const modifiedAt = String(tableMeta?.modifiedAt ?? tableMeta?.modified_at ?? "").trim();
  const source = String(tableMeta?.modifiedSource ?? tableMeta?.modified_source ?? "").trim();
  if (!modifiedAt || (source !== "database" && source !== "external")) {
    return null;
  }
  const tableMs = parseAuditTimestampMs(modifiedAt);
  if (!tableMs) return null;
  const newestAuditMs = revisions[0]?.tsMs || 0;
  if (newestAuditMs > 0 && tableMs <= newestAuditMs + EXTERNAL_NEWER_GRACE_MS) {
    return null;
  }
  return {
    modifiedAt,
    source,
  };
}

function normalizeExternalTimeKind(raw) {
  return String(raw || "").toLowerCase() === "exact" ? "exact" : "detected";
}

function normalizeExternalSignal(raw, timeKind) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "create_time" || s === "write_count" || s === "update_time") return s;
  return timeKind === "exact" ? "update_time" : "write_count";
}

function externalMatchesAnyAuditRevision(ext, auditRevisions) {
  for (const rev of Array.isArray(auditRevisions) ? auditRevisions : []) {
    const auditMs = Number(rev?.tsMs || parseAuditTimestampMs(rev?.ts));
    if (!auditMs) continue;
    if (ext.timeKind === "exact") {
      if (
        ext.tsMs >= auditMs - EXACT_AUDIT_MATCH_BEFORE_MS
        && ext.tsMs <= auditMs + EXACT_AUDIT_MATCH_AFTER_MS
      ) {
        return true;
      }
    } else if (
      ext.tsMs >= auditMs - DETECTED_AUDIT_MATCH_BEFORE_MS
      && ext.tsMs <= auditMs + DETECTED_AUDIT_MATCH_AFTER_MS
    ) {
      return true;
    }
  }
  return false;
}

const ORIGIN_RANK = { merged: 3, shared: 2, local: 1, observed: 0 };

/**
 * Merge local & team-shared external (non-Blackcat) table change events,
 * deduplicate cross-workstation reports, include the current database
 * `tableMeta` fallback when untouched, and suppress any event already explained
 * by a Blackcat audit revision.
 */
export function mergeTableExternalChanges({
  localEntries = [],
  sharedEntries = [],
  tableMeta = null,
  auditRevisions = [],
  serverKey = "",
} = {}) {
  const wantedServerKey = canonicalRealServerKey(serverKey);
  const byEventId = new Map();

  const ingest = (list, defaultOrigin) => {
    for (const raw of Array.isArray(list) ? list : []) {
      if (!raw || typeof raw !== "object") continue;
      const entryServerKey = canonicalRealServerKey(raw.serverKey ?? raw.server_key);
      if (wantedServerKey && entryServerKey && entryServerKey !== wantedServerKey) {
        continue;
      }
      const rawTs = String(raw.ts || "").trim();
      const tsMs = Number(raw.tsMs ?? raw.ts_ms) || parseAuditTimestampMs(rawTs);
      if (!tsMs) continue;
      const timeKind = normalizeExternalTimeKind(raw.timeKind ?? raw.time_kind);
      const signal = normalizeExternalSignal(raw.signal, timeKind);
      const eventId = String(raw.eventId ?? raw.event_id ?? `${defaultOrigin}-${tsMs}`).trim();
      const origin = String(raw.origin || defaultOrigin);
      const existing = byEventId.get(eventId);
      if (existing) {
        const mergedOrigin = existing.origin === origin ? origin : "merged";
        const preferIncoming = timeKind === "exact" && existing.timeKind !== "exact";
        byEventId.set(eventId, {
          ...existing,
          ...(preferIncoming ? { ts: rawTs || existing.ts, tsMs, timeKind, signal } : {}),
          origin: mergedOrigin,
        });
      } else {
        byEventId.set(eventId, {
          eventId,
          ts: rawTs || new Date(tsMs).toISOString(),
          tsMs,
          timeKind,
          signal,
          origin,
        });
      }
    }
  };

  ingest(localEntries, "local");
  ingest(sharedEntries, "shared");

  // Process exact events before approximate ("detected") events so exact DB
  // timestamps always absorb nearby approximate discoveries.
  const candidates = [...byEventId.values()].sort((a, b) => {
    if (a.timeKind !== b.timeKind) return a.timeKind === "exact" ? -1 : 1;
    return a.tsMs - b.tsMs;
  });

  const deduped = [];
  for (const item of candidates) {
    if (item.timeKind === "exact") {
      const dupIdx = deduped.findIndex(
        (kept) => kept.timeKind === "exact" && Math.abs(kept.tsMs - item.tsMs) <= EXACT_COALESCE_WINDOW_MS,
      );
      if (dupIdx >= 0) {
        const kept = deduped[dupIdx];
        if ((ORIGIN_RANK[item.origin] || 0) > (ORIGIN_RANK[kept.origin] || 0)) {
          deduped[dupIdx] = { ...kept, origin: item.origin === kept.origin ? kept.origin : "merged" };
        }
        continue;
      }
      deduped.push(item);
    } else {
      const coveredByExact = deduped.some(
        (kept) => kept.timeKind === "exact"
          && kept.tsMs <= item.tsMs + DETECTED_AUDIT_MATCH_BEFORE_MS
          && item.tsMs <= kept.tsMs + DETECTED_COALESCE_WINDOW_MS,
      );
      if (coveredByExact) continue;
      const dupIdx = deduped.findIndex(
        (kept) => kept.timeKind !== "exact" && Math.abs(kept.tsMs - item.tsMs) <= DETECTED_COALESCE_WINDOW_MS,
      );
      if (dupIdx >= 0) {
        const kept = deduped[dupIdx];
        const mergedOrigin = kept.origin === item.origin ? kept.origin : "merged";
        deduped[dupIdx] = item.tsMs < kept.tsMs
          ? { ...item, origin: mergedOrigin }
          : { ...kept, origin: mergedOrigin };
        continue;
      }
      deduped.push(item);
    }
  }

  // Fallback to current live `tableMeta` when a table has an observed database/
  // external modification not yet recorded in `table_external_changes` (e.g. an
  // untouched table that was edited outside Blackcat before first open).
  const metaModifiedAt = String(tableMeta?.modifiedAt ?? tableMeta?.modified_at ?? "").trim();
  const metaSource = String(tableMeta?.modifiedSource ?? tableMeta?.modified_source ?? "").trim();
  if (metaModifiedAt && (metaSource === "database" || metaSource === "external")) {
    const tableMs = parseAuditTimestampMs(metaModifiedAt);
    const newestAuditMs = auditRevisions.reduce(
      (max, rev) => Math.max(max, Number(rev?.tsMs || parseAuditTimestampMs(rev?.ts)) || 0),
      0,
    );
    const notShadowedByAudit = !(newestAuditMs > 0 && tableMs <= newestAuditMs + EXTERNAL_NEWER_GRACE_MS);
    const alreadyCovered = deduped.some((kept) => (
      metaSource === "database"
        ? Math.abs(kept.tsMs - tableMs) <= EXACT_COALESCE_WINDOW_MS
        : Math.abs(kept.tsMs - tableMs) <= DETECTED_COALESCE_WINDOW_MS
    ));
    if (tableMs > 0 && notShadowedByAudit && !alreadyCovered) {
      const timeKind = metaSource === "external" ? "detected" : "exact";
      deduped.push({
        eventId: `observed-${tableMs}`,
        ts: metaModifiedAt,
        tsMs: tableMs,
        timeKind,
        signal: metaSource === "external" ? "write_count" : "update_time",
        origin: "observed",
      });
    }
  }

  return deduped
    .filter((item) => !externalMatchesAnyAuditRevision(item, auditRevisions))
    .sort((a, b) => b.tsMs - a.tsMs || String(b.eventId).localeCompare(String(a.eventId)))
    .map((item) => ({
      id: `ext-${item.eventId}`,
      kind: "external",
      isExternal: true,
      eventId: item.eventId,
      ts: item.ts,
      tsMs: item.tsMs,
      actor: "",
      username: "",
      isSelfFallback: false,
      source: "external",
      timeKind: item.timeKind,
      signal: item.signal,
      isRollback: false,
      origin: item.origin,
      counts: { update: 0, insert: 0, delete: 0, ddl: 0 },
      fieldChangeCount: 0,
      entryCount: 0,
      items: [],
    }));
}

/**
 * Interleave Blackcat audit revisions and detected external change revisions in
 * newest-first chronological order for the single-table change timeline.
 */
export function mergeTimelineRevisions(auditRevisions = [], externalRevisions = []) {
  const normalizedAudit = (Array.isArray(auditRevisions) ? auditRevisions : []).map((rev) => (
    rev?.kind ? rev : { ...rev, kind: "audit", isExternal: false }
  ));
  const combined = [...normalizedAudit, ...(Array.isArray(externalRevisions) ? externalRevisions : [])];
  combined.sort((a, b) => {
    const aMs = Number(a?.tsMs || parseAuditTimestampMs(a?.ts)) || 0;
    const bMs = Number(b?.tsMs || parseAuditTimestampMs(b?.ts)) || 0;
    if (bMs !== aMs) return bMs - aMs;
    if (Boolean(a?.isExternal) !== Boolean(b?.isExternal)) {
      return a?.isExternal ? -1 : 1;
    }
    return String(b?.id || "").localeCompare(String(a?.id || ""));
  });
  return combined;
}

/**
 * Return the newest external change that occurred strictly after
 * `revisions[targetIndex]`, or null when none intervened.
 */
export function findNewerExternalRevision(revisions = [], targetIndex = -1) {
  if (!Array.isArray(revisions) || targetIndex <= 0) return null;
  for (let i = 0; i < targetIndex && i < revisions.length; i += 1) {
    if (revisions[i]?.isExternal) return revisions[i];
  }
  return null;
}

export function filterRevisionItems(items = [], rawQuery = "", columnComments = null) {
  const query = String(rawQuery || "").trim().toLowerCase();
  if (!query) return items;

  const matchesText = (value) => String(value || "").toLowerCase().includes(query);
  const filtered = [];

  for (const item of items) {
    const identityMatches = item.rowIdentity.some(
      (part) => matchesText(part.key) || matchesText(part.value),
    );
    const notesMatches = matchesText(item.notes) || matchesText(item.forwardSql);

    if (item.operation === "DDL") {
      const ddlMatches = item.ddlItems.filter((desc) => matchesText(desc));
      if (ddlMatches.length || notesMatches) {
        filtered.push({ ...item, ddlItems: ddlMatches.length ? ddlMatches : item.ddlItems });
      }
      continue;
    }

    if (item.operation === "INSERT" || item.operation === "DELETE") {
      if (identityMatches || notesMatches) {
        filtered.push(item);
        continue;
      }
      const fieldMatches = item.rowFields.filter((row) => (
        matchesText(row.field)
        || matchesText(columnComments?.get?.(row.field.toLowerCase()))
        || matchesText(row.value?.text)
      ));
      if (fieldMatches.length) {
        filtered.push({ ...item, rowFields: fieldMatches });
      }
      continue;
    }

    if (identityMatches || notesMatches) {
      filtered.push(item);
      continue;
    }
    const matchedChanges = item.changes.filter((change) => (
      matchesText(change.field)
      || matchesText(columnComments?.get?.(change.field.toLowerCase()))
      || matchesText(change.before?.text)
      || matchesText(change.after?.text)
    ));
    if (matchedChanges.length) {
      filtered.push({ ...item, changes: matchedChanges });
    }
  }

  return filtered;
}
