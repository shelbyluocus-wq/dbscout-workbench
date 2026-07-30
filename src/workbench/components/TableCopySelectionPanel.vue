<script setup>
import { Check, ListChecks, X } from "lucide-vue-next";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";

const props = defineProps({
  tables: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits(["remove", "clear"]);

const viewportRef = ref(null);
const scrollTop = ref(0);
const viewportHeight = ref(360);
const ITEM_HEIGHT = 30;
const BUFFER = 5;

const totalHeight = computed(() => props.tables.length * ITEM_HEIGHT);
const virtualWindow = computed(() => {
  const total = props.tables.length;
  const height = viewportHeight.value || 360;
  let start = Math.floor(scrollTop.value / ITEM_HEIGHT) - BUFFER;
  let end = Math.ceil((scrollTop.value + height) / ITEM_HEIGHT) + BUFFER;
  start = Math.max(0, start);
  end = Math.min(total, end);
  return { start, end, total };
});
const visibleRows = computed(() =>
  props.tables.slice(virtualWindow.value.start, virtualWindow.value.end)
);

let rafId = 0;
function onScroll() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (viewportRef.value) scrollTop.value = viewportRef.value.scrollTop;
  });
}

function clampScrollPosition() {
  const viewport = viewportRef.value;
  if (!viewport) return;
  const maxScrollTop = Math.max(0, totalHeight.value - viewport.clientHeight);
  if (viewport.scrollTop > maxScrollTop) viewport.scrollTop = maxScrollTop;
  scrollTop.value = viewport.scrollTop;
}

let resizeObserver = null;
function observeViewport(element) {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (!element) return;
  viewportHeight.value = element.clientHeight || 360;
  scrollTop.value = element.scrollTop || 0;
  resizeObserver = new ResizeObserver(() => {
    viewportHeight.value = element.clientHeight || 360;
    clampScrollPosition();
  });
  resizeObserver.observe(element);
}

onMounted(() => nextTick(() => observeViewport(viewportRef.value)));

onBeforeUnmount(() => {
  if (resizeObserver) resizeObserver.disconnect();
  if (rafId) cancelAnimationFrame(rafId);
});

watch(viewportRef, (element) => observeViewport(element));
watch(
  () => props.tables.length,
  () => nextTick(clampScrollPosition)
);
</script>

<template>
  <section class="wb-table-copy-selection-panel" aria-labelledby="wb-table-copy-selection-title">
    <header class="wb-table-copy-selection-header">
      <div class="wb-table-copy-selection-title">
        <strong id="wb-table-copy-selection-title">已选表</strong>
        <span aria-live="polite">{{ tables.length }}</span>
      </div>
      <button
        type="button"
        class="wb-table-copy-selection-clear"
        :disabled="busy || tables.length === 0"
        @click="emit('clear')"
      >
        清空
      </button>
    </header>

    <p class="wb-table-copy-selection-hint">发送前可在这里核对或移除。</p>

    <div
      v-if="tables.length"
      ref="viewportRef"
      class="wb-table-copy-selection-list"
      role="list"
      aria-label="当前已选择的表"
      @scroll.passive="onScroll"
    >
      <div class="wb-table-copy-selection-virtual" :style="{ height: totalHeight + 'px' }">
        <div
          v-if="virtualWindow.start > 0"
          :style="{ height: virtualWindow.start * ITEM_HEIGHT + 'px', flexShrink: 0 }"
        />

        <div
          v-for="table in visibleRows"
          :key="table.name"
          class="wb-table-copy-selection-row"
          role="listitem"
        >
          <Check :size="13" :stroke-width="2.2" aria-hidden="true" />
          <span :title="table.name">{{ table.name }}</span>
          <button
            type="button"
            :disabled="busy"
            :aria-label="`从已选表中移除 ${table.name}`"
            :title="`移除 ${table.name}`"
            @click="emit('remove', table.name)"
          >
            <X :size="13" aria-hidden="true" />
          </button>
        </div>

        <div
          v-if="virtualWindow.end < virtualWindow.total"
          :style="{ height: (virtualWindow.total - virtualWindow.end) * ITEM_HEIGHT + 'px', flexShrink: 0 }"
        />
      </div>
    </div>

    <div v-else class="wb-table-copy-selection-empty" role="status">
      <ListChecks :size="24" aria-hidden="true" />
      <strong>尚未选择表</strong>
      <span>从左侧勾选后，表名会显示在这里。</span>
    </div>
  </section>
</template>
