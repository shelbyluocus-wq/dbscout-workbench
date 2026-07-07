<script setup>
import { computed, nextTick, ref, watch } from "vue";

const ROW_HEIGHT = 44;
const BUFFER_ROWS = 8;

const props = defineProps({
  tables: { type: Array, default: () => [] },
  selectedNames: { type: Array, default: () => [] },
  renamingName: { type: String, default: "" },
  renameDraft: { type: String, default: "" },
  readOnly: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits([
  "select-table",
  "open-table",
  "open-design",
  "start-rename",
  "rename-draft",
  "submit-rename",
  "cancel-rename",
  "contextmenu",
  "blank-contextmenu",
  "blank-click",
  "copy",
  "paste",
  "delete",
]);

const scrollerRef = ref(null);
const renameInputRef = ref(null);
const scrollTop = ref(0);
const viewportHeight = ref(520);

const selectedSet = computed(() => new Set(props.selectedNames));
const totalHeight = computed(() => props.tables.length * ROW_HEIGHT);
const visibleRange = computed(() => {
  const total = props.tables.length;
  if (!total) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - BUFFER_ROWS);
  const visibleCount = Math.ceil(viewportHeight.value / ROW_HEIGHT) + BUFFER_ROWS * 2;
  return { start, end: Math.min(total, start + visibleCount) };
});
const visibleRows = computed(() =>
  props.tables.slice(visibleRange.value.start, visibleRange.value.end).map((table, offset) => ({
    table,
    index: visibleRange.value.start + offset,
  })),
);

function tableName(table) {
  return table?.tableName || table?.table_name || "";
}

function tableComment(table) {
  return table?.tableComment || table?.table_comment || "";
}

function onScroll(event) {
  const target = event?.currentTarget;
  if (!target) return;
  scrollTop.value = target.scrollTop;
  viewportHeight.value = target.clientHeight || viewportHeight.value;
}

function select(table, event) {
  emit("select-table", tableName(table), event);
}

function selectForAction(table) {
  const name = tableName(table);
  if (name && !selectedSet.value.has(name)) emit("select-table", name, {});
  return name;
}

function handleRowCopy(table) {
  selectForAction(table);
  emit("copy");
}

function handleRowPaste() {
  emit("paste");
}

function handleRowRename(table) {
  const name = selectForAction(table);
  emit("start-rename", name);
}

function handleRowOpen(table) {
  const name = selectForAction(table);
  if (name) emit("open-table", name);
}

function handleRowDelete(table) {
  selectForAction(table);
  emit("delete");
}

function handleBlankPointer(event) {
  if (event.target === scrollerRef.value) emit("blank-click", event);
}

function handleKeydown(event) {
  const key = String(event.key || "");
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "c") {
    event.preventDefault();
    emit("copy");
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "v") {
    event.preventDefault();
    emit("paste");
    return;
  }
  if (key === "F2") {
    event.preventDefault();
    emit("start-rename");
    return;
  }
  if (key === "Enter") {
    event.preventDefault();
    props.selectedNames.forEach((name) => emit("open-table", name));
    return;
  }
  if (key === "Delete") {
    event.preventDefault();
    emit("delete");
    return;
  }
  if (key === "Escape" && props.renamingName) {
    event.preventDefault();
    emit("cancel-rename");
  }
}

function submitRename() {
  emit("submit-rename", props.renamingName, props.renameDraft);
}

function focusList() {
  scrollerRef.value?.focus?.();
}

watch(
  () => props.renamingName,
  (name) => {
    if (!name) return;
    nextTick(() => {
      renameInputRef.value?.focus?.();
      renameInputRef.value?.select?.();
    });
  },
);

defineExpose({ focusList });
</script>

<template>
  <div
    ref="scrollerRef"
    class="wb-dbhome-object-list"
    tabindex="0"
    role="listbox"
    aria-label="表对象"
    :aria-multiselectable="true"
    @scroll="onScroll"
    @keydown="handleKeydown"
    @pointerdown="handleBlankPointer"
    @contextmenu.prevent="emit('blank-contextmenu', $event)"
  >
    <div v-if="!tables.length" class="wb-dbhome-empty-list">
      <strong>当前数据库暂无表</strong>
      <span>可以从其它数据库复制表后在这里粘贴。</span>
    </div>
    <div v-else class="wb-dbhome-virtual" :style="{ height: `${totalHeight}px` }">
      <div class="wb-dbhome-virtual-window" :style="{ transform: `translateY(${visibleRange.start * ROW_HEIGHT}px)` }">
        <button
          v-for="{ table } in visibleRows"
          :key="tableName(table)"
          type="button"
          class="wb-dbhome-object-row"
          :class="{ 'is-selected': selectedSet.has(tableName(table)), 'is-renaming': renamingName === tableName(table) }"
          role="option"
          :aria-selected="selectedSet.has(tableName(table)) ? 'true' : 'false'"
          :data-table-name="tableName(table)"
          @click="select(table, $event)"
          @dblclick="emit('open-table', tableName(table))"
          @contextmenu.prevent.stop="emit('contextmenu', $event, tableName(table))"
          @keydown.ctrl.c.prevent.stop="handleRowCopy(table)"
          @keydown.meta.c.prevent.stop="handleRowCopy(table)"
          @keydown.ctrl.v.prevent.stop="handleRowPaste"
          @keydown.meta.v.prevent.stop="handleRowPaste"
          @keydown.f2.prevent.stop="handleRowRename(table)"
          @keydown.enter.prevent.stop="handleRowOpen(table)"
          @keydown.delete.prevent.stop="handleRowDelete(table)"
        >
          <span class="wb-dbhome-object-icon" aria-hidden="true"></span>
          <span class="wb-dbhome-object-main">
            <input
              v-if="renamingName === tableName(table)"
              ref="renameInputRef"
              class="wb-dbhome-rename-input"
              :value="renameDraft"
              :disabled="busy || readOnly"
              @input="emit('rename-draft', $event.target.value)"
              @keydown.enter.prevent.stop="submitRename"
              @keydown.esc.prevent.stop="emit('cancel-rename')"
              @click.stop
              @dblclick.stop
            />
            <span v-else class="wb-dbhome-object-name">{{ tableName(table) }}</span>
            <span class="wb-dbhome-object-comment">{{ tableComment(table) || "无备注" }}</span>
          </span>
          <span class="wb-dbhome-object-meta">
            <span v-if="table.columnCount != null">{{ table.columnCount }} 字段</span>
            <span v-if="readOnly" class="wb-dbhome-readonly">只读</span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
