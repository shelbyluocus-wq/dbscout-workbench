import { computed, reactive } from "vue";

import { t as translate } from "../i18n/index.js";
import { normalizeTableComment, normalizeTableName } from "../utils/normalize.js";
import { useTableFolderStore } from "./tableFolderStore.js";
import { currentWindowRole, isTableFolderWindowRole } from "../utils/windowRole.js";

export const TABLE_FOLDER_WINDOW_OPEN_EVENT = "table-folder-window-open";

function sameScope(a, b) {
  return String(a?.connectionId || "") === String(b?.connectionId || "")
    && String(a?.database || "") === String(b?.database || "");
}

function tableRows(tables) {
  return (Array.isArray(tables) ? tables : [])
    .map((table) => ({ name: normalizeTableName(table), comment: normalizeTableComment(table) }))
    .filter((table) => table.name);
}

// The table folder page (dialog) and the folder window's own start-up.
export function useTableFolders({
  invokeWorkbench,
  workspace,
  selectedConnectionId,
  selectedDatabase,
  connections,
  connectionLabel,
  databaseLabel,
  openTable,
  openTables,
  notify,
  t = translate,
  store = useTableFolderStore(),
  role = currentWindowRole(),
  listenToWindow = defaultListenToWindow,
} = {}) {
  const dialog = reactive({
    open: false,
    connectionId: "",
    database: "",
    tables: [],
    loading: false,
    loadToken: 0,
  });

  const scope = computed(() => ({ connectionId: dialog.connectionId, database: dialog.database }));

  function scopeLabel({ connectionId, database }) {
    const connection = connections.value.find((item) => item.id === connectionId);
    const name = connectionLabel(connectionId, connection?.label || connectionId);
    return `${name} · ${databaseLabel(connectionId, database) || database}`;
  }

  const scopeOptions = computed(() => {
    const options = [];
    const add = (entry) => {
      if (!entry.database || options.some((item) => sameScope(item, entry))) return;
      options.push({ connectionId: entry.connectionId, database: entry.database, label: scopeLabel(entry) });
    };
    add({ connectionId: dialog.connectionId, database: dialog.database });
    add({ connectionId: selectedConnectionId.value, database: selectedDatabase.value });
    store.scopes().forEach(add);
    return options;
  });

  // Tables of the dialog's database open in this window, in tab order.
  const openTableNames = computed(() => workspace.tabs
    .filter((tab) => (tab.kind || "data") === "data" && sameScope(tab, scope.value))
    .map((tab) => tab.tableName)
    .filter(Boolean));

  async function loadTables() {
    const token = ++dialog.loadToken;
    const target = { connectionId: dialog.connectionId, database: dialog.database };
    if (!target.database) {
      dialog.tables = [];
      return;
    }
    // The database already shown in the sidebar needs no round trip.
    if (sameScope(target, { connectionId: selectedConnectionId.value, database: selectedDatabase.value }) && workspace.schema.length) {
      dialog.tables = tableRows(workspace.schema);
      dialog.loading = false;
      return;
    }
    dialog.loading = true;
    dialog.tables = [];
    try {
      const tables = await invokeWorkbench("list_tables", { ...target, priority: "visible" });
      if (token === dialog.loadToken) dialog.tables = tableRows(tables);
    } catch (error) {
      if (token === dialog.loadToken) notify("error", String(error?.message || error));
    } finally {
      if (token === dialog.loadToken) dialog.loading = false;
    }
  }

  function setScope({ connectionId = "", database = "" } = {}) {
    dialog.connectionId = String(connectionId || "");
    dialog.database = String(database || "");
    void loadTables();
  }

  function open(target = null) {
    const focusedTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId);
    const initial = target?.database
      ? target
      : focusedTab?.database
        ? { connectionId: focusedTab.connectionId, database: focusedTab.database }
        : { connectionId: selectedConnectionId.value, database: selectedDatabase.value };
    setScope(initial);
    dialog.open = true;
  }

  function close() {
    dialog.open = false;
    dialog.loadToken += 1;
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
      notify("success", result?.reused ? t("tableFolders.windowReused", { name }) : t("tableFolders.windowOpened", { name }));
      close();
    } catch (error) {
      notify("error", t("tableFolders.windowFailed", { error: String(error?.message || error) }));
    }
  }

  function folderTables(folder) {
    const known = new Map((sameScope(folder, scope.value) ? dialog.tables : []).map((table) => [table.name, table]));
    return folder.tableNames
      .filter((name) => !known.size || known.has(name))
      .map((tableName) => ({
        connectionId: folder.connectionId,
        database: folder.database,
        tableName,
        tableComment: known.get(tableName)?.comment || "",
      }));
  }

  async function openHere(folder) {
    const tables = folderTables(folder);
    if (!tables.length) return;
    close();
    await openTables({ tables, activeName: tables[0].tableName });
  }

  async function openOne({ connectionId, database, tableName } = {}) {
    if (!tableName) return;
    const comment = dialog.tables.find((table) => table.name === tableName)?.comment || "";
    close();
    await openTable({ connectionId, database, tableName, tableComment: comment });
  }

  // ── Folder window ────────────────────────────────────────────────────────
  const isFolderWindow = isTableFolderWindowRole(role);

  // Tables the folder names that the database no longer has.
  function reportMissing(tableNames, scopeTables) {
    const present = new Set(tableRows(scopeTables).map((table) => table.name));
    if (!present.size) return;
    const missing = tableNames.filter((name) => !present.has(name));
    if (!missing.length) return;
    notify("warning", t("tableFolders.missingOnOpen", { count: missing.length, names: missing.join(", ") }));
  }

  function afterFolderWindowRestored() {
    if (!isFolderWindow) return;
    if (sameScope(role, { connectionId: selectedConnectionId.value, database: selectedDatabase.value })) {
      reportMissing(role.tableNames, workspace.schema);
    }
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
    dialog,
    scope,
    scopeOptions,
    openTableNames,
    open,
    close,
    setScope,
    openWindow,
    openHere,
    openOne,
    isFolderWindow,
    windowRole: role,
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
