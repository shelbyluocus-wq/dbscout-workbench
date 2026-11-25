export function isDisconnectedSavedPlaceholder(connectionId, connections = []) {
  const id = String(connectionId || "").trim();
  if (!id) return false;
  if (id.startsWith("saved-")) return true;
  const match = (Array.isArray(connections) ? connections : []).find(
    (item) => String(item?.id || "") === id,
  );
  return Boolean(match && match.saved && !match.connected);
}

export function shouldSkipWorkspacePersist({
  connectionId = "",
  database = "",
  tabs = [],
  connections = [],
} = {}) {
  return (
    isDisconnectedSavedPlaceholder(connectionId, connections)
    && !String(database || "").trim()
    && (!Array.isArray(tabs) || tabs.length === 0)
  );
}

export function shouldEnsureDatabaseHome({
  isFolderWindow = false,
  selectedDatabase = "",
  tabs = [],
  focusedPane = null,
} = {}) {
  if (isFolderWindow || !String(selectedDatabase || "").trim()) return false;
  const list = Array.isArray(tabs) ? tabs : [];
  const hasHomeTab = list.some((tab) => tab?.kind === "home");
  const hasFocusedPaneTabs = Boolean(focusedPane?.tabIds?.length);
  return !hasHomeTab || !hasFocusedPaneTabs;
}

export function shouldRestorePendingStartupSnapshot(
  snapshot,
  { connectionId = "", database = "", tabs = [] } = {},
) {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (Array.isArray(tabs) && tabs.length > 0) return false;
  const safeConnectionId = String(connectionId || "").trim();
  const safeDatabase = String(database || "").trim();
  if (!safeConnectionId || !safeDatabase) return false;
  return (
    String(snapshot.connectionId || "") === safeConnectionId
    && String(snapshot.database || "") === safeDatabase
  );
}

export function shouldEmitSidebarDatabaseOpen({ activeTab = null } = {}) {
  return !activeTab;
}
