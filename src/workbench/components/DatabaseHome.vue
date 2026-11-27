<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  ClipboardPaste,
  Code2,
  Copy,
  Eraser,
  FolderOpen,
  History,
  Languages,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  TableProperties,
  Trash2,
} from "lucide-vue-next";
import {
  applyLocaleTableFolding,
  useLocaleTableFoldPreference,
} from "../utils/localeTableGrouping.js";

import {
  createDatabaseHomeController,
  databaseHomeRenameError,
  HOME_SORT_MODES,
} from "../composables/useDatabaseHome.js";
import { useAliases } from "../composables/aliasStore.js";
import { databaseTextColorCss, useDatabaseDecorations } from "../composables/databaseDecorationStore.js";
import { createHomepageTypeahead } from "../composables/useHomepageTypeahead.js";
import { useConfirm } from "../composables/useConfirm.js";
import { useShortcuts } from "../composables/useShortcuts.js";
import { useTableFolderStore } from "../composables/tableFolderStore.js";
import { createHomepageSelectionDismissal } from "../homepageSelectionDismissal.js";
import { highlightSearchRanges } from "../utils/searchMatch.js";
import { connectionHasCapability } from "../utils/connectionKinds.js";
import { formatShortcutForPlatform } from "../utils/desktopPlatform.js";
import { focusMenuItem, handleMenuKeydown } from "../utils/menuKeyboard.js";
import {
  confirmOpeningTables,
  createSelectionRecall,
  isContextMenuKey,
  isDeleteCommandKey,
  isPlainSelectionEvent,
  selectionOpenPlan,
} from "../utils/listSelection.js";
import DatabaseTableList from "./DatabaseTableList.vue";
import { databaseDecorationIconComponent } from "./databaseDecorationIcons.js";
import ToolbarActionIcon from "./ToolbarActionIcon.vue";
import ToolbarSplitButton from "./ToolbarSplitButton.vue";
import { useToolbarFit } from "../composables/useToolbarFit.js";

const props = defineProps({
  tab: { type: Object, required: true },
  tables: { type: Array, default: () => [] },
  recentTableNames: { type: Array, default: () => [] },
  clipboard: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  visible: { type: Boolean, default: true },
  isActiveView: { type: Function, default: null },
  canClosePane: { type: Boolean, default: false },
  engineKind: { type: String, default: "" },
});

const emit = defineEmits([
  "open-table",
  "open-design",
  "create-table",
  "copy-tables",
  "paste-tables",
  "rename-table",
  "edit-table-comment",
  "delete-tables",
  "truncate-tables",
  "show-ddl",
  "send-tables",
  "refresh",
  "batch-export",
  "batch-import",
  "visible-tables",
  "state-change",
  "focus-table",
  "split-pane",
  "close-pane",
  "open-sql-library",
  "view-change-history",
]);

const clipboardRef = computed({
  get: () => props.clipboard,
  set: (value) => emit("copy-tables", value),
});
const homeLoading = computed(() => props.tab.loading === true);
const tableSource = computed(() => homeLoading.value ? [] : props.tables);
const recentSource = computed(() => props.recentTableNames);
// The star toggles the database's favorites folder.
const tableFavoriteStore = useTableFolderStore();
const favoriteTableNames = computed(() =>
  tableFavoriteStore.favoriteNames(props.tab.connectionId, props.tab.database),
);
const { databaseLabel, getDatabaseAlias } = useAliases();
const { getDatabaseDecoration } = useDatabaseDecorations();
const engineKind = computed(() => props.engineKind || props.tab.engineKind || "mysql");
const homeReadOnly = Boolean(props.tab.readOnly || props.tab.read_only);

const controller = createDatabaseHomeController({
  connectionId: props.tab.connectionId,
  database: props.tab.database,
  tables: tableSource,
  recentTableNames: recentSource,
  favoriteTableNames,
  readOnly: homeReadOnly,
  allowRenameDrop: !homeReadOnly && connectionHasCapability(engineKind.value, "renameDrop"),
  allowTableCopy: !homeReadOnly && connectionHasCapability(engineKind.value, "tableCopy"),
  clipboard: clipboardRef,
  initialQuery: props.tab.query || "",
  initialSortMode: props.tab.sortMode || HOME_SORT_MODES.nameAsc,
});

const menu = reactive({
  open: false,
  x: 0,
  y: 0,
  tableName: "",
  selectedNames: [],
  blank: false,
});
controller.setSelection(Array.isArray(props.tab.selectedTableNames) ? props.tab.selectedTableNames : []);
controller.focusedName.value = props.tab.focusedTableName || props.tab.selectedTableNames?.at?.(-1) || "";

const { foldLocaleTables, toggleFoldLocaleTables } = useLocaleTableFoldPreference();
const expandedLocaleBases = ref(new Set());
const localeFoldResult = computed(() => applyLocaleTableFolding(controller.filteredTables.value, {
  allTables: controller.tables.value,
  fold: foldLocaleTables.value,
  expandedBases: expandedLocaleBases.value,
  query: controller.query.value,
}));
const displayedTables = computed(() => localeFoldResult.value.rows);

function toggleLocaleGroup(baseLower) {
  if (!baseLower) return;
  const next = new Set(expandedLocaleBases.value);
  if (next.has(baseLower)) next.delete(baseLower);
  else next.add(baseLower);
  expandedLocaleBases.value = next;
}

function viewTableChangeHistory(tableName) {
  const name = String(tableName || "").trim();
  if (!name) return;
  const matched = controller.tables.value.find((item) => (item?.tableName || item?.table_name) === name) || null;
  emit("view-change-history", {
    ...tableSourceContext.value,
    tableName: name,
    tableComment: matched?.tableComment || matched?.table_comment || "",
    tableMeta: matched,
  });
}

watch(
  () => `${props.tab.connectionId}\u001f${props.tab.database}`,
  () => { expandedLocaleBases.value = new Set(); },
);

const databaseRealName = computed(() => props.tab.database || t('m_5403ed977fb5'));
const databaseName = computed(() => (
  databaseLabel(props.tab.connectionId, props.tab.database) || databaseRealName.value
));
const databaseTitle = computed(() => {
  const alias = getDatabaseAlias(props.tab.connectionId, props.tab.database);
  return alias ? `${alias}（${databaseRealName.value}）` : databaseRealName.value;
});
const databaseDecoration = computed(() => (
  getDatabaseDecoration(props.tab.connectionId, props.tab.database)
));
const databaseHomeIcon = computed(() => databaseDecorationIconComponent(databaseDecoration.value?.icon));
const databaseHomeDecorationStyle = computed(() => {
  const decoration = databaseDecoration.value;
  const textColor = databaseTextColorCss(decoration?.textColor);
  return {
    ...(decoration?.color ? { "--wb-dbhome-icon-color": decoration.color } : {}),
    ...(textColor ? { "--wb-dbhome-name-color": textColor } : {}),
  };
});
const selectedCount = computed(() => controller.selectedNames.value.length);
const { confirm } = useConfirm();
const shortcuts = useShortcuts();
// A double-click on a row inside a multi-selection opens the whole selection.
const selectionRecall = createSelectionRecall();
// The context menu acts on the selection when the clicked row belongs to it.
const menuTargetCount = computed(() => (
  menu.tableName && menu.selectedNames.includes(menu.tableName) ? menu.selectedNames.length : 1
));
const openMenuLabel = computed(() => menuTargetCount.value > 1 ? t("home.openTables", { count: menuTargetCount.value }) : t('m_bf8ef131aa2d'));
const deleteMenuLabel = computed(() => menu.selectedNames.length > 1 ? t("home.deleteTables", { count: menu.selectedNames.length }) : t('m_d545721cef25'));
const menuShortcuts = computed(() => ({
  open: "Enter",
  design: formatShortcutForPlatform(shortcuts.get("openDesign")),
  rename: "F2",
  editTableComment: formatShortcutForPlatform(shortcuts.get("editTableComment")),
  copy: formatShortcutForPlatform("Ctrl+C"),
  paste: formatShortcutForPlatform("Ctrl+V"),
  refresh: formatShortcutForPlatform(shortcuts.get("refresh")),
  delete: "Delete",
}));
const tableCount = computed(() => controller.tables.value.length);
const visibleCount = computed(() => controller.filteredTables.value.length);
const readOnly = computed(() => Boolean(props.tab.readOnly || props.tab.read_only));
const canTableDesign = computed(() => !readOnly.value && connectionHasCapability(engineKind.value, "tableDesign"));
const canTableCopy = computed(() => !readOnly.value && connectionHasCapability(engineKind.value, "tableCopy"));
const canImport = computed(() => !readOnly.value && connectionHasCapability(engineKind.value, "import"));
const canRenameDrop = computed(() => !readOnly.value && connectionHasCapability(engineKind.value, "renameDrop"));
const canShowDdl = computed(() => engineKind.value !== "mongodb");
const canSqlConsole = computed(() => connectionHasCapability(engineKind.value, "sqlConsole"));
const tableSourceContext = computed(() => ({
  connectionId: props.tab.connectionId,
  database: props.tab.database,
}));
const homeRootRef = ref(null);
const searchInputRef = ref(null);
const homeToolbarRef = ref(null);
// Fit levels: 0 full, 1 action icons only, 2 close-pane icon too, 3 one overflow menu.
useToolbarFit(homeToolbarRef, {
  maxLevel: 3,
  contentSignature: () => [props.canClosePane, t("m_d2fcdde81f06"), t("m_1e9b6e9d9fbe")].join("\u001f"),
});
const searchNavigationName = ref("");
const tableListRef = ref(null);
const contextMenuRef = ref(null);
const splitMenuOpen = ref(false);
const compactActionMenuOpen = ref(false);
const splitItems = computed(() => [
  { id: "right", label: t('m_62ed1b06404f'), hint: t('m_c497337502dc'), icon: "split-right" },
  { id: "down", label: t('m_3d63360a3d6e'), hint: t('m_18a9b1b583a8'), icon: "split-down" },
]);
const compactActionItems = computed(() => ([
  {
    id: "batch-export",
    label: t('m_d2fcdde81f06'),
    hint: t('m_182001ece5e4'),
    icon: "export",
    disabled: props.busy,
  },
  {
    id: "batch-import",
    label: t('m_fd7719273970'),
    hint: t('m_58cd39db1ad8'),
    icon: "import",
    disabled: props.busy || !canImport.value,
  },
  ...splitItems.value.map((item, index) => ({
    ...item,
    separatorBefore: index === 0,
  })),
]));
const typeahead = createHomepageTypeahead({
  tables: computed(() => controller.filteredTables.value),
  onMatch: (table) => {
    const name = table?.tableName || "";
    if (!name) return;
    controller.selectTable(name, {});
    nextTick(() => tableListRef.value?.scrollTableIntoView?.(name));
  },
  onOpen: (table) => openTable(table?.tableName || ""),
});
const typeaheadResultLabel = computed(() => {
  const query = typeahead.query.value.trim().toLocaleLowerCase();
  const name = typeahead.matchedTableName.value;
  if (!name) return t('m_e5dcd10208d5');
  return name.toLocaleLowerCase() === query ? "" : name;
});
const typeaheadResultHtml = computed(() =>
  highlightSearchRanges(typeaheadResultLabel.value, typeahead.matchRanges.value),
);
const isHomeInteractive = computed(() => props.active && props.visible);
const selectionDismissal = createHomepageSelectionDismissal({
  getRoot: () => homeRootRef.value,
  getProtectedRoots: () => [contextMenuRef.value],
  isEnabled: () => props.visible && (typeof props.isActiveView !== "function" || props.isActiveView()),
  clearSelection,
});

function syncTabState() {
  if (!props.tab) return;
  props.tab.query = controller.query.value;
  props.tab.sortMode = controller.sortMode.value;
  props.tab.selectedTableNames = [...controller.selectedNames.value];
  props.tab.focusedTableName = controller.focusedName.value || "";
  if (!props.visible) return;
  emit("state-change", {
    tabId: props.tab.id,
    query: props.tab.query,
    sortMode: props.tab.sortMode,
    selectedTableNames: props.tab.selectedTableNames,
    focusedTableName: props.tab.focusedTableName,
  });
}

function handleTableListScrollChange({ scrollTop = 0, scrollLeft = 0 } = {}) {
  if (!props.tab) return;
  props.tab.scrollTop = Math.max(0, Number(scrollTop) || 0);
  props.tab.scrollLeft = Math.max(0, Number(scrollLeft) || 0);
}

function setQuery(value) {
  controller.setQuery(value);
  searchNavigationName.value = "";
}

function clearSearchQuery() {
  controller.setQuery("");
  searchNavigationName.value = "";
  nextTick(() => searchInputRef.value?.focus());
}

function focusSearch() {
  const input = searchInputRef.value;
  if (!input) return false;
  input.focus();
  input.select?.();
  return true;
}

function sortByColumn(column) {
  controller.sortByColumn(column);
}

function replaceSelection(names) {
  controller.setSelection(names);
}

function toggleTableFavorite(name) {
  const favorite = tableFavoriteStore.toggleFavorite(props.tab.connectionId, props.tab.database, name);
  if (!favorite) return;
  nextTick(() => tableListRef.value?.scrollTableIntoView?.(name, { block: "nearest" }));
}

watch(
  () => [controller.query.value, controller.sortMode.value, controller.selectedNames.value.join("\u001f"), controller.focusedName.value, props.tab.id, props.tab.error],
  syncTabState,
  { immediate: true },
);

watch(
  () => props.tab.id,
  () => {
    controller.setQuery(props.tab.query || "");
    controller.setSortMode(props.tab.sortMode || HOME_SORT_MODES.nameAsc);
    controller.selectedNames.value = Array.isArray(props.tab.selectedTableNames) ? [...props.tab.selectedTableNames] : [];
    controller.focusedName.value = props.tab.focusedTableName || controller.selectedNames.value.at(-1) || "";
    searchNavigationName.value = "";
    controller.cancelRename();
  },
);

watch(
  () => (Array.isArray(props.tab.selectedTableNames) ? props.tab.selectedTableNames.join("\u001f") : ""),
  (incoming) => {
    if (incoming === controller.selectedNames.value.join("\u001f")) return;
    controller.setSelection(Array.isArray(props.tab.selectedTableNames) ? props.tab.selectedTableNames : []);
  },
);

function closeMenu() {
  // A menu driven from the keyboard hands focus back to the list before its
  // items disappear, so the next key (or a dialog's focus return) still lands.
  if (contextMenuRef.value?.contains?.(document.activeElement)) homeRootRef.value?.focus?.({ preventScroll: true });
  menu.open = false;
  menu.tableName = "";
  menu.blank = false;
}

function tableByName(name) {
  return controller.tables.value.find((table) => table.tableName === name) || null;
}

function tablePayload(name) {
  const table = tableByName(name);
  return {
    ...(table || {}),
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    tableName: name,
    tableComment: table?.tableComment || table?.table_comment || "",
    readOnly: readOnly.value,
  };
}

function selectTable(name, event = {}) {
  if (!name) return;
  const plain = isPlainSelectionEvent(event);
  // The second click of a double-click must leave the selection alone: the
  // double-click that follows opens it.
  if (plain && Number(event?.detail) > 1) return;
  if (plain) selectionRecall.remember(name, controller.selectedNames.value);
  else selectionRecall.clear();
  controller.selectTable(name, event);
  emit("focus-table", tablePayload(name));
}

function clearSelection() {
  controller.clearSelection();
}

function isHomeTableNavigationTarget(target) {
  const root = homeRootRef.value;
  if (!root || !target) return false;
  if (target === searchInputRef.value) return true;
  if (target === root) return true;
  if (target.closest?.('.wb-tab[data-kind="home"].active')) return true;
  const surface = target.closest?.(".wb-dbhome-table-surface");
  return Boolean(surface && root.contains(surface) && !target.closest?.(".wb-dbhome-table-header"));
}

// The page itself, the list surface and a table-name button take list
// commands (Enter, Delete, F2, Esc, Shift+F10). Other controls inside rows,
// such as the favorite star, keep their own keys.
function isHomeListCommandTarget(target) {
  const root = homeRootRef.value;
  if (!root || !target) return false;
  if (target === root) return true;
  if (target === searchInputRef.value || !isHomeTableNavigationTarget(target)) return false;
  const control = target.closest?.("button, input, textarea, select, a");
  return !control || control.classList?.contains("wb-dbhome-object-name-button");
}

const HOME_NAVIGATION_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);

function homeNavigationDelta(key) {
  const page = Math.max(1, tableListRef.value?.pageRowCount?.() || 10);
  if (key === "ArrowDown") return 1;
  if (key === "ArrowUp") return -1;
  if (key === "PageDown") return page;
  if (key === "PageUp") return -page;
  return key === "End" ? Infinity : -Infinity;
}

function handleHomeArrowKeydown(event) {
  const key = String(event.key || "");
  if (!isHomeTableNavigationTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (!HOME_NAVIGATION_KEYS.has(key)) return false;
  const fromSearch = event.target === searchInputRef.value;
  // Home, End and the page keys keep moving the caret inside the search box.
  if (fromSearch && key !== "ArrowUp" && key !== "ArrowDown") return false;

  event.preventDefault();
  typeahead.dismiss();
  const delta = homeNavigationDelta(key);
  const name = fromSearch
    ? moveSearchSelection(delta, event)
    : controller.moveSelection(delta, event);
  if (!name) return true;
  selectionRecall.clear();
  emit("focus-table", tablePayload(name));
  nextTick(() => tableListRef.value?.scrollTableIntoView?.(name, { block: "nearest" }));
  return true;
}

function moveSearchSelection(delta, event = {}) {
  const tables = controller.filteredTables.value;
  if (!tables.length) return "";
  const currentIndex = tables.findIndex((table) => table.tableName === searchNavigationName.value);
  const nextIndex = currentIndex < 0
    ? (delta > 0 ? 0 : tables.length - 1)
    : Math.max(0, Math.min(tables.length - 1, currentIndex + delta));
  const name = tables[nextIndex]?.tableName || "";
  if (!name) return "";
  controller.selectTable(name, { shiftKey: Boolean(event.shiftKey) });
  searchNavigationName.value = name;
  return name;
}

function openSearchResult() {
  const tables = controller.filteredTables.value;
  if (!tables.length) return false;
  const navigatedTable = tables.find((table) => table.tableName === searchNavigationName.value);
  const name = navigatedTable?.tableName || tables[0]?.tableName || "";
  if (!name) return false;
  controller.selectTable(name, {});
  searchNavigationName.value = name;
  emit("focus-table", tablePayload(name));
  openTable(name);
  return true;
}

function handleSearchKeydown(event) {
  if (handleHomeArrowKeydown(event)) {
    event.stopPropagation?.();
    return;
  }
  if (String(event.key || "") !== "Enter" || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  event.stopPropagation?.();
  typeahead.dismiss();
  openSearchResult();
}

function handleHomeEnterKeydown(event) {
  const target = event.target;
  const isHomeEntryTarget = isHomeListCommandTarget(target) || target?.closest?.('.wb-tab[data-kind="home"].active');
  if (!isHomeEntryTarget || String(event.key || "") !== "Enter") return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !controller.selectedNames.value.length) return false;

  event.preventDefault();
  void openSelection(controller.focusedName.value);
  return true;
}

// Delete, F2, Esc and Shift+F10 act on the selection wherever the keyboard
// focus sits in the list: the page after a click or drag selection, the list
// surface, or a table-name button (which handles its own row first).
function handleHomeListKeydown(event) {
  if (!isHomeListCommandTarget(event.target)) return false;
  if (handleEditTableCommentKeydown(event)) return true;
  const key = String(event.key || "");
  const command = event.ctrlKey || event.metaKey;
  if (isDeleteCommandKey(event)) {
    if (!controller.selectedNames.value.length) return false;
    event.preventDefault();
    deleteSelection();
    return true;
  }
  if (key === "F2" && !command && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    renameFromKeyboard();
    return true;
  }
  if (isContextMenuKey(event)) {
    event.preventDefault();
    openKeyboardContextMenu();
    return true;
  }
  if (key === "Escape" && !command && !event.altKey) {
    if (controller.renamingName.value) cancelRename();
    else if (controller.selectedNames.value.length) clearSelection();
    else return false;
    event.preventDefault();
    return true;
  }
  return false;
}

function handleHomeKeydown(event) {
  if (String(event.key || "") === "Escape" && menu.open) {
    event.preventDefault();
    closeMenu();
    return;
  }
  if (isEditableTypeaheadTarget(event.target)) return;
  const key = String(event.key || "");
  if ((event.ctrlKey || event.metaKey) && !event.altKey && key.toLowerCase() === "a") {
    event.preventDefault();
    controller.selectAllFiltered();
    selectionRecall.clear();
    const focusedName = controller.focusedName.value || controller.selectedNames.value.at(-1) || "";
    if (focusedName) emit("focus-table", tablePayload(focusedName));
    return;
  }
  if (handleHomeArrowKeydown(event)) return;
  if (handleHomeEnterKeydown(event)) return;
  handleHomeListKeydown(event);
}

function splitHome(direction) {
  splitMenuOpen.value = false;
  compactActionMenuOpen.value = false;
  emit("split-pane", direction);
}

function toggleSplitMenu() {
  compactActionMenuOpen.value = false;
  splitMenuOpen.value = !splitMenuOpen.value;
}

function toggleCompactActionMenu() {
  splitMenuOpen.value = false;
  compactActionMenuOpen.value = !compactActionMenuOpen.value;
}

function handleCompactAction(actionId) {
  compactActionMenuOpen.value = false;
  if (actionId === "batch-export") openBatchExport();
  else if (actionId === "batch-import") openBatchImport();
  else if (actionId === "right" || actionId === "down") splitHome(actionId);
}

function openTable(name, { activate = true } = {}) {
  if (!name) return;
  emit("open-table", activate ? tablePayload(name) : { ...tablePayload(name), activate: false });
}

// Opens tables in list order; only the table the user acted on becomes the
// active tab. A large selection asks first.
async function openTables({ names = [], activeName = "" } = {}) {
  if (!names.length || !(await confirmOpeningTables(names.length, { confirm, t }))) return false;
  names.forEach((name) => openTable(name, { activate: name === activeName }));
  return true;
}

function openSelection(focusedName = "") {
  const order = controller.filteredTables.value.map((table) => table.tableName);
  return openTables(selectionOpenPlan(focusedName, controller.selectedNames.value, order));
}

// Double-clicking any part of a row opens it; inside a multi-selection it
// opens every selected table (the first click had collapsed the selection,
// so restore it first).
function activateRow(name) {
  if (!name || controller.renamingName.value === name) return;
  const restored = selectionRecall.recall(name);
  if (restored) controller.setSelection(restored);
  controller.focusedName.value = name;
  void openSelection(name);
}

function openDesign(name = controller.selectedNames.value[0]) {
  if (!canTableDesign.value || !name) return;
  const selected = controller.selectedNames.value;
  // When the right-clicked table is part of a multi-selection, open the
  // design for every selected table instead of just the clicked one.
  if (selected.length > 1 && selected.includes(name)) {
    emit("open-design", selected.map((tableName) => tablePayload(tableName)));
    return;
  }
  emit("open-design", tablePayload(name));
}

function copySelection() {
  const payload = controller.copySelection();
  closeMenu();
  return Boolean(payload);
}

function completeTablePaste(createdNames = []) {
  const pastedNames = Array.isArray(createdNames) ? createdNames.filter(Boolean) : [];
  typeahead.dismiss();
  controller.resetForMutationRefresh();
  controller.setSelection(pastedNames);
  searchNavigationName.value = controller.filteredTables.value.some((table) => table.tableName === pastedNames[0])
    ? pastedNames[0]
    : "";
  tableListRef.value?.resetView?.();
  props.tab.error = "";
  props.tab.statusText = "";
  syncTabState();
  if (pastedNames[0]) {
    nextTick(() => tableListRef.value?.scrollTableIntoView?.(pastedNames[0]));
  }
}

function pasteTables() {
  if (!controller.canPaste.value) return false;
  emit("paste-tables", {
    target: {
      connectionId: props.tab.connectionId,
      database: props.tab.database,
    },
    payload: controller.clipboard.value,
    onSuccess: completeTablePaste,
  });
  closeMenu();
  return true;
}

function startRename(name = "") {
  if (!name && selectedCount.value !== 1) return;
  if (name && (!controller.selectedSet.value.has(name) || selectedCount.value > 1)) controller.selectTable(name, {});
  controller.startRename(name);
  closeMenu();
}

// F2 renames the single selected table, or the focused one of a selection.
function renameFromKeyboard() {
  const focused = controller.focusedName.value;
  if (selectedCount.value > 1 && focused && controller.selectedSet.value.has(focused)) startRename(focused);
  else startRename();
}

function cancelRename() {
  controller.cancelRename();
}

function updateRenameDraft(value) {
  controller.updateRenameDraft(value);
}

function submitRename(oldName, nextName) {
  const result = controller.validateRenameDraft(oldName, nextName);
  if (!result.ok) {
    if (result.reason === "unchanged") {
      cancelRename();
      return;
    }
    const message = databaseHomeRenameError(result.reason, nextName);
    controller.failRename(message);
    return;
  }
  const renameAttempt = controller.beginRenameSubmit();
  emit("rename-table", {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    tableName: oldName,
    newName: result.value,
    onSuccess: () => {
      controller.completeRename(renameAttempt);
    },
    onError: (error) => {
      const message = databaseHomeRenameError("request", result.value, error);
      controller.failRename(message, renameAttempt);
    },
  });
}

function refreshHome() {
  closeMenu();
  typeahead.dismiss();
  controller.resetForRefresh();
  tableListRef.value?.resetView?.();
  props.tab.error = "";
  props.tab.statusText = "";
  syncTabState();
  emit("refresh", props.tab);
}

function editTableComment(name = menu.tableName) {
  if (!canTableDesign.value || !name) return;
  emit("edit-table-comment", tablePayload(name));
  closeMenu();
}

function handleEditTableCommentKeydown(event) {
  if (!shortcuts.matchesBinding("editTableComment", event)) return false;
  if (!canTableDesign.value || isEditableTypeaheadTarget(event.target)) return false;
  const focused = controller.focusedName.value;
  const name = menu.open
    ? menu.tableName
    : controller.selectedSet.value.has(focused) ? focused : controller.selectedNames.value[0];
  if (!name) return false;
  event.preventDefault();
  event.stopPropagation();
  editTableComment(name);
  return true;
}

function sendSelection() {
  if (!canTableCopy.value || !menu.selectedNames.length) return;
  emit("send-tables", {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    tableNames: [...menu.selectedNames],
  });
  closeMenu();
}

// Read-only and unsupported connections still emit, so the workbench can say
// why nothing was deleted instead of ignoring the key press.
function deleteSelection(name = "", selectedNames = null) {
  if (!Array.isArray(selectedNames) && name && !controller.selectedSet.value.has(name)) controller.selectTable(name, {});
  const tableNames = Array.isArray(selectedNames)
    ? [...selectedNames]
    : [...controller.selectedNames.value];
  if (!tableNames.length) return;
  emit("delete-tables", {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    tableNames,
  });
  closeMenu();
}

function showDdl(name = "") {
  const tableName = String(name || "").trim();
  if (!tableName) return;
  emit("show-ddl", {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    tableName,
  });
  closeMenu();
}

function truncateSelection(name = "", selectedNames = null) {
  if (!Array.isArray(selectedNames) && name && !controller.selectedSet.value.has(name)) controller.selectTable(name, {});
  const tableNames = Array.isArray(selectedNames)
    ? [...selectedNames]
    : [...controller.selectedNames.value];
  if (!tableNames.length) return;
  emit("truncate-tables", {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    tableNames,
  });
  closeMenu();
}

function batchSource() {
  const selectedTableNames = [...controller.selectedNames.value];
  return {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    ...(selectedTableNames.length ? { selectedTableNames } : {}),
  };
}

function openBatchExport() {
  emit("batch-export", batchSource());
}

function openBatchImport() {
  if (!canImport.value) return;
  emit("batch-import", batchSource());
}

function openContextMenu(event, tableName) {
  if (tableName && !controller.selectedSet.value.has(tableName)) controller.selectTable(tableName, {});
  menu.open = true;
  menu.x = event.clientX;
  menu.y = event.clientY;
  menu.tableName = tableName || "";
  menu.selectedNames = [...controller.selectedNames.value];
  menu.blank = !tableName;
}

// Shift+F10 / Menu key: open the menu under the focused row (or the list when
// nothing is selected) and move focus into it.
function openKeyboardContextMenu() {
  const focused = controller.focusedName.value;
  const name = focused && controller.selectedSet.value.has(focused)
    ? focused
    : controller.selectedNames.value.at(-1) || "";
  if (name) tableListRef.value?.scrollTableIntoView?.(name, { block: "nearest" });
  nextTick(() => {
    const anchor = name
      ? tableListRef.value?.rowElement?.(name)
      : homeRootRef.value?.querySelector?.(".wb-dbhome-table-surface");
    const rect = anchor?.getBoundingClientRect?.();
    openContextMenu({ clientX: (rect?.left || 0) + 24, clientY: name ? rect?.bottom || 0 : (rect?.top || 0) + 8 }, name);
    nextTick(() => focusMenuItem(contextMenuRef.value, "first"));
  });
}

function handleContextMenuKeydown(event) {
  if (handleEditTableCommentKeydown(event)) return;
  handleMenuKeydown(event, contextMenuRef.value, { close: closeMenu });
}

function onWindowPointerDown(event) {
  if (!event.target?.closest?.(".wb-dbhome-context-menu")) closeMenu();
}

function isEditableTypeaheadTarget(target) {
  return Boolean(target?.isContentEditable || target?.closest?.("input, textarea, select"));
}

function handleHomeSurfaceClick(event) {
  const target = event.target;
  if (!target || target.closest?.(".wb-dbhome-search, button, a, [role='menuitem']")) return;
  if (isEditableTypeaheadTarget(target)) return;
  homeRootRef.value?.focus?.({ preventScroll: true });
}

function handleDocumentPointerDown(event) {
  if (!props.visible) return;
  const input = searchInputRef.value;
  if (!input || document.activeElement !== input) return;
  if (event.target?.closest?.(".wb-dbhome-search")) return;
  const end = input.value.length;
  input.setSelectionRange?.(end, end);
  input.blur();
}

function isTypeaheadEventInCurrentPane(event) {
  const root = homeRootRef.value;
  const target = event.target;
  if (!root || !target) return false;
  if (root.contains(target)) return true;
  const pane = root.closest(".wb-workbench-pane");
  return Boolean(pane?.contains(target));
}

function handleTypeaheadKeydown(event) {
  if (!isHomeInteractive.value || isEditableTypeaheadTarget(event.target)) return;
  if (!isTypeaheadEventInCurrentPane(event)) return;
  if (handleHomeArrowKeydown(event)) {
    event.stopPropagation?.();
    return;
  }
  if (typeahead.handleKeydown(event)) {
    event.stopPropagation?.();
    return;
  }
  if (handleHomeEnterKeydown(event)) event.stopPropagation?.();
}

watch(
  () => menu.open,
  (open) => {
    if (open) window.addEventListener("pointerdown", onWindowPointerDown, { capture: true });
    else window.removeEventListener("pointerdown", onWindowPointerDown, { capture: true });
  },
);

watch(
  () => isHomeInteractive.value,
  (interactive) => {
    if (!interactive) {
      typeahead.dismiss();
      splitMenuOpen.value = false;
      compactActionMenuOpen.value = false;
    }
  },
);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) {
      closeMenu();
      return;
    }
    const activeElement = globalThis.document?.activeElement;
    if (
      props.active
      && (!activeElement || activeElement === document.body || activeElement === document.documentElement)
    ) {
      homeRootRef.value?.focus?.({ preventScroll: true });
    }
  },
  { flush: "post" },
);

onMounted(() => {
  document.addEventListener("click", selectionDismissal.handleDocumentClick, { capture: true });
  document.addEventListener("pointerdown", handleDocumentPointerDown, { capture: true });
  document.addEventListener("keydown", handleTypeaheadKeydown, { capture: true });
});

onBeforeUnmount(() => {
  typeahead.dismiss();
  window.removeEventListener("pointerdown", onWindowPointerDown, { capture: true });
  document.removeEventListener("click", selectionDismissal.handleDocumentClick, { capture: true });
  document.removeEventListener("pointerdown", handleDocumentPointerDown, { capture: true });
  document.removeEventListener("keydown", handleTypeaheadKeydown, { capture: true });
});

function refresh() {
  refreshHome();
  return true;
}

defineExpose({ copySelection, pasteTables, focusSearch, refresh });
</script>

<template>
  <section
    ref="homeRootRef"
    class="wb-database-home"
    :class="{ 'is-readonly': readOnly }"
    :style="databaseHomeDecorationStyle"
    tabindex="-1"
    @click.capture="handleHomeSurfaceClick"
    @keydown="handleHomeKeydown"
  >
    <header class="wb-dbhome-header">
      <div class="wb-dbhome-title">
        <component :is="databaseHomeIcon" :size="18" class="wb-dbhome-title-icon" aria-hidden="true" />
        <div>
          <h2 :title="databaseTitle">{{ databaseName }}</h2>
          <p v-if="homeLoading">{{ t('m_133b5069fbfb') }}</p>
          <p v-else-if="controller.query.value.trim()">{{ visibleCount }} / {{ tableCount }} {{ t('m_a2b22d3a5ca3') }}</p>
          <p v-else-if="localeFoldResult.hiddenVariantCount > 0">
            {{ t('dbHome.totalTablesFolded', { count: tableCount, folded: localeFoldResult.hiddenVariantCount }) }}
          </p>
          <p v-else>{{ t('dbHome.totalTables', { count: tableCount }) }}</p>
        </div>
      </div>
      <div v-if="readOnly" class="wb-dbhome-summary" :aria-label="t('m_fa9dcb37fdf5')">
        <span>{{ t('m_3b5ec3533b0e') }}</span>
      </div>
    </header>

    <div ref="homeToolbarRef" class="wb-dbhome-toolbar" :aria-label="t('m_b0c35c00cb3d')">
      <div class="wb-dbhome-search">
        <span aria-hidden="true"></span>
        <input
          ref="searchInputRef"
          :value="controller.query.value"
          type="search"
          :aria-label="t('m_a6c843332a9d')"
          :placeholder="t('m_a6c843332a9d')"
          @input="setQuery($event.target.value)"
          @keydown="handleSearchKeydown"
        />
        <button
          v-if="controller.query.value"
          type="button"
          class="wb-dbhome-search-clear"
          :aria-label="t('m_ee32f25f7050')"
          @mousedown.prevent
          @click.stop="clearSearchQuery"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3L3 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <button
        v-if="localeFoldResult.totalVariantCount > 0"
        type="button"
        class="wb-dbhome-locale-fold-toggle"
        :class="{ 'is-active': foldLocaleTables }"
        :aria-pressed="foldLocaleTables ? 'true' : 'false'"
        :title="t('localeFold.toggleHint', { count: localeFoldResult.totalVariantCount })"
        @click="toggleFoldLocaleTables"
      >
        <Languages :size="14" :stroke-width="1.9" aria-hidden="true" />
        <span>{{ foldLocaleTables ? t('localeFold.foldedShort') : t('localeFold.foldShort') }}</span>
      </button>
      <div class="wb-dbhome-actions" :aria-label="t('m_e3244d705db7')">
        <div class="wb-toolbar-action-group wb-dbhome-action-group" :aria-label="t('m_813a2915d825')">
          <button
            type="button"
            class="wb-toolbar-action-button wb-dbhome-action-button wb-dbhome-sql-entry"
            aria-label="SQL"
            :disabled="!canSqlConsole"
            @click="emit('open-sql-library')"
          >
            <ToolbarActionIcon name="sql" />
            <span class="wb-toolbar-action-label">SQL</span>
          </button>
          <button
            type="button"
            class="wb-toolbar-action-button wb-dbhome-action-button"
            :aria-label="t('m_d2fcdde81f06')"
            :disabled="busy"
            @click="openBatchExport"
          >
            <ToolbarActionIcon name="export" />
            <span class="wb-toolbar-action-label">{{ t('m_d2fcdde81f06') }}</span>
          </button>
          <button
            type="button"
            class="wb-toolbar-action-button wb-dbhome-action-button"
            :aria-label="t('m_fd7719273970')"
            :disabled="busy || !canImport"
            @click="openBatchImport"
          >
            <ToolbarActionIcon name="import" />
            <span class="wb-toolbar-action-label">{{ t('m_fd7719273970') }}</span>
          </button>
          <ToolbarSplitButton
            :label="t('m_666ec3442af3')"
            icon="split-right"
            :menu-label="t('m_588827d8d5bb')"
            :open="splitMenuOpen"
            :items="splitItems"
            @primary="splitHome('right')"
            @toggle="toggleSplitMenu"
            @close="splitMenuOpen = false"
            @select="splitHome"
          />
        </div>
        <ToolbarSplitButton
          class="wb-toolbar-compact-overflow wb-dbhome-overflow"
          :label="t('m_38844b135cf7')"
          icon="more"
          :menu-label="t('m_cc5a7393169d')"
          primary-opens-menu
          single-trigger
          :open="compactActionMenuOpen"
          :items="compactActionItems"
          @toggle="toggleCompactActionMenu"
          @close="compactActionMenuOpen = false"
          @select="handleCompactAction"
        />
        <button
          v-if="canClosePane"
          type="button"
          class="wb-dbhome-close-pane"
          :title="t('m_a11df0f96070')"
          @click="emit('close-pane')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
            <path d="M8 3v10M9.8 5.2l2.2 2.2m0-2.2L9.8 7.4" />
          </svg>
          <span>{{ t('m_1e9b6e9d9fbe') }}</span>
        </button>
      </div>
    </div>

    <DatabaseTableList
      ref="tableListRef"
      :tables="displayedTables"
      :locale-meta="localeFoldResult.localeMetaByName"
      :loading="homeLoading"
      :visible="visible"
      :initial-scroll-top="tab.scrollTop || 0"
      :initial-scroll-left="tab.scrollLeft || 0"
      :search-query="controller.query.value"
      :typeahead-query="typeahead.query.value"
      :selected-names="controller.selectedNames.value"
      :favorite-names="favoriteTableNames"
      :database-decoration="databaseDecoration"
      :renaming-name="controller.renamingName.value"
      :rename-draft="controller.renameDraft.value"
      :rename-error="controller.renameError.value"
      :rename-pending="controller.renamePending.value"
      :sort-state="controller.sortState.value"
      :read-only="readOnly"
      :busy="busy"
      @select-table="selectTable"
      @open-selection="openSelection"
      @activate-row="activateRow"
      @open-design="openDesign"
      @start-rename="startRename"
      @rename-draft="updateRenameDraft"
      @submit-rename="submitRename"
      @cancel-rename="cancelRename"
      @contextmenu="openContextMenu"
      @blank-contextmenu="openContextMenu($event, '')"
      @blank-click="clearSelection"
      @copy="copySelection"
      @paste="pasteTables"
      @delete="deleteSelection"
      @sort-column="sortByColumn"
      @replace-selection="replaceSelection"
      @toggle-favorite="toggleTableFavorite"
      @toggle-locale-group="toggleLocaleGroup"
      @view-change-history="viewTableChangeHistory"
      @box-selection-complete="selectionDismissal.markBoxSelectionComplete"
      @visible-tables="emit('visible-tables', { ...tableSourceContext, tableNames: $event })"
      @scroll-change="handleTableListScrollChange"
    />

    <div
      v-if="typeahead.active.value"
      class="wb-dbhome-typeahead"
      :class="{ 'is-empty': !typeahead.match.value }"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span class="wb-dbhome-typeahead-query">{{ typeahead.query.value }}</span>
      <span
        v-if="typeaheadResultLabel"
        class="wb-dbhome-typeahead-result"
        v-html="typeaheadResultHtml"
      ></span>
    </div>

    <Teleport defer to=".mysql-workbench">
      <menu
        v-if="menu.open"
        ref="contextMenuRef"
        class="wb-context-menu wb-dbhome-context-menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        role="menu"
        tabindex="-1"
        :aria-label="t('m_d2061cf8e332')"
        @click.stop
        @contextmenu.prevent.stop
        @keydown="handleContextMenuKeydown"
      >
        <button type="button" role="menuitem" :disabled="busy || !canTableDesign || !tab.database" @click="emit('create-table', tableSourceContext); closeMenu()"><Plus :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('createTable.title') }}</button>
        <button v-if="!menu.blank" type="button" role="menuitem" @click="openSelection(menu.tableName); closeMenu()"><FolderOpen :size="14" class="wb-context-icon" aria-hidden="true" />{{ openMenuLabel }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ menuShortcuts.open }}</kbd></button>
        <button v-if="!menu.blank" type="button" role="menuitem" :disabled="!canTableDesign" @click="openDesign(menu.tableName); closeMenu()"><TableProperties :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_d9a122ddc940') }}<kbd v-if="menuShortcuts.design" class="wb-context-shortcut" aria-hidden="true">{{ menuShortcuts.design }}</kbd></button>
        <button v-if="!menu.blank && canShowDdl && menu.selectedNames.length <= 1" type="button" role="menuitem" @click="showDdl(menu.tableName)"><Code2 :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('tableDdl.menuAction') }}</button>
        <button v-if="!menu.blank" type="button" role="menuitem" @click="viewTableChangeHistory(menu.tableName); closeMenu()"><History :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('home.contextViewHistory') }}</button>
        <button v-if="!menu.blank" type="button" role="menuitem" :disabled="!canRenameDrop" @click="startRename(menu.tableName)"><Pencil :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_0d0cbac2eee5') }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ menuShortcuts.rename }}</kbd></button>
        <button v-if="!menu.blank" type="button" role="menuitem" :disabled="!canTableDesign" @click="editTableComment(menu.tableName)"><MessageSquareText :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('home.editTableComment') }}<kbd v-if="menuShortcuts.editTableComment" class="wb-context-shortcut" aria-hidden="true">{{ menuShortcuts.editTableComment }}</kbd></button>
        <button v-if="!menu.blank" type="button" role="menuitem" :disabled="!canTableCopy || !menu.selectedNames.length" @click="sendSelection"><Send :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_8f211e16faf2') }}</button>
        <button type="button" role="menuitem" :disabled="!controller.canCopy.value" @click="copySelection"><Copy :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_63d90d977348') }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ menuShortcuts.copy }}</kbd></button>
        <button type="button" role="menuitem" :disabled="!controller.canPaste.value" @click="pasteTables"><ClipboardPaste :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_335179267471') }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ menuShortcuts.paste }}</kbd></button>
        <hr class="wb-context-separator" role="separator" />
        <button type="button" role="menuitem" @click="refreshHome"><RefreshCw :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_aee887434131') }}<kbd v-if="menuShortcuts.refresh" class="wb-context-shortcut" aria-hidden="true">{{ menuShortcuts.refresh }}</kbd></button>
        <button v-if="!menu.blank && canRenameDrop && menu.selectedNames.length" type="button" role="menuitem" class="danger" :disabled="busy" @click="truncateSelection(menu.tableName, menu.selectedNames)"><Eraser :size="14" class="wb-context-icon" aria-hidden="true" />{{ menu.selectedNames.length > 1 ? t('tableTruncate.menuPlural', { count: menu.selectedNames.length }) : t('tableTruncate.menuAction') }}</button>
        <button v-if="!menu.blank" type="button" role="menuitem" class="danger" :disabled="busy || !canRenameDrop || !menu.selectedNames.length" @click="deleteSelection(menu.tableName, menu.selectedNames)"><Trash2 :size="14" class="wb-context-icon" aria-hidden="true" />{{ deleteMenuLabel }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ menuShortcuts.delete }}</kbd></button>
      </menu>
    </Teleport>
  </section>
</template>
