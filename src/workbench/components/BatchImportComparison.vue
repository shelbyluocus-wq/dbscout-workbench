<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Maximize2,
  Minimize2,
  RotateCcw,
  Search,
  X,
} from "lucide-vue-next";
import {
  loadFullComparisonToCompletion,
  useBatchComparisonFullRows,
} from "../composables/useBatchComparisonFullRows.js";
import { useBatchComparisonSearch } from "../composables/useBatchComparisonSearch.js";
import {
  applyExitFullscreen,
  applyTableSelectionToFullscreen,
  createTableComparisonFullscreen,
  isTableFullscreenFocused,
  isTableStage as readTableStage,
  resetTableComparisonFullscreen,
  toggleGlobalFullscreen,
  toggleTableFullscreen as nextTableFullscreen,
} from "../composables/tableComparisonFullscreen.js";
import BatchImportDiffGrid from "./BatchImportDiffGrid.vue";
import ToolbarSplitButton from "./ToolbarSplitButton.vue";
import {
  COMPARISON_TABLE_NAV_WIDTH_STORAGE_KEY,
  MAX_COMPARISON_TABLE_NAV_WIDTH,
  MIN_COMPARISON_TABLE_NAV_WIDTH,
  clampComparisonTableNavWidth,
  comparisonTableNavGridStyle,
  comparisonTableNavResizerStyle,
  comparisonTableNavWidthFromClientX,
  comparisonTableNavWidthFromKey,
  readStoredComparisonTableNavWidth,
} from "../utils/comparisonPaneSplit.js";

const props = defineProps({
  comparison: { type: Object, required: true },
});

const emit = defineEmits(["fullscreen-change"]);
const theme = inject("theme", ref("light"));

const viewMode = ref("differences");
const showPrimaryKeys = ref(true);
const fullscreen = ref(createTableComparisonFullscreen());
const isFullscreen = computed(() => fullscreen.value.isFullscreen);
const isTableStage = computed(() => readTableStage(fullscreen.value));
const activeFilter = ref("all");
const activeTable = ref("");
const widthResetToken = ref(0);
const searchInputRef = ref(null);
const searchModeMenuOpen = ref(false);
const comparisonBodyRef = ref(null);
const tableNavWidth = ref(readStoredComparisonTableNavWidth(null));
const tableNavHostWidth = ref(0);
const isTableNavResizing = ref(false);
let removeTableNavDragListeners = null;

const differenceFilterOptions = [
  { value: "all", label: "全部类型" },
  { value: "inserted", label: "新增" },
  { value: "updated", label: "修改" },
  { value: "deleted", label: "删除" },
  { value: "error", label: "异常" },
];
const fullFilterOptions = [
  ...differenceFilterOptions.slice(0, 4),
  { value: "unchanged", label: "未变化" },
  differenceFilterOptions[4],
];
const filterOptions = computed(() => (
  viewMode.value === "all" ? fullFilterOptions : differenceFilterOptions
));

const tableBySheet = computed(() =>
  new Map((props.comparison.tables || []).map((table) => [table.sheetName, table])),
);
const selectedTable = computed(() => tableBySheet.value.get(activeTable.value) || null);
const searchScopeTable = computed(() => (
  selectedTable.value
  || ((props.comparison.tables || []).length === 1 ? props.comparison.tables[0] : null)
));
const canSearchCurrentTable = computed(() => Boolean(searchScopeTable.value));
const { loadMore: loadFullRows, stateFor: fullStateFor } = useBatchComparisonFullRows(
  () => props.comparison,
);
const currentFullState = computed(() => (
  selectedTable.value ? fullStateFor(selectedTable.value) : null
));

const changeCount = computed(() =>
  Number(props.comparison.summary.inserted || 0)
  + Number(props.comparison.summary.updated || 0)
  + Number(props.comparison.summary.deleted || 0)
);
const statusNote = computed(() => {
  if (props.comparison.stale && props.comparison.status === "cancelled") {
    return "这是导入前未完成的对比结果";
  }
  if (props.comparison.stale) return "这是导入前的对比结果";
  if (props.comparison.status === "cancelled") return "对比已取消，仅显示已完成部分";
  return "";
});

function tableTotal(table, includeUnchanged = false) {
  const statuses = includeUnchanged
    ? ["inserted", "updated", "deleted", "unchanged", "errors"]
    : ["inserted", "updated", "deleted", "errors"];
  return statuses.reduce((sum, status) => sum + Number(table?.[status] || 0), 0);
}

const modeRows = computed(() => {
  if (viewMode.value === "differences") return props.comparison.rows || [];
  const table = selectedTable.value;
  if (!table) return [];
  const loaded = currentFullState.value?.rows || [];
  const errors = (props.comparison.rows || []).filter(
    (row) => row.sheetName === table.sheetName && row.status === "error",
  );
  return [...loaded, ...errors];
});

const filteredRows = computed(() => {
  return modeRows.value.filter((row) => {
    if (activeFilter.value !== "all" && row.status !== activeFilter.value) return false;
    if (activeTable.value && row.sheetName !== activeTable.value) return false;
    return true;
  });
});

const searchScopeRows = computed(() => {
  const table = searchScopeTable.value;
  if (!table) return [];
  return modeRows.value.filter((row) => (
    row.sheetName === table.sheetName
    && (activeFilter.value === "all" || row.status === activeFilter.value)
  ));
});
const searchScopeColumns = computed(() => searchScopeTable.value?.columns || []);
const searchScopeKey = computed(() => [
  props.comparison.runId,
  viewMode.value,
  searchScopeTable.value?.sheetName || "",
  activeFilter.value,
].join("\x1f"));

async function ensureCurrentSearchScopeComplete() {
  if (viewMode.value !== "all") {
    return { complete: !props.comparison.truncated, error: "" };
  }
  const table = searchScopeTable.value;
  if (!table) return { complete: true, error: "" };
  const searchText = query.value.trim();
  const sheetName = table.sheetName;
  const state = await loadFullComparisonToCompletion(
    table,
    loadFullRows,
    fullStateFor,
    () => (
      Boolean(searchText)
      && query.value.trim() === searchText
      && viewMode.value === "all"
      && searchScopeTable.value?.sheetName === sheetName
    ),
  );
  return { complete: state.complete, error: state.error };
}

const {
  query,
  mode: searchMode,
  activeSearchMatch,
  hasSearchMatches,
  searchHitSummary,
  searching: searchInProgress,
  error: searchError,
  runSearchNow,
  setMode: setSearchMode,
  goToNextSearchMatch,
  goToPreviousSearchMatch,
} = useBatchComparisonSearch({
  rows: searchScopeRows,
  columns: searchScopeColumns,
  showPrimaryKeys,
  scopeKey: searchScopeKey,
  canSearch: canSearchCurrentTable,
  prepareSearch: ensureCurrentSearchScopeComplete,
});

const searchModeLabel = computed(() => ({
  exact: "精确",
  continuous: "连续",
  fuzzy: "模糊",
})[searchMode.value]);
const searchModeItems = computed(() => ([
  {
    id: "continuous",
    label: "连续",
    hint: "单元格内连续包含整段文字",
    checkable: true,
    checked: searchMode.value === "continuous",
  },
  {
    id: "exact",
    label: "精确",
    hint: "单元格内容完全相等",
    checkable: true,
    checked: searchMode.value === "exact",
  },
  {
    id: "fuzzy",
    label: "模糊",
    hint: "允许字符分散出现或近似匹配",
    checkable: true,
    checked: searchMode.value === "fuzzy",
  },
]));

function filterCount(status) {
  const table = activeTable.value ? selectedTable.value : null;
  if (viewMode.value === "all") {
    if (!table) return 0;
    if (status === "all") return tableTotal(table, true);
    if (status === "error") return Number(table.errors || 0);
    return Number(table[status] || 0);
  }
  const summary = table || props.comparison.summary;
  if (status === "all") return tableTotal(summary, false);
  if (status === "error") return Number(summary.errors || 0);
  return Number(summary[status] || 0);
}

const visibleSections = computed(() => {
  const focusedSheet = isTableStage.value ? fullscreen.value.focusedSheet : "";
  const sections = [];
  for (const table of props.comparison.tables || []) {
    if (focusedSheet && table.sheetName !== focusedSheet) continue;
    if (!focusedSheet && activeTable.value && table.sheetName !== activeTable.value) continue;
    const rows = filteredRows.value.filter((row) => row.sheetName === table.sheetName);
    if (!rows.length && !focusedSheet) continue;
    sections.push({
      sheetName: table.sheetName,
      tableName: table.tableName || table.sheetName,
      columns: Array.isArray(table.columns) ? table.columns : [],
      columnWidthKey: [
        table.fullComparison?.connectionId,
        table.fullComparison?.database,
        table.tableName || table.sheetName,
      ].filter(Boolean).join("\x1f"),
      rows,
    });
  }
  return sections;
});

const focusedTable = computed(() =>
  tableBySheet.value.get(fullscreen.value.focusedSheet) || selectedTable.value,
);
const focusedTableName = computed(() =>
  focusedTable.value?.tableName || focusedTable.value?.sheetName || "",
);
const tableStageList = computed(() => props.comparison.tables || []);
const tableStageIndex = computed(() =>
  tableStageList.value.findIndex((table) => table.sheetName === fullscreen.value.focusedSheet),
);
const tableStageCounts = computed(() => {
  const table = focusedTable.value || {};
  return [
    { key: "inserted", label: "新增", value: Number(table.inserted || 0) },
    { key: "updated", label: "修改", value: Number(table.updated || 0) },
    { key: "deleted", label: "删除", value: Number(table.deleted || 0) },
    { key: "unchanged", label: "未变化", value: Number(table.unchanged || 0) },
    { key: "errors", label: "异常", value: Number(table.errors || 0) },
  ];
});

const visibleTableNavWidth = computed(() => (
  clampComparisonTableNavWidth(tableNavWidth.value, tableNavHostWidth.value)
));
const tableNavBodyStyle = computed(() => (
  isTableStage.value
    ? undefined
    : comparisonTableNavGridStyle(visibleTableNavWidth.value)
));
const tableNavResizerStyle = computed(() => (
  comparisonTableNavResizerStyle(visibleTableNavWidth.value)
));

function currentTableNavHostWidth() {
  const width = comparisonBodyRef.value?.getBoundingClientRect?.().width;
  return Number.isFinite(width) && width > 0 ? width : tableNavHostWidth.value;
}

function syncTableNavHostWidth() {
  tableNavHostWidth.value = currentTableNavHostWidth();
}

function loadTableNavWidth() {
  try {
    tableNavWidth.value = readStoredComparisonTableNavWidth(
      globalThis.localStorage?.getItem(COMPARISON_TABLE_NAV_WIDTH_STORAGE_KEY),
    );
  } catch {
    tableNavWidth.value = readStoredComparisonTableNavWidth(null);
  }
}

function saveTableNavWidth() {
  try {
    globalThis.localStorage?.setItem(
      COMPARISON_TABLE_NAV_WIDTH_STORAGE_KEY,
      String(tableNavWidth.value),
    );
  } catch {
    // Width persistence is optional; dragging still works for this view.
  }
}

function finishTableNavResize() {
  removeTableNavDragListeners?.();
  removeTableNavDragListeners = null;
  isTableNavResizing.value = false;
  globalThis.document?.body?.classList?.remove("wb-is-pane-resizing");
  if (globalThis.document?.body?.style) {
    globalThis.document.body.style.cursor = "";
    globalThis.document.body.style.userSelect = "";
  }
}

function onTableNavResizerPointerDown(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  finishTableNavResize();
  syncTableNavHostWidth();

  const rect = comparisonBodyRef.value?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0) return;

  isTableNavResizing.value = true;
  globalThis.document?.body?.classList?.add("wb-is-pane-resizing");
  if (globalThis.document?.body?.style) {
    globalThis.document.body.style.cursor = "col-resize";
    globalThis.document.body.style.userSelect = "none";
  }

  const onMove = (moveEvent) => {
    tableNavWidth.value = comparisonTableNavWidthFromClientX(moveEvent.clientX, rect);
  };
  const onUp = () => {
    finishTableNavResize();
    saveTableNavWidth();
  };

  globalThis.window?.addEventListener("pointermove", onMove);
  globalThis.window?.addEventListener("pointerup", onUp, { once: true });
  removeTableNavDragListeners = () => {
    globalThis.window?.removeEventListener("pointermove", onMove);
    globalThis.window?.removeEventListener("pointerup", onUp);
  };
}

function resetTableNavWidth() {
  tableNavWidth.value = readStoredComparisonTableNavWidth(null);
  saveTableNavWidth();
}

function onTableNavResizerKeydown(event) {
  if (event.key === "Home") {
    event.preventDefault();
    resetTableNavWidth();
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  syncTableNavHostWidth();
  tableNavWidth.value = comparisonTableNavWidthFromKey(
    visibleTableNavWidth.value,
    event.key,
    { shift: event.shiftKey, hostWidth: tableNavHostWidth.value },
  );
  saveTableNavWidth();
}

function sectionSummaryText(table) {
  const parts = [];
  if (Number(table?.inserted || 0)) parts.push(`新增 ${table.inserted}`);
  if (Number(table?.updated || 0)) parts.push(`修改 ${table.updated}`);
  if (Number(table?.deleted || 0)) parts.push(`删除 ${table.deleted}`);
  if (viewMode.value === "all" && Number(table?.unchanged || 0)) parts.push(`未变化 ${table.unchanged}`);
  if (Number(table?.errors || 0)) parts.push(`异常 ${table.errors}`);
  return parts.join(" · ");
}

function switchMode(mode) {
  viewMode.value = mode;
  activeFilter.value = "all";
  if (mode === "all" && !activeTable.value) {
    activeTable.value = props.comparison.tables?.[0]?.sheetName || "";
  }
}

function selectTable(sheetName) {
  activeTable.value = sheetName;
  activeFilter.value = "all";
  fullscreen.value = applyTableSelectionToFullscreen(fullscreen.value, sheetName);
}

function applyFullscreenResult(result) {
  if (result.restoreTable !== null) activeTable.value = result.restoreTable;
  else if (result.state.focusedSheet) activeTable.value = result.state.focusedSheet;
  fullscreen.value = result.state;
}

function isTableFocused(sheetName) {
  return isTableFullscreenFocused(fullscreen.value, sheetName);
}

function selectSearchMode(mode) {
  setSearchMode(mode);
  searchModeMenuOpen.value = false;
}

function focusComparisonSearch() {
  if (!canSearchCurrentTable.value) return;
  searchInputRef.value?.focus();
  searchInputRef.value?.select?.();
}

function onSearchShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || String(event.key).toLowerCase() !== "f") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  focusComparisonSearch();
}

async function loadSelectedFullRows() {
  const table = selectedTable.value;
  if (!table) return;
  await loadFullRows(table);
  if (query.value.trim()) await runSearchNow();
}

function toggleFullscreen() {
  applyFullscreenResult(toggleGlobalFullscreen(fullscreen.value));
}

function toggleTableFullscreen(sheetName) {
  applyFullscreenResult(nextTableFullscreen(fullscreen.value, sheetName, activeTable.value));
}

function exitTableStage() {
  applyFullscreenResult(applyExitFullscreen(fullscreen.value));
}

function focusAdjacentTable(delta) {
  const next = tableStageList.value[tableStageIndex.value + delta];
  if (!next) return;
  selectTable(next.sheetName);
}

function onFullscreenKeydown(event) {
  if (!isFullscreen.value || event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  applyFullscreenResult(applyExitFullscreen(fullscreen.value));
}

watch(isFullscreen, (open) => {
  document.documentElement.classList.toggle("wb-comparison-fullscreen-open", open);
  if (open) window.addEventListener("keydown", onFullscreenKeydown, true);
  else window.removeEventListener("keydown", onFullscreenKeydown, true);
  emit("fullscreen-change", open);
  nextTick(syncTableNavHostWidth);
});

watch(
  [viewMode, activeTable, () => props.comparison.runId],
  async ([mode, sheetName]) => {
    if (mode !== "all" || !sheetName) return;
    await nextTick();
    const table = selectedTable.value;
    if (table && !fullStateFor(table).rows.length) loadFullRows(table);
  },
);

onMounted(() => {
  loadTableNavWidth();
  nextTick(syncTableNavHostWidth);
  window.addEventListener("keydown", onSearchShortcut, true);
  window.addEventListener("resize", syncTableNavHostWidth);
});

watch(
  () => props.comparison.runId,
  () => {
    viewMode.value = "differences";
    showPrimaryKeys.value = true;
    fullscreen.value = resetTableComparisonFullscreen();
    activeFilter.value = "all";
    activeTable.value = "";
    query.value = "";
    searchModeMenuOpen.value = false;
    widthResetToken.value += 1;
  },
);

onBeforeUnmount(() => {
  finishTableNavResize();
  document.documentElement.classList.remove("wb-comparison-fullscreen-open");
  window.removeEventListener("keydown", onFullscreenKeydown, true);
  window.removeEventListener("keydown", onSearchShortcut, true);
  window.removeEventListener("resize", syncTableNavHostWidth);
  if (isFullscreen.value) emit("fullscreen-change", false);
});
</script>

<template>
  <Teleport to="body" :disabled="!isFullscreen">
    <section
      class="wb-batch-comparison"
      :class="{
        'is-fullscreen': isFullscreen && !isTableStage,
        'is-table-stage': isTableStage,
        'wb-floating-themed': isFullscreen,
      }"
      :data-theme="isFullscreen ? theme : undefined"
      :aria-label="isTableStage ? `表对比：${focusedTableName}` : '批量导入变化对比'"
    >
      <header v-if="isTableStage" class="wb-table-stage-bar" data-tauri-drag-region>
        <button type="button" class="wb-table-stage-back" @click="exitTableStage">
          <ArrowLeft :size="15" aria-hidden="true" />
          返回全部表
        </button>
        <div class="wb-table-stage-identity" data-tauri-drag-region>
          <strong>{{ focusedTableName }}</strong>
          <ul class="wb-table-stage-counts" aria-label="此表变化" data-tauri-drag-region>
            <li
              v-for="item in tableStageCounts"
              :key="item.key"
              :class="[`is-${item.key}`, { 'is-zero': !item.value }]"
            >
              <strong>{{ item.value }}</strong>{{ item.label }}
            </li>
          </ul>
        </div>
        <div v-if="tableStageList.length > 1" class="wb-table-stage-switch" role="group" aria-label="切换对比表">
          <button
            type="button"
            :disabled="tableStageIndex <= 0"
            aria-label="上一张表"
            title="上一张表"
            @click="focusAdjacentTable(-1)"
          >
            <ChevronLeft :size="15" aria-hidden="true" />
          </button>
          <span>{{ tableStageIndex + 1 }} / {{ tableStageList.length }}</span>
          <button
            type="button"
            :disabled="tableStageIndex >= tableStageList.length - 1"
            aria-label="下一张表"
            title="下一张表"
            @click="focusAdjacentTable(1)"
          >
            <ChevronRight :size="15" aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          class="wb-table-stage-close"
          aria-label="关闭此表对比"
          title="关闭此表对比"
          @click="exitTableStage"
        >
          <X :size="16" aria-hidden="true" />
        </button>
      </header>
      <div
        v-else
        class="wb-batch-comparison-summary"
        :class="`is-${comparison.status}`"
        :data-tauri-drag-region="isFullscreen || undefined"
      >
        <div><strong>{{ comparison.summary.inserted }}</strong><span>预计新增</span></div>
        <div><strong>{{ comparison.summary.updated }}</strong><span>预计修改</span></div>
        <div><strong>{{ comparison.summary.deleted }}</strong><span>预计删除</span></div>
        <div><strong>{{ comparison.summary.unchanged }}</strong><span>未变化</span></div>
        <div><strong>{{ comparison.summary.errors }}</strong><span>异常</span></div>
      </div>

      <div class="wb-batch-comparison-toolbar" :data-tauri-drag-region="isFullscreen || undefined">
        <div class="wb-batch-comparison-view-tools">
          <div class="wb-batch-comparison-mode" role="group" aria-label="对比范围">
            <button type="button" :class="{ 'is-active': viewMode === 'all' }" @click="switchMode('all')">全部行</button>
            <button type="button" :class="{ 'is-active': viewMode === 'differences' }" @click="switchMode('differences')">只看差别</button>
          </div>
          <label class="wb-batch-comparison-pk-toggle">
            <input v-model="showPrimaryKeys" type="checkbox" />
            <span>显示主键</span>
          </label>
        </div>

        <div class="wb-batch-comparison-filters" role="tablist" aria-label="变化类型">
          <button
            v-for="option in filterOptions"
            :key="option.value"
            type="button"
            role="tab"
            :class="{ 'is-active': activeFilter === option.value }"
            :aria-selected="activeFilter === option.value"
            @click="activeFilter = option.value"
          >
            {{ option.label }}
            <span>{{ filterCount(option.value) }}</span>
          </button>
        </div>

        <div
          class="wb-table-search-field wb-batch-comparison-search"
          :class="{
            'has-matches': hasSearchMatches,
            'is-searching': searchInProgress,
            'is-mode-open': searchModeMenuOpen,
          }"
        >
          <Search class="wb-table-search-field-icon" :size="14" aria-hidden="true" />
          <input
            ref="searchInputRef"
            v-model="query"
            type="search"
            class="wb-table-search-field-input"
            :disabled="!canSearchCurrentTable"
            :placeholder="isTableStage ? '搜索此表' : '搜索当前表'"
            :title="canSearchCurrentTable || isTableStage ? '' : '先在左侧选择一张表'"
            :aria-label="`搜索此表，当前使用${searchModeLabel}匹配`"
            @keydown.enter.prevent="goToNextSearchMatch"
          />
          <div class="wb-search-aux" aria-live="polite">
            <span v-if="searchInProgress" class="wb-batch-comparison-searching">搜索中</span>
            <span v-else-if="hasSearchMatches" class="wb-search-nav-inline" role="group" aria-label="命中导航">
              <button
                type="button"
                class="wb-search-nav-icon"
                aria-label="上一个匹配"
                title="上一个匹配"
                @click="goToPreviousSearchMatch"
              >
                <ChevronUp :size="13" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="wb-search-nav-icon"
                aria-label="下一个匹配"
                title="下一个匹配"
                @click="goToNextSearchMatch"
              >
                <ChevronDown :size="13" aria-hidden="true" />
              </button>
            </span>
            <span
              v-if="searchHitSummary.label && !searchInProgress"
              class="wb-search-hit-count"
              :title="`当前命中 / 命中总数：${searchHitSummary.label}`"
            >{{ searchHitSummary.label }}</span>
          </div>
          <ToolbarSplitButton
            class="wb-search-mode-control"
            :label="searchModeLabel"
            menu-label="搜索匹配方式"
            menu-class="wb-batch-comparison-search-menu"
            primary-opens-menu
            single-trigger
            :primary-disabled="!canSearchCurrentTable"
            :menu-disabled="!canSearchCurrentTable"
            :open="searchModeMenuOpen"
            :items="searchModeItems"
            @toggle="searchModeMenuOpen = !searchModeMenuOpen"
            @close="searchModeMenuOpen = false"
            @select="selectSearchMode"
          />
        </div>
        <div class="wb-batch-comparison-icon-actions">
          <button type="button" title="恢复默认列宽" aria-label="恢复默认列宽" @click="widthResetToken += 1">
            <RotateCcw :size="15" aria-hidden="true" />
          </button>
          <button
            v-if="!isTableStage"
            type="button"
            :title="isFullscreen ? '退出全屏' : '全屏对比'"
            :aria-label="isFullscreen ? '退出全屏' : '全屏对比'"
            @click="toggleFullscreen"
          >
            <Minimize2 v-if="isFullscreen" :size="15" aria-hidden="true" />
            <Maximize2 v-else :size="15" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        ref="comparisonBodyRef"
        class="wb-batch-comparison-body"
        :class="{ 'is-table-nav-resizing': isTableNavResizing }"
        :style="tableNavBodyStyle"
      >
        <nav v-if="!isTableStage" class="wb-batch-comparison-tables" aria-label="按目标表筛选">
          <button
            v-if="viewMode === 'differences'"
            type="button"
            :class="{ 'is-active': activeTable === '' }"
            @click="selectTable('')"
          >
            <span>全部目标表</span>
            <strong>{{ comparison.detailTotal }}</strong>
          </button>
          <button
            v-for="table in comparison.tables"
            :key="table.sheetName"
            type="button"
            :class="{ 'is-active': activeTable === table.sheetName }"
            :title="table.tableName"
            @click="selectTable(table.sheetName)"
          >
            <span>{{ table.tableName }}</span>
            <strong>{{ tableTotal(table, viewMode === "all") }}</strong>
          </button>
        </nav>
        <div
          v-if="!isTableStage"
          class="wb-batch-comparison-table-resizer"
          :style="tableNavResizerStyle"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          aria-label="调整目标表列表宽度"
          :aria-valuemin="MIN_COMPARISON_TABLE_NAV_WIDTH"
          :aria-valuemax="MAX_COMPARISON_TABLE_NAV_WIDTH"
          :aria-valuenow="visibleTableNavWidth"
          title="拖动调整表名单宽度，双击恢复默认"
          @pointerdown.stop.prevent="onTableNavResizerPointerDown"
          @dblclick.stop.prevent="resetTableNavWidth"
          @keydown="onTableNavResizerKeydown"
        ></div>

        <div class="wb-batch-comparison-details">
          <p v-if="statusNote" class="wb-batch-comparison-note" role="status">{{ statusNote }}</p>
          <p v-if="viewMode === 'differences' && comparison.truncated" class="wb-batch-comparison-note" role="status">
            明细显示前 {{ comparison.rows.length }} 条，共 {{ comparison.detailTotal }} 条变化或异常
          </p>
          <p v-if="viewMode !== 'all' && searchError" class="wb-batch-comparison-note is-error" role="status">
            {{ searchError }}
          </p>
          <div v-if="viewMode === 'all' && currentFullState" class="wb-batch-comparison-load-state" role="status">
            <span>已加载 {{ currentFullState.rows.length }} / {{ currentFullState.total }} 行</span>
            <span v-if="query && searchInProgress && !currentFullState.complete">正在读取剩余内容后搜索</span>
            <span v-if="currentFullState.error" class="is-error">{{ currentFullState.error }}</span>
            <span v-else-if="searchError" class="is-error">{{ searchError }}</span>
            <button
              v-if="!currentFullState.complete"
              type="button"
              :disabled="currentFullState.loading"
              @click="loadSelectedFullRows"
            >
              {{ currentFullState.loading ? "正在加载…" : (currentFullState.error ? "重试" : "继续加载") }}
            </button>
          </div>
          <template v-if="visibleSections.length">
            <section
              v-for="section in visibleSections"
              :key="section.sheetName"
              class="wb-batch-diff-section"
              :class="{ 'is-table-fullscreen': isTableFocused(section.sheetName) }"
            >
              <header v-if="!isTableStage" class="wb-batch-diff-section-header">
                <strong>{{ section.tableName }}</strong>
                <span>{{ sectionSummaryText(tableBySheet.get(section.sheetName) || {}) }}</span>
                <button
                  type="button"
                  class="wb-batch-diff-section-expand"
                  title="全屏查看此表"
                  :aria-label="`全屏查看 ${section.tableName}`"
                  @click="toggleTableFullscreen(section.sheetName)"
                >
                  <Maximize2 :size="15" aria-hidden="true" />
                </button>
              </header>
              <div class="wb-batch-diff-section-body">
                <BatchImportDiffGrid
                  :table-name="section.tableName"
                  :column-width-key="section.columnWidthKey"
                  :columns="section.columns"
                  :rows="section.rows"
                  :show-primary-keys="showPrimaryKeys"
                  :width-reset-token="widthResetToken"
                  :search-query="query"
                  :search-mode="searchMode"
                  :active-search-match="activeSearchMatch"
                />
              </div>
            </section>
          </template>
          <div v-else class="wb-batch-comparison-empty">
            <span v-if="viewMode === 'all' && currentFullState?.loading">正在读取完整数据…</span>
            <span v-else>{{ changeCount || comparison.summary.errors || viewMode === "all" ? "当前范围没有数据" : "没有需要写入的变化" }}</span>
          </div>
        </div>
      </div>
    </section>
  </Teleport>
</template>
