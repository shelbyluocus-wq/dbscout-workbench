import { computed } from "vue";
import { t } from "../i18n/index.js";
import { railDatabaseIconComponent } from "../components/railDatabaseIcons.js";
import { formatShortcutForPlatform } from "../utils/desktopPlatform.js";
import {
  movePinnedDatabase,
  setPinnedDatabaseRail,
  setPinnedDatabaseRailAppearance,
} from "../utils/pinnedDatabases.js";
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
}) {
  const items = computed(() => (Array.isArray(pinnedDatabases.value) ? pinnedDatabases.value : [])
    .filter((entry) => entry.rail)
    .map((entry) => {
      const id = railDatabaseId(entry.connectionId, entry.database);
      const label = databaseLabel(entry.connectionId, entry.database) || entry.database;
      const connection = (connections.value || []).find(
        (candidate) => String(candidate?.id) === String(entry.connectionId),
      ) || null;
      const connectionName = connectionLabel(entry.connectionId, connection?.label || entry.connectionId);
      const missing = !connection;
      const disconnected = !missing && connection.connected !== true;
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
      const source = currentSource?.() || {};
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
        shortcutLabel: formatShortcutForPlatform(entry.shortcut || ""),
        custom: { icon: entry.railIcon || "", text: entry.railText || "", color: entry.railColor || "" },
        autoText,
      };
    }));

  function isOnRail(connectionId, database) {
    return (Array.isArray(pinnedDatabases.value) ? pinnedDatabases.value : [])
      .some((entry) => entry.rail && sameSource(entry, connectionId, database));
  }

  function displayName(connectionId, database) {
    return databaseLabel(connectionId, database) || String(database || "");
  }

  function pin({ connectionId, database } = {}) {
    if (!connectionId || !database) return { ok: false };
    const name = displayName(connectionId, database);
    if (isOnRail(connectionId, database)) {
      notify(translate("railDatabase.alreadyPinned", { name }));
      return { ok: false, existed: true };
    }
    const id = railDatabaseId(connectionId, database);
    const decoration = getDatabaseDecoration(connectionId, database);
    const color = decoration?.color ? "" : nextRailColor(items.value.map((item) => item.color), id);
    pinnedDatabases.value = setPinnedDatabaseRail(
      connectionId,
      database,
      true,
      pinnedDatabases.value,
      { color },
    );
    notify(translate("railDatabase.pinned", { name }));
    return { ok: true };
  }

  function unpin({ connectionId, database } = {}) {
    if (!connectionId || !database) return { ok: false };
    const name = displayName(connectionId, database);
    pinnedDatabases.value = setPinnedDatabaseRail(connectionId, database, false, pinnedDatabases.value);
    notify(translate("railDatabase.unpinned", { name }));
    return { ok: true };
  }

  function reorder(sourceId, targetId, { position } = {}) {
    pinnedDatabases.value = movePinnedDatabase(sourceId, targetId, position, pinnedDatabases.value);
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

  return { items, isOnRail, pin, unpin, reorder, setAppearance, resetAppearance };
}
