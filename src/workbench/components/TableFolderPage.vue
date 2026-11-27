<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, unref, watch } from "vue";
import { AppWindow, Folder, FolderOpen, Pencil, Plus, Search, Star, Trash2, X } from "lucide-vue-next";
import { DefaultTableIcon as Table2 } from "./workbenchIcons.js";

import { useTableFolderContext } from "../composables/tableFolderContext.js";
import { databaseTextColorCss, useDatabaseDecorations } from "../composables/databaseDecorationStore.js";
import { databaseTableIconComponent } from "./databaseDecorationIcons.js";
import {
  FAVORITES_FOLDER_KIND,
  TABLE_FOLDER_NAME_MAX_LENGTH,
  useTableFolderStore,
} from "../composables/tableFolderStore.js";
import { formatShortcutForPlatform, isMacOSPlatform } from "../utils/desktopPlatform.js";
import { isContextMenuKey, isDeleteCommandKey, nextListSelection } from "../utils/listSelection.js";
import { focusMenuItem, handleMenuKeydown } from "../utils/menuKeyboard.js";
import { isFolderDropCandidate, readFolderDrop, writeFolderDrag, writeTableDrag } from "../utils/tableDragPayload.js";
import { filterTablesByKeywords, matchTableKeywords, parseSearchKeywords } from "../utils/tableKeywordSearch.js";
import { highlightSearchRanges } from "../utils/searchMatch.js";

const props = defineProps({
  tab: { type: Object, required: true },
});

const store = useTableFolderStore();
const context = useTableFolderContext();
const rootRef = ref(null);
const listRef = ref(null);
const menuRef = ref(null);
const renameInputRef = ref(null);
const addButtonRef = ref(null);
const FOLDER_ROW_HEIGHT = 30;
const FOLDER_OVERSCAN = 8;
const listScrollTop = ref(0);
const listViewportHeight = ref(560);
let listScrollRaf = 0;
let listResizeObserver = null;
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
const addingFolderId = ref("");
const pickSelection = ref([]);
const menu = ref({ open: false, x: 0, y: 0, kind: "", folderId: "", tableNames: [] });

const scope = computed(() => ({ connectionId: String(props.tab.connectionId || ""), database: String(props.tab.database || "") }));
const scopeKey = computed(() => JSON.stringify(scope.value));
const databaseGroups = computed(() => {
  const groups = (unref(context?.databaseGroups) || []).map((group) => ({ ...group, databases: [...group.databases] }));
  let current = groups.find((group) => group.connectionId === scope.value.connectionId);
  if (!current) {
    current = { connectionId: scope.value.connectionId, label: scope.value.connectionId, databases: [] };
    groups.unshift(current);
  }
  if (!current.databases.includes(scope.value.database)) current.databases.unshift(scope.value.database);
  return groups;
});
let tableLoadVersion = 0;

function switchDatabase(event) {
  context?.switchDatabase?.(props.tab, JSON.parse(event.target.value));
}

function loadDatabases() {
  void context?.loadDatabases?.();
}
const { getDatabaseDecoration } = useDatabaseDecorations();
const databaseDecoration = computed(() => getDatabaseDecoration(scope.value.connectionId, scope.value.database));
const tableIcon = computed(() => databaseTableIconComponent(databaseDecoration.value));
const databaseDecorationStyle = computed(() => ({
  "--wb-folder-icon-color": databaseDecoration.value?.color || undefined,
  "--wb-folder-table-color": databaseTextColorCss(databaseDecoration.value?.textColor) || undefined,
}));
const folders = computed(() => store.foldersFor(scope.value.connectionId, scope.value.database));
const currentFolder = computed(() => (
  folders.value.find((folder) => folder.id === props.tab.folderId) || null
));
const addingFolder = computed(() => folders.value.find((folder) => folder.id === addingFolderId.value) || null);
const pickSet = computed(() => new Set(pickSelection.value));
const tableByName = computed(() => new Map(tables.value.map((table) => [table.name, table])));
const folderRows = computed(() => (currentFolder.value?.tableNames || []).map((name) => ({
      name,
      comment: tableByName.value.get(name)?.comment || "",
      missing: tablesLoaded.value && !tableByName.value.has(name),
})));
const visibleRows = computed(() => currentFolder.value ? folderRows.value : pickRows.value);
const virtualWindow = computed(() => {
  const total = visibleRows.value.length;
  if (total <= 60) {
    return { start: 0, end: total, topHeight: 0, bottomHeight: 0 };
  }
  const height = Math.max(FOLDER_ROW_HEIGHT, listViewportHeight.value || 560);
  const start = Math.max(0, Math.floor(listScrollTop.value / FOLDER_ROW_HEIGHT) - FOLDER_OVERSCAN);
  const end = Math.min(total, Math.ceil((listScrollTop.value + height) / FOLDER_ROW_HEIGHT) + FOLDER_OVERSCAN);
  return {
    start,
    end,
    topHeight: start * FOLDER_ROW_HEIGHT,
    bottomHeight: Math.max(0, (total - end) * FOLDER_ROW_HEIGHT),
  };
});
const renderedRows = computed(() => visibleRows.value.slice(virtualWindow.value.start, virtualWindow.value.end));
const rowOrder = computed(() => visibleRows.value.map((row) => row.name));
const selectedSet = computed(() => new Set(selectedNames.value));
const pickRows = computed(() => {
  const present = new Set(addingFolder.value?.tableNames || []);
  const keywords = parseSearchKeywords(pickQuery.value);
  return filterTablesByKeywords(tables.value, pickQuery.value)
    .map((table) => {
      const match = matchTableKeywords(table, keywords);
      return {
        ...table,
        present: present.has(table.name),
        nameHtml: highlightSearchRanges(table.name, match.nameRanges),
        commentHtml: highlightSearchRanges(table.comment, match.commentRanges),
      };
    });
});
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
  const version = ++tableLoadVersion;
  const requestedScope = scopeKey.value;
  tablesLoading.value = true;
  try {
    const loaded = await context.loadTables({ ...scope.value });
    if (version !== tableLoadVersion || requestedScope !== scopeKey.value) return;
    tables.value = loaded;
    tablesLoaded.value = true;
  } catch (error) {
    if (version === tableLoadVersion && requestedScope === scopeKey.value) notify("error", String(error?.message || error));
  } finally {
    if (version === tableLoadVersion) tablesLoading.value = false;
  }
}

function selectFolder(folder) {
  props.tab.folderId = folder?.id || "";
  addingFolderId.value = "";
  pickSelection.value = [];
  pickQuery.value = "";
  selectedNames.value = [];
  selectionAnchor.value = "";
  closeMenu();
}

function startAdding() {
  const folder = currentFolder.value;
  if (!folder) return;
  selectFolder(null);
  addingFolderId.value = folder.id;
}

function togglePick(row) {
  if (currentFolder.value) return;
  pickSelection.value = pickSet.value.has(row.name)
    ? pickSelection.value.filter((name) => name !== row.name)
    : [...pickSelection.value, row.name];
}

function showAddTargets(event) {
  if (currentFolder.value || !pickSelection.value.length) return;
  const rect = event.currentTarget.getBoundingClientRect();
  openMenu({ kind: "addTarget", x: rect.right - 200, y: rect.bottom + 4 }, { keyboard: true });
}

function submitPicks(folderId) {
  const folder = folders.value.find((item) => item.id === folderId);
  if (currentFolder.value || !folder || !pickSelection.value.length) return;
  const names = tables.value.map((table) => table.name).filter((name) => pickSet.value.has(name));
  reportAdded(folder, store.addTables(folder.id, names, scope.value));
  selectFolder(folder);
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
  store.deleteFolder(folder.id);
  if (props.tab.folderId === folder.id || addingFolderId.value === folder.id) selectFolder(null);
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
  const rows = visibleRows.value.filter((row) => names.includes(row.name) && !row.missing);
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

function onListScroll() {
  if (listScrollRaf) return;
  const run = () => {
    listScrollRaf = 0;
    if (listRef.value) listScrollTop.value = listRef.value.scrollTop;
  };
  listScrollRaf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : (run(), 0);
}

function syncListViewportHeight() {
  const height = listRef.value?.clientHeight;
  if (height && height > 0) listViewportHeight.value = height;
}

function resetListScroll() {
  listScrollTop.value = 0;
  if (listRef.value) listRef.value.scrollTop = 0;
}

function ensureRowIndexVisible(index) {
  const el = listRef.value;
  if (!el || index < 0) return;
  const top = index * FOLDER_ROW_HEIGHT;
  const bottom = top + FOLDER_ROW_HEIGHT;
  if (top < el.scrollTop) {
    el.scrollTop = top;
    listScrollTop.value = top;
  } else if (bottom > el.scrollTop + el.clientHeight) {
    const next = Math.max(0, bottom - el.clientHeight);
    el.scrollTop = next;
    listScrollTop.value = next;
  }
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
    ensureRowIndexVisible(index);
    void nextTick(() => {
      rootRef.value?.querySelector?.(`.wb-folder-row[data-table-name="${CSS.escape(target)}"]`)?.focus();
    });
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

// ── Menu ─────────────────────────────────────────────────────────────────
function openMenu({ kind, folderId = "", tableNames = [], x, y }, { keyboard = false } = {}) {
  const width = 200;
  const height = kind === "addTarget" ? Math.min(folders.value.length * 32 + 40, 360) : kind === "folder" ? 168 : 84;
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
  if (!menu.value.open) return;
  const returnToAdd = menu.value.kind === "addTarget";
  menu.value = { ...menu.value, open: false };
  if (returnToAdd) void nextTick(() => addButtonRef.value?.focus());
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
  if (typeof ResizeObserver === "function") {
    listResizeObserver = new ResizeObserver(syncListViewportHeight);
    if (listRef.value) listResizeObserver.observe(listRef.value);
  }
  syncListViewportHeight();
});

watch(listRef, (el, prev) => {
  if (prev && listResizeObserver) listResizeObserver.unobserve(prev);
  if (el && listResizeObserver) listResizeObserver.observe(el);
  syncListViewportHeight();
});

watch([() => currentFolder.value?.id || "", pickQuery], () => {
  resetListScroll();
});

onBeforeUnmount(() => {
  tableLoadVersion += 1;
  if (listScrollRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(listScrollRaf);
  listScrollRaf = 0;
  listResizeObserver?.disconnect();
  listResizeObserver = null;
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  document.removeEventListener("keydown", onDocumentKeydown, true);
});

watch(() => `${scope.value.connectionId}\u001f${scope.value.database}`, () => {
  tables.value = [];
  tablesLoaded.value = false;
  selectedNames.value = [];
  selectionAnchor.value = "";
  pickQuery.value = "";
  addingFolderId.value = "";
  pickSelection.value = [];
  cancelRename();
  closeMenu();
  dropTargetId.value = "";
  contentDropActive.value = false;
  void loadTables();
});
</script>

<template>
  <section ref="rootRef" class="wb-folder-page" :style="databaseDecorationStyle" :aria-label="t('tableFolders.title')">
      <nav class="wb-folder-sidebar" :aria-label="t('tableFolders.folderList')">
        <select class="wb-folder-database" :value="scopeKey" :aria-label="t('m_9fa99195c7c0')" :title="scope.database" @focus="loadDatabases" @change="switchDatabase">
          <optgroup v-for="group in databaseGroups" :key="group.connectionId" :label="group.label">
            <option v-for="database in group.databases" :key="database" :value="JSON.stringify({ connectionId: group.connectionId, database })">
              {{ context?.databaseLabel?.(group.connectionId, database) || database }}
            </option>
          </optgroup>
        </select>
        <button type="button" class="wb-folder-item wb-folder-all" :class="{ 'is-selected': !currentFolder }" :aria-current="!currentFolder ? 'true' : undefined" @click="selectFolder(null)">
          <Table2 :size="15" aria-hidden="true" />
          <span class="wb-folder-name">{{ t("m_f974e44668ed") }}</span>
        </button>
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
        class="wb-folder-content"
        :class="{ 'is-drop-target': contentDropActive }"
        :aria-label="currentFolder ? t('tableFolders.tablesOf', { name: folderLabel(currentFolder) }) : t('m_f974e44668ed')"
        @dragover="onContentDragOver"
        @dragleave="onContentDragLeave"
        @drop="dropInto(currentFolder, $event)"
      >
        <header class="wb-folder-header">
          <h2>{{ currentFolder ? folderLabel(currentFolder) : t('m_f974e44668ed') }}</h2>
          <label v-if="!currentFolder" class="wb-folder-search">
            <Search :size="14" aria-hidden="true" />
            <input v-model="pickQuery" type="search" :placeholder="t('tableFolders.search')" :aria-label="t('tableFolders.search')" />
          </label>
          <div v-if="currentFolder" class="wb-folder-actions">
            <button type="button" @click="startAdding">
              <Plus :size="15" aria-hidden="true" />{{ t("tableFolders.addTables") }}
            </button>
            <button type="button" class="is-primary" :disabled="!currentFolder.tableNames.length" @click="openInWindow()">
              <AppWindow :size="15" aria-hidden="true" />{{ t("tableFolders.openWindow") }}
            </button>
          </div>
          <div v-else class="wb-folder-actions">
            <button v-if="addingFolder" type="button" @click="selectFolder(addingFolder)">{{ t("tableFolders.cancel") }}</button>
            <button ref="addButtonRef" type="button" class="is-primary" :disabled="!pickSelection.length" aria-haspopup="menu" :aria-expanded="menu.open && menu.kind === 'addTarget'" @click="showAddTargets">
              <Plus :size="15" aria-hidden="true" />{{ pickSelection.length ? t("tableFolders.addCount", { count: pickSelection.length }) : t("tableFolders.add") }}
            </button>
          </div>
        </header>
        <ul v-if="visibleRows.length" ref="listRef" class="wb-folder-rows" @scroll.passive="onListScroll">
          <li
            v-if="virtualWindow.topHeight > 0"
            class="wb-folder-spacer"
            role="presentation"
            aria-hidden="true"
            :style="{ height: `${virtualWindow.topHeight}px` }"
          ></li>
          <li
            v-for="row in renderedRows"
            :key="row.name"
            class="wb-folder-row"
            :class="{ 'is-selected': selectedSet.has(row.name), 'is-missing': row.missing }"
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
            <input
              v-if="!currentFolder"
              class="wb-folder-check"
              type="checkbox"
              :checked="pickSet.has(row.name)"
              :aria-label="`${t('tableFolders.addTables')}: ${row.name}`"
              @click.stop
              @dblclick.stop
              @keydown.stop
              @change="togglePick(row)"
            />
            <component :is="tableIcon" :size="15" aria-hidden="true" class="wb-folder-row-icon" />
            <span v-if="currentFolder" class="wb-folder-table">{{ row.name }}</span>
            <span v-else class="wb-folder-table" v-html="row.nameHtml"></span>
            <span v-if="row.missing" class="wb-folder-missing">{{ t("tableFolders.missing") }}</span>
            <span v-else-if="currentFolder" class="wb-folder-comment">{{ row.comment }}</span>
            <span v-else class="wb-folder-comment" v-html="row.commentHtml"></span>
          </li>
          <li
            v-if="virtualWindow.bottomHeight > 0"
            class="wb-folder-spacer"
            role="presentation"
            aria-hidden="true"
            :style="{ height: `${virtualWindow.bottomHeight}px` }"
          ></li>
        </ul>
        <p v-else-if="tablesLoading" class="wb-folder-empty" role="status">{{ t("tableFolders.loadingTables") }}</p>
        <p v-else class="wb-folder-empty">{{ currentFolder ? t("tableFolders.emptyFolder") : t("m_4034e355eb62") }}</p>
      </section>

    <Teleport to="body">
      <menu
        v-if="menu.open"
        ref="menuRef"
        class="wb-context-menu wb-folder-menu"
        :class="{ 'wb-folder-target-menu': menu.kind === 'addTarget' }"
        :style="menuStyle"
        role="menu"
        tabindex="-1"
        :aria-label="menu.kind === 'addTarget' ? t('tableFolders.chooseTarget') : t('m_1a94fed1be72')"
        @keydown="onMenuKeydown"
        @contextmenu.prevent.stop
      >
        <template v-if="menu.kind === 'addTarget'">
          <li class="wb-folder-target-heading" role="presentation">{{ t("tableFolders.chooseTarget") }}</li>
          <button v-for="folder in folders" :key="folder.id" type="button" role="menuitem" @click="submitPicks(folder.id)">
            <component :is="folder.kind === 'favorites' ? Star : Folder" :size="14" class="wb-context-icon" aria-hidden="true" />
            <span class="wb-folder-name">{{ folderLabel(folder) }}</span>
          </button>
        </template>
        <template v-else-if="menu.kind === 'folder' && menuFolder">
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
          <button v-if="currentFolder" type="button" role="menuitem" @click="removeRows(menu.tableNames)">
            <X :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("tableFolders.removeFromFolder") }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ deleteKeyLabel }}</kbd>
          </button>
        </template>
      </menu>
    </Teleport>
  </section>
</template>
