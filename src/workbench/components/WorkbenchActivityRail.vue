<script setup>
import { computed, onBeforeUnmount, ref, toRef, watch } from "vue";
import { useActivityRailSort } from "../composables/useActivityRailSort.js";
import { retainPointerActivationChrome } from "../pointerActivationChrome.js";
import { activeDatabaseDrag, readDatabaseDrop } from "../utils/databaseDragPayload.js";
import WorkbenchMoreMenu from "./WorkbenchMoreMenu.vue";
import WorkbenchActivityRailButton from "./WorkbenchActivityRailButton.vue";
import WorkbenchRailDatabaseGroup from "./WorkbenchRailDatabaseGroup.vue";

const props = defineProps({
  leadItems: { type: Array, default: () => [] },
  items: { type: Array, default: () => [] },
  bottomItems: { type: Array, default: () => [] },
  label: { type: String, default: "" },
  moreItem: { type: Object, default: null },
  theme: { type: String, default: "light" },
  moreActions: { type: Array, default: () => [] },
  databaseItems: { type: Array, default: () => [] },
  databaseLayout: { type: Array, default: () => [] },
  databaseGroups: { type: Array, default: () => [] },
  databaseLabel: { type: String, default: "" },
});

const emit = defineEmits([
  "select",
  "reorder",
  "more-open",
  "more-select",
  "database-select",
  "database-reorder",
  "database-drop",
  "database-unpin",
  "database-appearance",
  "database-appearance-reset",
  "database-group-create",
  "database-group-move",
  "database-group-rename",
  "database-group-dissolve",
  "database-group-reorder",
]);

const sortGroupRef = ref(null);
const sort = useActivityRailSort({
  items: toRef(props, "items"),
  container: sortGroupRef,
  onReorder: ({ sourceId, targetId, position }) => emit("reorder", sourceId, targetId, { position }),
});

onBeforeUnmount(sort.dispose);

const sortPhase = computed(() => sort.phase.value);
const databaseSortPhase = ref("idle");
const dropHover = ref(false);
const pendingDrop = activeDatabaseDrag;

function onRailDragOver(event) {
  if (!pendingDrop.value) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  dropHover.value = true;
}

function onRailDragLeave(event) {
  if (event.relatedTarget && event.currentTarget?.contains?.(event.relatedTarget)) return;
  const rect = event.currentTarget?.getBoundingClientRect?.();
  if (
    rect
    && event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom
  ) return;
  dropHover.value = false;
}

function onRailDrop(event) {
  const payload = readDatabaseDrop(event);
  if (!payload) return;
  event.preventDefault();
  dropHover.value = false;
  emit("database-drop", payload);
}

watch(pendingDrop, (value) => {
  if (!value) dropHover.value = false;
});

const pointerActivatedIds = ref(new Set());

function pointerActivated(item) {
  return pointerActivatedIds.value.has(item.id);
}

function retainPointerChrome(item, event) {
  const retained = retainPointerActivationChrome(event, () => {
    if (!pointerActivatedIds.value.has(item.id)) return;
    const next = new Set(pointerActivatedIds.value);
    next.delete(item.id);
    pointerActivatedIds.value = next;
  });
  if (!retained) return;
  const next = new Set(pointerActivatedIds.value);
  next.add(item.id);
  pointerActivatedIds.value = next;
}

function selectItem(item, event) {
  retainPointerChrome(item, event);
  emit("select", item.id, event);
}

function selectSortable(item, event) {
  retainPointerChrome(item, event);
  if (sort.consumeClick()) return;
  emit("select", item.id, event);
}

function sortableClass(item) {
  return {
    "is-rail-dragging": sort.isLifted(item),
    "is-rail-settling": sort.isSettling(item),
    "is-pointer-activated": pointerActivated(item),
  };
}

function sortableStyle(item, index) {
  const shift = sort.shiftFor(item, index);
  return shift ? { "--wb-rail-sort-shift": `${shift}px` } : undefined;
}
</script>

<template>
  <nav
    class="wb-activity-rail"
    :class="{
      'is-sorting':
        sortPhase === 'dragging' || sortPhase === 'settling'
        || databaseSortPhase === 'dragging' || databaseSortPhase === 'settling',
      'is-sort-resetting': sortPhase === 'resetting' || databaseSortPhase === 'resetting',
    }"
    :aria-label="label"
    @dragover="onRailDragOver"
    @dragleave="onRailDragLeave"
    @drop="onRailDrop"
  >
    <WorkbenchActivityRailButton
      v-for="item in leadItems"
      :key="item.id"
      :item="item"
      :class="{ 'is-pointer-activated': pointerActivated(item) }"
      @click="selectItem(item, $event)"
    />

    <span v-if="leadItems.length && items.length" class="wb-activity-rail-separator" aria-hidden="true"></span>

    <div ref="sortGroupRef" class="wb-activity-rail-group">
      <WorkbenchActivityRailButton
        v-for="(item, index) in items"
        :key="item.id"
        :item="item"
        class="is-sortable"
        :class="sortableClass(item)"
        :style="sortableStyle(item, index)"
        :data-wb-rail-sort-id="item.id"
        @pointerdown="sort.onPointerDown(item, $event)"
        @keydown.alt.up.prevent="sort.moveByKeyboard(item, -1)"
        @keydown.alt.down.prevent="sort.moveByKeyboard(item, 1)"
        @click="selectSortable(item, $event)"
      />
    </div>

    <WorkbenchMoreMenu v-if="moreItem" :item="moreItem" :actions="moreActions" :theme="theme"
      @open="emit('more-open')" @select="emit('more-select', $event)" />

    <WorkbenchRailDatabaseGroup
      :items="databaseItems"
      :layout="databaseLayout"
      :groups="databaseGroups"
      :label="databaseLabel"
      :theme="theme"
      :pending-drop="pendingDrop"
      :drop-hover="dropHover"
      @select="(item, $event) => emit('database-select', item, $event)"
      @reorder="(sourceId, targetId, options) => emit('database-reorder', sourceId, targetId, options)"
      @unpin="(item) => emit('database-unpin', item)"
      @appearance="(payload) => emit('database-appearance', payload)"
      @appearance-reset="(item) => emit('database-appearance-reset', item)"
      @drop="(payload) => { dropHover = false; emit('database-drop', payload); }"
      @group-create="(item) => emit('database-group-create', item)"
      @group-move="(item, groupId) => emit('database-group-move', item, groupId)"
      @group-rename="(groupId, name) => emit('database-group-rename', groupId, name)"
      @group-dissolve="(groupId) => emit('database-group-dissolve', groupId)"
      @group-reorder="(groupId, sourceId, targetId, options) => emit('database-group-reorder', groupId, sourceId, targetId, options)"
      @sort-phase="(phase) => { databaseSortPhase = phase; }"
    />

    <div v-if="bottomItems.length" class="wb-activity-rail-bottom">
      <WorkbenchActivityRailButton
        v-for="item in bottomItems"
        :key="item.id"
        :item="item"
        :class="{ 'is-pointer-activated': pointerActivated(item) }"
        @click="selectItem(item, $event)"
      />
    </div>
  </nav>
</template>
