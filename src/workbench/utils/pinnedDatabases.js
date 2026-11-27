// 常驻数据库（pinned databases）持久化：用户在 Ctrl+P 浮层里把某些数据库
// 标记为"常驻显示"，跨连接混合展示，方便快速切换。
//
// 结构：[{ connectionId, database }]，顺序即展示顺序。
// 真实的 connectionId / database 仍是后端调用的唯一标识，这里只存选择意向。

import { previewDragOrder } from "../sidebarDragPreview.js";
import {
  normalizeRailColor,
  normalizeRailIcon,
  normalizeRailText,
  railDatabaseId,
} from "./railDatabaseGlyph.js";
import { isRailGroupId } from "./railDatabaseGroups.js";

const PINNED_DATABASES_KEY = "dbscout_pinned_databases";

function readJsonStorage(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

function sameEntry(left, right) {
  return (
    String(left?.connectionId || "") === String(right?.connectionId || "") &&
    String(left?.database || "") === String(right?.database || "")
  );
}

function normalizeEntry(entry) {
  const connectionId = String(entry?.connectionId || "").trim();
  const database = String(entry?.database || "").trim();
  if (!database) return null;
  const normalized = { connectionId, database };
  const shortcut = String(entry?.shortcut || "").trim();
  if (shortcut) normalized.shortcut = shortcut;
  if (entry?.rail) normalized.rail = true;
  if (entry?.rail && isRailGroupId(entry?.railGroup)) normalized.railGroup = entry.railGroup;
  const railIcon = normalizeRailIcon(entry?.railIcon);
  const railText = normalizeRailText(entry?.railText);
  if (railIcon) normalized.railIcon = railIcon;
  else if (railText) normalized.railText = railText;
  const railColor = normalizeRailColor(entry?.railColor);
  if (railColor) normalized.railColor = railColor;
  return normalized;
}

export function normalizePinnedDatabases(list) {
  const normalized = [];
  for (const rawEntry of Array.isArray(list) ? list : []) {
    const entry = normalizeEntry(rawEntry);
    if (!entry || normalized.some((candidate) => sameEntry(candidate, entry))) continue;
    normalized.push(entry);
  }
  return normalized;
}

export function readPinnedDatabases() {
  const list = readJsonStorage(PINNED_DATABASES_KEY, []);
  return normalizePinnedDatabases(list);
}

export function writePinnedDatabases(list) {
  writeJsonStorage(
    PINNED_DATABASES_KEY,
    normalizePinnedDatabases(list),
  );
}

export function isPinnedDatabase(connectionId, database, list = null) {
  const entries = list || readPinnedDatabases();
  return entries.some((e) => sameEntry(e, { connectionId, database }));
}

export function togglePinnedDatabase(connectionId, database, list = null) {
  const entries = normalizePinnedDatabases(list || readPinnedDatabases());
  const idx = entries.findIndex((e) => sameEntry(e, { connectionId, database }));
  if (idx >= 0) {
    entries.splice(idx, 1);
  } else {
    entries.push({ connectionId: String(connectionId || ""), database: String(database || "") });
  }
  writePinnedDatabases(entries);
  return entries;
}

export function addPinnedDatabase(connectionId, database, list = null) {
  const entries = normalizePinnedDatabases(list || readPinnedDatabases());
  const entry = normalizeEntry({ connectionId, database });
  if (!entry || entries.some((candidate) => sameEntry(candidate, entry))) return entries;
  entries.push(entry);
  writePinnedDatabases(entries);
  return entries;
}

export function removePinnedDatabase(connectionId, database, list = null) {
  const entries = normalizePinnedDatabases(list || readPinnedDatabases());
  const next = entries.filter((entry) => !sameEntry(entry, { connectionId, database }));
  if (next.length !== entries.length) writePinnedDatabases(next);
  return next;
}

export function setPinnedDatabaseShortcut(connectionId, database, shortcut, list = null) {
  const entries = normalizePinnedDatabases(list || readPinnedDatabases());
  const normalizedShortcut = String(shortcut || "").trim();
  const next = entries.map((entry) => {
    if (!sameEntry(entry, { connectionId, database })) return entry;
    const updated = { ...entry };
    if (normalizedShortcut) updated.shortcut = normalizedShortcut;
    else delete updated.shortcut;
    return updated;
  });
  writePinnedDatabases(next);
  return next;
}

export function setPinnedDatabaseRail(connectionId, database, rail, list = null, { color = "" } = {}) {
  const entries = normalizePinnedDatabases(list || readPinnedDatabases());
  const index = entries.findIndex((entry) => sameEntry(entry, { connectionId, database }));
  const normalizedColor = normalizeRailColor(color);
  if (index < 0) {
    if (!rail) return entries;
    const entry = normalizeEntry({ connectionId, database, rail: true, railColor: normalizedColor });
    if (!entry) return entries;
    entries.push(entry);
    writePinnedDatabases(entries);
    return entries;
  }
  const entry = { ...entries[index] };
  if (rail) {
    entry.rail = true;
    if (!entry.railColor && normalizedColor) entry.railColor = normalizedColor;
  } else {
    delete entry.rail;
    delete entry.railGroup;
  }
  entries[index] = entry;
  writePinnedDatabases(entries);
  return entries;
}

export function setPinnedDatabaseRailAppearance(connectionId, database, { icon, text, color } = {}, list = null) {
  const entries = normalizePinnedDatabases(list || readPinnedDatabases());
  const index = entries.findIndex((entry) => sameEntry(entry, { connectionId, database }));
  if (index < 0) return entries;
  const entry = { ...entries[index] };
  const normalizedColor = color === undefined ? undefined : normalizeRailColor(color);
  const normalizedIcon = icon === undefined ? undefined : normalizeRailIcon(icon);
  const normalizedText = text === undefined ? undefined : normalizeRailText(text);
  if (normalizedColor !== undefined) {
    if (normalizedColor) entry.railColor = normalizedColor;
    else delete entry.railColor;
  }
  if (normalizedIcon) {
    entry.railIcon = normalizedIcon;
    delete entry.railText;
  } else if (normalizedText) {
    entry.railText = normalizedText;
    delete entry.railIcon;
  } else {
    if (normalizedIcon === "") delete entry.railIcon;
    if (normalizedText === "") delete entry.railText;
  }
  entries[index] = entry;
  writePinnedDatabases(entries);
  return entries;
}

export function movePinnedDatabase(sourceId, targetId, position, list = null) {
  const entries = normalizePinnedDatabases(list || readPinnedDatabases());
  const next = previewDragOrder(entries, sourceId, targetId, {
    position,
    getKey: (entry) => railDatabaseId(entry.connectionId, entry.database),
  });
  if (next.some((entry, index) => entry !== entries[index])) writePinnedDatabases(next);
  return next;
}

// 删除连接时清理该连接下的所有常驻条目。
export function removePinnedDatabasesForConnection(connectionId, list = null) {
  const entries = normalizePinnedDatabases(list || readPinnedDatabases());
  const next = entries.filter((e) => String(e.connectionId || "") !== String(connectionId || ""));
  if (next.length !== entries.length) writePinnedDatabases(next);
  return next;
}
