import { ref } from "vue";

// Sidebar connection groups: named, collapsible folders for connections, like
// Navicat's. A connection belongs to at most one group; groups only organise
// the tree and never touch the connection itself. Membership is keyed by the
// connection's stable identity (see connectionIdentityKey), not its runtime id.
export const CONNECTION_GROUPS_STORAGE_KEY = "dbscout.connection-groups.v1";
export const CONNECTION_GROUP_NAME_MAX_LENGTH = 40;

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function normalizeName(value) {
  return String(value || "").trim();
}

function nameKey(name) {
  return normalizeName(name).toLocaleLowerCase();
}

function randomGroupId(existingIds) {
  for (;;) {
    const id = `cgrp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    if (!existingIds.has(id)) return id;
  }
}

export function normalizeConnectionGroups(value) {
  const groups = [];
  const ids = new Set();
  for (const raw of Array.isArray(value?.groups) ? value.groups : []) {
    const id = String(raw?.id || "").trim();
    const name = normalizeName(raw?.name).slice(0, CONNECTION_GROUP_NAME_MAX_LENGTH);
    if (!id || !name || ids.has(id)) continue;
    ids.add(id);
    groups.push({ id, name, collapsed: Boolean(raw?.collapsed) });
  }
  const members = {};
  const rawMembers = value?.members && typeof value.members === "object" ? value.members : {};
  for (const [key, groupId] of Object.entries(rawMembers)) {
    if (key && ids.has(String(groupId))) members[key] = String(groupId);
  }
  return { groups, members };
}

export function loadConnectionGroups(storage = defaultStorage()) {
  try {
    const stored = JSON.parse(storage?.getItem?.(CONNECTION_GROUPS_STORAGE_KEY) || "null");
    return normalizeConnectionGroups(stored?.version === 1 ? stored : null);
  } catch {
    return normalizeConnectionGroups(null);
  }
}

export function saveConnectionGroups(state, storage = defaultStorage()) {
  try {
    storage?.setItem?.(CONNECTION_GROUPS_STORAGE_KEY, JSON.stringify({ version: 1, ...normalizeConnectionGroups(state) }));
  } catch {
    // Groups are a convenience; the tree keeps working without storage.
  }
}

function moveInList(list, sourceId, targetId, position) {
  if (!sourceId || !targetId || sourceId === targetId) return list;
  const next = [...list];
  const from = next.findIndex((item) => item.id === sourceId);
  if (from < 0) return list;
  const [moved] = next.splice(from, 1);
  const target = next.findIndex((item) => item.id === targetId);
  if (target < 0) return list;
  next.splice(position === "after" ? target + 1 : target, 0, moved);
  return next;
}

/**
 * The sidebar's top level: groups first (in their own order, each with its
 * connections in connection order), then the connections in no group.
 * `identityOf` maps a connection to its membership key.
 */
export function buildConnectionTree(connections, { groups = [], members = {}, identityOf }) {
  const byGroup = new Map(groups.map((group) => [group.id, []]));
  const ungrouped = [];
  for (const connection of Array.isArray(connections) ? connections : []) {
    const groupId = members[identityOf(connection)];
    if (groupId && byGroup.has(groupId)) byGroup.get(groupId).push(connection);
    else ungrouped.push(connection);
  }
  return {
    groups: groups.map((group) => ({ ...group, connections: byGroup.get(group.id) })),
    ungrouped,
  };
}

export function createConnectionGroupStore({ storage = defaultStorage(), initial } = {}) {
  const state = ref(initial === undefined ? loadConnectionGroups(storage) : normalizeConnectionGroups(initial));

  function commit(next) {
    state.value = normalizeConnectionGroups(next);
    saveConnectionGroups(state.value, storage);
  }

  function reload() {
    state.value = loadConnectionGroups(storage);
  }

  function getGroup(id) {
    return state.value.groups.find((group) => group.id === String(id || "")) || null;
  }

  function groupOf(memberKey) {
    return state.value.members[memberKey] || "";
  }

  function validateName(name, exceptId = "") {
    const normalized = normalizeName(name);
    if (!normalized) return "empty";
    if (normalized.length > CONNECTION_GROUP_NAME_MAX_LENGTH) return "tooLong";
    if (state.value.groups.some((group) => group.id !== exceptId && nameKey(group.name) === nameKey(normalized))) return "duplicate";
    return "";
  }

  function suggestName(base) {
    const root = normalizeName(base) || "Group";
    if (!validateName(root)) return root;
    for (let index = 2; ; index += 1) {
      const candidate = `${root} ${index}`;
      if (!validateName(candidate)) return candidate;
    }
  }

  function createGroup(name, { memberKeys = [] } = {}) {
    const error = validateName(name);
    if (error) return { ok: false, error };
    const group = {
      id: randomGroupId(new Set(state.value.groups.map((item) => item.id))),
      name: normalizeName(name),
      collapsed: false,
    };
    const members = { ...state.value.members };
    memberKeys.filter(Boolean).forEach((key) => { members[key] = group.id; });
    commit({ groups: [...state.value.groups, group], members });
    return { ok: true, group };
  }

  function renameGroup(id, name) {
    const group = getGroup(id);
    if (!group) return { ok: false, error: "missing" };
    const error = validateName(name, group.id);
    if (error) return { ok: false, error };
    commit({
      ...state.value,
      groups: state.value.groups.map((item) => (item.id === group.id ? { ...item, name: normalizeName(name) } : item)),
    });
    return { ok: true };
  }

  // The group goes; its connections return to the top level.
  function deleteGroup(id) {
    if (!getGroup(id)) return false;
    const members = Object.fromEntries(Object.entries(state.value.members).filter(([, groupId]) => groupId !== id));
    commit({ groups: state.value.groups.filter((group) => group.id !== id), members });
    return true;
  }

  function setCollapsed(id, collapsed) {
    const group = getGroup(id);
    if (!group || group.collapsed === Boolean(collapsed)) return;
    commit({
      ...state.value,
      groups: state.value.groups.map((item) => (item.id === group.id ? { ...item, collapsed: Boolean(collapsed) } : item)),
    });
  }

  // `groupId` "" takes the connection out of its group.
  function assign(memberKey, groupId) {
    if (!memberKey) return false;
    const target = groupId ? getGroup(groupId) : null;
    if (groupId && !target) return false;
    if ((state.value.members[memberKey] || "") === (target?.id || "")) return false;
    const members = { ...state.value.members };
    if (target) members[memberKey] = target.id;
    else delete members[memberKey];
    commit({ ...state.value, members });
    return true;
  }

  function moveGroup(sourceId, targetId, position = "before") {
    const groups = moveInList(state.value.groups, sourceId, targetId, position);
    if (groups !== state.value.groups) commit({ ...state.value, groups });
  }

  function forget(memberKey) {
    if (!state.value.members[memberKey]) return;
    assign(memberKey, "");
  }

  return {
    state,
    reload,
    getGroup,
    groupOf,
    validateName,
    suggestName,
    createGroup,
    renameGroup,
    deleteGroup,
    setCollapsed,
    assign,
    moveGroup,
    forget,
  };
}

let sharedStore = null;

// One store per window; other windows' edits arrive through storage events.
export function useConnectionGroupStore() {
  if (!sharedStore) {
    sharedStore = createConnectionGroupStore();
    globalThis.addEventListener?.("storage", (event) => {
      if (event?.key === CONNECTION_GROUPS_STORAGE_KEY) sharedStore.reload();
    });
  }
  return sharedStore;
}
