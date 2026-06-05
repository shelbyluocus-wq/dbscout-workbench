const STORAGE_KEY = "dbscout_workspace";

function normalizeTabKind(kind) {
  return kind === "design" ? "design" : "data";
}

/**
 * Build a lightweight snapshot of workspace state for persistence.
 * Only serializable primitives are stored -- transient data like rows,
 * columns, loading flags, and Sets are excluded.
 */
export function buildWorkspaceSnapshot({
  connectionId = "",
  database = "",
  tabs = [],
  activeTabId = "",
}) {
  const savedTabs = tabs.map((tab) => ({
    id: tab.id,
    kind: normalizeTabKind(tab.kind),
    connectionId: tab.connectionId || "",
    database: tab.database || "",
    tableName: tab.tableName || "",
    tableComment: tab.tableComment || "",
    filter: tab.filter || "",
    filterMode: tab.filterMode || "fuzzy",
    sort: tab.sort || null,
  }));
  return {
    connectionId,
    database,
    tabs: savedTabs,
    activeTabId,
  };
}

/**
 * Save a workspace snapshot to localStorage.
 */
export function saveWorkspaceSnapshot(snapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // localStorage may be unavailable or full -- silently ignore.
  }
}

/**
 * Load a previously saved workspace snapshot from localStorage.
 * Returns null when no valid snapshot exists.
 */
export function loadWorkspaceSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      connectionId: String(parsed.connectionId || ""),
      database: String(parsed.database || ""),
      tabs: Array.isArray(parsed.tabs)
        ? parsed.tabs
            .filter((tab) => tab && typeof tab === "object" && tab.tableName)
            .map((tab) => ({
              id: String(tab.id || ""),
              kind: normalizeTabKind(tab.kind),
              connectionId: String(tab.connectionId || ""),
              database: String(tab.database || ""),
              tableName: String(tab.tableName || ""),
              tableComment: String(tab.tableComment || ""),
              filter: String(tab.filter || ""),
              filterMode: String(tab.filterMode || "fuzzy"),
              sort: tab.sort || null,
            }))
        : [],
      activeTabId: String(parsed.activeTabId || ""),
    };
  } catch {
    return null;
  }
}

/**
 * Clear the persisted workspace snapshot.
 */
export function clearWorkspaceSnapshot() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Silently ignore.
  }
}
