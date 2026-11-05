import { ref } from "vue";

// Table folders: named, reference-only groups of tables inside one database.
// Each (connection, database) also has a fixed "favorites" folder, which is
// what the star in the database home toggles. Folders never move or copy
// tables; they only remember table names.
export const TABLE_FOLDERS_STORAGE_KEY = "dbscout.table-folders.v1";
export const LEGACY_TABLE_FAVORITES_STORAGE_KEY = "dbscout.table-favorites.v1";
export const TABLE_FOLDER_NAME_MAX_LENGTH = 40;
export const FAVORITES_FOLDER_KIND = "favorites";
export const USER_FOLDER_KIND = "folder";

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

function uniqueNames(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeName).filter(Boolean))];
}

function sameScope(entry, connectionId, database) {
  return (
    String(entry?.connectionId || "") === String(connectionId || "") &&
    String(entry?.database || "") === String(database || "")
  );
}

// FNV-1a, hex. Folder ids double as native window labels, so they must stay
// within [A-Za-z0-9_-] whatever the connection id or database name holds.
function hashText(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function favoritesFolderId(connectionId, database) {
  return `fav-${hashText(`${connectionId || ""}\u001f${database || ""}`)}`;
}

function randomFolderId(existingIds) {
  for (;;) {
    const id = `fld-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    if (!existingIds.has(id)) return id;
  }
}

function normalizeFolder(raw) {
  const connectionId = String(raw?.connectionId || "");
  const database = String(raw?.database || "");
  if (!database) return null;
  const kind = raw?.kind === FAVORITES_FOLDER_KIND ? FAVORITES_FOLDER_KIND : USER_FOLDER_KIND;
  const id = kind === FAVORITES_FOLDER_KIND ? favoritesFolderId(connectionId, database) : String(raw?.id || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const name = kind === FAVORITES_FOLDER_KIND ? "" : normalizeName(raw?.name).slice(0, TABLE_FOLDER_NAME_MAX_LENGTH);
  if (kind === USER_FOLDER_KIND && !name) return null;
  return {
    id,
    kind,
    name,
    connectionId,
    database,
    tableNames: uniqueNames(raw?.tableNames),
    createdAt: Number(raw?.createdAt) || 0,
    updatedAt: Number(raw?.updatedAt) || 0,
  };
}

export function normalizeTableFolders(value) {
  const source = Array.isArray(value?.folders) ? value.folders : Array.isArray(value) ? value : [];
  const byId = new Map();
  source.forEach((raw) => {
    const folder = normalizeFolder(raw);
    if (!folder) return;
    const existing = byId.get(folder.id);
    if (existing) existing.tableNames = uniqueNames([...existing.tableNames, ...folder.tableNames]);
    else byId.set(folder.id, folder);
  });
  return [...byId.values()];
}

// Favorites written by earlier versions: one flat list per database.
export function migrateLegacyFavorites(value) {
  const entries = Array.isArray(value?.entries) ? value.entries : [];
  return normalizeTableFolders(entries.map((entry) => ({
    kind: FAVORITES_FOLDER_KIND,
    connectionId: entry?.connectionId,
    database: entry?.database,
    tableNames: entry?.tableNames,
  })));
}

function readJson(storage, key) {
  try {
    return JSON.parse(storage?.getItem?.(key) || "null");
  } catch {
    return null;
  }
}

export function loadTableFolders(storage = defaultStorage()) {
  const stored = readJson(storage, TABLE_FOLDERS_STORAGE_KEY);
  if (stored?.version === 1) return normalizeTableFolders(stored);
  const legacy = readJson(storage, LEGACY_TABLE_FAVORITES_STORAGE_KEY);
  return legacy?.version === 1 ? migrateLegacyFavorites(legacy) : [];
}

export function saveTableFolders(folders, storage = defaultStorage()) {
  try {
    storage?.setItem?.(TABLE_FOLDERS_STORAGE_KEY, JSON.stringify({
      version: 1,
      folders: normalizeTableFolders(folders),
    }));
  } catch {
    // Folders are a convenience; table browsing must keep working without storage.
  }
}

function folderNameKey(name) {
  return normalizeName(name).toLocaleLowerCase();
}

export function createTableFolderStore({ storage = defaultStorage(), initialFolders, now = () => Date.now() } = {}) {
  const folders = ref(initialFolders === undefined
    ? loadTableFolders(storage)
    : normalizeTableFolders(initialFolders));

  function commit(next) {
    folders.value = next;
    saveTableFolders(next, storage);
  }

  function emptyFavorites(connectionId, database) {
    return {
      id: favoritesFolderId(connectionId, database),
      kind: FAVORITES_FOLDER_KIND,
      name: "",
      connectionId: String(connectionId || ""),
      database: String(database || ""),
      tableNames: [],
      createdAt: 0,
      updatedAt: 0,
    };
  }

  // Favorites first, then the user's folders in creation order.
  function foldersFor(connectionId, database) {
    if (!database) return [];
    const scoped = folders.value.filter((folder) => sameScope(folder, connectionId, database));
    const favorites = scoped.find((folder) => folder.kind === FAVORITES_FOLDER_KIND) || emptyFavorites(connectionId, database);
    const userFolders = scoped
      .filter((folder) => folder.kind === USER_FOLDER_KIND)
      .sort((a, b) => a.createdAt - b.createdAt);
    return [favorites, ...userFolders];
  }

  // Databases that hold at least one non-empty folder, for the scope picker.
  function scopes() {
    const seen = new Map();
    folders.value.forEach((folder) => {
      if (folder.kind === FAVORITES_FOLDER_KIND && !folder.tableNames.length) return;
      const key = `${folder.connectionId}\u001f${folder.database}`;
      if (!seen.has(key)) seen.set(key, { connectionId: folder.connectionId, database: folder.database });
    });
    return [...seen.values()];
  }

  function getFolder(id) {
    const key = String(id || "");
    return folders.value.find((folder) => folder.id === key) || null;
  }

  // Unknown favorites ids resolve against their own scope only when the caller
  // names it; plain lookups never invent folders.
  function resolveFolder(id, scope = null) {
    const stored = getFolder(id);
    if (stored) return stored;
    if (scope && String(id) === favoritesFolderId(scope.connectionId, scope.database)) {
      return emptyFavorites(scope.connectionId, scope.database);
    }
    return null;
  }

  function updateFolder(folder, patch) {
    const next = { ...folder, ...patch, updatedAt: now() };
    const exists = folders.value.some((item) => item.id === folder.id);
    commit(exists
      ? folders.value.map((item) => (item.id === folder.id ? next : item))
      : [...folders.value, next]);
    return next;
  }

  function validateName(connectionId, database, name, { exceptId = "" } = {}) {
    const trimmed = normalizeName(name);
    if (!trimmed) return "empty";
    if (trimmed.length > TABLE_FOLDER_NAME_MAX_LENGTH) return "tooLong";
    const key = folderNameKey(trimmed);
    const duplicate = folders.value.some((folder) => (
      folder.kind === USER_FOLDER_KIND &&
      folder.id !== exceptId &&
      sameScope(folder, connectionId, database) &&
      folderNameKey(folder.name) === key
    ));
    return duplicate ? "duplicate" : "";
  }

  function suggestName(connectionId, database, base) {
    const stem = normalizeName(base).slice(0, TABLE_FOLDER_NAME_MAX_LENGTH - 4) || "Folder";
    if (!validateName(connectionId, database, stem)) return stem;
    for (let index = 2; ; index += 1) {
      const candidate = `${stem} ${index}`;
      if (!validateName(connectionId, database, candidate)) return candidate;
    }
  }

  function createFolder({ connectionId, database, name, tableNames = [] } = {}) {
    if (!database) return { ok: false, error: "scope" };
    const error = validateName(connectionId, database, name);
    if (error) return { ok: false, error };
    const timestamp = now();
    const folder = {
      id: randomFolderId(new Set(folders.value.map((item) => item.id))),
      kind: USER_FOLDER_KIND,
      name: normalizeName(name),
      connectionId: String(connectionId || ""),
      database: String(database || ""),
      tableNames: uniqueNames(tableNames),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    commit([...folders.value, folder]);
    return { ok: true, folder };
  }

  function renameFolder(id, name) {
    const folder = getFolder(id);
    if (!folder || folder.kind !== USER_FOLDER_KIND) return { ok: false, error: "missing" };
    const error = validateName(folder.connectionId, folder.database, name, { exceptId: folder.id });
    if (error) return { ok: false, error };
    return { ok: true, folder: updateFolder(folder, { name: normalizeName(name) }) };
  }

  function deleteFolder(id) {
    const folder = getFolder(id);
    if (!folder || folder.kind !== USER_FOLDER_KIND) return false;
    commit(folders.value.filter((item) => item.id !== folder.id));
    return true;
  }

  // Returns how many names were new and how many were already there.
  function addTables(id, tableNames, scope = null) {
    const folder = resolveFolder(id, scope);
    const names = uniqueNames(tableNames);
    if (!folder) return { added: 0, skipped: names.length };
    const present = new Set(folder.tableNames);
    const fresh = names.filter((name) => !present.has(name));
    if (fresh.length) updateFolder(folder, { tableNames: [...folder.tableNames, ...fresh] });
    return { added: fresh.length, skipped: names.length - fresh.length };
  }

  function removeTables(id, tableNames) {
    const folder = getFolder(id);
    if (!folder) return 0;
    const drop = new Set(uniqueNames(tableNames));
    const kept = folder.tableNames.filter((name) => !drop.has(name));
    const removed = folder.tableNames.length - kept.length;
    if (removed) updateFolder(folder, { tableNames: kept });
    return removed;
  }

  // Adds the tables another folder holds right now; later changes to the
  // source folder are not followed. Only folders of the same database qualify.
  function importFolder(targetId, sourceId, scope = null) {
    const target = resolveFolder(targetId, scope);
    const source = resolveFolder(sourceId, scope);
    if (!target || !source || target.id === source.id) return { ok: false, added: 0, skipped: 0 };
    if (!sameScope(target, source.connectionId, source.database)) return { ok: false, added: 0, skipped: 0 };
    return { ok: true, ...addTables(target.id, source.tableNames, scope) };
  }

  // A table renamed in the database keeps its place in every folder.
  function renameTable(connectionId, database, oldName, newName) {
    const previous = normalizeName(oldName);
    const nextName = normalizeName(newName);
    if (!previous || !nextName || previous === nextName) return false;
    let changed = false;
    const next = folders.value.map((folder) => {
      if (!sameScope(folder, connectionId, database) || !folder.tableNames.includes(previous)) return folder;
      changed = true;
      return {
        ...folder,
        tableNames: uniqueNames(folder.tableNames.map((name) => (name === previous ? nextName : name))),
        updatedAt: now(),
      };
    });
    if (changed) commit(next);
    return changed;
  }

  // ── Favorites facade (the star in the database home) ──────────────────────
  function favoriteNames(connectionId, database) {
    return foldersFor(connectionId, database)[0]?.tableNames || [];
  }

  function isFavorite(connectionId, database, tableName) {
    const name = normalizeName(tableName);
    return Boolean(name && favoriteNames(connectionId, database).includes(name));
  }

  function toggleFavorite(connectionId, database, tableName) {
    const name = normalizeName(tableName);
    if (!database || !name) return false;
    const folder = foldersFor(connectionId, database)[0];
    if (folder.tableNames.includes(name)) {
      updateFolder(folder, { tableNames: folder.tableNames.filter((item) => item !== name) });
      return false;
    }
    updateFolder(folder, { tableNames: [...folder.tableNames, name] });
    return true;
  }

  function renameFavorite(connectionId, database, oldName, newName) {
    if (!isFavorite(connectionId, database, oldName) || !normalizeName(newName)) return false;
    return renameTable(connectionId, database, oldName, newName);
  }

  // Another window wrote the folders: adopt its copy.
  function reload() {
    folders.value = loadTableFolders(storage);
  }

  return {
    folders,
    foldersFor,
    scopes,
    getFolder,
    resolveFolder,
    validateName,
    suggestName,
    createFolder,
    renameFolder,
    deleteFolder,
    addTables,
    removeTables,
    importFolder,
    renameTable,
    favoriteNames,
    isFavorite,
    toggleFavorite,
    renameFavorite,
    reload,
  };
}

let sharedStore = null;

export function useTableFolderStore() {
  if (sharedStore) return sharedStore;
  sharedStore = createTableFolderStore();
  // Folders opened in another window edit the same storage; keep in step.
  try {
    globalThis.addEventListener?.("storage", (event) => {
      if (event?.key === TABLE_FOLDERS_STORAGE_KEY) sharedStore.reload();
    });
  } catch {
    // Non-browser runtimes (tests) have no storage events.
  }
  return sharedStore;
}
