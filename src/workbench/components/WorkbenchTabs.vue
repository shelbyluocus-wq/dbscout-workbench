<script setup>
import { computed, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { previewDragOrder, resolvePreviewDropTarget, sameDragTarget } from "../sidebarDragPreview.js";
import { useAliases } from "../composables/aliasStore.js";
import { formatTableTabTitle } from "../utils/tabDisplay.js";

const props = defineProps({
  tabs: { type: Array, default: () => [] },
  activeTabId: { type: String, default: "" },
  paneId: { type: String, default: "" },
  canClosePane: { type: Boolean, default: false },
});

const emit = defineEmits(["activate-tab", "close-tab", "close-pane", "tab-contextmenu", "reorder-tab", "copy-tab-name"]);

const { databaseLabel } = useAliases();

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
  if (props.tabs.find((tab) => tab.id === tabId)?.opening) return;
  draggingTabId.value = tabId;
  dragTargetTabId.value = "";
  dragTargetPosition.value = "before";
  if (!event?.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
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
  if (tabKind(tab) === "home") return "首页";
  if (tabKind(tab) === "sql-library") return "SQL 查询";
  if (tabKind(tab) === "sql") return tab.title || tab.fileName || "SQL 查询";
  return formatTableTabTitle(tab, databaseLabel(tab.connectionId, tab.database));
}

function isTableLikeTab(tab) {
  const kind = tabKind(tab);
  return kind === "data" || kind === "design";
}

function tabDatabaseLabel(tab) {
  return databaseLabel(tab.connectionId, tab.database) || String(tab.database || "");
}

// Table tabs render as two stacked lines (table name over database name)
// whenever there is a database to show; everything else stays single-line.
function hasTabSubtitle(tab) {
  return isTableLikeTab(tab) && !tab.opening && Boolean(tabDatabaseLabel(tab));
}

function tabSourceTitle(tab) {
  if (tabKind(tab) === "home") return "首页";
  if (tabKind(tab) === "sql-library") return "SQL 查询文档";
  if (tabKind(tab) === "sql") return tab.filePath || `${tab.connectionId || ""}/${tab.database || ""}`;
  const display = formatTableTabTitle(tab, databaseLabel(tab.connectionId, tab.database));
  const source = `${tab.connectionId || ""}/${tab.database || ""}.${tab.tableName}`;
  const detail = display && display !== source ? `${display}\n${source}` : source;
  return tab.opening ? `${detail} · 正在打开` : detail;
}

function canCloseTab(tab) {
  return !tab.opening && tabKind(tab) !== "home";
}

function activateTab(tab) {
  if (!tab?.opening) emit("activate-tab", tab.id);
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
  };
}

async function toggleMaximize() {
  try {
    const win = getCurrentWindow();
    if (await win.isMaximized()) await win.unmaximize();
    else await win.maximize();
  } catch {
    // ignore — window APIs unavailable in non-Tauri context
  }
}

</script>

<template>
  <section
    ref="tabBarRef"
    class="wb-object-tabs wb-tabs"
    data-tauri-drag-region
    @contextmenu.prevent.stop="openTabContextMenu"
    @dragover.prevent.stop="markTabbarDragTarget"
    @drop.prevent.stop="dropTabOnBar"
    @dblclick="toggleMaximize"
  >
    <TransitionGroup name="wb-tab-reorder" tag="div" class="wb-tab-list" data-tauri-drag-region>
      <div
        v-for="tab in previewTabs"
        :key="tab.id"
        class="wb-tab"
        :class="tabClass(tab)"
        :data-kind="tabKind(tab)"
        role="button"
        :tabindex="tab.opening ? -1 : 0"
        :aria-disabled="tab.opening ? 'true' : 'false'"
        :draggable="!tab.opening && tabKind(tab) !== 'home'"
        @dragstart.stop="startTabDrag(tab.id, $event)"
        @dragover.prevent.stop="markTabDragTarget(tab.id, $event)"
        @drop.prevent.stop="dropTab(tab.id, $event)"
        @dragend="clearTabDrag"
        @click="activateTab(tab)"
        @contextmenu.prevent.stop="openTabContextMenu($event, tab)"
        @dblclick.stop="copyTabName(tab, $event)"
        @keydown.enter.prevent="activateTab(tab)"
        @keydown.space.prevent="activateTab(tab)"
      >
        <span class="wb-tab-title" :class="{ 'wb-tab-title-stack': hasTabSubtitle(tab) }" :title="tabSourceTitle(tab)">
          <template v-if="hasTabSubtitle(tab)">
            <span class="wb-tab-line wb-tab-line-primary">
              <span class="wb-tab-name">{{ tab.tableName || tabTitle(tab) }}</span>
              <small v-if="tabKind(tab) === 'design'" class="wb-tab-kind">设计</small>
            </span>
            <span class="wb-tab-line wb-tab-line-secondary">
              <svg class="wb-tab-db-icon" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true">
                <ellipse cx="6" cy="2.7" rx="4.1" ry="1.9" />
                <path d="M1.9 2.7v6.6c0 1.05 1.83 1.9 4.1 1.9s4.1-.85 4.1-1.9V2.7" />
                <path d="M1.9 6c0 1.05 1.83 1.9 4.1 1.9s4.1-.85 4.1-1.9" />
              </svg>
              <span class="wb-tab-db">{{ tabDatabaseLabel(tab) }}</span>
            </span>
          </template>
          <template v-else>
            <span v-if="tab.opening" class="wb-tab-opening-spinner" aria-hidden="true"></span>
            <span class="wb-tab-name">{{ tabTitle(tab) }}</span>
            <small v-if="tab.opening" class="wb-tab-opening-label" aria-live="polite">正在打开</small>
            <small v-if="tabKind(tab) === 'design'" class="wb-tab-kind">设计</small>
            <small v-if="tabKind(tab) === 'sql'" class="wb-tab-kind">SQL{{ tab.dirty ? ' •' : '' }}</small>
            <small v-if="tabKind(tab) === 'sql' && tab.database">{{ databaseLabel(tab.connectionId, tab.database) }}</small>
          </template>
        </span>
        <button
          v-if="canCloseTab(tab)"
          type="button"
          class="wb-tab-close"
          draggable="false"
          aria-label="关闭表标签"
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
          aria-label="关闭当前分屏"
          title="关闭当前分屏"
          @mousedown.stop="stopTabClosePointer"
          @click.stop="emit('close-pane')"
        >
          <span class="wb-tab-close-mark" aria-hidden="true"></span>
        </button>
      </div>
    </TransitionGroup>
  </section>
</template>
