<script setup>
import { computed, onBeforeUnmount, ref, toRef } from "vue";
import { useActivityRailSort } from "../composables/useActivityRailSort.js";
import WorkbenchActivityRailButton from "./WorkbenchActivityRailButton.vue";

const props = defineProps({
  leadItems: { type: Array, default: () => [] },
  items: { type: Array, default: () => [] },
  bottomItems: { type: Array, default: () => [] },
  label: { type: String, default: "" },
});

const emit = defineEmits(["select", "reorder"]);

const sortGroupRef = ref(null);
const sort = useActivityRailSort({
  items: toRef(props, "items"),
  container: sortGroupRef,
  onReorder: ({ sourceId, targetId, position }) => emit("reorder", sourceId, targetId, { position }),
});

onBeforeUnmount(sort.dispose);

const sortPhase = computed(() => sort.phase.value);

function selectSortable(item, event) {
  if (sort.consumeClick()) return;
  emit("select", item.id, event);
}

function sortableClass(item) {
  return {
    "is-rail-dragging": sort.isLifted(item),
    "is-rail-settling": sort.isSettling(item),
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
      @click="emit('select', item.id, $event)"
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

    <div v-if="bottomItems.length" class="wb-activity-rail-bottom">
      <WorkbenchActivityRailButton
        v-for="item in bottomItems"
        :key="item.id"
        :item="item"
        @click="emit('select', item.id, $event)"
      />
    </div>
  </nav>
</template>
