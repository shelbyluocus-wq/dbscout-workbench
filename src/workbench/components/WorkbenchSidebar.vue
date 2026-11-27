<script setup>
import { t } from "../i18n/index.js";
import { writeTableDrag } from "../utils/tableDragPayload.js";
import LanguageSettings from "./LanguageSettings.vue";
import { ChevronRight, Folder, FolderOpen, FolderPlus, Languages, Server, ServerOff } from "lucide-vue-next";
import {
  applyLocaleTableFolding,
  useLocaleTableFoldPreference,
} from "../utils/localeTableGrouping.js";
import { computed, ref, reactive, watch, nextTick, onBeforeUnmount, onMounted } from "vue";
import DesignDebugDialog from "./DesignDebugDialog.vue";
import SidebarSearchPanel from "./SidebarSearchPanel.vue";
import SidebarConnectionMenu from "./SidebarConnectionMenu.vue";
import ShortcutSettingsDialog from "./ShortcutSettingsDialog.vue";
import FontSettingsDialog from "./FontSettingsDialog.vue";
import WallpaperSettingsDialog from "./WallpaperSettingsDialog.vue";
import { useWallpaper, WALLPAPERS } from "../composables/useWallpaper.js";
import { useCellHighlight } from "../composables/useCellHighlight.js";
import { useFieldCommentColor } from "../composables/useFieldCommentColor.js";
import { GLOW_COLOR_PRESETS, resolveGlowColorCss, useGlowColor } from "../composables/useDatabaseSwitchGlow.js";
import {
  areAllConnectionsCollapsed,
  createSidebarTreeState,
  isConnectionExpanded,
  isDatabaseExpanded,
  revealConnection,
  revealSelectedConnection,
  revealDatabase,
  settleDatabaseExpansion,
  toggleConnectionExpansion,
  toggleDatabaseExpansion,
  collapseAllConnections,
  expandAllConnections,
} from "../sidebarTreeState.js";
import { createSidebarSearchState } from "../sidebarSearchState.js";
import { createSidebarRowFollower, revealSidebarSearchResults } from "../sidebarScroll.js";
import { previewDragOrder, resolvePreviewDropTarget, sameDragTarget } from "../sidebarDragPreview.js";
import {
  CONNECTION_GROUP_NAME_MAX_LENGTH,
  buildConnectionTree,
  useConnectionGroupStore,
} from "../composables/connectionGroupStore.js";
import { useConfirm } from "../composables/useConfirm.js";
import { connectionIdentityKey } from "../utils/connectionIdentity.js";
import { beginDatabaseDrag, endDatabaseDrag } from "../utils/databaseDragPayload.js";
import { useAliases } from "../composables/aliasStore.js";
import { databaseTextColorCss, useDatabaseDecorations } from "../composables/databaseDecorationStore.js";
import { computeTableBranchMinHeight, SIDEBAR_TABLE_BRANCH_MAX_HEIGHT, useSidebarVirtualTables } from "../composables/useSidebarVirtualTables.js";
import { useSidebarTableSelection } from "../composables/useSidebarTableSelection.js";
import { isContextMenuKey, isDeleteCommandKey } from "../utils/listSelection.js";
import { splitMiddleEllipsis } from "../utils/middleEllipsis.js";
import { shouldEmitSidebarDatabaseOpen } from "../utils/workspaceHomeRecovery.js";
import { databaseDecorationIconComponent, databaseTableIconComponent } from "./databaseDecorationIcons.js";

function themeLabel(theme) {
  const keys = { slate: "theme.slate", teal: "theme.teal", azure: "theme.azure" };
  return keys[theme.id] ? t(keys[theme.id]) : theme.label;
}

const props = defineProps({
  selectedConnectionId: { type: String, default: "" },
  selectedDatabase: { type: String, default: "" },
  connections: { type: Array, default: () => [] },
  databases: { type: Array, default: () => [] },
  databasesByConnection: { type: Object, default: null },
  databaseFetchErrors: { type: Object, default: null },
  loadingConnectionIds: { type: Object, default: null },
  filteredTables: { type: Array, default: () => [] },
  schemaSearchResults: { type: Array, default: () => [] },
  sidebarSearchState: { type: Object, default: null },
  treeQuery: { type: String, default: "" },
  activeTab: { type: Object, default: null },
  isDark: { type: Boolean, default: false },
  themePreference: { type: String, default: "system" },
  vibrancyOn: { type: Boolean, default: false },
  vibrancySupported: { type: Boolean, default: false },
  colorThemes: { type: Array, default: () => [] },
  colorTheme: { type: String, default: "slate" },
  fontPreference: { type: String, default: "system" },
  fontWeight: { type: Number, default: 400 },
  fontLabel: { type: String, default: "系统默认" },
  invokeWorkbench: { type: Function, default: null },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits([
  "update:treeQuery",
  "select-connection",
  "select-database",
  "expand-connection",
  "expand-all-connections",
  "open-table",
  "search-values",
  "cancel-search-values",
  "open-schema-result",
  "open-value-result",
  "reorder-connections",
  "reorder-databases",
  "rename-table",
  "rename-database",
  "rename-connection",
  "remove-connection",
  "connection-open",
  "connection-close",
  "refresh-connection",
  "contextmenu-open",
  "open-tables",
  "delete-tables",
  "contextmenu",
  "toggle-theme",
  "set-theme",
  "set-vibrancy",
  "set-color-theme",
  "change-font",
]);

const { databaseLabel, getDatabaseAlias, connectionLabel, getConnectionAlias } = useAliases();
const { getDatabaseDecoration } = useDatabaseDecorations();

function databaseDecoration(connectionId, database) {
  return getDatabaseDecoration(connectionId, database);
}

function databaseTreeIcon(connectionId, database) {
  const decoration = databaseDecoration(connectionId, database);
  return databaseDecorationIconComponent(decoration?.icon);
}

function tableTreeIcon(connectionId, database) {
  return databaseTableIconComponent(databaseDecoration(connectionId, database));
}

function databaseMarkerStyle(connectionId, database) {
  const color = databaseDecoration(connectionId, database)?.color;
  return color ? { color } : undefined;
}

function databaseTextStyle(connectionId, database) {
  const color = databaseTextColorCss(databaseDecoration(connectionId, database)?.textColor);
  return color ? { color } : undefined;
}

const treeState = reactive(createSidebarTreeState());
const fallbackSearchState = reactive(createSidebarSearchState());
// `targetGroupId` is the group a dragged connection would join ("" = none,
// null = unchanged).
const dragState = reactive({ kind: "", connectionId: "", sourceId: "", targetId: "", targetPosition: "before", targetGroupId: null });
const treeNavRef = ref(null);
const tableScrollRef = ref(null);
const tableListRef = ref(null);
const databaseRowRefs = new Map();
const databaseRowRefSetters = new Map();
const settingsOpen = ref(false);
const settingsSheetRef = ref(null);
const searchPanelRef = ref(null);
const shortcutsOpen = ref(false);
const fontSettingsOpen = ref(false);
const wallpaperSettingsOpen = ref(false);
const { active: activeWallpaper, customWallpapers } = useWallpaper();
// The settings row names the picture on screen, as the font row names the font.
const wallpaperName = computed(() => {
  const { id } = activeWallpaper.value;
  if (id === "none") return t("wallpaper.none");
  if (id === "custom" || id.startsWith("custom-")) return customWallpapers.value.find((item) => item.id === id)?.name || t("wallpaper.custom");
  return t(WALLPAPERS.find((wallpaper) => wallpaper.id === id)?.labelKey || "wallpaper.none");
});
// 设计调试面板仅 dev 模式可见（npm run dev / tauri dev），正式打包不出现
const isDev = import.meta.env.DEV;
const designDebugOpen = ref(false);

function onBranchAfterEnter(element) {
  element?.classList?.remove?.("wb-branch-enter-from", "wb-branch-enter-to");
}

function onTableBranchBeforeLeave(element) {
  if (!element || typeof element.getBoundingClientRect !== "function") return;
  const currentHeight = Math.round(element.getBoundingClientRect().height);
  if (currentHeight > 0) {
    element.style.setProperty("--wb-tree-table-min-h", `${currentHeight}px`);
  }
}

function setTableScrollElement(element) {
  if (element) {
    tableScrollRef.value = element;
    return;
  }
  nextTick(() => {
    if (tableScrollRef.value && !tableScrollRef.value.isConnected) {
      tableScrollRef.value = null;
    }
  });
}

function setTableListElement(element) {
  if (element) {
    tableListRef.value = element;
    return;
  }
  nextTick(() => {
    if (tableListRef.value && !tableListRef.value.isConnected) {
      tableListRef.value = null;
    }
  });
}
const currentTheme = computed(() => (props.isDark ? "dark" : "light"));
const { color: cellHighlightColor, setColor: setCellHighlightColor, clear: clearCellHighlightColor } = useCellHighlight({
  getTheme: () => currentTheme.value,
  themeRef: currentTheme,
});
const { color: fieldCommentColor, setColor: setFieldCommentColor, clear: clearFieldCommentColor } = useFieldCommentColor({
  getTheme: () => currentTheme.value,
  themeRef: currentTheme,
});
const { color: glowColor, setColor: setGlowColor, clear: clearGlowColor } = useGlowColor({
  getTheme: () => currentTheme.value,
  themeRef: currentTheme,
});
const glowColorPresets = GLOW_COLOR_PRESETS;
// 取色器与预设色点都按当前主题显示实际生效的 hex
const glowColorHex = computed(
  () => resolveGlowColorCss(glowColor.value, currentTheme.value) || (currentTheme.value === "dark" ? "#60a5fa" : "#3b82f6"),
);
function glowPresetSwatch(preset) {
  return currentTheme.value === "dark" ? preset.dark : preset.light;
}

const areAllCollapsed = computed(() =>
  areAllConnectionsCollapsed(
    treeState,
    props.connections.map((c) => c.id),
    props.selectedConnectionId,
  ),
);

function toggleCollapseAll() {
  const ids = props.connections.map((c) => c.id);
  if (areAllCollapsed.value) {
    const expandableIds = props.connections
      .filter((c) => !c.closed && (c.connected !== false || !c.saved))
      .map((c) => c.id);
    expandAllConnections(treeState, expandableIds.length ? expandableIds : ids);
    groupStore.state.value.groups.forEach((group) => groupStore.setCollapsed(group.id, false));
    emit("expand-all-connections");
  } else {
    collapseAllConnections(treeState, ids);
    groupStore.state.value.groups.forEach((group) => groupStore.setCollapsed(group.id, true));
  }
}

function toggleSettings() {
  settingsOpen.value = !settingsOpen.value;
}

function openSettings() {
  settingsOpen.value = true;
}

function openShortcuts() {
  shortcutsOpen.value = true;
}

function settingsRailTrigger() {
  return document.querySelector('.wb-activity-rail-btn[data-wb-rail-id="settings"]');
}

function closeSettings({ restoreFocus = false } = {}) {
  settingsOpen.value = false;
  if (restoreFocus) nextTick(() => settingsRailTrigger()?.focus?.());
}

function openFontSettings() {
  fontSettingsOpen.value = true;
}

function openWallpaperSettings() {
  closeSettings();
  wallpaperSettingsOpen.value = true;
}

function closeWallpaperSettings() {
  wallpaperSettingsOpen.value = false;
  nextTick(() => settingsRailTrigger()?.focus?.());
}

function openDesignDebug() {
  designDebugOpen.value = true;
  closeSettings();
}

function closeDesignDebug() {
  designDebugOpen.value = false;
  nextTick(() => settingsRailTrigger()?.focus?.());
}

function closeFontSettings() {
  fontSettingsOpen.value = false;
  nextTick(() => settingsRailTrigger()?.focus?.());
}

function onDocumentPointerDown(event) {
  if (settingsSheetRef.value?.contains?.(event.target)) return;
  if (settingsRailTrigger()?.contains?.(event.target)) return;
  closeSettings();
}

function onDocumentKeydown(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeSettings({ restoreFocus: true });
}

watch(settingsOpen, (isOpen) => {
  if (isOpen) {
    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("keydown", onDocumentKeydown);
  } else {
    document.removeEventListener("pointerdown", onDocumentPointerDown);
    document.removeEventListener("keydown", onDocumentKeydown);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
});

function setTheme(nextTheme) {
  emit("set-theme", nextTheme);
}

const previewConnections = computed(() => {
  if (dragState.kind === "connection" && dragState.sourceId && dragState.targetId) {
    return previewDragOrder(props.connections, dragState.sourceId, dragState.targetId, {
      position: dragState.targetPosition,
      getKey: (connection) => connection.id,
    });
  }
  return props.connections;
});

// ── Connection groups ────────────────────────────────────────────────────
const groupStore = useConnectionGroupStore();
const { confirm: confirmDialog } = useConfirm();

function connectionGroupId(connection) {
  return groupStore.groupOf(connectionIdentityKey(connection));
}

const previewGroupState = computed(() => {
  const { groups, members } = groupStore.state.value;
  if (dragState.kind === "group" && dragState.sourceId && dragState.targetId) {
    return {
      members,
      groups: previewDragOrder(groups, dragState.sourceId, dragState.targetId, {
        position: dragState.targetPosition,
        getKey: (group) => group.id,
      }),
    };
  }
  if (dragState.kind === "connection" && dragState.targetGroupId !== null) {
    const key = connectionIdentityKey(props.connections.find((connection) => connection.id === dragState.sourceId));
    if (!key) return { groups, members };
    const next = { ...members };
    if (dragState.targetGroupId) next[key] = dragState.targetGroupId;
    else delete next[key];
    return { groups, members: next };
  }
  return { groups, members };
});

const connectionTree = computed(() => buildConnectionTree(previewConnections.value, {
  ...previewGroupState.value,
  identityOf: connectionIdentityKey,
}));

// While a connection is dragged every group stays open, so the dragged row is
// never unmounted mid-drag; while a group is dragged they all fold.
function isGroupOpen(group) {
  if (dragState.kind === "group") return false;
  if (dragState.kind === "connection") return true;
  return !group.collapsed;
}

// One flat, keyed list for the tree: group headers followed by their
// connections, then the connections in no group.
const treeItems = computed(() => {
  const items = [];
  for (const group of connectionTree.value.groups) {
    items.push({ key: `group:${group.id}`, kind: "group", group, connection: null, groupId: group.id, groupEnd: false });
    if (!isGroupOpen(group)) continue;
    group.connections.forEach((connection, index) => {
      items.push({
        key: connection.id,
        kind: "connection",
        group: null,
        connection,
        groupId: group.id,
        groupEnd: index === group.connections.length - 1,
      });
    });
  }
  connectionTree.value.ungrouped.forEach((connection) => {
    items.push({ key: connection.id, kind: "connection", group: null, connection, groupId: "", groupEnd: false });
  });
  return items;
});

function groupCounts(group) {
  const connections = group?.connections || [];
  const closed = connections.filter((connection) => connection.closed).length;
  return { openCount: connections.length - closed, closedCount: closed };
}

function revealConnectionGroup(connectionId) {
  const connection = props.connections.find((item) => item.id === connectionId);
  const groupId = connection ? connectionGroupId(connection) : "";
  if (groupId) groupStore.setCollapsed(groupId, false);
}

function toggleGroup(group) {
  if (groupRename.id === group.id) return;
  groupStore.setCollapsed(group.id, !group.collapsed);
}

const groupRename = reactive({ id: "", draft: "", error: "" });
const groupRenameInputRef = ref(null);

function groupNameError(code) {
  if (code === "empty") return t("connectionGroup.nameEmpty");
  if (code === "duplicate") return t("connectionGroup.nameDuplicate");
  if (code === "tooLong") return t("connectionGroup.nameTooLong", { max: CONNECTION_GROUP_NAME_MAX_LENGTH });
  return "";
}

function startGroupRename(groupId) {
  const group = groupStore.getGroup(groupId);
  if (!group) return;
  groupStore.setCollapsed(group.id, false);
  groupRename.id = group.id;
  groupRename.draft = group.name;
  groupRename.error = "";
  nextTick(() => {
    const input = Array.isArray(groupRenameInputRef.value) ? groupRenameInputRef.value[0] : groupRenameInputRef.value;
    input?.focus();
    input?.select();
  });
}

function focusGroupRow(groupId) {
  nextTick(() => treeNavRef.value?.querySelector?.(`[data-connection-group-id="${groupId}"] .wb-connection-group-node`)?.focus?.({ preventScroll: true }));
}

function commitGroupRename() {
  const id = groupRename.id;
  if (!id) return;
  const group = groupStore.getGroup(id);
  if (group && groupRename.draft.trim() !== group.name) {
    const result = groupStore.renameGroup(id, groupRename.draft);
    if (!result.ok) {
      groupRename.error = groupNameError(result.error);
      return;
    }
  }
  cancelGroupRename();
  focusGroupRow(id);
}

function cancelGroupRename() {
  groupRename.id = "";
  groupRename.draft = "";
  groupRename.error = "";
}

// A new group starts with the given connections and its name in edit mode.
function createGroup(connectionIds = []) {
  const memberKeys = connectionIds
    .map((id) => connectionIdentityKey(props.connections.find((connection) => connection.id === id)))
    .filter(Boolean);
  const result = groupStore.createGroup(groupStore.suggestName(t("connectionGroup.defaultName")), { memberKeys });
  if (result.ok) startGroupRename(result.group.id);
}

async function deleteGroup(groupId) {
  const group = connectionTree.value.groups.find((item) => item.id === groupId);
  if (!group) return;
  const confirmed = !group.connections.length || await confirmDialog({
    title: t("connectionGroup.deleteTitle"),
    message: t("connectionGroup.deleteMessage", { name: group.name, count: group.connections.length }),
    confirmText: t("connectionGroup.delete"),
    cancelText: t("m_2cd0f3be8738"),
    danger: true,
  });
  if (confirmed) groupStore.deleteGroup(groupId);
}

function moveConnectionToGroup(connectionId, groupId) {
  const connection = props.connections.find((item) => item.id === connectionId);
  if (!connection || !groupStore.assign(connectionIdentityKey(connection), groupId)) return;
  if (groupId) groupStore.setCollapsed(groupId, false);
}

function handleGroupKeydown(event, group) {
  if (event.key === "F2" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    startGroupRename(group.id);
  } else if (isDeleteCommandKey(event)) {
    void deleteGroup(group.id);
  } else if (isContextMenuKey(event)) {
    openGroupMenu(menuPointBelow(event.currentTarget), group);
  } else if (event.key === "ArrowLeft" && !group.collapsed) {
    groupStore.setCollapsed(group.id, true);
  } else if (event.key === "ArrowRight" && group.collapsed) {
    groupStore.setCollapsed(group.id, false);
  } else {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

// ── Connection and group menu ────────────────────────────────────────────
const connectionMenu = reactive({ open: false, x: 0, y: 0, kind: "connection", connectionId: "", groupId: "", keyboard: false });
let connectionMenuReturnFocus = null;

function menuPointBelow(element) {
  const rect = element?.getBoundingClientRect?.();
  return rect ? { clientX: rect.left + 24, clientY: rect.bottom, keyboard: true } : { clientX: 0, clientY: 0, keyboard: true };
}

function showConnectionMenu(event, kind, { connectionId = "", groupId = "" } = {}) {
  connectionMenuReturnFocus = event?.keyboard ? document.activeElement : null;
  Object.assign(connectionMenu, {
    open: true,
    x: Number(event?.clientX || 0),
    y: Number(event?.clientY || 0),
    kind,
    connectionId,
    groupId,
    keyboard: Boolean(event?.keyboard),
  });
}

function openConnectionMenu(event, connection) {
  emit("contextmenu-open");
  showConnectionMenu(event, "connection", { connectionId: connection.id });
}

function openGroupMenu(event, group) {
  emit("contextmenu-open");
  showConnectionMenu(event, "group", { groupId: group.id });
}

function closeConnectionMenu({ restoreFocus = false } = {}) {
  if (!connectionMenu.open) return;
  connectionMenu.open = false;
  const target = connectionMenuReturnFocus;
  connectionMenuReturnFocus = null;
  if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
}

const menuConnection = computed(() => {
  const connection = props.connections.find((item) => item.id === connectionMenu.connectionId);
  if (!connection) return null;
  return {
    id: connection.id,
    label: connectionLabel(connection.id, connection.label),
    closed: Boolean(connection.closed),
    closable: !connection.closed && !connection.sampleData,
    groupId: connectionGroupId(connection),
  };
});

const menuGroup = computed(() => {
  const group = connectionTree.value.groups.find((item) => item.id === connectionMenu.groupId);
  return group ? { id: group.id, name: group.name, ...groupCounts(group) } : null;
});

const menuGroups = computed(() => groupStore.state.value.groups.map(({ id, name }) => ({ id, name })));

function onConnectionMenuSelect({ action, groupId = "" }) {
  const connectionId = connectionMenu.connectionId;
  const group = connectionTree.value.groups.find((item) => item.id === connectionMenu.groupId);
  const keepFocus = !["rename", "remove", "new-group", "group-rename", "group-delete", "close", "group-close-all"].includes(action);
  closeConnectionMenu({ restoreFocus: keepFocus });
  if (action === "open") openConnectionRow(connectionId);
  else if (action === "close") emit("connection-close", { connectionIds: [connectionId] });
  else if (action === "new-group") createGroup([connectionId]);
  else if (action === "move-to") moveConnectionToGroup(connectionId, groupId);
  else if (action === "ungroup") moveConnectionToGroup(connectionId, "");
  else if (action === "rename") emit("rename-connection", { connectionId });
  else if (action === "refresh") emit("refresh-connection", { connectionId });
  else if (action === "remove") emit("remove-connection", { connectionId });
  else if (action === "group-open-all") {
    group?.connections.filter((connection) => connection.closed).forEach((connection) => openConnectionRow(connection.id));
  } else if (action === "group-close-all") {
    emit("connection-close", { connectionIds: (group?.connections || []).filter((connection) => !connection.closed).map((connection) => connection.id) });
  } else if (action === "group-rename" && group) startGroupRename(group.id);
  else if (action === "group-delete" && group) void deleteGroup(group.id);
}

function rawDatabasesForConnection(connectionId) {
  const mapped = props.databasesByConnection?.[connectionId];
  if (Array.isArray(mapped)) return mapped;
  return connectionId === props.selectedConnectionId ? props.databases : [];
}

function databasesForConnection(connectionId) {
  const list = rawDatabasesForConnection(connectionId);
  if (
    dragState.kind === "database"
    && (!dragState.connectionId || dragState.connectionId === connectionId)
    && dragState.sourceId
    && dragState.targetId
  ) {
    return previewDragOrder(list, dragState.sourceId, dragState.targetId, {
      position: dragState.targetPosition,
    });
  }
  return list;
}

const previewDatabases = computed(() => databasesForConnection(props.selectedConnectionId));

function isConnectionLoading(connectionId) {
  if (props.loadingConnectionIds?.has?.(connectionId)) return true;
  return props.busy && connectionId === props.selectedConnectionId && rawDatabasesForConnection(connectionId).length === 0;
}

function connectionFetchError(connectionId) {
  return props.databaseFetchErrors?.[connectionId] || null;
}

// A closed connection unfolds only to show it opening or why it failed to.
function isConnectionBranchShown(connection) {
  if (!isConnectionExpanded(treeState, connection.id, props.selectedConnectionId)) return false;
  return !connection.closed || isConnectionLoading(connection.id) || Boolean(connectionFetchError(connection.id));
}

watch(
  () => props.connections.filter((connection) => connection.closed).map((connection) => connection.id),
  (closedIds, previousIds = []) => {
    const previous = new Set(previousIds);
    closedIds.filter((id) => !previous.has(id)).forEach((id) => {
      if (connectionFetchError(id) || isConnectionLoading(id)) return;
      treeState.collapsedConnectionIds.add(id);
      treeState.expandedConnectionIds?.delete(id);
    });
  },
);

function retryConnectionFetch(connectionId) {
  const err = connectionFetchError(connectionId);
  if (err?.needsReconnect) {
    emit("select-connection", connectionId);
  } else {
    emit("expand-connection", connectionId);
  }
}

const effectiveSchemaSearchResults = computed(() => {
  if (!props.treeQuery.trim()) return [];
  if (props.schemaSearchResults.length > 0) return props.schemaSearchResults;
  return props.filteredTables.map((table, index) => {
    const name = table.tableName || table.table_name || index;
    return {
      key: `table:${props.selectedConnectionId}:${props.selectedDatabase}:${name}:${index}`,
      table,
      visibleColumns: [],
      matchedColumns: [],
      hiddenColumnCount: 0,
      matchKind: "none",
    };
  });
});

const effectiveSearchState = computed(() => props.sidebarSearchState || fallbackSearchState);
const rawFilteredTables = computed(() => (
  !props.treeQuery.trim()
    ? props.filteredTables
    : effectiveSchemaSearchResults.value.map((result) => result.table)
));
const { foldLocaleTables, toggleFoldLocaleTables } = useLocaleTableFoldPreference();
const expandedLocaleBases = ref(new Set());
const sidebarLocaleFold = computed(() => applyLocaleTableFolding(rawFilteredTables.value, {
  allTables: props.filteredTables,
  fold: foldLocaleTables.value,
  expandedBases: expandedLocaleBases.value,
  query: props.treeQuery,
}));
const filteredTables = computed(() => sidebarLocaleFold.value.rows);

function sidebarLocaleMeta(table) {
  return sidebarLocaleFold.value.localeMetaByName.get(String(table?.tableName || "")) || null;
}

function toggleSidebarLocaleGroup(baseLower) {
  if (!baseLower) return;
  const next = new Set(expandedLocaleBases.value);
  if (next.has(baseLower)) next.delete(baseLower);
  else next.add(baseLower);
  expandedLocaleBases.value = next;
}

// 表列表虚拟滚动：只挂载可视区行，展开大库分支不再一次性创建上千个 DOM。
const {
  virtualRange: tableVirtualRange,
  listTop: tableListTop,
  rowHeight: tableRowHeight,
  visibleTables,
  scrollTableIntoView,
  scrollContainer: tableScrollElement,
} = useSidebarVirtualTables({
  scrollContainerRef: tableScrollRef,
  listElRef: tableListRef,
  tables: filteredTables,
});

const renderedVisibleTables = computed(() =>
  visibleTables.value.map((entry) => ({
    table: entry.table,
    index: entry.index,
    nameParts: splitMiddleEllipsis(entry.table.tableName),
    localeMeta: sidebarLocaleMeta(entry.table),
  })),
);

const activeBranchTableIcon = computed(() =>
  tableTreeIcon(props.selectedConnectionId, props.selectedDatabase),
);
const activeBranchMarkerStyle = computed(() =>
  databaseMarkerStyle(props.selectedConnectionId, props.selectedDatabase),
);
const activeBranchTextStyle = computed(() =>
  databaseTextStyle(props.selectedConnectionId, props.selectedDatabase),
);

const activeTableName = computed(() => (
  props.activeTab?.connectionId === props.selectedConnectionId && props.activeTab?.database === props.selectedDatabase
    ? String(props.activeTab?.tableName || "")
    : ""
));
const tableSelection = useSidebarTableSelection({ tables: filteredTables, activeTableName });

watch(() => [props.selectedConnectionId, props.selectedDatabase], () => {
  tableSelection.clear();
  expandedLocaleBases.value = new Set();
});
watch(() => props.treeQuery.trim(), (query) => {
  if (query) tableSelection.clear();
});
watch(filteredTables, () => {
  if (tableSelection.isMultiple.value || tableSelection.selectedSet.value.size > 0) {
    tableSelection.prune();
  }
});

const treeViewportHeight = ref(0);
const visibleDatabaseCount = computed(() => {
  let count = 0;
  for (const conn of previewConnections.value) {
    if (isConnectionExpanded(treeState, conn.id, props.selectedConnectionId)) {
      count += databasesForConnection(conn.id).length;
    }
  }
  return count;
});
const tableBranchMaxHeight = computed(() => {
  const viewport = treeViewportHeight.value;
  if (viewport <= 0) return SIDEBAR_TABLE_BRANCH_MAX_HEIGHT;
  const connectionRows = Math.min(treeItems.value.length, 6) * 30;
  const databaseRows = Math.min(visibleDatabaseCount.value || previewDatabases.value.length, 8) * 28;
  const available = viewport - connectionRows - databaseRows - 16;
  return Math.max(SIDEBAR_TABLE_BRANCH_MAX_HEIGHT, available);
});

const tableBranchMinHeight = computed(() => {
  const height = computeTableBranchMinHeight({
    tableHeight: tableVirtualRange.value.totalHeight,
    listTop: tableListTop.value,
    searching: !!props.treeQuery.trim(),
    loading: props.busy && !filteredTables.value.length,
    maxHeight: tableBranchMaxHeight.value,
  });
  return `${height}px`;
});

watch(
  () => props.activeTab?.id,
  async () => {
    const tab = props.activeTab;
    if (!tab) return;
    if (tab.connectionId !== props.selectedConnectionId || tab.database !== props.selectedDatabase) return;
    revealActiveTable();
  },
);

let pendingSidebarClickAnchor = null;

watch(
  () => [props.selectedConnectionId, props.selectedDatabase],
  ([connectionId, database], [previousConnectionId, previousDatabase]) => {
    if (connectionId && connectionId !== previousConnectionId) {
      revealSelectedConnection(treeState, connectionId);
      revealConnectionGroup(connectionId);
    }
    settleDatabaseExpansion(treeState, connectionId, database);
    if (!connectionId || !database) return;
    if (connectionId === previousConnectionId && database === previousDatabase) return;
    const key = databaseRowKey(connectionId, database);
    const anchorOffset = pendingSidebarClickAnchor?.key === key ? pendingSidebarClickAnchor.offset : null;
    pendingSidebarClickAnchor = null;
    if (!treeState.collapsedConnectionIds.has(connectionId)) {
      revealSelectedDatabase(anchorOffset !== null ? { anchorViewportOffset: anchorOffset } : undefined);
    }
    nextTick(() => revealActiveTable());
  },
);

// 只在「进入搜索态」（空 → 非空）时把表区带回顶部，再在下一帧校正首个结果。
// 这既避开虚拟表列表卸载与搜索结果挂载之间的布局竞争，也完全不触碰数据库导航滚动。
let wasSearching = false;
watch(
  () => props.treeQuery,
  (query) => {
    const nowSearching = !!(query || "").trim();
    const entering = nowSearching && !wasSearching;
    wasSearching = nowSearching;
    if (!entering) return;
    nextTick(() => {
      const container = tableScrollElement();
      if (!container) return;
      if (typeof container.scrollTo === "function") container.scrollTo({ top: 0, behavior: "auto" });
      else container.scrollTop = 0;
      requestAnimationFrame(() => {
        revealSidebarSearchResults(tableScrollElement(), { smooth: false });
      });
    });
  },
);

// The highlighted "current" database follows the active tab right away; the
// selected source catches up in the background (tabSourceSync), and covers
// tabs without a database of their own.
const currentDatabaseKey = computed(() => {
  const tab = props.activeTab;
  if (tab?.database) return databaseRowKey(tab.connectionId || props.selectedConnectionId, tab.database);
  return props.selectedDatabase ? databaseRowKey(props.selectedConnectionId, props.selectedDatabase) : "";
});

function isCurrentDatabase(connectionId, database) {
  return currentDatabaseKey.value === databaseRowKey(connectionId, database);
}

function databaseRowKey(connectionId, database) {
  return `${String(connectionId || "")}\u001f${String(database || "")}`;
}

function setDatabaseRowRef(connectionId, database, element) {
  const key = databaseRowKey(connectionId, database);
  if (element) databaseRowRefs.set(key, element);
  else databaseRowRefs.delete(key);
}

function getDatabaseRowRefSetter(connectionId, database) {
  const key = databaseRowKey(connectionId, database);
  let setter = databaseRowRefSetters.get(key);
  if (!setter) {
    setter = (element) => setDatabaseRowRef(connectionId, database, element);
    databaseRowRefSetters.set(key, setter);
  }
  return setter;
}

// 外部入口切换数据库时只做 nearest reveal，绝不把数据库吸到导航区顶部；
// 直接在侧栏点击已滚动树中的数据库行时，锚定鼠标下的行视口偏移，防止上方分支收起时整行跳走。
const selectedDatabaseFollower = createSidebarRowFollower({
  getContainer: () => treeNavRef.value,
  getRow: () => databaseRowRefs.get(databaseRowKey(props.selectedConnectionId, props.selectedDatabase)),
});

function revealSelectedDatabase(options) {
  if (props.selectedConnectionId) {
    revealSelectedConnection(treeState, props.selectedConnectionId);
    revealConnectionGroup(props.selectedConnectionId);
  }
  // After the DOM update, so the branch transitions of this change have begun.
  return nextTick(() => selectedDatabaseFollower.follow(options));
}

// A collapsed sidebar has no layout to measure; a database chosen meanwhile
// is brought into view when the tree is shown again.
let treeVisibilityObserver = null;
onMounted(() => {
  if (!treeNavRef.value) return;
  treeViewportHeight.value = Math.round(treeNavRef.value.clientHeight || 0);
  if (typeof ResizeObserver !== "function") return;
  treeVisibilityObserver = new ResizeObserver(() => {
    treeViewportHeight.value = Math.round(treeNavRef.value?.clientHeight || 0);
    selectedDatabaseFollower.resume();
  });
  treeVisibilityObserver.observe(treeNavRef.value);
});
onBeforeUnmount(() => {
  treeVisibilityObserver?.disconnect();
  selectedDatabaseFollower.stop();
});

// 把当前 tab 对应的表滚动到侧栏可视区内，并预留上下边距。
// 表列表已虚拟化：离屏行没有 DOM，因此按表在列表中的下标计算滚动位置，
// 而不是查询 DOM 元素。跨连接/数据库切换时表数据异步加载，故带有限次重试。
function revealActiveTable() {
  const tab = props.activeTab;
  const container = tableScrollElement();
  if (!tab || !container) return;
  if (tab.connectionId !== props.selectedConnectionId || tab.database !== props.selectedDatabase) return;

  const MAX_ATTEMPTS = 8;

  const attempt = (count) => {
    if (count > MAX_ATTEMPTS) return;
    const index = filteredTables.value.findIndex(
      (table) => (table.tableName || table.table_name) === tab.tableName,
    );
    if (index < 0) {
      // 表尚未进入列表（展开/加载未完成），下一帧再试。
      requestAnimationFrame(() => attempt(count + 1));
      return;
    }
    // 表区独立滚动；按整行高度留出 1 行上下文，避免自动定位时把上方相邻行截断半截。
    scrollTableIntoView(index, { margin: tableRowHeight.value });
  };

  void nextTick(() => attempt(1));
}

// Opening a closed connection unfolds it; the databases follow once connected.
function openConnectionRow(connectionId) {
  revealConnection(treeState, connectionId);
  emit("connection-open", connectionId);
}

function onConnectionClick(connectionId) {
  const connection = props.connections.find((item) => item.id === connectionId);
  if (connection?.closed) {
    if (isConnectionLoading(connectionId)) return;
    if (isConnectionExpanded(treeState, connectionId, props.selectedConnectionId) && connectionFetchError(connectionId)) {
      toggleConnectionExpansion(treeState, connectionId, props.selectedConnectionId);
      return;
    }
    openConnectionRow(connectionId);
    return;
  }
  if (connection && !connection.connected && connection.saved) {
    revealConnection(treeState, connectionId);
    emit("select-connection", connectionId);
    return;
  }
  toggleConnectionExpansion(treeState, connectionId, props.selectedConnectionId);
  if (!isConnectionExpanded(treeState, connectionId, props.selectedConnectionId)) {
    return;
  }
  if (!props.selectedDatabase && shouldEmitSidebarDatabaseOpen({ activeTab: props.activeTab })) {
    emit("select-connection", connectionId);
    return;
  }
  emit("expand-connection", connectionId);
}

function captureRowViewportOffset(event) {
  const container = treeNavRef.value;
  const row = event?.currentTarget;
  if (!container || !row || !(Number(container.scrollTop) > 0)) return null;
  const containerRect = container.getBoundingClientRect?.();
  const rowRect = row.getBoundingClientRect?.();
  if (!containerRect || !rowRect) return null;
  const offset = Number(rowRect.top) - Number(containerRect.top);
  return Number.isFinite(offset) ? offset : null;
}

function onDatabaseClick(connectionId, database, event) {
  if (toggleDatabaseExpansion(treeState, connectionId, database, props.selectedConnectionId, props.selectedDatabase)) {
    if (isDatabaseExpanded(treeState, connectionId, database, props.selectedConnectionId, props.selectedDatabase)) {
      nextTick(() => revealActiveTable());
    }
    if (shouldEmitSidebarDatabaseOpen({ activeTab: props.activeTab })) {
      emit("select-database", { connectionId, database });
    }
    return;
  }
  const anchorOffset = captureRowViewportOffset(event);
  pendingSidebarClickAnchor = anchorOffset !== null
    ? { key: databaseRowKey(connectionId, database), offset: anchorOffset }
    : null;
  revealConnection(treeState, connectionId);
  revealDatabase(treeState, connectionId, database);
  if (anchorOffset !== null) {
    void revealSelectedDatabase({ anchorViewportOffset: anchorOffset });
  }
  emit("select-database", { connectionId, database });
}

function tablePayload(table) {
  return {
    ...(table.raw || table),
    connectionId: props.selectedConnectionId,
    database: props.selectedDatabase,
  };
}

function tableForName(name) {
  return filteredTables.value.find((table) => table.tableName === name) || null;
}

function openSelectedTable(table) {
  emit("open-table", tablePayload(table));
}

// Plain click opens the table at once (unchanged); Ctrl/Cmd and Shift clicks
// only build the selection that Enter, double-click and Delete act on.
function onTableClick(table, event) {
  if (tableSelection.click(table.tableName, event) === "open") openSelectedTable(table);
}

function onTableDoubleClick(table) {
  const plan = tableSelection.doubleClick(table.tableName);
  if (plan) openTablePlan(plan);
}

function openTablePlan({ names = [], activeName = "" } = {}) {
  const tables = names.map(tableForName).filter(Boolean).map(tablePayload);
  if (!tables.length) return;
  if (tables.length === 1) {
    openSelectedTable(tables[0]);
    return;
  }
  emit("open-tables", { tables, activeName });
}

function deleteTables(names) {
  if (!names.length) return;
  emit("delete-tables", {
    connectionId: props.selectedConnectionId,
    database: props.selectedDatabase,
    tableNames: [...names],
    origin: "sidebar",
  });
}

function openTableContextMenu(event, table) {
  const tableNames = tableSelection.targets(table.tableName);
  emit("contextmenu", event, { ...tablePayload(table), selectedTableNames: tableNames });
}

// Rows are virtualized: scroll the target into view, then focus it once the
// window has rendered it.
function focusTableRow(name, attempt = 0) {
  if (!name) return;
  const index = filteredTables.value.findIndex((table) => table.tableName === name);
  if (attempt === 0) scrollTableIntoView(index, { margin: 8, smooth: false });
  const row = Array.from(tableListRef.value?.querySelectorAll?.(".wb-table-item") || [])
    .find((element) => element.dataset.tableName === name);
  if (row) {
    row.focus({ preventScroll: true });
    return;
  }
  if (attempt < 4) requestAnimationFrame(() => focusTableRow(name, attempt + 1));
}

const TABLE_NAVIGATION_DELTAS = Object.freeze({ ArrowDown: 1, ArrowUp: -1, End: Infinity, Home: -Infinity });

function handleTableListKeydown(event) {
  const row = event.target?.closest?.(".wb-table-item");
  const name = row?.dataset?.tableName || "";
  const table = tableForName(name);
  if (!table) return;
  const key = String(event.key || "");
  const command = event.ctrlKey || event.metaKey;
  const plain = !command && !event.altKey && !event.shiftKey;
  if (Object.hasOwn(TABLE_NAVIGATION_DELTAS, key) && !command && !event.altKey) {
    focusTableRow(tableSelection.move(TABLE_NAVIGATION_DELTAS[key], { extend: event.shiftKey, from: name }));
  } else if (key === "Enter" && plain) {
    tableSelection.targets(name);
    openTablePlan(tableSelection.openPlan(name));
  } else if (key === "F2" && plain) {
    emit("rename-table", tablePayload(table));
  } else if (isDeleteCommandKey(event)) {
    deleteTables(tableSelection.targets(name));
  } else if (command && !event.shiftKey && !event.altKey && key.toLowerCase() === "a") {
    tableSelection.selectAll();
  } else if (key === "Escape" && tableSelection.isMultiple.value) {
    tableSelection.clear();
  } else if (isContextMenuKey(event)) {
    const rect = row.getBoundingClientRect();
    openTableContextMenu({ clientX: rect.left + 24, clientY: rect.bottom, keyboard: true }, table);
  } else {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

// F2 renames a connection or database alias and Delete removes a
// connection, matching the table rows.
function handleConnectionKeydown(event, connectionId) {
  if (event.key === "F2" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    emit("rename-connection", { connectionId });
  } else if (isDeleteCommandKey(event)) {
    emit("remove-connection", { connectionId });
  } else if (isContextMenuKey(event)) {
    const connection = props.connections.find((item) => item.id === connectionId);
    if (connection) openConnectionMenu(menuPointBelow(event.currentTarget), connection);
  } else {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

function handleDatabaseKeydown(event, connectionId, database) {
  if (event.key !== "F2" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  event.stopPropagation();
  emit("rename-database", { connectionId, database });
}

function databaseTooltip(connectionId, database) {
  const alias = getDatabaseAlias(connectionId, database);
  return alias ? `${alias}\n${database}` : database;
}

function connectionTooltip(connection) {
  const alias = getConnectionAlias(connection.id);
  return alias ? `${alias}\n${connection.label}` : connection.label;
}

function openSchemaSearchResult(result) {
  emit("open-schema-result", result);
}

function tableTitle(table) {
  return table.tableComment ? `${table.tableName}\n${table.tableComment}` : table.tableName;
}

function isTableActive(table) {
  return (
    props.activeTab?.connectionId === props.selectedConnectionId &&
    props.activeTab?.database === props.selectedDatabase &&
    props.activeTab?.tableName === table.tableName
  );
}

function setDragImage(event) {
  if (!event?.dataTransfer || typeof document === "undefined") return;
  const source = event.currentTarget;
  const rect = source?.getBoundingClientRect?.();
  if (!source || !rect) return;
  const image = source.cloneNode(true);
  image.classList.add("wb-sidebar-drag-image");
  image.style.width = `${rect.width}px`;
  image.style.height = `${rect.height}px`;
  document.body.appendChild(image);
  event.dataTransfer.setDragImage(image, Math.min(18, rect.width / 2), Math.min(18, rect.height / 2));
  requestAnimationFrame(() => image.remove());
}

function setDragPayload(event, kind, id) {
  if (!event?.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-dbscout-sidebar", JSON.stringify({ kind, id }));
  event.dataTransfer.setData("text/plain", String(id));
  setDragImage(event);
}

// Tables dragged out of the sidebar, e.g. into a table folder. A table that
// belongs to the multi-selection takes the whole selection along.
function startTableDrag(connectionId, database, table, event) {
  const name = table?.tableName || "";
  const names = tableSelection.isMultiple.value && tableSelection.selectedSet.value.has(name)
    ? filteredTables.value.map((item) => item.tableName).filter((item) => tableSelection.selectedSet.value.has(item))
    : [name];
  writeTableDrag(event, { connectionId, database, tableNames: names });
}

function startSidebarDrag(kind, id, event, connectionId = "") {
  closeConnectionMenu();
  dragState.kind = kind;
  dragState.connectionId = connectionId;
  dragState.sourceId = id;
  dragState.targetId = "";
  dragState.targetPosition = "before";
  dragState.targetGroupId = null;
  setDragPayload(event, kind, id);
  if (kind === "database") beginDatabaseDrag(event, { connectionId, database: id });
}

function clearSidebarDrag() {
  dragState.kind = "";
  dragState.connectionId = "";
  dragState.sourceId = "";
  dragState.targetId = "";
  dragState.targetPosition = "before";
  dragState.targetGroupId = null;
  endDatabaseDrag();
}

function isDragSource(kind, id, connectionId = "") {
  if (dragState.kind !== kind || dragState.sourceId !== id) return false;
  if (kind === "database" && dragState.connectionId && dragState.connectionId !== connectionId) return false;
  return true;
}

function isDragTarget(kind, id, connectionId = "") {
  if (dragState.kind !== kind || dragState.targetId !== id || dragState.sourceId === id) return false;
  if (kind === "database" && dragState.connectionId && dragState.connectionId !== connectionId) return false;
  return true;
}

function dragNodeClass(kind, id, connectionId = "") {
  const source = isDragSource(kind, id, connectionId);
  const targetBefore = isDragTarget(kind, id, connectionId) && dragState.targetPosition === "before";
  const targetAfter = isDragTarget(kind, id, connectionId) && dragState.targetPosition === "after";
  return {
    "is-drag-ghost": source,
    "is-drop-before": targetBefore,
    "is-drop-after": targetAfter,
  };
}

function dragRowClass(kind, id, connectionId = "") {
  const source = isDragSource(kind, id, connectionId);
  const target = isDragTarget(kind, id, connectionId);
  return {
    "is-dragging-source": source,
    "is-drag-over": target,
    "is-drag-preview-target": target,
  };
}

function markDragTarget(kind, id, event, connectionId = "") {
  if (dragState.kind !== kind || dragState.sourceId === id) return;
  if (kind === "database" && dragState.connectionId && dragState.connectionId !== connectionId) return;
  const position = dropPosition(event);
  if (event?.dataTransfer) event.dataTransfer.dropEffect = "move";
  if (sameDragTarget({ kind: dragState.kind, id: dragState.targetId, position: dragState.targetPosition }, kind, id, position)) return;
  dragState.targetId = id;
  dragState.targetPosition = position;
}

function dropPosition(event) {
  const rect = event?.currentTarget?.getBoundingClientRect?.();
  if (!rect) return "before";
  return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
}

// Over a connection row, the dragged connection takes that row's place and
// its group; over a group header it joins the group; below the list it
// leaves its group and goes last.
function markConnectionDragTarget(connectionId, groupId, event) {
  if (dragState.kind === "group") {
    if (event?.dataTransfer) event.dataTransfer.dropEffect = "none";
    return;
  }
  markDragTarget("connection", connectionId, event);
  if (dragState.kind === "connection") dragState.targetGroupId = groupId;
}

function markGroupDragTarget(group, event) {
  if (dragState.kind === "group") {
    markDragTarget("group", group.id, event);
    return;
  }
  if (dragState.kind !== "connection") return;
  if (event?.dataTransfer) event.dataTransfer.dropEffect = "move";
  dragState.targetId = "";
  dragState.targetGroupId = group.id;
}

// Only the space below the last row counts: the gaps between rows belong to
// the row targets around them.
function isBelowLastRow(event) {
  const rows = event?.currentTarget?.children;
  const last = rows?.[rows.length - 1];
  const rect = last?.getBoundingClientRect?.();
  return Boolean(rect && event.clientY > rect.bottom);
}

function markListEndDragTarget(event) {
  if (dragState.kind !== "connection") return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  if (!isBelowLastRow(event)) return;
  const last = connectionTree.value.ungrouped.filter((connection) => connection.id !== dragState.sourceId).at(-1);
  dragState.targetId = last?.id || "";
  dragState.targetPosition = "after";
  dragState.targetGroupId = "";
}

function isGroupDropTarget(group) {
  return dragState.kind === "connection" && !dragState.targetId && dragState.targetGroupId === group.id;
}

function commitConnectionDrop(fallbackTargetId = "", fallbackPosition = "before") {
  if (dragState.kind !== "connection" || !dragState.sourceId) return;
  const sourceId = dragState.sourceId;
  const groupId = dragState.targetGroupId;
  const target = resolvePreviewDropTarget(dragState, fallbackTargetId, fallbackPosition);
  if (target.targetId && sourceId !== target.targetId) {
    emit("reorder-connections", sourceId, target.targetId, { position: target.position });
  }
  if (groupId !== null) moveConnectionToGroup(sourceId, groupId);
}

function dropConnection(connectionId, event) {
  if (dragState.kind === "connection" && dragState.sourceId) {
    const fallbackPosition = dragState.targetId === connectionId ? dragState.targetPosition : dropPosition(event);
    commitConnectionDrop(connectionId, fallbackPosition);
  }
  clearSidebarDrag();
}

function dropOnGroup(group, event) {
  if (dragState.kind === "group" && dragState.sourceId) {
    const fallbackPosition = dragState.targetId === group.id ? dragState.targetPosition : dropPosition(event);
    const target = resolvePreviewDropTarget(dragState, group.id, fallbackPosition);
    if (dragState.sourceId !== target.targetId) groupStore.moveGroup(dragState.sourceId, target.targetId, target.position);
  } else if (dragState.kind === "connection" && dragState.sourceId) {
    dragState.targetId = "";
    dragState.targetGroupId = group.id;
    commitConnectionDrop();
  }
  clearSidebarDrag();
}

function dropOnListEnd(event) {
  if (dragState.kind !== "connection") return;
  event.preventDefault();
  commitConnectionDrop();
  clearSidebarDrag();
}

function dropDatabase(connectionId, database, event) {
  if (
    dragState.kind === "database"
    && dragState.sourceId
    && (!dragState.connectionId || dragState.connectionId === connectionId)
  ) {
    const fallbackPosition = dragState.targetId === database ? dragState.targetPosition : dropPosition(event);
    const target = resolvePreviewDropTarget(dragState, database, fallbackPosition);
    if (dragState.sourceId !== target.targetId) {
      emit("reorder-databases", dragState.sourceId, target.targetId, { connectionId, position: target.position });
    }
  }
  clearSidebarDrag();
}

// Exposed so the orchestrator can focus the sidebar search via Ctrl+P (#8).
// `<SidebarSearchPanel>` renders inside a `v-for` over databases, so in Vue 3
// `searchPanelRef` resolves to an array of component instances rather than a
// single one. Normalize both shapes and focus the first panel that exposes
// `focusSearch`.
//
// The panel is also wrapped in `v-if="isDatabaseExpanded(...)"`, so when the
// selected database branch is collapsed (the common state when the user is
// working in the data grid) no panel is mounted and the array is empty —
// making Ctrl+P silently no-op. In that case expand the selected
// connection/database branch first, then focus on the next tick once Vue has
// mounted the panel's input (#ctrl-p-noop).
function focusSearch() {
  const focusMounted = () => {
    const panels = Array.isArray(searchPanelRef.value) ? searchPanelRef.value : [searchPanelRef.value];
    for (const panel of panels) {
      if (panel && typeof panel.focusSearch === "function") {
        panel.focusSearch();
        return true;
      }
    }
    return false;
  };

  if (focusMounted()) return;

  // No panel mounted yet — reveal the selected branch so Vue renders it, then
  // focus after the DOM update.
  const connectionId = props.selectedConnectionId;
  const database = props.selectedDatabase;
  if (!connectionId || !database) return;
  revealConnection(treeState, connectionId);
  revealDatabase(treeState, connectionId, database);
  nextTick(() => {
    focusMounted();
  });
}

defineExpose({ focusSearch, revealSelectedDatabase, toggleSettings, openSettings, openShortcuts, settingsOpen });
</script>

<template>
  <aside class="wb-sidebar wb-navigation-pane" @contextmenu.prevent.stop="emit('contextmenu', $event)">
    <Teleport defer to="#wb-topbar-sidebar-actions">
      <div class="wb-sidebar-actions">
        <button
          type="button"
          class="wb-header-btn"
          :aria-label="t('connectionGroup.newGroup')"
          :title="t('connectionGroup.newGroup')"
          @click="createGroup()"
        >
          <FolderPlus :size="14" :stroke-width="1.75" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="wb-header-btn"
          :aria-label="areAllCollapsed ? t('m_a49b9e3cc423') : t('m_809ec93960dd')"
          :title="areAllCollapsed ? t('m_695704a261cb') : t('m_2fabdc5d8190')"
          @click="toggleCollapseAll"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <template v-if="areAllCollapsed">
              <polyline points="2,5 7,10 12,5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </template>
            <template v-else>
              <polyline points="2,9 7,4 12,9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </template>
          </svg>
        </button>
      </div>
    </Teleport>

    <nav
      ref="treeNavRef"
      class="wb-source-tree"
      :style="{ '--wb-tree-table-min-h': tableBranchMinHeight }"
      :aria-label="t('m_46770f47d1a3')"
    >
      <TransitionGroup
        name="wb-tree-reorder"
        tag="div"
        class="wb-source-connection-list"
        :class="{ 'is-reordering': dragState.kind === 'connection' || dragState.kind === 'group' }"
        @dragover="markListEndDragTarget"
        @drop="dropOnListEnd"
      >
        <section
          v-for="{ key, kind: itemKind, group, connection, groupId: itemGroupId, groupEnd } in treeItems"
          :key="key"
          :data-connection-id="connection?.id"
          :data-connection-group-id="group?.id"
          :class="itemKind === 'group'
            ? ['wb-source-group', dragNodeClass('group', group.id), { 'is-open': isGroupOpen(group) }]
            : ['wb-source-connection', dragNodeClass('connection', connection.id), {
              'is-expanded': isConnectionBranchShown(connection),
              'is-grouped': Boolean(itemGroupId),
              'is-group-end': groupEnd,
            }]"
        >
          <template v-if="itemKind === 'group'">
            <div v-if="groupRename.id === group.id" class="wb-tree-row wb-connection-group-node is-renaming">
              <span class="wb-tree-chevron is-open" aria-hidden="true"></span>
              <FolderOpen :size="15" class="wb-tree-kind-icon" aria-hidden="true" />
              <input
                ref="groupRenameInputRef"
                v-model="groupRename.draft"
                class="wb-connection-group-rename"
                :maxlength="CONNECTION_GROUP_NAME_MAX_LENGTH"
                :aria-label="t('connectionGroup.rename')"
                :aria-invalid="groupRename.error ? 'true' : 'false'"
                :aria-describedby="groupRename.error ? 'wb-connection-group-error' : undefined"
                @keydown.enter.prevent="commitGroupRename"
                @keydown.esc.prevent.stop="cancelGroupRename(); focusGroupRow(group.id)"
                @blur="commitGroupRename"
              />
            </div>
            <button
              v-else
              type="button"
              class="wb-tree-row wb-connection-group-node"
              :class="[dragRowClass('group', group.id), { 'is-drop-into': isGroupDropTarget(group) }]"
              :title="group.name"
              :aria-expanded="isGroupOpen(group) ? 'true' : 'false'"
              draggable="true"
              @dragstart.stop="startSidebarDrag('group', group.id, $event)"
              @dragover.prevent.stop="markGroupDragTarget(group, $event)"
              @drop.prevent.stop="dropOnGroup(group, $event)"
              @dragend="clearSidebarDrag"
              @click="toggleGroup(group)"
              @keydown="handleGroupKeydown($event, group)"
              @contextmenu.prevent.stop="openGroupMenu($event, group)"
            >
              <span class="wb-tree-chevron" :class="{ 'is-open': isGroupOpen(group) }" aria-hidden="true"></span>
              <component :is="isGroupOpen(group) ? FolderOpen : Folder" :size="15" class="wb-tree-kind-icon" aria-hidden="true" />
              <span class="wb-connection-group-label">
                <span class="wb-tree-label">{{ group.name }}</span>
                <span v-if="!isGroupOpen(group) && group.connections.length" class="wb-connection-group-count">{{ group.connections.length }}</span>
              </span>
            </button>
            <p v-if="groupRename.id === group.id && groupRename.error" id="wb-connection-group-error" class="wb-connection-group-error" role="alert">{{ groupRename.error }}</p>
          </template>
          <template v-else>
          <button
            class="wb-tree-row wb-connection-node"
            :class="[{ active: connection.id === selectedConnectionId, 'is-closed': connection.closed }, dragRowClass('connection', connection.id)]"
            :title="connectionTooltip(connection)"
            :aria-expanded="isConnectionExpanded(treeState, connection.id, selectedConnectionId) && isConnectionBranchShown(connection)"
            draggable="true"
            @dragstart.stop="startSidebarDrag('connection', connection.id, $event)"
            @dragover.prevent.stop="markConnectionDragTarget(connection.id, itemGroupId, $event)"
            @drop.prevent.stop="dropConnection(connection.id, $event)"
            @dragend="clearSidebarDrag"
            @click="onConnectionClick(connection.id)"
            @keydown="handleConnectionKeydown($event, connection.id)"
            @contextmenu.prevent.stop="openConnectionMenu($event, connection)"
          >
            <span class="wb-tree-chevron" :class="{ 'is-open': isConnectionBranchShown(connection) }" aria-hidden="true"></span>
            <component :is="connection.closed ? ServerOff : Server" :size="15" class="wb-tree-kind-icon" aria-hidden="true" />
            <span class="wb-alias-copy" :class="{ 'has-alias': getConnectionAlias(connection.id) }">
              <span class="wb-tree-label">{{ connectionLabel(connection.id, connection.label) }}</span>
              <span v-if="getConnectionAlias(connection.id)" class="wb-alias-realname">{{ connection.label }}</span>
            </span>
            <span v-if="connection.closed" class="wb-visually-hidden">{{ t("connectionGroup.closedState") }}</span>
          </button>

          <Transition name="wb-branch" :duration="220" @after-enter="onBranchAfterEnter" @enter-cancelled="onBranchAfterEnter">
          <section v-if="dragState.kind !== 'connection' && dragState.kind !== 'group' && isConnectionBranchShown(connection)" class="wb-database-branch">
            <div class="wb-branch-inner">
            <TransitionGroup
              name="wb-tree-reorder"
              tag="div"
              class="wb-source-database-list"
              :class="{ 'is-reordering': dragState.kind === 'database' && dragState.connectionId === connection.id }"
            >
              <section
                v-for="database in databasesForConnection(connection.id)"
                :key="database"
                class="wb-source-database"
                :class="[
                  dragNodeClass('database', database, connection.id),
                  { 'is-expanded': isDatabaseExpanded(treeState, connection.id, database, selectedConnectionId, selectedDatabase) },
                ]"
              >
                <button
                  :ref="getDatabaseRowRefSetter(connection.id, database)"
                  class="wb-tree-row wb-database-item"
                  :class="[{ active: isCurrentDatabase(connection.id, database) }, dragRowClass('database', database, connection.id)]"
                  :title="databaseTooltip(connection.id, database)"
                  :aria-current="isCurrentDatabase(connection.id, database) ? 'true' : undefined"
                  :aria-expanded="isDatabaseExpanded(treeState, connection.id, database, selectedConnectionId, selectedDatabase)"
                  draggable="true"
                  @dragstart.stop="startSidebarDrag('database', database, $event, connection.id)"
                  @dragover.prevent.stop="markDragTarget('database', database, $event, connection.id)"
                  @drop.prevent.stop="dropDatabase(connection.id, database, $event)"
                  @dragend="clearSidebarDrag"
                  @click="onDatabaseClick(connection.id, database, $event)"
                  @keydown="handleDatabaseKeydown($event, connection.id, database)"
                  @contextmenu.prevent.stop="emit('contextmenu', $event, { kind: 'database', connectionId: connection.id, database })"
                >
                  <svg v-if="isCurrentDatabase(connection.id, database)" class="wb-current-db-halo" aria-hidden="true" focusable="false">
                    <rect class="wb-current-db-halo-track" x="0" y="0" width="100%" height="100%" rx="5.5" pathLength="100" />
                    <rect class="wb-current-db-halo-trail is-long" x="0" y="0" width="100%" height="100%" rx="5.5" pathLength="100" />
                    <rect class="wb-current-db-halo-trail is-mid" x="0" y="0" width="100%" height="100%" rx="5.5" pathLength="100" />
                    <rect class="wb-current-db-halo-trail is-short" x="0" y="0" width="100%" height="100%" rx="5.5" pathLength="100" />
                    <rect class="wb-current-db-halo-head" x="0" y="0" width="100%" height="100%" rx="5.5" pathLength="100" />
                  </svg>
                  <span class="wb-tree-chevron" :class="{ 'is-open': isDatabaseExpanded(treeState, connection.id, database, selectedConnectionId, selectedDatabase) }" aria-hidden="true"></span>
                  <component :is="databaseTreeIcon(connection.id, database)" :size="15" class="wb-tree-kind-icon" :style="databaseMarkerStyle(connection.id, database)" aria-hidden="true" />
                  <span class="wb-alias-copy" :class="{ 'has-alias': getDatabaseAlias(connection.id, database) }">
                    <span class="wb-tree-label" :style="databaseTextStyle(connection.id, database)">{{ databaseLabel(connection.id, database) }}</span>
                    <span v-if="getDatabaseAlias(connection.id, database)" class="wb-alias-realname">{{ database }}</span>
                  </span>
                </button>

                <Transition name="wb-branch" :duration="220" @after-enter="onBranchAfterEnter" @enter-cancelled="onBranchAfterEnter" @before-leave="onTableBranchBeforeLeave">
                <section v-if="dragState.kind !== 'database' && isDatabaseExpanded(treeState, connection.id, database, selectedConnectionId, selectedDatabase)" class="wb-table-branch">
                  <SidebarSearchPanel
                    ref="searchPanelRef"
                    :query="treeQuery"
                    :connection-id="selectedConnectionId"
                    :database="database"
                    :schema-results="effectiveSchemaSearchResults"
                    :search-state="effectiveSearchState"
                    :scroll-aria-label="t('sidebar.tablesOf', { database: databaseLabel(connection.id, database) })"
                    @scroll-element="setTableScrollElement"
                    @update:query="emit('update:treeQuery', $event)"
                    @search-values="emit('search-values')"
                    @cancel-search-values="emit('cancel-search-values')"
                    @open-schema-result="openSchemaSearchResult"
                    @open-value-result="emit('open-value-result', $event)"
                  >

                  <template v-if="!treeQuery.trim()">
                    <div
                      v-if="sidebarLocaleFold.totalVariantCount > 0"
                      class="wb-sidebar-locale-bar"
                    >
                      <button
                        type="button"
                        class="wb-sidebar-locale-toggle"
                        :class="{ 'is-active': foldLocaleTables }"
                        :aria-pressed="foldLocaleTables ? 'true' : 'false'"
                        :title="t('localeFold.toggleHint', { count: sidebarLocaleFold.totalVariantCount })"
                        @click="toggleFoldLocaleTables"
                      >
                        <Languages :size="12" :stroke-width="2" aria-hidden="true" />
                        <span>{{ foldLocaleTables ? t('localeFold.foldedCount', { count: sidebarLocaleFold.hiddenVariantCount }) : t('localeFold.foldShort') }}</span>
                      </button>
                    </div>
                    <div
                      v-if="filteredTables.length"
                      :ref="setTableListElement"
                      class="wb-table-vlist"
                      :style="{ height: `${tableVirtualRange.totalHeight}px` }"
                      @keydown="handleTableListKeydown"
                    >
                      <div
                        class="wb-table-vlist-window"
                        :style="{ transform: `translateY(${tableVirtualRange.padTop}px)` }"
                      >
                        <button
                          v-for="entry in renderedVisibleTables"
                          :key="entry.table.tableName"
                          class="wb-tree-row wb-table-item"
                          :data-table-name="entry.table.tableName"
                          :class="{
                            active: isTableActive(entry.table),
                            'is-selected': tableSelection.isMultiple.value && tableSelection.selectedSet.value.has(entry.table.tableName),
                            'has-locale-pill': sidebarLocaleMeta(entry.table)?.kind === 'base',
                            'is-locale-variant': sidebarLocaleMeta(entry.table)?.kind === 'variant',
                          }"
                          :aria-current="isTableActive(entry.table) ? 'page' : undefined"
                          :title="tableTitle(entry.table)"
                          draggable="true"
                          @dragstart="startTableDrag(connection.id, database, entry.table, $event)"
                          @click="onTableClick(entry.table, $event)"
                          @dblclick="onTableDoubleClick(entry.table)"
                          @contextmenu.prevent.stop="openTableContextMenu($event, entry.table)"
                        >
                          <component :is="tableTreeIcon(connection.id, database)" :size="15" class="wb-tree-kind-icon" :style="databaseMarkerStyle(connection.id, database)" aria-hidden="true" />
                          <span class="wb-table-copy" :class="{ 'has-comment': entry.table.tableComment }">
                            <span class="wb-table-name" :style="databaseTextStyle(connection.id, database)" :class="{ 'is-middle-ellipsis': Boolean(entry.nameParts.tail) }" :aria-label="entry.nameParts.tail ? entry.table.tableName : undefined"><span class="wb-middle-ellipsis-head" :aria-hidden="entry.nameParts.tail ? 'true' : undefined">{{ entry.nameParts.head }}</span><span v-if="entry.nameParts.tail" class="wb-middle-ellipsis-tail" aria-hidden="true">{{ entry.nameParts.tail }}</span></span>
                            <span v-if="entry.table.tableComment" class="wb-table-comment">{{ entry.table.tableComment }}</span>
                          </span>
                          <span
                            v-if="entry.localeMeta?.kind === 'base'"
                            role="button"
                            tabindex="0"
                            class="wb-locale-group-pill wb-sidebar-locale-pill"
                            :class="{ 'is-expanded': entry.localeMeta.expanded }"
                            :aria-expanded="entry.localeMeta.expanded ? 'true' : 'false'"
                            :title="t('localeFold.expandGroup', { count: entry.localeMeta.variantCount, suffixes: entry.localeMeta.suffixes.join(' / ') })"
                            @click.stop="toggleSidebarLocaleGroup(entry.localeMeta.baseLower)"
                            @dblclick.stop
                            @keydown.enter.space.prevent.stop="toggleSidebarLocaleGroup(entry.localeMeta.baseLower)"
                          >
                            <ChevronRight :size="10" :stroke-width="2.2" class="wb-locale-group-chevron" aria-hidden="true" />
                            <span>+{{ entry.localeMeta.variantCount }}</span>
                          </span>
                        </button>
                      </div>
                    </div>

                    <p v-if="busy && !filteredTables.length" class="wb-tree-loading">
                      <span class="wb-tree-loading-spinner" aria-hidden="true"></span> {{ t('m_4927a53bcc88') }} </p>
                    <p v-else-if="!filteredTables.length" class="wb-tree-empty">{{ t('m_4034e355eb62') }}</p>
                  </template>
                  </SidebarSearchPanel>
                </section>
                </Transition>
              </section>
            </TransitionGroup>
            <p v-if="isConnectionLoading(connection.id) && !databasesForConnection(connection.id).length" class="wb-tree-loading">
              <span class="wb-tree-loading-spinner" aria-hidden="true"></span> {{ t('m_4927a53bcc88') }} </p>
            <div v-else-if="!databasesForConnection(connection.id).length && connectionFetchError(connection.id)" class="wb-tree-connection-error">
              <span>{{ connectionFetchError(connection.id).message }}</span>
              <button type="button" class="wb-tree-connection-retry" @click.stop="retryConnectionFetch(connection.id)">
                {{ connectionFetchError(connection.id).needsReconnect ? t('m_1eff9b7d894c') : t('m_b8784c8dd563') }}
              </button>
            </div>
            </div>
          </section>
          </Transition>
          </template>
        </section>
      </TransitionGroup>
    </nav>

    <SidebarConnectionMenu
      :open="connectionMenu.open"
      :x="connectionMenu.x"
      :y="connectionMenu.y"
      :kind="connectionMenu.kind"
      :theme="currentTheme"
      :connection="menuConnection"
      :group="menuGroup"
      :groups="menuGroups"
      :focus-on-open="connectionMenu.keyboard"
      @select="onConnectionMenuSelect"
      @close="closeConnectionMenu"
    />

    <Teleport to="body">
      <Transition name="wb-sidebar-settings-sheet">
      <section
        v-if="settingsOpen"
        ref="settingsSheetRef"
        id="wb-sidebar-settings-sheet"
        class="wb-sidebar-settings-sheet wb-floating-themed"
        :data-theme="currentTheme"
        :aria-label="t('m_df3d58c7d84b')"
        :aria-hidden="!settingsOpen"
        :inert="!settingsOpen"
      >
        <div class="wb-sidebar-settings-group">
        <LanguageSettings />
        <div class="wb-sidebar-settings-row is-stacked">
          <span class="wb-sidebar-settings-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3.6" />
              <path d="M12 2.7v2.4M12 18.9v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.7 12h2.4M18.9 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7" />
            </svg> {{ t('m_86a63f23a076') }} </span>
          <div class="wb-sidebar-theme-segment is-full" role="group" :aria-label="t('m_d32fff09b9ab')">
            <button type="button" :class="{ active: themePreference === 'light' }" @click.stop="setTheme('light')">{{ t('m_aa0819dfc4d8') }}</button>
            <button type="button" :class="{ active: themePreference === 'dark' }" @click.stop="setTheme('dark')">{{ t('m_a6b75d068032') }}</button>
            <button type="button" :class="{ active: themePreference === 'system' }" @click.stop="setTheme('system')">{{ t('m_c9a1f2b3d4e5') }}</button>
          </div>
        </div>
        <div v-if="vibrancySupported" class="wb-sidebar-settings-row">
          <span class="wb-sidebar-settings-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" rx="3" />
              <path d="M3 10h18" />
            </svg> {{ t('m_b7c2d3e4f5a6') }} </span>
          <div class="wb-sidebar-theme-segment" role="group" :aria-label="t('m_b7c2d3e4f5a6')">
            <button type="button" :class="{ active: vibrancyOn }" @click.stop="emit('set-vibrancy', true)">{{ t('m_c1d2e3f4a5b6') }}</button>
            <button type="button" :class="{ active: !vibrancyOn }" @click.stop="emit('set-vibrancy', false)">{{ t('m_d1e2f3a4b5c6') }}</button>
          </div>
        </div>
        <div class="wb-sidebar-settings-row wb-sidebar-settings-row-themes">
          <span class="wb-sidebar-settings-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M8.5 10.5h.01M12 8.5h.01M15.5 10.5h.01M9.5 14.5h.01M13 15.5h.01" />
            </svg> {{ t('m_788db1cfec2a') }} </span>
          <div class="wb-sidebar-theme-options" role="group" :aria-label="t('m_8f29293906e7')">
            <button
              v-for="theme in colorThemes"
              :key="theme.id"
              type="button"
              class="wb-sidebar-theme-option"
              :class="{ active: theme.id === colorTheme }"
              :title="theme.description"
              @click.stop="emit('set-color-theme', theme.id)"
            >
              <span class="wb-sidebar-theme-swatch" aria-hidden="true"><i :style="{ background: theme.swatch[1] }"></i><i :style="{ background: theme.swatch[0] }"></i><i :style="{ background: theme.swatch[2] }"></i></span>
              {{ themeLabel(theme) }}
            </button>
          </div>
        </div>
        <div class="wb-sidebar-settings-row">
          <span class="wb-sidebar-settings-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="8" cy="9" r="1.5" />
              <path d="m3 17 5-5 4 4 3-3 6 6" />
            </svg> {{ t('wallpaper.title') }} </span>
          <button type="button" class="wb-sidebar-settings-action" aria-haspopup="dialog" :title="t('wallpaper.open')" :aria-label="`${t('wallpaper.open')} ${wallpaperName}`" @click.stop="openWallpaperSettings">
            <span class="wb-sidebar-settings-action-label">{{ wallpaperName }}</span>
            <ChevronRight :size="13" class="wb-sidebar-settings-chevron" aria-hidden="true" />
          </button>
        </div>
        <div class="wb-sidebar-settings-row">
          <span class="wb-sidebar-settings-label">
            <span class="wb-sidebar-font-icon" aria-hidden="true">Aa</span> {{ t('m_52a039f438fd') }} </span>
          <button
            type="button"
            class="wb-sidebar-settings-action wb-sidebar-font-action"
            :title="fontPreference === 'system' ? t('settings.systemFont') : fontLabel"
            @click.stop="openFontSettings"
          >
            <span class="wb-sidebar-settings-action-label">{{ fontPreference === 'system' ? t('settings.systemFont') : fontLabel }}</span>
            <ChevronRight :size="13" class="wb-sidebar-settings-chevron" aria-hidden="true" />
          </button>
        </div>
        </div>
        <div class="wb-sidebar-settings-group">
        <div class="wb-sidebar-settings-row">
          <span class="wb-sidebar-settings-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 5.5h14M5 9.5h9M5 13.5h11M5 17.5h7" />
            </svg> {{ t('m_39230fff0eb1') }} </span>
          <span class="wb-sidebar-highlight-picker">
            <button
              v-if="fieldCommentColor"
              type="button"
              class="wb-sidebar-settings-reset"
              :title="t('m_ba2e93e73037')"
              @click.stop="clearFieldCommentColor"
            >{{ t('m_844b8cc8dff7') }}</button>
            <input
              type="color"
              :value="fieldCommentColor || (isDark ? '#c2c8d0' : '#3f4650')"
              :aria-label="t('m_268035c4ed59')"
              @input="setFieldCommentColor($event.target.value)"
            />
          </span>
        </div>
        <div class="wb-sidebar-settings-row">
          <span class="wb-sidebar-settings-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4" y="4" width="7" height="7" rx="1.5" />
              <rect x="13" y="4" width="7" height="7" rx="1.5" />
              <rect x="4" y="13" width="7" height="7" rx="1.5" />
              <rect x="13" y="13" width="7" height="7" rx="1.5" />
            </svg> {{ t('m_5395b35f3101') }} </span>
          <span class="wb-sidebar-highlight-picker">
            <button
              v-if="cellHighlightColor"
              type="button"
              class="wb-sidebar-settings-reset"
              :title="t('m_ba2e93e73037')"
              @click.stop="clearCellHighlightColor"
            >{{ t('m_844b8cc8dff7') }}</button>
            <input
              type="color"
              :value="cellHighlightColor || '#3b82f6'"
              :aria-label="t('m_3081c51ef3c7')"
              @input="setCellHighlightColor($event.target.value)"
            />
          </span>
        </div>
        <div class="wb-sidebar-settings-row wb-sidebar-settings-row-themes">
          <span class="wb-sidebar-settings-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 21V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16" />
              <path d="M8 12.5h8" />
            </svg> {{ t('m_94f283676114') }} </span>
          <div class="wb-sidebar-glow-options" role="group" :aria-label="t('m_8072d90fc108')">
            <button
              v-for="preset in glowColorPresets"
              :key="preset.value"
              type="button"
              class="wb-sidebar-glow-preset"
              :class="{ active: glowColor === preset.value }"
              :style="{ background: glowPresetSwatch(preset) }"
              :title="preset.label"
              :aria-label="t('sidebar.glowColor', { name: preset.label })"
              @click.stop="setGlowColor(preset.value)"
            ></button>
            <span class="wb-sidebar-highlight-picker">
              <button
                v-if="glowColor"
                type="button"
                class="wb-sidebar-settings-reset"
                :title="t('m_ba2e93e73037')"
                @click.stop="clearGlowColor"
              >{{ t('m_844b8cc8dff7') }}</button>
              <input
                type="color"
                :value="glowColorHex"
                :aria-label="t('m_60aea9656c75')"
                :title="t('m_781b07fdcb56')"
                @input="setGlowColor($event.target.value)"
              />
            </span>
          </div>
        </div>
        </div>
        <div class="wb-sidebar-settings-group">
        <div class="wb-sidebar-settings-row">
          <span class="wb-sidebar-settings-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="7" width="18" height="11" rx="2.5" />
              <path d="M7 11h2M7 14h1M11 11h2M11 14h3M16 11h1M16 14h2" />
            </svg> {{ t('m_ee2638183d3e') }} </span>
          <button type="button" class="wb-sidebar-settings-action" @click.stop="shortcutsOpen = true">{{ t('m_1eff9b7d894c') }}</button>
        </div>
        <div v-if="isDev" class="wb-sidebar-settings-row">
          <span class="wb-sidebar-settings-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M8.5 10.5h.01M15.5 10.5h.01M8.5 14.5h7" />
            </svg> {{ t('m_0fe0c819b123') }} </span>
          <button type="button" class="wb-sidebar-settings-action" @click.stop="openDesignDebug">{{ t('m_3429a4778824') }}</button>
        </div>
        </div>
      </section>
      </Transition>
    </Teleport>

    <ShortcutSettingsDialog
      :open="shortcutsOpen"
      :invoke-workbench="invokeWorkbench"
      :theme="currentTheme"
      @close="shortcutsOpen = false"
    />
    <FontSettingsDialog
      :open="fontSettingsOpen"
      :preference="fontPreference"
      :weight="fontWeight"
      :theme="currentTheme"
      :invoke-workbench="invokeWorkbench"
      @apply="emit('change-font', $event)"
      @close="closeFontSettings"
    />
    <WallpaperSettingsDialog
      v-if="wallpaperSettingsOpen"
      :open="wallpaperSettingsOpen"
      :theme="currentTheme"
      @close="closeWallpaperSettings"
      @set-theme="emit('set-theme', $event)"
    />
    <DesignDebugDialog
      v-if="isDev"
      :open="designDebugOpen"
      :theme="currentTheme"
      @close="closeDesignDebug"
    />
  </aside>
</template>
