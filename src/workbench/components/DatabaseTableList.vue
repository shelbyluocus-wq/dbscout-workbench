<script setup>
import { t } from "../i18n/index.js";
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { ArrowDown, ArrowUp, ChevronRight, GripVertical, History, Star } from "lucide-vue-next";
import {
  computeAutoHomeColumnWidths,
  defaultHomeColumnLayout,
  fittedFillWidth,
  formatDataSize,
  formatModifiedAtTooltip,
  formatModifiedDisplayParts,
  homeColumnDefinition,
  homeGridTemplateColumns,
  homeTableWidthCss,
  loadHomeColumnLayout,
  moveHomeColumn,
  saveHomeColumnLayout,
} from "../homeColumnLayout.js";
import { isDeleteCommandKey } from "../utils/listSelection.js";
import { highlightSearchRanges } from "../utils/searchMatch.js";
import { matchTableKeywords, parseSearchKeywords } from "../utils/tableKeywordSearch.js";
import { matchTableSearch } from "../utils/tableSearch.js";
import { databaseTableIconComponent } from "./databaseDecorationIcons.js";

const ROW_HEIGHT = 30;
const BUFFER_ROWS = 8;

const props = defineProps({
  tables: { type: Array, default: () => [] },
  searchQuery: { type: String, default: "" },
  typeaheadQuery: { type: String, default: "" },
  selectedNames: { type: Array, default: () => [] },
  favoriteNames: { type: Array, default: () => [] },
  databaseDecoration: { type: Object, default: null },
  renamingName: { type: String, default: "" },
  renameDraft: { type: String, default: "" },
  renameError: { type: String, default: "" },
  renamePending: { type: Boolean, default: false },
  sortState: { type: Object, default: () => ({ column: "name", direction: "asc" }) },
  readOnly: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  localeMeta: { type: Object, default: null },
});

const emit = defineEmits([
  "select-table",
  "open-selection",
  "activate-row",
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
  "toggle-locale-group",
  "view-change-history",
  "box-selection-complete",
]);

function rowLocaleMeta(table) {
  return props.localeMeta?.get?.(tableName(table)) || null;
}

const scrollerRef = ref(null);
const renameInputRef = ref(null);
const renameErrorId = `wb-dbhome-rename-error-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
const renameSubmissionHandled = ref(false);
const scrollTop = ref(0);
const viewportHeight = ref(520);
const surfaceWidth = ref(0);
const columnLayout = ref(loadHomeColumnLayout());
const columnResize = ref(null);
const draggedColumnKey = ref("");
const dropTarget = ref(null);
const headerMenu = ref({ open: false, x: 0, y: 0 });
const selectionBox = ref(null);
const boxSelectedNames = ref([]);
// Ctrl/Cmd+drag adds the box to the selection the drag started with;
// a plain drag replaces it, so the old selection is not shown meanwhile.
const boxBaseNames = ref([]);
const suppressHeaderClick = ref(false);

const selectedSet = computed(() => new Set(props.selectedNames));
const favoriteSet = computed(() => new Set(props.favoriteNames));
const boxSelectedSet = computed(() => new Set(boxSelectedNames.value));
const boxPreviewActive = computed(() => Boolean(selectionBox.value)
  && selectionBox.value.width >= 4
  && selectionBox.value.height >= 4);
const renderedSelectedSet = computed(() => (boxPreviewActive.value
  ? new Set([...boxBaseNames.value, ...boxSelectedNames.value])
  : selectedSet.value));
const tableIcon = computed(() => databaseTableIconComponent(props.databaseDecoration));
const columns = computed(() => columnLayout.value.map((item) => {
  const definition = homeColumnDefinition(item.key);
  return { ...definition, label: t(({ name: 'm_699c6d62a836', size: 'm_7640eaa08b0c', modified: 'm_257bbcc44c83', comment: 'm_daede9881787' })[item.key]), width: columnWidths.value[item.key] };
}));
const automaticColumnWidths = computed(() => computeAutoHomeColumnWidths(props.tables, {
  readOnly: props.readOnly,
  emptyComment: t('m_8445d1bad03f'),
  selfLabel: t('home.modifiedSelf'),
}));
const columnWidths = computed(() => {
  const automatic = automaticColumnWidths.value;
  const widths = Object.fromEntries(columnLayout.value.map((item) => [item.key, item.width || automatic[item.key]]));
  // On narrow panes, trim an automatically sized comment column toward its
  // automatic minimum so the table avoids horizontal scroll; a width the user
  // dragged always stays exactly as set, and wide panes never stretch it.
  const autoComment = columnLayout.value.find((item) => item.key === "comment" && !item.width);
  if (autoComment) {
    const otherColumnsWidth = columnLayout.value
      .reduce((sum, item) => (item.key === autoComment.key ? sum : sum + widths[item.key]), 0);
    const commentDefinition = homeColumnDefinition(autoComment.key);
    widths[autoComment.key] = fittedFillWidth({
      preferred: widths[autoComment.key],
      minWidth: commentDefinition.autoMinWidth ?? commentDefinition.minWidth,
      available: surfaceWidth.value,
      otherColumnsWidth,
    });
  }
  return widths;
});
const tableWidth = computed(() => homeTableWidthCss(columns.value));
const gridTemplateColumns = computed(() => homeGridTemplateColumns(columns.value));
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
  const keywords = parseSearchKeywords(props.searchQuery);
  const typeaheadQuery = props.typeaheadQuery.trim();
  if (!keywords.length && !typeaheadQuery) return new Map();

  return new Map(visibleRows.value.map(({ table }) => {
    const keywordMatch = matchTableKeywords(table, keywords);
    return [tableName(table), {
      tableName: [
        ...keywordMatch.nameRanges,
        ...typeaheadNameRanges(table, typeaheadQuery),
      ],
      tableComment: keywordMatch.commentRanges,
    }];
  }));
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

function typeaheadNameRanges(table, query) {
  if (!query) return [];
  const match = matchTableSearch(table, query, { includedKinds: ["tableName"] });
  return match.matched ? match.ranges : [];
}

function highlightedTableField(table, kind) {
  const value = kind === "tableComment" ? tableComment(table) || t('m_8445d1bad03f') : tableName(table);
  const ranges = visibleSearchMatches.value.get(tableName(table))?.[kind] || [];
  return highlightSearchRanges(value, ranges);
}

function modifiedCellParts(table) {
  return formatModifiedDisplayParts(table, { selfLabel: t("home.modifiedSelf") });
}

function columnCellValue(table, key) {
  if (key === "size") return formatDataSize(table?.dataSizeBytes ?? table?.data_size_bytes);
  if (key === "modified") return modifiedCellParts(table).text;
  if (key === "comment") return tableComment(table) || t('m_8445d1bad03f');
  return tableName(table);
}

function columnCellTitle(table, key) {
  if (key === "modified") {
    return formatModifiedAtTooltip(table, {
      empty: t("home.modifiedEmpty"),
      self: t("home.modifiedSelf"),
      blackcat: t("home.modifiedSource.blackcat"),
      shared: t("home.modifiedSource.shared"),
      database: t("home.modifiedSource.database"),
      external: t("home.modifiedSource.external"),
    });
  }
  return columnCellValue(table, key);
}

function clampWidth(value, min, max) {
  return Math.max(min, Math.min(max, Math.ceil(Number(value) || min)));
}

function sortDirection(column) {
  return props.sortState?.column === column ? props.sortState?.direction || "" : "";
}

function sortLabel(column) {
  const direction = sortDirection(column);
  if (direction === "asc") return t('m_ca715c0d8d83');
  if (direction === "desc") return t('m_4b77c3546823');
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

function openChangeHistory(table) {
  const name = tableName(table);
  if (name) emit("view-change-history", name);
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

// Enter on a row inside the selection opens the whole selection; a row
// outside it is selected and opened on its own.
function handleRowOpen(table) {
  const name = selectForAction(table);
  if (name) emit("open-selection", name);
}

function handleRowDelete(table) {
  selectForAction(table);
  emit("delete");
}

// Keys a focused table-name button acts on. Everything else (arrows, Home,
// End, Escape, Shift+F10) bubbles to the home page, which owns navigation.
function handleRowKeydown(table, event) {
  const key = String(event.key || "");
  const command = event.ctrlKey || event.metaKey;
  const lowerKey = key.toLowerCase();
  if (command && !event.shiftKey && !event.altKey && lowerKey === "c") handleRowCopy(table);
  else if (command && !event.shiftKey && !event.altKey && lowerKey === "v") handleRowPaste();
  else if (key === "F2" && !command && !event.altKey && !event.shiftKey) handleRowRename(table);
  else if (key === "Enter" && !command && !event.altKey && !event.shiftKey) handleRowOpen(table);
  else if (isDeleteCommandKey(event)) handleRowDelete(table);
  else return;
  event.preventDefault();
  event.stopPropagation();
}

function handleRowDoubleClick(table, event) {
  if (event?.button !== undefined && event.button !== 0) return;
  const name = tableName(table);
  if (name) emit("activate-row", name);
}

function handleBlankPointer(event) {
  headerMenu.value.open = false;
  if (event.ctrlKey || event.metaKey) return;
  if (!event.target?.closest?.(".wb-dbhome-object-row, .wb-dbhome-table-header")) emit("blank-click", event);
}

function beginColumnResize(column, event) {
  const key = column?.key;
  if (!key) return;
  suppressHeaderClick.value = true;
  const renderedWidth = event.currentTarget?.parentElement?.getBoundingClientRect?.().width;
  columnResize.value = {
    key,
    startX: event.clientX,
    startWidth: renderedWidth || column.width,
    moved: false,
  };
  window.addEventListener("pointermove", continueColumnResize);
  window.addEventListener("pointerup", finishColumnResize, { once: true });
  window.addEventListener("pointercancel", finishColumnResize, { once: true });
}

function continueColumnResize(event) {
  const resize = columnResize.value;
  if (!resize) return;
  const delta = event.clientX - resize.startX;
  if (!resize.moved && Math.abs(delta) < 1) return;
  resize.moved = true;
  const definition = homeColumnDefinition(resize.key);
  const width = clampWidth(resize.startWidth + delta, definition.minWidth, definition.maxWidth);
  columnLayout.value = columnLayout.value.map((column) => column.key === resize.key ? { ...column, width } : column);
}

function finishColumnResize() {
  window.removeEventListener("pointermove", continueColumnResize);
  window.removeEventListener("pointerup", finishColumnResize);
  window.removeEventListener("pointercancel", finishColumnResize);
  const moved = Boolean(columnResize.value?.moved);
  columnResize.value = null;
  if (moved) saveHomeColumnLayout(columnLayout.value);
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
  const additive = Boolean(event.ctrlKey || event.metaKey);
  boxBaseNames.value = additive ? [...props.selectedNames] : [];
  selectionBox.value = {
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    width: 0,
    height: 0,
    additive,
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
  const selected = [...new Set([...boxBaseNames.value, ...boxSelectedNames.value])];
  selectionBox.value = null;
  boxSelectedNames.value = [];
  boxBaseNames.value = [];
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

// Rows that fit in the viewport, for PageUp/PageDown.
function pageRowCount() {
  const height = scrollerRef.value?.clientHeight || viewportHeight.value;
  return Math.max(1, Math.floor(height / ROW_HEIGHT) - 1);
}

function rowElement(name) {
  const rows = scrollerRef.value?.querySelectorAll?.(".wb-dbhome-object-row") || [];
  return Array.from(rows).find((row) => row.dataset.tableName === name) || null;
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
  window.removeEventListener("pointercancel", finishColumnResize);
  window.removeEventListener("pointermove", updateBoxSelection);
  window.removeEventListener("pointerup", finishBoxSelection);
  columnResize.value = null;
  selectionBox.value = null;
  boxSelectedNames.value = [];
  boxBaseNames.value = [];
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

const suspendPaneResize = inject("suspendGridAutoFit", null);
let surfaceObserver = null;
let pendingSurfaceMeasure = false;

function syncSurfaceMetrics() {
  const surface = scrollerRef.value;
  if (!surface) return;
  const nextWidth = surface.clientWidth;
  const nextHeight = surface.clientHeight;
  if (Math.abs(nextWidth - surfaceWidth.value) >= 1) surfaceWidth.value = nextWidth;
  if (nextHeight && Math.abs(nextHeight - viewportHeight.value) >= 1) viewportHeight.value = nextHeight;
}

watch(
  () => Boolean(suspendPaneResize?.value),
  (suspended) => {
    if (suspended || !pendingSurfaceMeasure) return;
    pendingSurfaceMeasure = false;
    nextTick(syncSurfaceMetrics);
  },
);

onMounted(() => {
  const surface = scrollerRef.value;
  if (!surface || typeof ResizeObserver !== "function") return;
  syncSurfaceMetrics();
  surfaceObserver = new ResizeObserver(() => {
    if (suspendPaneResize?.value) {
      pendingSurfaceMeasure = true;
      const nextHeight = surface.clientHeight;
      if (nextHeight && Math.abs(nextHeight - viewportHeight.value) >= 1) viewportHeight.value = nextHeight;
      return;
    }
    syncSurfaceMetrics();
  });
  surfaceObserver.observe(surface);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", continueColumnResize);
  window.removeEventListener("pointerup", finishColumnResize);
  window.removeEventListener("pointercancel", finishColumnResize);
  window.removeEventListener("pointermove", updateBoxSelection);
  window.removeEventListener("pointerup", finishBoxSelection);
  surfaceObserver?.disconnect();
  surfaceObserver = null;
});

defineExpose({ focusList, pageRowCount, resetView, rowElement, scrollTableIntoView });
</script>

<template>
  <div
    ref="scrollerRef"
    class="wb-dbhome-table-surface"
    :class="{ 'is-scrolled': scrollTop > 0 }"
    tabindex="0"
    role="listbox"
    :aria-label="t('m_ad3702d6aeb7')"
    :aria-multiselectable="true"
    @scroll="onScroll"
    @pointerdown="handleBlankPointer"
    @pointerdown.left="beginBoxSelection"
    @contextmenu.prevent.stop="emit('blank-contextmenu', $event)"
  >
    <div v-if="loading" class="wb-dbhome-empty-list is-loading" role="status" aria-live="polite">
      <strong>{{ t('m_133b5069fbfb') }}</strong>
      <span>{{ t('m_de615c77a92d') }}</span>
    </div>
    <div v-else-if="!tables.length" class="wb-dbhome-empty-list">
      <strong>{{ t('m_b0ae2ecf1ac5') }}</strong>
      <span>{{ t('m_ca3e16dc2317') }}</span>
    </div>
    <template v-else>
      <div
        class="wb-dbhome-table-header"
        :style="{ gridTemplateColumns, width: tableWidth }"
        role="row"
        @contextmenu.prevent.stop="openHeaderMenu"
      >
        <button
          v-for="column in columns"
          :key="column.key"
          type="button"
          class="wb-dbhome-header-cell"
          :class="{
            'is-sorted': sortDirection(column.key),
            'is-end': column.align === 'end',
            'is-resizing': columnResize?.key === column.key,
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
            :title="t('m_d4770aa6ef7b')"
            :aria-label="t('m_d4770aa6ef7b')"
            @click.stop
            @dragstart.stop="beginColumnDrag(column, $event)"
            @dragend="endColumnDrag"
          ><GripVertical :size="12" :stroke-width="2" aria-hidden="true" /></span>
          <span class="wb-dbhome-header-label">{{ column.label }}</span>
          <span class="wb-dbhome-sort-mark" aria-hidden="true">
            <ArrowUp v-if="sortDirection(column.key) === 'asc'" :size="12" :stroke-width="2.2" />
            <ArrowDown v-else-if="sortDirection(column.key) === 'desc'" :size="12" :stroke-width="2.2" />
          </span>
          <span v-if="sortLabel(column.key)" class="wb-visually-hidden">{{ sortLabel(column.key) }}</span>
          <span
            class="wb-dbhome-resize-handle"
            aria-hidden="true"
            @pointerdown.stop.prevent="beginColumnResize(column, $event)"
            @dblclick.stop.prevent="resetColumnWidth(column.key)"
          ></span>
        </button>
      </div>
      <div class="wb-dbhome-object-list" :style="{ width: tableWidth }">
        <div class="wb-dbhome-virtual" :style="{ height: `${totalHeight}px` }">
          <div class="wb-dbhome-virtual-window" :style="{ transform: `translateY(${visibleRange.start * ROW_HEIGHT}px)` }">
        <div
          v-for="{ table } in visibleRows"
          :key="tableName(table)"
          class="wb-dbhome-object-row"
          :class="{
            'is-selected': renderedSelectedSet.has(tableName(table)),
            'is-box-selected': boxSelectedSet.has(tableName(table)),
            'is-renaming': renamingName === tableName(table),
            'is-locale-variant': rowLocaleMeta(table)?.kind === 'variant',
          }"
          :style="{ gridTemplateColumns }"
          :data-table-name="tableName(table)"
          @click="select(table, $event)"
          @dblclick="handleRowDoubleClick(table, $event)"
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
              'is-end': column.align === 'end',
            }"
            :title="columnCellTitle(table, column.key)"
          >
            <template v-if="column.key === 'name'">
              <component :is="tableIcon" :size="15" class="wb-tree-kind-icon wb-dbhome-table-icon" aria-hidden="true" />
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
                @contextmenu.prevent.stop="emit('contextmenu', $event, tableName(table))"
                @keydown="handleRowKeydown(table, $event)"
              ><span class="wb-dbhome-object-name-text" v-html="highlightedTableField(table, 'tableName')"></span></button>
              <button
                v-if="rowLocaleMeta(table)?.kind === 'base'"
                type="button"
                class="wb-locale-group-pill"
                :class="{ 'is-expanded': rowLocaleMeta(table).expanded }"
                :aria-expanded="rowLocaleMeta(table).expanded ? 'true' : 'false'"
                :title="t('localeFold.expandGroup', { count: rowLocaleMeta(table).variantCount, suffixes: rowLocaleMeta(table).suffixes.join(' / ') })"
                @pointerdown.stop.prevent
                @click.stop="emit('toggle-locale-group', rowLocaleMeta(table).baseLower)"
                @dblclick.stop
              >
                <ChevronRight :size="11" :stroke-width="2.2" class="wb-locale-group-chevron" aria-hidden="true" />
                <span>+{{ rowLocaleMeta(table).variantCount }}</span>
              </button>
              <span
                v-else-if="rowLocaleMeta(table)?.kind === 'variant'"
                class="wb-locale-variant-badge"
              >{{ rowLocaleMeta(table).suffix }}</span>
              <button
                type="button"
                class="wb-dbhome-favorite-button"
                :class="{ 'is-favorite': favoriteSet.has(tableName(table)) }"
                :title="favoriteSet.has(tableName(table)) ? t('m_dca60869e7d2') : t('m_616b6280465e')"
                :aria-label="t(favoriteSet.has(tableName(table)) ? 'home.unfavoriteTable' : 'home.favoriteTable', { table: tableName(table) })"
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
              <span v-if="readOnly" class="wb-dbhome-readonly">{{ t('m_3b5ec3533b0e') }}</span>
            </template>
            <template v-else-if="column.key === 'comment'">
              <span v-if="renamingName === tableName(table) && renameError" :id="renameErrorId" class="wb-dbhome-rename-error" role="alert" :title="renameError">{{ renameError }}</span>
              <span v-else-if="renamingName === tableName(table) && renamePending" class="wb-dbhome-rename-pending" role="status">{{ t('m_f5dee69cca2b') }}</span>
              <span v-else class="wb-dbhome-object-comment-text" v-html="highlightedTableField(table, 'tableComment')"></span>
            </template>
            <template v-else-if="column.key === 'modified'">
              <span class="wb-dbhome-modified-cell">
                <span class="wb-dbhome-modified-main">
                  <span class="wb-dbhome-modified-time">{{ modifiedCellParts(table).time }}</span>
                  <span v-if="modifiedCellParts(table).actor" class="wb-dbhome-modified-sep" aria-hidden="true">·</span>
                  <span v-if="modifiedCellParts(table).actor" class="wb-dbhome-modified-actor">{{ modifiedCellParts(table).actor }}</span>
                </span>
                <button
                  type="button"
                  class="wb-dbhome-history-button"
                  :title="t('home.viewChangeHistory', { table: tableName(table) })"
                  :aria-label="t('home.viewChangeHistory', { table: tableName(table) })"
                  @pointerdown.stop.prevent
                  @click.stop="openChangeHistory(table)"
                  @dblclick.stop
                >
                  <History :size="14" :stroke-width="1.8" aria-hidden="true" />
                </button>
              </span>
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
          <button type="button" role="menuitem" @click="resetColumnLayout">{{ t('m_a902179d4a5a') }}</button>
        </menu>
      </Teleport>
    </template>
  </div>
</template>
