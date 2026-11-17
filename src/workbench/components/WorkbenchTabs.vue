<script setup>
import { t } from "../i18n/index.js";
import { useTabReorderMotion } from "../composables/useTabReorderMotion.js";
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { ChevronDown, House } from "lucide-vue-next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { previewDragOrder, resolvePreviewDropTarget, sameDragTarget } from "../sidebarDragPreview.js";
import { useAliases } from "../composables/aliasStore.js";
import { databaseTextColorCss, useDatabaseDecorations } from "../composables/databaseDecorationStore.js";
import { formatShortcutForPlatform } from "../utils/desktopPlatform.js";
import { useMacosTitlebarDoubleClick } from "../composables/useMacosTitlebar.js";
import { formatTableTabTitle } from "../utils/tabDisplay.js";
import { assignTabShortcutHints } from "../utils/tabShortcutHints.js";
import { writeTableDrag } from "../utils/tableDragPayload.js";
import { partitionTabs } from "../utils/tabOverflow.js";
import { databaseDecorationIconComponent } from "./databaseDecorationIcons.js";

const props = defineProps({
  tabs: { type: Array, default: () => [] },
  activeTabId: { type: String, default: "" },
  paneId: { type: String, default: "" },
  canClosePane: { type: Boolean, default: false },
  showShortcutHints: { type: Boolean, default: false },
  connections: { type: Array, default: () => [] },
});

const emit = defineEmits(["activate-tab", "close-tab", "close-pane", "tab-contextmenu", "reorder-tab", "copy-tab-name"]);

const { databaseLabel, connectionLabel } = useAliases();
const { getDatabaseDecoration } = useDatabaseDecorations();

const draggingTabId = ref("");
const dragTargetTabId = ref("");
const dragTargetPosition = ref("before");

const previewTabs = computed(() => {
  if (!draggingTabId.value || !dragTargetTabId.value) return pinHomeTabFirst(props.tabs);
  return pinHomeTabFirst(previewDragOrder(props.tabs, draggingTabId.value, dragTargetTabId.value, {
    position: dragTargetPosition.value,
    getKey: (tab) => tab.id,
  }));
});

function openTabContextMenu(event, tab = null) {
  if (props.tabs.length === 0 || tab?.opening) return;
  emit("tab-contextmenu", { x: event.clientX, y: event.clientY, paneId: props.paneId, tabId: tab?.id || props.activeTabId });
}

function tabDropPosition(event) {
  const rect = event?.currentTarget?.getBoundingClientRect?.();
  if (!rect) return "before";
  return event.clientX > rect.left + rect.width / 2 ? "after" : "before";
}

function startTabDrag(tabId, event) {
  const tab = props.tabs.find((tab) => tab.id === tabId);
  if (!tab || tab.opening) return;
  draggingTabId.value = tabId;
  dragTargetTabId.value = "";
  dragTargetPosition.value = "before";
  if (!event?.dataTransfer) return;
  const canCopyTable = !tab.createMode && isTableLikeTab(tab) && tab.tableName && writeTableDrag(event, {
    connectionId: tab.connectionId,
    database: tab.database,
    tableNames: [tab.tableName],
  });
  event.dataTransfer.effectAllowed = canCopyTable ? "copyMove" : "move";
  event.dataTransfer.setData("application/x-dbscout-tab", tabId);
  event.dataTransfer.setData("application/x-dbscout-pane", props.paneId);
  event.dataTransfer.setData("text/plain", tabId);
}

function draggedTabId(event) {
  return draggingTabId.value || event?.dataTransfer?.getData?.("application/x-dbscout-tab") || event?.dataTransfer?.getData?.("text/plain") || "";
}

function markTabDragTarget(tabId, event) {
  if (props.tabs.find((tab) => tab.id === tabId)?.opening) return;
  const sourceId = draggedTabId(event);
  if (!sourceId || sourceId === tabId) return;
  const position = normalizeDropPosition(tabId, tabDropPosition(event));
  if (event?.dataTransfer) event.dataTransfer.dropEffect = "move";
  if (sameDragTarget({ kind: "tab", id: dragTargetTabId.value, position: dragTargetPosition.value }, "tab", tabId, position)) return;
  dragTargetTabId.value = tabId;
  dragTargetPosition.value = position;
}

function dropTab(tabId, event) {
  if (props.tabs.find((tab) => tab.id === tabId)?.opening) {
    clearTabDrag();
    return;
  }
  const sourceId = draggedTabId(event);
  if (sourceId) {
    const fallbackPosition = dragTargetTabId.value === tabId
      ? dragTargetPosition.value
      : normalizeDropPosition(tabId, tabDropPosition(event));
    const target = resolvePreviewDropTarget(
      { sourceId, targetId: dragTargetTabId.value, targetPosition: dragTargetPosition.value },
      tabId,
      fallbackPosition,
    );
    if (sourceId !== target.targetId) {
      emit("reorder-tab", sourceId, target.targetId, { position: target.position });
    }
  }
  clearTabDrag();
}

function markTabbarDragTarget(event) {
  const sourceId = draggedTabId(event);
  if (!sourceId) return;
  if (event?.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function dropTabOnBar(event) {
  const sourceId = draggedTabId(event);
  if (!sourceId || event.target?.closest?.(".wb-tab")) return;
  emit("reorder-tab", sourceId, "", { position: "after" });
  clearTabDrag();
}

function clearTabDrag() {
  draggingTabId.value = "";
  dragTargetTabId.value = "";
  dragTargetPosition.value = "before";
}

function stopTabClosePointer() {}

function copyTabName(tab, event) {
  if (tab?.opening) return;
  emit("copy-tab-name", {
    tab,
    x: event?.clientX ?? 0,
    y: event?.clientY ?? 0,
  });
}

function tabKind(tab) {
  if (tab.kind === "home") return "home";
  if (tab.kind === "sql") return "sql";
  if (tab.kind === "sql-library") return "sql-library";
  if (tab.kind === "folders") return "folders";
  return tab.kind === "design" ? "design" : "data";
}

function pinHomeTabFirst(tabs) {
  const homeIndex = tabs.findIndex((tab) => tabKind(tab) === "home");
  if (homeIndex <= 0) return tabs;
  const nextTabs = [...tabs];
  const [home] = nextTabs.splice(homeIndex, 1);
  nextTabs.unshift(home);
  return nextTabs;
}

function normalizeDropPosition(tabId, position) {
  const targetTab = props.tabs.find((tab) => tab.id === tabId);
  return tabKind(targetTab) === "home" && position === "before" ? "after" : position;
}

function tabTitle(tab) {
  if (tabKind(tab) === "home") return t('m_203c08e0d44a');
  if (tabKind(tab) === "sql-library") return t('m_6369c8800ff1');
  if (tabKind(tab) === "folders") return t('tableFolders.title');
  if (tabKind(tab) === "sql") return tab.title || tab.fileName || t('m_6369c8800ff1');
  return formatTableTabTitle(tab, databaseLabel(tab.connectionId, tab.database));
}

function isTableLikeTab(tab) {
  const kind = tabKind(tab);
  return kind === "data" || kind === "design";
}

function tabDatabaseLabel(tab) {
  return databaseLabel(tab.connectionId, tab.database) || String(tab.database || "");
}

function tabConnectionLabel(tab) {
  const id = String(tab.connectionId || "");
  if (!id) return "";
  const connection = props.connections.find((item) => String(item.id) === id);
  return connectionLabel(id, connection?.label || id);
}

function tabMenuName(tab) {
  if (tab.createMode) return tab.draft?.tableName || t('createTable.title');
  return isTableLikeTab(tab) ? (tab.tableName || tabTitle(tab)) : tabTitle(tab);
}

function tabMenuTag(tab) {
  if (tabKind(tab) === "design") return t('m_56c255e19858');
  if (tabKind(tab) === "sql") return `SQL${tab.dirty ? " •" : ""}`;
  return tab.relationFilter ? t('relations.tabTag') : "";
}

function tabDatabaseDecoration(tab) {
  return getDatabaseDecoration(tab.connectionId, tab.database);
}

function tabDatabaseIcon(tab) {
  return databaseDecorationIconComponent(tabDatabaseDecoration(tab)?.icon);
}

function tabDatabaseDecorationStyle(tab) {
  const decoration = tabDatabaseDecoration(tab);
  const textColor = databaseTextColorCss(decoration?.textColor);
  return {
    ...(decoration?.color ? { "--wb-tab-database-icon-color": decoration.color } : {}),
    ...(textColor ? { "--wb-tab-database-name-color": textColor } : {}),
  };
}

// Table tabs render as two stacked lines (table name over database name)
// whenever there is a database to show; everything else stays single-line.
function hasTabSubtitle(tab) {
  return isTableLikeTab(tab) && !tab.opening && Boolean(tabDatabaseLabel(tab));
}

function tabSourceTitle(tab) {
  if (tabKind(tab) === "home") return t('m_203c08e0d44a');
  if (tabKind(tab) === "sql-library") return t('m_7eb481889026');
  if (tabKind(tab) === "folders") return `${t('tableFolders.title')}\n${tabDatabaseLabel(tab)}`;
  if (tabKind(tab) === "sql") return tab.filePath || `${tab.connectionId || ""}/${tab.database || ""}`;
  const display = formatTableTabTitle(tab, databaseLabel(tab.connectionId, tab.database));
  const source = `${tab.connectionId || ""}/${tab.database || ""}.${tab.createMode ? (tab.draft?.tableName || "") : tab.tableName}`;
  const detail = display && display !== source ? `${display}\n${source}` : source;
  return tab.opening ? t('m_88ce9bfd24f4', { detail }) : detail;
}

function canCloseTab(tab) {
  return !tab.opening && tabKind(tab) !== "home";
}

function activateTab(tab) {
  if (!tab?.opening) emit("activate-tab", tab.id);
}

// Middle-click closes a tab, as in browsers and editors.
function closeTabFromMiddleClick(tab, event) {
  if (event?.button !== 1 || !canCloseTab(tab)) return;
  event.preventDefault();
  emit("close-tab", tab.id);
}

function tabClass(tab) {
  return {
    active: tab.id === props.activeTabId,
    "is-opening": tab.opening === true,
    "is-design-tab": tabKind(tab) === "design",
    "is-sql-tab": tabKind(tab) === "sql",
    "is-sql-library-tab": tabKind(tab) === "sql-library",
    "is-dirty-tab": tabKind(tab) === "sql" && tab.dirty,
    "can-close-pane": props.canClosePane && tabKind(tab) === "home",
    "is-tab-dragging": tab.id === draggingTabId.value,
    "is-tab-drag-over": tab.id === dragTargetTabId.value,
    "is-showing-shortcut": Boolean(props.showShortcutHints && tabShortcutHint(tab)),
  };
}

const shortcutHintsByTabId = computed(() => {
  const map = new Map();
  for (const hint of assignTabShortcutHints(previewTabs.value)) {
    map.set(hint.tabId, hint);
  }
  return map;
});

function tabShortcutHint(tab) {
  return shortcutHintsByTabId.value.get(tab?.id) || null;
}

function tabShortcutLabel(tab) {
  const hint = tabShortcutHint(tab);
  return hint ? formatShortcutForPlatform(hint.combo) : "";
}

const macosTitlebar = useMacosTitlebarDoubleClick();

async function toggleMaximize() {
  try {
    const win = getCurrentWindow();
    if (await win.isMaximized()) await win.unmaximize();
    else await win.maximize();
  } catch {
    // ignore — window APIs unavailable in non-Tauri context
  }
}

async function minimizeWindow() {
  try {
    await getCurrentWindow().minimize();
  } catch {
    // ignore — window APIs unavailable in non-Tauri context
  }
}

// On macOS the double-click follows the system "title bar double-click"
// setting (zoom / minimize / nothing); elsewhere it always toggles maximize.
function onTabBarDoubleClick() {
  if (macosTitlebar.managed) {
    macosTitlebar.runDoubleClickAction({ minimize: minimizeWindow, zoom: toggleMaximize });
    return;
  }
  void toggleMaximize();
}

const tabListRef = ref(null);
const tabBarRef = ref(null);
const overflowButtonRef = ref(null);
const overflowMenuRef = ref(null);
const availableWidth = ref(0);
const overflowOpen = ref(false);
const overflowStyle = ref({});
const overflowTheme = ref("light");
const tabPartition = computed(() => partitionTabs(previewTabs.value, props.activeTabId, availableWidth.value));
const visibleTabs = computed(() => tabPartition.value.visible);
const overflowTabs = computed(() => tabPartition.value.overflow);
useTabReorderMotion(tabListRef, visibleTabs, draggingTabId);

function closeOverflow(restoreFocus = false) {
  overflowOpen.value = false;
  if (restoreFocus) overflowButtonRef.value?.focus();
}

async function toggleOverflow() {
  if (overflowOpen.value) return closeOverflow();
  const bounds = overflowButtonRef.value?.getBoundingClientRect();
  if (!bounds) return;
  overflowTheme.value = tabBarRef.value?.closest?.("[data-theme]")?.getAttribute("data-theme") || "light";
  overflowStyle.value = {
    top: `${bounds.bottom + 6}px`,
    right: `${Math.max(8, window.innerWidth - bounds.right)}px`,
    maxHeight: `${Math.max(80, window.innerHeight - bounds.bottom - 12)}px`,
  };
  overflowOpen.value = true;
  await nextTick();
  overflowMenuRef.value?.querySelector('button:not(:disabled)')?.focus();
}

async function selectOverflowTab(tab) {
  closeOverflow();
  activateTab(tab);
  await nextTick();
  tabListRef.value?.querySelector('.wb-tab.active')?.focus();
}

function onOverflowKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeOverflow(true);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = [...overflowMenuRef.value.querySelectorAll('button:not(:disabled)')];
  const current = buttons.indexOf(document.activeElement);
  const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[index]?.focus();
}

function dismissOverflow(event) {
  if (!overflowMenuRef.value?.contains(event.target) && !overflowButtonRef.value?.contains(event.target)) closeOverflow();
}

let resizeObserver;
watch(() => props.activeTabId, async (tabId, previousTabId) => {
  const focused = document.activeElement;
  const focusedTab = focused?.closest?.(".wb-tab");
  const shouldMoveFocus = tabListRef.value?.contains(focusedTab)
    && focusedTab?.dataset.tabId === previousTabId;
  closeOverflow();
  if (!shouldMoveFocus) return;
  await nextTick();
  if (props.activeTabId !== tabId) return;
  if (document.activeElement !== focused && document.activeElement !== document.body) return;
  tabListRef.value?.querySelector(".wb-tab.active")?.focus({ preventScroll: true });
});
watch(() => overflowTabs.value.length, (count) => { if (!count) closeOverflow(); });
onMounted(() => {
  resizeObserver = new ResizeObserver(([entry]) => {
    availableWidth.value = Math.max(0, entry.contentRect.width - 16);
    closeOverflow();
  });
  resizeObserver.observe(tabBarRef.value);
  document.addEventListener("pointerdown", dismissOverflow);
  document.addEventListener("focusin", dismissOverflow);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  document.removeEventListener("pointerdown", dismissOverflow);
  document.removeEventListener("focusin", dismissOverflow);
});
</script>

<template>
  <section
    ref="tabBarRef"
    class="wb-object-tabs wb-tabs"
    data-tauri-drag-region
    @contextmenu.prevent.stop="openTabContextMenu"
    @dragover.prevent.stop="markTabbarDragTarget"
    @drop.prevent.stop="dropTabOnBar"
    @dblclick="onTabBarDoubleClick"
  >
    <div ref="tabListRef" class="wb-tab-list" data-tauri-drag-region>
      <div
        v-for="tab in visibleTabs"
        :key="tab.id"
        class="wb-tab"
        :class="tabClass(tab)"
        :data-kind="tabKind(tab)"
        :data-tab-id="tab.id"
        role="button"
        :tabindex="tab.opening ? -1 : 0"
        :aria-disabled="tab.opening ? 'true' : 'false'"
        :draggable="!tab.opening && tabKind(tab) !== 'home'"
        @dragstart.stop="startTabDrag(tab.id, $event)"
        @dragover.prevent.stop="markTabDragTarget(tab.id, $event)"
        @drop.prevent.stop="dropTab(tab.id, $event)"
        @dragend="clearTabDrag"
        @click="activateTab(tab)"
        @mousedown.middle.prevent
        @auxclick="closeTabFromMiddleClick(tab, $event)"
        @contextmenu.prevent.stop="openTabContextMenu($event, tab)"
        @dblclick.stop="copyTabName(tab, $event)"
        @keydown.enter.prevent="activateTab(tab)"
        @keydown.space.prevent="activateTab(tab)"
      >
        <span class="wb-tab-title" :class="{ 'wb-tab-title-stack': hasTabSubtitle(tab) }" :title="tabSourceTitle(tab)">
          <template v-if="hasTabSubtitle(tab)">
            <span class="wb-tab-line wb-tab-line-primary">
              <span class="wb-tab-name">{{ tab.createMode ? (tab.draft?.tableName || t('createTable.title')) : (tab.tableName || tabTitle(tab)) }}</span>
              <small v-if="tabKind(tab) === 'design'" class="wb-tab-kind">{{ t('m_56c255e19858') }}</small>
              <small v-else-if="tab.relationFilter" class="wb-tab-kind">{{ t('relations.tabTag') }}</small>
            </span>
            <span class="wb-tab-line wb-tab-line-secondary" :style="tabDatabaseDecorationStyle(tab)">
              <component
                :is="tabDatabaseIcon(tab)"
                v-if="tabDatabaseDecoration(tab)"
                :size="10"
                :stroke-width="1.5"
                class="wb-tab-db-icon is-decorated"
                aria-hidden="true"
              />
              <svg v-else class="wb-tab-db-icon" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true">
                <ellipse cx="6" cy="2.7" rx="4.1" ry="1.9" />
                <path d="M1.9 2.7v6.6c0 1.05 1.83 1.9 4.1 1.9s4.1-.85 4.1-1.9V2.7" />
                <path d="M1.9 6c0 1.05 1.83 1.9 4.1 1.9s4.1-.85 4.1-1.9" />
              </svg>
              <span class="wb-tab-db">{{ tabDatabaseLabel(tab) }}</span>
            </span>
          </template>
          <template v-else-if="tabKind(tab) === 'home'">
            <House class="wb-tab-home-icon" :size="16" :stroke-width="1.8" aria-hidden="true" />
            <span class="wb-tab-name">{{ tabTitle(tab) }}</span>
          </template>
          <template v-else>
            <span v-if="tab.opening" class="wb-tab-opening-spinner" aria-hidden="true"></span>
            <span class="wb-tab-name">{{ tabTitle(tab) }}</span>
            <small v-if="tab.opening" class="wb-tab-opening-label" aria-live="polite">{{ t('m_48de9f48a703') }}</small>
            <small v-if="tabKind(tab) === 'design'" class="wb-tab-kind">{{ t('m_56c255e19858') }}</small>
            <small v-else-if="tab.relationFilter" class="wb-tab-kind">{{ t('relations.tabTag') }}</small>
            <small v-if="tabKind(tab) === 'sql'" class="wb-tab-kind">SQL{{ tab.dirty ? ' •' : '' }}</small>
            <small v-if="tabKind(tab) === 'sql' && tab.database">{{ databaseLabel(tab.connectionId, tab.database) }}</small>
          </template>
        </span>
        <span
          v-if="showShortcutHints && tabShortcutLabel(tab)"
          class="wb-tab-shortcut-badge"
          aria-hidden="true"
        >{{ tabShortcutLabel(tab) }}</span>
        <button
          v-if="canCloseTab(tab)"
          type="button"
          class="wb-tab-close"
          draggable="false"
          :aria-label="t('m_31ff143e6168')"
          @mousedown.stop="stopTabClosePointer"
          @dragstart.prevent.stop="stopTabClosePointer"
          @click.stop="emit('close-tab', tab.id)"
        >
          <span class="wb-tab-close-mark" aria-hidden="true"></span>
        </button>
        <button
          v-else-if="canClosePane && tabKind(tab) === 'home'"
          type="button"
          class="wb-tab-close wb-pane-close-button"
          draggable="false"
          :aria-label="t('m_fd6f188d325a')"
          :title="t('m_fd6f188d325a')"
          @mousedown.stop="stopTabClosePointer"
          @click.stop="emit('close-pane')"
        >
          <span class="wb-tab-close-mark" aria-hidden="true"></span>
        </button>
      </div>
    </div>
    <button
      v-if="overflowTabs.length"
      ref="overflowButtonRef"
      type="button"
      class="wb-tab-overflow-button"
      :aria-label="t('tabs.overflow', { count: overflowTabs.length })"
      :title="t('tabs.overflow', { count: overflowTabs.length })"
      aria-haspopup="menu"
      :aria-expanded="overflowOpen"
      @click.stop="toggleOverflow"
      @dblclick.stop
      @keydown.down.prevent="toggleOverflow"
      @keydown.esc.stop="closeOverflow(true)"
    >
      <ChevronDown :size="16" aria-hidden="true" />
      <span>{{ overflowTabs.length }}</span>
    </button>
    <Teleport to="body">
      <div
        v-if="overflowOpen"
        class="wb-tab-overflow-layer wb-floating-themed"
        :data-theme="overflowTheme"
      >
        <div
          ref="overflowMenuRef"
          class="wb-tab-overflow-menu"
          :style="overflowStyle"
          role="menu"
          :aria-label="t('tabs.overflow', { count: overflowTabs.length })"
          @keydown="onOverflowKeydown"
          @contextmenu.prevent.stop
        >
          <div class="wb-tab-overflow-head" aria-hidden="true">{{ t('tabs.overflow', { count: overflowTabs.length }) }}</div>
          <div class="wb-tab-overflow-list">
            <button
              v-for="tab in overflowTabs"
              :key="tab.id"
              type="button"
              role="menuitem"
              class="wb-tab-overflow-item"
              :disabled="tab.opening"
              :title="tabSourceTitle(tab)"
              @click="selectOverflowTab(tab)"
            >
              <span class="wb-tab-overflow-line">
                <span class="wb-tab-overflow-name">{{ tabMenuName(tab) }}</span>
                <small v-if="tabMenuTag(tab)" class="wb-tab-overflow-tag">{{ tabMenuTag(tab) }}</small>
              </span>
              <span v-if="tab.database" class="wb-tab-overflow-line wb-tab-overflow-source" :style="tabDatabaseDecorationStyle(tab)">
                <component
                  :is="tabDatabaseIcon(tab)"
                  v-if="tabDatabaseDecoration(tab)"
                  :size="11"
                  :stroke-width="1.6"
                  class="wb-tab-db-icon is-decorated"
                  aria-hidden="true"
                />
                <svg v-else class="wb-tab-db-icon" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true">
                  <ellipse cx="6" cy="2.7" rx="4.1" ry="1.9" />
                  <path d="M1.9 2.7v6.6c0 1.05 1.83 1.9 4.1 1.9s4.1-.85 4.1-1.9V2.7" />
                  <path d="M1.9 6c0 1.05 1.83 1.9 4.1 1.9s4.1-.85 4.1-1.9" />
                </svg>
                <span class="wb-tab-db">{{ tabDatabaseLabel(tab) }}</span>
                <span v-if="tabConnectionLabel(tab)" class="wb-tab-overflow-connection">{{ tabConnectionLabel(tab) }}</span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
