// Groups of database shortcuts on the activity rail. A group is one folder
// tile on the rail that opens a list of its databases. Membership lives on the
// pinned entry (`railGroup`); the group itself only stores its name. A group
// sits where its first member is and exists only while it has members.
//
// Every edit goes through the rail layout: the top-level sequence of tiles and
// groups is computed, changed, and written back into the rail entries' slots
// of the pinned list (non-rail favorites keep their positions), so a group's
// members always stay together.

import { railDatabaseId } from "./railDatabaseGlyph.js";

export const RAIL_GROUPS_KEY = "dbscout_rail_groups";
export const RAIL_GROUP_NAME_MAX_LENGTH = 24;
const GROUP_KEY_PREFIX = "group:";

export function railGroupKey(groupId) {
  return `${GROUP_KEY_PREFIX}${groupId}`;
}

export function railGroupIdFromKey(key) {
  const text = String(key || "");
  return text.startsWith(GROUP_KEY_PREFIX) ? text.slice(GROUP_KEY_PREFIX.length) : "";
}

export function isRailGroupId(value) {
  return /^rg-[a-z0-9]{4,32}$/.test(String(value || ""));
}

function entryId(entry) {
  return railDatabaseId(entry.connectionId, entry.database);
}

export function normalizeRailGroups(list) {
  const groups = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String(raw?.id || "");
    if (!isRailGroupId(id) || groups.some((group) => group.id === id)) continue;
    groups.push({ id, name: String(raw?.name || "").trim().slice(0, RAIL_GROUP_NAME_MAX_LENGTH) });
  }
  return groups;
}

export function readRailGroups() {
  try {
    return normalizeRailGroups(JSON.parse(globalThis.localStorage?.getItem(RAIL_GROUPS_KEY) || "[]"));
  } catch {
    return [];
  }
}

export function writeRailGroups(groups) {
  try {
    globalThis.localStorage?.setItem(RAIL_GROUPS_KEY, JSON.stringify(normalizeRailGroups(groups)));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

export function newRailGroupId(groups = []) {
  const taken = new Set(groups.map((group) => group.id));
  for (;;) {
    const id = `rg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!taken.has(id)) return id;
  }
}

export function suggestRailGroupName(groups, base) {
  const names = new Set(groups.map((group) => group.name));
  for (let index = 1; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!names.has(candidate)) return candidate;
  }
}

/**
 * Top-level rail items in order: `{ kind: "db", key, entry }` for a tile and
 * `{ kind: "group", key, group, entries }` for a group, placed at its first
 * member. Entries naming an unknown group are plain tiles.
 */
export function railLayout(entries, groups) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const layout = [];
  const groupItems = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry?.rail) continue;
    const group = byId.get(entry.railGroup);
    if (!group) {
      layout.push({ kind: "db", key: entryId(entry), entry });
      continue;
    }
    let item = groupItems.get(group.id);
    if (!item) {
      item = { kind: "group", key: railGroupKey(group.id), group, entries: [] };
      groupItems.set(group.id, item);
      layout.push(item);
    }
    item.entries.push(entry);
  }
  return layout;
}

function withGroup(entry, groupId) {
  const next = { ...entry };
  if (groupId) next.railGroup = groupId;
  else delete next.railGroup;
  return next;
}

/** Writes a layout back: rail slots of the pinned list take its order. */
export function applyRailLayout(entries, layout) {
  const ordered = [];
  for (const item of layout) {
    if (item.kind === "group") item.entries.forEach((entry) => ordered.push(withGroup(entry, item.group.id)));
    else ordered.push(withGroup(item.entry, ""));
  }
  let next = 0;
  return entries.map((entry) => (entry?.rail ? ordered[next++] : entry));
}

/** Groups that still have members, in their stored order. */
export function liveRailGroups(entries, groups) {
  const used = new Set(entries.filter((entry) => entry?.rail && entry.railGroup).map((entry) => entry.railGroup));
  return groups.filter((group) => used.has(group.id));
}

function moveInList(list, sourceKey, targetKey, position, keyOf) {
  const from = list.findIndex((item) => keyOf(item) === sourceKey);
  if (from < 0 || sourceKey === targetKey) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  const target = next.findIndex((item) => keyOf(item) === targetKey);
  if (target < 0) return list;
  next.splice(position === "after" ? target + 1 : target, 0, moved);
  return next;
}

// Takes a database out of wherever it is: its tile, or its group (which
// disappears with its last member). Returns the layout without it, the entry
// and the index its removal left open.
function detach(layout, railId) {
  for (let index = 0; index < layout.length; index += 1) {
    const item = layout[index];
    if (item.kind === "db" && item.key === railId) {
      return { layout: layout.filter((_, at) => at !== index), entry: item.entry, index, groupIndex: -1 };
    }
    if (item.kind !== "group") continue;
    const member = item.entries.find((entry) => entryId(entry) === railId);
    if (!member) continue;
    const rest = item.entries.filter((entry) => entry !== member);
    const next = [...layout];
    if (rest.length) next[index] = { ...item, entries: rest };
    else next.splice(index, 1);
    return { layout: next, entry: member, index: rest.length ? index + 1 : index, groupIndex: rest.length ? index : -1 };
  }
  return null;
}

export function moveRailTopLevel(entries, groups, sourceKey, targetKey, position = "before") {
  const layout = railLayout(entries, groups);
  return applyRailLayout(entries, moveInList(layout, sourceKey, targetKey, position, (item) => item.key));
}

export function moveWithinRailGroup(entries, groups, groupId, sourceId, targetId, position = "before") {
  const layout = railLayout(entries, groups).map((item) => (
    item.kind === "group" && item.group.id === groupId
      ? { ...item, entries: moveInList(item.entries, sourceId, targetId, position, entryId) }
      : item
  ));
  return applyRailLayout(entries, layout);
}

/** Moves a database into a group (last), or out of its group when `groupId` is "". */
export function assignRailGroup(entries, groups, railId, groupId) {
  const layout = railLayout(entries, groups);
  const current = layout.find((item) => item.kind === "group" && item.entries.some((entry) => entryId(entry) === railId));
  if ((current?.group.id || "") === (groupId || "")) return entries;
  if (groupId && !groups.some((group) => group.id === groupId)) return entries;
  const detached = detach(layout, railId);
  if (!detached) return entries;
  const next = detached.layout;
  if (groupId) {
    const index = next.findIndex((item) => item.kind === "group" && item.group.id === groupId);
    if (index >= 0) next[index] = { ...next[index], entries: [...next[index].entries, detached.entry] };
    else next.splice(detached.index, 0, { kind: "group", key: railGroupKey(groupId), group: groups.find((group) => group.id === groupId), entries: [detached.entry] });
  } else {
    // Out of a group: right after it, or in its place when it emptied.
    next.splice(detached.index, 0, { kind: "db", key: railId, entry: detached.entry });
  }
  return applyRailLayout(entries, next);
}

/** A new group holding one database, in the place that database had. */
export function createRailGroup(entries, groups, railId, name) {
  const id = newRailGroupId(groups);
  const group = { id, name: String(name || "").trim().slice(0, RAIL_GROUP_NAME_MAX_LENGTH) };
  const nextGroups = [...groups, group];
  const layout = railLayout(entries, groups);
  const detached = detach(layout, railId);
  if (!detached) return { entries, groups, groupId: "" };
  const next = detached.layout;
  next.splice(detached.index, 0, { kind: "group", key: railGroupKey(id), group, entries: [detached.entry] });
  return { entries: applyRailLayout(entries, next), groups: nextGroups, groupId: id };
}

/** The group goes; its databases take its place on the rail, in order. */
export function dissolveRailGroup(entries, groups, groupId) {
  const layout = railLayout(entries, groups).flatMap((item) => (
    item.kind === "group" && item.group.id === groupId
      ? item.entries.map((entry) => ({ kind: "db", key: entryId(entry), entry }))
      : [item]
  ));
  return { entries: applyRailLayout(entries, layout), groups: groups.filter((group) => group.id !== groupId) };
}
