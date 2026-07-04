<script setup>
import { nextTick, ref, watch } from "vue";

const props = defineProps({
  visible: { type: Boolean, default: false },
  databases: { type: Array, default: () => [] },
  selectedDatabase: { type: String, default: "" },
  connectionLabel: { type: String, default: "" },
  // 定位锚点：展开按钮的 DOM 元素，浮层附在其右下
  anchor: { type: Object, default: null },
});

const emit = defineEmits([
  "update:visible",
  "select-database",
  "expand",
]);

const popoverRef = ref(null);

// 取锚点位置，浮层定位到锚点右侧（收起态按钮在左上角，右侧空间充足）
function anchorRect() {
  const el = props.anchor;
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  return el.getBoundingClientRect();
}

function popoverStyle() {
  const rect = anchorRect();
  if (!rect) return {};
  // 紧贴按钮右侧、垂直对齐按钮顶部。按钮是 32px 方块，留 6px 间隙。
  return {
    left: `${rect.right + 6}px`,
    top: `${rect.top}px`,
  };
}

watch(
  () => props.visible,
  async (open) => {
    if (open) {
      await nextTick();
      // 浮层出现时无需聚焦（鼠标驱动），仅确保可访问性
    }
  },
);

function select(database) {
  if (!database) return;
  emit("select-database", database);
  emit("update:visible", false);
}

function expand() {
  emit("expand");
  emit("update:visible", false);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="popoverRef"
      class="wb-sidebar-expand-popover"
      role="dialog"
      aria-label="切换数据库"
      :style="popoverStyle()"
      @mousedown.stop
    >
      <header class="wb-sidebar-expand-popover-header">
        <span class="wb-sidebar-expand-popover-conn" :title="connectionLabel">
          {{ connectionLabel || "当前连接" }}
        </span>
        <button
          type="button"
          class="wb-sidebar-expand-popover-expand"
          title="展开数据库栏"
          @click="expand"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <polyline points="3,2 7,6 3,10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </header>
      <ul class="wb-sidebar-expand-popover-list" role="listbox" aria-label="数据库列表">
        <li
          v-for="db in databases"
          :key="db"
          role="option"
          :aria-selected="db === selectedDatabase ? 'true' : 'false'"
          class="wb-sidebar-expand-popover-item"
          :class="{ 'is-selected': db === selectedDatabase }"
          :title="db"
          @click="select(db)"
        >
          <span class="wb-sidebar-expand-popover-db-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3">
              <ellipse cx="7" cy="3.2" rx="4.5" ry="1.6" />
              <path d="M2.5 3.2v7.6c0 .9 2 1.6 4.5 1.6s4.5-.7 4.5-1.6V3.2" />
              <path d="M2.5 7c0 .9 2 1.6 4.5 1.6s4.5-.7 4.5-1.6" />
            </svg>
          </span>
          <span class="wb-sidebar-expand-popover-db-name">{{ db }}</span>
        </li>
        <li v-if="!databases.length" class="wb-sidebar-expand-popover-empty">
          暂无数据库
        </li>
      </ul>
    </div>
  </Teleport>
</template>
