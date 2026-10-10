<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, toRaw, watch } from "vue";
import { Search } from "lucide-vue-next";
import {
  sidebarValueResultsAreFresh,
  valueSearchProgressPercent,
} from "../sidebarSearchState.js";
import { buildSchemaSearchResults } from "../workspaceState.js";
import {
  QUICK_OPEN_RESULT_BATCH_SIZE,
  advanceQuickOpenResultWindow,
  clampQuickOpenSize,
  createQuickOpenResultWindow,
  createQuickOpenScopeState,
  ensureQuickOpenResultMounted,
  loadQuickOpenSize,
  quickOpenIncludedTables,
  quickOpenResultRange,
  quickOpenScopeTableSelected,
  resetQuickOpenScopeToResults,
  resetQuickOpenResultWindow,
  saveQuickOpenSize,
  scaleQuickOpenSize,
  toggleQuickOpenScopeTable,
} from "../quickOpenState.js";
import { columnName } from "../utils/normalize.js";
import {
  highlightSearchExcerpt,
  highlightSearchRanges,
  highlightSearchText,
  matchSearchText,
} from "../utils/searchMatch.js";
import { useEscClose } from "../composables/useEscClose.js";
import SearchHitBadge from "./SearchHitBadge.vue";
import { searchKindLabel } from "../utils/searchKindLabels.js";
import QuickOpenKindFilter from "./QuickOpenKindFilter.vue";

const props = defineProps({
  visible: { type: Boolean, default: false },
  query: { type: String, default: "" },
  connectionId: { type: String, default: "" },
  database: { type: String, default: "" },
  tables: { type: Array, default: () => [] },
  schema: { type: Array, default: () => [] },
  // 当前连接下的库列表（用于回退展示与一致性校验）
  databases: { type: Array, default: () => [] },
  // 所有连接（用于跨连接常驻库标注 + 切连接）
  connections: { type: Array, default: () => [] },
  // 常驻库列表 [{ connectionId, database }]，跨连接混合
  pinnedDatabases: { type: Array, default: () => [] },
  // 跨连接库缓存：{ [connectionId]: string[] }，由浮层打开时预拉取填充，
  // 供「连接 → 库」级联子菜单即时展示，无需切换当前连接即可预览。
  databasesByConnection: { type: Object, default: () => ({}) },
  // 跨连接库拉取错误：{ [connectionId]: { message, needsReconnect } }
  databaseFetchErrors: { type: Object, default: () => ({}) },
  // 连接显示名取值函数 (connectionId, fallback) => label
  connectionLabel: { type: Function, default: (id, fallback) => fallback || id || "" },
  // 库显示名取值函数 (connectionId, database) => label
  databaseLabel: { type: Function, default: (id, db) => db || "" },
  valueSearchState: { type: Object, default: () => ({}) },
  // 当前主题（浮层 Teleport 到 body，不能复用完整 .mysql-workbench
  // 壳层布局；用轻量主题类承接 --wb-* 深色覆盖）
  theme: { type: String, default: "light" },
});

const emit = defineEmits([
  "update:visible",
  "update:query",
  "open-table",
  "select-database",
  "toggle-pin-database",
  "reconnect-connection",
  "search-values",
  "cancel-search-values",
  "open-value-result",
]);

const inputRef = ref(null);
const valueInputRef = ref(null);
const listRef = ref(null);
const selectedIndex = ref(0);
const valueQuery = ref("");
const matchMode = ref("fuzzy");
const scopeMatchKind = ref("all");
const scopeState = reactive(createQuickOpenScopeState());
const resultWindow = reactive(createQuickOpenResultWindow());
const cardSize = ref({ width: 760, height: 520 });
const cardRef = ref(null);
const resizingAxis = ref("");
const dbDropdownOpen = ref(false);
const scopeBtnRef = ref(null);
const dbDropdownRef = ref(null);
const dbDropdownPos = ref({ left: 0, top: 0, width: 0 });
// 级联子菜单当前 hover 的连接 id。打开下拉时默认指向当前连接，让用户立即看到
// 当前连接的库列表，无需先 hover。
const hoveredConnectionId = ref("");
// 左栏连接被点击后保持的“选中”id。hover 会即时联动，但点击后即使鼠标离开也保留
// 选中痕迹，让用户明确知道右栏当前展示的是哪个连接的库。
const selectedConnectionId = ref("");

const dbDropdownStyle = computed(() => ({
  left: `${dbDropdownPos.value.left}px`,
  top: `${dbDropdownPos.value.top}px`,
  width: `${dbDropdownPos.value.width}px`,
}));

const hasQuery = computed(() => props.query.trim().length > 0);
const searchTextMode = computed(() => (matchMode.value === "continuous" ? "contains" : "fuzzy"));
const scopeIncludedKinds = computed(() => (
  scopeMatchKind.value === "all" ? null : [scopeMatchKind.value]
));
const results = shallowRef([]);
const renderedQuery = ref("");
const searchRunning = ref(false);
const QUICK_OPEN_SEARCH_CHUNK_SIZE = 80;
let resultBuildToken = 0;

function yieldQuickOpenSearch() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function compareSchemaResults(left, right) {
  return left.rank - right.rank || left.score - right.score || left.index - right.index;
}

async function rebuildResults() {
  const token = ++resultBuildToken;
  if (!props.visible) {
    searchRunning.value = false;
    results.value = [];
    return;
  }
  // Schema entries are immutable for the duration of one query. Searching the
  // raw tree avoids tens of thousands of deep reactive proxy reads on wide
  // databases; query/visibility changes still invalidate this computed value.
  const schema = toRaw(props.schema);
  const query = props.query.trim();
  if (!query) {
    searchRunning.value = false;
    renderedQuery.value = "";
    results.value = schema.map((table) => ({
      table,
      matchKind: "tableName",
      visibleColumns: [],
      matchedColumns: [],
      hiddenColumnCount: 0,
    }));
    return;
  }

  searchRunning.value = true;
  const nextResults = [];
  for (let offset = 0; offset < schema.length; offset += QUICK_OPEN_SEARCH_CHUNK_SIZE) {
    const chunk = buildSchemaSearchResults(
      schema.slice(offset, offset + QUICK_OPEN_SEARCH_CHUNK_SIZE),
      query,
      {
        mode: searchTextMode.value,
        includedKinds: scopeIncludedKinds.value,
        matchedColumnLimit: 3,
      },
    );
    for (const result of chunk) nextResults.push({ ...result, index: result.index + offset });
    if (offset + QUICK_OPEN_SEARCH_CHUNK_SIZE < schema.length) {
      await yieldQuickOpenSearch();
      if (token !== resultBuildToken) return;
    }
  }
  if (token !== resultBuildToken) return;
  renderedQuery.value = query;
  results.value = nextResults.sort(compareSchemaResults);
  searchRunning.value = false;
}

watch(
  [() => props.visible, () => props.query, () => props.schema, searchTextMode, scopeIncludedKinds],
  () => { void rebuildResults(); },
  { immediate: true },
);
const hasFreshValues = computed(() => sidebarValueResultsAreFresh(props.valueSearchState || {}));
const visibleValueResults = computed(() => (hasFreshValues.value ? props.valueSearchState?.valueResults || [] : []));
const resultWindowRange = computed(() => quickOpenResultRange(resultWindow, results.value.length));
const mountedResults = computed(() => results.value.slice(resultWindowRange.value.start, resultWindowRange.value.end));
const excludedScopeTables = computed(() => new Set(scopeState.excludedTables));
const selectedScopeCount = computed(() => {
  if (!hasQuery.value) return props.schema.length;
  if (!scopeState.excludedTables.length) return results.value.length;
  let excludedCount = 0;
  for (const result of results.value) {
    if (excludedScopeTables.value.has(tableName(result.table))) excludedCount += 1;
  }
  return Math.max(0, results.value.length - excludedCount);
});
const valueSearchScopeEmpty = computed(() => (
  hasQuery.value && !searchRunning.value && selectedScopeCount.value === 0
));
const valueSearchDisabled = computed(() => searchRunning.value || valueSearchScopeEmpty.value);
const cardStyle = computed(() => ({ width: `${cardSize.value.width}px`, height: `${cardSize.value.height}px` }));
const progressPercent = computed(() => valueSearchProgressPercent(props.valueSearchState || {}));
const progressStyle = computed(() => ({ "--wb-value-search-progress-width": `${progressPercent.value}%` }));
const progressLabel = computed(() => {
  const progress = props.valueSearchState?.valueProgress || {};
  const done = Number(progress.done) || 0;
  const total = Number(progress.total) || 0;
  const matches = Number(progress.matches) || 0;
  if (!total) return t("search.valueProgressPending", { matches });
  return t("search.valueProgress", { done, total, matches });
});
const emptyResultLabel = computed(() =>
  hasFreshValues.value ? t("search.noValueMatches") : t("search.noSchemaMatches"),
);

// 常驻库里属于其它连接的（跨连接展示，标注连接名）
const crossConnectionPinned = computed(() =>
  (props.pinnedDatabases || []).filter(
    (e) => String(e.connectionId) !== String(props.connectionId),
  ),
);

// 常驻库里属于当前连接的（与当前连接库区同源，但单列更直观）
const currentConnectionPinned = computed(() =>
  (props.pinnedDatabases || []).filter(
    (e) => String(e.connectionId) === String(props.connectionId),
  ),
);

// 下拉第一层：所有可见连接。当前连接置顶，其余按 label 排序。
// 每行附带 kind、是否当前、是否需要重新连接、错误信息，供左栏渲染与右栏分支。
const connectionRows = computed(() => {
  const rows = (props.connections || []).map((conn) => {
    const id = String(conn?.id || "");
    const err = props.databaseFetchErrors?.[id];
    return {
      id,
      label: connLabel(id) || id,
      kind: conn?.kind || "",
      isCurrent: id === String(props.connectionId),
      needsReconnect: Boolean(err?.needsReconnect),
      error: err?.message || "",
    };
  });
  return rows.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return a.label.localeCompare(b.label, "zh");
  });
});

// 右栏要展示的库列表：hover 连接的缓存库列表。
// 优先用预拉取缓存；若该连接恰好是当前连接且缓存尚未命中，回退到 props.databases。
const databasesForHoveredConnection = computed(() => {
  const id = String(hoveredConnectionId.value || "");
  if (!id) return [];
  const cached = props.databasesByConnection?.[id];
  if (Array.isArray(cached) && cached.length) return cached;
  if (id === String(props.connectionId)) return props.databases || [];
  return [];
});

const hoveredConnectionError = computed(() => {
  const id = String(hoveredConnectionId.value || "");
  if (!id) return null;
  return props.databaseFetchErrors?.[id] || null;
});

const hasAnyDatabase = computed(
  () => currentConnectionPinned.value.length || crossConnectionPinned.value.length || connectionRows.value.length > 0,
);

function tableName(table) {
  return table?.tableName || table?.table_name || "";
}
function tableComment(table) {
  return table?.tableComment || table?.table_comment || "";
}
function columnComment(column) {
  return column?.column_comment || column?.columnComment || "";
}
function matchKindLabel(kind) {
  return searchKindLabel(kind);
}
function columnHitLabel(column, result) {
  return matchKindLabel(column?.searchMatchKind || result?.matchKind || "columnName");
}
function highlightMatch(value, match, semanticKind) {
  const matchedKind = match?.searchMatchKind || match?.matchKind || "";
  if (matchedKind === semanticKind && Array.isArray(match?.searchMatchRanges) && match.searchMatchRanges.length) {
    return highlightSearchRanges(value, match.searchMatchRanges);
  }
  return highlightSearchText(value, renderedQuery.value, { mode: searchTextMode.value });
}
function highlightCommentMatch(value, match, semanticKind) {
  const matchedKind = match?.searchMatchKind || match?.matchKind || "";
  if (matchedKind === semanticKind && Array.isArray(match?.searchMatchRanges) && match.searchMatchRanges.length) {
    return highlightSearchExcerpt(value, match.searchMatchRanges, 58);
  }
  const fallback = matchSearchText(value, renderedQuery.value, { mode: searchTextMode.value });
  return fallback.matched
    ? highlightSearchExcerpt(value, fallback.ranges, 58)
    : highlightSearchText(value, renderedQuery.value, { mode: searchTextMode.value });
}
function highlightValue(value) {
  return highlightSearchText(value, valueQuery.value || props.valueSearchState?.valueSearchedQuery || "", { mode: "contains" });
}

function connLabel(connectionId) {
  const conn = props.connections?.find((c) => String(c.id) === String(connectionId));
  return props.connectionLabel(connectionId, conn?.label || connectionId || "");
}
function dbLabel(connectionId, database) {
  return props.databaseLabel(connectionId, database) || database || "";
}
function isPinned(connectionId, database) {
  return props.pinnedDatabases.some(
    (e) => String(e.connectionId) === String(connectionId) && String(e.database) === String(database),
  );
}

watch(results, (list) => {
  selectedIndex.value = list.length ? 0 : -1;
  resetQuickOpenResultWindow(resultWindow, list.length);
});

watch(() => props.visible, async (open) => {
  if (!open) {
    emit("update:query", "");
    valueQuery.value = "";
    scopeState.mode = "auto";
    scopeState.excludedTables = [];
    resetQuickOpenResultWindow(resultWindow, 0);
    matchMode.value = "fuzzy";
    scopeMatchKind.value = "all";
    selectedIndex.value = 0;
    dbDropdownOpen.value = false;
    selectedConnectionId.value = "";
    return;
  }
  lastViewport = viewportSize();
  cardSize.value = loadQuickOpenSize(globalThis.localStorage, lastViewport);
  await nextTick();
  inputRef.value?.focus?.();
  inputRef.value?.select?.();
});

function close() {
  emit("update:visible", false);
}

useEscClose(
  () => props.visible,
  close,
  () => Boolean(props.valueSearchState?.valueLoading),
  { dialogRef: cardRef },
);

useEscClose(
  () => props.visible && dbDropdownOpen.value,
  () => {
    dbDropdownOpen.value = false;
    nextTick(() => scopeBtnRef.value?.focus?.());
  },
  null,
  { dialogRef: dbDropdownRef, restoreFocus: false },
);

function setMatchMode(mode) {
  matchMode.value = mode === "continuous" ? "continuous" : "fuzzy";
  nextTick(() => inputRef.value?.focus?.());
}

function activateSchemaResult(result) {
  if (searchRunning.value) return;
  const table = result?.table?.raw || result?.table;
  if (!table) return;
  emit("open-table", { table, matchResult: result });
  close();
}

function activateItem(item) {
  if (!item) return;
  if (item.kind === "value") {
    emit("open-value-result", item.result);
    close();
    return;
  }
  activateSchemaResult(item.result);
}

function isScopeTableSelected(name) {
  return quickOpenScopeTableSelected(scopeState, name, hasQuery.value);
}

function toggleScopeTable(name, checked) {
  if (searchRunning.value) return;
  toggleQuickOpenScopeTable(scopeState, name, checked);
}

function resetScopeSelection() {
  resetQuickOpenScopeToResults(scopeState);
}

function runValueSearch() {
  const query = valueQuery.value.trim();
  if (!query || valueSearchDisabled.value || props.valueSearchState?.valueLoading) return;
  emit("search-values", {
    query,
    includedTables: quickOpenIncludedTables(
      scopeState,
      results.value.map((result) => tableName(result.table)),
      hasQuery.value,
    ),
  });
}

function selectDatabase(connectionId, database) {
  if (!database) return;
  emit("select-database", { connectionId, database });
  dbDropdownOpen.value = false;
  // 保持浮窗打开，方便用户继续搜索新数据库的表；清空搜索词并同步选中连接
  emit("update:query", "");
  selectedConnectionId.value = String(connectionId || "");
  hoveredConnectionId.value = String(connectionId || "");
  nextTick(() => inputRef.value?.focus?.());
}

function togglePin(connectionId, database, event) {
  event?.stopPropagation();
  emit("toggle-pin-database", { connectionId, database });
}

function toggleDbDropdown() {
  if (dbDropdownOpen.value) {
    dbDropdownOpen.value = false;
    return;
  }
  // 计算下拉定位：紧贴 scope 按钮下方，宽度对齐浮层卡片
  const el = scopeBtnRef.value;
  if (el && typeof el.getBoundingClientRect === "function") {
    const rect = el.getBoundingClientRect();
    // 宽度用浮层卡片宽度，左对齐卡片内容区；级联两栏需要更宽，取卡片宽度与最小宽度的较大者
    const card = el.closest(".wb-quick-open");
    const cardRect = card?.getBoundingClientRect();
    const cardWidth = cardRect ? cardRect.width - 20 : Math.max(220, rect.width);
    const width = Math.max(cardWidth, 360);
    dbDropdownPos.value = {
      left: cardRect ? cardRect.left + 10 : rect.left,
      top: rect.bottom + 4,
      width,
    };
  }
  // 打开时默认 hover 并选中当前连接，右栏立即展示当前连接库列表
  const initialId = String(props.connectionId || "");
  hoveredConnectionId.value = initialId;
  selectedConnectionId.value = initialId;
  dbDropdownOpen.value = true;
}

function reconnectHoveredConnection() {
  emit("reconnect-connection", { connectionId: hoveredConnectionId.value });
  dbDropdownOpen.value = false;
  close();
}

function ensureSelectedVisible() {
  nextTick(() => {
    const list = listRef.value;
    if (!list) return;
    const item = list.querySelector('[data-active="true"]');
    if (item) item.scrollIntoView({ block: "nearest" });
  });
}

let resultWindowAdjusting = false;

async function shiftResultWindow(direction, list) {
  if (!list || resultWindowAdjusting) return;
  const previous = quickOpenResultRange(resultWindow, results.value.length);
  const retainedIndex = direction === "down"
    ? Math.min(previous.end - 1, previous.start + QUICK_OPEN_RESULT_BATCH_SIZE)
    : previous.start;
  const retained = list.querySelector(`[data-result-index="${retainedIndex}"]`);
  const retainedViewportOffset = retained ? retained.offsetTop - list.scrollTop : null;
  resultWindowAdjusting = true;
  const changed = advanceQuickOpenResultWindow(resultWindow, results.value.length, direction);
  if (!changed) {
    resultWindowAdjusting = false;
    return;
  }
  await nextTick();
  const nextRange = quickOpenResultRange(resultWindow, results.value.length);
  if (nextRange.start !== previous.start && retainedViewportOffset !== null) {
    const nextRetained = list.querySelector(`[data-result-index="${retainedIndex}"]`);
    if (nextRetained) list.scrollTop = Math.max(0, nextRetained.offsetTop - retainedViewportOffset);
  }
  const release = () => { resultWindowAdjusting = false; };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(release);
  else setTimeout(release, 0);
}

function handleResultsScroll(event) {
  const list = event.currentTarget;
  if (!list || resultWindowAdjusting) return;
  if (list.scrollTop <= 16 && resultWindowRange.value.start > 0) {
    void shiftResultWindow("up", list);
    return;
  }
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 24) {
    void shiftResultWindow("down", list);
  }
}

function selectResultIndex(index) {
  selectedIndex.value = index;
  ensureQuickOpenResultMounted(resultWindow, index, results.value.length);
  ensureSelectedVisible();
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    if (dbDropdownOpen.value) {
      event.preventDefault();
      dbDropdownOpen.value = false;
      return;
    }
    if (props.valueSearchState?.valueLoading) {
      emit("cancel-search-values");
      event.preventDefault();
      return;
    }
    event.preventDefault();
    close();
    return;
  }
  // 数据库下拉打开时，不处理表列表的键盘导航
  if (dbDropdownOpen.value) return;
  // The visible rows still belong to the previous query while a chunked
  // search is running. Keep them stable, but never activate stale results.
  if (searchRunning.value) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!results.value.length) return;
    selectResultIndex((selectedIndex.value + 1) % results.value.length);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!results.value.length) return;
    selectResultIndex((selectedIndex.value - 1 + results.value.length) % results.value.length);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    activateSchemaResult(results.value[selectedIndex.value]);
  }
}

function handleValueKeydown(event) {
  if (event.key === "Escape") {
    if (props.valueSearchState?.valueLoading) {
      event.preventDefault();
      emit("cancel-search-values");
      return;
    }
    event.preventDefault();
    close();
    return;
  }
  if (event.key === "Enter" && !event.isComposing && !event.repeat) {
    event.preventDefault();
    runValueSearch();
  }
}

function viewportSize() {
  return { width: globalThis.innerWidth || 1024, height: globalThis.innerHeight || 768 };
}

let lastViewport = viewportSize();
let finishActiveResize = null;

function clampToViewport() {
  const nextViewport = viewportSize();
  cardSize.value = resizingAxis.value
    ? clampQuickOpenSize(cardSize.value, nextViewport)
    : scaleQuickOpenSize(cardSize.value, lastViewport, nextViewport);
  lastViewport = nextViewport;
}

function startResize(event, axis) {
  event.preventDefault();
  event.stopPropagation();
  finishActiveResize?.();
  const handle = event.currentTarget;
  const pointerId = event.pointerId;
  const start = { x: event.clientX, y: event.clientY, ...cardSize.value };
  const cursor = axis === "x" ? "ew-resize" : axis === "y" ? "ns-resize" : "nwse-resize";
  resizingAxis.value = axis;
  handle?.setPointerCapture?.(pointerId);
  if (globalThis.document?.body?.style) {
    globalThis.document.body.style.cursor = cursor;
    globalThis.document.body.style.userSelect = "none";
  }
  const move = (moveEvent) => {
    const samples = moveEvent.getCoalescedEvents?.();
    const latest = samples?.length ? samples[samples.length - 1] : moveEvent;
    cardSize.value = clampQuickOpenSize({
      width: axis.includes("x") ? start.width + latest.clientX - start.x : start.width,
      height: axis.includes("y") ? start.height + latest.clientY - start.y : start.height,
    }, viewportSize());
  };
  const stop = () => {
    globalThis.removeEventListener?.("pointermove", move);
    globalThis.removeEventListener?.("pointerup", stop);
    globalThis.removeEventListener?.("pointercancel", stop);
    handle?.removeEventListener?.("lostpointercapture", stop);
    if (handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    resizingAxis.value = "";
    lastViewport = viewportSize();
    saveQuickOpenSize(cardSize.value, globalThis.localStorage, lastViewport);
    if (globalThis.document?.body?.style) {
      globalThis.document.body.style.cursor = "";
      globalThis.document.body.style.userSelect = "";
    }
    if (finishActiveResize === stop) finishActiveResize = null;
  };
  finishActiveResize = stop;
  globalThis.addEventListener?.("pointermove", move);
  globalThis.addEventListener?.("pointerup", stop);
  globalThis.addEventListener?.("pointercancel", stop);
  handle?.addEventListener?.("lostpointercapture", stop);
}

onMounted(() => globalThis.addEventListener?.("resize", clampToViewport));
onBeforeUnmount(() => {
  resultBuildToken += 1;
  finishActiveResize?.();
  globalThis.removeEventListener?.("resize", clampToViewport);
});

</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="wb-quick-open-overlay wb-floating-themed"
      :data-theme="theme"
      role="dialog"
      aria-modal="true"
      :aria-label="t('m_c5c9896dae48')"
    >
      <div ref="cardRef" class="wb-quick-open" :class="{ 'is-resizing': resizingAxis }" :style="cardStyle" tabindex="-1" @mousedown.stop>
        <div class="wb-quick-open-header">
          <button
            ref="scopeBtnRef"
            type="button"
            class="wb-quick-open-scope-btn"
            :class="{ 'is-open': dbDropdownOpen }"
            :aria-expanded="dbDropdownOpen ? 'true' : 'false'"
            :title="database ? `当前：${connLabel(connectionId)} / ${database}` : t('m_7d5d498a63e8')"
            @click="toggleDbDropdown"
          >
            <svg class="wb-quick-open-scope-db-icon" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
              <ellipse cx="7" cy="3.2" rx="4.5" ry="1.6" />
              <path d="M2.5 3.2v7.6c0 .9 2 1.6 4.5 1.6s4.5-.7 4.5-1.6V3.2" />
              <path d="M2.5 7c0 .9 2 1.6 4.5 1.6s4.5-.7 4.5-1.6" />
            </svg>
            <span class="wb-quick-open-scope-label">{{ database || t('m_7d5d498a63e8') }}</span>
            <svg class="wb-quick-open-scope-caret" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="2,3.5 5,6.5 8,3.5" />
            </svg>
          </button>
          <div class="wb-quick-open-search-field">
            <Search class="wb-quick-open-search-icon" :size="17" :stroke-width="1.8" aria-hidden="true" />
            <input
              ref="inputRef"
              :value="query"
              autocomplete="off"
              spellcheck="false"
              :placeholder="tables.length ? t('m_0ada9390aa84') : t('m_b0ae2ecf1ac5')"
              :aria-label="t('m_4932987e6d33')"
              aria-controls="wb-quick-open-list"
              @input="emit('update:query', $event.target.value)"
              @keydown="handleKeydown"
            />
          </div>
          <div class="wb-quick-open-match-mode" role="group" :aria-label="t('m_3c6aaeb415f7')">
            <button
              type="button"
              :class="{ 'is-active': matchMode === 'fuzzy' }"
              :aria-pressed="matchMode === 'fuzzy' ? 'true' : 'false'"
              :title="t('m_cdad9e7103ea')"
              @click="setMatchMode('fuzzy')"
            >{{ t('m_36bab7a3de7f') }}</button>
            <button
              type="button"
              :class="{ 'is-active': matchMode === 'continuous' }"
              :aria-pressed="matchMode === 'continuous' ? 'true' : 'false'"
              :title="t('m_08461057b9ae')"
              @click="setMatchMode('continuous')"
            >{{ t('m_53b333e7b09d') }}</button>
          </div>
          <button
            type="button"
            class="wb-quick-open-close"
            :aria-label="t('m_3fd47edce45b')"
            tabindex="-1"
            @click="close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3l8 8M11 3L3 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>

          <!-- 数据库切换下拉（Teleport 到 body，避免被 .wb-quick-open overflow:hidden 裁切） -->
          <Teleport to="body">
            <div
              v-if="dbDropdownOpen"
              ref="dbDropdownRef"
              class="wb-quick-open-db-dropdown wb-floating-themed"
              :data-theme="theme"
              :style="dbDropdownStyle"
              role="listbox"
              :aria-label="t('m_9fa99195c7c0')"
              tabindex="-1"
              @mousedown.stop
            >
            <!-- 常驻库（当前连接 + 跨连接混合）：一键快速切换，无需钻进连接子菜单 -->
            <div v-if="currentConnectionPinned.length || crossConnectionPinned.length" class="wb-quick-open-db-pinned">
              <header class="wb-quick-open-db-section-title">{{ t('m_300b6634fef3') }}</header>
              <button
                v-for="entry in currentConnectionPinned"
                :key="`pin-${entry.connectionId}-${entry.database}`"
                type="button"
                class="wb-quick-open-db-item"
                :class="{ 'is-selected': entry.database === database && String(entry.connectionId) === String(connectionId) }"
                role="option"
                :aria-selected="entry.database === database && String(entry.connectionId) === String(connectionId) ? 'true' : 'false'"
                :title="`${connLabel(entry.connectionId)} / ${dbLabel(entry.connectionId, entry.database)}`"
                @click="selectDatabase(entry.connectionId, entry.database)"
              >
                <span class="wb-quick-open-db-name">{{ dbLabel(entry.connectionId, entry.database) }}</span>
                <span class="wb-quick-open-db-conn">{{ connLabel(entry.connectionId) }}</span>
                <svg
                  class="wb-quick-open-db-pin is-pinned"
                  width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"
                  :title="t('m_a9f57bff3578')"
                  @click="togglePin(entry.connectionId, entry.database, $event)"
                ><path d="M9.5 1.5l3 3-2 1.2-.8 3.5-2-2-3 3-.7-.7 3-3-2-2 3.5-.8z"/></svg>
              </button>
              <button
                v-for="entry in crossConnectionPinned"
                :key="`pin-${entry.connectionId}-${entry.database}`"
                type="button"
                class="wb-quick-open-db-item"
                :class="{ 'is-selected': entry.database === database && String(entry.connectionId) === String(connectionId) }"
                role="option"
                :aria-selected="entry.database === database && String(entry.connectionId) === String(connectionId) ? 'true' : 'false'"
                :title="`${connLabel(entry.connectionId)} / ${dbLabel(entry.connectionId, entry.database)}`"
                @click="selectDatabase(entry.connectionId, entry.database)"
              >
                <span class="wb-quick-open-db-name">{{ dbLabel(entry.connectionId, entry.database) }}</span>
                <span class="wb-quick-open-db-conn">{{ connLabel(entry.connectionId) }}</span>
                <svg
                  class="wb-quick-open-db-pin is-pinned"
                  width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"
                  :title="t('m_a9f57bff3578')"
                  @click="togglePin(entry.connectionId, entry.database, $event)"
                ><path d="M9.5 1.5l3 3-2 1.2-.8 3.5-2-2-3 3-.7-.7 3-3-2-2 3.5-.8z"/></svg>
              </button>
            </div>

            <!-- 级联两栏：左栏连接列表，右栏 hover 连接的库列表 -->
            <div v-if="connectionRows.length" class="wb-quick-open-db-cascade">
              <header v-if="currentConnectionPinned.length || crossConnectionPinned.length" class="wb-quick-open-db-section-title">{{ t('m_3af17da71ef0') }}</header>
              <div class="wb-quick-open-db-cascade-body">
                <!-- 左栏：连接 -->
                <ul class="wb-quick-open-db-conn-list" role="list">
                  <li
                    v-for="conn in connectionRows"
                    :key="conn.id"
                    class="wb-quick-open-db-conn-item"
                    :class="{
                      'is-current': conn.isCurrent,
                      'is-hovered': conn.id === hoveredConnectionId,
                      'is-selected': conn.id === selectedConnectionId,
                      'needs-reconnect': conn.needsReconnect,
                    }"
                    role="presentation"
                    @mouseenter="hoveredConnectionId = conn.id"
                    @focus="hoveredConnectionId = conn.id"
                    @click="hoveredConnectionId = conn.id; selectedConnectionId = conn.id"
                  >
                    <span class="wb-quick-open-db-conn-label">{{ conn.label }}</span>
                    <svg
                      v-if="conn.needsReconnect"
                      class="wb-quick-open-db-conn-warn"
                      width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"
                      :title="t('m_2a7573e8891b')"
                    ><path d="M6 1.5L11 10.5H1z"/><line x1="6" y1="5" x2="6" y2="7.5"/><circle cx="6" cy="9" r="0.4" fill="currentColor"/></svg>
                  </li>
                </ul>
                <!-- 右栏：hover 连接的库 -->
                <div class="wb-quick-open-db-submenu" role="listbox" :aria-label="`${connLabel(hoveredConnectionId)} 的数据库`">
                  <template v-if="hoveredConnectionError?.needsReconnect">
                    <p class="wb-quick-open-db-empty">{{ hoveredConnectionError.message }}</p>
                    <button
                      type="button"
                      class="wb-quick-open-db-reconnect"
                      @click="reconnectHoveredConnection"
                    >{{ t('m_68891ab35cab') }}</button>
                  </template>
                  <template v-else-if="hoveredConnectionError">
                    <p class="wb-quick-open-db-empty">{{ hoveredConnectionError.message }}</p>
                  </template>
                  <template v-else-if="databasesForHoveredConnection.length">
                    <button
                      v-for="db in databasesForHoveredConnection"
                      :key="`db-${hoveredConnectionId}-${db}`"
                      type="button"
                      class="wb-quick-open-db-item"
                      :class="{ 'is-selected': db === database && String(hoveredConnectionId) === String(connectionId) }"
                      role="option"
                      :aria-selected="db === database && String(hoveredConnectionId) === String(connectionId) ? 'true' : 'false'"
                      :title="dbLabel(hoveredConnectionId, db)"
                      @click="selectDatabase(hoveredConnectionId, db)"
                    >
                      <span class="wb-quick-open-db-name">{{ dbLabel(hoveredConnectionId, db) }}</span>
                      <svg
                        class="wb-quick-open-db-pin"
                        :class="{ 'is-pinned': isPinned(hoveredConnectionId, db) }"
                        width="13" height="13" viewBox="0 0 14 14"
                        :fill="isPinned(hoveredConnectionId, db) ? 'currentColor' : 'none'"
                        stroke="currentColor" stroke-width="1.3" aria-hidden="true"
                        :title="isPinned(hoveredConnectionId, db) ? t('m_a9f57bff3578') : t('m_7fc29c837b7b')"
                        @click="togglePin(hoveredConnectionId, db, $event)"
                      ><path d="M9.5 1.5l3 3-2 1.2-.8 3.5-2-2-3 3-.7-.7 3-3-2-2 3.5-.8z"/></svg>
                    </button>
                  </template>
                  <p v-else class="wb-quick-open-db-empty">{{ t('m_5de336bcef14') }}</p>
                </div>
              </div>
            </div>

            <p v-if="!hasAnyDatabase" class="wb-quick-open-db-empty"> {{ t('m_b04ccd016069') }} </p>
          </div>
          </Teleport>
        </div>

        <div class="wb-quick-open-body">
          <section
            class="wb-quick-open-scope-panel"
            :aria-label="t('m_a1594fbd419e')"
            :aria-busy="searchRunning ? 'true' : 'false'"
          >
            <header class="wb-quick-open-section-header">
              <span>{{ t('m_a1594fbd419e') }}</span>
              <QuickOpenKindFilter v-model="scopeMatchKind" :theme="theme" />
              <span class="wb-quick-open-scope-summary">
                <template v-if="searchRunning">{{ t('m_cc50237edca2') }}</template>
                <template v-else>
                  {{ hasQuery ? `已选 ${selectedScopeCount}` : `全部 ${selectedScopeCount}` }}
                  · {{ scopeState.mode === "custom" ? t('m_aefac3869b51') : t('m_4a246a75ac8c') }}
                </template>
              </span>
              <button
                v-if="scopeState.mode === 'custom'"
                type="button"
                class="wb-quick-open-reset-scope"
                @click="resetScopeSelection"
              >{{ t('m_5fc55f0ca4c5') }}</button>
            </header>
            <ul
              v-if="results.length"
              id="wb-quick-open-list"
              ref="listRef"
              class="wb-quick-open-results wb-quick-open-scope-results"
              role="listbox"
              :aria-disabled="searchRunning ? 'true' : 'false'"
              @scroll.passive="handleResultsScroll"
            >
              <li
                v-for="(result, index) in mountedResults"
                :key="tableName(result.table)"
                role="option"
                :aria-disabled="searchRunning ? 'true' : 'false'"
                :aria-posinset="resultWindowRange.start + index + 1"
                :aria-setsize="results.length"
                :aria-selected="resultWindowRange.start + index === selectedIndex ? 'true' : 'false'"
                :data-active="resultWindowRange.start + index === selectedIndex ? 'true' : 'false'"
                :data-result-index="resultWindowRange.start + index"
                class="wb-quick-open-item"
                :class="{ 'is-selected': resultWindowRange.start + index === selectedIndex }"
                @mousemove="selectedIndex = resultWindowRange.start + index"
                @dblclick="activateSchemaResult(result)"
              >
                <label class="wb-quick-open-scope-check" @click.stop>
                  <input
                    type="checkbox"
                    :checked="isScopeTableSelected(tableName(result.table))"
                    :disabled="!hasQuery"
                    :aria-disabled="searchRunning ? 'true' : null"
                    :aria-label="`在值搜索中包含 ${tableName(result.table)}`"
                    @click="searchRunning && $event.preventDefault()"
                    @change="toggleScopeTable(tableName(result.table), $event.target.checked)"
                  />
                </label>
                <button
                  type="button"
                  class="wb-quick-open-item-copy"
                  :aria-disabled="searchRunning ? 'true' : null"
                  @click="activateSchemaResult(result)"
                >
                  <span class="wb-quick-open-item-title">
                    <span class="wb-table-name" v-html="highlightMatch(tableName(result.table), result, 'tableName')"></span>
                    <SearchHitBadge :kind="result.matchKind" />
                  </span>
                  <span v-if="tableComment(result.table)" class="wb-table-comment">
                    <SearchHitBadge kind="tableComment" subtle />
                    <span v-html="highlightCommentMatch(tableComment(result.table), result, 'tableComment')"></span>
                  </span>
                  <span v-for="column in result.visibleColumns" :key="columnName(column)" class="wb-column-hit">
                    <SearchHitBadge :kind="column.searchMatchKind || result.matchKind || 'columnName'" subtle />
                    <span class="wb-column-hit-name" v-html="highlightMatch(columnName(column), column, 'columnName')"></span>
                    <span v-if="columnComment(column)" class="wb-column-hit-comment" v-html="highlightCommentMatch(columnComment(column), column, 'columnComment')"></span>
                  </span>
                </button>
              </li>
            </ul>
            <p v-else-if="!searchRunning" class="wb-quick-open-empty">
              {{ matchMode === 'continuous' ? t('m_41d30d076e85') : t('m_63d858907b2c') }}
            </p>
          </section>

          <section class="wb-quick-open-value-panel" :aria-label="t('m_a6c677ee925e')">
            <header class="wb-quick-open-section-header">
              <span>{{ t('m_a6c677ee925e') }}</span>
              <span class="wb-quick-open-scope-summary">{{ t('m_d5339e5d38da') }}</span>
            </header>
            <div class="wb-quick-open-value-input-row">
              <div class="wb-quick-open-value-field">
                <Search class="wb-quick-open-value-search-icon" :size="15" :stroke-width="1.8" aria-hidden="true" />
                <input
                  ref="valueInputRef"
                  v-model="valueQuery"
                  autocomplete="off"
                  spellcheck="false"
                  enterkeyhint="search"
                  :placeholder="t('m_cf299fa4a460')"
                  :aria-label="t('m_041d9c270bcd')"
                  aria-keyshortcuts="Enter Control+Enter Meta+Enter"
                  @keydown="handleValueKeydown"
                />
              </div>
              <button
                type="button"
                class="wb-quick-open-value-submit"
                :class="{ 'is-loading': valueSearchState?.valueLoading }"
                :aria-busy="valueSearchState?.valueLoading ? 'true' : 'false'"
                :disabled="!valueQuery.trim() || valueSearchDisabled || valueSearchState?.valueLoading"
                @click="runValueSearch"
              >
                <Search :size="14" :stroke-width="2" aria-hidden="true" />
                <span>{{ valueSearchState?.valueLoading ? t('m_e3f404a27945') : t('m_bb952af82ffc') }}</span>
              </button>
            </div>
            <p v-if="valueSearchScopeEmpty" class="wb-quick-open-value-error">{{ t('m_2c0209b7a263') }}</p>
            <div v-if="valueSearchState?.valueLoading" class="wb-value-search-progress-wrap">
              <div class="wb-value-search-progress" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100" :style="progressStyle">
                <span class="wb-value-search-progress-fill"></span>
              </div>
              <p class="wb-value-search-progress-text">{{ progressLabel }}</p>
            </div>
            <p v-if="valueSearchState?.valueError" class="wb-quick-open-value-error">{{ valueSearchState.valueError }}</p>
            <ul v-if="visibleValueResults.length" class="wb-quick-open-results wb-quick-open-value-results" role="listbox">
              <li v-for="result in visibleValueResults" :key="`${result.tableName}-${result.columnName}-${result.previewValue}`" class="wb-quick-open-item">
                <button type="button" class="wb-quick-open-item-copy" @click="emit('open-value-result', result)">
                  <span class="wb-quick-open-item-title">
                    <span class="wb-table-name">{{ result.tableName }}</span>
                    <SearchHitBadge kind="value" />
                  </span>
                  <span v-if="result.tableComment" class="wb-table-comment">
                    <SearchHitBadge kind="tableComment" subtle />
                    <span>{{ result.tableComment }}</span>
                  </span>
                  <span class="wb-value-hit">
                    <SearchHitBadge kind="value" subtle />
                    <span class="wb-column-hit-name">{{ result.columnName }}</span>:
                    <span v-html="highlightValue(result.previewValue)"></span>
                  </span>
                </button>
              </li>
            </ul>
            <p v-else-if="hasFreshValues && !valueSearchState?.valueLoading" class="wb-quick-open-empty">{{ t('m_0082d5f24dcc') }}</p>
            <p v-else-if="!valueSearchState?.valueLoading" class="wb-quick-open-value-guidance"> {{ t('m_c87b93d0b4c8') }} </p>
          </section>
        </div>

        <footer class="wb-quick-open-footer">
          <span class="wb-quick-open-hint">
            <kbd>↑</kbd><kbd>↓</kbd> {{ t('m_c11330b85234') }} <kbd>Enter</kbd> {{ t('m_c771248e511f') }} <kbd>Ctrl+Enter</kbd> {{ t('m_64c250df225f') }} <kbd>Esc</kbd> {{ t('m_3fd47edce45b') }} </span>
        </footer>
        <span class="wb-quick-open-resize-handle is-right" aria-hidden="true" @pointerdown="startResize($event, 'x')"></span>
        <span class="wb-quick-open-resize-handle is-bottom" aria-hidden="true" @pointerdown="startResize($event, 'y')"></span>
        <span class="wb-quick-open-resize-handle is-corner" aria-hidden="true" @pointerdown="startResize($event, 'xy')"></span>
      </div>
    </div>
  </Teleport>
</template>
