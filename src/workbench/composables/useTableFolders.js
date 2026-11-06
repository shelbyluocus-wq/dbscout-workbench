import { t as translate } from "../i18n/index.js";
import { normalizeTableComment, normalizeTableName } from "../utils/normalize.js";
import { computed, unref } from "vue";
import { openTableFoldersTab, setTableFolderScope } from "../workspaceState.js";
import { currentWindowRole, isTableFolderWindowRole } from "../utils/windowRole.js";

export const TABLE_FOLDER_WINDOW_OPEN_EVENT = "table-folder-window-open";

function sameScope(a, b) {
  return String(a?.connectionId || "") === String(b?.connectionId || "")
    && String(a?.database || "") === String(b?.database || "");
}

export function tableRows(tables) {
  return (Array.isArray(tables) ? tables : [])
    .map((table) => ({ name: normalizeTableName(table), comment: normalizeTableComment(table) }))
    .filter((table) => table.name);
}

// The table folder page's actions (provided to it as a context) and the
// folder window's own start-up.
export function useTableFolders({
  invokeWorkbench,
  workspace,
  selectedConnectionId,
  selectedDatabase,
  connections = [],
  databases = [],
  databasesByConnection = {},
  loadDatabases = async () => {},
  databaseLabel = (_connectionId, database) => database,
  connectionLabel = (_connectionId, label) => label,
  onScopeChange = () => {},
  openTable,
  openTables,
  notify,
  confirm = null,
  t = translate,
  role = currentWindowRole(),
  listenToWindow = defaultListenToWindow,
} = {}) {
  // The database shown in the sidebar needs no round trip.
  async function loadTables(scope) {
    if (!scope?.database) return [];
    if (sameScope(scope, workspace) && workspace.schema.length && workspace.schema.every((table) => sameScope(scope, table))) {
      return tableRows(workspace.schema);
    }
    return tableRows(await invokeWorkbench("list_tables", { ...scope, priority: "visible" }));
  }

  function openPage(target = null) {
    const focusedTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId);
    const scope = target?.database
      ? target
      : focusedTab?.database
        ? { connectionId: focusedTab.connectionId, database: focusedTab.database }
        : { connectionId: selectedConnectionId.value, database: selectedDatabase.value };
    if (!scope.database) {
      notify("info", t("tableFolders.noDatabase"));
      return null;
    }
    return openTableFoldersTab(workspace, scope, { activate: true, paneId: workspace.focusedPaneId });
  }

  async function openWindow(folder) {
    if (!folder?.tableNames?.length) return;
    const name = folder.displayName || folder.name;
    try {
      const result = await invokeWorkbench("open_table_folder_window", {
        request: {
          folderId: folder.id,
          folderName: name,
          connectionId: folder.connectionId,
          database: folder.database,
          tableNames: [...folder.tableNames],
        },
      });
      if (result?.reused) notify("info", t("tableFolders.windowReused", { name }));
    } catch (error) {
      notify("error", t("tableFolders.windowFailed", { error: String(error?.message || error) }));
    }
  }

  // Every table the database still has becomes a tab of this window.
  async function openHere(folder, knownTables = []) {
    const known = new Map(tableRows(knownTables).map((table) => [table.name, table]));
    const tables = folder.tableNames
      .filter((name) => !known.size || known.has(name))
      .map((tableName) => ({
        connectionId: folder.connectionId,
        database: folder.database,
        tableName,
        tableComment: known.get(tableName)?.comment || "",
      }));
    if (!tables.length) return;
    await openTables({ tables, activeName: tables[0].tableName });
  }

  async function openFolderTables(tables, activeName) {
    if (tables.length === 1) {
      await openTable(tables[0]);
      return;
    }
    await openTables({ tables, activeName });
  }

  const context = Object.freeze({
    loadTables,
    loadDatabases,
    databaseLabel,
    databaseGroups: computed(() => (unref(connections) || []).map((connection) => ({
      connectionId: connection.id,
      label: connectionLabel(connection.id, connection.label || connection.id),
      databases: connection.id === selectedConnectionId.value
        ? unref(databases) || []
        : unref(databasesByConnection)[connection.id] || [],
    }))),
    switchDatabase(tab, scope) {
      setTableFolderScope(tab, scope);
      onScopeChange(tab);
    },
    openWindow,
    openHere,
    openTables: openFolderTables,
    notify,
    confirm,
  });

  // ── Folder window ────────────────────────────────────────────────────────
  const isFolderWindow = isTableFolderWindowRole(role);

  // Tables the folder names that the database no longer has.
  function afterFolderWindowRestored() {
    if (!isFolderWindow) return;
    if (!sameScope(role, { connectionId: selectedConnectionId.value, database: selectedDatabase.value })) return;
    const present = new Set(tableRows(workspace.schema).map((table) => table.name));
    if (!present.size) return;
    const missing = role.tableNames.filter((name) => !present.has(name));
    if (missing.length) notify("warning", t("tableFolders.missingOnOpen", { count: missing.length, names: missing.join(", ") }));
  }

  // The folder was opened again from another window: add what is new since.
  async function addFolderTables(payload) {
    if (!sameScope(payload, role)) return;
    const names = (Array.isArray(payload?.tableNames) ? payload.tableNames : []).map(String).filter(Boolean);
    const open = new Set(workspace.tabs
      .filter((tab) => (tab.kind || "data") === "data" && sameScope(tab, role))
      .map((tab) => tab.tableName));
    const schemaNames = new Set(tableRows(workspace.schema).map((table) => table.name));
    const fresh = names.filter((name) => !open.has(name) && (!schemaNames.size || schemaNames.has(name)));
    if (!fresh.length) return;
    await openTables({
      tables: fresh.map((tableName) => ({ connectionId: role.connectionId, database: role.database, tableName })),
      activeName: fresh[0],
      skipConfirm: true,
    });
  }

  let unlisten = null;
  async function startFolderWindow() {
    if (!isFolderWindow || unlisten) return;
    try {
      unlisten = await listenToWindow(TABLE_FOLDER_WINDOW_OPEN_EVENT, (payload) => { void addFolderTables(payload); });
    } catch {
      unlisten = null;
    }
  }

  function dispose() {
    if (typeof unlisten === "function") unlisten();
    unlisten = null;
  }

  return {
    context,
    openPage,
    isFolderWindow,
    afterFolderWindowRestored,
    addFolderTables,
    startFolderWindow,
    dispose,
  };
}

// Events sent to this window only (see table_folder_windows.rs).
async function defaultListenToWindow(event, handler) {
  if (!globalThis.__TAURI_INTERNALS__) return null;
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().listen(event, (message) => handler(message?.payload || {}));
}
