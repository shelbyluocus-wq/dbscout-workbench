import { computed, ref } from "vue";
import { t } from "../i18n/index.js";
import { railDatabaseIconComponent } from "../components/railDatabaseIcons.js";
import { formatShortcutForPlatform } from "../utils/desktopPlatform.js";
import {
  movePinnedDatabase,
  normalizePinnedDatabases,
  setPinnedDatabaseRail,
  setPinnedDatabaseRailAppearance,
  writePinnedDatabases,
} from "../utils/pinnedDatabases.js";
import {
  RAIL_GROUP_NAME_MAX_LENGTH,
  assignRailGroup,
  createRailGroup,
  dissolveRailGroup,
  liveRailGroups,
  moveRailTopLevel,
  moveWithinRailGroup,
  railGroupIdFromKey,
  railLayout,
  readRailGroups,
  suggestRailGroupName,
  writeRailGroups,
} from "../utils/railDatabaseGroups.js";
import {
  autoRailColor,
  deriveRailMonogram,
  isCompactRailText,
  nextRailColor,
  railDatabaseId,
  readableInkOn,
} from "../utils/railDatabaseGlyph.js";

function sameSource(entry, connectionId, database) {
  return (
    String(entry?.connectionId || "") === String(connectionId || "")
    && String(entry?.database || "") === String(database || "")
  );
}

export function useRailDatabases({
  pinnedDatabases,
  connections,
  currentSource,
  databaseLabel,
  connectionLabel,
  getDatabaseDecoration,
  translate = t,
  notify = () => {},
  initialGroups = readRailGroups(),
}) {
  const groups = ref(initialGroups);
  const items = computed(() => {
    const pinned = Array.isArray(pinnedDatabases.value) ? pinnedDatabases.value : [];
    const list = Array.isArray(connections.value) ? connections.value : [];
    const connectionsById = new Map();
    let hasAnyPendingSaved = false;
    for (const candidate of list) {
      if (candidate?.id != null) connectionsById.set(String(candidate.id), candidate);
      if (candidate?.saved && candidate.connected !== true) hasAnyPendingSaved = true;
    }
    const source = currentSource?.() || {};
    return pinned
      .filter((entry) => entry.rail)
      .map((entry) => {
        const id = railDatabaseId(entry.connectionId, entry.database);
        const label = databaseLabel(entry.connectionId, entry.database) || entry.database;
        const connection = connectionsById.get(String(entry.connectionId)) || null;
        const connectionName = connectionLabel(entry.connectionId, connection?.label || entry.connectionId);
        const hasPendingSavedPlaceholder = !connection && hasAnyPendingSaved;
        const missing = !connection && !hasPendingSavedPlaceholder;
        const disconnected = hasPendingSavedPlaceholder || (!missing && connection.connected !== true);
        const decoration = getDatabaseDecoration(entry.connectionId, entry.database);
        const autoText = deriveRailMonogram(label);
        let glyph;
        if (entry.railIcon) {
          glyph = { kind: "icon", id: entry.railIcon, icon: railDatabaseIconComponent(entry.railIcon) };
        } else if (entry.railText) {
          glyph = { kind: "text", text: entry.railText, compact: isCompactRailText(entry.railText) };
        } else if (decoration?.icon && decoration.icon !== "database") {
          glyph = { kind: "icon", id: decoration.icon, icon: railDatabaseIconComponent(decoration.icon) };
        } else {
          glyph = { kind: "text", text: autoText, compact: isCompactRailText(autoText) };
        }
        const color = entry.railColor || decoration?.color || autoRailColor(id);
        const current = sameSource(entry, source.connectionId, source.database) && Boolean(source.database);
        const hint = missing
          ? translate("railDatabase.missingHint")
          : current
            ? translate("railDatabase.currentHint", { connection: connectionName })
            : disconnected
              ? translate("railDatabase.disconnectedHint", { connection: connectionName })
              : translate("railDatabase.switchHint", { connection: connectionName });
        return {
          id,
          connectionId: entry.connectionId,
          database: entry.database,
          label,
          realName: entry.database,
          connectionLabel: connectionName,
          hint,
          glyph,
          color,
          ink: readableInkOn(color),
          current,
          disconnected,
          missing,
          groupId: entry.railGroup || "",
          shortcutLabel: formatShortcutForPlatform(entry.shortcut || ""),
          custom: { icon: entry.railIcon || "", text: entry.railText || "", color: entry.railColor || "" },
          autoText,
        };
      });
  });

  // The rail's top level: database tiles and group folders, in rail order.
  const layout = computed(() => {
    const byId = new Map(items.value.map((item) => [item.id, item]));
    return railLayout(entries(), groups.value).map((entry) => {
      if (entry.kind === "db") return { kind: "db", id: entry.key, item: byId.get(entry.key) };
      const members = entry.entries.map((member) => byId.get(railDatabaseId(member.connectionId, member.database)));
      const current = members.find((member) => member.current) || null;
      const name = entry.group.name || translate("railDatabase.groupUntitled");
      return {
        kind: "group",
        id: entry.key,
        groupId: entry.group.id,
        name,
        items: members,
        current: Boolean(current),
        hint: current
          ? translate("railDatabase.groupCurrentHint", { count: members.length, name: current.label })
          : translate("railDatabase.groupHint", { count: members.length }),
      };
    });
  });

  const groupOptions = computed(() => liveRailGroups(entries(), groups.value)
    .map((group) => ({ id: group.id, name: group.name || translate("railDatabase.groupUntitled") })));

  function entries() {
    return Array.isArray(pinnedDatabases.value) ? pinnedDatabases.value : [];
  }

  // Pinned entries and groups always change together; empty groups are dropped.
  function commit(nextEntries, nextGroups = groups.value) {
    const normalized = normalizePinnedDatabases(nextEntries);
    const live = liveRailGroups(normalized, nextGroups);
    pinnedDatabases.value = normalized;
    writePinnedDatabases(normalized);
    groups.value = live;
    writeRailGroups(live);
  }

  function isOnRail(connectionId, database) {
    return (Array.isArray(pinnedDatabases.value) ? pinnedDatabases.value : [])
      .some((entry) => entry.rail && sameSource(entry, connectionId, database));
  }

  function displayName(connectionId, database) {
    return databaseLabel(connectionId, database) || String(database || "");
  }

  // `groupId` pins straight into a group (a database dropped on its folder).
  function pin({ connectionId, database, groupId = "" } = {}) {
    if (!connectionId || !database) return { ok: false };
    const name = displayName(connectionId, database);
    const id = railDatabaseId(connectionId, database);
    const group = groupId ? groupOptions.value.find((option) => option.id === groupId) : null;
    if (isOnRail(connectionId, database)) {
      if (group && items.value.find((item) => item.id === id)?.groupId !== group.id) {
        moveToGroup({ id }, group.id);
        notify(translate("railDatabase.movedToGroup", { name, group: group.name }));
        return { ok: true, moved: true };
      }
      notify(translate("railDatabase.alreadyPinned", { name }));
      return { ok: false, existed: true };
    }
    const decoration = getDatabaseDecoration(connectionId, database);
    const color = decoration?.color ? "" : nextRailColor(items.value.map((item) => item.color), id);
    pinnedDatabases.value = setPinnedDatabaseRail(
      connectionId,
      database,
      true,
      pinnedDatabases.value,
      { color },
    );
    if (group) {
      commit(assignRailGroup(entries(), groups.value, id, group.id));
      notify(translate("railDatabase.pinnedToGroup", { name, group: group.name }));
    } else {
      notify(translate("railDatabase.pinned", { name }));
    }
    return { ok: true };
  }

  function unpin({ connectionId, database } = {}) {
    if (!connectionId || !database) return { ok: false };
    const name = displayName(connectionId, database);
    pinnedDatabases.value = setPinnedDatabaseRail(connectionId, database, false, pinnedDatabases.value);
    notify(translate("railDatabase.unpinned", { name }));
    return { ok: true };
  }

  // Top-level reorder: tile ids and group keys (`group:<id>`) both work.
  function reorder(sourceId, targetId, { position } = {}) {
    if (!railGroupIdFromKey(sourceId) && !railGroupIdFromKey(targetId) && !groups.value.length) {
      pinnedDatabases.value = movePinnedDatabase(sourceId, targetId, position, pinnedDatabases.value);
      return;
    }
    commit(moveRailTopLevel(entries(), groups.value, sourceId, targetId, position));
  }

  function reorderInGroup(groupId, sourceId, targetId, { position } = {}) {
    commit(moveWithinRailGroup(entries(), groups.value, groupId, sourceId, targetId, position));
  }

  function createGroup(item) {
    if (!item?.id) return "";
    const result = createRailGroup(entries(), groups.value, item.id, suggestRailGroupName(groups.value, translate("railDatabase.groupDefaultName")));
    if (!result.groupId) return "";
    commit(result.entries, result.groups);
    return result.groupId;
  }

  function moveToGroup(item, groupId) {
    if (!item?.id) return;
    commit(assignRailGroup(entries(), groups.value, item.id, groupId));
  }

  function removeFromGroup(item) {
    moveToGroup(item, "");
  }

  function renameGroup(groupId, name) {
    const trimmed = String(name || "").trim().slice(0, RAIL_GROUP_NAME_MAX_LENGTH);
    if (!trimmed) return false;
    commit(entries(), groups.value.map((group) => (group.id === groupId ? { ...group, name: trimmed } : group)));
    return true;
  }

  function dissolveGroup(groupId) {
    const result = dissolveRailGroup(entries(), groups.value, groupId);
    commit(result.entries, result.groups);
  }

  function setAppearance({ connectionId, database, icon, text, color } = {}) {
    pinnedDatabases.value = setPinnedDatabaseRailAppearance(
      connectionId,
      database,
      { icon, text, color },
      pinnedDatabases.value,
    );
  }

  function resetAppearance({ connectionId, database } = {}) {
    const id = railDatabaseId(connectionId, database);
    const decoration = getDatabaseDecoration(connectionId, database);
    const used = items.value.filter((item) => item.id !== id).map((item) => item.color);
    setAppearance({
      connectionId,
      database,
      icon: "",
      text: "",
      color: decoration?.color ? "" : nextRailColor(used, id),
    });
  }

  return {
    items,
    layout,
    groupOptions,
    isOnRail,
    pin,
    unpin,
    reorder,
    reorderInGroup,
    createGroup,
    moveToGroup,
    removeFromGroup,
    renameGroup,
    dissolveGroup,
    setAppearance,
    resetAppearance,
  };
}
