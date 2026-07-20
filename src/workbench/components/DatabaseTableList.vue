<script setup>
import { computed, nextTick, ref, useId, watch } from "vue";
import { Star, Table2 } from "lucide-vue-next";
import {
  defaultHomeColumnLayout,
  formatDataSize,
  formatModifiedAt,
  homeColumnDefinition,
  loadHomeColumnLayout,
  moveHomeColumn,
  saveHomeColumnLayout,
} from "../homeColumnLayout.js";
import { highlightSearchRanges } from "../utils/searchMatch.js";
import { matchTableSearch } from "../utils/tableSearch.js";

const ROW_HEIGHT = 36;
const BUFFER_ROWS = 8;

const props = defineProps({
  tables: { type: Array, default: () => [] },
  searchQuery: { type: String, default: "" },
  typeaheadQuery: { type: String, default: "" },
  selectedNames: { type: Array, default: () => [] },
  favoriteNames: { type: Array, default: () => [] },
  renamingName: { type: String, default: "" },
  renameDraft: { type: String, default: "" },
  renameError: { type: String, default: "" },
  renamePending: { type: Boolean, default: false },
  sortState: { type: Object, default: () => ({ column: "name", direction: "asc" }) },
  readOnly: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits([
  "select-table",
  "open-table",
  "open-design",
  "visible-tables",
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
  "toggle-favorite",
  "box-selection-complete",
]);

const scrollerRef = ref(null);
const renameInputRef = ref(null);
const renameErrorId = `wb-dbhome-rename-error-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
const renameSubmissionHandled = ref(false);
const scrollTop = ref(0);
const viewportHeight = ref(520);
const columnLayout = ref(loadHomeColumnLayout());
const columnResize = ref(null);
const draggedColumnKey = ref("");
const dropTarget = ref(null);
const headerMenu = ref({ open: false, x: 0, y: 0 });
const selectionBox = ref(null);
const boxSelectedNames = ref([]);
const suppressHeaderClick = ref(false);

const selectedSet = computed(() => new Set(props.selectedNames));
const favoriteSet = computed(() => new Set(props.favoriteNames));
const boxSelectedSet = computed(() => new Set(boxSelectedNames.value));
const renderedSelectedSet = computed(() => new Set([...props.selectedNames, ...boxSelectedNames.value]));
const columns = computed(() => columnLayout.value.map((item) => {
  const definition = homeColumnDefinition(item.key);
  return { ...definition, width: columnWidths.value[item.key] };
}));
const columnWidths = computed(() => {
  const maxName = props.tables.reduce((max, table) => Math.max(max, textWidth(tableName(table), 13)), 0);
  const maxComment = props.tables.reduce((max, table) => Math.max(max, textWidth(tableComment(table) || "无备注", 12.5)), 0);
  const automatic = {
    name: clampWidth(maxName + (props.readOnly ? 126 : 76), 160, 520),
    size: 116,
    modified: 176,
    comment: clampWidth(maxComment + 28, 180, 520),
  };
  return Object.fromEntries(columnLayout.value.map((item) => [item.key, item.width || automatic[item.key]]));
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
const visibleSearchMatches = computed(() => {
  const searchQuery = props.searchQuery.trim();
  const typeaheadQuery = props.typeaheadQuery.trim();
  if (!searchQuery && !typeaheadQuery) return new Map();

  return new Map(visibleRows.value.map(({ table }) => [tableName(table), {
    tableName: [
      ...matchedFieldRanges(table, searchQuery ? [searchQuery] : [], "tableName", "contains"),
      ...matchedFieldRanges(table, typeaheadQuery ? [typeaheadQuery] : [], "tableName"),
    ],
    tableComment: matchedFieldRanges(table, searchQuery ? [searchQuery] : [], "tableComment", "contains"),
  }]));
});

watch(
  () => visibleRows.value.map(({ table }) => tableName(table)).filter(Boolean).join("\u001f"),
  () => {
    emit("visible-tables", visibleRows.value.map(({ table }) => tableName(table)).filter(Boolean));
  },
  { immediate: true },
);

function tableName(table) {
  return table?.tableName || table?.table_name || "";
}

function tableComment(table) {
  return table?.tableComment || table?.table_comment || "";
}

function matchedFieldRanges(table, queries, kind, mode = "fuzzy") {
  return queries.flatMap((query) => {
    const match = matchTableSearch(table, query, { mode, includedKinds: [kind] });
    return match.matched ? match.ranges : [];
  });
}

function highlightedTableField(table, kind) {
  const value = kind === "tableComment" ? tableComment(table) || "无备注" : tableName(table);
  const ranges = visibleSearchMatches.value.get(tableName(table))?.[kind] || [];
  return highlightSearchRanges(value, ranges);
}

function columnCellValue(table, key) {
  if (key === "size") return formatDataSize(table?.dataSizeBytes ?? table?.data_size_bytes);
  if (key === "modified") return formatModifiedAt(table?.modifiedAt ?? table?.modified_at);
  if (key === "comment") return tableComment(table) || "无备注";
  return tableName(table);
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

function toggleFavorite(table) {
  const name = tableName(table);
  if (name) emit("toggle-favorite", name);
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
  headerMenu.value.open = false;
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
  const definition = homeColumnDefinition(resize.key);
  const width = clampWidth(resize.startWidth + event.clientX - resize.startX, definition.minWidth, definition.maxWidth);
  columnLayout.value = columnLayout.value.map((column) => column.key === resize.key ? { ...column, width } : column);
}

function finishColumnResize() {
  window.removeEventListener("pointermove", continueColumnResize);
  columnResize.value = null;
  saveHomeColumnLayout(columnLayout.value);
  window.setTimeout(() => {
    suppressHeaderClick.value = false;
  }, 0);
}

function beginBoxSelection(event) {
  if (event.button !== 0) return;
  if (event.target?.closest?.(".wb-dbhome-object-name, .wb-dbhome-table-header, .wb-dbhome-empty-list")) return;
  if (props.renamingName) {
    renameInputRef.value?.blur?.();
    return;
  }
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
  emit("box-selection-complete");
  emit("replace-selection", selected);
}

function resetColumnWidth(key) {
  columnLayout.value = columnLayout.value.map((column) => column.key === key ? { ...column, width: null } : column);
  saveHomeColumnLayout(columnLayout.value);
}

function columnRects() {
  const rects = new Map();
  scrollerRef.value?.querySelectorAll?.("[data-home-cell-id]")?.forEach((element) => {
    rects.set(element.dataset.homeCellId, element.getBoundingClientRect());
  });
  return rects;
}

function animateColumnMove(before) {
  if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
  nextTick(() => {
    scrollerRef.value?.querySelectorAll?.("[data-home-cell-id]")?.forEach((element) => {
      const previous = before.get(element.dataset.homeCellId);
      if (!previous) return;
      const current = element.getBoundingClientRect();
      const delta = previous.left - current.left;
      if (Math.abs(delta) < 1) return;
      element.style.transition = "none";
      element.style.transform = `translateX(${delta}px)`;
      requestAnimationFrame(() => {
        element.style.transition = "transform 180ms cubic-bezier(.2,.8,.2,1)";
        element.style.transform = "translateX(0)";
      });
    });
  });
}

function beginColumnDrag(column, event) {
  draggedColumnKey.value = column.key;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", column.key);
}

function dragOverColumn(column, event) {
  if (!draggedColumnKey.value || draggedColumnKey.value === column.key) return;
  const rect = event.currentTarget.getBoundingClientRect();
  dropTarget.value = { key: column.key, position: event.clientX >= rect.left + rect.width / 2 ? "after" : "before" };
}

function dropColumn() {
  if (!draggedColumnKey.value || !dropTarget.value) return;
  const before = columnRects();
  columnLayout.value = moveHomeColumn(columnLayout.value, draggedColumnKey.value, dropTarget.value.key, dropTarget.value.position);
  saveHomeColumnLayout(columnLayout.value);
  animateColumnMove(before);
  draggedColumnKey.value = "";
  dropTarget.value = null;
}

function endColumnDrag() {
  draggedColumnKey.value = "";
  dropTarget.value = null;
}

function openHeaderMenu(event) {
  headerMenu.value = { open: true, x: event.clientX, y: event.clientY };
}

function resetColumnLayout() {
  const before = columnRects();
  columnLayout.value = defaultHomeColumnLayout();
  saveHomeColumnLayout(columnLayout.value);
  headerMenu.value.open = false;
  animateColumnMove(before);
}

function isEditableShortcutTarget(target) {
  if (!target) return false;
  return Boolean(target.isContentEditable || target.closest?.("input, textarea, select"));
}

function handleKeydown(event) {
  if (isEditableShortcutTarget(event.target)) return;
  const key = String(event.key || "");
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "a") {
    event.preventDefault();
    emit("replace-selection", props.tables.map((table) => tableName(table)).filter(Boolean));
    return;
  }
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
  if (renameSubmissionHandled.value) return;
  renameSubmissionHandled.value = true;
  emit("submit-rename", props.renamingName, props.renameDraft);
}

function handleRenameInput(event) {
  renameSubmissionHandled.value = false;
  emit("rename-draft", event?.target?.value ?? "");
}

function cancelRename() {
  renameSubmissionHandled.value = true;
  emit("cancel-rename");
}

function setRenameInput(element) {
  renameInputRef.value = element || null;
}

function focusList() {
  scrollerRef.value?.focus?.();
}

function scrollTableIntoView(name, { block = "center" } = {}) {
  const index = props.tables.findIndex((table) => tableName(table) === name);
  const scroller = scrollerRef.value;
  if (index < 0 || !scroller) return false;
  const rowTop = index * ROW_HEIGHT;
  const rowBottom = rowTop + ROW_HEIGHT;
  let nextTop = rowTop - Math.max(0, scroller.clientHeight - ROW_HEIGHT) / 2;
  if (block === "nearest") {
    const viewportTop = scroller.scrollTop;
    const viewportBottom = viewportTop + scroller.clientHeight;
    if (rowTop < viewportTop) nextTop = rowTop;
    else if (rowBottom > viewportBottom) nextTop = rowBottom - scroller.clientHeight;
    else return true;
  }
  scroller.scrollTop = Math.max(0, nextTop);
  scrollTop.value = scroller.scrollTop;
  return true;
}

function resetView() {
  window.removeEventListener("pointermove", continueColumnResize);
  window.removeEventListener("pointerup", finishColumnResize);
  window.removeEventListener("pointermove", updateBoxSelection);
  window.removeEventListener("pointerup", finishBoxSelection);
  columnResize.value = null;
  selectionBox.value = null;
  boxSelectedNames.value = [];
  suppressHeaderClick.value = false;
  renameSubmissionHandled.value = false;
  scrollTop.value = 0;
  if (scrollerRef.value) scrollerRef.value.scrollTop = 0;
}

watch(
  () => props.renamingName,
  (name) => {
    if (!name) return;
    renameSubmissionHandled.value = false;
    nextTick(() => {
      renameInputRef.value?.focus?.();
      renameInputRef.value?.select?.();
    });
  },
);

watch(
  () => props.renameDraft,
  () => {
    if (props.renamingName) renameSubmissionHandled.value = false;
  },
);

watch(
  () => [props.renameError, props.renamePending],
  ([error, pending]) => {
    if (!error || pending || !props.renamingName) return;
    nextTick(() => {
      renameInputRef.value?.focus?.();
      renameInputRef.value?.select?.();
    });
  },
);

defineExpose({ focusList, resetView, scrollTableIntoView });
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
    @contextmenu.prevent.stop="emit('blank-contextmenu', $event)"
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
          :class="{
            'is-sorted': sortDirection(column.key),
            'is-drop-before': dropTarget?.key === column.key && dropTarget?.position === 'before',
            'is-drop-after': dropTarget?.key === column.key && dropTarget?.position === 'after',
          }"
          :data-home-cell-id="`header:${column.key}`"
          role="columnheader"
          :aria-sort="sortDirection(column.key) === 'asc' ? 'ascending' : sortDirection(column.key) === 'desc' ? 'descending' : 'none'"
          @click="handleHeaderClick(column.key)"
          @contextmenu.prevent.stop="openHeaderMenu"
          @dragover.prevent="dragOverColumn(column, $event)"
          @drop.prevent="dropColumn"
        >
          <span
            class="wb-dbhome-column-drag-handle"
            draggable="true"
            title="拖动调整列顺序"
            aria-label="拖动调整列顺序"
            @click.stop
            @dragstart.stop="beginColumnDrag(column, $event)"
            @dragend="endColumnDrag"
          >⠿</span>
          <span>{{ column.label }}</span>
          <span class="wb-dbhome-sort-mark" aria-hidden="true">{{ sortDirection(column.key) === "asc" ? "↑" : sortDirection(column.key) === "desc" ? "↓" : "" }}</span>
          <span v-if="sortLabel(column.key)" class="wb-visually-hidden">{{ sortLabel(column.key) }}</span>
          <span
            class="wb-dbhome-resize-handle"
            aria-hidden="true"
            @pointerdown.stop.prevent="beginColumnResize(column, $event)"
            @dblclick.stop.prevent="resetColumnWidth(column.key)"
          ></span>
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
          <span
            v-for="column in columns"
            :key="`${tableName(table)}:${column.key}`"
            :data-home-cell-id="`${tableName(table)}:${column.key}`"
            :class="{
              'wb-dbhome-object-name': column.key === 'name',
              'wb-dbhome-object-comment': column.key === 'comment',
              'wb-dbhome-object-cell': column.key !== 'name',
            }"
            :title="columnCellValue(table, column.key)"
            @click="column.key !== 'name' && select(table, $event)"
          >
            <template v-if="column.key === 'name'">
              <Table2 :size="15" class="wb-tree-kind-icon" aria-hidden="true" />
              <input
                v-if="renamingName === tableName(table)"
                :ref="setRenameInput"
                class="wb-dbhome-rename-input"
                :class="{ 'is-error': renameError }"
                :value="renameDraft"
                :disabled="busy || readOnly || renamePending"
                :aria-invalid="renameError ? 'true' : undefined"
                :aria-describedby="renameError ? renameErrorId : undefined"
                :aria-busy="renamePending ? 'true' : undefined"
                @input="handleRenameInput"
                @keydown.enter.prevent.stop="submitRename"
                @keydown.esc.prevent.stop="cancelRename"
                @blur="submitRename"
                @click.stop
                @dblclick.stop
              />
              <button
                v-else
                type="button"
                class="wb-dbhome-object-name-button"
                role="option"
                :aria-selected="renderedSelectedSet.has(tableName(table)) ? 'true' : 'false'"
                @click.stop="select(table, $event)"
                @dblclick="emit('open-table', tableName(table))"
                @contextmenu.prevent.stop="emit('contextmenu', $event, tableName(table))"
                @keydown.ctrl.c.prevent.stop="handleRowCopy(table)"
                @keydown.meta.c.prevent.stop="handleRowCopy(table)"
                @keydown.ctrl.v.prevent.stop="handleRowPaste"
                @keydown.meta.v.prevent.stop="handleRowPaste"
                @keydown.f2.prevent.stop="handleRowRename(table)"
                @keydown.enter.prevent.stop="handleRowOpen(table)"
                @keydown.delete.prevent.stop="handleRowDelete(table)"
                v-html="highlightedTableField(table, 'tableName')"
              ></button>
              <button
                type="button"
                class="wb-dbhome-favorite-button"
                :class="{ 'is-favorite': favoriteSet.has(tableName(table)) }"
                :title="favoriteSet.has(tableName(table)) ? '取消收藏' : '收藏并置顶'"
                :aria-label="favoriteSet.has(tableName(table)) ? `取消收藏 ${tableName(table)}` : `收藏并置顶 ${tableName(table)}`"
                :aria-pressed="favoriteSet.has(tableName(table)) ? 'true' : 'false'"
                @pointerdown.stop.prevent
                @click.stop="toggleFavorite(table)"
                @dblclick.stop
              >
                <Star
                  :size="15"
                  :stroke-width="1.8"
                  :fill="favoriteSet.has(tableName(table)) ? 'currentColor' : 'none'"
                  aria-hidden="true"
                />
              </button>
              <span v-if="readOnly" class="wb-dbhome-readonly">只读</span>
            </template>
            <template v-else-if="column.key === 'comment'">
              <span v-if="renamingName === tableName(table) && renameError" :id="renameErrorId" class="wb-dbhome-rename-error" role="alert" :title="renameError">{{ renameError }}</span>
              <span v-else-if="renamingName === tableName(table) && renamePending" class="wb-dbhome-rename-pending" role="status">正在重命名…</span>
              <span v-else class="wb-dbhome-object-comment-text" v-html="highlightedTableField(table, 'tableComment')"></span>
            </template>
            <span v-else>{{ columnCellValue(table, column.key) }}</span>
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
      <Teleport to="body">
        <menu
          v-if="headerMenu.open"
          class="wb-context-menu wb-dbhome-column-menu"
          :style="{ left: `${headerMenu.x}px`, top: `${headerMenu.y}px` }"
          role="menu"
          @click.stop
        >
          <button type="button" role="menuitem" @click="resetColumnLayout">恢复默认列布局</button>
        </menu>
      </Teleport>
    </template>
  </div>
</template>
