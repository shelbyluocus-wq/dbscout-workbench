<script setup>
import { computed, onBeforeUnmount, ref, toRef } from "vue";
import { useActivityRailSort } from "../composables/useActivityRailSort.js";
import { retainPointerActivationChrome } from "../pointerActivationChrome.js";
import WorkbenchMoreMenu from "./WorkbenchMoreMenu.vue";
import WorkbenchActivityRailButton from "./WorkbenchActivityRailButton.vue";

const props = defineProps({
  leadItems: { type: Array, default: () => [] },
  items: { type: Array, default: () => [] },
  bottomItems: { type: Array, default: () => [] },
  label: { type: String, default: "" },
  moreItem: { type: Object, default: null },
  theme: { type: String, default: "light" },
  moreActions: { type: Array, default: () => [] },
});

const emit = defineEmits(["select", "reorder", "more-open", "more-select"]);

const sortGroupRef = ref(null);
const sort = useActivityRailSort({
  items: toRef(props, "items"),
  container: sortGroupRef,
  onReorder: ({ sourceId, targetId, position }) => emit("reorder", sourceId, targetId, { position }),
});

onBeforeUnmount(sort.dispose);

const sortPhase = computed(() => sort.phase.value);
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
      'is-sorting': sortPhase === 'dragging' || sortPhase === 'settling',
      'is-sort-resetting': sortPhase === 'resetting',
    }"
    :aria-label="label"
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
