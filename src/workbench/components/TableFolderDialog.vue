<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, ref, watch } from "vue";
import {
  AppWindow,
  Check,
  Folder,
  FolderInput,
  FolderPlus,
  PanelsTopLeft,
  Pencil,
  Plus,
  Search,
  Star,
  Table2,
  Trash2,
  X,
} from "lucide-vue-next";

import { useEscClose } from "../composables/useEscClose.js";
import {
  FAVORITES_FOLDER_KIND,
  TABLE_FOLDER_NAME_MAX_LENGTH,
  useTableFolderStore,
} from "../composables/tableFolderStore.js";

// A Finder-like page for table folders: folders of one database on the left,
// the tables a folder refers to on the right. Folders only remember names.
const props = defineProps({
  scope: { type: Object, default: () => ({ connectionId: "", database: "" }) },
  // [{ connectionId, database, label }] — databases that hold folders plus the current one.
  scopeOptions: { type: Array, default: () => [] },
  // [{ name, comment }] of the scope's database.
  tables: { type: Array, default: () => [] },
  tablesLoading: { type: Boolean, default: false },
  // Tables of the scope open in this window, for "save open tabs".
  openTableNames: { type: Array, default: () => [] },
  theme: { type: String, default: "light" },
  confirm: { type: Function, default: null },
});

const emit = defineEmits(["close", "change-scope", "open-window", "open-here", "open-table", "notice"]);

const store = useTableFolderStore();
const dialogRef = ref(null);
const renameInputRef = ref(null);
const searchInputRef = ref(null);
const selectedFolderId = ref("");
const renamingId = ref("");
const renameDraft = ref("");
const renameError = ref("");
const mode = ref("list"); // "list" | "add"
const addQuery = ref("");
const addSelection = ref(new Set());
const importMenuOpen = ref(false);
const focusedTable = ref("");

useEscClose(() => true, () => {
  if (renamingId.value) cancelRename();
  else if (importMenuOpen.value) importMenuOpen.value = false;
  else if (mode.value === "add") mode.value = "list";
  else emit("close");
}, null, { dialogRef });

const scopeKey = computed(() => `${props.scope?.connectionId || ""}\u001f${props.scope?.database || ""}`);
const folders = computed(() => store.foldersFor(props.scope?.connectionId, props.scope?.database));
const selectedFolder = computed(() => (
  folders.value.find((folder) => folder.id === selectedFolderId.value) || folders.value[0] || null
));
const isFavorites = computed(() => selectedFolder.value?.kind === FAVORITES_FOLDER_KIND);
const tableByName = computed(() => new Map(props.tables.map((table) => [table.name, table])));
const folderRows = computed(() => (selectedFolder.value?.tableNames || []).map((name) => ({
  name,
  comment: tableByName.value.get(name)?.comment || "",
  missing: !props.tablesLoading && props.tables.length > 0 && !tableByName.value.has(name),
})));
const importSources = computed(() => folders.value.filter((folder) => (
  folder.id !== selectedFolder.value?.id && folder.tableNames.length > 0
)));
const addCandidates = computed(() => {
  const query = addQuery.value.trim().toLocaleLowerCase();
  const present = new Set(selectedFolder.value?.tableNames || []);
  return props.tables
    .filter((table) => !query || `${table.name} ${table.comment || ""}`.toLocaleLowerCase().includes(query))
    .map((table) => ({ ...table, present: present.has(table.name) }));
});
const openTabNamesInScope = computed(() => [...new Set(props.openTableNames)]);
const selectedScopeValue = computed(() => scopeKey.value);

watch(scopeKey, () => {
  selectedFolderId.value = "";
  mode.value = "list";
  cancelRename();
}, { immediate: true });

function folderLabel(folder) {
  return folder?.kind === FAVORITES_FOLDER_KIND ? t("tableFolders.favorites") : folder?.name || "";
}

function nameError(code) {
  if (code === "empty") return t("tableFolders.nameEmpty");
  if (code === "duplicate") return t("tableFolders.nameDuplicate");
  if (code === "tooLong") return t("tableFolders.nameTooLong", { max: TABLE_FOLDER_NAME_MAX_LENGTH });
  return "";
}

function selectFolder(folder) {
  if (renamingId.value && renamingId.value !== folder.id) commitRename();
  selectedFolderId.value = folder.id;
  mode.value = "list";
  importMenuOpen.value = false;
  focusedTable.value = "";
}

function notify(tone, message) {
  emit("notice", { tone, message });
}

function createFolder(tableNames = [], baseName = t("tableFolders.defaultName")) {
  const { connectionId, database } = props.scope || {};
  const name = store.suggestName(connectionId, database, baseName);
  const result = store.createFolder({ connectionId, database, name, tableNames });
  if (!result.ok) {
    notify("error", nameError(result.error));
    return;
  }
  selectedFolderId.value = result.folder.id;
  mode.value = "list";
  startRename(result.folder);
}

function saveOpenTabs() {
  if (!openTabNamesInScope.value.length) return;
  createFolder(openTabNamesInScope.value, t("tableFolders.saveTabsName"));
}

function startRename(folder = selectedFolder.value) {
  if (!folder || folder.kind === FAVORITES_FOLDER_KIND) return;
  renamingId.value = folder.id;
  renameDraft.value = folder.name;
  renameError.value = "";
  void nextTick(() => {
    const input = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value;
    input?.focus();
    input?.select();
  });
}

function commitRename() {
  if (!renamingId.value) return;
  const folder = store.getFolder(renamingId.value);
  if (folder && renameDraft.value.trim() === folder.name) {
    cancelRename();
    return;
  }
  const result = store.renameFolder(renamingId.value, renameDraft.value);
  if (!result.ok) {
    renameError.value = nameError(result.error);
    return;
  }
  cancelRename();
}

function cancelRename() {
  renamingId.value = "";
  renameDraft.value = "";
  renameError.value = "";
}

async function deleteSelectedFolder() {
  const folder = selectedFolder.value;
  if (!folder || folder.kind === FAVORITES_FOLDER_KIND) return;
  const ok = props.confirm
    ? await props.confirm({
      title: t("tableFolders.deleteConfirmTitle"),
      message: t("tableFolders.deleteConfirmMessage", { name: folder.name }),
      confirmText: t("tableFolders.delete"),
      cancelText: t("tableFolders.cancel"),
      danger: true,
    })
    : true;
  if (!ok) return;
  store.deleteFolder(folder.id);
  selectedFolderId.value = "";
}

function removeTable(name) {
  const folder = selectedFolder.value;
  if (!folder) return;
  const rows = folderRows.value;
  const index = rows.findIndex((row) => row.name === name);
  store.removeTables(folder.id, [name]);
  focusedTable.value = rows[index + 1]?.name || rows[index - 1]?.name || "";
}

function openAddTables() {
  addQuery.value = "";
  addSelection.value = new Set();
  importMenuOpen.value = false;
  mode.value = "add";
  void nextTick(() => searchInputRef.value?.focus());
}

function toggleCandidate(table) {
  if (table.present) return;
  const next = new Set(addSelection.value);
  if (next.has(table.name)) next.delete(table.name);
  else next.add(table.name);
  addSelection.value = next;
}

function reportAdded(folder, { added, skipped }) {
  const name = folderLabel(folder);
  if (!added) {
    notify("info", t("tableFolders.nothingAdded", { name }));
    return;
  }
  notify("success", skipped
    ? t("tableFolders.addedSkipped", { added, skipped, name })
    : t("tableFolders.added", { added, name }));
}

function addSelectedTables() {
  const folder = selectedFolder.value;
  if (!folder || !addSelection.value.size) return;
  const names = props.tables.map((table) => table.name).filter((name) => addSelection.value.has(name));
  reportAdded(folder, store.addTables(folder.id, names, props.scope));
  mode.value = "list";
}

function importFrom(source) {
  const target = selectedFolder.value;
  importMenuOpen.value = false;
  if (!target) return;
  const result = store.importFolder(target.id, source.id, props.scope);
  if (result.ok) reportAdded(target, result);
}

function openWindow() {
  const folder = selectedFolder.value;
  if (!folder?.tableNames.length) return;
  emit("open-window", { ...folder, displayName: folderLabel(folder) });
}

function openHere() {
  const folder = selectedFolder.value;
  if (!folder?.tableNames.length) return;
  emit("open-here", { ...folder, displayName: folderLabel(folder) });
}

function openTable(row) {
  if (row.missing) return;
  emit("open-table", { connectionId: props.scope.connectionId, database: props.scope.database, tableName: row.name });
}

function onTableKeydown(event, row) {
  if (event.key === "Enter") {
    event.preventDefault();
    openTable(row);
  } else if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    removeTable(row.name);
    void nextTick(() => dialogRef.value?.querySelector?.(".wb-table-folder-row.is-focused")?.focus());
  }
}

function onFolderKeydown(event, folder) {
  if (event.key === "F2") {
    event.preventDefault();
    startRename(folder);
  }
}

function changeScope(event) {
  const option = props.scopeOptions.find((item) => `${item.connectionId}\u001f${item.database}` === event.target.value);
  if (option) emit("change-scope", { connectionId: option.connectionId, database: option.database });
}
</script>

<template>
  <Teleport to="body">
    <div class="wb-shortcut-dialog-overlay wb-mcp-dialog-overlay wb-table-folder-overlay wb-floating-themed" :data-theme="theme">
      <section
        ref="dialogRef"
        class="wb-shortcut-dialog wb-table-folder-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wb-table-folder-title"
        tabindex="-1"
      >
        <header class="wb-shortcut-dialog-header wb-mcp-dialog-header wb-table-folder-header">
          <strong id="wb-table-folder-title">{{ t("tableFolders.title") }}</strong>
          <label v-if="scopeOptions.length" class="wb-table-folder-scope">
            <span>{{ t("tableFolders.scopeLabel") }}</span>
            <select :value="selectedScopeValue" @change="changeScope">
              <option
                v-for="option in scopeOptions"
                :key="`${option.connectionId}\u001f${option.database}`"
                :value="`${option.connectionId}\u001f${option.database}`"
              >{{ option.label }}</option>
            </select>
          </label>
          <button type="button" class="wb-shortcut-dialog-close wb-mcp-dialog-close" :aria-label="t('m_3fd47edce45b')" @click="emit('close')">
            <X :size="16" />
          </button>
        </header>

        <p v-if="!scope?.database" class="wb-table-folder-empty-scope">{{ t("tableFolders.noDatabase") }}</p>

        <div v-else class="wb-table-folder-body">
          <nav class="wb-table-folder-sidebar" :aria-label="t('tableFolders.folderList')">
            <ul class="wb-table-folder-list">
              <li v-for="folder in folders" :key="folder.id">
                <div
                  v-if="renamingId === folder.id"
                  class="wb-table-folder-item is-selected is-renaming"
                >
                  <Folder :size="15" aria-hidden="true" />
                  <input
                    ref="renameInputRef"
                    v-model="renameDraft"
                    class="wb-table-folder-rename"
                    :maxlength="TABLE_FOLDER_NAME_MAX_LENGTH"
                    :aria-label="t('tableFolders.rename')"
                    :aria-invalid="renameError ? 'true' : 'false'"
                    @keydown.enter.prevent="commitRename"
                    @keydown.esc.prevent.stop="cancelRename"
                    @blur="commitRename"
                  />
                </div>
                <button
                  v-else
                  type="button"
                  class="wb-table-folder-item"
                  :class="{ 'is-selected': folder.id === selectedFolder?.id }"
                  :aria-current="folder.id === selectedFolder?.id ? 'true' : undefined"
                  @click="selectFolder(folder)"
                  @dblclick="startRename(folder)"
                  @keydown="onFolderKeydown($event, folder)"
                >
                  <Star v-if="folder.kind === 'favorites'" :size="15" aria-hidden="true" class="wb-table-folder-star" />
                  <Folder v-else :size="15" aria-hidden="true" />
                  <span class="wb-table-folder-name">{{ folderLabel(folder) }}</span>
                  <small>{{ folder.tableNames.length }}</small>
                </button>
                <p v-if="renamingId === folder.id && renameError" class="wb-table-folder-error" role="alert">{{ renameError }}</p>
              </li>
            </ul>
            <div class="wb-table-folder-sidebar-actions">
              <button type="button" @click="createFolder()">
                <FolderPlus :size="15" aria-hidden="true" />{{ t("tableFolders.newFolder") }}
              </button>
              <button type="button" :disabled="!openTabNamesInScope.length" :title="t('tableFolders.saveTabsHint')" @click="saveOpenTabs">
                <PanelsTopLeft :size="15" aria-hidden="true" />{{ t("tableFolders.saveTabs") }}
              </button>
            </div>
          </nav>

          <section v-if="selectedFolder" class="wb-table-folder-content" :aria-label="t('tableFolders.tablesOf', { name: folderLabel(selectedFolder) })">
            <div class="wb-table-folder-toolbar">
              <div class="wb-table-folder-heading">
                <strong>{{ folderLabel(selectedFolder) }}</strong>
                <span>{{ t("tableFolders.tableCount", { count: selectedFolder.tableNames.length }) }}</span>
                <button v-if="!isFavorites" type="button" class="wb-table-folder-icon-button" :title="t('tableFolders.rename')" :aria-label="t('tableFolders.rename')" @click="startRename()">
                  <Pencil :size="14" />
                </button>
                <button v-if="!isFavorites" type="button" class="wb-table-folder-icon-button is-danger" :title="t('tableFolders.delete')" :aria-label="t('tableFolders.delete')" @click="deleteSelectedFolder">
                  <Trash2 :size="14" />
                </button>
              </div>
              <div class="wb-table-folder-actions">
                <button type="button" :aria-pressed="mode === 'add' ? 'true' : 'false'" @click="mode === 'add' ? (mode = 'list') : openAddTables()">
                  <Plus :size="15" aria-hidden="true" />{{ t("tableFolders.addTables") }}
                </button>
                <div class="wb-table-folder-import">
                  <button type="button" aria-haspopup="menu" :aria-expanded="importMenuOpen ? 'true' : 'false'" @click="importMenuOpen = !importMenuOpen">
                    <FolderInput :size="15" aria-hidden="true" />{{ t("tableFolders.addFolder") }}
                  </button>
                  <div v-if="importMenuOpen" class="wb-table-folder-import-menu" role="menu">
                    <p>{{ t("tableFolders.addFolderHint") }}</p>
                    <button
                      v-for="source in importSources"
                      :key="source.id"
                      type="button"
                      role="menuitem"
                      @click="importFrom(source)"
                    >
                      <Star v-if="source.kind === 'favorites'" :size="14" aria-hidden="true" class="wb-table-folder-star" />
                      <Folder v-else :size="14" aria-hidden="true" />
                      <span>{{ folderLabel(source) }}</span>
                      <small>{{ source.tableNames.length }}</small>
                    </button>
                    <p v-if="!importSources.length" class="wb-table-folder-muted">{{ t("tableFolders.noOtherFolders") }}</p>
                  </div>
                </div>
                <button type="button" :disabled="!selectedFolder.tableNames.length" @click="openHere">
                  <Table2 :size="15" aria-hidden="true" />{{ t("tableFolders.openHere") }}
                </button>
                <button type="button" class="is-primary" :disabled="!selectedFolder.tableNames.length" @click="openWindow">
                  <AppWindow :size="15" aria-hidden="true" />{{ t("tableFolders.openWindow") }}
                </button>
              </div>
            </div>

            <div v-if="mode === 'add'" class="wb-table-folder-picker">
              <label class="wb-table-folder-search">
                <Search :size="14" aria-hidden="true" />
                <input ref="searchInputRef" v-model="addQuery" type="search" :placeholder="t('tableFolders.search')" :aria-label="t('tableFolders.search')" @keydown.enter.prevent="addSelectedTables" />
              </label>
              <ul class="wb-table-folder-rows" role="listbox" aria-multiselectable="true">
                <li v-for="table in addCandidates" :key="table.name">
                  <button
                    type="button"
                    role="option"
                    class="wb-table-folder-row"
                    :class="{ 'is-checked': table.present || addSelection.has(table.name), 'is-present': table.present }"
                    :aria-selected="table.present || addSelection.has(table.name) ? 'true' : 'false'"
                    :aria-disabled="table.present ? 'true' : undefined"
                    @click="toggleCandidate(table)"
                  >
                    <span class="wb-table-folder-check" aria-hidden="true"><Check v-if="table.present || addSelection.has(table.name)" :size="12" /></span>
                    <span class="wb-table-folder-table">{{ table.name }}</span>
                    <span class="wb-table-folder-comment">{{ table.present ? t("tableFolders.alreadyIn") : table.comment }}</span>
                  </button>
                </li>
                <li v-if="tablesLoading" class="wb-table-folder-muted">{{ t("tableFolders.loadingTables") }}</li>
                <li v-else-if="!addCandidates.length" class="wb-table-folder-muted">{{ t("m_4034e355eb62") }}</li>
              </ul>
              <div class="wb-table-folder-picker-footer">
                <button type="button" @click="mode = 'list'">{{ t("tableFolders.cancel") }}</button>
                <button type="button" class="is-primary" :disabled="!addSelection.size" @click="addSelectedTables">
                  {{ t("tableFolders.addSelected", { count: addSelection.size }) }}
                </button>
              </div>
            </div>

            <ul v-else-if="folderRows.length" class="wb-table-folder-rows">
              <li v-for="row in folderRows" :key="row.name">
                <div
                  class="wb-table-folder-row"
                  :class="{ 'is-missing': row.missing, 'is-focused': focusedTable === row.name }"
                  tabindex="0"
                  :title="row.missing ? t('tableFolders.missingHint') : t('tableFolders.openTableHint')"
                  @focus="focusedTable = row.name"
                  @dblclick="openTable(row)"
                  @keydown="onTableKeydown($event, row)"
                >
                  <Table2 :size="14" aria-hidden="true" class="wb-table-folder-row-icon" />
                  <span class="wb-table-folder-table">{{ row.name }}</span>
                  <span v-if="row.missing" class="wb-table-folder-missing">{{ t("tableFolders.missing") }}</span>
                  <span v-else class="wb-table-folder-comment">{{ row.comment }}</span>
                  <button type="button" class="wb-table-folder-icon-button" :title="t('tableFolders.removeTable', { table: row.name })" :aria-label="t('tableFolders.removeTable', { table: row.name })" @click.stop="removeTable(row.name)">
                    <X :size="13" />
                  </button>
                </div>
              </li>
            </ul>
            <p v-else class="wb-table-folder-empty">{{ isFavorites ? t("tableFolders.emptyFavorites") : t("tableFolders.emptyFolder") }}</p>
          </section>
        </div>

        <footer v-if="scope?.database" class="wb-table-folder-footer">{{ t("tableFolders.footer") }}</footer>
      </section>
    </div>
  </Teleport>
</template>
