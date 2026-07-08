<script setup>
import { computed, nextTick, reactive, ref, watch } from "vue";

const ROW_HEIGHT = 44;
const BUFFER_ROWS = 8;
const MIN_WIDTHS = Object.freeze({ name: 180, comment: 160, fields: 92 });
const MAX_WIDTHS = Object.freeze({ name: 420, comment: 360, fields: 128 });

const props = defineProps({
  tables: { type: Array, default: () => [] },
  selectedNames: { type: Array, default: () => [] },
  renamingName: { type: String, default: "" },
  renameDraft: { type: String, default: "" },
  sortState: { type: Object, default: () => ({ column: "name", direction: "asc" }) },
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
  "sort-column",
  "replace-selection",
]);

const scrollerRef = ref(null);
const renameInputRef = ref(null);
const scrollTop = ref(0);
const viewportHeight = ref(520);
const userColumnWidths = reactive({ name: 0, comment: 0, fields: 0 });
const columnResize = ref(null);
const selectionBox = ref(null);
const boxSelectedNames = ref([]);
const suppressHeaderClick = ref(false);

const selectedSet = computed(() => new Set(props.selectedNames));
const boxSelectedSet = computed(() => new Set(boxSelectedNames.value));
const renderedSelectedSet = computed(() => new Set([...props.selectedNames, ...boxSelectedNames.value]));
const columns = computed(() => [
  { key: "name", label: "表名", width: columnWidths.value.name },
  { key: "comment", label: "备注", width: columnWidths.value.comment },
  { key: "fields", label: "字段", width: columnWidths.value.fields },
]);
const columnWidths = computed(() => {
  const maxName = props.tables.reduce((max, table) => Math.max(max, textWidth(tableName(table), 13)), 0);
  const maxComment = props.tables.reduce((max, table) => Math.max(max, textWidth(tableComment(table) || "无备注", 12.5)), 0);
  return {
    name: userColumnWidths.name || clampWidth(maxName + 52, MIN_WIDTHS.name, MAX_WIDTHS.name),
    comment: userColumnWidths.comment || clampWidth(maxComment + 28, MIN_WIDTHS.comment, MAX_WIDTHS.comment),
    fields: userColumnWidths.fields || MIN_WIDTHS.fields,
  };
});
const tableWidth = computed(() => columns.value.reduce((sum, column) => sum + column.width, 0));
const gridTemplateColumns = computed(() => columns.value.map((column) => `${column.width}px`).join(" "));
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

function columnCountLabel(table) {
  return table?.columnCount != null ? `${table.columnCount} 字段` : "";
}

function textWidth(value, fontSize = 13) {
  return String(value || "").length * Math.max(7, fontSize * 0.56);
}

function clampWidth(value, min, max) {
  return Math.max(min, Math.min(max, Math.ceil(Number(value) || min)));
}

function sortDirection(column) {
  return props.sortState?.column === column ? props.sortState?.direction || "" : "";
}

function sortLabel(column) {
  const direction = sortDirection(column);
  if (direction === "asc") return "升序";
  if (direction === "desc") return "降序";
  return "";
}

function handleHeaderClick(column) {
  if (suppressHeaderClick.value) {
    suppressHeaderClick.value = false;
    return;
  }
  emit("sort-column", column);
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
  if (!event.target?.closest?.(".wb-dbhome-object-row, .wb-dbhome-table-header")) emit("blank-click", event);
}

function beginColumnResize(column, event) {
  const key = column?.key;
  if (!key) return;
  suppressHeaderClick.value = true;
  columnResize.value = {
    key,
    startX: event.clientX,
    startWidth: column.width,
  };
  window.addEventListener("pointermove", continueColumnResize);
  window.addEventListener("pointerup", finishColumnResize, { once: true });
}

function continueColumnResize(event) {
  const resize = columnResize.value;
  if (!resize) return;
  const min = MIN_WIDTHS[resize.key] || 80;
  const max = MAX_WIDTHS[resize.key] || 520;
  userColumnWidths[resize.key] = clampWidth(resize.startWidth + event.clientX - resize.startX, min, max);
}

function finishColumnResize() {
  window.removeEventListener("pointermove", continueColumnResize);
  columnResize.value = null;
  window.setTimeout(() => {
    suppressHeaderClick.value = false;
  }, 0);
}

function beginBoxSelection(event) {
  if (event.button !== 0) return;
  if (event.target?.closest?.(".wb-dbhome-object-row, .wb-dbhome-table-header, .wb-dbhome-empty-list")) return;
  const rect = scrollerRef.value?.getBoundingClientRect?.();
  if (!rect) return;
  event.preventDefault();
  boxSelectedNames.value = [];
  selectionBox.value = {
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    width: 0,
    height: 0,
  };
  window.addEventListener("pointermove", updateBoxSelection);
  window.addEventListener("pointerup", finishBoxSelection, { once: true });
}

function selectedNamesInBox(box) {
  if (!box || box.width < 4 || box.height < 4) return [];
  const boxRect = {
    left: box.x,
    right: box.x + box.width,
    top: box.y,
    bottom: box.y + box.height,
  };
  const selected = [];
  scrollerRef.value?.querySelectorAll?.(".wb-dbhome-object-row")?.forEach((row) => {
    const rect = row.getBoundingClientRect();
    const intersects = rect.left < boxRect.right && rect.right > boxRect.left && rect.top < boxRect.bottom && rect.bottom > boxRect.top;
    if (intersects) selected.push(row.dataset.tableName);
  });
  return selected;
}

function updateBoxSelectionPreview(box = selectionBox.value) {
  boxSelectedNames.value = selectedNamesInBox(box);
}

function updateBoxSelection(event) {
  const box = selectionBox.value;
  if (!box) return;
  const x = Math.min(box.startX, event.clientX);
  const y = Math.min(box.startY, event.clientY);
  box.x = x;
  box.y = y;
  box.width = Math.abs(event.clientX - box.startX);
  box.height = Math.abs(event.clientY - box.startY);
  updateBoxSelectionPreview(box);
}

function finishBoxSelection(event) {
  window.removeEventListener("pointermove", updateBoxSelection);
  if (event) updateBoxSelection(event);
  const box = selectionBox.value;
  const selected = [...boxSelectedNames.value];
  selectionBox.value = null;
  boxSelectedNames.value = [];
  if (!box || box.width < 4 || box.height < 4) return;
  emit("replace-selection", selected);
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
    class="wb-dbhome-table-surface"
    tabindex="0"
    role="listbox"
    aria-label="表对象"
    :aria-multiselectable="true"
    @scroll="onScroll"
    @keydown="handleKeydown"
    @pointerdown="handleBlankPointer"
    @pointerdown.left="beginBoxSelection"
    @contextmenu.prevent="emit('blank-contextmenu', $event)"
  >
    <div v-if="!tables.length" class="wb-dbhome-empty-list">
      <strong>当前数据库暂无表</strong>
      <span>可以从其它数据库复制表后在这里粘贴。</span>
    </div>
    <template v-else>
      <div class="wb-dbhome-table-header" :style="{ gridTemplateColumns, width: `${tableWidth}px` }" role="row">
        <button
          v-for="column in columns"
          :key="column.key"
          type="button"
          class="wb-dbhome-header-cell"
          :class="{ 'is-sorted': sortDirection(column.key) }"
          role="columnheader"
          :aria-sort="sortDirection(column.key) === 'asc' ? 'ascending' : sortDirection(column.key) === 'desc' ? 'descending' : 'none'"
          @click="handleHeaderClick(column.key)"
        >
          <span>{{ column.label }}</span>
          <span class="wb-dbhome-sort-mark" aria-hidden="true">{{ sortDirection(column.key) === "asc" ? "↑" : sortDirection(column.key) === "desc" ? "↓" : "" }}</span>
          <span v-if="sortLabel(column.key)" class="wb-visually-hidden">{{ sortLabel(column.key) }}</span>
          <span class="wb-dbhome-resize-handle" aria-hidden="true" @pointerdown.stop.prevent="beginColumnResize(column, $event)"></span>
        </button>
      </div>
      <div class="wb-dbhome-object-list" :style="{ width: `${tableWidth}px` }">
        <div class="wb-dbhome-virtual" :style="{ height: `${totalHeight}px`, width: `${tableWidth}px` }">
          <div class="wb-dbhome-virtual-window" :style="{ transform: `translateY(${visibleRange.start * ROW_HEIGHT}px)` }">
        <div
          v-for="{ table } in visibleRows"
          :key="tableName(table)"
          class="wb-dbhome-object-row"
          :class="{
            'is-selected': renderedSelectedSet.has(tableName(table)),
            'is-box-selected': boxSelectedSet.has(tableName(table)),
            'is-renaming': renamingName === tableName(table),
          }"
          :style="{ gridTemplateColumns }"
          :data-table-name="tableName(table)"
          @contextmenu.prevent.stop="emit('contextmenu', $event, tableName(table))"
        >
          <span class="wb-dbhome-object-name">
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
            <button
              v-else
              type="button"
              class="wb-dbhome-object-name-button"
              role="option"
              :aria-selected="renderedSelectedSet.has(tableName(table)) ? 'true' : 'false'"
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
              {{ tableName(table) }}
            </button>
          </span>
          <span class="wb-dbhome-object-comment">
            <span class="wb-dbhome-object-comment-text">{{ tableComment(table) || "无备注" }}</span>
          </span>
          <span class="wb-dbhome-object-meta">
            <span class="wb-dbhome-object-field-count">{{ columnCountLabel(table) }}</span>
            <span v-if="readOnly" class="wb-dbhome-readonly">只读</span>
          </span>
        </div>
          </div>
        </div>
      </div>
      <div
        v-if="selectionBox"
        class="wb-dbhome-selection-box"
        :style="{
          left: `${selectionBox.x}px`,
          top: `${selectionBox.y}px`,
          width: `${selectionBox.width}px`,
          height: `${selectionBox.height}px`,
        }"
      ></div>
    </template>
  </div>
</template>
