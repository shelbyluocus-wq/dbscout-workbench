<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AppWindow, ArrowLeft, Check, Folder, FolderOpen, Pencil, Plus, Search, Star, Table2, Trash2, X } from "lucide-vue-next";

import { useTableFolderContext } from "../composables/tableFolderContext.js";
import {
  FAVORITES_FOLDER_KIND,
  TABLE_FOLDER_NAME_MAX_LENGTH,
  useTableFolderStore,
} from "../composables/tableFolderStore.js";
import { formatShortcutForPlatform, isMacOSPlatform } from "../utils/desktopPlatform.js";
import { isContextMenuKey, isDeleteCommandKey, nextListSelection } from "../utils/listSelection.js";
import { focusMenuItem, handleMenuKeydown } from "../utils/menuKeyboard.js";
import { isFolderDropCandidate, readFolderDrop, writeFolderDrag, writeTableDrag } from "../utils/tableDragPayload.js";

// One database's table folders as a workbench page: folders on the left, the
// tables a folder refers to on the right. Tables join a folder by dragging
// (from the sidebar, from another folder, or a whole folder onto a folder) or
// through the table picker. Rare actions live in right-click menus.
const props = defineProps({
  tab: { type: Object, required: true },
});

const store = useTableFolderStore();
const context = useTableFolderContext();
const rootRef = ref(null);
const menuRef = ref(null);
const renameInputRef = ref(null);
const pickSearchRef = ref(null);

const view = ref("folder"); // "folder" | "pick"
const tables = ref([]);
const tablesLoaded = ref(false);
const tablesLoading = ref(false);
const selectedNames = ref([]);
const selectionAnchor = ref("");
const renamingId = ref("");
const renameDraft = ref("");
const renameError = ref("");
const dropTargetId = ref("");
const contentDropActive = ref(false);
const pickQuery = ref("");
const pickSelection = ref([]);
const pickAnchor = ref("");
const menu = ref({ open: false, x: 0, y: 0, kind: "", folderId: "", tableNames: [] });

const scope = computed(() => ({ connectionId: String(props.tab.connectionId || ""), database: String(props.tab.database || "") }));
const folders = computed(() => store.foldersFor(scope.value.connectionId, scope.value.database));
const currentFolder = computed(() => (
  folders.value.find((folder) => folder.id === props.tab.folderId) || folders.value[0] || null
));
const tableByName = computed(() => new Map(tables.value.map((table) => [table.name, table])));
const folderRows = computed(() => (currentFolder.value?.tableNames || []).map((name) => ({
  name,
  comment: tableByName.value.get(name)?.comment || "",
  missing: tablesLoaded.value && tables.value.length > 0 && !tableByName.value.has(name),
})));
const rowOrder = computed(() => folderRows.value.map((row) => row.name));
const selectedSet = computed(() => new Set(selectedNames.value));
const pickRows = computed(() => {
  const query = pickQuery.value.trim().toLocaleLowerCase();
  const present = new Set(currentFolder.value?.tableNames || []);
  return tables.value
    .filter((table) => !query || `${table.name} ${table.comment}`.toLocaleLowerCase().includes(query))
    .map((table) => ({ ...table, present: present.has(table.name) }));
});
const pickSet = computed(() => new Set(pickSelection.value));
const deleteKeyLabel = computed(() => formatShortcutForPlatform(isMacOSPlatform() ? "Backspace" : "Delete"));
const menuFolder = computed(() => store.getFolder(menu.value.folderId) || folders.value.find((folder) => folder.id === menu.value.folderId) || null);
const menuStyle = computed(() => ({ left: `${menu.value.x}px`, top: `${menu.value.y}px` }));

function folderLabel(folder) {
  return folder?.kind === FAVORITES_FOLDER_KIND ? t("tableFolders.favorites") : folder?.name || "";
}

function notify(tone, message) {
  context?.notify?.(tone, message);
}

async function loadTables() {
  if (!context?.loadTables || !scope.value.database) return;
  tablesLoading.value = true;
  try {
    tables.value = await context.loadTables(scope.value);
    tablesLoaded.value = true;
  } catch (error) {
    notify("error", String(error?.message || error));
  } finally {
    tablesLoading.value = false;
  }
}

function selectFolder(folder) {
  if (!folder) return;
  props.tab.folderId = folder.id;
  selectedNames.value = [];
  selectionAnchor.value = "";
}

watch(() => currentFolder.value?.id, () => {
  selectedNames.value = selectedNames.value.filter((name) => currentFolder.value?.tableNames.includes(name));
});

// ── Folders ──────────────────────────────────────────────────────────────
function nameError(code) {
  if (code === "empty") return t("tableFolders.nameEmpty");
  if (code === "duplicate") return t("tableFolders.nameDuplicate");
  if (code === "tooLong") return t("tableFolders.nameTooLong", { max: TABLE_FOLDER_NAME_MAX_LENGTH });
  return "";
}

function createFolder() {
  const { connectionId, database } = scope.value;
  const name = store.suggestName(connectionId, database, t("tableFolders.defaultName"));
  const result = store.createFolder({ connectionId, database, name });
  if (!result.ok) return;
  selectFolder(result.folder);
  startRename(result.folder);
}

function startRename(folder) {
  if (!folder || folder.kind === FAVORITES_FOLDER_KIND) return;
  closeMenu();
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
  if (!folder || renameDraft.value.trim() === folder.name) {
    cancelRename();
    return;
  }
  const result = store.renameFolder(folder.id, renameDraft.value);
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

async function deleteFolder(folder) {
  closeMenu();
  if (!folder || folder.kind === FAVORITES_FOLDER_KIND) return;
  const ok = context?.confirm
    ? await context.confirm({
      title: t("tableFolders.deleteConfirmTitle"),
      message: t("tableFolders.deleteConfirmMessage", { name: folder.name }),
      confirmText: t("tableFolders.delete"),
      cancelText: t("tableFolders.cancel"),
      danger: true,
    })
    : true;
  if (!ok) return;
  const index = folders.value.findIndex((item) => item.id === folder.id);
  store.deleteFolder(folder.id);
  if (props.tab.folderId === folder.id) selectFolder(folders.value[Math.max(0, index - 1)]);
}

function onFolderKeydown(event, folder) {
  if (event.key === "F2") {
    event.preventDefault();
    startRename(folder);
  } else if (isDeleteCommandKey(event) && folder.kind !== FAVORITES_FOLDER_KIND) {
    event.preventDefault();
    void deleteFolder(folder);
  } else if (isContextMenuKey(event)) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu({ kind: "folder", folderId: folder.id, x: rect.left + 12, y: rect.bottom - 4 }, { keyboard: true });
  }
}

// ── Opening ──────────────────────────────────────────────────────────────
function openableFolder(folder) {
  return folder ? { ...folder, displayName: folderLabel(folder) } : null;
}

function openInWindow(folder = currentFolder.value) {
  closeMenu();
  if (!folder?.tableNames.length) return;
  void context?.openWindow?.(openableFolder(folder), tables.value);
}

function openHere(folder = currentFolder.value) {
  closeMenu();
  if (!folder?.tableNames.length) return;
  void context?.openHere?.(openableFolder(folder), tables.value);
}

function openRows(names) {
  closeMenu();
  const rows = folderRows.value.filter((row) => names.includes(row.name) && !row.missing);
  if (!rows.length) return;
  void context?.openTables?.(rows.map((row) => ({
    connectionId: scope.value.connectionId,
    database: scope.value.database,
    tableName: row.name,
    tableComment: row.comment,
  })), rows[0].name);
}

// ── Folder contents ──────────────────────────────────────────────────────
function onRowClick(row, event) {
  const next = nextListSelection({ order: rowOrder.value, selected: selectedNames.value, anchor: selectionAnchor.value, name: row.name, event });
  selectedNames.value = next.selected;
  selectionAnchor.value = next.anchor;
}

function rowsForAction(row) {
  return selectedSet.value.has(row.name) ? rowOrder.value.filter((name) => selectedSet.value.has(name)) : [row.name];
}

function removeRows(names) {
  closeMenu();
  const folder = currentFolder.value;
  if (!folder || !names.length) return;
  const order = rowOrder.value;
  const last = Math.max(...names.map((name) => order.indexOf(name)));
  store.removeTables(folder.id, names);
  const remaining = order.filter((name) => !names.includes(name));
  const next = order.slice(last + 1).find((name) => remaining.includes(name)) || remaining.at(-1) || "";
  selectedNames.value = next ? [next] : [];
  selectionAnchor.value = next;
  if (next) void nextTick(() => rootRef.value?.querySelector?.(`.wb-folder-row[data-table-name="${CSS.escape(next)}"]`)?.focus());
}

function onRowKeydown(event, row) {
  if (event.key === "Enter") {
    event.preventDefault();
    openRows(rowsForAction(row));
  } else if (isDeleteCommandKey(event)) {
    event.preventDefault();
    removeRows(rowsForAction(row));
  } else if (isContextMenuKey(event)) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    if (!selectedSet.value.has(row.name)) onRowClick(row, {});
    openMenu({ kind: "table", tableNames: rowsForAction(row), x: rect.left + 24, y: rect.bottom - 4 }, { keyboard: true });
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const index = rowOrder.value.indexOf(row.name) + (event.key === "ArrowDown" ? 1 : -1);
    const target = rowOrder.value[index];
    if (!target) return;
    onRowClick({ name: target }, event.shiftKey ? { shiftKey: true } : {});
    rootRef.value?.querySelector?.(`.wb-folder-row[data-table-name="${CSS.escape(target)}"]`)?.focus();
  }
}

function onRowContextMenu(event, row) {
  if (!selectedSet.value.has(row.name)) onRowClick(row, {});
  openMenu({ kind: "table", tableNames: rowsForAction(row), x: event.clientX, y: event.clientY });
}

function onRowDragStart(event, row) {
  if (!selectedSet.value.has(row.name)) onRowClick(row, {});
  writeTableDrag(event, { ...scope.value, tableNames: rowsForAction(row) });
}

// ── Drag and drop onto folders ───────────────────────────────────────────
function reportAdded(folder, { added, skipped }) {
  const name = folderLabel(folder);
  if (!added) notify("info", t("tableFolders.nothingAdded", { name }));
  else if (skipped) notify("success", t("tableFolders.addedSkipped", { added, skipped, name }));
  else notify("success", t("tableFolders.added", { added, name }));
}

function onFolderDragOver(event, folder) {
  if (!isFolderDropCandidate(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  dropTargetId.value = folder.id;
}

function onFolderDragLeave(event, folder) {
  if (event.currentTarget.contains(event.relatedTarget)) return;
  if (dropTargetId.value === folder.id) dropTargetId.value = "";
}

function dropInto(folder, event) {
  dropTargetId.value = "";
  contentDropActive.value = false;
  const payload = readFolderDrop(event);
  if (!folder || !payload) return;
  event.preventDefault();
  if (payload.kind === "folder") {
    if (payload.folderId === folder.id) return;
    const result = store.importFolder(folder.id, payload.folderId, scope.value);
    if (result.ok) reportAdded(folder, result);
    return;
  }
  if (payload.connectionId !== scope.value.connectionId || payload.database !== scope.value.database) {
    notify("warning", t("tableFolders.otherDatabase"));
    return;
  }
  reportAdded(folder, store.addTables(folder.id, payload.tableNames, scope.value));
}

function onContentDragOver(event) {
  if (!isFolderDropCandidate(event) || !currentFolder.value) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  contentDropActive.value = true;
}

function onContentDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) contentDropActive.value = false;
}

// ── Table picker ─────────────────────────────────────────────────────────
function openPicker() {
  pickQuery.value = "";
  pickSelection.value = [];
  pickAnchor.value = "";
  view.value = "pick";
  if (!tablesLoaded.value && !tablesLoading.value) void loadTables();
  void nextTick(() => pickSearchRef.value?.focus());
}

function closePicker() {
  view.value = "folder";
}

function togglePick(row, event) {
  if (row.present) return;
  const order = pickRows.value.filter((item) => !item.present).map((item) => item.name);
  if (event?.shiftKey && pickAnchor.value) {
    pickSelection.value = nextListSelection({ order, selected: pickSelection.value, anchor: pickAnchor.value, name: row.name, event: { shiftKey: true, ctrlKey: true } }).selected;
    return;
  }
  pickSelection.value = pickSet.value.has(row.name)
    ? pickSelection.value.filter((name) => name !== row.name)
    : [...pickSelection.value, row.name];
  pickAnchor.value = row.name;
}

function submitPicks() {
  const folder = currentFolder.value;
  if (!folder || !pickSelection.value.length) return;
  const names = tables.value.map((table) => table.name).filter((name) => pickSet.value.has(name));
  reportAdded(folder, store.addTables(folder.id, names, scope.value));
  closePicker();
}

function onPickKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePicker();
  }
}

// ── Menu ─────────────────────────────────────────────────────────────────
function openMenu({ kind, folderId = "", tableNames = [], x, y }, { keyboard = false } = {}) {
  const width = 200;
  const height = kind === "folder" ? 168 : 84;
  menu.value = {
    open: true,
    kind,
    folderId,
    tableNames,
    x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  };
  if (keyboard) void nextTick(() => focusMenuItem(menuRef.value, "first"));
}

function onFolderContextMenu(event, folder) {
  selectFolder(folder);
  openMenu({ kind: "folder", folderId: folder.id, x: event.clientX, y: event.clientY });
}

function closeMenu() {
  if (menu.value.open) menu.value = { ...menu.value, open: false };
}

function onMenuKeydown(event) {
  handleMenuKeydown(event, menuRef.value, { close: closeMenu });
}

function onDocumentPointerDown(event) {
  if (menu.value.open && !menuRef.value?.contains(event.target)) closeMenu();
}

// A menu opened with the mouse has no focus of its own; Escape still closes it.
function onDocumentKeydown(event) {
  if (!menu.value.open || event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
}

onMounted(() => {
  void loadTables();
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  document.removeEventListener("keydown", onDocumentKeydown, true);
});

watch(() => `${scope.value.connectionId}\u001f${scope.value.database}`, () => {
  tablesLoaded.value = false;
  void loadTables();
});
</script>

<template>
  <section ref="rootRef" class="wb-folder-page" :aria-label="t('tableFolders.title')">
    <template v-if="view === 'folder'">
      <nav class="wb-folder-sidebar" :aria-label="t('tableFolders.folderList')">
        <ul class="wb-folder-list">
          <li v-for="folder in folders" :key="folder.id">
            <div v-if="renamingId === folder.id" class="wb-folder-item is-selected">
              <Folder :size="15" aria-hidden="true" />
              <input
                ref="renameInputRef"
                v-model="renameDraft"
                class="wb-folder-rename"
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
              class="wb-folder-item"
              :class="{ 'is-selected': folder.id === currentFolder?.id, 'is-drop-target': dropTargetId === folder.id }"
              :aria-current="folder.id === currentFolder?.id ? 'true' : undefined"
              :data-folder-id="folder.id"
              draggable="true"
              @click="selectFolder(folder)"
              @keydown="onFolderKeydown($event, folder)"
              @contextmenu.prevent.stop="onFolderContextMenu($event, folder)"
              @dragstart="writeFolderDrag($event, folder.id)"
              @dragover="onFolderDragOver($event, folder)"
              @dragleave="onFolderDragLeave($event, folder)"
              @drop="dropInto(folder, $event)"
            >
              <Star v-if="folder.kind === 'favorites'" :size="15" aria-hidden="true" class="wb-folder-star" />
              <FolderOpen v-else-if="folder.id === currentFolder?.id" :size="15" aria-hidden="true" />
              <Folder v-else :size="15" aria-hidden="true" />
              <span class="wb-folder-name">{{ folderLabel(folder) }}</span>
            </button>
            <p v-if="renamingId === folder.id && renameError" class="wb-folder-error" role="alert">{{ renameError }}</p>
          </li>
        </ul>
        <button type="button" class="wb-folder-add" :title="t('tableFolders.newFolder')" :aria-label="t('tableFolders.newFolder')" @click="createFolder">
          <Plus :size="16" aria-hidden="true" />
        </button>
      </nav>

      <section
        v-if="currentFolder"
        class="wb-folder-content"
        :class="{ 'is-drop-target': contentDropActive }"
        :aria-label="t('tableFolders.tablesOf', { name: folderLabel(currentFolder) })"
        @dragover="onContentDragOver"
        @dragleave="onContentDragLeave"
        @drop="dropInto(currentFolder, $event)"
      >
        <header class="wb-folder-header">
          <h2>{{ folderLabel(currentFolder) }}</h2>
          <div class="wb-folder-actions">
            <button type="button" @click="openPicker">
              <Plus :size="15" aria-hidden="true" />{{ t("tableFolders.addTables") }}
            </button>
            <button type="button" class="is-primary" :disabled="!currentFolder.tableNames.length" @click="openInWindow()">
              <AppWindow :size="15" aria-hidden="true" />{{ t("tableFolders.openWindow") }}
            </button>
          </div>
        </header>
        <ul v-if="folderRows.length" class="wb-folder-rows" role="listbox" aria-multiselectable="true">
          <li
            v-for="row in folderRows"
            :key="row.name"
            class="wb-folder-row"
            :class="{ 'is-selected': selectedSet.has(row.name), 'is-missing': row.missing }"
            role="option"
            :aria-selected="selectedSet.has(row.name) ? 'true' : 'false'"
            :data-table-name="row.name"
            :title="row.missing ? t('tableFolders.missingHint') : undefined"
            tabindex="0"
            draggable="true"
            @click="onRowClick(row, $event)"
            @dblclick="openRows([row.name])"
            @keydown="onRowKeydown($event, row)"
            @contextmenu.prevent.stop="onRowContextMenu($event, row)"
            @dragstart="onRowDragStart($event, row)"
          >
            <Table2 :size="15" aria-hidden="true" class="wb-folder-row-icon" />
            <span class="wb-folder-table">{{ row.name }}</span>
            <span v-if="row.missing" class="wb-folder-missing">{{ t("tableFolders.missing") }}</span>
            <span v-else class="wb-folder-comment">{{ row.comment }}</span>
          </li>
        </ul>
        <p v-else class="wb-folder-empty">{{ t("tableFolders.emptyFolder") }}</p>
      </section>
    </template>

    <section v-else class="wb-folder-picker" :aria-label="t('tableFolders.pickTitle', { name: folderLabel(currentFolder) })" @keydown="onPickKeydown">
      <header class="wb-folder-header">
        <button type="button" class="wb-folder-back" :title="t('tableFolders.back')" :aria-label="t('tableFolders.back')" @click="closePicker">
          <ArrowLeft :size="16" />
        </button>
        <h2>{{ t("tableFolders.pickTitle", { name: folderLabel(currentFolder) }) }}</h2>
        <label class="wb-folder-search">
          <Search :size="14" aria-hidden="true" />
          <input ref="pickSearchRef" v-model="pickQuery" type="search" :placeholder="t('tableFolders.search')" :aria-label="t('tableFolders.search')" />
        </label>
      </header>
      <ul class="wb-folder-rows" role="listbox" aria-multiselectable="true">
        <li
          v-for="row in pickRows"
          :key="row.name"
          class="wb-folder-row is-pickable"
          :class="{ 'is-checked': row.present || pickSet.has(row.name), 'is-present': row.present }"
          role="option"
          :aria-selected="row.present || pickSet.has(row.name) ? 'true' : 'false'"
          :aria-disabled="row.present ? 'true' : undefined"
          @click="togglePick(row, $event)"
        >
          <span class="wb-folder-check" aria-hidden="true"><Check v-if="row.present || pickSet.has(row.name)" :size="12" /></span>
          <span class="wb-folder-table">{{ row.name }}</span>
          <span class="wb-folder-comment">{{ row.comment }}</span>
        </li>
        <li v-if="tablesLoading && !pickRows.length" class="wb-folder-empty">{{ t("tableFolders.loadingTables") }}</li>
        <li v-else-if="!pickRows.length" class="wb-folder-empty">{{ t("m_4034e355eb62") }}</li>
      </ul>
      <footer class="wb-folder-picker-footer">
        <button type="button" @click="closePicker">{{ t("tableFolders.cancel") }}</button>
        <button type="button" class="is-primary" :disabled="!pickSelection.length" @click="submitPicks">
          {{ pickSelection.length ? t("tableFolders.submitCount", { count: pickSelection.length }) : t("tableFolders.submit") }}
        </button>
      </footer>
    </section>

    <Teleport to="body">
      <menu
        v-if="menu.open"
        ref="menuRef"
        class="wb-context-menu wb-folder-menu"
        :style="menuStyle"
        role="menu"
        tabindex="-1"
        :aria-label="t('m_1a94fed1be72')"
        @keydown="onMenuKeydown"
        @contextmenu.prevent.stop
      >
        <template v-if="menu.kind === 'folder' && menuFolder">
          <button type="button" role="menuitem" :disabled="!menuFolder.tableNames.length" @click="openInWindow(menuFolder)">
            <AppWindow :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("tableFolders.openWindow") }}
          </button>
          <button type="button" role="menuitem" :disabled="!menuFolder.tableNames.length" @click="openHere(menuFolder)">
            <Table2 :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("tableFolders.openHere") }}
          </button>
          <template v-if="menuFolder.kind !== 'favorites'">
            <hr class="wb-context-separator" role="separator" />
            <button type="button" role="menuitem" @click="startRename(menuFolder)">
              <Pencil :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("tableFolders.renameShort") }}<kbd class="wb-context-shortcut" aria-hidden="true">F2</kbd>
            </button>
            <button type="button" role="menuitem" class="is-danger" @click="deleteFolder(menuFolder)">
              <Trash2 :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("tableFolders.deleteShort") }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ deleteKeyLabel }}</kbd>
            </button>
          </template>
        </template>
        <template v-else-if="menu.kind === 'table'">
          <button type="button" role="menuitem" @click="openRows(menu.tableNames)">
            <Table2 :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("tableFolders.openTables") }}<kbd class="wb-context-shortcut" aria-hidden="true">Enter</kbd>
          </button>
          <button type="button" role="menuitem" @click="removeRows(menu.tableNames)">
            <X :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("tableFolders.removeFromFolder") }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ deleteKeyLabel }}</kbd>
          </button>
        </template>
      </menu>
    </Teleport>
  </section>
</template>
