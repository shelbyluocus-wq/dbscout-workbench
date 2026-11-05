// Which kind of window this page runs in. The main window is the only one
// with saved tabs, the tray, the updater and the external MCP connection.
// A table folder window opens the tables of one folder and forgets its tabs
// when it closes.
//
// The desktop app injects `__DBSCOUT_WINDOW__` before any page script runs;
// the browser preview opens `?tableFolder=<id>` instead and reads the folder
// from the shared folder store.

export const MAIN_WINDOW_ROLE = Object.freeze({ kind: "main" });
export const TABLE_FOLDER_WINDOW_KIND = "tableFolder";
export const TABLE_FOLDER_WINDOW_LABEL_PREFIX = "table-folder-";

const FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function names(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((name) => String(name || "").trim()).filter(Boolean))];
}

export function normalizeTableFolderWindowRole(raw) {
  if (!raw || typeof raw !== "object" || raw.kind !== TABLE_FOLDER_WINDOW_KIND) return null;
  const folderId = String(raw.folderId || "");
  if (!FOLDER_ID_PATTERN.test(folderId)) return null;
  return Object.freeze({
    kind: TABLE_FOLDER_WINDOW_KIND,
    folderId,
    folderName: String(raw.folderName || ""),
    connectionId: String(raw.connectionId || ""),
    database: String(raw.database || ""),
    tableNames: Object.freeze(names(raw.tableNames)),
  });
}

export function resolveWindowRole({ global = globalThis, resolveFolder = null } = {}) {
  const injected = normalizeTableFolderWindowRole(global?.__DBSCOUT_WINDOW__);
  if (injected) return injected;
  let folderId = "";
  try {
    folderId = new URLSearchParams(global?.location?.search || "").get("tableFolder") || "";
  } catch {
    folderId = "";
  }
  if (!folderId) return MAIN_WINDOW_ROLE;
  const folder = typeof resolveFolder === "function" ? resolveFolder(folderId) : null;
  if (!folder) return MAIN_WINDOW_ROLE;
  return normalizeTableFolderWindowRole({
    kind: TABLE_FOLDER_WINDOW_KIND,
    folderId,
    folderName: folder.name,
    connectionId: folder.connectionId,
    database: folder.database,
    tableNames: folder.tableNames,
  }) || MAIN_WINDOW_ROLE;
}

export function isTableFolderWindowRole(role) {
  return role?.kind === TABLE_FOLDER_WINDOW_KIND;
}

export function tableFolderWindowLabel(folderId) {
  return `${TABLE_FOLDER_WINDOW_LABEL_PREFIX}${folderId}`;
}

// The workspace a folder window starts with: every table of the folder in
// one pane, the first one shown. Tables load when they are first shown, so
// a large folder does not hold up the first one.
export function buildTableFolderSnapshot(role) {
  const tabs = role.tableNames.map((tableName, index) => ({
    id: `folder-tab-${index + 1}`,
    kind: "data",
    connectionId: role.connectionId,
    database: role.database,
    tableName,
  }));
  const tabIds = tabs.map((tab) => tab.id);
  return {
    version: 4,
    connectionId: role.connectionId,
    database: role.database,
    tabs,
    activeTabId: tabIds[0] || "",
    panes: { "pane-1": { id: "pane-1", tabIds, activeTabId: tabIds[0] || "" } },
    layout: { type: "pane", paneId: "pane-1" },
    focusedPaneId: "pane-1",
  };
}

let currentRole = MAIN_WINDOW_ROLE;

export function setCurrentWindowRole(role) {
  currentRole = role || MAIN_WINDOW_ROLE;
}

export function currentWindowRole() {
  return currentRole;
}
