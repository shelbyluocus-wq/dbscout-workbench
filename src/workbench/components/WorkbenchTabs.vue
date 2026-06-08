<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { previewDragOrder, resolvePreviewDropTarget, sameDragTarget } from "../sidebarDragPreview.js";

const props = defineProps({
  tabs: { type: Array, default: () => [] },
  activeTabId: { type: String, default: "" },
  paneId: { type: String, default: "" },
});

const emit = defineEmits(["activate-tab", "close-tab", "tab-contextmenu", "reorder-tab"]);

const tabBarRef = ref(null);
const draggingTabId = ref("");
const dragTargetTabId = ref("");
const dragTargetPosition = ref("before");
const reduceMotionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");

const previewTabs = computed(() => {
  if (!draggingTabId.value || !dragTargetTabId.value) return props.tabs;
  return previewDragOrder(props.tabs, draggingTabId.value, dragTargetTabId.value, {
    position: dragTargetPosition.value,
    getKey: (tab) => tab.id,
  });
});

function openTabContextMenu(event) {
  if (props.tabs.length === 0) return;
  emit("tab-contextmenu", { x: event.clientX, y: event.clientY });
}

function tabDropPosition(event) {
  const rect = event?.currentTarget?.getBoundingClientRect?.();
  if (!rect) return "before";
  return event.clientX > rect.left + rect.width / 2 ? "after" : "before";
}

function startTabDrag(tabId, event) {
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
  const sourceId = draggedTabId(event);
  if (!sourceId || sourceId === tabId) return;
  const position = tabDropPosition(event);
  if (event?.dataTransfer) event.dataTransfer.dropEffect = "move";
  if (sameDragTarget({ kind: "tab", id: dragTargetTabId.value, position: dragTargetPosition.value }, "tab", tabId, position)) return;
  dragTargetTabId.value = tabId;
  dragTargetPosition.value = position;
}

function dropTab(tabId, event) {
  const sourceId = draggedTabId(event);
  if (sourceId) {
    const fallbackPosition = dragTargetTabId.value === tabId ? dragTargetPosition.value : tabDropPosition(event);
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

function tabKind(tab) {
  return tab.kind === "design" ? "design" : "data";
}

function tabClass(tab) {
  return {
    active: tab.id === props.activeTabId,
    "is-design-tab": tabKind(tab) === "design",
    "is-tab-dragging": tab.id === draggingTabId.value,
    "is-tab-drag-over": tab.id === dragTargetTabId.value,
  };
}

watch(
  () => props.activeTabId,
  async () => {
    await nextTick();
    const activeTab = tabBarRef.value?.querySelector(".wb-tab.active");
    activeTab?.scrollIntoView({
      behavior: reduceMotionQuery?.matches ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  },
);
</script>

<template>
  <section
    class="wb-object-tabs wb-tabs"
    ref="tabBarRef"
    @contextmenu.prevent.stop="openTabContextMenu"
    @dragover.prevent.stop="markTabbarDragTarget"
    @drop.prevent.stop="dropTabOnBar"
  >
    <TransitionGroup name="wb-tab-reorder" tag="div" class="wb-tab-list">
      <div
        v-for="tab in previewTabs"
        :key="tab.id"
        class="wb-tab"
        :class="tabClass(tab)"
        :data-kind="tabKind(tab)"
        role="button"
        tabindex="0"
        draggable="true"
        @dragstart.stop="startTabDrag(tab.id, $event)"
        @dragover.prevent.stop="markTabDragTarget(tab.id, $event)"
        @drop.prevent.stop="dropTab(tab.id, $event)"
        @dragend="clearTabDrag"
        @click="emit('activate-tab', tab.id)"
        @keydown.enter.prevent="emit('activate-tab', tab.id)"
        @keydown.space.prevent="emit('activate-tab', tab.id)"
      >
        <span class="wb-object-icon" data-kind="table"></span>
        <span class="wb-tab-title" :title="`${tab.connectionId || ''}/${tab.database || ''}.${tab.tableName}`">
          {{ tab.tableName }}
          <small v-if="tabKind(tab) === 'design'" class="wb-tab-kind">设计</small>
          <small v-if="tab.database">{{ tab.database }}</small>
        </span>
        <button
          type="button"
          class="wb-tab-close"
          draggable="false"
          aria-label="关闭表标签"
          @mousedown.stop="stopTabClosePointer"
          @dragstart.prevent.stop="stopTabClosePointer"
          @click.stop="emit('close-tab', tab.id)"
        >×</button>
      </div>
    </TransitionGroup>
  </section>
</template>
