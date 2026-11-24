import { auditChangeItems, auditChangeSql } from "./auditDisplay.js";

const LEGACY_PLACEHOLDER_SERVER_KEY = "mysql://configured:3306";
const DEFAULT_GROUP_WINDOW_MS = 2500;
const EXTERNAL_NEWER_GRACE_MS = 120_000;
const VALID_STATUSES = new Set(["committed", "rolled_back"]);

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
    const actorInfo = normalizeActor(raw, selfLabel);
    const normalized = {
      ...raw,
      clientId,
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

  for (const raw of Array.isArray(sharedEntries) ? sharedEntries : []) {
    if (!raw || !VALID_STATUSES.has(String(raw.status || ""))) continue;
    const entryServerKey = canonicalRealServerKey(raw.serverKey);
    if (wantedServerKey && entryServerKey && entryServerKey !== wantedServerKey) {
      continue;
    }
    const clientId = String(raw.clientId || "").trim();
    const actorInfo = normalizeActor(raw, selfLabel);
    const existing = clientId ? byClientId.get(clientId) : null;
    if (existing) {
      byClientId.set(clientId, {
        ...existing,
        // Prefer central-server display name/username while preserving local
        // rowIdentity, sessionId, forwardSql, and notes.
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
        tsMs: parseAuditTimestampMs(raw.ts),
        actor: actorInfo.actor,
        username: actorInfo.username,
        isSelfFallback: actorInfo.isSelfFallback,
        origin: "shared",
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
    if (bId !== aId) return bId - aId;
    return String(b.clientId || "").localeCompare(String(a.clientId || ""));
  });
  return merged;
}

function sameRevisionBucket(currentGroup, entry, windowMs) {
  const last = currentGroup._lastEntry;
  if (!last) return false;
  if (currentGroup.items.length >= 500) return false;
  if (last.sessionId && entry.sessionId && last.sessionId === entry.sessionId) {
    return true;
  }
  const sameActor = last.actor.toLowerCase() === entry.actor.toLowerCase();
  const sameSource = String(last.source || "") === String(entry.source || "");
  const sameRollback = Boolean(last.isRollback) === Boolean(entry.isRollback);
  if (!sameActor || !sameSource || !sameRollback) return false;
  return Math.abs(last.tsMs - entry.tsMs) <= windowMs;
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
      accumulateRevisionCounts(current, detailItem);
      if (current.origin !== entry.origin) current.origin = "merged";
      continue;
    }

    const rev = {
      id: `rev-${detailItem.id}-${revisions.length}`,
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
      items: [detailItem],
      _lastEntry: entry,
    };
    accumulateRevisionCounts(rev, detailItem);
    revisions.push(rev);
  }

  return revisions.map(({ _lastEntry, ...rev }) => rev);
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
