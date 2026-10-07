<script setup>
import { computed, ref } from "vue";
import { previewDragOrder, sameDragTarget } from "../sidebarDragPreview.js";

const props = defineProps({
  items: { type: Array, default: () => [] },
  bottomItems: { type: Array, default: () => [] },
  label: { type: String, default: "" },
});

const emit = defineEmits(["select", "reorder"]);

function hintId(item) {
  return `wb-activity-rail-hint-${item.id}`;
}

const draggingId = ref("");
const dropTargetId = ref("");
const dropPosition = ref("before");

// Buttons slide into their drop position live, matching the pane tab strip's
// drag preview behavior.
const previewItems = computed(() => {
  if (!draggingId.value || !dropTargetId.value) return props.items;
  return previewDragOrder(props.items, draggingId.value, dropTargetId.value, {
    position: dropPosition.value,
    getKey: (item) => item.id,
  });
});

function clearDrag() {
  draggingId.value = "";
  dropTargetId.value = "";
  dropPosition.value = "before";
}

function startItemDrag(item, event) {
  draggingId.value = item.id;
  dropTargetId.value = "";
  dropPosition.value = "before";
  if (!event?.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-dbscout-rail-entry", item.id);
  event.dataTransfer.setData("text/plain", item.id);
}

function railDropPosition(event) {
  const rect = event?.currentTarget?.getBoundingClientRect?.();
  if (!rect) return "before";
  return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
}

function markItemDragTarget(item, event) {
  if (!draggingId.value) return;
  event.preventDefault();
  event.stopPropagation();
  if (draggingId.value === item.id) return;
  const position = railDropPosition(event);
  if (event?.dataTransfer) event.dataTransfer.dropEffect = "move";
  if (sameDragTarget({ kind: "rail", id: dropTargetId.value, position: dropPosition.value }, "rail", item.id, position)) return;
  dropTargetId.value = item.id;
  dropPosition.value = position;
}

function markRailDragOver(event) {
  if (!draggingId.value) return;
  event.preventDefault();
}

function dropOnItem(item, event) {
  if (!draggingId.value) return;
  event.preventDefault();
  event.stopPropagation();
  if (draggingId.value !== item.id) {
    const position = dropTargetId.value === item.id ? dropPosition.value : railDropPosition(event);
    emit("reorder", { sourceId: draggingId.value, targetId: item.id, position });
  }
  clearDrag();
}

function dropOnRailTail(event) {
  if (!draggingId.value) return;
  event.preventDefault();
  // Only gaps landing on the nav itself count; separators and the pinned
  // bottom zone stay inert.
  if (event?.target === event?.currentTarget) {
    const siblings = [...event.currentTarget.children];
    let targetId = "";
    let position = "after";
    for (const el of siblings) {
      const id = el?.dataset?.wbRailId;
      if (!id) continue;
      const rect = el.getBoundingClientRect();
      targetId = id;
      if (event.clientY < rect.top + rect.height / 2) {
        position = "before";
        break;
      }
    }
    if (targetId && targetId !== draggingId.value) {
      emit("reorder", { sourceId: draggingId.value, targetId, position });
    }
  }
  clearDrag();
}
</script>

<template>
  <nav
    class="wb-activity-rail"
    :aria-label="label"
    @dragover="markRailDragOver"
    @drop="dropOnRailTail"
  >
    <template v-for="(item, index) in previewItems" :key="item.id">
      <span v-if="item.separatorBefore && index > 0" class="wb-activity-rail-separator" aria-hidden="true"></span>
      <button
        type="button"
        class="wb-activity-rail-btn"
        :class="{ 'is-rail-dragging': item.id === draggingId }"
        :aria-label="item.label"
        :aria-describedby="item.hint ? hintId(item) : undefined"
        :aria-keyshortcuts="item.ariaShortcut || undefined"
        :aria-haspopup="item.popup || undefined"
        :aria-expanded="item.expanded"
        :aria-controls="item.controls || undefined"
        :data-wb-rail-id="item.id"
        draggable="true"
        @dragstart.stop="startItemDrag(item, $event)"
        @dragover="markItemDragTarget(item, $event)"
        @drop="dropOnItem(item, $event)"
        @dragend="clearDrag"
        @click="emit('select', item.id, $event)"
      >
        <component :is="item.icon" :size="18" :stroke-width="1.6" aria-hidden="true" />
        <span class="wb-activity-rail-tip" aria-hidden="true">
          <span class="wb-activity-rail-tip-title">
            <strong>{{ item.label }}</strong>
            <kbd v-if="item.shortcutLabel">{{ item.shortcutLabel }}</kbd>
          </span>
          <span v-if="item.hint" :id="hintId(item)" class="wb-activity-rail-tip-hint">{{ item.hint }}</span>
        </span>
      </button>
    </template>

    <div v-if="bottomItems.length" class="wb-activity-rail-bottom">
      <button
        v-for="item in bottomItems"
        :key="item.id"
        type="button"
        class="wb-activity-rail-btn"
        :aria-label="item.label"
        :aria-describedby="item.hint ? hintId(item) : undefined"
        :aria-keyshortcuts="item.ariaShortcut || undefined"
        :aria-haspopup="item.popup || undefined"
        :aria-expanded="item.expanded"
        :aria-controls="item.controls || undefined"
        :data-wb-rail-id="item.id"
        @click="emit('select', item.id, $event)"
      >
        <component :is="item.icon" :size="18" :stroke-width="1.6" aria-hidden="true" />
        <span class="wb-activity-rail-tip" aria-hidden="true">
          <span class="wb-activity-rail-tip-title">
            <strong>{{ item.label }}</strong>
            <kbd v-if="item.shortcutLabel">{{ item.shortcutLabel }}</kbd>
          </span>
          <span v-if="item.hint" :id="hintId(item)" class="wb-activity-rail-tip-hint">{{ item.hint }}</span>
        </span>
      </button>
    </div>
  </nav>
</template>
